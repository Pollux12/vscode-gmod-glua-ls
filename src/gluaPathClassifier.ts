const GLUA_DIRECTORY_NAMES = new Set([
    'lua',
    'gamemode',
    'autorun',
    'derma',
    'drive',
    'effects',
    'entities',
    'includes',
    'matproxy',
    'menu',
    'postprocess',
    'properties',
    'skins',
    'stools',
    'vgui',
    'weapons',
]);

const GLUA_ENTRYPOINT_NAMES = new Set([
    'init.lua',
    'cl_init.lua',
    'shared.lua',
    'menu.lua',
]);

const GLUA_REALM_PREFIX = /^(?:cl|sv|sh)_/;

/**
 * Returns whether a Lua path has a conventional Garry's Mod GLua location or name.
 * This only classifies the supplied path; it does not access the filesystem.
 */
export function isLikelyGluaPath(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);
    const basename = segments[segments.length - 1]?.toLowerCase();

    if (!basename?.endsWith('.lua')) {
        return false;
    }

    if (GLUA_ENTRYPOINT_NAMES.has(basename) || GLUA_REALM_PREFIX.test(basename)) {
        return true;
    }

    return segments
        .slice(0, -1)
        .some((segment) => GLUA_DIRECTORY_NAMES.has(segment.toLowerCase()));
}
