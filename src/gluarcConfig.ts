import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';

const GLUARC_FILE_NAME = '.gluarc.json';
const UTF8_DECODER = new TextDecoder('utf-8');
const UTF8_ENCODER = new TextEncoder();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(target, key);
}

const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafePath(path: string[]): boolean {
    return path.every((segment) => !UNSAFE_PATH_KEYS.has(segment));
}

function deleteNestedValue(target: Record<string, unknown>, path: string[], depth: number): boolean {
    const key = path[depth];
    if (UNSAFE_PATH_KEYS.has(key) || !hasOwnKey(target, key)) {
        return false;
    }

    if (depth === path.length - 1) {
        delete target[key];
        return Object.keys(target).length === 0;
    }

    const child = target[key];
    if (!isObjectRecord(child)) {
        return false;
    }

    const shouldDeleteChild = deleteNestedValue(child, path, depth + 1);
    if (shouldDeleteChild) {
        delete target[key];
    }

    return Object.keys(target).length === 0;
}

/**
 * Returns the URI for .gluarc.json in a workspace folder.
 */
export function getGluarcUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(workspaceFolder.uri, GLUARC_FILE_NAME);
}

/**
 * Reads .gluarc.json from the workspace folder.
 * Returns {} if the file doesn't exist.
 * Throws on parse errors.
 */
export async function readGluarcConfig(workspaceFolder: vscode.WorkspaceFolder): Promise<Record<string, unknown>> {
    const gluarcUri = getGluarcUri(workspaceFolder);

    try {
        const content = await vscode.workspace.fs.readFile(gluarcUri);
        const raw = UTF8_DECODER.decode(content);

        if (!raw.trim()) {
            return {};
        }

        const parsed = JSON.parse(raw) as unknown;
        if (!isObjectRecord(parsed)) {
            throw new Error(`${GLUARC_FILE_NAME} must contain a JSON object.`);
        }

        return parsed;
    } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            return {};
        }

        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to read ${GLUARC_FILE_NAME}: ${message}`);
        throw error;
    }
}

/**
 * Writes the config object as pretty-printed JSON to .gluarc.json.
 * Shows an error message if write fails.
 * Returns true on success, false on failure.
 */
export async function writeGluarcConfig(
    workspaceFolder: vscode.WorkspaceFolder,
    config: Record<string, unknown>
): Promise<boolean> {
    const gluarcUri = getGluarcUri(workspaceFolder);

    try {
        const serialized = `${JSON.stringify(config, null, 2)}\n`;
        const encoded = UTF8_ENCODER.encode(serialized);
        await vscode.workspace.fs.writeFile(gluarcUri, encoded);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to write ${GLUARC_FILE_NAME}: ${message}`);
        return false;
    }
}

/**
 * Mutates obj by setting the value at the given path array.
 * Creates intermediate objects as needed.
 * If value is undefined or null, deletes the key to keep the file clean.
 * If deleting a key leaves the parent object empty, also removes the parent (cleanup empty sections).
 */
export function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
    if (path.length === 0 || !isSafePath(path)) {
        return;
    }

    if (value === undefined || value === null) {
        deleteNestedValue(obj, path, 0);
        return;
    }

    let current: Record<string, unknown> = obj;

    for (let index = 0; index < path.length - 1; index += 1) {
        const segment = path[index];
        const next = current[segment];

        if (!isObjectRecord(next)) {
            const replacement: Record<string, unknown> = {};
            current[segment] = replacement;
            current = replacement;
            continue;
        }

        current = next;
    }

    current[path[path.length - 1]] = value;
}

/**
 * Gets a value from a nested object by path array.
 * Returns undefined if any segment is missing.
 */
export function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
    if (path.length === 0) {
        return obj;
    }

    let current: unknown = obj;

    for (const segment of path) {
        if (!isObjectRecord(current) || !hasOwnKey(current, segment)) {
            return undefined;
        }

        current = current[segment];
    }

    return current;
}
