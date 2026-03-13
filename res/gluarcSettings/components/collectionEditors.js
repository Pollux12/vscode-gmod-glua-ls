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

            const actionBtn = document.createElement("button");
            actionBtn.type = "button";
            if (rowIsActive) {
                actions.classList.add("mapping-table-row-actions");
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

            if (isOverride) {
                const resetBtn = document.createElement("button");
                resetBtn.type = "button";
                resetBtn.className = "mapping-table-row-reset";
                resetBtn.textContent = "↺";
                resetBtn.title = "Reset to default";
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

function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
}

function normalizePathArray(value) {
    return normalizeStringArray(value).map((segment) =>
        segment.replace(/^[/\\]+|[/\\]+$/g, ""),
    ).filter((segment) => segment.length > 0);
}

function normalizeScaffoldFiles(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.files)) {
        return [];
    }

    return value.files
        .map((entry) => {
            if (!entry || typeof entry !== "object") {
                return null;
            }

            const filePath = typeof entry.path === "string" ? entry.path.trim() : "";
            const template = typeof entry.template === "string" ? entry.template.trim() : "";
            if (!filePath || !template) {
                return null;
            }

            return { path: filePath, template };
        })
        .filter((entry) => entry !== null);
}

function normalizeScriptedClassDefinition(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id) {
        return null;
    }

    const definition = { id };
    const label = typeof value.label === "string" ? value.label.trim() : "";
    const classGlobal = typeof value.classGlobal === "string" ? value.classGlobal.trim() : "";
    const parentId = typeof value.parentId === "string" ? value.parentId.trim() : "";
    const icon = typeof value.icon === "string" ? value.icon.trim() : "";
    const rootDir = typeof value.rootDir === "string" ? value.rootDir.trim() : "";
    const path = normalizePathArray(value.path);
    const include = normalizeStringArray(value.include);
    const exclude = normalizeStringArray(value.exclude);
    const scaffoldFiles = normalizeScaffoldFiles(value.scaffold);

    if (label) definition.label = label;
    if (path.length > 0) definition.path = path;
    if (include.length > 0) definition.include = include;
    if (exclude.length > 0) definition.exclude = exclude;
    if (classGlobal) definition.classGlobal = classGlobal;
    if (parentId) definition.parentId = parentId;
    if (icon) definition.icon = icon;
    if (rootDir) definition.rootDir = rootDir;
    if (typeof value.disabled === "boolean") definition.disabled = value.disabled;
    if (Array.isArray(value.scaffold?.files)) {
        definition.scaffold = scaffoldFiles.length > 0 ? { files: scaffoldFiles } : { files: [] };
    }

    return definition;
}

function scriptedClassKeyForField(field) {
    return Array.isArray(field.path) && field.path.length > 0
        ? field.path.join(".")
        : "scripted-class-table";
}

function cloneDefinition(definition) {
    if (definition === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(definition));
}

function definitionsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function mergeScriptedClassDefinition(baseDefinition, overrideDefinition) {
    const merged = cloneDefinition(baseDefinition);
    [
        "label",
        "path",
        "include",
        "exclude",
        "classGlobal",
        "parentId",
        "icon",
        "rootDir",
        "scaffold",
    ].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(overrideDefinition, key)) {
            merged[key] = cloneDefinition(overrideDefinition[key]);
        }
    });
    if (overrideDefinition.disabled === true) {
        merged.disabled = true;
    } else {
        delete merged.disabled;
    }
    return merged;
}

function getScriptedClassDefaults(field) {
    if (!Array.isArray(field.default)) {
        return [];
    }

    return field.default
        .map((entry) => normalizeScriptedClassDefinition(entry))
        .filter((entry) => entry !== null);
}

function getScriptedClassRawState(value) {
    const definitions = new Map();
    const legacyGlobs = [];

    if (!Array.isArray(value)) {
        return { definitions, legacyGlobs };
    }

    value.forEach((entry) => {
        if (typeof entry === "string") {
            const trimmed = entry.trim();
            if (trimmed) {
                legacyGlobs.push(trimmed);
            }
            return;
        }

        const normalized = normalizeScriptedClassDefinition(entry);
        if (normalized) {
            definitions.set(normalized.id, normalized);
        }
    });

    return { definitions, legacyGlobs };
}

