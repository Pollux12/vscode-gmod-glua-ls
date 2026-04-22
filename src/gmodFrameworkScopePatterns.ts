export const LOADER_SCOPE_DIR_TO_CLASS_GLOBAL: Readonly<Record<string, string>> = {
    items: 'ITEM',
    classes: 'CLASS',
    factions: 'FACTION',
    attributes: 'ATTRIBUTE',
    entities: 'ENT',
    weapons: 'SWEP',
    effects: 'EFFECT',
    stools: 'TOOL',
    tools: 'TOOL',
    plugins: 'PLUGIN',
};

export const DIRECT_LOADER_SCOPE_CONTAINERS: ReadonlySet<string> = new Set([
    'schema',
    'gamemode',
    'lua',
]);

export const PLUGIN_CONTAINER_SCOPE_PATHS: ReadonlySet<string> = new Set([
    'plugins',
    'schema/plugins',
    'gamemode/plugins',
    'lua/plugins',
]);

export interface StructuralLoaderScopeMatch {
    normalizedPath: string;
    loaderDirName: string;
    classGlobal: string;
    kind: 'direct-loader-root' | 'plugin-contained-loader';
    pluginContainerPath?: string;
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathStartsWithSegments(pathSegments: string[], prefixSegments: string[]): boolean {
    if (prefixSegments.length > pathSegments.length) {
        return false;
    }

    return prefixSegments.every((segment, index) => pathSegments[index] === segment);
}

export function matchStructuralLoaderScope(dirPath: string): StructuralLoaderScopeMatch | undefined {
    const normalizedPath = normalizePath(dirPath);
    if (normalizedPath.length === 0) {
        return undefined;
    }

    const segments = normalizedPath.split('/');
    const loaderDirName = segments[segments.length - 1];
    const classGlobal = LOADER_SCOPE_DIR_TO_CLASS_GLOBAL[loaderDirName];
    if (!classGlobal) {
        return undefined;
    }

    if (segments.length === 1) {
        return {
            normalizedPath,
            loaderDirName,
            classGlobal,
            kind: 'direct-loader-root',
        };
    }

    if (
        segments.length === 2 &&
        DIRECT_LOADER_SCOPE_CONTAINERS.has(segments[0])
    ) {
        return {
            normalizedPath,
            loaderDirName,
            classGlobal,
            kind: 'direct-loader-root',
        };
    }

    for (const pluginContainerPath of PLUGIN_CONTAINER_SCOPE_PATHS) {
        const containerSegments = pluginContainerPath.split('/');
        if (
            segments.length === containerSegments.length + 2 &&
            pathStartsWithSegments(segments, containerSegments)
        ) {
            const pluginName = segments[containerSegments.length];
            if (pluginName.length === 0) {
                continue;
            }

            return {
                normalizedPath,
                loaderDirName,
                classGlobal,
                kind: 'plugin-contained-loader',
                pluginContainerPath,
            };
        }
    }

    return undefined;
}

export function buildLoaderScopePatternFamily(
    exactPath: string,
    pluginContainers: readonly string[] = [],
): string[] {
    const normalizedPath = exactPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const structuralMatch = matchStructuralLoaderScope(normalizedPath);
    if (!structuralMatch) {
        return [`${normalizedPath}/**`];
    }

    const include = [`${normalizedPath}/**`];

    if (structuralMatch.kind === 'direct-loader-root') {
        for (const pluginContainerPath of pluginContainers) {
            include.push(`${pluginContainerPath}/*/${structuralMatch.loaderDirName}/**`);
        }
    }

    return [...new Set(include)];
}
