import { PATH_FIELD_KEYWORDS } from "../data.js";
import { showConfirmDialog } from "./dialog.js";

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
    removeBtn.onclick = () => {
        showConfirmDialog({
            title: "Remove Item",
            message: `Are you sure you want to remove this item?`,
            confirmLabel: "Remove",
            onConfirm: onRemove
        });
    };
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
        items.placeholder || (pathLike ? "Enter path..." : "Add item..."),
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
    const editorDesc = field.editor ?? {};
    const keyLabel = editorDesc.keyLabel || "Key";
    const valueLabel = editorDesc.valueLabel || "Value";

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
    keyInput.placeholder = editorDesc.keyPlaceholder || `${keyLabel}...`;
    inputsRow.appendChild(keyInput);

    const valueInput = createMapValueInput(descriptor);
    if (valueInput.tagName === "INPUT") {
        valueInput.placeholder = editorDesc.valuePlaceholder || `${valueLabel}...`;
    }
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
                showConfirmDialog({
                    title: "Remove Item",
                    message: `Are you sure you want to remove the mapped item "${key}"?`,
                    confirmLabel: "Remove",
                    onConfirm: () => {
                        delete currentObj[key];
                        save();
                        renderRows();
                    }
                });
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
                    showConfirmDialog({
                        title: "Remove Entry",
                        message: `Are you sure you want to remove this entry for "${key}"?`,
                        confirmLabel: "Remove",
                        onConfirm: () => {
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
                        }
                    });
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
    const fixedClassName = typeof value.fixedClassName === "string" ? value.fixedClassName.trim() : "";
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
    if (fixedClassName) definition.fixedClassName = fixedClassName;
    if (typeof value.isGlobalSingleton === "boolean") definition.isGlobalSingleton = value.isGlobalSingleton;
    if (typeof value.stripFilePrefix === "boolean") definition.stripFilePrefix = value.stripFilePrefix;
    if (typeof value.hideFromOutline === "boolean") definition.hideFromOutline = value.hideFromOutline;
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
        "fixedClassName",
        "parentId",
        "icon",
        "rootDir",
        "scaffold",
    ].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(overrideDefinition, key)) {
            merged[key] = cloneDefinition(overrideDefinition[key]);
        }
    });
    if (overrideDefinition.isGlobalSingleton === true) {
        merged.isGlobalSingleton = true;
    } else if (overrideDefinition.isGlobalSingleton === false) {
        delete merged.isGlobalSingleton;
    }
    if (overrideDefinition.stripFilePrefix === true) {
        merged.stripFilePrefix = true;
    } else if (overrideDefinition.stripFilePrefix === false) {
        delete merged.stripFilePrefix;
    }
    if (overrideDefinition.hideFromOutline === true) {
        merged.hideFromOutline = true;
    } else if (overrideDefinition.hideFromOutline === false) {
        delete merged.hideFromOutline;
    }
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
        "fixedClassName",
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
    for (const boolKey of ["isGlobalSingleton", "stripFilePrefix", "hideFromOutline"]) {
        if (effectiveDefinition[boolKey] === true && defaultDefinition[boolKey] !== true) {
            override[boolKey] = true;
        } else if (effectiveDefinition[boolKey] !== true && defaultDefinition[boolKey] === true) {
            override[boolKey] = false;
        }
    }

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
        "fixedClassName",
        "parentId",
        "icon",
        "rootDir",
        "scaffold",
    ].forEach((key) => {
        if (effectiveDefinition[key] !== undefined) {
            payload[key] = cloneDefinition(effectiveDefinition[key]);
        }
    });
    for (const boolKey of ["isGlobalSingleton", "stripFilePrefix", "hideFromOutline"]) {
        if (effectiveDefinition[boolKey] === true) {
            payload[boolKey] = true;
        }
    }
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

        const createField = (labelText, input, isFullWidth = false, helpText = null) => {
            const fieldWrapper = document.createElement("div");
            fieldWrapper.className = "object-list-field scripted-class-detail-field";
            if (isFullWidth) {
                fieldWrapper.classList.add("is-full-width");
            }

            const labelWrapper = document.createElement("div");
            labelWrapper.className = "setting-label-row";

            const label = document.createElement("div");
            label.className = "setting-label";
            label.textContent = labelText;
            labelWrapper.appendChild(label);

            if (helpText) {
                const helpIcon = document.createElement("span");
                helpIcon.className = "help-icon";
                helpIcon.title = helpText;
                helpIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM6.98 5.48c0-.58.46-1.02 1.05-1.02.58 0 1.05.44 1.05 1.02 0 .57-.47 1.02-1.05 1.02-.59 0-1.05-.45-1.05-1.02zm.45 6.51v-4.5h1.16v4.5H7.43z"/></svg>`;
                labelWrapper.appendChild(helpIcon);
            }

            fieldWrapper.appendChild(labelWrapper);
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

        const fixedClassNameInput = createField("Fixed Class Name", createScriptedClassTextInput(definition.fixedClassName || ""));
        fixedClassNameInput.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                const nextValue = fixedClassNameInput.value.trim();
                if (nextValue) {
                    nextDefinition.fixedClassName = nextValue;
                } else {
                    nextDefinition.fixedClassName = "";
                }
            });
        });

        const isGlobalSingletonCheckbox = document.createElement("input");
        isGlobalSingletonCheckbox.type = "checkbox";
        isGlobalSingletonCheckbox.checked = !!definition.isGlobalSingleton;
        isGlobalSingletonCheckbox.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                nextDefinition.isGlobalSingleton = isGlobalSingletonCheckbox.checked;
            });
        });
        createField("Global Singleton", isGlobalSingletonCheckbox);

        const stripFilePrefixCheckbox = document.createElement("input");
        stripFilePrefixCheckbox.type = "checkbox";
        stripFilePrefixCheckbox.checked = !!definition.stripFilePrefix;
        stripFilePrefixCheckbox.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                nextDefinition.stripFilePrefix = stripFilePrefixCheckbox.checked;
            });
        });
        createField("Strip File Prefix", stripFilePrefixCheckbox);

        const hideFromOutlineCheckbox = document.createElement("input");
        hideFromOutlineCheckbox.type = "checkbox";
        hideFromOutlineCheckbox.checked = !!definition.hideFromOutline;
        hideFromOutlineCheckbox.addEventListener("change", () => {
            updateEffectiveDefinition(row, (nextDefinition) => {
                nextDefinition.hideFromOutline = hideFromOutlineCheckbox.checked;
            });
        });
        createField("Hide From Outline", hideFromOutlineCheckbox);

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

        const includeContainer = renderScalarListEditor(
            { items: { type: "string", placeholder: "folder/**" }, path: ["include"] },
            definition.include || [],
            (nextValue) => {
                updateEffectiveDefinition(row, (nextDefinition) => {
                    nextDefinition.include = nextValue;
                });
            }
        );
        createField("Include Globs", includeContainer, true);

        const excludeContainer = renderScalarListEditor(
            { items: { type: "string", placeholder: "folder/excluded/**" }, path: ["exclude"] },
            definition.exclude || [],
            (nextValue) => {
                updateEffectiveDefinition(row, (nextDefinition) => {
                    if (nextValue.length > 0) {
                        nextDefinition.exclude = nextValue;
                    } else {
                        nextDefinition.exclude = [];
                    }
                });
            }
        );
        createField("Exclude Globs", excludeContainer, true);

        const scaffoldFiles = Array.isArray(definition.scaffold?.files) ? definition.scaffold.files : [];
        const initialScaffoldMap = {};
        scaffoldFiles.forEach((file) => {
            if (file.path && file.template) {
                initialScaffoldMap[file.path] = file.template;
            }
        });

        const scaffoldContainer = renderMapEditor(
            {
                additionalProperties: { type: "string" },
                editor: {
                    keyLabel: "File path",
                    valueLabel: "Template name",
                    keyPlaceholder: "{{name}}/shared.lua",
                    valuePlaceholder: "ent_shared.lua"
                }
            },
            initialScaffoldMap,
            (nextMap) => {
                updateEffectiveDefinition(row, (nextDefinition) => {
                    const nextFiles = Object.entries(nextMap).map(([path, template]) => ({ path, template }));
                    if (nextFiles.length > 0) {
                        nextDefinition.scaffold = { files: nextFiles };
                    } else {
                        nextDefinition.scaffold = { files: [] };
                    }
                });
            }
        );
        createField("Scaffold Files", scaffoldContainer, true, "Use {{name}} in the path to automatically replace it with the file or class name.");

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
        note.textContent = "Define special scripted classes such as entities and effects, alongside custom classes such as plugins, items, etc. This is a powerful feature which can automatically create a class for each file/folder within the given directory. See the defaults below for examples, you can also override as required.";

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
                actionBtn.onclick = () => {
                    showConfirmDialog({
                        title: "Disable Scripted Class",
                        message: `Are you sure you want to disable the default scripted class definition for "${row.id}"?`,
                        confirmLabel: "Disable",
                        onConfirm: () => setDefinition(row.id, { id: row.id, disabled: true })
                    });
                };

                if (row.status === "override") {
                    const resetBtn = document.createElement("button");
                    resetBtn.type = "button";
                    resetBtn.className = "mapping-table-row-reset";
                    resetBtn.textContent = "↺";
                    resetBtn.title = "Reset to built-in definition";
                    resetBtn.onclick = () => {
                        showConfirmDialog({
                            title: "Reset Scripted Class",
                            message: `Are you sure you want to reset the scripted class "${row.id}" to its built-in definition?`,
                            confirmLabel: "Reset",
                            onConfirm: () => setDefinition(row.id, null)
                        });
                    };
                    actions.appendChild(resetBtn);
                }
            } else {
                actionBtn.className = "remove-btn";
                actionBtn.textContent = "×";
                actionBtn.setAttribute("aria-label", `Remove scripted class ${row.id}`);
                actionBtn.onclick = () => {
                    showConfirmDialog({
                        title: "Remove Scripted Class",
                        message: `Are you sure you want to remove the custom scripted class definition for "${row.id}"?`,
                        confirmLabel: "Remove",
                        onConfirm: () => setDefinition(row.id, null)
                    });
                };
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
                showConfirmDialog({
                    title: "Remove Item",
                    message: `Are you sure you want to remove item ${index + 1}?`,
                    confirmLabel: "Remove",
                    onConfirm: () => {
                        currentArr.splice(index, 1);
                        onChange([...currentArr]);
                        renderList();
                    }
                });
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


// ─── Ignore Dir Defaults Editor ────────────────────────────────────────────────
// NOTE: The pure-logic functions below (normalizeIgnoreDirEntry, getIgnoreDirDefaults,
// isLegacyReplaceMode, buildIgnoreDirPayload) are mirrored in
// src/ignoreDirDefaultsLogic.ts for deterministic unit testing without a browser.
// Keep them in sync when making behavioral changes.

/**
 * Normalise a raw ignoreDirDefaults entry (string or object) to a canonical
 * { id, glob, label, disabled, wasObject } form. Returns null for invalid entries.
 *
 * `wasObject` is true when the source entry was an object (not a legacy string),
 * so round-trip serialization can preserve the object form and avoid data loss.
 */
function normalizeIgnoreDirEntry(entry) {
    if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        // Legacy string — treat the string itself as both id and glob
        return { id: trimmed, glob: trimmed, label: null, disabled: false, wasObject: false };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) return null;
    const glob = typeof entry.glob === "string" ? entry.glob.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const disabled = entry.disabled === true;
    return { id, glob: glob || null, label: label || null, disabled, wasObject: true };
}