function buildScriptedClassRows(defaults, rawDefinitions) {
    const defaultsById = new Map(defaults.map((entry) => [entry.id, entry]));
    const ids = [...new Set([...defaults.map((entry) => entry.id), ...rawDefinitions.keys()])];

    return ids.map((id) => {
        const defaultDefinition = defaultsById.get(id);
        const rawDefinition = rawDefinitions.get(id);

        if (rawDefinition?.disabled) {
            return {
                id,
                defaultDefinition,
                rawDefinition,
                effectiveDefinition: defaultDefinition ?? rawDefinition,
                status: defaultDefinition ? "removed" : "custom",
            };
        }

        if (defaultDefinition && rawDefinition) {
            return {
                id,
                defaultDefinition,
                rawDefinition,
                effectiveDefinition: mergeScriptedClassDefinition(defaultDefinition, rawDefinition),
                status: "override",
            };
        }

        if (defaultDefinition) {
            return {
                id,
                defaultDefinition,
                rawDefinition,
                effectiveDefinition: defaultDefinition,
                status: "default",
            };
        }

        return {
            id,
            defaultDefinition,
            rawDefinition,
            effectiveDefinition: rawDefinition,
            status: "custom",
        };
    });
}

function buildScriptedClassOverride(defaultDefinition, effectiveDefinition) {
    const override = { id: defaultDefinition.id };

    [
        "label",
        "path",
        "include",
        "exclude",
        "classGlobal",
        "parentId",
        "icon",
        "rootDir",
        "scaffold",
    ].forEach((key) => {
        const defaultValue = defaultDefinition[key];
        const effectiveValue = effectiveDefinition[key];
        if (!definitionsEqual(defaultValue, effectiveValue)) {
            override[key] = cloneDefinition(effectiveValue);
        }
    });

    return Object.keys(override).length > 1 ? override : null;
}

function buildCustomScriptedClassPayload(effectiveDefinition) {
    const payload = { id: effectiveDefinition.id };
    [
        "label",
        "path",
        "include",
        "exclude",
        "classGlobal",
        "parentId",
        "icon",
        "rootDir",
        "scaffold",
    ].forEach((key) => {
        if (effectiveDefinition[key] !== undefined) {
            payload[key] = cloneDefinition(effectiveDefinition[key]);
        }
    });
    return payload;
}

function createScriptedClassPayload(defaults, rawDefinitions, legacyGlobs) {
    const defaultsById = new Map(defaults.map((entry) => [entry.id, entry]));
    const entries = [];

    legacyGlobs.forEach((glob) => entries.push(glob));

    defaults.forEach((definition) => {
        const rawDefinition = rawDefinitions.get(definition.id);
        if (!rawDefinition) {
            return;
        }

        if (rawDefinition.disabled) {
            entries.push({ id: definition.id, disabled: true });
            return;
        }

        const effectiveDefinition = mergeScriptedClassDefinition(definition, rawDefinition);
        const override = buildScriptedClassOverride(definition, effectiveDefinition);
        if (override) {
            entries.push(override);
        }
    });

    rawDefinitions.forEach((rawDefinition, id) => {
        if (defaultsById.has(id) || rawDefinition.disabled) {
            return;
        }

        entries.push(buildCustomScriptedClassPayload(rawDefinition));
    });

    return entries;
}

