import { PATH_FIELD_KEYWORDS } from "../data.js";

function getFieldTokens(field) {
    const values = [];
    if (Array.isArray(field.path)) {
        values.push(...field.path);
    }
    if (typeof field.key === "string") {
        values.push(field.key);
    }
    if (typeof field.label === "string") {
        values.push(field.label);
    }

    return values.map((entry) => String(entry).toLowerCase());
}

function allValuesLookLikePaths(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return false;
    }

    return value.every(
        (entry) => typeof entry === "string" && /[\\/]/.test(entry),
    );
}

function isPathLikeArrayField(field, value) {
    if (Array.isArray(field.path) && field.path.join(".") === "workspace.library") {
        return true;
    }

    if (
        field.items &&
        Array.isArray(field.items.enumValues) &&
        field.items.enumValues.length > 0
    ) {
        return false;
    }

    if (field.type !== "array" || !field.items || field.items.type !== "string") {
        return false;
    }

    const tokens = getFieldTokens(field);
    const inWorkspace = Array.isArray(field.path) && field.path[0] === "workspace";
    const tokenLooksPathLike = tokens.some((token) =>
        PATH_FIELD_KEYWORDS.some((keyword) => token.includes(keyword)),
    );

    return inWorkspace || tokenLooksPathLike || allValuesLookLikePaths(value);
}

function isObjectRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortObjectEntries(obj) {
    return Object.entries(obj).sort(([left], [right]) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
}

function toSortedObject(obj) {
    return Object.fromEntries(sortObjectEntries(obj));
}

const mappingTableViewStates = new Map();
const MAPPING_TABLE_REMOVE_ANIMATION_MS = 160;

function getMappingTableStateKey(field) {
    if (Array.isArray(field.path) && field.path.length > 0) {
        return field.path.join(".");
    }

    if (typeof field.key === "string" && field.key.trim()) {
        return field.key.trim();
    }

    if (typeof field.label === "string" && field.label.trim()) {
        return field.label.trim().toLowerCase();
    }

    return "mapping-table";
}

function isScrolledNearBottom(element, threshold = 16) {
    if (!element) {
        return false;
    }

    return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
}

function captureMappingTableViewState(
    shell,
    { animation = null, keepBottomVisible = false, focusAddInput = false } = {},
) {
    const stickToBottom = keepBottomVisible || isScrolledNearBottom(shell);
    return {
        animation,
        focusAddInput,
        scrollTop: stickToBottom ? null : shell.scrollTop,
        stickToBottom,
    };
}

function applyMappingTableViewState(shell, addKeyInput, viewState) {
    if (!shell || !viewState) {
        return;
    }

    const restoreView = () => {
        if (viewState.stickToBottom) {
            shell.scrollTop = shell.scrollHeight;
        } else if (typeof viewState.scrollTop === "number") {
            const maxScrollTop = Math.max(shell.scrollHeight - shell.clientHeight, 0);
            shell.scrollTop = Math.min(viewState.scrollTop, maxScrollTop);
        }

        if (viewState.focusAddInput) {
            focusInputWithoutScroll(addKeyInput, shell);
        }
    };

    restoreView();
    requestAnimationFrame(() => {
        restoreView();
        requestAnimationFrame(restoreView);
    });
}

function setInputElementValue(inputElement, value) {
    inputElement.value = value === undefined || value === null ? "" : String(value);
}

function focusInputWithoutScroll(inputElement, scrollContainer = null) {
    const restoreScroll = () => {
        if (!scrollContainer) {
            return;
        }

        scrollContainer.scrollTop = scrollContainer.scrollHeight;
    };

    try {
        inputElement.focus({ preventScroll: true });
    } catch {
        inputElement.focus();
    }

    restoreScroll();
    requestAnimationFrame(restoreScroll);
}

function isEmptyMapValue(value) {
    return typeof value === "string" && value.trim() === "";
}

function getEffectiveMapEntries(defaults, rawEntries) {
    const merged = { ...defaults };
    for (const [key, entryValue] of sortObjectEntries(rawEntries)) {
        if (isEmptyMapValue(entryValue)) {
            delete merged[key];
            continue;
        }

        merged[key] = entryValue;
    }

    return merged;
}

function getMappingTableLabels(field) {
    const editor = isObjectRecord(field.editor) ? field.editor : {};
    return {
        keyLabel:
            typeof editor.keyLabel === "string" && editor.keyLabel.trim()
                ? editor.keyLabel.trim()
                : "Key",
        valueLabel:
            typeof editor.valueLabel === "string" && editor.valueLabel.trim()
                ? editor.valueLabel.trim()
                : "Value",
    };
}

function createMappingTableCell(kind, content = null) {
    const cell = document.createElement("div");
    cell.className = `mapping-table-cell is-${kind}`;
    if (typeof content === "string") {
        cell.textContent = content;
    } else if (content) {
        cell.appendChild(content);
    }
    return cell;
}

function createScalarInput(items, placeholder) {
    if (Array.isArray(items.enumValues) && items.enumValues.length > 0) {
        const select = document.createElement("select");
        items.enumValues.forEach((entry) => {
            const option = document.createElement("option");
            option.value = entry;
            option.textContent = entry;
            select.appendChild(option);
        });
        return select;
    }

    const input = document.createElement("input");
    input.type =
        items.type === "number" || items.type === "integer" ? "number" : "text";
    if (items.type === "integer") {
        input.step = "1";
    }
    input.placeholder = placeholder;
    return input;
}

function clearScalarInput(inputElement) {
    if (inputElement.tagName === "INPUT") {
        inputElement.value = "";
    }
}

function coerceScalarValue(items, inputElement) {
    const rawValue =
        typeof inputElement.value === "string"
            ? inputElement.value.trim()
            : inputElement.value;

    if (items.type === "integer") {
        if (rawValue === "") {
            return undefined;
        }

        const parsed = Number.parseInt(rawValue, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    if (items.type === "number") {
        if (rawValue === "") {
            return undefined;
        }

        const parsed = Number.parseFloat(rawValue);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return rawValue === "" ? undefined : rawValue;
}

function createCollectionRow(columns, onRemove, removeLabel) {
    const row = document.createElement("div");
    row.className = "path-row";

    columns.forEach((value) => {
        const cell = document.createElement("div");
        cell.className = "path-cell";
        cell.textContent = String(value);
        row.appendChild(cell);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", removeLabel);
    removeBtn.onclick = onRemove;
    row.appendChild(removeBtn);

    return row;
}

function createMapValueInput(descriptor) {
    if (Array.isArray(descriptor.enumValues) && descriptor.enumValues.length > 0) {
        const select = document.createElement("select");
        descriptor.enumValues.forEach((entry) => {
            const option = document.createElement("option");
            option.value = entry;
            option.textContent = entry;
            select.appendChild(option);
        });
        return select;
    }

    const input = document.createElement("input");
    input.type =
        descriptor.type === "number" || descriptor.type === "integer"
            ? "number"
            : "text";
    if (descriptor.type === "integer") {
        input.step = "1";
    }
    input.placeholder = "Value...";
    return input;
}

function coerceMapValue(descriptor, inputElement) {
    const rawValue =
        typeof inputElement.value === "string"
            ? inputElement.value.trim()
            : inputElement.value;

    if (descriptor.type === "integer") {
        if (rawValue === "") {
            return undefined;
        }

        const parsed = Number.parseInt(rawValue, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    if (descriptor.type === "number") {
        if (rawValue === "") {
            return undefined;
        }

        const parsed = Number.parseFloat(rawValue);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return rawValue === "" ? undefined : rawValue;
}

export function renderScalarListEditor(field, value, onChange) {
    const items = field.items ?? { type: "string" };
    const pathLike = isPathLikeArrayField(field, value);

    const container = document.createElement("div");
    container.className = "path-list-container";

    const table = document.createElement("div");
    table.className = "path-table";
    container.appendChild(table);

    const addRow = document.createElement("div");
    addRow.className = "path-add-row";

    const inputElement = createScalarInput(
        items,
        pathLike ? "Enter path..." : "Add item...",
    );
    addRow.appendChild(inputElement);

    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add";
    addRow.appendChild(addBtn);
    container.appendChild(addRow);

    let currentArr = Array.isArray(value)
        ? [...value]
        : Array.isArray(field.default)
          ? [...field.default]
          : [];

    const save = () => onChange([...currentArr]);

    const renderRows = () => {
        table.innerHTML = "";
        currentArr.forEach((entry, index) => {
            table.appendChild(
                createCollectionRow(
                    [entry],
                    () => {
                        currentArr.splice(index, 1);
                        save();
                        renderRows();
                    },
                    pathLike ? `Remove path ${entry}` : `Remove item ${entry}`,
                ),
            );
        });
    };

    const addItem = () => {
        const nextValue = coerceScalarValue(items, inputElement);
        if (nextValue === undefined) {
            return;
        }

        currentArr.push(nextValue);
        save();
        renderRows();
        clearScalarInput(inputElement);
        if (inputElement.tagName === "INPUT") {
            inputElement.focus();
        }
    };

    addBtn.onclick = addItem;
    if (inputElement.tagName === "INPUT") {
        inputElement.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addItem();
            }
        });
    }

    renderRows();
    return container;
}

export function renderMapEditor(field, value, onChange) {
    const descriptor = field.additionalProperties ?? { type: "string" };

    const container = document.createElement("div");
    container.className = "path-list-container";

    const table = document.createElement("div");
    table.className = "path-table";
    container.appendChild(table);

    const addRow = document.createElement("div");
    addRow.className = "path-add-row";

    const inputsRow = document.createElement("div");
    inputsRow.className = "map-inputs-row";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.placeholder = "Key...";
    inputsRow.appendChild(keyInput);

    const valueInput = createMapValueInput(descriptor);
    inputsRow.appendChild(valueInput);

    addRow.appendChild(inputsRow);

    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add";
    addRow.appendChild(addBtn);
    container.appendChild(addRow);

    let currentObj =
        value && typeof value === "object" && !Array.isArray(value)
            ? { ...value }
            : {};

    const save = () => onChange({ ...currentObj });

    const renderRows = () => {
        table.innerHTML = "";
        Object.entries(currentObj).forEach(([key, entryValue]) => {
            const row = document.createElement("div");
            row.className = "path-row map-row";

            const keyCell = document.createElement("div");
            keyCell.className = "path-cell";
            keyCell.textContent = key;
            row.appendChild(keyCell);

            const arrow = document.createElement("div");
            arrow.className = "map-arrow";
            arrow.textContent = "→";
            row.appendChild(arrow);

            const valueCell = document.createElement("div");
            valueCell.className = "path-cell";
            valueCell.textContent = String(entryValue);
            row.appendChild(valueCell);

            const removeBtn = document.createElement("button");
            removeBtn.className = "remove-btn";
            removeBtn.type = "button";
            removeBtn.textContent = "×";
            removeBtn.setAttribute("aria-label", `Remove item ${key}`);
            removeBtn.onclick = () => {
                delete currentObj[key];
                save();
                renderRows();
            };
            row.appendChild(removeBtn);

            table.appendChild(row);
        });
    };

    const addEntry = () => {
        const nextKey = keyInput.value.trim();
        const nextValue = coerceMapValue(descriptor, valueInput);
        if (!nextKey || nextValue === undefined) {
            return;
        }

        currentObj = {
            ...currentObj,
            [nextKey]: nextValue,
        };
        save();
        renderRows();
        keyInput.value = "";
        clearScalarInput(valueInput);
        keyInput.focus();
    };

    addBtn.onclick = addEntry;
    keyInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addEntry();
        }
    });
    if (valueInput.tagName === "INPUT") {
        valueInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addEntry();
            }
        });
    }

    renderRows();
    return container;
}

