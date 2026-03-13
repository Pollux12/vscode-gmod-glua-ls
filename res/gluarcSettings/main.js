import {
    DESCRIPTION_OVERRIDES,
    EFFECTIVE_DEFAULTS,
    FORMAT_CATEGORY_KEY,
    FORMAT_CONFIG_PRECEDENCE_PATH,
    FORMAT_CONFIG_PRECEDENCE_VALUES,
    FORMAT_PRESET_PATH,
    FORMAT_PRESET_VALUES,
    HIDDEN_SETTINGS,
    LABEL_OVERRIDES,
} from "./data.js";
import { showToast, setupSearch, updateFilter } from "./search.js";
import {
    renderMappingTableEditor,
    renderMapEditor,
    renderObjectArrayEditor,
    renderScriptedClassTableEditor,
    renderScalarListEditor,
} from "./components/collectionEditors.js";
import {
    isDiagnosticsStateField,
    isSeverityField,
    hasMeaningfulStateOverrides,
    hasMeaningfulSeverityOverrides,
    renderDiagnosticsStateTable,
    renderSeverityTable,
} from "./components/diagnosticEditors.js";
import { renderFormatterSectionContent } from "./components/formatterSection.js";
import { createSettingRow } from "./components/settingRow.js";

const vscode = acquireVsCodeApi();

const currentState = {
    categories: [],
    config: {},
    autoSaveEnabled: false,
};

let formatAutoSwitchedToCustom = false;
let searchInitialized = false;
let sectionObserver;
let isDirty = false;
let dirtyTimer;
let savedDisplayTimer;
let saveState = "idle"; // idle | pending | saving | saved

window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
        return;
    }

    switch (message.type) {
        case "init":
            currentState.categories = Array.isArray(message.categories)
                ? message.categories
                : [];
            currentState.config =
                message.config && typeof message.config === "object"
                    ? message.config
                    : {};
            updateAutoSaveEnabled(message.autoSaveEnabled);
            clearDirty();
            renderSettings();
            setupObservers();
            if (!searchInitialized) {
                setupSearch();
                searchInitialized = true;
            }
            break;
        case "configUpdated":
            if (isDirty) {
                updateAutoSaveEnabled(message.autoSaveEnabled);
                showToast(getPendingExternalChangeMessage());
                return;
            }
            currentState.config =
                message.config && typeof message.config === "object"
                    ? message.config
                    : {};
            updateAutoSaveEnabled(message.autoSaveEnabled);
            clearDirty();
            updateAllWidgetValues();
            showToast();
            break;
        case "resetCompleted":
            currentState.config =
                message.config && typeof message.config === "object"
                    ? message.config
                    : {};
            updateAutoSaveEnabled(message.autoSaveEnabled);
            clearDirty();
            updateAllWidgetValues();
            break;
        case "settingsUpdated":
            updateAutoSaveEnabled(message.autoSaveEnabled);
            break;
        case "saved":
            onSaved();
            break;
        default:
            break;
    }
});

const reloadServerButton = document.getElementById("reloadServerBtn");
if (reloadServerButton) {
    reloadServerButton.addEventListener("click", reloadServer);
}

const resetAllButton = document.getElementById("resetAllBtn");
if (resetAllButton) {
    resetAllButton.addEventListener("click", resetAllSettings);
}

const saveButton = document.getElementById("saveBtn");
if (saveButton) {
    saveButton.addEventListener("click", saveNow);
}

function getValue(path, defaultValue) {
    if (!Array.isArray(path)) {
        return defaultValue;
    }

    let current = currentState.config;
    for (const key of path) {
        if (current === undefined || current === null) {
            break;
        }
        current = current[key];
    }

    return current !== undefined ? current : defaultValue;
}

function sendChange(path, value) {
    vscode.postMessage({ type: "change", path, value });
}

function updateAutoSaveEnabled(enabled) {
    currentState.autoSaveEnabled = Boolean(enabled);

    if (saveButton) {
        saveButton.title = currentState.autoSaveEnabled
            ? "Save changes to .gluarc.json now, or wait for auto-save"
            : "Save changes to .gluarc.json manually";
    }
}