function parseLineList(text) {
    return text
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function formatLineList(values) {
    return Array.isArray(values) ? values.join("\n") : "";
}

function formatPathSegments(values) {
    return Array.isArray(values) ? values.join("/") : "";
}

function inferScriptedClassRootDir(pathSegments) {
    const normalized = normalizePathArray(pathSegments);
    const pathSummary = normalized.join("/");
    if (!pathSummary) {
        return "";
    }

    return normalized[0]?.toLowerCase() === "plugins"
        ? pathSummary
        : `lua/${pathSummary}`;
}

function inferScriptedClassInclude(pathSegments) {
    const pathSummary = normalizePathArray(pathSegments).join("/");
    return pathSummary ? [`${pathSummary}/**`] : [];
}

function createScriptedClassCell(kind, content = null) {
    const cell = document.createElement("div");
    cell.className = `mapping-table-cell scripted-class-cell is-${kind}`;
    if (typeof content === "string") {
        cell.textContent = content;
    } else if (content) {
        cell.appendChild(content);
    }
    return cell;
}

function createScriptedClassTextInput(value, placeholder = "") {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value ?? "";
    input.placeholder = placeholder;
    return input;
}

function createScriptedClassTextArea(value, placeholder = "") {
    const textarea = document.createElement("textarea");
    textarea.className = "json-input scripted-class-textarea";
    textarea.value = value ?? "";
    textarea.placeholder = placeholder;
    return textarea;
}

function createScriptedClassSummary(definition, id) {
    const summary = document.createElement("div");
    summary.className = "scripted-class-summary";

    const title = document.createElement("strong");
    title.textContent = definition.label || id;
    summary.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "scripted-class-summary-meta";
    meta.textContent = id;
    summary.appendChild(meta);

    return summary;
}

function createScriptedClassBadge(status) {
    const badge = document.createElement("span");
    badge.className = "mapping-table-badge";

    if (status === "removed") {
        badge.textContent = "Removed";
        badge.classList.add("is-removed");
    } else if (status === "override") {
        badge.textContent = "Override";
        badge.classList.add("is-override");
    } else if (status === "custom") {
        badge.textContent = "Custom";
        badge.classList.add("is-custom");
    } else {
        badge.textContent = "Default";
        badge.classList.add("is-default");
    }

    return badge;
}

export function renderScriptedClassTableEditor(field, value, onChange) {
    const defaults = getScriptedClassDefaults(field);
    let { definitions: rawDefinitions, legacyGlobs } = getScriptedClassRawState(value);
    const expandedRows = new Set();

    const container = document.createElement("div");
    container.className = "mapping-table-container scripted-class-table-container";

    const note = document.createElement("div");
    note.className = "mapping-table-note";
    container.appendChild(note);

    const shell = document.createElement("div");
    shell.className = "mapping-table-shell scripted-class-table-shell";
    container.appendChild(shell);

    const header = document.createElement("div");
    header.className = "mapping-table-header scripted-class-table-header";
    [
        { kind: "name", label: "Class" },
        { kind: "global", label: "Global" },
        { kind: "path", label: "Path" },
        { kind: "source", label: "Source" },
        { kind: "actions", label: "Actions" },
    ].forEach(({ kind, label }) => {
        const cell = createScriptedClassCell(kind, label);
        cell.classList.add("mapping-table-heading");
        header.appendChild(cell);
    });
    shell.appendChild(header);

    const body = document.createElement("div");
    body.className = "mapping-table-body";
    shell.appendChild(body);

    const legacySection = document.createElement("div");
    legacySection.className = "scripted-class-legacy-section";
    container.appendChild(legacySection);

    const addRow = document.createElement("div");
    addRow.className = "mapping-table-add-row scripted-class-table-add-row";
    const addIdInput = createScriptedClassTextInput("", "Definition id...");
    const addLabelInput = createScriptedClassTextInput("", "Label...");
    const addGlobalInput = createScriptedClassTextInput("", "Global...");
    const addPathInput = createScriptedClassTextInput("", "Folder path...");
    const addActions = document.createElement("div");
    addActions.className = "mapping-table-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add";
    addActions.appendChild(addBtn);
    addRow.appendChild(createScriptedClassCell("name", addIdInput));
    addRow.appendChild(createScriptedClassCell("global", addGlobalInput));
    addRow.appendChild(createScriptedClassCell("path", addPathInput));
    addRow.appendChild(createScriptedClassCell("source", addLabelInput));
    addRow.appendChild(createScriptedClassCell("actions", addActions));
    shell.appendChild(addRow);

    const commit = () => {
        const payload = createScriptedClassPayload(defaults, rawDefinitions, legacyGlobs);
        onChange(payload.length > 0 ? payload : null);
    };

    const rerender = (viewStateOptions = null) => {
        const viewState = captureMappingTableViewState(shell, viewStateOptions ?? {});
        render();
        applyMappingTableViewState(shell, addIdInput, viewState);
    };

    const setDefinition = (id, nextDefinition) => {
        if (nextDefinition) {
            rawDefinitions.set(id, nextDefinition);
        } else {
            rawDefinitions.delete(id);
        }
        commit();
        rerender();
    };

    const updateEffectiveDefinition = (row, updater) => {
        const nextEffective = cloneDefinition(row.effectiveDefinition);
        updater(nextEffective);

        const defaultDefinition = row.defaultDefinition;
        if (defaultDefinition) {
            const nextOverride = buildScriptedClassOverride(defaultDefinition, nextEffective);
            setDefinition(row.id, nextOverride);
            return;
        }

        setDefinition(row.id, buildCustomScriptedClassPayload(nextEffective));
    };

    const renderDetailsPanel = (row) => {
        const definition = row.effectiveDefinition;
        const panel = document.createElement("div");
        panel.className = "scripted-class-details";

        const createField = (labelText, input) => {
            const fieldWrapper = document.createElement("label");
            fieldWrapper.className = "object-list-field scripted-class-detail-field";
            const label = document.createElement("div");
            label.className = "setting-label";
            label.textContent = labelText;
            fieldWrapper.appendChild(label);
            fieldWrapper.appendChild(input);
            panel.appendChild(fieldWrapper);
            return input;
        };

        const labelInput = createField("Label", createScriptedClassTextInput(definition.label || ""));
        labelInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                nextDefinition.label = labelInput.value.trim() || row.id;
            });
        });

        const classGlobalInput = createField("Global", createScriptedClassTextInput(definition.classGlobal || ""));
        classGlobalInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const nextValue = classGlobalInput.value.trim();
                nextDefinition.classGlobal = nextValue || row.defaultDefinition?.classGlobal || row.id.toUpperCase();
            });
        });

        const rootDirInput = createField("Root Directory", createScriptedClassTextInput(definition.rootDir || ""));
        rootDirInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const nextValue = rootDirInput.value.trim();
                nextDefinition.rootDir = nextValue || row.defaultDefinition?.rootDir || inferScriptedClassRootDir(nextDefinition.path);
            });
        });

        const parentIdInput = createField("Parent Id", createScriptedClassTextInput(definition.parentId || ""));
        parentIdInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const nextValue = parentIdInput.value.trim();
                if (nextValue) {
                    nextDefinition.parentId = nextValue;
                } else {
                    nextDefinition.parentId = "";
                }
            });
        });

        const iconInput = createField("Icon", createScriptedClassTextInput(definition.icon || ""));
        iconInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const nextValue = iconInput.value.trim();
                if (nextValue) {
                    nextDefinition.icon = nextValue;
                } else {
                    nextDefinition.icon = "";
                }
            });
        });

        const pathInput = createField("Path Segments", createScriptedClassTextInput(formatPathSegments(definition.path), "entities/custom"));
        pathInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const previousPath = normalizePathArray(nextDefinition.path);
                const previousDefaultRootDir = inferScriptedClassRootDir(previousPath);
                const previousDefaultInclude = inferScriptedClassInclude(previousPath);
                const nextPath = normalizePathArray(pathInput.value.split(/[\\/]+/));

                nextDefinition.path = nextPath;

                if (!nextDefinition.rootDir || nextDefinition.rootDir === previousDefaultRootDir) {
                    nextDefinition.rootDir = inferScriptedClassRootDir(nextPath);
                }

                if (
                    !Array.isArray(nextDefinition.include)
                    || nextDefinition.include.length === 0
                    || definitionsEqual(nextDefinition.include, previousDefaultInclude)
                ) {
                    nextDefinition.include = inferScriptedClassInclude(nextPath);
                }
            });
        });

        const includeInput = createField("Include Globs", createScriptedClassTextArea(formatLineList(definition.include), "folder/**"));
        includeInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                nextDefinition.include = parseLineList(includeInput.value);
            });
        });

        const excludeInput = createField("Exclude Globs", createScriptedClassTextArea(formatLineList(definition.exclude), "folder/excluded/**"));
        excludeInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const nextExclude = parseLineList(excludeInput.value);
                if (nextExclude.length > 0) {
                    nextDefinition.exclude = nextExclude;
                } else {
                    nextDefinition.exclude = [];
                }
            });
        });

        const scaffoldFiles = Array.isArray(definition.scaffold?.files) ? definition.scaffold.files : [];
        const scaffoldInput = createField(
            "Scaffold Files",
            createScriptedClassTextArea(
                scaffoldFiles.map((entry) => `${entry.path} => ${entry.template}`).join("\n"),
                "{{name}}/shared.lua => ent_shared.lua",
            ),
        );
        scaffoldInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const nextFiles = scaffoldInput.value
                    .split(/\r?\n/)
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0)
                    .map((entry) => {
                        const [filePath, template] = entry.split(/\s*=>\s*/, 2);
                        return {
                            path: filePath?.trim() || "",
                            template: template?.trim() || "",
                        };
                    })
                    .filter((entry) => entry.path && entry.template);

                if (nextFiles.length > 0) {
                    nextDefinition.scaffold = { files: nextFiles };
                } else {
                    nextDefinition.scaffold = { files: [] };
                }
            });
        });

        return panel;
    };

    const renderLegacySection = () => {
        legacySection.innerHTML = "";

        const headerEl = document.createElement("div");
        headerEl.className = "scripted-class-legacy-header";
        headerEl.textContent = "Legacy Include Globs";
        legacySection.appendChild(headerEl);

        const noteEl = document.createElement("div");
        noteEl.className = "mapping-table-note";
        noteEl.textContent = legacyGlobs.length === 0
            ? "No legacy glob entries are stored."
            : "String entries are preserved for backward compatibility, but object definitions are preferred.";
        legacySection.appendChild(noteEl);

        const list = document.createElement("div");
        list.className = "path-table";
        legacySection.appendChild(list);

        legacyGlobs.forEach((glob, index) => {
            list.appendChild(
                createCollectionRow(
                    [glob],
                    () => {
                        legacyGlobs = legacyGlobs.filter((_entry, entryIndex) => entryIndex !== index);
                        commit();
                        rerender();
                    },
                    `Remove legacy glob ${glob}`,
                ),
            );
        });

        const addLegacyRow = document.createElement("div");
        addLegacyRow.className = "path-add-row";
        const addLegacyInput = createScriptedClassTextInput("", "Add legacy glob...");
        const addLegacyBtn = document.createElement("button");
        addLegacyBtn.className = "add-btn";
        addLegacyBtn.type = "button";
        addLegacyBtn.textContent = "+ Add Glob";
        addLegacyRow.appendChild(addLegacyInput);
        addLegacyRow.appendChild(addLegacyBtn);
        legacySection.appendChild(addLegacyRow);

        const addLegacyGlob = () => {
            const nextValue = addLegacyInput.value.trim();
            if (!nextValue || legacyGlobs.includes(nextValue)) {
                return;
            }

            legacyGlobs = [...legacyGlobs, nextValue];
            addLegacyInput.value = "";
            commit();
            rerender({ keepBottomVisible: true });
        };

        addLegacyBtn.onclick = addLegacyGlob;
        addLegacyInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addLegacyGlob();
            }
        });
    };

    const render = () => {
        note.textContent = rawDefinitions.size === 0 && legacyGlobs.length === 0
            ? "Built-in scripted classes stay active until you add overrides, removals, or custom definitions. Path must match the real folder structure; include globs only decide which files are in scope."
            : "Workspace changes are stored as overrides and removals so built-in updates still flow through. Keep Path aligned with the actual folders you want the explorer and analyzer to classify.";

        body.innerHTML = "";

        buildScriptedClassRows(defaults, rawDefinitions).forEach((row) => {
            const definition = row.effectiveDefinition;
            const summaryRow = document.createElement("div");
            summaryRow.className = "mapping-table-row scripted-class-table-row";
            if (row.status === "removed") {
                summaryRow.classList.add("is-inactive");
            }
            if (row.status === "override") {
                summaryRow.classList.add("is-overridden");
            }

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "mapping-table-inline-btn scripted-class-expand-btn";
            editBtn.textContent = expandedRows.has(row.id) ? "Hide" : "Edit";
            editBtn.onclick = () => {
                if (expandedRows.has(row.id)) {
                    expandedRows.delete(row.id);
                } else {
                    expandedRows.add(row.id);
                }
                rerender();
            };

            const nameCellContent = document.createElement("div");
            nameCellContent.className = "scripted-class-name-cell";
            nameCellContent.appendChild(createScriptedClassSummary(definition, row.id));
            nameCellContent.appendChild(editBtn);
            summaryRow.appendChild(createScriptedClassCell("name", nameCellContent));
            summaryRow.appendChild(createScriptedClassCell("global", definition.classGlobal || ""));
            summaryRow.appendChild(createScriptedClassCell("path", formatPathSegments(definition.path)));
            summaryRow.appendChild(createScriptedClassCell("source", createScriptedClassBadge(row.status)));

            const actions = document.createElement("div");
            actions.className = "mapping-table-actions";
            const actionBtn = document.createElement("button");
            actionBtn.type = "button";

            if (row.status === "removed") {
                actionBtn.className = "mapping-table-inline-btn";
                actionBtn.textContent = "Use";
                actionBtn.onclick = () => setDefinition(row.id, null);
            } else if (row.defaultDefinition) {
                actionBtn.className = "remove-btn";
                actionBtn.textContent = "×";
                actionBtn.setAttribute("aria-label", `Remove scripted class ${row.id}`);
                actionBtn.onclick = () => setDefinition(row.id, { id: row.id, disabled: true });

                if (row.status === "override") {
                    const resetBtn = document.createElement("button");
                    resetBtn.type = "button";
                    resetBtn.className = "mapping-table-row-reset";
                    resetBtn.textContent = "↺";
                    resetBtn.title = "Reset to built-in definition";
                    resetBtn.onclick = () => setDefinition(row.id, null);
                    actions.appendChild(resetBtn);
                }
            } else {
                actionBtn.className = "remove-btn";
                actionBtn.textContent = "×";
                actionBtn.setAttribute("aria-label", `Remove scripted class ${row.id}`);
                actionBtn.onclick = () => setDefinition(row.id, null);
            }

            actions.appendChild(actionBtn);
            summaryRow.appendChild(createScriptedClassCell("actions", actions));

            if (expandedRows.has(row.id) && row.status !== "removed") {
                const wrapper = document.createElement("div");
                wrapper.className = "scripted-class-row-wrapper";
                wrapper.appendChild(summaryRow);
                wrapper.appendChild(renderDetailsPanel(row));
                body.appendChild(wrapper);
            } else {
                body.appendChild(summaryRow);
            }
        });

        renderLegacySection();
    };

    const addCustomDefinition = () => {
        const id = addIdInput.value.trim();
        if (!id || rawDefinitions.has(id) || defaults.some((entry) => entry.id === id)) {
            return;
        }

        const label = addLabelInput.value.trim() || id;
        const classGlobal = addGlobalInput.value.trim() || id.toUpperCase();
        const pathSegments = normalizePathArray((addPathInput.value.trim() || id).split(/[\\/]+/));
        const rootDir = inferScriptedClassRootDir(pathSegments);
        rawDefinitions.set(id, {
            id,
            label,
            classGlobal,
            path: pathSegments,
            include: inferScriptedClassInclude(pathSegments),
            rootDir,
        });
        expandedRows.add(id);
        addIdInput.value = "";
        addLabelInput.value = "";
        addGlobalInput.value = "";
        addPathInput.value = "";
        commit();
        rerender({ keepBottomVisible: true, focusAddInput: true });
    };

    addBtn.onclick = addCustomDefinition;
    [addIdInput, addLabelInput, addGlobalInput, addPathInput].forEach((input) => {
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addCustomDefinition();
            }
        });
    });

    render();
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

