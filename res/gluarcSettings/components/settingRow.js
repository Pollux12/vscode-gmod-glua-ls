/**
 * Creates a standardized setting row element used across all settings sections.
 *
 * @param {object} options
 * @param {string} options.label - The display label for the setting.
 * @param {string} [options.description] - Description text.
 * @param {string} [options.keyHint] - Config path hint (e.g. "format.preset").
 * @param {string[]|string} [options.path] - Data path for search/filter matching.
 * @param {HTMLElement} options.input - The input control element.
 * @param {boolean} [options.inline=true] - Whether to use inline (two-column) layout.
 * @param {boolean} [options.nested=false] - Whether this row is inside a collapsible group.
 * @param {boolean} [options.modified=false] - Whether the setting has been modified from default.
 * @param {function} [options.onReset] - Callback invoked when user clicks the reset-to-default button.
 * @param {HTMLElement[]} [options.labelActions=[]] - Action buttons appended to the label row.
 * @param {HTMLElement[]} [options.keyHintActions=[]] - Action elements appended inline with the key hint.
 * @param {HTMLElement} [options.extraContent] - Extra content appended to the row (e.g. preview panel).
 * @returns {HTMLElement}
 */
export function createSettingRow(options) {
    const {
        description,
        extraContent,
        inline = true,
        input,
        keyHint,
        keyHintActions = [],
        label,
        labelActions = [],
        modified = false,
        nested = false,
        onReset,
        path,
    } = options;

    const row = document.createElement("div");
    row.className = `setting-row ${inline ? "setting-row-inline" : "setting-row-stacked"}`;
    if (nested) {
        row.classList.add("setting-row-nested");
    }
    if (modified) {
        row.classList.add("is-modified");
    }
    row.dataset.path = Array.isArray(path) ? path.join(".") : (path || "");

    const textContainer = document.createElement("div");
    textContainer.className = "setting-text";

    const labelRow = document.createElement("div");
    labelRow.className = "setting-label-row";

    const labelEl = document.createElement("span");
    labelEl.className = "setting-label";
    labelEl.textContent = label;
    labelRow.appendChild(labelEl);

    if (typeof onReset === "function") {
        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "setting-reset-btn";
        resetBtn.title = "Reset to default";
        resetBtn.setAttribute("aria-label", `Reset ${label} to default`);
        resetBtn.textContent = "↺";
        resetBtn.onclick = onReset;
        labelRow.appendChild(resetBtn);
    }

    for (const action of labelActions) {
        labelRow.appendChild(action);
    }

    textContainer.appendChild(labelRow);

    if (description) {
        const descEl = document.createElement("div");
        descEl.className = "setting-description";
        descEl.textContent = description;
        textContainer.appendChild(descEl);
    }

    if (keyHint) {
        const hintRow = document.createElement("div");
        hintRow.className = "setting-key-hint-row";

        const hintEl = document.createElement("span");
        hintEl.className = "setting-key-hint";
        hintEl.textContent = keyHint;
        hintRow.appendChild(hintEl);

        for (const action of keyHintActions) {
            hintRow.appendChild(action);
        }

        textContainer.appendChild(hintRow);
    }

    row.appendChild(textContainer);

    const inputContainer = document.createElement("div");
    inputContainer.className = "setting-input-container";
    inputContainer.appendChild(input);
    row.appendChild(inputContainer);

    if (extraContent) {
        row.appendChild(extraContent);
    }

    return row;
}

/**
 * Creates a collapsible group using <details>/<summary>.
 *
 * @param {object} options
 * @param {string} options.title - The group title shown in the summary.
 * @param {string} [options.description] - Description shown inside the body.
 * @param {string} [options.keyHint] - Config path hint shown inside the body.
 * @param {string} [options.path] - Data path for search/filter matching.
 * @param {boolean} [options.open=true] - Whether the group starts expanded.
 * @returns {{ element: HTMLDetailsElement, body: HTMLDivElement }}
 */
export function createCollapsibleGroup(options) {
    const {
        description,
        keyHint,
        open = true,
        path,
        title,
    } = options;

    const details = document.createElement("details");
    details.className = "collapsible-group";
    details.open = open;
    if (path) {
        details.dataset.path = path;
    }

    const summary = document.createElement("summary");
    summary.textContent = title;
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "collapsible-group-content";

    if (description || keyHint) {
        const infoRow = document.createElement("div");
        infoRow.className = "collapsible-group-info";

        if (description) {
            const descEl = document.createElement("div");
            descEl.className = "setting-description";
            descEl.textContent = description;
            infoRow.appendChild(descEl);
        }

        if (keyHint) {
            const hintEl = document.createElement("div");
            hintEl.className = "setting-key-hint";
            hintEl.textContent = keyHint;
            infoRow.appendChild(hintEl);
        }

        body.appendChild(infoRow);
    }

    details.appendChild(body);
    return { element: details, body };
}
