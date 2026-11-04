import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { McpToolContext, ToolSpec } from './runtimeTools';
import { booleanArg, clampText, displayPath, enumArg, numberArg, resolveWorkspacePath, sourceExcerpt, stringArg, ToolInputError } from './toolSupport';

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
    private readonly updatedAt = new Map<string, number>();
    private readonly listeners = new Set<(uris: readonly vscode.Uri[]) => void>();
    private readonly subscription: vscode.Disposable;

    constructor() {
        this.subscription = vscode.languages.onDidChangeDiagnostics((event) => {
            const now = Date.now();
            for (const uri of event.uris) {
                this.updatedAt.set(uri.toString(), now);
            }
            for (const listener of [...this.listeners]) {
                listener(event.uris);
            }
        });
    }

    dispose(): void {
        this.subscription.dispose();
        this.listeners.clear();
    }

    lastUpdate(uri: vscode.Uri): number | undefined {
        return this.updatedAt.get(uri.toString());
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

function isUnder(file: string, target: string): boolean {
    const relative = path.relative(target, file);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

            // Files edited since their last analysis: make sure the server sees them, then wait.
            const pending = new Set<string>();
            for (const target of targets) {
                if (!fs.statSync(target).isFile()) {
                    continue;
                }
                const uri = vscode.Uri.file(target);
                const last = watcher.lastUpdate(uri);
                const modified = fs.statSync(target).mtimeMs;
                if (last === undefined || modified > last) {
                    pending.add(uri.toString());
                    if (!vscode.workspace.textDocuments.some((document) => document.uri.fsPath === target)) {
                        await vscode.workspace.openTextDocument(uri).then(undefined, () => undefined);
                    }
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
            let omitted = 0;
            const sorted = [...all].sort(([a], [b]) => a.fsPath.localeCompare(b.fsPath));
            for (const [uri, list] of sorted) {
                const ordered = [...list].sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line);
                for (const diagnostic of ordered) {
                    totals[diagnostic.severity] += 1;
                    if (diagnostic.severity > minSeverity) {
                        continue;
                    }
                    if (listed.length >= limit) {
                        omitted += 1;
                        continue;
                    }
                    const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
                    listed.push(`${displayPath(uri.fsPath)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} `
                        + `${SEVERITY_LABEL[diagnostic.severity]}${code !== undefined ? ` [${code}]` : ''} ${diagnostic.message.replace(/\s*\n\s*/g, ' ')}`);
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
            if (value.trim().length > 0) {
                parts.push(value.trim());
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

function codeLookupTool(): ToolSpec {
    return {
        definition: {
            name: 'code_lookup',
            title: 'Look up GLua symbols with the language server',
            description: [
                'Ask the GLuaLS language server about a symbol: its type and docs (hover), where it is defined, and optionally every reference.',
                'Knows Garry\'s Mod API types, realms, hooks, net messages and the workspace\'s own classes (ENT, SWEP, PANEL, gamemode tables).',
                'Give `symbol` (e.g. "PLAYER:GetMoney", "MyAddon.Config", "net.Start") to search the workspace, or `file` + `line` (+ `symbol` or `column`) to look at a specific spot.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Symbol name to search for, or to locate on `line`.' },
                    file: { type: 'string' },
                    line: { type: 'integer', minimum: 1 },
                    column: { type: 'integer', minimum: 1 },
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
                const tail = (lowered.split(/[.:]/).pop() ?? lowered);
                const ranked = found
                    .filter((entry) => entry.location.uri.scheme === 'file')
                    .sort((a, b) => score(b) - score(a));
                function score(entry: vscode.SymbolInformation): number {
                    const name = entry.name.toLowerCase();
                    const full = `${entry.containerName ?? ''}${entry.containerName ? '.' : ''}${entry.name}`.toLowerCase();
                    return (full === lowered.replace(':', '.') ? 4 : 0) + (name === tail ? 2 : 0) + (name.startsWith(tail) ? 1 : 0);
                }
                if (ranked.length === 0) {
                    return { text: `No workspace symbol matches "${symbol}". Try the last part of the name, or give file + line.` };
                }
                lines.push(`Matches for "${symbol}" (${ranked.length}${ranked.length > 8 ? ', first 8 shown' : ''}):`);
                for (const entry of ranked.slice(0, 8)) {
                    lines.push(`  ${entry.containerName ? `${entry.containerName}.` : ''}${entry.name} (${vscode.SymbolKind[entry.kind]})  ${oneLine(entry.location)}`);
                }
                uri = ranked[0].location.uri;
                const document = await vscode.workspace.openTextDocument(uri);
                const start = ranked[0].location.range.start;
                position = new vscode.Position(start.line, columnOf(document.lineAt(start.line).text, symbol));
                lines.push('', `Details for the first match:`);
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
