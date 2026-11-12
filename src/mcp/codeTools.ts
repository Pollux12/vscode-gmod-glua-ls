import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { McpToolContext, ToolSpec } from './runtimeTools';
import { booleanArg, clampText, displayPath, enumArg, getAnnotationsRoot, numberArg, resolveWorkspacePath, sourceExcerpt, stringArg, ToolInputError } from './toolSupport';

/** The `source` the GLuaLS language server puts on its diagnostics. */
export const LANGUAGE_SERVER_SOURCE = 'GLuaLS';

const SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;
type SeverityName = (typeof SEVERITIES)[number];
const SEVERITY_RANK: Record<SeverityName, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
};
const SEVERITY_LABEL = ['error', 'warning', 'info', 'hint'];

/**
 * Remembers when diagnostics last changed for each file, so a request about a file
 * edited after that can wait for the language server to catch up.
 */
export class DiagnosticsWatcher implements vscode.Disposable {
    /** Files changed on disk before this are assumed to have been analysed already. */
    readonly startedAt = Date.now();
    private readonly updatedAt = new Map<string, number>();
    private readonly editedAt = new Map<string, number>();
    private readonly listeners = new Set<(uris: readonly vscode.Uri[]) => void>();
    private readonly subscriptions: vscode.Disposable[];

    constructor() {
        this.subscriptions = [
            vscode.languages.onDidChangeDiagnostics((event) => {
                const now = Date.now();
                for (const uri of event.uris) {
                    this.updatedAt.set(uri.toString(), now);
                }
                for (const listener of [...this.listeners]) {
                    listener(event.uris);
                }
            }),
            // Edits in an open editor change what the language server analyses without touching the file on disk.
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.uri.scheme === 'file' && event.contentChanges.length > 0) {
                    this.editedAt.set(event.document.uri.toString(), Date.now());
                }
            }),
        ];
    }

    dispose(): void {
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.listeners.clear();
    }

    lastUpdate(uri: vscode.Uri): number | undefined {
        return this.updatedAt.get(uri.toString());
    }

    lastEdit(uri: vscode.Uri): number | undefined {
        return this.editedAt.get(uri.toString());
    }

    /** Waits until every URI in `pending` had a diagnostics update, or the timeout passes. */
    waitForUpdates(pending: Set<string>, timeoutMs: number): Promise<void> {
        if (pending.size === 0 || timeoutMs <= 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                this.listeners.delete(listener);
                resolve();
            };
            const listener = (uris: readonly vscode.Uri[]) => {
                for (const uri of uris) {
                    pending.delete(uri.toString());
                }
                if (pending.size === 0) {
                    finish();
                }
            };
            const timer = setTimeout(finish, timeoutMs);
            this.listeners.add(listener);
        });
    }
}

const fileLines = new Map<string, string[]>();

function sourceLine(uri: vscode.Uri, line: number): string | undefined {
    const key = uri.toString();
    let lines = fileLines.get(key);
    if (!lines) {
        const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
        try {
            lines = (open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8')).split(/\r?\n/);
        } catch {
            return undefined;
        }
        fileLines.set(key, lines);
    }
    const text = lines[line]?.trim();
    return text ? (text.length > 160 ? `${text.slice(0, 160)}...` : text) : undefined;
}

function isUnder(file: string, target: string): boolean {
    const relative = path.relative(target, file);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const FOLDER_SCAN_LIMIT = 5000;
const MAX_FILES_TO_REFRESH = 50;

/** Lua files under `folder` changed on disk since `since` (bounded, skipping hidden folders and node_modules). */
function luaFilesChangedSince(folder: string, since: number): string[] {
    const found: string[] = [];
    const queue = [folder];
    let seen = 0;
    while (queue.length > 0 && seen < FOLDER_SCAN_LIMIT) {
        const dir = queue.shift()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            seen += 1;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    queue.push(full);
                }
            } else if (entry.name.endsWith('.lua')) {
                try {
                    if (fs.statSync(full).mtimeMs > since) {
                        found.push(full);
                    }
                } catch {
                    // Deleted while scanning.
                }
            }
        }
    }
    return found;
}

