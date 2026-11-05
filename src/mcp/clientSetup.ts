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

/** Thrown when config.toml already defines the server in a form setup cannot safely edit. */
export class CodexTomlUnsupportedError extends Error {}

/** Adds or replaces the `[mcp_servers.gluals]` table in a Codex `config.toml`, leaving the rest as it was. */
export function mergeCodexToml(existing: string | undefined, port: number): string {
    const block = codexTomlBlock(port);
    const text = existing ?? '';
    const lines = text.split(/\r?\n/);
    // TOML allows quoted keys and spaces around the dots: [mcp_servers.gluals], [mcp_servers."gluals"], [ mcp_servers . 'gluals' ].
    const name = `(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')`;
    const key = `\\s*mcp_servers\\s*\\.\\s*${name}\\s*`;
    const header = new RegExp(`^\\s*\\[${key}\\]\\s*(#.*)?$`);
    const subTable = new RegExp(`^\\s*\\[${key}\\.`);
    const start = lines.findIndex((line) => header.test(line));
    if (start < 0) {
        // Defined some other way (a dotted key, an inline table under [mcp_servers], or only sub-tables):
        // appending a second definition would make the file invalid, so leave it to the user.
        const elsewhere = new RegExp(`^\\s*(?:mcp_servers\\s*\\.\\s*)?${name}\\s*[.=]`);
        if (lines.some((line) => elsewhere.test(line) || subTable.test(line))) {
            throw new CodexTomlUnsupportedError(`config.toml already defines mcp_servers.${MCP_SERVER_NAME} in a form setup cannot edit safely.`);
        }
        const trimmed = text.replace(/\s+$/, '');
        return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
    }
    let end = start + 1;
    // Replace only the table's own keys, up to the next header. Its sub-tables (env, headers, ...) stay as the user wrote them.
    while (end < lines.length && !/^\s*\[/.test(lines[end])) {
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
