// "AI Agents (MCP)" card. These are VS Code settings (gluals.mcp.*), not .gluarc.json values,
// so the card talks to the extension through its own messages.

export function setupMcpCard(vscode) {
    const card = document.getElementById("mcpCard");
    if (!card) {
        return;
    }
    const enabled = document.getElementById("mcpEnabled");
    const port = document.getElementById("mcpPort");
    const status = document.getElementById("mcpStatus");
    const details = document.getElementById("mcpDetails");

    enabled.addEventListener("change", () => {
        vscode.postMessage({ type: "mcp:setEnabled", value: enabled.checked });
    });
    port.addEventListener("change", () => {
        const value = Number(port.value);
        if (Number.isInteger(value) && value >= 1024 && value <= 65535) {
            vscode.postMessage({ type: "mcp:setPort", value });
        }
    });
    for (const button of card.querySelectorAll("[data-mcp-action]")) {
        button.addEventListener("click", () => {
            vscode.postMessage({ type: "mcp:action", action: button.getAttribute("data-mcp-action") });
        });
    }

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "mcpState") {
            return;
        }
        enabled.checked = message.enabled === true;
        if (document.activeElement !== port) {
            port.value = String(message.port);
        }
        status.textContent = message.statusText;
        status.dataset.kind = message.statusKind;
        details.hidden = message.enabled !== true;
    });

    vscode.postMessage({ type: "mcp:ready" });
}
