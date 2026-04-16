import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { applyGluarcPatch, buildPresetPatchEntries } from './gluarcPatch';
import { ensureGluarcExists } from './gluarcConfig';
import {
    LOADER_SCOPE_DIR_TO_CLASS_GLOBAL,
    PLUGIN_CONTAINER_SCOPE_PATHS,
    matchStructuralLoaderScope,
} from './gmodFrameworkScopePatterns';

// ─── Wizard result ────────────────────────────────────────────────────────────

export interface WizardResult {
    /** Whether the wizard completed and wrote changes. */
    applied: boolean;
    /** Workspace folder that was targeted. */
    folder: vscode.WorkspaceFolder | undefined;
}

export interface FrameworkSetupWizardOptions {
    /**
     * Optional paths to preselect in the script-folder step when they are
     * present in the workspace. Used by uncertain preset detection so the
     * guided path can start with conservative framework-specific suggestions.
     */
    recommendedScopePaths?: string[];
}

// ─── Filesystem scan helpers ──────────────────────────────────────────────────

/** Candidate scope directory found by scanning the workspace. */
interface ScannedScope {
    id: string;
    relativePath: string;
    label: string;
    fileCount: number;
}

interface InferredClassScopeFields {
    classGlobal: string;
    fixedClassName?: string;
    include: string[];
    path: string[];
    rootDir?: string;
    isGlobalSingleton?: boolean;
    stripFilePrefix?: boolean;
    hideFromOutline?: boolean;
}

interface ScopeDiscoveryCandidate {
    relativePath: string;
    fileCount: number;
    important: boolean;
}

const EXACT_CLASS_SCOPE_PATHS: ReadonlySet<string> = new Set([
    'schema',
    ...PLUGIN_CONTAINER_SCOPE_PATHS,
]);

const HEURISTIC_FRAMEWORK_SCOPE_FIELDS: Readonly<Record<string, InferredClassScopeFields>> = {
    'gamemode/framework': {
        classGlobal: 'GM',
        include: ['gamemode/framework/**'],
        path: ['gamemode', 'framework'],
        rootDir: 'gamemode/framework',
    },
    'gamemode/modules': {
        classGlobal: 'GM',
        include: ['gamemode/modules/**'],
        path: ['gamemode', 'modules'],
        rootDir: 'gamemode/modules',
    },
    'gamemode/schema': {
        classGlobal: 'GM',
        include: ['gamemode/schema/**'],
        path: ['gamemode', 'schema'],
        rootDir: 'gamemode/schema',
    },
    'gamemode/config': {
        classGlobal: 'GM',
        include: ['gamemode/config/**'],
        path: ['gamemode', 'config'],
        rootDir: 'gamemode/config',
    },
    'gamemode/libraries': {
        classGlobal: 'GM',
        include: ['gamemode/libraries/**'],
        path: ['gamemode', 'libraries'],
        rootDir: 'gamemode/libraries',
    },
    'lua/darkrp_modules': {
        classGlobal: 'GM',
        include: ['lua/darkrp_modules/**'],
        path: ['lua', 'darkrp_modules'],
        rootDir: 'lua/darkrp_modules',
    },
    'lua/darkrp_customthings': {
        classGlobal: 'GM',
        include: ['lua/darkrp_customthings/**'],
        path: ['lua', 'darkrp_customthings'],
        rootDir: 'lua/darkrp_customthings',
    },
    'lua/darkrp_config': {
        classGlobal: 'GM',
        include: ['lua/darkrp_config/**'],
        path: ['lua', 'darkrp_config'],
        rootDir: 'lua/darkrp_config',
    },
    'lua/darkrp_language': {
        classGlobal: 'GM',
        include: ['lua/darkrp_language/**'],
        path: ['lua', 'darkrp_language'],
        rootDir: 'lua/darkrp_language',
    },
};

const NESTED_GAMEMODE_FRAMEWORK_ROOTS: ReadonlySet<string> = new Set([
    'framework',
    'modules',
    'schema',
    'config',
    'libraries',
]);

const NESTED_LUA_FRAMEWORK_ROOTS: ReadonlySet<string> = new Set([
    'darkrp_modules',
    'darkrp_customthings',
    'darkrp_config',
    'darkrp_language',
]);