function diagnosticsTool(context: McpToolContext, watcher: DiagnosticsWatcher): ToolSpec {
    return {
        definition: {
            name: 'diagnostics',
            title: 'GLua language server diagnostics',
            description: [
                'Errors and warnings from the GLuaLS language server (undefined globals, wrong realm, type and argument mismatches, net message mismatches, syntax errors, ...).',
                'Pass `paths` (files or folders) to check what you just edited; it waits briefly for the server to re-analyse files that changed. Without paths, covers the whole workspace.',
                'Always starts with totals per severity. Default min_severity is warning.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative or absolute files/folders.' },
                    min_severity: { type: 'string', enum: [...SEVERITIES], description: 'Lowest severity to list (default warning).' },
                    limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most entries to list (default 100).' },
                    wait_ms: { type: 'integer', minimum: 0, maximum: 15000, description: 'How long to wait for fresh results on changed files (default 4000).' },
                },
            },
            annotations: { title: 'Diagnostics', readOnlyHint: true, openWorldHint: false },
        },
        handler: async (args) => {
            fileLines.clear();
            const minSeverity = SEVERITY_RANK[enumArg(args, 'min_severity', SEVERITIES, 'warning')];
            const limit = numberArg(args, 'limit', { min: 1, max: 500, fallback: 100 })!;
            const waitMs = numberArg(args, 'wait_ms', { min: 0, max: 15_000, fallback: 4000 })!;
            const rawPaths = args.paths;
            if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.some((entry) => typeof entry !== 'string'))) {
                throw new ToolInputError('"paths" must be an array of strings.');
            }
            const targets: string[] = [];
            const missing: string[] = [];
            for (const entry of (rawPaths as string[] | undefined) ?? []) {
                const resolved = resolveWorkspacePath(entry);
                if (resolved && fs.existsSync(resolved)) {
                    targets.push(resolved);
                } else {
                    missing.push(entry);
                }
            }

            // Files edited (on disk or in an editor) since their last analysis: make sure the server sees them, then wait.
            // Inside a requested folder, only files changed since the watcher started are candidates.
            const candidates = new Map<string, boolean>();
            for (const target of targets) {
                if (fs.statSync(target).isFile()) {
                    candidates.set(target, true);
                    continue;
                }
                for (const file of luaFilesChangedSince(target, watcher.startedAt)) {
                    candidates.set(file, candidates.get(file) ?? false);
                }
                for (const document of vscode.workspace.textDocuments) {
                    if (document.uri.scheme === 'file' && isUnder(document.uri.fsPath, target) && watcher.lastEdit(document.uri) !== undefined) {
                        candidates.set(document.uri.fsPath, candidates.get(document.uri.fsPath) ?? false);
                    }
                }
            }
            const pending = new Set<string>();
            for (const [file, requested] of candidates) {
                if (pending.size >= MAX_FILES_TO_REFRESH) {
                    break;
                }
                const uri = vscode.Uri.file(file);
                const last = watcher.lastUpdate(uri);
                let changed = watcher.lastEdit(uri) ?? 0;
                try {
                    changed = Math.max(changed, fs.statSync(file).mtimeMs);
                } catch {
                    continue;
                }
                if (changed > (last ?? watcher.startedAt)) {
                    pending.add(uri.toString());
                }
                if ((requested || pending.has(uri.toString())) && !vscode.workspace.textDocuments.some((document) => document.uri.fsPath === file)) {
                    await vscode.workspace.openTextDocument(uri).then(undefined, () => undefined);
                }
            }
            const waitedFor = pending.size;
            await watcher.waitForUpdates(pending, waitMs);

            const all = vscode.languages.getDiagnostics()
                .filter(([uri]) => uri.scheme === 'file')
                .map(([uri, list]) => [uri, list.filter((diagnostic) => diagnostic.source === LANGUAGE_SERVER_SOURCE)] as const)
                .filter(([uri, list]) => list.length > 0 && (targets.length === 0 || targets.some((target) => isUnder(uri.fsPath, target))));

            const totals = [0, 0, 0, 0];
            const listed: string[] = [];
            let listedCount = 0;
            let omitted = 0;
            const sorted = [...all].sort(([a], [b]) => a.fsPath.localeCompare(b.fsPath));
            for (const [uri, list] of sorted) {
                const ordered = [...list].sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line);
                for (const diagnostic of ordered) {
                    totals[diagnostic.severity] += 1;
                    if (diagnostic.severity > minSeverity) {
                        continue;
                    }
                    // The limit counts diagnostics, not output lines (each may add a source line).
                    if (listedCount >= limit) {
                        omitted += 1;
                        continue;
                    }
                    listedCount += 1;
                    const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
                    const message = diagnostic.message.replace(/\s*\n\s*/g, ' ').replace(/[\s.]+$/, '');
                    listed.push(`${displayPath(uri.fsPath)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} `
                        + `${SEVERITY_LABEL[diagnostic.severity]}${code !== undefined ? ` [${code}]` : ''} ${message}`);
                    // The offending line, so the agent can judge the fix without opening the file.
                    const source = sourceLine(uri, diagnostic.range.start.line);
                    if (source) {
                        listed.push(`    | ${source}`);
                    }
                }
            }

            const scope = targets.length > 0 ? `${targets.map(displayPath).join(', ')}` : 'whole workspace';
            const lines = [`Diagnostics for ${scope}: ${totals[0]} errors, ${totals[1]} warnings, ${totals[2]} info, ${totals[3]} hints.`];
            if (missing.length > 0) {
                lines.push(`Not found: ${missing.join(', ')}`);
            }
            if (waitedFor > 0 && pending.size > 0) {
                lines.push(`Note: ${pending.size} file(s) had not been re-analysed after ${waitMs} ms; results for them may be stale.`);
            }
            const hidden = totals.reduce((sum, count, severity) => sum + (severity > minSeverity ? count : 0), 0);
            if (hidden > 0) {
                lines.push(`${hidden} lower-severity item(s) not listed; pass min_severity "hint" to include them.`);
            }
            if (listed.length === 0) {
                lines.push(totals.some((count) => count > 0) ? 'Nothing at or above the requested severity.' : 'No problems found.');
            } else {
                lines.push(...listed);
                if (omitted > 0) {
                    lines.push(`... ${omitted} more (raise limit, narrow paths or raise min_severity).`);
                }
            }
            return { text: clampText(lines.join('\n')) };
        },
    };
}

