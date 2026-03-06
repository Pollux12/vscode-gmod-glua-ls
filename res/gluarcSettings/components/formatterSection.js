import {
    FORMAT_BOOLEAN_FIELDS,
    FORMAT_CFC_PRESET,
    FORMAT_CONFIG_PRECEDENCE_PATH,
    FORMAT_CONFIG_PRECEDENCE_VALUES,
    FORMAT_DESCRIPTIONS,
    FORMAT_ENGINE_DEFAULTS,
    FORMAT_ENUM_FIELDS,
    FORMAT_GROUPS,
    FORMAT_INTEGER_FIELDS,
    FORMAT_LINE_SPACE_FIELDS,
    FORMAT_PRESET_PATH,
    FORMAT_PRESET_VALUES,
    FORMAT_PREVIEWS,
    FORMAT_STYLE_OVERRIDES_PATH,
} from "../data.js";
import { escapeHtml } from "../search.js";
import { createSettingRow, createCollapsibleGroup } from "./settingRow.js";

function getFormatFieldType(key) {
    if (FORMAT_BOOLEAN_FIELDS.has(key)) {
        return "boolean";
    }

    if (FORMAT_INTEGER_FIELDS.has(key)) {
        return "integer";
    }

    if (FORMAT_LINE_SPACE_FIELDS.has(key)) {
        return "lineSpacing";
    }

    if (key === "space_before_inline_comment") {
        return "numberOrKeep";
    }

    if (FORMAT_ENUM_FIELDS[key]) {
        return "enum";
    }

    return "string";
}

function formatFieldLabel(key) {
    return key
        .split("_")
        .map((token) =>
            token.length > 0 ? token[0].toUpperCase() + token.slice(1) : token,
        )
        .join(" ");
}

function setInlineFormatPreviewExpanded(previewContainer, previewToggle, expanded) {
    if (!previewContainer || !previewToggle) {
        return;
    }

    previewContainer.classList.toggle("is-open", expanded);
    previewToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    previewToggle.textContent = expanded ? "Hide Preview" : "Preview";
}

function collapseInlineFormatPreviews(exceptContainer, exceptToggle) {
    document.querySelectorAll(".format-inline-preview.is-open").forEach((container) => {
        if (container !== exceptContainer) {
            container.classList.remove("is-open");
        }
    });

    document
        .querySelectorAll('.format-preview-toggle[aria-expanded="true"]')
        .forEach((button) => {
            if (button !== exceptToggle) {
                button.setAttribute("aria-expanded", "false");
                button.textContent = "Preview";
            }
        });
}

function createInlineFormatPreview(key) {
    const container = document.createElement("div");
    container.className = "format-inline-preview";
    container.id = `formatPreview-${key}`;

    const panel = document.createElement("div");
    panel.className = "format-inline-preview-panel";

    const header = document.createElement("div");
    header.className = "format-inline-preview-header";
    header.textContent = "Preview";
    panel.appendChild(header);

    const content = document.createElement("div");
    content.className = "format-inline-preview-content";
    content.innerHTML = highlightLua(
        FORMAT_PREVIEWS[key] || "-- No preview available for this setting.",
    );
    panel.appendChild(content);

    container.appendChild(panel);
    return container;
}

function renderFormatPresetInput(context) {
    const select = document.createElement("select");
    [
        { value: "default", label: "Default" },
        { value: "cfc", label: "CFC" },
        { value: "custom", label: "Custom" },
    ].forEach((option) => {
        const entry = document.createElement("option");
        entry.value = option.value;
        entry.textContent = option.label;
        select.appendChild(entry);
    });

    select.value = context.getFormatPreset();
    select.onchange = () => {
        applyFormatPreset(select.value, context);
    };

    return select;
}