function getHeuristicFrameworkScopeFields(dirPath: string): InferredClassScopeFields | undefined {
    const normalized = normalizeScopePath(dirPath);
    const exact = HEURISTIC_FRAMEWORK_SCOPE_FIELDS[normalized];
    if (exact) {
        return exact;
    }

    const segments = normalized.split('/');
    if (segments.length < 3) {
        return undefined;
    }

    const lastSegment = segments[segments.length - 1];
    if (segments[0] === 'gamemode' && segments[1] !== 'plugins' && NESTED_GAMEMODE_FRAMEWORK_ROOTS.has(lastSegment)) {
        return {
            classGlobal: 'GM',
            include: [`${normalized}/**`],
            path: segments,
            rootDir: normalized,
        };
    }

    if (segments[0] === 'lua' && segments[1] !== 'plugins' && NESTED_LUA_FRAMEWORK_ROOTS.has(lastSegment)) {
        return {
            classGlobal: 'GM',
            include: [`${normalized}/**`],
            path: segments,
            rootDir: normalized,
        };
    }

    return undefined;
}

function safeReaddir(dirPath: string): string[] {
    try {
        return fs.readdirSync(dirPath);
    } catch {
        return [];
    }
}

function isDirectory(dirPath: string): boolean {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
}

function countLuaFiles(dirPath: string, maxDepth: number = 3): number {
    let count = 0;
    const stack: Array<[string, number]> = [[dirPath, 0]];
    while (stack.length > 0) {
        const [current, depth] = stack.pop()!;
        if (depth > maxDepth) continue;
        for (const entry of safeReaddir(current)) {
            const full = path.join(current, entry);
            if (isDirectory(full)) {
                stack.push([full, depth + 1]);
            } else if (entry.endsWith('.lua')) {
                count++;
            }
        }
    }
    return count;
}

function workspaceContainsPath(folderPath: string, relativePath: string): boolean {
    const fullPath = path.join(folderPath, ...relativePath.split('/'));
    return isDirectory(fullPath);
}

function getWorkspaceLuaFileCount(folderPath: string, relativePath: string, maxDepth: number = 3): number {
    const fullPath = path.join(folderPath, ...relativePath.split('/'));
    if (!isDirectory(fullPath)) {
        return 0;
    }

    return countLuaFiles(fullPath, maxDepth);
}

function isSafeCustomGenericScopePath(folderPath: string, relativePath: string): boolean {
    const normalized = normalizeScopePath(relativePath);
    const segments = normalized.split('/');
    const inPluginContainer = [...PLUGIN_CONTAINER_SCOPE_PATHS].some((pluginContainerPath) =>
        normalized === pluginContainerPath || normalized.startsWith(`${pluginContainerPath}/`),
    );

    if (segments[0] === 'schema' || inPluginContainer) {
        return false;
    }

    return workspaceContainsPath(folderPath, relativePath) && getWorkspaceLuaFileCount(folderPath, relativePath, 3) > 0;
}

