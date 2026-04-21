import * as path from 'path';
import {
    LOADER_SCOPE_DIR_TO_CLASS_GLOBAL,
    PLUGIN_CONTAINER_SCOPE_PATHS,
    matchStructuralLoaderScope,
} from './gmodFrameworkScopePatterns';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InferredClassScopeFields {
    classGlobal: string;
    fixedClassName?: string;
    include: string[];
    path: string[];
    rootDir?: string;
    isGlobalSingleton?: boolean;
    stripFilePrefix?: boolean;
    hideFromOutline?: boolean;
    aliases?: string[];
    superTypes?: string[];
    hookOwner?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const EXACT_CLASS_SCOPE_PATHS: ReadonlySet<string> = new Set([
    'schema',
    ...PLUGIN_CONTAINER_SCOPE_PATHS,
]);

export const HEURISTIC_FRAMEWORK_SCOPE_FIELDS: Readonly<Record<string, InferredClassScopeFields>> = {
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

export const NESTED_GAMEMODE_FRAMEWORK_ROOTS: ReadonlySet<string> = new Set([
    'framework',
    'modules',
    'schema',
    'config',
    'libraries',
]);

export const NESTED_LUA_FRAMEWORK_ROOTS: ReadonlySet<string> = new Set([
    'darkrp_modules',
    'darkrp_customthings',
    'darkrp_config',
    'darkrp_language',
]);

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

// ─── Normalization and validation ─────────────────────────────────────────────

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
export function deduplicateScopePaths(paths: readonly string[]): string[] {
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

/**
 * Returns a short, plain-English reason explaining why `raw` was rejected by
 * {@link normalizeCustomScopePath}.  Used to build user-facing warning messages
 * so the wizard can tell the user exactly what was wrong with each entry.
 *
 * Call only when `normalizeCustomScopePath(raw) === null`.
 */
export function categorizeScopePathRejection(raw: string): string {
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

// ─── Scope recognition ────────────────────────────────────────────────────────

export function getHeuristicFrameworkScopeFields(dirPath: string): InferredClassScopeFields | undefined {
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

/**
 * Returns true when a folder path is a real scripted-class loader root we know
 * how to model conservatively. This deliberately excludes arbitrary schema/
 * implementation folders such as schema/meta, schema/derma, schema/libs, or
 * plugin implementation directories like plugins/writing.
 */
export function isRecognizedClassScopePath(dirPath: string): boolean {
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

// ─── classGlobal inference ────────────────────────────────────────────────────

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

export function inferClassScopeFields(dirPath: string, fallbackClassGlobal: string): InferredClassScopeFields {
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
                classGlobal: 'SCHEMA',
                fixedClassName: 'SCHEMA',
                isGlobalSingleton: true,
                hideFromOutline: true,
                aliases: ['Schema'],
                superTypes: ['GM'],
                hookOwner: true,
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
