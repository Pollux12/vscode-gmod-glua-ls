/**
 * Config snippets and file merges that point AI clients at the GLuaLS MCP server.
 * No vscode import, so these are unit-tested directly.
 */

export const MCP_SERVER_NAME = 'gluals';

export function mcpUrl(port: number): string {
    return `http://127.0.0.1:${port}/mcp`;
}

export type JsonServersKey = 'mcpServers' | 'servers';

/**
 * Adds or replaces one server in a JSON config such as `.mcp.json` (`mcpServers`) or
 * `.vscode/mcp.json` (`servers`), keeping every other entry. Throws when the existing
 * text is not plain JSON, so the caller can fall back to showing the snippet.
 */
export function mergeJsonServerConfig(existing: string | undefined, key: JsonServersKey, name: string, entry: Record<string, unknown>): string {
    let root: Record<string, unknown> = {};
    if (existing !== undefined && existing.trim().length > 0) {
        const parsed: unknown = JSON.parse(existing);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('The file does not contain a JSON object.');
        }
        root = parsed as Record<string, unknown>;
    }
    const current = root[key];
    const servers = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
    servers[name] = entry;
    root[key] = servers;
    return `${JSON.stringify(root, null, 2)}\n`;
}

export function claudeCodeEntry(port: number): Record<string, unknown> {
    return { type: 'http', url: mcpUrl(port) };
}

export function cursorEntry(port: number): Record<string, unknown> {
    return { url: mcpUrl(port) };
}

export function vscodeEntry(port: number): Record<string, unknown> {
    return { type: 'http', url: mcpUrl(port) };
}

export function claudeCodeCommand(port: number): string {
    return `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl(port)}`;
}

/** Codex's default 60 s tool timeout is shorter than a debugger wait plus margin, so raise it. */
export function codexTomlBlock(port: number): string {
    return [
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `url = "${mcpUrl(port)}"`,
        'tool_timeout_sec = 120',
        '',
    ].join('\n');
}

/** Adds or replaces the `[mcp_servers.gluals]` table in a Codex `config.toml`, leaving the rest as it was. */
export function mergeCodexToml(existing: string | undefined, port: number): string {
    const block = codexTomlBlock(port);
    const text = existing ?? '';
    const lines = text.split(/\r?\n/);
    const header = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${MCP_SERVER_NAME}"|${MCP_SERVER_NAME})\\]\\s*(#.*)?$`);
    const start = lines.findIndex((line) => header.test(line));
    if (start < 0) {
        const trimmed = text.replace(/\s+$/, '');
        return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
    }
    let end = start + 1;
    // The table runs until the next header that is not one of its own sub-tables.
    while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !lines[end].trim().startsWith(`[mcp_servers.${MCP_SERVER_NAME}.`))) {
        end += 1;
    }
    const before = lines.slice(0, start).join('\n').replace(/\s+$/, '');
    const after = lines.slice(end).join('\n').replace(/^\s+/, '');
    return [before, block.replace(/\n$/, ''), after].filter((part) => part.length > 0).join('\n\n') + '\n';
}

/** The generic snippet most other clients (Windsurf, Cline, Zed, ...) accept with small changes. */
export function genericJsonSnippet(port: number): string {
    return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl(port) } } }, null, 2);
}
