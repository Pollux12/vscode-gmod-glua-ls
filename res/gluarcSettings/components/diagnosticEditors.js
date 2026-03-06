import {
    DIAGNOSTIC_CODES,
    DIAGNOSTIC_DEFAULT_ENABLE,
    DIAGNOSTIC_DEFAULT_SEVERITY,
    DIAGNOSTIC_SEVERITY_VALUES,
    DIAGNOSTIC_STATE_CODES,
} from "../data.js";

function getDiagnosticDefaultEnable(code) {
    return DIAGNOSTIC_DEFAULT_ENABLE[code] !== false;
}

function getDiagnosticDefaultSeverity(code) {
    return DIAGNOSTIC_DEFAULT_SEVERITY[code] || "warning";
}

function normalizeSeverityOverrides(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    const normalized = {};
    for (const [key, severity] of Object.entries(value)) {
        if (DIAGNOSTIC_SEVERITY_VALUES.includes(severity)) {
            normalized[key] = severity;
        }
    }

    return normalized;
}

function toTitleCase(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function createDiagnosticTableShell(headers) {
    const container = document.createElement("div");
    container.className = "severity-table-container";

    const toolbar = document.createElement("div");
    toolbar.className = "severity-table-toolbar";

    const overridesCount = document.createElement("div");
    overridesCount.className = "severity-overrides-count";
    toolbar.appendChild(overridesCount);

    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.className = "severity-filter";
    filterInput.placeholder = "Filter codes...";
    toolbar.appendChild(filterInput);
    container.appendChild(toolbar);

    const scroll = document.createElement("div");
    scroll.className = "severity-table-scroll";

    const table = document.createElement("table");
    table.className = "severity-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    headers.forEach((text) => {
        const th = document.createElement("th");
        th.textContent = text;
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    scroll.appendChild(table);
    container.appendChild(scroll);

    return {
        container,
        tbody,
        filterInput,
        setOverridesText: (text) => {
            overridesCount.textContent = text;
        },
    };
}

function setupTableFilter(filterInput, rows) {
    const updateFilter = () => {
        const query = filterInput.value.trim().toLowerCase();
        rows.forEach(({ row, code }) => {
            row.style.display =
                !query || code.toLowerCase().includes(query) ? "" : "none";
        });
    };

    filterInput.addEventListener("input", updateFilter);
    return updateFilter;
}

export function isDiagnosticsStateField(field) {
    return (
        Array.isArray(field.path) &&
        field.path.length === 2 &&
        field.path[0] === "diagnostics" &&
        field.path[1] === "enables"
    );
}

export function isSeverityField(field) {
    return (
        Array.isArray(field.path) &&
        field.path.length >= 2 &&
        field.path[0] === "diagnostics" &&
        field.path[1] === "severity"
    );
}

export function hasMeaningfulStateOverrides(getValue) {
    const enables = getValue(["diagnostics", "enables"]) || [];
    const disable = getValue(["diagnostics", "disable"]) || [];

    if (Array.isArray(enables)) {
        for (const code of enables) {
            if (typeof code === "string" && !getDiagnosticDefaultEnable(code)) {
                return true;
            }
        }
    }

    if (Array.isArray(disable)) {
        for (const code of disable) {
            if (typeof code === "string" && getDiagnosticDefaultEnable(code)) {
                return true;
            }
        }
    }

    return false;
}

export function hasMeaningfulSeverityOverrides(severityConfig) {
    if (!severityConfig || typeof severityConfig !== "object") return false;

    for (const [code, severity] of Object.entries(severityConfig)) {
        if (severity !== getDiagnosticDefaultSeverity(code)) {
            return true;
        }
    }

    return false;
}

export function renderDiagnosticsStateTable(field, context) {
    const enablesRaw = context.getValue(["diagnostics", "enables"]) || [];
    const disableRaw = context.getValue(["diagnostics", "disable"]) || [];

    const enables = Array.isArray(enablesRaw)
        ? enablesRaw.filter((code) => typeof code === "string")
        : [];
    const disable = Array.isArray(disableRaw)
        ? disableRaw.filter((code) => typeof code === "string")
        : [];

    const validCodeSet = new Set(DIAGNOSTIC_STATE_CODES);
    const stateMap = {};

    enables.forEach((code) => {
        if (validCodeSet.has(code)) {
            stateMap[code] = "enable";
        }
    });

    disable.forEach((code) => {
        if (validCodeSet.has(code)) {
            stateMap[code] = "disable";
        }
    });

    const { container, tbody, filterInput, setOverridesText } =
        createDiagnosticTableShell([
            "Diagnostic Code",
            "Default",
            "Override",
            "",
        ]);

    const isStateOverridden = (code) => {
        const state = stateMap[code];
        if (state === undefined) return false;
        const defaultEnabled = getDiagnosticDefaultEnable(code);
        return state !== (defaultEnabled ? "enable" : "disable");
    };

    const updateOverridesCount = () => {
        const count = DIAGNOSTIC_STATE_CODES.reduce((total, code) => {
            return isStateOverridden(code) ? total + 1 : total;
        }, 0);
        setOverridesText(`${count} overrides active`);
    };

    const commitStateToConfig = () => {
        const nextEnables = [];
        const nextDisable = [];

        DIAGNOSTIC_STATE_CODES.forEach((code) => {
            const state = stateMap[code];
            if (state === "enable") {
                nextEnables.push(code);
            } else if (state === "disable") {
                nextDisable.push(code);
            }
        });

        context.commitLocalChange(
            ["diagnostics", "enables"],
            nextEnables.length > 0 ? nextEnables : null,
        );
        context.commitLocalChange(
            ["diagnostics", "disable"],
            nextDisable.length > 0 ? nextDisable : null,
        );
    };

    const rows = [];

    DIAGNOSTIC_STATE_CODES.forEach((code) => {
        const defaultEnabled = getDiagnosticDefaultEnable(code);
        const defaultValue = defaultEnabled ? "enable" : "disable";

        const row = document.createElement("tr");
        row.dataset.code = code;

        const codeCell = document.createElement("td");
        codeCell.className = "severity-code";
        codeCell.textContent = code;
        row.appendChild(codeCell);

        const defaultCell = document.createElement("td");
        defaultCell.textContent = defaultEnabled ? "Enabled" : "Disabled";
        defaultCell.style.color = "var(--vscode-descriptionForeground)";
        row.appendChild(defaultCell);

        const overrideCell = document.createElement("td");
        const select = document.createElement("select");

        const enableOption = document.createElement("option");
        enableOption.value = "enable";
        enableOption.textContent = "Enabled";
        select.appendChild(enableOption);

        const disableOption = document.createElement("option");
        disableOption.value = "disable";
        disableOption.textContent = "Disabled";
        select.appendChild(disableOption);

        const currentState = stateMap[code];
        const isOverridden = isStateOverridden(code);
        select.value = currentState || defaultValue;
        if (isOverridden) row.classList.add("is-overridden");

        const resetCell = document.createElement("td");
        const resetBtn = document.createElement("button");
        resetBtn.className = "severity-row-reset";
        resetBtn.textContent = "↺";
        resetBtn.title = "Reset to default";
        resetBtn.style.visibility = isOverridden ? "visible" : "hidden";

        const updateRowState = () => {
            const overridden = isStateOverridden(code);
            row.classList.toggle("is-overridden", overridden);
            resetBtn.style.visibility = overridden ? "visible" : "hidden";
        };

        select.onchange = () => {
            const selectedValue = select.value;
            if (selectedValue === defaultValue) {
                delete stateMap[code];
            } else {
                stateMap[code] = selectedValue;
            }
            updateRowState();
            updateOverridesCount();
            commitStateToConfig();
        };

        resetBtn.onclick = () => {
            delete stateMap[code];
            select.value = defaultValue;
            updateRowState();
            updateOverridesCount();
            commitStateToConfig();
        };

        overrideCell.appendChild(select);
        row.appendChild(overrideCell);
        resetCell.appendChild(resetBtn);
        row.appendChild(resetCell);

        tbody.appendChild(row);
        rows.push({ row, code });
    });

    const runFilter = setupTableFilter(filterInput, rows);
    updateOverridesCount();
    runFilter();

    return container;
}

export function renderSeverityTable(field, severityConfig, context) {
    const { container, tbody, filterInput, setOverridesText } =
        createDiagnosticTableShell([
            "Diagnostic Code",
            "Default",
            "Severity",
            "",
        ]);

    const localOverrides = normalizeSeverityOverrides(severityConfig);

    const isSeverityOverridden = (code) => {
        const value = localOverrides[code];
        if (!value) return false;
        return value !== getDiagnosticDefaultSeverity(code);
    };

    const updateOverridesCount = () => {
        const count = DIAGNOSTIC_CODES.reduce((total, code) => {
            return isSeverityOverridden(code) ? total + 1 : total;
        }, 0);
        setOverridesText(`${count} overrides active`);
    };

    const rows = [];

    DIAGNOSTIC_CODES.forEach((code) => {
        const defaultSeverity = getDiagnosticDefaultSeverity(code);

        const row = document.createElement("tr");
        row.dataset.code = code;

        const codeCell = document.createElement("td");
        codeCell.className = "severity-code";
        codeCell.textContent = code;
        row.appendChild(codeCell);

        const defaultCell = document.createElement("td");
        defaultCell.textContent = toTitleCase(defaultSeverity);
        defaultCell.style.color = "var(--vscode-descriptionForeground)";
        row.appendChild(defaultCell);

        const selectCell = document.createElement("td");
        const select = document.createElement("select");

        DIAGNOSTIC_SEVERITY_VALUES.forEach((severity) => {
            const option = document.createElement("option");
            option.value = severity;
            option.textContent = toTitleCase(severity);
            select.appendChild(option);
        });

        const currentValue = localOverrides[code];
        const isOverridden = isSeverityOverridden(code);
        select.value = currentValue || defaultSeverity;
        if (isOverridden) row.classList.add("is-overridden");

        const resetCell = document.createElement("td");
        const resetBtn = document.createElement("button");
        resetBtn.className = "severity-row-reset";
        resetBtn.textContent = "↺";
        resetBtn.title = "Reset to default";
        resetBtn.style.visibility = isOverridden ? "visible" : "hidden";

        const updateRowState = () => {
            const overridden = isSeverityOverridden(code);
            row.classList.toggle("is-overridden", overridden);
            resetBtn.style.visibility = overridden ? "visible" : "hidden";
        };

        select.onchange = () => {
            const selectedValue = select.value;
            if (selectedValue === defaultSeverity) {
                delete localOverrides[code];
            } else {
                localOverrides[code] = selectedValue;
            }
            updateRowState();
            updateOverridesCount();
            context.commitLocalChange(
                [...field.path, code],
                selectedValue === defaultSeverity ? null : selectedValue,
            );
        };

        resetBtn.onclick = () => {
            delete localOverrides[code];
            select.value = defaultSeverity;
            updateRowState();
            updateOverridesCount();
            context.commitLocalChange([...field.path, code], null);
        };

        selectCell.appendChild(select);
        row.appendChild(selectCell);
        resetCell.appendChild(resetBtn);
        row.appendChild(resetCell);

        tbody.appendChild(row);
        rows.push({ row, code });
    });

    const runFilter = setupTableFilter(filterInput, rows);
    updateOverridesCount();
    runFilter();

    return container;
}