function getPendingExternalChangeMessage() {
    return currentState.autoSaveEnabled
        ? "External config changed — save now or wait for auto-save"
        : "External config changed — save your local edits manually when you're ready";
}

function markDirty() {
    isDirty = true;
    setSaveState("pending");
}

function clearDirty() {
    isDirty = false;
    if (dirtyTimer) {
        clearTimeout(dirtyTimer);
        dirtyTimer = undefined;
    }
    if (savedDisplayTimer) {
        clearTimeout(savedDisplayTimer);
        savedDisplayTimer = undefined;
    }
    setSaveState("idle");
}

function onSaved() {
    isDirty = false;
    if (dirtyTimer) {
        clearTimeout(dirtyTimer);
        dirtyTimer = undefined;
    }
    setSaveState("saved");
    if (savedDisplayTimer) {
        clearTimeout(savedDisplayTimer);
    }
    savedDisplayTimer = setTimeout(() => {
        savedDisplayTimer = undefined;
        setSaveState("idle");
    }, 3000);
}

function setSaveState(state) {
    saveState = state;
    const footer = document.getElementById("sidebarFooter");
    const btn = document.getElementById("saveBtn");
    if (!footer || !btn) {
        return;
    }

    footer.classList.remove("is-idle", "is-pending", "is-saving", "is-saved");

    switch (state) {
        case "pending":
            footer.style.display = "";
            footer.classList.add("is-pending");
            btn.textContent = "Save Changes";
            btn.disabled = false;
            break;
        case "saving":
            footer.style.display = "";
            footer.classList.add("is-saving");
            btn.textContent = "Saving\u2026";
            btn.disabled = true;
            break;
        case "saved":
            footer.style.display = "";
            footer.classList.add("is-saved");
            btn.textContent = "Saved \u2713";
            btn.disabled = true;
            break;
        default:
            footer.classList.add("is-idle");
            footer.style.display = "none";
            break;
    }
}

function saveNow() {
    if (saveState !== "pending") {
        return;
    }
    setSaveState("saving");
    vscode.postMessage({ type: "saveNow" });
}

function isObjectRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setLocalValue(path, value) {
    if (!Array.isArray(path) || path.length === 0) {
        return;
    }

    if (!isObjectRecord(currentState.config)) {
        currentState.config = {};
    }

    if (value === undefined || value === null) {
        deleteLocalValue(path);
        return;
    }

    let current = currentState.config;
    for (let index = 0; index < path.length - 1; index += 1) {
        const segment = path[index];
        const next = current[segment];
        if (!isObjectRecord(next)) {
            current[segment] = {};
        }
        current = current[segment];
    }

    current[path[path.length - 1]] = value;
}

function deleteLocalValue(path) {
    const prune = (target, depth) => {
        if (!isObjectRecord(target)) {
            return false;
        }

        const key = path[depth];
        if (!(key in target)) {
            return Object.keys(target).length === 0;
        }

        if (depth === path.length - 1) {
            delete target[key];
            return Object.keys(target).length === 0;
        }

        const child = target[key];
        const childEmpty = prune(child, depth + 1);
        if (childEmpty) {
            delete target[key];
        }

        return Object.keys(target).length === 0;
    };

    prune(currentState.config, 0);
}

function commitLocalChange(path, value) {
    setLocalValue(path, value);
    sendChange(path, value);
    markDirty();
}

function getFormatPreset() {
    const rawPreset = getValue(FORMAT_PRESET_PATH, "default");
    return FORMAT_PRESET_VALUES.includes(rawPreset) ? rawPreset : "default";
}

function getFormatConfigPrecedence() {
    const rawValue = getValue(
        FORMAT_CONFIG_PRECEDENCE_PATH,
        "preferEditorconfig",
    );
    return FORMAT_CONFIG_PRECEDENCE_VALUES.includes(rawValue)
        ? rawValue
        : "preferEditorconfig";
}

function reloadServer() {
    vscode.postMessage({ type: "reloadServer" });
}

function resetAllSettings() {
    vscode.postMessage({ type: "resetAll" });
}

function getFieldPathKey(field) {
    if (!field || !Array.isArray(field.path)) {
        return "";
    }

    return field.path.join(".");
}

