// "AI Agents (MCP)" section. Its values are VS Code settings (gluals.mcp.*), not
// .gluarc.json values, so it talks to the extension through its own messages
// instead of the panel's config path.

import { createSettingRow } from "./components/settingRow.js";

const SECTION_ID = "cat-mcp";
const DEFAULTS = { enabled: false, port: 21120, allowCodeExecution: true, autoAttach: true };

let vscodeApi;
let state = { ...DEFAULTS, statusKind: "disabled", statusText: "Off" };
const controls = {};

/** Listens for state from the extension. Call once at startup. */
export function setupMcpSection(vscode) {
    vscodeApi = vscode;
    window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "mcpState") {
            return;
        }
        state = { ...state, ...message };
        updateMcpSection();
    });
    vscode.postMessage({ type: "mcp:ready" });
}

function setSetting(key, value) {
    vscodeApi?.postMessage({ type: "mcp:setSetting", key, value });
}

function booleanSelect(key) {
    const select = document.createElement("select");
    for (const [value, label] of [["true", "Enabled"], ["false", "Disabled"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    }
    select.onchange = () => setSetting(key, select.value === "true");
    controls[key] = select;
    return select;
}

function portInput() {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1024";
    input.max = "65535";
    input.onchange = () => {
        const value = Number(input.value);
        if (Number.isInteger(value) && value >= 1024 && value <= 65535) {
            setSetting("port", value);
        } else {
            input.value = String(state.port);
        }
    };
    controls.port = input;
    return input;
}

function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "add-btn";
    button.textContent = label;
    button.onclick = () => vscodeApi?.postMessage({ type: "mcp:action", action });
    return button;
}

function settingRow(key, label, description, input) {
    const row = createSettingRow({
        label,
        description,
        keyHint: `gluals.mcp.${key}`,
        path: ["mcp", key],
        input,
        inline: true,
        onReset: () => setSetting(key, null),
    });
    controls[`${key}Row`] = row;
    return row;
}

/**
 * Appends the section and its sidebar entry. renderSettings() rebuilds both lists,
 * so it calls this last each time; search pairs sections and entries by position.
 */
export function renderMcpSection({ categoryList, sectionsContent, onCategoryClick }) {
    const item = document.createElement("li");
    item.className = "category-item";
    item.textContent = "AI Agents (MCP)";
    item.dataset.target = SECTION_ID;
    item.onclick = () => onCategoryClick(SECTION_ID);
    categoryList.appendChild(item);

    const section = document.createElement("section");
    section.id = SECTION_ID;

    const heading = document.createElement("div");
    heading.className = "section-heading";
    const title = document.createElement("h2");
    title.textContent = "AI Agents (MCP)";
    heading.appendChild(title);
    const description = document.createElement("div");
    description.className = "section-description";
    description.textContent = "Let AI agents run Lua on your GMod server, read its console and errors, and debug it. "
        + "Saved in VS Code settings, not .gluarc.json.";
    heading.appendChild(description);
    section.appendChild(heading);

    const body = document.createElement("div");
    body.className = "section-body";

    body.appendChild(settingRow("enabled", "MCP Server",
        "Run the MCP server for AI agents. Only this computer can connect.",
        booleanSelect("enabled")));

    const status = document.createElement("span");
    status.className = "mcp-status";
    controls.status = status;
    const statusWrap = document.createElement("div");
    statusWrap.className = "mcp-status-control";
    statusWrap.appendChild(status);
    const copy = actionButton("Copy URL", "copyUrl");
    controls.copy = copy;
    statusWrap.appendChild(copy);
    const statusRow = createSettingRow({
        label: "Status",
        description: "The address agents connect to.",
        path: ["mcp", "status"],
        input: statusWrap,
        inline: true,
    });
    body.appendChild(statusRow);

    body.appendChild(createSettingRow({
        label: "Connect an Agent",
        description: "Copilot and Cursor connect automatically. Set up Claude Code, Codex and others here.",
        path: ["mcp", "setup"],
        input: actionButton("Set Up Agent…", "setup"),
        inline: true,
    }));

    body.appendChild(settingRow("port", "Port",
        "Port the MCP server listens on.",
        portInput()));

    body.appendChild(settingRow("allowCodeExecution", "Allow Code Execution",
        "Let agents run Lua and console commands on the server. When disabled, they can still read and debug.",
        booleanSelect("allowCodeExecution")));

    body.appendChild(settingRow("autoAttach", "Auto Attach",
        "Connect the debugger automatically when an agent needs it.",
        booleanSelect("autoAttach")));

    section.appendChild(body);
    sectionsContent.appendChild(section);
    updateMcpSection();
}

function updateMcpSection() {
    for (const key of ["enabled", "allowCodeExecution", "autoAttach"]) {
        if (controls[key]) {
            controls[key].value = state[key] ? "true" : "false";
        }
    }
    if (controls.port && document.activeElement !== controls.port) {
        controls.port.value = String(state.port);
    }
    for (const key of Object.keys(DEFAULTS)) {
        controls[`${key}Row`]?.classList.toggle("is-modified", state[key] !== DEFAULTS[key]);
    }
    if (controls.status) {
        controls.status.textContent = state.statusText;
        controls.status.dataset.kind = state.statusKind;
    }
    if (controls.copy) {
        controls.copy.hidden = state.statusKind !== "running";
    }
}
