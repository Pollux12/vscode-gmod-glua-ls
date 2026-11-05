import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { gamePathToClientPath, GmodSourceMapping } from '../debugger/gmod_debugger/GmodSourcePaths';

/** Longest text a single tool reply carries; Claude Code warns above roughly 10k tokens. */
export const MAX_REPLY_CHARS = 24_000;

export class ToolInputError extends Error {}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new ToolInputError(`"${key}" must be a string.`);
    }
    return value;
}

export function numberArg(args: Record<string, unknown>, key: string, options: { min?: number; max?: number; fallback?: number } = {}): number | undefined {
    const value = args[key];
    if (value === undefined || value === null) {
        return options.fallback;
    }
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
        throw new ToolInputError(`"${key}" must be a number.`);
    }
    let result = parsed;
    if (options.min !== undefined) {
        result = Math.max(options.min, result);
    }
    if (options.max !== undefined) {
        result = Math.min(options.max, result);
    }
    return result;
}

export function booleanArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
    const value = args[key];
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === 'true' || value === 'false') {
        return value === 'true';
    }
    throw new ToolInputError(`"${key}" must be true or false.`);
}

export function enumArg<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback?: T): T {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
        if (fallback !== undefined) {
            return fallback;
        }
        throw new ToolInputError(`"${key}" is required (one of: ${allowed.join(', ')}).`);
    }
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
        throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}.`);
    }
    return value as T;
}

/** Cuts text to `max` characters, saying how much was left out. */
export function clampText(text: string, max = MAX_REPLY_CHARS): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max)}\n... (${text.length - max} more characters cut; narrow the request with search, limit or paths)`;
}

/** Resolves a path an agent gave: absolute, relative to a workspace folder, or relative to the debugger's sourceRoot. */
export function resolveWorkspacePath(input: string, sourceRoot?: string): string | undefined {
    const trimmed = input.trim().replace(/^file:\/\//, '');
    if (trimmed.length === 0) {
        return undefined;
    }
    if (path.isAbsolute(trimmed)) {
        return path.normalize(trimmed);
    }
    const roots = [
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        ...(sourceRoot ? [sourceRoot] : []),
    ];
    for (const root of roots) {
        const candidate = path.resolve(root, trimmed);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    // Paths as include() and logpoint labels write them, relative to lua/ ("myaddon/sv_init.lua").
    for (const root of roots) {
        const candidate = path.resolve(root, 'lua', trimmed);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    // Multi-root workspaces: allow "<folder name>/rest/of/path".
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const prefix = `${folder.name}/`;
        const normalized = trimmed.replace(/\\/g, '/');
        if (normalized.startsWith(prefix)) {
            const candidate = path.resolve(folder.uri.fsPath, normalized.slice(prefix.length));
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return roots.length > 0 ? path.resolve(roots[0], trimmed) : undefined;
}

let annotationsRoot: () => string | undefined = () => undefined;

/** Where the GMod API annotations live, so their files can be shown as `[GMod API] player.lua`. */
export function setAnnotationsRoot(getter: () => string | undefined): void {
    annotationsRoot = getter;
}

export function getAnnotationsRoot(): string | undefined {
    return annotationsRoot();
}

/** Shows a local file the way an agent's own file tools expect: relative to the workspace when inside it. */
export function displayPath(fsPath: string): string {
    const apiRoot = annotationsRoot();
    if (apiRoot) {
        const relative = path.relative(apiRoot, fsPath);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return `[GMod API] ${relative.replace(/\\/g, '/')}`;
        }
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
        const relative = path.relative(folder.uri.fsPath, fsPath);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            const normalized = relative.replace(/\\/g, '/');
            return folders.length > 1 ? `${folder.name}/${normalized}` : normalized;
        }
    }
    return fsPath.replace(/\\/g, '/');
}

const GAME_PATH_PATTERN = /((?:addons\/[^/\s:]+\/)?(?:lua|gamemodes)\/[^\s:'"]+\.lua):(\d+)/g;

/**
 * Rewrites game paths in an error message or stack line (`addons/x/lua/y.lua:12`) to
 * local workspace paths when the file exists there, so the agent can open them directly.
 */
export function mapGamePathsInText(text: string, mapping: GmodSourceMapping | undefined): string {
    if (!mapping || (!mapping.sourceRoot && !mapping.sourceFileMap)) {
        return text;
    }
    return text.replace(GAME_PATH_PATTERN, (whole, gamePath: string, line: string) => {
        const local = gamePathToClientPath(gamePath, mapping);
        if (local && fs.existsSync(local)) {
            return `${displayPath(local)}:${line}`;
        }
        return whole;
    });
}

/** Lines `line - before` to `line + after` of a file, numbered, with `>` on `line`. */
export function sourceExcerpt(fsPath: string, line: number, before = 3, after = 3): string | undefined {
    let text: string;
    try {
        const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === fsPath);
        text = open ? open.getText() : fs.readFileSync(fsPath, 'utf8');
    } catch {
        return undefined;
    }
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, line - before);
    const end = Math.min(lines.length, line + after);
    const width = String(end).length;
    const out: string[] = [];
    for (let current = start; current <= end; current++) {
        const marker = current === line ? '>' : ' ';
        const content = lines[current - 1] ?? '';
        out.push(`${marker} ${String(current).padStart(width)} | ${content.length > 200 ? `${content.slice(0, 200)}...` : content}`);
    }
    return out.join('\n');
}

export function formatAge(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    return `${Math.round(minutes / 60)}h ago`;
}

/** Renders a value from LRDB's JSON (used when the server's bridge is older than the MCP tools). */
export function formatLrdbValue(value: unknown, depth = 1): string {
    if (value === null || value === undefined) {
        return 'nil';
    }
    if (typeof value === 'string') {
        return value.length > 300 ? `${value.slice(0, 300)}...` : value;
    }
    if (typeof value !== 'object') {
        return String(value);
    }
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
        return '{}';
    }
    if (depth <= 0) {
        return `{...} (${entries.length} entries)`;
    }
    const shown = entries.slice(0, 20).map(([key, item]) => `${key} = ${formatLrdbValue(item, depth - 1)}`);
    if (entries.length > 20) {
        shown.push(`... (${entries.length - 20} more)`);
    }
    return `{${shown.join(', ')}}`;
}

export function isLuaIdentifier(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !LUA_KEYWORDS.has(name);
}

const LUA_KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
    'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue',
]);