function shouldHideField(field) {
    return HIDDEN_SETTINGS.has(getFieldPathKey(field));
}

function getFieldDescription(field) {
    const fieldPathKey = getFieldPathKey(field);
    if (
        fieldPathKey &&
        typeof DESCRIPTION_OVERRIDES[fieldPathKey] === "string"
    ) {
        return DESCRIPTION_OVERRIDES[fieldPathKey];
    }

    return field.description;
}

function getFieldLabel(field) {
    const fieldPathKey = getFieldPathKey(field);
    if (fieldPathKey && typeof LABEL_OVERRIDES[fieldPathKey] === "string") {
        return LABEL_OVERRIDES[fieldPathKey];
    }

    return field.label;
}

function isSingleLineControlField(field) {
    if (isDiagnosticsStateField(field) || isSeverityField(field)) {
        return false;
    }

    return (
        field.type === "boolean" ||
        field.type === "number" ||
        field.type === "integer" ||
        field.type === "string" ||
        field.type === "enum"
    );
}

function createAppContext() {
    return {
        commitLocalChange,
        generateInput,
        getFormatAutoSwitchedToCustom: () => formatAutoSwitchedToCustom,
        getFormatConfigPrecedence,
        getFormatPreset,
        getValue,
        setFormatAutoSwitchedToCustom: (value) => {
            formatAutoSwitchedToCustom = value;
        },
        updateAllWidgetValues,
    };
}

function renderSettings() {
    const categoryList = document.getElementById("categoryList");
    const sectionsContent = document.getElementById("settingsSections");
    if (!categoryList || !sectionsContent) {
        return;
    }

    categoryList.innerHTML = "";
    sectionsContent.innerHTML = "";

    let visibleCategoryIndex = 0;

    currentState.categories.forEach((category) => {
        const isFormatCategory = category.key === FORMAT_CATEGORY_KEY;
        const visibleFields = Array.isArray(category.fields)
            ? category.fields.filter((field) => !shouldHideField(field))
            : [];

        if (!isFormatCategory && visibleFields.length === 0) {
            return;
        }

        const categoryId = `cat-${visibleCategoryIndex}`;

        const item = document.createElement("li");
        item.className = "category-item";
        item.textContent = category.label;
        item.dataset.target = categoryId;
        item.onclick = () => {
            document.getElementById(categoryId)?.scrollIntoView({
                block: "start",
            });
            document
                .querySelectorAll(".category-item")
                .forEach((entry) => entry.classList.remove("active"));
            item.classList.add("active");
        };
        categoryList.appendChild(item);

        const section = document.createElement("section");
        section.id = categoryId;

        const sectionHeading = document.createElement("div");
        sectionHeading.className = "section-heading";

        const heading = document.createElement("h2");
        heading.textContent = category.label;
        sectionHeading.appendChild(heading);

        if (category.description) {
            const description = document.createElement("div");
            description.className = "section-description";
            description.textContent = category.description;
            sectionHeading.appendChild(description);
        }

        section.appendChild(sectionHeading);

        if (isFormatCategory) {
            const behaviorNote = document.createElement("div");
            behaviorNote.className = "formatter-note";

            const noteTitle = document.createElement("strong");
            noteTitle.textContent = "Custom Overrides";
            behaviorNote.appendChild(noteTitle);

            const noteBody = document.createElement("span");
            noteBody.textContent =
                " — Editing any individual formatter option below will automatically switch the Preset to Custom.";
            behaviorNote.appendChild(noteBody);

            const formatBody = renderFormatterSectionContent(createAppContext());
            const settingsColumn = formatBody.querySelector(".format-settings-column");
            if (settingsColumn) {
                settingsColumn.insertBefore(behaviorNote, settingsColumn.firstChild);
            } else {
                formatBody.insertBefore(behaviorNote, formatBody.firstChild);
            }
            section.appendChild(formatBody);
        } else {
            const sectionBody = document.createElement("div");
            sectionBody.className = "section-body";
            visibleFields.forEach((field) => {
                const widget = createFieldWidget(field);
                if (widget) {
                    sectionBody.appendChild(widget);
                }
            });
            section.appendChild(sectionBody);
        }

        sectionsContent.appendChild(section);
        visibleCategoryIndex += 1;
    });

    const searchInput = document.getElementById("searchInput");
    if (searchInput && searchInput.value) {
        updateFilter(searchInput.value);
    }
}