function getIgnoreDirDefaults(field) {
    if (!Array.isArray(field.default)) return [];
    return field.default
        .map(normalizeIgnoreDirEntry)
        .filter((entry) => entry !== null);
}

/**
 * Detect whether a raw value array is in "legacy replace mode":
 * all entries are plain strings with no object overrides/disables.
 * In this mode the array REPLACES the built-in defaults entirely.
 */
function isLegacyReplaceMode(val) {
    if (!Array.isArray(val) || val.length === 0) return false;
    return val.every((entry) => typeof entry === "string");
}

/**
 * Build a serializable payload from the raw overrides map plus the built-in
 * defaults. Only emits entries that differ from the defaults.
 *
 * Built-in overrides/disables are serialized as objects (e.g. `{ id, glob }`,
 * `{ id, disabled: true }`). Custom entries (delta-mode additions) are always
 * serialized as `{ id, glob }` objects regardless of how they were created.
 * This ensures the saved array is never all-strings in delta mode, so reloading
 * never misidentifies it as legacy replace mode and delta mode persists correctly.
 * Existing `label` metadata is preserved when present.
 *
 * The only code path that produces plain strings is the legacy-mode serializer
 * inside `commit()`, which runs only while `legacyMode` is still true.
 */
function buildIgnoreDirPayload(builtinDefaults, overrides) {
    const builtinById = new Map(builtinDefaults.map((entry) => [entry.id, entry]));
    const entries = [];

    overrides.forEach((override, id) => {
        const builtin = builtinById.get(id);
        if (builtin) {
            if (override.disabled) {
                // Preserve label from the builtin if future schema defaults include one
                const obj = { id, disabled: true };
                const effectiveLabel = override.label ?? builtin.label ?? null;
                if (effectiveLabel) obj.label = effectiveLabel;
                entries.push(obj);
                return;
            }
            // Only write if glob actually changed from the built-in default
            if (override.glob !== null && override.glob !== builtin.glob) {
                const obj = { id, glob: override.glob };
                // Preserve label: from the override if set, otherwise fall back to builtin
                const effectiveLabel = override.label ?? builtin.label ?? null;
                if (effectiveLabel) obj.label = effectiveLabel;
                entries.push(obj);
            }
            // Matches default — nothing to write
        } else {
            // Custom entry (not in built-ins) — always serialize as an object so
            // the saved array is never all-strings and delta mode persists across reload.
            if (!override.disabled && override.glob) {
                const obj = { id, glob: override.glob };
                if (override.label) obj.label = override.label;
                entries.push(obj);
            }
        }
    });

    return entries;
}