export function renderMappingTableEditor(field, value, onChange) {
    const descriptor = field.additionalProperties ?? { type: "string" };
    const defaults = isObjectRecord(field.default) ? toSortedObject(field.default) : {};
    const { keyLabel, valueLabel } = getMappingTableLabels(field);
    const stateKey = getMappingTableStateKey(field);

    let rawEntries = isObjectRecord(value) ? { ...value } : {};

    const container = document.createElement("div");
    container.className = "mapping-table-container";

    const note = document.createElement("div");
    note.className = "mapping-table-note";
    container.appendChild(note);

    const shell = document.createElement("div");
    shell.className = "mapping-table-shell";
    container.appendChild(shell);

    const header = document.createElement("div");
    header.className = "mapping-table-header";
    [
        { kind: "key", label: keyLabel },
        { kind: "value", label: valueLabel },
        { kind: "source", label: "Source" },
        { kind: "actions", label: "Actions" },
    ].forEach(({ kind, label }) => {
        const cell = createMappingTableCell(kind, label);
        cell.classList.add("mapping-table-heading");
        header.appendChild(cell);
    });
    shell.appendChild(header);

    const body = document.createElement("div");
    body.className = "mapping-table-body";
    shell.appendChild(body);

    const addRow = document.createElement("div");
    addRow.className = "mapping-table-add-row";

    const addKeyInput = document.createElement("input");
    addKeyInput.type = "text";
    addKeyInput.placeholder = `${keyLabel}...`;
    addRow.appendChild(createMappingTableCell("key", addKeyInput));

    const addValueInput = createMapValueInput(descriptor);
    if (addValueInput.tagName === "INPUT") {
        addValueInput.placeholder = `${valueLabel}...`;
    }
    addRow.appendChild(createMappingTableCell("value", addValueInput));

    const addSourceCell = createMappingTableCell("source");
    addSourceCell.classList.add("is-empty");
    addRow.appendChild(addSourceCell);

    const addActions = document.createElement("div");
    addActions.className = "mapping-table-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add";
    addActions.appendChild(addBtn);
    addRow.appendChild(createMappingTableCell("actions", addActions));
    shell.appendChild(addRow);

    const pendingViewState = mappingTableViewStates.get(stateKey) ?? null;
    mappingTableViewStates.delete(stateKey);

    const commitEntries = (nextEntries, viewState = null) => {
        const sanitizedEntries = {};

        for (const [key, entryValue] of Object.entries(nextEntries)) {
            const trimmedKey = key.trim();
            if (!trimmedKey) {
                continue;
            }

            if (isEmptyMapValue(entryValue)) {
                if (Object.prototype.hasOwnProperty.call(defaults, trimmedKey)) {
                    sanitizedEntries[trimmedKey] = "";
                }
                continue;
            }

            if (
                Object.prototype.hasOwnProperty.call(defaults, trimmedKey) &&
                defaults[trimmedKey] === entryValue
            ) {
                continue;
            }

            sanitizedEntries[trimmedKey] = entryValue;
        }

        rawEntries = sanitizedEntries;
        if (viewState) {
            mappingTableViewStates.set(stateKey, viewState);
        } else {
            mappingTableViewStates.delete(stateKey);
        }
        onChange(Object.keys(rawEntries).length > 0 ? { ...rawEntries } : null);
        if (container.isConnected) {
            mappingTableViewStates.delete(stateKey);
            return true;
        }

        return false;
    };

    const renderRows = ({ viewState = null } = {}) => {
        note.textContent = Object.keys(rawEntries).length === 0
            ? "Built-in fallback names are active until you customize this workspace."
            : "Workspace changes are stored as overrides and removals, so future built-in fallback additions still flow through.";

        body.innerHTML = "";

        const effectiveEntries = getEffectiveMapEntries(defaults, rawEntries);

        const defaultKeysSorted = Object.keys(defaults).sort((left, right) =>
            left.localeCompare(right, undefined, { sensitivity: "base" }),
        );

        const customKeys = Object.keys(rawEntries).filter(
            (key) => !Object.prototype.hasOwnProperty.call(defaults, key)
        );

        const sortedKeys = [...new Set([...defaultKeysSorted, ...customKeys])];

        sortedKeys.forEach((key) => {
            const hasDefault = Object.prototype.hasOwnProperty.call(defaults, key);
            const hasRaw = Object.prototype.hasOwnProperty.call(rawEntries, key);
            const isRemoved = hasRaw && isEmptyMapValue(rawEntries[key]);
            const rowIsActive = Object.prototype.hasOwnProperty.call(effectiveEntries, key);
            const rowValue = rowIsActive ? effectiveEntries[key] : defaults[key];
            const isCustom = rowIsActive && !hasDefault;
            const isOverride =
                hasRaw &&
                hasDefault &&
                rowIsActive &&
                effectiveEntries[key] !== defaults[key];

            const row = document.createElement("div");
            row.className = "mapping-table-row";
            if (!rowIsActive) {
                row.classList.add("is-inactive");
            }
            if (isCustom) {
                row.classList.add("is-custom");
            }
            if (isOverride) {
                row.classList.add("is-overridden");
            }
            if (viewState?.animation?.type === "enter" && viewState.animation.key === key) {
                row.classList.add("is-entering");
            }

            const keyInput = document.createElement("input");
            keyInput.type = "text";
            keyInput.value = key;
            row.appendChild(createMappingTableCell("key", keyInput));

            const valueInput = createMapValueInput(descriptor);
            setInputElementValue(valueInput, rowValue);
            row.appendChild(createMappingTableCell("value", valueInput));

            const badge = document.createElement("span");
            badge.className = "mapping-table-badge";
            if (isRemoved) {
                badge.textContent = "Removed";
                badge.classList.add("is-removed");
            } else if (isOverride) {
                badge.textContent = "Override";
                badge.classList.add("is-override");
            } else if (isCustom) {
                badge.textContent = "Custom";
                badge.classList.add("is-custom");
            } else if (rowIsActive && hasDefault) {
                badge.textContent = "Default";
                badge.classList.add("is-default");
            } else {
                badge.textContent = "Built-in";
                badge.classList.add("is-built-in");
            }
            row.appendChild(createMappingTableCell("source", badge));

            const actions = document.createElement("div");
            actions.className = "mapping-table-actions";

            const applyRowChange = () => {
                const nextKey = keyInput.value.trim();
                const nextValue = coerceMapValue(descriptor, valueInput);
                if (!nextKey || nextValue === undefined) {
                    keyInput.value = key;
                    setInputElementValue(valueInput, rowValue);
                    return;
                }

                if (typeof nextValue === "string" && nextValue.trim() === "") {
                    keyInput.value = key;
                    setInputElementValue(valueInput, rowValue);
                    return;
                }

                const nextEntries = { ...rawEntries };
                const duplicateActiveKey =
                    nextKey !== key &&
                    Object.prototype.hasOwnProperty.call(effectiveEntries, nextKey);
                if (duplicateActiveKey) {
                    keyInput.value = key;
                    setInputElementValue(valueInput, rowValue);
                    return;
                }

                if (rowIsActive) {
                    if (hasDefault) {
                        if (nextKey !== key) {
                            nextEntries[key] = "";
                            if (
                                Object.prototype.hasOwnProperty.call(defaults, nextKey) &&
                                defaults[nextKey] === nextValue
                            ) {
                                delete nextEntries[nextKey];
                            } else {
                                nextEntries[nextKey] = nextValue;
                            }
                        } else if (defaults[key] === nextValue) {
                            delete nextEntries[key];
                        } else {
                            nextEntries[key] = nextValue;
                        }
                    } else {
                        if (nextKey !== key) {
                            delete nextEntries[key];
                        }
                        nextEntries[nextKey] = nextValue;
                    }
                } else {
                    nextEntries[key] = "";
                    if (
                        Object.prototype.hasOwnProperty.call(defaults, nextKey) &&
                        defaults[nextKey] === nextValue
                    ) {
                        delete nextEntries[nextKey];
                    } else {
                        nextEntries[nextKey] = nextValue;
                    }
                }

                const viewState = captureMappingTableViewState(shell);
                const shouldRenderLocally = commitEntries(nextEntries, viewState);
                if (shouldRenderLocally) {
                    renderRows({ viewState });
                }
            };

            keyInput.addEventListener("change", applyRowChange);
            valueInput.addEventListener("change", applyRowChange);

            if (isOverride) {
                const resetBtn = document.createElement("button");
                resetBtn.type = "button";
                resetBtn.className = "mapping-table-inline-btn";
                resetBtn.textContent = "Reset";
                resetBtn.onclick = () => {
                    const nextEntries = { ...rawEntries };
                    delete nextEntries[key];
                    const viewState = captureMappingTableViewState(shell);
                    const shouldRenderLocally = commitEntries(nextEntries, viewState);
                    if (shouldRenderLocally) {
                        renderRows({ viewState });
                    }
                };
                actions.appendChild(resetBtn);
            }

            const actionBtn = document.createElement("button");
            actionBtn.type = "button";
            if (rowIsActive) {
                actionBtn.className = "remove-btn";
                actionBtn.textContent = "×";
                actionBtn.setAttribute("aria-label", `Remove ${keyLabel.toLowerCase()} ${key}`);
                actionBtn.onclick = () => {
                    const nextEntries = { ...rawEntries };
                    if (hasDefault) {
                        nextEntries[key] = "";
                    } else {
                        delete nextEntries[key];
                    }

                    if (!hasDefault) {
                        if (row.classList.contains("is-removing")) {
                            return;
                        }

                        row.classList.add("is-removing");
                        row.querySelectorAll("input, select, button").forEach((element) => {
                            element.disabled = true;
                        });

                        window.setTimeout(() => {
                            const viewState = captureMappingTableViewState(shell);
                            const shouldRenderLocally = commitEntries(nextEntries, viewState);
                            if (shouldRenderLocally) {
                                renderRows({ viewState });
                            }
                        }, MAPPING_TABLE_REMOVE_ANIMATION_MS);
                        return;
                    }

                    const viewState = captureMappingTableViewState(shell);
                    const shouldRenderLocally = commitEntries(nextEntries, viewState);
                    if (shouldRenderLocally) {
                        renderRows({ viewState });
                    }
                };
            } else {
                actionBtn.className = "mapping-table-inline-btn";
                actionBtn.textContent = "Use";
                actionBtn.setAttribute("aria-label", `Use built-in ${keyLabel.toLowerCase()} ${key}`);
                actionBtn.onclick = () => {
                    const nextEntries = { ...rawEntries };
                    delete nextEntries[key];
                    const viewState = captureMappingTableViewState(shell);
                    const shouldRenderLocally = commitEntries(nextEntries, viewState);
                    if (shouldRenderLocally) {
                        renderRows({ viewState });
                    }
                };
            }
            actions.appendChild(actionBtn);

            row.appendChild(createMappingTableCell("actions", actions));
            body.appendChild(row);
        });

        if (viewState) {
            applyMappingTableViewState(shell, addKeyInput, viewState);
        }
    };

    const addEntry = () => {
        const nextKey = addKeyInput.value.trim();
        const nextValue = coerceMapValue(descriptor, addValueInput);
        if (!nextKey || nextValue === undefined) {
            return;
        }

        if (typeof nextValue === "string" && nextValue.trim() === "") {
            return;
        }

        const effectiveEntries = getEffectiveMapEntries(defaults, rawEntries);
        if (Object.prototype.hasOwnProperty.call(effectiveEntries, nextKey)) {
            return;
        }

        const nextEntries = { ...rawEntries };
        if (
            Object.prototype.hasOwnProperty.call(defaults, nextKey) &&
            defaults[nextKey] === nextValue
        ) {
            delete nextEntries[nextKey];
        } else {
            nextEntries[nextKey] = nextValue;
        }

        const viewState = captureMappingTableViewState(shell, {
            animation: {
                key: nextKey,
                type: "enter",
            },
            keepBottomVisible: true,
            focusAddInput: true,
        });
        const shouldRenderLocally = commitEntries(nextEntries, viewState);
        addKeyInput.value = "";
        clearScalarInput(addValueInput);
        if (shouldRenderLocally) {
            renderRows({ viewState });
        }
    };

    addBtn.onclick = addEntry;
    addKeyInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addEntry();
        }
    });
    if (addValueInput.tagName === "INPUT") {
        addValueInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addEntry();
            }
        });
    }

    renderRows({ viewState: pendingViewState });
    return container;
}