function renderFormatConfigPrecedenceInput(context) {
    const select = document.createElement("select");

    FORMAT_CONFIG_PRECEDENCE_VALUES.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent =
            value === "preferEditorconfig"
                ? "Prefer .editorconfig"
                : "Prefer .gluarc.json";
        select.appendChild(option);
    });

    select.value = context.getFormatConfigPrecedence();
    select.onchange = () => {
        context.commitLocalChange(FORMAT_CONFIG_PRECEDENCE_PATH, select.value);
    };

    return select;
}

function parseLineSpacingValue(raw) {
    if (!raw || typeof raw !== "string") {
        return { mode: "keep", amount: 1 };
    }
    if (raw === "keep") {
        return { mode: "keep", amount: 1 };
    }
    const match = raw.match(/^(fixed|min|max)\((\d+)\)$/);
    if (match) {
        return { mode: match[1], amount: Number.parseInt(match[2], 10) };
    }
    return { mode: "keep", amount: 1 };
}

function createLineSpacingInput(fieldValue, onChange, effectiveDefault) {
    const parsed = parseLineSpacingValue(fieldValue ?? effectiveDefault);

    const wrapper = document.createElement("div");
    wrapper.className = "line-spacing-control";

    const modeSelect = document.createElement("select");
    const modes = [
        { value: "keep", label: "Keep" },
        { value: "fixed", label: "Fixed" },
        { value: "min", label: "Minimum" },
        { value: "max", label: "Maximum" },
    ];
    modes.forEach(({ value, label }) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        modeSelect.appendChild(opt);
    });
    modeSelect.value = parsed.mode;

    const amountInput = document.createElement("input");
    amountInput.type = "number";
    amountInput.min = "0";
    amountInput.step = "1";
    amountInput.value = parsed.amount;
    amountInput.className = "line-spacing-amount";

    const needsAmount = (mode) => mode === "fixed" || mode === "min" || mode === "max";
    amountInput.disabled = !needsAmount(parsed.mode);

    const emitChange = () => {
        const mode = modeSelect.value;
        if (mode === "keep") {
            onChange("keep");
            return;
        }
        const n = Number.parseInt(amountInput.value, 10);
        onChange(`${mode}(${Number.isNaN(n) || n < 0 ? 0 : n})`);
    };

    modeSelect.onchange = () => {
        amountInput.disabled = !needsAmount(modeSelect.value);
        emitChange();
    };
    amountInput.onchange = emitChange;

    wrapper.appendChild(modeSelect);
    wrapper.appendChild(amountInput);
    return wrapper;
}

function getEffectiveFormatDefault(key, context) {
    const preset = context.getFormatPreset();
    if (preset === "cfc" && key in FORMAT_CFC_PRESET) {
        return FORMAT_CFC_PRESET[key];
    }
    return FORMAT_ENGINE_DEFAULTS[key];
}

