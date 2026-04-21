import * as path from 'path';
import * as fs from 'fs';
import { PLUGIN_CONTAINER_SCOPE_PATHS } from './gmodFrameworkScopePatterns';
import { isRecognizedClassScopePath, normalizeScopePath } from './gmodFrameworkWizardScopes';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Candidate scope directory found by scanning the workspace. */
export interface ScannedScope {
    id: string;
    relativePath: string;
    label: string;
    fileCount: number;
}

export interface ScopeDiscoveryCandidate {
    relativePath: string;
    fileCount: number;
    important: boolean;
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

export async function safeReaddir(dirPath: string): Promise<string[]> {
    try {
        return await fs.promises.readdir(dirPath);
    } catch {
        return [];
    }
}

export async function isDirectory(dirPath: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(dirPath)).isDirectory();
    } catch {
        return false;
    }
}

export async function countLuaFiles(dirPath: string, maxDepth: number = 3): Promise<number> {
    let count = 0;
    const stack: Array<[string, number]> = [[dirPath, 0]];
    while (stack.length > 0) {
        const [current, depth] = stack.pop()!;
        if (depth > maxDepth) continue;
        for (const entry of await safeReaddir(current)) {
            const full = path.join(current, entry);
            if (await isDirectory(full)) {
                stack.push([full, depth + 1]);
            } else if (entry.endsWith('.lua')) {
                count++;
            }
        }
    }
    return count;
}

export async function workspaceContainsPath(folderPath: string, relativePath: string): Promise<boolean> {
    const fullPath = path.join(folderPath, ...relativePath.split('/'));
    return isDirectory(fullPath);
}

export async function getWorkspaceLuaFileCount(folderPath: string, relativePath: string, maxDepth: number = 3): Promise<number> {
    const fullPath = path.join(folderPath, ...relativePath.split('/'));
    if (!(await isDirectory(fullPath))) {
        return 0;
    }

    return countLuaFiles(fullPath, maxDepth);
}

export async function isSafeCustomGenericScopePath(folderPath: string, relativePath: string): Promise<boolean> {
    const normalized = normalizeScopePath(relativePath);
    const segments = normalized.split('/');
    const inPluginContainer = [...PLUGIN_CONTAINER_SCOPE_PATHS].some((pluginContainerPath) =>
        normalized === pluginContainerPath || normalized.startsWith(`${pluginContainerPath}/`),
    );

    if (segments[0] === 'schema' || inPluginContainer) {
        return false;
    }

    return (await workspaceContainsPath(folderPath, relativePath))
        && (await getWorkspaceLuaFileCount(folderPath, relativePath, 3)) > 0;
}

export function shouldAcceptCustomScopePath(folderPath: string, relativePath: string): Promise<boolean> {
    if (isRecognizedClassScopePath(relativePath)) {
        return Promise.resolve(true);
    }
    return isSafeCustomGenericScopePath(folderPath, relativePath);
}

// ─── Scope discovery ──────────────────────────────────────────────────────────

export function addScopeCandidate(
    scopes: Map<string, ScopeDiscoveryCandidate>,
    relativePath: string,
    fileCount: number,
    important: boolean,
): void {
    const normalized = relativePath.replace(/\\/g, '/');
    const existing = scopes.get(normalized);
    if (!existing) {
        scopes.set(normalized, { relativePath: normalized, fileCount, important });
        return;
    }

    existing.fileCount = Math.max(existing.fileCount, fileCount);
    existing.important = existing.important || important;
}

export async function collectRecognizedScopeDescendants(
    folderPath: string,
    scanRootRelativePath: string,
    maxDepth: number,
): Promise<ScopeDiscoveryCandidate[]> {
    const scanRootFullPath = path.join(folderPath, ...scanRootRelativePath.split('/'));
    if (!(await isDirectory(scanRootFullPath))) {
        return [];
    }

    const discovered = new Map<string, ScopeDiscoveryCandidate>();
    const queue: Array<{ fullPath: string; depth: number }> = [{ fullPath: scanRootFullPath, depth: 0 }];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.depth >= maxDepth) {
            continue;
        }

        for (const entry of await safeReaddir(current.fullPath)) {
            if (entry.startsWith('.') || entry === 'node_modules') {
                continue;
            }

            const childFullPath = path.join(current.fullPath, entry);
            if (!(await isDirectory(childFullPath))) {
                continue;
            }

            const relFromFolder = path.relative(folderPath, childFullPath).replace(/\\/g, '/');
            const isRecognized = isRecognizedClassScopePath(relFromFolder);
            if (isRecognized) {
                const fileCount = await countLuaFiles(childFullPath, 2);
                if (fileCount > 0) {
                    addScopeCandidate(discovered, relFromFolder, fileCount, true);
                }
            }

            queue.push({ fullPath: childFullPath, depth: current.depth + 1 });
        }
    }

    return [...discovered.values()];
}