function hoverText(hovers: vscode.Hover[] | undefined): string | undefined {
    const parts: string[] = [];
    for (const hover of hovers ?? []) {
        for (const content of hover.contents) {
            const value = typeof content === 'string' ? content : 'value' in content ? content.value : '';
            // Realm badges are images; the bold realm name next to them says the same.
            const text = value.replace(/!\[[^\]]*\]\([^)]*\)\s*/g, '').trim();
            if (text.length > 0) {
                parts.push(text);
            }
        }
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function locationsOf(result: Array<vscode.Location | vscode.LocationLink> | vscode.Location | undefined): vscode.Location[] {
    if (!result) {
        return [];
    }
    const list = Array.isArray(result) ? result : [result];
    return list.map((entry) => 'targetUri' in entry ? new vscode.Location(entry.targetUri, entry.targetSelectionRange ?? entry.targetRange) : entry);
}

function oneLine(location: vscode.Location): string {
    const line = location.range.start.line + 1;
    const excerpt = sourceExcerpt(location.uri.fsPath, line, 0, 0);
    const text = excerpt ? excerpt.replace(/^>\s*\d+\s*\|\s?/, '').trim() : '';
    return `${displayPath(location.uri.fsPath)}:${line}${text ? `  ${text}` : ''}`;
}

/** Finds `name` on a line, preferring the last segment of dotted/colon names. */
function columnOf(lineText: string, name: string | undefined): number {
    if (name) {
        const last = name.split(/[.:]/).pop() ?? name;
        const match = new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(lineText);
        if (match) {
            return match.index;
        }
    }
    const firstCode = lineText.search(/\S/);
    return firstCode >= 0 ? firstCode : 0;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SourceMatch {
    location: vscode.Location;
    isDefinition: boolean;
}

/** Lua files of the GMod API annotations, read once per folder and kept in memory. */
let apiFileCache: { root: string; files: Array<{ uri: vscode.Uri; text: string }> } | undefined;

function apiFiles(): Array<{ uri: vscode.Uri; text: string }> {
    const root = getAnnotationsRoot();
    if (!root || !fs.existsSync(root)) {
        return [];
    }
    if (apiFileCache?.root !== root) {
        const files: Array<{ uri: vscode.Uri; text: string }> = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.endsWith('.lua')) {
                    files.push({ uri: vscode.Uri.file(full), text: fs.readFileSync(full, 'utf8') });
                }
            }
        };
        walk(root);
        apiFileCache = { root, files };
    }
    return apiFileCache.files;
}