/**
 * Render a simple table UI for workspace.ignoreDirDefaults.
 * - Shows built-in defaults with their glob and a source badge.
 * - Allows disabling a built-in, overriding its glob, or resetting.
 * - Allows adding custom entries (only glob needed).
 *
 * LEGACY REPLACE MODE: if the persisted value contains only plain strings
 * (no objects), it fully replaces the built-in list rather than overlaying it.
 * In that mode the editor shows the strings as the complete active list and
 * surfaces a warning + conversion button so the user can migrate to delta mode.
 */
export function renderIgnoreDirDefaultsEditor(field, value, onChange, options = {}) {
    const builtinDefaults = getIgnoreDirDefaults(field);
    const builtinById = new Map(builtinDefaults.map((entry) => [entry.id, entry]));
    // defaultsActive reflects workspace.useDefaultIgnores (true unless explicitly false)
    const defaultsActive = options.defaultsActive !== false;

    // Detect legacy replace mode up front; only reassessed on full re-init (external change).
    let legacyMode = isLegacyReplaceMode(value);

    /**
     * @type {Map<string, {id: string, glob: string|null, label: string|null, disabled: boolean, wasObject: boolean}>}
     */
    let rawOverrides = new Map();

    const parseValue = (val, isLegacy = false) => {
        const map = new Map();
        if (!Array.isArray(val)) return map;
        val.forEach((entry) => {
            const normalized = normalizeIgnoreDirEntry(entry);
            if (!normalized) return;
            if (isLegacy) {
                // In legacy replace mode every string entry is kept verbatim, even if
                // its value happens to equal a built-in id. The map key is the glob
                // string itself so identical duplicates are de-duped, but the entry
                // is always stored and never silently dropped.
                map.set(normalized.id, { ...normalized });
                return;
            }
            const builtin = builtinById.get(normalized.id);
            if (builtin) {
                if (normalized.disabled) {
                    map.set(normalized.id, { ...normalized });
                    return;
                }
                const globDiffers = normalized.glob !== null && normalized.glob !== builtin.glob;
                if (globDiffers) {
                    map.set(normalized.id, { ...normalized });
                }
                // Matches default — no override needed
            } else {
                // Custom entry — always store, preserving wasObject flag
                map.set(normalized.id, { ...normalized });
            }
        });
        return map;
    };

    rawOverrides = parseValue(value, legacyMode);

    const container = document.createElement("div");
    container.className = "mapping-table-container ignore-dir-defaults-container";

    // Warning banner shown in legacy replace mode
    const legacyBanner = document.createElement("div");
    legacyBanner.className = "mapping-table-note ignore-dir-defaults-legacy-banner";
    container.appendChild(legacyBanner);

    const note = document.createElement("div");
    note.className = "mapping-table-note";
    container.appendChild(note);

    const shell = document.createElement("div");
    shell.className = "mapping-table-shell";
    container.appendChild(shell);

    // Header
    const header = document.createElement("div");
    header.className = "mapping-table-header ignore-dir-defaults-header";
    [
        { kind: "path", label: "Glob / Path" },
        { kind: "source", label: "Source" },
        { kind: "actions", label: "Actions" },
    ].forEach(({ kind, label }) => {
        const cell = document.createElement("div");
        cell.className = `mapping-table-cell is-${kind} mapping-table-heading`;
        cell.textContent = label;
        header.appendChild(cell);
    });
    shell.appendChild(header);

    const body = document.createElement("div");
    body.className = "mapping-table-body";
    shell.appendChild(body);

    // Add row
    const addRow = document.createElement("div");
    addRow.className = "mapping-table-add-row ignore-dir-defaults-add-row";

    const addGlobInput = document.createElement("input");
    addGlobInput.type = "text";
    addGlobInput.placeholder = "Glob pattern, e.g. **/vendor/**";

    const addGlobCell = document.createElement("div");
    addGlobCell.className = "mapping-table-cell is-path";
    addGlobCell.appendChild(addGlobInput);
    addRow.appendChild(addGlobCell);

    const addSourceCell = document.createElement("div");
    addSourceCell.className = "mapping-table-cell is-source";
    addRow.appendChild(addSourceCell);

    const addActionsCell = document.createElement("div");
    addActionsCell.className = "mapping-table-cell is-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add";
    addActionsCell.appendChild(addBtn);
    addRow.appendChild(addActionsCell);
    shell.appendChild(addRow);

    /**
     * Commit a new overrides map and emit the serialized payload.
     * In legacy replace mode, serialize the map back to plain strings (preserve mode semantics).
     * As soon as forceDeltaMode is true, we exit legacy mode and switch to delta serialization.
     */
    const commit = (overrides, forceDeltaMode = false) => {
        rawOverrides = overrides;

        if (legacyMode && !forceDeltaMode) {
            // Stay in legacy mode: emit every active glob verbatim as a plain string.
            // Entries whose id matches a built-in must also be emitted — in legacy replace
            // mode the array replaces built-ins entirely, so every string matters.
            const legacyEntries = [];
            overrides.forEach((override) => {
                if (!override.disabled && override.glob) {
                    legacyEntries.push(override.glob);
                }
            });
            if (legacyEntries.length === 0) {
                // All legacy entries removed — transition to delta view immediately
                // instead of staying in a stale empty legacy mode.
                legacyMode = false;
            }
            onChange(legacyEntries.length > 0 ? legacyEntries : null);
        } else {
            if (forceDeltaMode) {
                legacyMode = false;
            }
            const payload = buildIgnoreDirPayload(builtinDefaults, rawOverrides);
            onChange(payload.length > 0 ? payload : null);
        }
    };

    const renderRows = () => {
        // Legacy mode banner
        if (legacyMode) {
            legacyBanner.style.display = "";
            legacyBanner.innerHTML = "";

            const bannerText = document.createElement("span");
            bannerText.textContent =
                "⚠️ Legacy replace mode: this list fully replaces the built-in defaults. " +
                "Built-in entries are not active unless listed here.";
            legacyBanner.appendChild(bannerText);

            const convertBtn = document.createElement("button");
            convertBtn.type = "button";
            convertBtn.className = "mapping-table-inline-btn";
            convertBtn.style.marginLeft = "8px";
            convertBtn.textContent = "Convert to delta mode";
            convertBtn.title =
                "Switch to delta mode: built-in defaults stay active and only your " +
                "explicit disables / glob overrides are stored. Your custom string entries " +
                "will be preserved as custom entries in the new format.";
            convertBtn.onclick = () => {
                showConfirmDialog({
                    title: "Convert to Delta Mode",
                    message:
                        "This will switch from legacy replace mode to delta mode. " +
                        "Built-in defaults will become active again, and your custom globs " +
                        "will be kept as additional custom entries. Continue?",
                    confirmLabel: "Convert",
                    onConfirm: () => {
                        // Keep only non-builtin custom entries; drop any that match a builtin id.
                        // Mark wasObject=true so buildIgnoreDirPayload serializes them as
                        // { id, glob } objects rather than plain strings. This ensures the
                        // saved array is no longer all-strings, so reloading the panel will
                        // not fall back into legacy replace mode.
                        const nextOverrides = new Map();
                        rawOverrides.forEach((override, id) => {
                            if (!builtinById.has(id) && !override.disabled && override.glob) {
                                nextOverrides.set(id, { ...override, wasObject: true });
                            }
                        });
                        commit(nextOverrides, true);
                        renderRows();
                    },
                });
            };
            legacyBanner.appendChild(convertBtn);
        } else {
            legacyBanner.style.display = "none";
        }

        const totalOverrides = rawOverrides.size;
        note.textContent = legacyMode
            ? `${totalOverrides} glob${totalOverrides === 1 ? "" : "s"} listed. These replace built-in defaults entirely — built-ins are not applied.`
            : !defaultsActive
                ? "Built-in ignore defaults are suppressed — workspace.useDefaultIgnores is disabled. Entries below have no effect on built-ins until it is re-enabled."
                : (totalOverrides === 0
                    ? "Built-in ignore defaults are active. You can disable or override individual entries below."
                    : "Workspace overrides are delta-based — future built-in additions will still apply unless explicitly disabled.");

        body.innerHTML = "";

        if (legacyMode) {
            // In legacy replace mode: only show the string entries (no built-in rows)
            rawOverrides.forEach((override, id) => {
                if (override.disabled || !override.glob) return;

                const row = document.createElement("div");
                row.className = "mapping-table-row is-custom";

                const globInput = document.createElement("input");
                globInput.type = "text";
                globInput.value = override.glob;
                globInput.placeholder = "Glob pattern...";

                const pathCell = document.createElement("div");
                pathCell.className = "mapping-table-cell is-path";
                pathCell.appendChild(globInput);
                row.appendChild(pathCell);

                const badge = document.createElement("span");
                badge.className = "mapping-table-badge is-custom";
                badge.textContent = "Active";
                const sourceCell = document.createElement("div");
                sourceCell.className = "mapping-table-cell is-source";
                sourceCell.appendChild(badge);
                row.appendChild(sourceCell);

                globInput.addEventListener("change", () => {
                    const nextGlob = globInput.value.trim();
                    if (!nextGlob) {
                        globInput.value = override.glob;
                        return;
                    }
                    const nextOverrides = new Map(rawOverrides);
                    if (id !== nextGlob) {
                        nextOverrides.delete(id);
                    }
                    nextOverrides.set(nextGlob, { id: nextGlob, glob: nextGlob, label: null, disabled: false, wasObject: false });
                    commit(nextOverrides);
                    renderRows();
                });

                const actionsDiv = document.createElement("div");
                actionsDiv.className = "mapping-table-actions mapping-table-row-actions";

                const removeBtn = document.createElement("button");
                removeBtn.className = "remove-btn";
                removeBtn.type = "button";
                removeBtn.textContent = "×";
                removeBtn.setAttribute("aria-label", `Remove entry: ${id}`);
                removeBtn.title = "Remove this entry";
                removeBtn.onclick = () => {
                    showConfirmDialog({
                        title: "Remove Ignore Entry",
                        message: `Are you sure you want to remove the ignore entry "${id}"?`,
                        confirmLabel: "Remove",
                        onConfirm: () => {
                            const nextOverrides = new Map(rawOverrides);
                            nextOverrides.delete(id);
                            commit(nextOverrides);
                            renderRows();
                        },
                    });
                };
                actionsDiv.appendChild(removeBtn);

                const actionsCell = document.createElement("div");
                actionsCell.className = "mapping-table-cell is-actions";
                actionsCell.appendChild(actionsDiv);
                row.appendChild(actionsCell);

                body.appendChild(row);
            });
        } else {
            // Delta mode: show all built-in rows + custom entries
            const allIds = [
                ...builtinDefaults.map((entry) => entry.id),
                ...[...rawOverrides.keys()].filter((id) => !builtinById.has(id)),
            ];

            allIds.forEach((id) => {
                const builtin = builtinById.get(id);
                const override = rawOverrides.get(id);
                const isCustom = !builtin;
                const isDisabled = override?.disabled === true;
                const isOverride = !isCustom && override && !isDisabled && override.glob !== null && override.glob !== builtin.glob;
                const effectiveGlob = isDisabled
                    ? (builtin?.glob ?? "")
                    : (override?.glob ?? builtin?.glob ?? "");

                const row = document.createElement("div");
                row.className = "mapping-table-row";
                if (isDisabled) row.classList.add("is-inactive");
                if (isOverride) row.classList.add("is-overridden");
                if (isCustom) row.classList.add("is-custom");

                // Glob cell (editable)
                const globInput = document.createElement("input");
                globInput.type = "text";
                globInput.value = effectiveGlob;
                globInput.disabled = isDisabled;
                globInput.placeholder = builtin?.glob ?? "";

                const pathCell = document.createElement("div");
                pathCell.className = "mapping-table-cell is-path";
                pathCell.appendChild(globInput);
                row.appendChild(pathCell);

                // Source badge cell
                const badge = document.createElement("span");
                badge.className = "mapping-table-badge";
                if (isDisabled) {
                    badge.textContent = "Disabled";
                    badge.classList.add("is-removed");
                } else if (isOverride) {
                    badge.textContent = "Override";
                    badge.classList.add("is-override");
                } else if (isCustom) {
                    badge.textContent = "Custom";
                    badge.classList.add("is-custom");
                } else {
                    badge.textContent = "Default";
                    badge.classList.add("is-default");
                }

                const sourceCell = document.createElement("div");
                sourceCell.className = "mapping-table-cell is-source";
                sourceCell.appendChild(badge);
                row.appendChild(sourceCell);

                // Glob change handler
                globInput.addEventListener("change", () => {
                    const nextGlob = globInput.value.trim();
                    if (!nextGlob) {
                        globInput.value = effectiveGlob;
                        return;
                    }
                    const nextOverrides = new Map(rawOverrides);
                    if (builtin) {
                        if (nextGlob === builtin.glob) {
                            // Restored to default — remove override
                            nextOverrides.delete(id);
                        } else {
                            // Preserve existing label from override or builtin
                            const existingBuiltinOverride = rawOverrides.get(id);
                            const preservedLabel = existingBuiltinOverride?.label ?? builtin.label ?? null;
                            nextOverrides.set(id, { id, glob: nextGlob, label: preservedLabel, disabled: false, wasObject: false });
                        }
                    } else {
                        // Custom entry glob edit.
                        // - wasObject=true (object-backed): the id is a stable identifier independent
                        //   of the glob, so keep the same map key/id and just update the glob.
                        // - wasObject=false (string-backed): the id IS the glob (plain-string
                        //   round-trip key), so a glob edit is also a rename — delete the old key
                        //   and re-insert under the new glob as key/id. This prevents stale keys
                        //   and duplicate add-guard misses after a rename.
                        const existing = rawOverrides.get(id);
                        const wasObj = existing?.wasObject ?? false;
                        if (wasObj) {
                            // Object-backed: preserve stable id; only the glob changes.
                            const stableId = existing?.id ?? id;
                            const stableLabel = existing?.label ?? null;
                            if (id !== stableId) {
                                nextOverrides.delete(id);
                            }
                            nextOverrides.set(stableId, { id: stableId, glob: nextGlob, label: stableLabel, disabled: false, wasObject: true });
                        } else {
                            // String-backed: rename key and id to the new glob value.
                            nextOverrides.delete(id);
                            nextOverrides.set(nextGlob, { id: nextGlob, glob: nextGlob, label: null, disabled: false, wasObject: false });
                        }
                    }
                    commit(nextOverrides);
                    renderRows();
                });

                // Actions cell
                const actionsDiv = document.createElement("div");
                actionsDiv.className = "mapping-table-actions mapping-table-row-actions";

                if (isDisabled) {
                    // "Restore" button — re-enables the built-in
                    const restoreBtn = document.createElement("button");
                    restoreBtn.type = "button";
                    restoreBtn.className = "mapping-table-inline-btn";
                    restoreBtn.textContent = "Restore";
                    restoreBtn.title = "Re-enable this built-in ignore pattern";
                    restoreBtn.onclick = () => {
                        const nextOverrides = new Map(rawOverrides);
                        nextOverrides.delete(id);
                        commit(nextOverrides);
                        renderRows();
                    };
                    actionsDiv.appendChild(restoreBtn);
                } else {
                    if (isOverride) {
                        // Reset button — restores built-in glob
                        const resetBtn = document.createElement("button");
                        resetBtn.type = "button";
                        resetBtn.className = "mapping-table-row-reset";
                        resetBtn.textContent = "↺";
                        resetBtn.title = "Reset glob to built-in default";
                        resetBtn.onclick = () => {
                            const nextOverrides = new Map(rawOverrides);
                            nextOverrides.delete(id);
                            commit(nextOverrides);
                            renderRows();
                        };
                        actionsDiv.appendChild(resetBtn);
                    }

                    // Remove/Disable button
                    const removeBtn = document.createElement("button");
                    removeBtn.className = "remove-btn";
                    removeBtn.type = "button";
                    removeBtn.textContent = "×";
                    if (builtin) {
                        removeBtn.setAttribute("aria-label", `Disable built-in: ${id}`);
                        removeBtn.title = "Disable this built-in ignore pattern for this workspace";
                        removeBtn.onclick = () => {
                            const nextOverrides = new Map(rawOverrides);
                            // Preserve label from builtin (or existing override) when disabling
                            const existingOverride = rawOverrides.get(id);
                            const preservedLabel = existingOverride?.label ?? builtin.label ?? null;
                            nextOverrides.set(id, { id, glob: builtin.glob, label: preservedLabel, disabled: true, wasObject: false });
                            commit(nextOverrides);
                            renderRows();
                        };
                    } else {
                        removeBtn.setAttribute("aria-label", `Remove custom entry: ${id}`);
                        removeBtn.title = "Remove this custom ignore entry";
                        removeBtn.onclick = () => {
                            showConfirmDialog({
                                title: "Remove Ignore Entry",
                                message: `Are you sure you want to remove the custom ignore entry "${id}"?`,
                                confirmLabel: "Remove",
                                onConfirm: () => {
                                    const nextOverrides = new Map(rawOverrides);
                                    nextOverrides.delete(id);
                                    commit(nextOverrides);
                                    renderRows();
                                },
                            });
                        };
                    }
                    actionsDiv.appendChild(removeBtn);
                }

                const actionsCell = document.createElement("div");
                actionsCell.className = "mapping-table-cell is-actions";
                actionsCell.appendChild(actionsDiv);
                row.appendChild(actionsCell);

                body.appendChild(row);
            });
        }
    };

    const addItem = () => {
        const glob = addGlobInput.value.trim();
        if (!glob) return;
        // In delta mode also reject if the glob matches a built-in id (user should use disable/override instead).
        if (!legacyMode && builtinById.has(glob)) return;
        // Reject if the glob already exists as a map key OR as the effective glob value of any
        // existing override. This catches renamed string-backed entries (where the old id is stale
        // but the new glob value matches what the user is trying to add) and wasObject entries
        // whose glob was edited to the same value.
        if (rawOverrides.has(glob)) return;
        for (const override of rawOverrides.values()) {
            if (override.glob === glob) return;
        }
        const id = glob;
        const nextOverrides = new Map(rawOverrides);
        nextOverrides.set(id, { id, glob, label: null, disabled: false, wasObject: false });
        commit(nextOverrides);
        renderRows();
        addGlobInput.value = "";
        addGlobInput.focus();
    };

    addBtn.onclick = addItem;
    addGlobInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addItem();
        }
    });

    renderRows();
    return container;
}