function addScopeCandidate(
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

function collectRecognizedScopeDescendants(
    folderPath: string,
    scanRootRelativePath: string,
    maxDepth: number,
): ScopeDiscoveryCandidate[] {
    const scanRootFullPath = path.join(folderPath, ...scanRootRelativePath.split('/'));
    if (!isDirectory(scanRootFullPath)) {
        return [];
    }

    const discovered = new Map<string, ScopeDiscoveryCandidate>();
    const queue: Array<{ fullPath: string; depth: number }> = [{ fullPath: scanRootFullPath, depth: 0 }];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.depth >= maxDepth) {
            continue;
        }

        for (const entry of safeReaddir(current.fullPath)) {
            if (entry.startsWith('.') || entry === 'node_modules') {
                continue;
            }

            const childFullPath = path.join(current.fullPath, entry);
            if (!isDirectory(childFullPath)) {
                continue;
            }

            const relFromFolder = path.relative(folderPath, childFullPath).replace(/\\/g, '/');
            const isRecognized = isRecognizedClassScopePath(relFromFolder);
            if (isRecognized) {
                const fileCount = countLuaFiles(childFullPath, 2);
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
 * Returns true when a folder path is a real scripted-class loader root we know
 * how to model conservatively. This deliberately excludes arbitrary schema/
 * implementation folders such as schema/meta, schema/derma, schema/libs, or
 * plugin implementation directories like plugins/writing.
 */
function isRecognizedClassScopePath(dirPath: string): boolean {
    const normalizedPath = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedKey = normalizeScopePath(normalizedPath);
    if (EXACT_CLASS_SCOPE_PATHS.has(normalizedKey)) {
        return true;
    }

    if (getHeuristicFrameworkScopeFields(normalizedKey)) {
        return true;
    }

    return matchStructuralLoaderScope(normalizedPath) !== undefined;
}

/**
 * Scans the workspace folder for directories that look like they contain
 * Lua class/plugin/scope files. Used to populate the wizard's script folder step.
 */
function scanWorkspaceScopes(folderPath: string): ScannedScope[] {
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
        if (!isDirectory(full)) continue;

        const normalized = relPath.replace(/\\/g, '/');
        if (!isRecognizedClassScopePath(normalized)) continue;

        const fileCount = countLuaFiles(full);
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
        for (const candidate of collectRecognizedScopeDescendants(folderPath, scanRoot.relativePath, scanRoot.maxDepth)) {
            addScopeCandidate(discoveredScopes, candidate.relativePath, candidate.fileCount, candidate.important);
        }
    }

    for (const pluginContainer of PLUGIN_CONTAINER_SCOPE_PATHS) {
        const containerFullPath = path.join(folderPath, ...pluginContainer.split('/'));
        if (!isDirectory(containerFullPath)) continue;

        for (const pluginDirName of safeReaddir(containerFullPath)) {
            const pluginFullPath = path.join(containerFullPath, pluginDirName);
            if (!isDirectory(pluginFullPath)) continue;

            for (const entry of safeReaddir(pluginFullPath)) {
                const nestedFullPath = path.join(pluginFullPath, entry);
                if (!isDirectory(nestedFullPath)) continue;

                const relFromFolder = path.relative(folderPath, nestedFullPath).replace(/\\/g, '/');
                if (!isRecognizedClassScopePath(relFromFolder)) continue;

                const fileCount = countLuaFiles(nestedFullPath, 2);
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

// ─── Lua identifier validation ────────────────────────────────────────────────

/**
 * Returns `true` when `name` is a syntactically valid Lua identifier:
 * it starts with a letter or underscore and contains only letters, digits,
 * and underscores.
 *
 * Used to reject obviously malformed names entered in the suppress-warning
 * input before writing them to `.gluarc.json`. Names that pass this check are
 * not guaranteed to be
 * valid *Lua globals* (they could still conflict with keywords or built-ins),
 * but they are safe to write as config values.
 */
export function isValidLuaIdentifier(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// ─── Scope preselection set ───────────────────────────────────────────────────

/**
 * Scope directory paths that are pre-checked by default in the script-folder
 * selection step because they are unambiguously common Garry's Mod directories.
 * Exported so it can be referenced in tests.
 */
export const PRESELECT_SCOPE_PATHS: ReadonlySet<string> = new Set([
    'schema',
    'schema/items',
    'schema/attributes',
    'schema/factions',
    'schema/classes',
    'schema/plugins',
    'gamemode/entities',
    'gamemode/weapons',
    'gamemode/plugins',
    'lua/entities',
    'lua/weapons',
    'plugins',
    'entities',
    'weapons',
]);

/**
 * Normalises a scope directory path for stable comparison:
 * - converts backslashes to forward slashes
 * - strips trailing slashes
 * - lowercases (for case-insensitive deduplication)
 *
 * The return value is suitable as a map/set key but should not be stored as
 * the canonical path (use the separator-normalised form instead).
 */
export function normalizeScopePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Deduplicates an array of scope directory paths.  Comparison is
 * case-insensitive and backslashes are treated as forward slashes, so the
 * same logical directory never produces two entries regardless of how the
 * user typed it.  The first occurrence wins and its original letter casing is
 * preserved (only backslashes are converted to forward slashes and trailing
 * slashes are stripped) so that emitted config fields — `include`, `rootDir`,
 * and `path` — are correct on case-sensitive filesystems.
 *
 * Use {@link normalizeScopePath} when you need a lowercase dedup key; do NOT
 * store its return value as a canonical config path.
 */
export function deduplicateScopePaths(paths: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of paths) {
        const key = normalizeScopePath(raw);
        if (!seen.has(key)) {
            seen.add(key);
            // Preserve original casing; only normalise separators and trim
            // trailing slashes so the emitted path is filesystem-accurate.
            result.push(raw.replace(/\\/g, '/').replace(/\/+$/, ''));
        }
    }
    return result;
}

// ─── Custom scope path normalization ─────────────────────────────────────────

/**
 * Normalises a user-entered custom scope path for safe use in include globs.
 *
 * Rules applied (in order):
 * 1. Convert backslashes to forward slashes and trim surrounding whitespace.
 * 2. Strip any number of leading `./` prefixes (relative-from-here notation).
 * 3. Reject absolute Unix paths (`/…`) and absolute Windows paths (`C:/…`).
 * 4. Reject any path that contains `..` as a segment (traversal anywhere in
 *    the path, e.g. `schema/../plugins` as well as the leading `../` form).
 * 5. Reject paths containing glob metacharacters (`*`, `?`, `[`, `]`, `{`, `}`, `!`)
 *    which would produce broken or dangerously broad include globs.
 * 6. Strip trailing slashes.
 * 7. Reject dot-segment-only results such as `.` or `./.` that would collapse
 *    to the workspace root and produce an over-broad `./**` include.
 * 8. Reject empty results.
 *
 * Returns the normalised relative path string, or `null` when the input
 * should be silently discarded.  The caller should warn the user in that case.
 */
export function normalizeCustomScopePath(rawPath: string): string | null {
    // Step 1 — separator normalisation and whitespace trim
    let p = rawPath.replace(/\\/g, '/').trim();

    // Step 2 — strip any number of leading "./" sequences
    while (p.startsWith('./')) {
        p = p.slice(2);
    }

    // Step 3 — reject absolute paths
    if (p.startsWith('/')) { return null; }
    if (/^[A-Za-z]:/.test(p)) { return null; } // Windows absolute (e.g. C:/path)

    // Step 4 — reject any ".." path segment (upward traversal anywhere in path)
    if (p.split('/').some((seg) => seg === '..')) { return null; }

    // Step 5 — reject glob metacharacters to prevent broken / dangerous globs
    if (/[*?[\]{}!]/.test(p)) { return null; }

    // Step 6 — strip trailing slashes
    p = p.replace(/\/+$/, '');

    // Step 7 — reject dot-segment-only paths that would target the workspace root
    if (p.split('/').every((seg) => seg === '.')) { return null; }

    // Step 8 — reject empty result
    if (p.length === 0) { return null; }

    return p;
}

function shouldAcceptCustomScopePath(folderPath: string, relativePath: string): boolean {
    return isRecognizedClassScopePath(relativePath) || isSafeCustomGenericScopePath(folderPath, relativePath);
}

// ─── classGlobal heuristic ────────────────────────────────────────────────────

/**
 * Map from well-known Lua scope directory names (lowercase) to the canonical
 * classGlobal used in that directory.  Used by {@link inferClassGlobal} to
 * automatically assign the right global per scope without any extra UI.
 */
export const SCOPE_NAME_TO_CLASS_GLOBAL: Readonly<Record<string, string>> = {
    schema: 'Schema',
    attributes: 'ATTRIBUTE',
    ...LOADER_SCOPE_DIR_TO_CLASS_GLOBAL,
    languages: 'LANGUAGE',
};

/**
 * Infers the `classGlobal` for a scope directory from its last path segment.
 * Matching is case-insensitive so `Plugins`, `PLUGINS`, and `plugins` all map
 * to `PLUGIN`.  Returns `fallback` when the directory name is not in
 * {@link SCOPE_NAME_TO_CLASS_GLOBAL}.
 */
export function inferClassGlobal(dirPath: string, fallback: string): string {
    const dirName = path.basename(dirPath).toLowerCase();
    return SCOPE_NAME_TO_CLASS_GLOBAL[dirName] ?? fallback;
}

function inferClassScopeFields(dirPath: string, fallbackClassGlobal: string): InferredClassScopeFields {
    const normalizedPath = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedKey = normalizeScopePath(normalizedPath);
    const heuristicFrameworkScope = getHeuristicFrameworkScopeFields(normalizedKey);
    const structuralMatch = matchStructuralLoaderScope(normalizedPath);

    if (heuristicFrameworkScope) {
        return heuristicFrameworkScope;
    }

    switch (normalizedKey) {
        case 'schema':
            return {
                classGlobal: 'Schema',
                fixedClassName: 'Schema',
                isGlobalSingleton: true,
                hideFromOutline: true,
                include: ['schema/**', 'gamemode/schema.lua'],
                path: ['schema'],
                rootDir: 'schema',
            };
        case 'plugins':
        case 'schema/plugins':
            return {
                classGlobal: 'PLUGIN',
                include: ['plugins/**', 'schema/plugins/**', 'gamemode/plugins/**'],
                path: ['plugins'],
                rootDir: 'plugins',
            };
    }

    // Generic loader directories: use wildcard patterns that match the
    // directory wherever it appears (under schema, under plugins/*, etc.).
    const lastSegment = normalizedKey.split('/').pop() ?? '';
    const classGlobal = SCOPE_NAME_TO_CLASS_GLOBAL[lastSegment];
    const stripFilePrefixDirs = new Set(['items', 'factions', 'classes', 'attributes']);
    if (classGlobal && lastSegment !== 'plugins') {
        return {
            classGlobal,
            stripFilePrefix: stripFilePrefixDirs.has(lastSegment) || undefined,
            include: [`**/${lastSegment}/**`],
            path: [lastSegment],
        };
    }

    if (structuralMatch?.kind === 'plugin-contained-loader') {
        return {
            classGlobal: structuralMatch.classGlobal,
            stripFilePrefix: stripFilePrefixDirs.has(structuralMatch.loaderDirName) || undefined,
            include: [`**/${structuralMatch.loaderDirName}/**`],
            path: [structuralMatch.loaderDirName],
        };
    }

    return {
        classGlobal: inferClassGlobal(normalizedPath, fallbackClassGlobal),
        include: [`${normalizedPath}/**`],
        path: normalizedPath.split('/'),
        rootDir: normalizedPath,
    };
}

// ─── Scope path rejection diagnostics ────────────────────────────────────────

/**
 * Returns a short, plain-English reason explaining why `raw` was rejected by
 * {@link normalizeCustomScopePath}.  Used to build user-facing warning messages
 * so the wizard can tell the user exactly what was wrong with each entry.
 *
 * Call only when `normalizeCustomScopePath(raw) === null`.
 */
function categorizeScopePathRejection(raw: string): string {
    let p = raw.replace(/\\/g, '/').trim();
    while (p.startsWith('./')) { p = p.slice(2); }

    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
        return 'absolute path — use a path relative to your workspace (e.g. "gamemode/plugins")';
    }
    if (p.split('/').some((seg) => seg === '..')) {
        return 'paths cannot contain ".." segments (e.g. "schema/../plugins")';
    }
    if (/[*?[\]{}!]/.test(p)) {
        return 'contains wildcards or special characters — remove *, ?, {}, [], !';
    }
    if (p.split('/').every((seg) => seg === '.')) {
        return 'path cannot be the workspace root — enter a real subfolder such as "gamemode/plugins"';
    }
    return 'blank or empty after stripping whitespace';
}

// ─── Wizard implementation ────────────────────────────────────────────────────

/**
 * Multi-step wizard for setting up an unknown or custom framework project.
 * Writes only `gmod.scriptedClassScopes.include` (plus optionally `diagnostics.globals`).
 *
 * Pressing Escape / Cancel at any step aborts the wizard and writes nothing.
 */
export async function runFrameworkSetupWizard(
    context: vscode.ExtensionContext,
    targetFolder?: vscode.WorkspaceFolder,
    options?: FrameworkSetupWizardOptions,
): Promise<WizardResult> {
    // ── Resolve workspace folder ──────────────────────────────────────────────
    // When a folder is directly targeted (or there is only one workspace folder)
    // we skip asking the user to pick — it is already unambiguous.
    const folder = await resolveWorkspaceFolder(targetFolder);
    if (!folder) {
        return { applied: false, folder: undefined };
    }

    const folderPath = folder.uri.fsPath;
    const recommendedScopePaths = new Set(
        (options?.recommendedScopePaths ?? []).map((p) => normalizeScopePath(p)),
    );

    // ── Step 1: Script Folders ────────────────────────────────────────────────
    // Scan the workspace and pre-check directories that are clearly GMod scope
    // folders (entities, weapons, plugins, etc.).
    const scannedScopes = scanWorkspaceScopes(folderPath);
    const scopePicks = scannedScopes.map((s) => ({
        label: s.relativePath,
        description: `${s.fileCount} Lua file(s)`,
        picked: PRESELECT_SCOPE_PATHS.has(s.relativePath) || recommendedScopePaths.has(normalizeScopePath(s.relativePath)),
        scopeId: s.id,
        relativePath: s.relativePath,
    }));

    const selectedScopePicks = await vscode.window.showQuickPick(scopePicks, {
        title: 'GLuaLS Setup (1/3) — Script Folders',
        placeHolder: 'Choose script-loader folders. Auto-selected items are conservative, high-confidence matches.',
        canPickMany: true,
        ignoreFocusOut: true,
    });
    if (selectedScopePicks === undefined) {
        return { applied: false, folder };
    }

    const customScopesRaw = await vscode.window.showInputBox({
        title: 'GLuaLS Setup (1/3) — Extra Script Folders',
        prompt: 'Add extra relative folder paths only when needed. They must exist and contain Lua files.',
        placeHolder: 'e.g. gamemode/custom,lua/mylib',
        ignoreFocusOut: true,
    });
    if (customScopesRaw === undefined) {
        return { applied: false, folder };
    }

    const customScopeDirs: string[] = [];
    const rejectedScopePaths: string[] = [];
    const rejectedNonLoaderScopePaths: string[] = [];
    for (const raw of customScopesRaw.split(',')) {
        const normalized = normalizeCustomScopePath(raw);
        if (normalized !== null) {
            if (shouldAcceptCustomScopePath(folderPath, normalized)) {
                customScopeDirs.push(normalized);
            } else {
                rejectedNonLoaderScopePaths.push(normalized);
            }
        } else if (raw.trim().length > 0) {
            rejectedScopePaths.push(raw.trim());
        }
    }
    if (rejectedScopePaths.length > 0) {
        const desc = rejectedScopePaths
            .map((p) => `"${p}" (${categorizeScopePathRejection(p)})`)
            .join(', ');
        void vscode.window.showWarningMessage(
            `GLuaLS: ${rejectedScopePaths.length === 1 ? 'One folder path was' : `${rejectedScopePaths.length} folder paths were`} ` +
            `ignored because ${rejectedScopePaths.length === 1 ? 'it' : 'they'} could not be used: ${desc}.`,
        );
    }
    if (rejectedNonLoaderScopePaths.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${rejectedNonLoaderScopePaths.length === 1 ? 'One folder was' : `${rejectedNonLoaderScopePaths.length} folders were`} ` +
            `ignored because ${rejectedNonLoaderScopePaths.length === 1 ? 'it is' : 'they are'} not a safe scripted-class folder candidate: ` +
            rejectedNonLoaderScopePaths.map((p) => `"${p}"`).join(', ') +
            `. Use a real loader root, or a folder that exists inside this workspace and already contains Lua files. ` +
            `Examples: schema, plugins, items, classes, factions, entities, weapons, effects, stools, tools, ` +
            `or reviewed framework roots like gamemode/framework, gamemode/modules, gamemode/schema, gamemode/config, gamemode/libraries, ` +
            `lua/darkrp_modules, lua/darkrp_customthings, lua/darkrp_config, lua/darkrp_language, or lua/plugins.`,
        );
    }

    // ── Step 2: Suppress Unknown-Variable Warnings (advanced, optional) ───────
    // This is an escape hatch for globals that the language server cannot detect
    // automatically.  Most users can leave this blank.
    const suppressRaw = await vscode.window.showInputBox({
        title: 'GLuaLS Setup (2/3) — Suppress Unknown-Variable Warnings (Advanced, Optional)',
        prompt:
            'Getting "unknown global" warnings for variables that are definitely valid? ' +
            'List them here (comma-separated). Leave blank to skip — this should be used sparingly.',
        placeHolder: 'e.g. MyFramework,MyLib,GlobalTable',
        ignoreFocusOut: true,
    });
    if (suppressRaw === undefined) {
        return { applied: false, folder };
    }

    const diagnosticsGlobals: string[] = [];
    const rejectedDiagnosticsGlobals: string[] = [];
    for (const raw of suppressRaw.split(',')) {
        const name = raw.trim();
        if (name.length === 0) { continue; }
        if (isValidLuaIdentifier(name)) {
            diagnosticsGlobals.push(name);
        } else {
            rejectedDiagnosticsGlobals.push(name);
        }
    }
    if (rejectedDiagnosticsGlobals.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${rejectedDiagnosticsGlobals.length === 1 ? 'One name was' : `${rejectedDiagnosticsGlobals.length} names were`} ` +
            `ignored in the suppress-warnings list because ${rejectedDiagnosticsGlobals.length === 1 ? 'it does' : 'they do'} not look like valid Lua identifiers: ` +
            rejectedDiagnosticsGlobals.map((n) => `"${n}"`).join(', ') +
            `. Names must start with a letter or underscore and contain only letters, digits, and underscores.`,
        );
    }

    // ── Step 3: Review and Save ───────────────────────────────────────────────
    // Resolve the default class global: Falls back to 'GM' so entries are never 
    // silently dropped by the backend.
    const defaultClassGlobal = 'GM';

    // Merge selected scope paths with any custom-entered dirs, deduplicating
    // overlaps so that re-running the wizard (or typing the same path in the
    // custom-entry box that was already ticked in the picker) never produces
    // duplicate entries.  Path comparison is case-insensitive and backslash-
    // tolerant.  Selected picker paths take precedence (they retain their
    // pre-computed scopeId).
    const allScopePaths = deduplicateScopePaths([
        ...selectedScopePicks.map((p) => p.relativePath),
        ...customScopeDirs,
    ]);

    const classScopeEntries = allScopePaths.map((p) => {
        // Reuse the scanned pick's stable scopeId when this path came from the
        // picker; fall back to a generated ID for custom-entered paths.
        const pick = selectedScopePicks.find(
            (sp) => normalizeScopePath(sp.relativePath) === normalizeScopePath(p),
        );
        const inferred = inferClassScopeFields(p, defaultClassGlobal);
        return {
            id: pick ? pick.scopeId : `custom-scope-${normalizeScopePath(p).replace(/\//g, '-')}`,
            classGlobal: inferred.classGlobal,
            fixedClassName: inferred.fixedClassName,
            isGlobalSingleton: inferred.isGlobalSingleton,
            stripFilePrefix: inferred.stripFilePrefix,
            hideFromOutline: inferred.hideFromOutline,
            include: inferred.include,
            label: path.basename(p),
            path: inferred.path,
            rootDir: inferred.rootDir,
        };
    });

    const previewLines: string[] = [];
    if (classScopeEntries.length > 0) {
        previewLines.push(
            `Script folders: ${classScopeEntries
                .map((e) => e.rootDir ?? e.include[0]?.replace(/\/\*\*$/, ''))
                .filter((p): p is string => typeof p === 'string' && p.length > 0)
                .join(', ')}`,
        );
    }
    if (diagnosticsGlobals.length > 0) {
        previewLines.push(`Suppress warnings for: ${diagnosticsGlobals.join(', ')}`);
    }
    if (previewLines.length === 0) {
        void vscode.window.showInformationMessage(
            'Nothing was selected — no changes were made.',
            'OK',
        );
        return { applied: false, folder };
    }

    const applyPick = await vscode.window.showQuickPick(
        [
            { label: '$(check) Save Settings', description: 'Write your choices to .gluarc.json', value: 'apply' },
            { label: '$(x) Discard', description: 'Cancel and write nothing', value: 'cancel' },
        ],
        {
            title: `GLuaLS Setup (3/3) — Review & Save\n${previewLines.join('\n')}`,
            placeHolder: previewLines.join(' | '),
            ignoreFocusOut: true,
        },
    );

    if (!applyPick || applyPick.value !== 'apply') {
        return { applied: false, folder };
    }

    // ── Write ─────────────────────────────────────────────────────────────────
    const created = await ensureGluarcExists(folder);
    if (!created) {
        return { applied: false, folder };
    }

    const patchEntries = buildPresetPatchEntries({
        classScopes: classScopeEntries,
        diagnosticsGlobals: diagnosticsGlobals.length > 0 ? diagnosticsGlobals : undefined,
    });

    const summary = await applyGluarcPatch(folder, patchEntries);

    if (summary.added.length > 0 && !summary.modified) {
        // The write itself failed (e.g. file is read-only).
        void vscode.window.showErrorMessage(
            `GLuaLS: Could not save settings to .gluarc.json. ` +
                `Check that the file is not read-only and try again.`,
        );
    } else if (summary.blocked.length > 0) {
        // Structural conflicts were found (e.g. a setting expected an object but found a single value).
        void vscode.window.showWarningMessage(
            `GLuaLS: Could not apply all settings due to structural conflicts in .gluarc.json. Update manually if needed.`,
        );
    } else if (summary.conflicts.length > 0) {
        // Some existing settings have different values and were not overwritten.
        void vscode.window.showWarningMessage(
            `GLuaLS: Could not apply all settings. Some existing settings have different values and were not overwritten. Update .gluarc.json manually if needed.`,
        );
    } else if (summary.modified) {
        const alreadySetNote =
            summary.skipped.length > 0
                ? ' Some settings were already configured and were left as-is.'
                : '';
        void vscode.window.showInformationMessage(
            `GLuaLS: Settings saved to ${path.basename(summary.filePath)}.${alreadySetNote}`,
        );
        // Restart the server so the new configuration takes effect immediately.
        await vscode.commands.executeCommand('gluals.restartServer');
    } else if (
        summary.added.length === 0 &&
        summary.skipped.length === 0 &&
        summary.conflicts.length === 0 &&
        summary.blocked.length === 0
    ) {
        // Config was already fully up to date — nothing to write.
        void vscode.window.showInformationMessage(
            `GLuaLS: Your settings are already up to date — nothing new to add.`,
        );
    } else if (summary.skipped.length > 0 && summary.added.length === 0) {
        // All selected settings were already configured.
        void vscode.window.showInformationMessage(
            `GLuaLS: All selected settings were already configured — nothing new to add.`,
        );
    }

    void context;
    // Report applied=true only when the write actually persisted, or when the
    // config was already genuinely up to date (no conflicts, no skips, no blocks).
    const appliedOk =
        (summary.modified ||
        (summary.added.length === 0 &&
            summary.skipped.length === 0 &&
            summary.conflicts.length === 0 &&
            summary.blocked.length === 0)) &&
        summary.blocked.length === 0;
    return { applied: appliedOk, folder };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveWorkspaceFolder(
    hint?: vscode.WorkspaceFolder,
): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(
            'GLuaLS: Please open a folder or workspace before running the setup wizard.',
        );
        return undefined;
    }

    if (folders.length === 1) return folders[0];

    // In multi-root workspaces always show a picker so the user can choose
    // which root to configure. If a hint was provided (e.g. from a detection
    // notification), sort it to the top as the suggested choice.
    const orderedFolders = hint
        ? [hint, ...folders.filter((f) => f !== hint)]
        : [...folders];

    const picks = orderedFolders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        folder: f,
    }));

    const picked = await vscode.window.showQuickPick(picks, {
        title: 'GLuaLS Setup — Select Workspace Folder',
        placeHolder: 'Which workspace folder do you want to configure?',
        ignoreFocusOut: true,
    });

    return picked?.folder;
}