function getEffectiveDefault(field) {
    if (field.default !== undefined && field.default !== null) {
        return field.default;
    }

    return EFFECTIVE_DEFAULTS[getFieldPathKey(field)];
}

function isValueEqualToDefault(value, defaultValue) {
    if (value === defaultValue) return true;
    if (value === undefined || defaultValue === undefined) return false;
    if (value === null || defaultValue === null) return false;
    if (typeof value !== typeof defaultValue) return false;
    if (typeof value === "object") {
        try {
            return JSON.stringify(value) === JSON.stringify(defaultValue);
        } catch {
            return false;
        }
    }
    return false;
}

function isFieldModified(field, currentValue) {
    if (currentValue === undefined) return false;

    if (isDiagnosticsStateField(field)) {
        return hasMeaningfulStateOverrides(getValue);
    }

    if (isSeverityField(field)) {
        return hasMeaningfulSeverityOverrides(currentValue);
    }

    const effectiveDefault = getEffectiveDefault(field);
    if (effectiveDefault === undefined) {
        return true;
    }

    return !isValueEqualToDefault(currentValue, effectiveDefault);
}

function createFieldWidget(field, options = {}) {
    if (shouldHideField(field)) {
        return null;
    }

    const currentValue = Object.prototype.hasOwnProperty.call(options, "value")
        ? options.value
        : getValue(field.path);
    const onChange =
        typeof options.onChange === "function"
            ? options.onChange
            : (newValue) => {
                  commitLocalChange(field.path, newValue);
                  updateAllWidgetValues();
              };

    if (
        field.type === "object" &&
        Array.isArray(field.properties) &&
        field.properties.length > 0 &&
        !isDiagnosticsStateField(field) &&
        !isSeverityField(field)
    ) {
        return renderObjectGroup(field, currentValue, onChange);
    }

    let widget;
    if (isDiagnosticsStateField(field)) {
        widget = renderDiagnosticsStateTable(field, { getValue, commitLocalChange });
    } else if (isSeverityField(field)) {
        widget = renderSeverityTable(field, currentValue, { commitLocalChange });
    } else {
        widget = generateInput(field, currentValue, onChange);
    }

    if (!widget) {
        return null;
    }

    return createSettingRow({
        label: getFieldLabel(field),
        description: getFieldDescription(field),
        keyHint: getFieldPathKey(field),
        path: field.path,
        input: widget,
        inline: isSingleLineControlField(field),
        nested: options.nested || false,
        modified: isFieldModified(field, currentValue),
        onReset: () => {
            commitLocalChange(field.path, null);
            updateAllWidgetValues();
        },
    });
}

function renderObjectGroup(field, value, onChange) {
    let currentObjectValue = isObjectRecord(value) ? { ...value } : {};

    const fragment = document.createDocumentFragment();
    let hasVisibleChildren = false;

    field.properties.forEach((subField) => {
        const child = createFieldWidget(subField, {
            value: currentObjectValue[subField.key],
            onChange: (newValue) => {
                currentObjectValue = {
                    ...currentObjectValue,
                    [subField.key]: newValue,
                };
                onChange({ ...currentObjectValue });
            },
        });

        if (child) {
            hasVisibleChildren = true;
            fragment.appendChild(child);
        }
    });

    if (!hasVisibleChildren) {
        return null;
    }

    return fragment;
}