/**
 * Finds where `symbol` is written in `files`. For `A.B` / `A:B` the whole path must
 * match; for a bare name any `X.name` or `X:name` matches too. Definitions come first.
 */
function searchSource(files: Iterable<{ uri: vscode.Uri; text: string }>, symbol: string, limit: number): SourceMatch[] {
    const parts = symbol.split(/[.:]/).filter((part) => part.length > 0);
    if (parts.length === 0) {
        return [];
    }
    const tail = parts[parts.length - 1];
    const pathPattern = parts.length > 1
        ? parts.map(escapeRegExp).join('\\s*[.:]\\s*')
        : `(?:[A-Za-z_][\\w]*\\s*[.:]\\s*)*${escapeRegExp(tail)}`;
    const definition = new RegExp(`function\\s+(${pathPattern})\\b|(${pathPattern})\\s*=(?!=)`);
    const usage = new RegExp(`\\b(${pathPattern})\\b`);
    const definitions: SourceMatch[] = [];
    const usages: SourceMatch[] = [];
    for (const file of files) {
        if (!file.text.includes(tail)) {
            continue;
        }
        const lines = file.text.split(/\r?\n/);
        for (let index = 0; index < lines.length && definitions.length < limit; index++) {
            const defined = definition.exec(lines[index]);
            const found = defined ?? (usages.length === 0 ? usage.exec(lines[index]) : null);
            if (!found) {
                continue;
            }
            const matched = found[1] ?? found[2];
            const column = lines[index].indexOf(matched, found.index) + matched.length - tail.length;
            const location = new vscode.Location(file.uri, new vscode.Position(index, column));
            (defined ? definitions : usages).push({ location, isDefinition: !!defined });
        }
        if (definitions.length >= limit) {
            break;
        }
    }
    return [...definitions, ...usages].slice(0, limit);
}

/**
 * Finds `symbol` in the workspace's Lua files, then in the GMod API annotations. The
 * language server's workspace symbols only list the workspace's globals, so members
 * (`MyAddon.Config`) and API functions (`Player:Nick`) are found in the source instead.
 */
async function findInSource(symbol: string, limit = 8): Promise<SourceMatch[]> {
    const workspaceFiles = await vscode.workspace.findFiles('**/*.lua', '**/{node_modules,.git}/**', 20_000);
    function* read() {
        for (const uri of workspaceFiles) {
            try {
                yield { uri, text: fs.readFileSync(uri.fsPath, 'utf8') };
            } catch {
                // unreadable file
            }
        }
    }
    const inWorkspace = searchSource(read(), symbol, limit);
    if (inWorkspace.some((match) => match.isDefinition)) {
        return inWorkspace;
    }
    const inApi = searchSource(apiFiles(), symbol, limit).filter((match) => match.isDefinition);
    return [...inApi, ...inWorkspace].slice(0, limit);
}

