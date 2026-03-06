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