function renderFormatStyleInput(key, fieldValue, onChange, context) {
    const fieldType = getFormatFieldType(key);
    const effectiveDefault = getEffectiveFormatDefault(key, context);

    if (fieldType === "boolean") {
        return context.generateInput(
            { type: "boolean", nullable: true, default: effectiveDefault },
            fieldValue,
            onChange,
        );
    }

    if (fieldType === "integer") {
        return context.generateInput(
            { type: "integer", nullable: true, default: effectiveDefault },
            fieldValue,
            onChange,
        );
    }

    if (fieldType === "enum") {
        return context.generateInput(
            {
                type: "enum",
                nullable: true,
                enumValues: FORMAT_ENUM_FIELDS[key],
                default: effectiveDefault,
            },
            fieldValue,
            onChange,
        );
    }

    if (fieldType === "lineSpacing") {
        return createLineSpacingInput(fieldValue, onChange, effectiveDefault);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value =
        fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : "";

    if (fieldType === "numberOrKeep") {
        input.placeholder = effectiveDefault !== undefined ? String(effectiveDefault) : "keep or number";
    }

    const setValidationState = (message) => {
        const hasError = typeof message === "string" && message.length > 0;
        input.style.borderColor = hasError
            ? "var(--vscode-inputValidation-errorBorder)"
            : "var(--vscode-input-border)";
        input.setAttribute("aria-invalid", hasError ? "true" : "false");
        return hasError;
    };

    if (fieldType === "numberOrKeep") {
        const wrapper = document.createElement("div");
        const error = document.createElement("div");
        error.className = "input-validation-message";
        error.style.display = "none";

        const showValidationMessage = (message) => {
            if (setValidationState(message)) {
                error.textContent = message;
                error.style.display = "block";
            } else {
                error.textContent = "";
                error.style.display = "none";
            }
        };

        input.oninput = () => {
            showValidationMessage("");
        };

        input.onchange = () => {
            const raw = input.value.trim();
            if (!raw) {
                showValidationMessage("");
                onChange(null);
                return;
            }

            if (raw === "keep") {
                showValidationMessage("");
                onChange("keep");
                return;
            }

            if (/^\d+$/.test(raw)) {
                showValidationMessage("");
                onChange(Number.parseInt(raw, 10));
                return;
            }

            showValidationMessage(
                'Enter an integer or the literal string "keep".',
            );
        };

        wrapper.appendChild(input);
        wrapper.appendChild(error);
        return wrapper;
    }

    input.onchange = () => {
        const raw = input.value.trim();
        onChange(raw ? raw : null);
    };

    return input;
}

function applyFormatPreset(selectedPreset, context) {
    if (!FORMAT_PRESET_VALUES.includes(selectedPreset)) {
        return;
    }

    if (selectedPreset === "default") {
        context.commitLocalChange(FORMAT_STYLE_OVERRIDES_PATH, null);
    } else if (selectedPreset === "cfc") {
        context.commitLocalChange(FORMAT_STYLE_OVERRIDES_PATH, {
            ...FORMAT_CFC_PRESET,
        });
    }

    context.commitLocalChange(FORMAT_PRESET_PATH, selectedPreset);
    context.setFormatAutoSwitchedToCustom(false);
    context.updateAllWidgetValues();
}

function applyFormatStyleOverrideChange(key, nextValue, context) {
    const keyPath = [...FORMAT_STYLE_OVERRIDES_PATH, key];
    const currentPreset = context.getFormatPreset();

    context.commitLocalChange(keyPath, nextValue);

    if (currentPreset !== "custom") {
        context.commitLocalChange(FORMAT_PRESET_PATH, "custom");
        context.setFormatAutoSwitchedToCustom(true);
        context.updateAllWidgetValues();
    }
}

function createFormatRowWithPreview(settingKey, label, description, keyHint, path, input, modified, onReset) {
    const hasPreview = Boolean(settingKey && FORMAT_PREVIEWS[settingKey]);
    const keyHintActions = [];
    let extraContent = null;

    if (hasPreview) {
        const previewContainer = createInlineFormatPreview(settingKey);
        const previewToggle = document.createElement("button");
        previewToggle.type = "button";
        previewToggle.className = "format-preview-toggle";
        previewToggle.textContent = "Preview";
        previewToggle.setAttribute("aria-expanded", "false");
        previewToggle.setAttribute("aria-controls", previewContainer.id);
        previewToggle.addEventListener("click", () => {
            const nextExpanded =
                previewToggle.getAttribute("aria-expanded") !== "true";
            collapseInlineFormatPreviews(previewContainer, previewToggle);
            setInlineFormatPreviewExpanded(
                previewContainer,
                previewToggle,
                nextExpanded,
            );
        });
        keyHintActions.push(previewToggle);
        extraContent = previewContainer;
    }

    return createSettingRow({
        label,
        description,
        keyHint,
        path,
        input,
        inline: true,
        modified: modified || false,
        onReset,
        keyHintActions,
        extraContent,
    });
}

function renderFormatGroup(group, context) {
    const { element, body } = createCollapsibleGroup({
        title: group.title,
    });

    group.keys.forEach((key) => {
        const fieldPath = [...FORMAT_STYLE_OVERRIDES_PATH, key];
        const fieldValue = context.getValue(fieldPath);
        const input = renderFormatStyleInput(key, fieldValue, (newValue) => {
            applyFormatStyleOverrideChange(key, newValue, context);
        }, context);

        body.appendChild(
            createFormatRowWithPreview(
                key,
                formatFieldLabel(key),
                FORMAT_DESCRIPTIONS[key],
                `format.styleOverrides.${key}`,
                fieldPath,
                input,
                fieldValue !== undefined,
                () => {
                    applyFormatStyleOverrideChange(key, null, context);
                    context.updateAllWidgetValues();
                },
            ),
        );
    });

    return element;
}

function highlightLua(code) {
    if (!code) {
        return "";
    }

    const lines = code.split("\n");
    const processed = lines.map((line) => {
        const headerMatch = line.match(/^-----\[\s(.+?)\s\]-----$/);
        if (headerMatch) {
            return `<span class="syntax-header">${escapeHtml(line)}</span>`;
        }
        return null;
    });

    const codeOnly = lines
        .map((line, index) => (processed[index] !== null ? "" : line))
        .join("\n");

    let highlighted;
    const highlighter = globalThis.hljs;
    try {
        highlighted =
            highlighter && typeof highlighter.highlight === "function"
                ? highlighter.highlight(codeOnly, { language: "lua" }).value
                : escapeHtml(codeOnly);
    } catch {
        highlighted = escapeHtml(codeOnly);
    }

    const highlightedLines = highlighted.split("\n");
    let highlightIndex = 0;

    return lines
        .map((_, index) => {
            if (processed[index] !== null) {
                if (highlightedLines[highlightIndex] === "") {
                    highlightIndex += 1;
                }
                return processed[index];
            }

            const highlightedLine = highlightedLines[highlightIndex];
            highlightIndex += 1;
            return highlightedLine !== undefined ? highlightedLine : "";
        })
        .join("\n");
}

export function renderFormatterSectionContent(context) {
    const layout = document.createElement("div");
    layout.className = "format-layout section-body";

    const column = document.createElement("div");
    column.className = "format-settings-column";

    const switchedNote = document.createElement("div");
    switchedNote.className = `formatter-note ${context.getFormatAutoSwitchedToCustom() ? "" : "formatter-note-hidden"}`;
    switchedNote.textContent =
        "Preset automatically switched to Custom because you edited individual formatter settings.";
    column.appendChild(switchedNote);

    column.appendChild(
        createSettingRow({
            label: "Preset",
            path: FORMAT_PRESET_PATH,
            description: "Choose a formatter preset. Default clears all overrides.",
            keyHint: "format.preset",
            input: renderFormatPresetInput(context),
            inline: true,
            modified: context.getValue(FORMAT_PRESET_PATH) !== undefined,
            onReset: () => {
                context.commitLocalChange(FORMAT_STYLE_OVERRIDES_PATH, null);
                context.commitLocalChange(FORMAT_PRESET_PATH, null);
                context.setFormatAutoSwitchedToCustom(false);
                context.updateAllWidgetValues();
            },
        }),
    );

    column.appendChild(
        createSettingRow({
            label: "Config Precedence",
            path: FORMAT_CONFIG_PRECEDENCE_PATH,
            description:
                "If your workspace has an .editorconfig file, preferEditorconfig can override formatter values from .gluarc.json.",
            keyHint: "format.configPrecedence",
            input: renderFormatConfigPrecedenceInput(context),
            inline: true,
            modified: context.getValue(FORMAT_CONFIG_PRECEDENCE_PATH) !== undefined,
            onReset: () => {
                context.commitLocalChange(FORMAT_CONFIG_PRECEDENCE_PATH, null);
                context.updateAllWidgetValues();
            },
        }),
    );

    FORMAT_GROUPS.forEach((group) => {
        column.appendChild(renderFormatGroup(group, context));
    });

    layout.appendChild(column);
    return layout;
}