function codeLookupTool(): ToolSpec {
    return {
        definition: {
            name: 'code_lookup',
            title: 'Look up GLua symbols with the language server',
            description: [
                'Ask the GLuaLS language server about a symbol: its type and docs (hover), where it is defined, and optionally every reference.',
                'Knows Garry\'s Mod API types, realms, hooks, net messages and the workspace\'s own classes (ENT, SWEP, PANEL, gamemode tables).',
                'Give `symbol` (e.g. "Player:Nick", "MyAddon.Config", "hook.Add") to find it in the workspace or the GMod API, or `file` + `line` (+ `symbol` or `column`) to look at a specific spot.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Symbol name to search for, or to locate on `line`.' },
                    file: { type: 'string', description: 'Workspace-relative or absolute path, to look at a spot instead of searching.' },
                    line: { type: 'integer', minimum: 1, description: 'With file: the 1-based line.' },
                    column: { type: 'integer', minimum: 1, description: 'With file: the 1-based column. Optional when symbol names what is on the line.' },
                    references: { type: 'boolean', description: 'Also list references (default false).' },
                },
            },
            annotations: { title: 'Code lookup', readOnlyHint: true, openWorldHint: false },
        },
        handler: async (args) => {
            const symbol = stringArg(args, 'symbol')?.trim();
            const file = stringArg(args, 'file');
            const lineArg = numberArg(args, 'line', { min: 1 });
            const columnArg = numberArg(args, 'column', { min: 1 });
            const wantReferences = booleanArg(args, 'references');
            const lines: string[] = [];

            let position: vscode.Position | undefined;
            let uri: vscode.Uri | undefined;
            if (file !== undefined) {
                const resolved = resolveWorkspacePath(file);
                if (!resolved || !fs.existsSync(resolved)) {
                    throw new ToolInputError(`File not found: ${file}`);
                }
                if (lineArg === undefined) {
                    throw new ToolInputError('"line" is required with "file".');
                }
                uri = vscode.Uri.file(resolved);
                const document = await vscode.workspace.openTextDocument(uri);
                const lineIndex = Math.min(document.lineCount - 1, Math.floor(lineArg) - 1);
                const lineText = document.lineAt(lineIndex).text;
                const column = columnArg !== undefined ? Math.floor(columnArg) - 1 : columnOf(lineText, symbol);
                position = new vscode.Position(lineIndex, Math.min(column, lineText.length));
            } else if (symbol) {
                const found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', symbol) ?? [];
                const lowered = symbol.toLowerCase();
                const tail = lowered.split(/[.:]/).pop() ?? lowered;
                const score = (entry: vscode.SymbolInformation): number => {
                    const name = entry.name.toLowerCase();
                    const full = `${entry.containerName ?? ''}${entry.containerName ? '.' : ''}${entry.name}`.toLowerCase();
                    return (full === lowered.replace(':', '.') ? 4 : 0) + (name === tail ? 2 : 0) + (name.startsWith(tail) ? 1 : 0);
                };
                const ranked = found.filter((entry) => entry.location.uri.scheme === 'file').sort((a, b) => score(b) - score(a));
                const exact = ranked.length > 0 && score(ranked[0]) >= (/[.:]/.test(symbol) ? 4 : 2);
                if (!exact) {
                    const matches = await findInSource(symbol);
                    if (matches.length > 0) {
                        uri = matches[0].location.uri;
                        position = matches[0].location.range.start;
                        // With references requested, the references list below already shows every place.
                        if (matches.length === 1 || wantReferences) {
                            lines.push(`Found "${symbol}" at ${oneLine(matches[0].location)}`, '');
                        } else {
                            lines.push(`Matches for "${symbol}":`, ...matches.map((match) => `  ${oneLine(match.location)}`), '', 'Details for the first match:');
                        }
                    }
                }
                if (!position) {
                    if (ranked.length === 0) {
                        return { text: `Nothing in the workspace matches "${symbol}". Check the spelling, or give file + line.` };
                    }
                    lines.push(`Matches for "${symbol}" (${ranked.length}${ranked.length > 8 ? ', first 8 shown' : ''}):`);
                    for (const entry of ranked.slice(0, 8)) {
                        lines.push(`  ${entry.containerName ? `${entry.containerName}.` : ''}${entry.name} (${vscode.SymbolKind[entry.kind]})  ${oneLine(entry.location)}`);
                    }
                    uri = ranked[0].location.uri;
                    const document = await vscode.workspace.openTextDocument(uri);
                    const start = ranked[0].location.range.start;
                    position = new vscode.Position(start.line, columnOf(document.lineAt(start.line).text, symbol));
                    lines.push('', 'Details for the first match:');
                }
            } else {
                throw new ToolInputError('Give "symbol", or "file" and "line".');
            }

            const [hovers, definitions] = await Promise.all([
                vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position),
                vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', uri, position),
            ]);
            const hover = hoverText(hovers);
            lines.push(hover ? `Hover:\n${hover}` : 'Hover: (nothing at this position)');
            const definitionList = locationsOf(definitions);
            if (definitionList.length > 0) {
                lines.push('Defined at:', ...definitionList.slice(0, 10).map((location) => `  ${oneLine(location)}`));
            }
            if (wantReferences) {
                const references = locationsOf(await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position));
                lines.push(`References (${references.length}${references.length > 60 ? ', first 60 shown' : ''}):`);
                lines.push(...references.slice(0, 60).map((location) => `  ${oneLine(location)}`));
            }
            return { text: clampText(lines.join('\n')) };
        },
    };
}

export function codeTools(context: McpToolContext, watcher: DiagnosticsWatcher): ToolSpec[] {
    void context;
    return [diagnosticsTool(context, watcher), codeLookupTool()];
}