function generateInput(field, value, onChange) {
    const { enumValues, items, type } = field;
    const fieldPathKey = getFieldPathKey(field);
    const effectiveDefault = (field.default !== undefined && field.default !== null)
        ? field.default
        : EFFECTIVE_DEFAULTS[fieldPathKey];

    if (type === "boolean") {
        const select = document.createElement("select");

        const enabledOption = document.createElement("option");
        enabledOption.value = "true";
        enabledOption.textContent = "Enabled";
        select.appendChild(enabledOption);

        const disabledOption = document.createElement("option");
        disabledOption.value = "false";
        disabledOption.textContent = "Disabled";
        select.appendChild(disabledOption);

        if (value === true) {
            select.value = "true";
        } else if (value === false) {
            select.value = "false";
        } else {
            select.value = effectiveDefault === false ? "false" : "true";
        }

        select.onchange = () => {
            onChange(select.value === "true");
        };

        return select;
    }

    if (type === "string" || type === "enum") {
        if (Array.isArray(enumValues) && enumValues.length > 0) {
            const select = document.createElement("select");

            enumValues.forEach((entry) => {
                const option = document.createElement("option");
                option.value = entry;
                option.textContent = entry;
                select.appendChild(option);
            });

            if (value !== undefined && value !== null) {
                select.value = value;
            } else if (effectiveDefault !== undefined && effectiveDefault !== null) {
                select.value = String(effectiveDefault);
            }

            select.onchange = () => {
                onChange(select.value);
            };

            return select;
        }

        const input = document.createElement("input");
        input.type = "text";
        input.value = value !== undefined && value !== null ? value : "";
        input.placeholder = effectiveDefault !== undefined ? effectiveDefault : "";
        input.onchange = () => {
            const nextValue = input.value.trim();
            onChange(nextValue === "" ? null : nextValue);
        };
        return input;
    }

    if (type === "number" || type === "integer") {
        const input = document.createElement("input");
        input.type = "number";
        if (type === "integer") {
            input.step = "1";
        }
        input.value = value !== undefined && value !== null ? value : "";
        input.placeholder = effectiveDefault !== undefined ? effectiveDefault : "";
        input.onchange = () => {
            if (input.value === "") {
                onChange(null);
                return;
            }

            const parsed =
                type === "integer"
                    ? Number.parseInt(input.value, 10)
                    : Number.parseFloat(input.value);
            onChange(Number.isNaN(parsed) ? null : parsed);
        };
        return input;
    }

    if (
        type === "array" &&
        items &&
        (items.type === "string" ||
            items.type === "enum" ||
            items.type === "number" ||
            items.type === "integer")
    ) {
        return renderScalarListEditor(field, value, onChange);
    }

    if (type === "object" && Array.isArray(field.properties) && field.properties.length > 0) {
        return renderObjectGroup(field, value, onChange);
    }

    if (
        field.editor?.kind === "scriptedClassTable" &&
        type === "array"
    ) {
        return renderScriptedClassTableEditor(field, value, onChange);
    }

    if (
        field.editor?.kind === "mappingTable" &&
        type === "object" &&
        field.additionalProperties
    ) {
        return renderMappingTableEditor(field, value, onChange);
    }

    if (type === "object" && field.additionalProperties) {
        return renderMapEditor(field, value, onChange);
    }

    if (type === "array" && items && items.type === "object") {
        return renderObjectArrayEditor(field, value, onChange, {
            getFieldDescription,
            renderInput: (subField, subValue, subOnChange) =>
                generateInput(subField, subValue, subOnChange),
        });
    }

    const textarea = document.createElement("textarea");
    textarea.className = "json-input";
    textarea.value = value ? JSON.stringify(value, null, 2) : "";
    textarea.placeholder = effectiveDefault ? JSON.stringify(effectiveDefault) : "{}";
    textarea.onchange = () => {
        try {
            const parsed = textarea.value ? JSON.parse(textarea.value) : null;
            onChange(parsed);
            textarea.style.borderColor = "var(--vscode-input-border)";
        } catch {
            textarea.style.borderColor =
                "var(--vscode-inputValidation-errorBorder)";
        }
    };

    return textarea;
}

function updateAllWidgetValues() {
    renderSettings();
    setupObservers();
}

function setupObservers() {
    if (sectionObserver) {
        sectionObserver.disconnect();
    }

    sectionObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                    return;
                }

                const id = entry.target.id;
                document.querySelectorAll(".category-item").forEach((item) => {
                    if (item.dataset.target === id) {
                        item.classList.add("active");
                    } else {
                        item.classList.remove("active");
                    }
                });
            });
        },
        { threshold: 0.2 },
    );

    document.querySelectorAll("section").forEach((section) => {
        sectionObserver.observe(section);
    });
}