/**
 * Scans the workspace folder for directories that look like they contain
 * Lua class/plugin/scope files. Used to populate the wizard's script folder step.
 */
export async function scanWorkspaceScopes(folderPath: string): Promise<ScannedScope[]> {
    // Known common patterns to check first
    const COMMON_PATHS = [
        'schema',
        'schema/items',
        'schema/attributes',
        'schema/classes',
        'schema/factions',
        'schema/plugins',
        'gamemode/framework',
        'gamemode/schema',
        'gamemode/entities',
        'gamemode/config',
        'gamemode/libraries',
        'gamemode/modules',
        'gamemode/weapons',
        'gamemode/plugins',
        'lua/darkrp_modules',
        'lua/darkrp_customthings',
        'lua/darkrp_config',
        'lua/darkrp_language',
        'lua/entities',
        'lua/weapons',
        'plugins',
        'entities',
        'weapons',
    ];

    const discoveredScopes = new Map<string, ScopeDiscoveryCandidate>();

    for (const relPath of COMMON_PATHS) {
        const full = path.join(folderPath, relPath);
        if (!(await isDirectory(full))) continue;

        const normalized = relPath.replace(/\\/g, '/');
        if (!isRecognizedClassScopePath(normalized)) continue;

        const fileCount = await countLuaFiles(full);
        if (fileCount === 0) continue;

        addScopeCandidate(discoveredScopes, normalized, fileCount, true);
    }

    const boundedScanRoots = [
        { relativePath: '', maxDepth: 1 },
        { relativePath: 'gamemode', maxDepth: 3 },
        { relativePath: 'schema', maxDepth: 3 },
        { relativePath: 'lua', maxDepth: 3 },
    ];

    for (const scanRoot of boundedScanRoots) {
        for (const candidate of await collectRecognizedScopeDescendants(folderPath, scanRoot.relativePath, scanRoot.maxDepth)) {
            addScopeCandidate(discoveredScopes, candidate.relativePath, candidate.fileCount, candidate.important);
        }
    }

    for (const pluginContainer of PLUGIN_CONTAINER_SCOPE_PATHS) {
        const containerFullPath = path.join(folderPath, ...pluginContainer.split('/'));
        if (!(await isDirectory(containerFullPath))) continue;

        for (const pluginDirName of await safeReaddir(containerFullPath)) {
            const pluginFullPath = path.join(containerFullPath, pluginDirName);
            if (!(await isDirectory(pluginFullPath))) continue;

            for (const entry of await safeReaddir(pluginFullPath)) {
                const nestedFullPath = path.join(pluginFullPath, entry);
                if (!(await isDirectory(nestedFullPath))) continue;

                const relFromFolder = path.relative(folderPath, nestedFullPath).replace(/\\/g, '/');
                if (!isRecognizedClassScopePath(relFromFolder)) continue;

                const fileCount = await countLuaFiles(nestedFullPath, 2);
                if (fileCount === 0) continue;

                addScopeCandidate(discoveredScopes, relFromFolder, fileCount, true);
            }
        }
    }

    const redundantFiltered = [...discoveredScopes.values()].filter((scope) => {
        // Reduce noisy duplicates: if both loader root and plugin-container path are present,
        // keep the more explicit plugin-container scope and drop generic parent duplicates.
        if (scope.relativePath === 'plugins' && discoveredScopes.has('schema/plugins')) {
            return false;
        }
        if (scope.relativePath === 'gamemode/plugins' && discoveredScopes.has('plugins')) {
            return false;
        }
        return true;
    });

    const scopes = redundantFiltered.map((scope) => {
        const parts = scope.relativePath.split('/');
        const lastPart = parts[parts.length - 1] || scope.relativePath;
        return {
            id: scope.relativePath.replace(/\//g, '-'),
            relativePath: scope.relativePath,
            label: `${lastPart} (${scope.relativePath}) — ${scope.fileCount} Lua file(s)`,
            fileCount: scope.fileCount,
            important: scope.important,
        };
    });

    scopes.sort((a, b) => {
        if (a.important !== b.important) {
            return a.important ? -1 : 1;
        }

        if (b.fileCount !== a.fileCount) {
            return b.fileCount - a.fileCount;
        }

        return a.relativePath.localeCompare(b.relativePath);
    });

    const importantScopes = scopes.filter((scope) => scope.important);
    const optionalScopes = scopes.filter((scope) => !scope.important);
    return [...importantScopes, ...optionalScopes].slice(0, 20);
}