export function renderObjectArrayEditor(field, value, onChange, options) {
    const { renderInput, getFieldDescription } = options;
    const itemProperties = Array.isArray(field.items?.properties)
        ? field.items.properties
        : [];

    const primaryField = itemProperties.find((f) => f.key === "path") || itemProperties[0];
    const optionalFields = itemProperties.filter((f) => f !== primaryField);

    const container = document.createElement("div");
    container.className = "path-list-container";
    let currentArr = Array.isArray(value) ? [...value] : [];

    const table = document.createElement("div");
    table.className = "path-table";
    container.appendChild(table);

    const hasPopulatedOptionals = (itemObj) =>
        optionalFields.some((f) => {
            const val = itemObj[f.key];
            return val !== undefined && val !== null && val !== "" &&
                !(Array.isArray(val) && val.length === 0);
        });

    const buildOptionalsPanel = (itemObj, index) => {
        const panel = document.createElement("div");
        panel.className = "object-compact-optionals";

        optionalFields.forEach((subField) => {
            const fieldRow = document.createElement("div");
            fieldRow.className = "object-list-field";

            const label = document.createElement("div");
            label.className = "setting-label";
            label.style.fontSize = "12px";
            label.textContent = subField.label;
            fieldRow.appendChild(label);

            const description = getFieldDescription(subField);
            if (description) {
                const descEl = document.createElement("div");
                descEl.className = "setting-description";
                descEl.style.fontSize = "12px";
                descEl.textContent = description;
                fieldRow.appendChild(descEl);
            }

            const input = renderInput(
                subField,
                itemObj[subField.key],
                (newValue) => {
                    const nextItem = { ...itemObj, [subField.key]: newValue };
                    currentArr[index] = nextItem;
                    onChange([...currentArr]);
                },
            );
            if (input) {
                fieldRow.appendChild(input);
            }
            panel.appendChild(fieldRow);
        });

        return panel;
    };

    const renderList = () => {
        table.innerHTML = "";
        currentArr.forEach((item, index) => {
            const itemObj =
                item && typeof item === "object" && !Array.isArray(item)
                    ? item
                    : typeof item === "string"
                      ? { path: item }
                      : {};

            const row = document.createElement("div");
            row.className = "path-row";

            const pathCell = document.createElement("div");
            pathCell.className = "path-cell";
            pathCell.textContent = itemObj[primaryField.key] ?? "";
            row.appendChild(pathCell);

            let panel = null;

            if (optionalFields.length > 0) {
                panel = buildOptionalsPanel(itemObj, index);
                const isExpanded = hasPopulatedOptionals(itemObj);
                if (isExpanded) {
                    panel.classList.add("is-open");
                }

                const expandBtn = document.createElement("button");
                expandBtn.className = "object-compact-expand";
                expandBtn.type = "button";
                expandBtn.textContent = "⋯";
                expandBtn.setAttribute("aria-label", "Configure optional fields");
                expandBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
                expandBtn.onclick = () => {
                    const isOpen = panel.classList.toggle("is-open");
                    expandBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
                };
                row.appendChild(expandBtn);
            }

            const removeBtn = document.createElement("button");
            removeBtn.className = "remove-btn";
            removeBtn.type = "button";
            removeBtn.textContent = "×";
            removeBtn.setAttribute("aria-label", `Remove item ${index + 1}`);
            removeBtn.onclick = () => {
                currentArr.splice(index, 1);
                onChange([...currentArr]);
                renderList();
            };
            row.appendChild(removeBtn);

            if (panel) {
                const wrapper = document.createElement("div");
                wrapper.className = "object-compact-wrapper";
                wrapper.appendChild(row);
                wrapper.appendChild(panel);
                table.appendChild(wrapper);
            } else {
                table.appendChild(row);
            }
        });
    };

    const addRow = document.createElement("div");
    addRow.className = "path-add-row";

    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = primaryField
        ? `Enter ${primaryField.label.toLowerCase()}...`
        : "Add item...";
    addRow.appendChild(addInput);

    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add";
    addRow.appendChild(addBtn);

    const addItem = () => {
        const val = addInput.value.trim();
        if (!val) return;
        currentArr.push(primaryField ? { [primaryField.key]: val } : val);
        onChange([...currentArr]);
        renderList();
        addInput.value = "";
        addInput.focus();
    };

    addBtn.onclick = addItem;
    addInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addItem();
        }
    });

    container.appendChild(addRow);
    renderList();
    return container;
}

