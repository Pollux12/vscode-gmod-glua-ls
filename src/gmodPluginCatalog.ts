import * as fs from 'fs';
import * as path from 'path';

export interface GmodPluginArtifactRef {
    readonly branch: string;
    readonly version?: string;
    readonly manifest: string;
}

export interface GmodPluginSearchHints {
    readonly fileGlobs?: readonly string[];
}

export type GmodPluginKind = 'framework' | 'gamemode' | 'addon' | 'library';

export interface GmodPluginDescriptor {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly kind: GmodPluginKind;
    readonly manifestPatterns: readonly string[];
    readonly folderNamePatterns: readonly string[];
    readonly fileNamePatterns: readonly string[];
    readonly globalNames: readonly string[];
    readonly globalPatterns: readonly string[];
    readonly gamemodeBases: readonly string[];
    readonly searchHints?: GmodPluginSearchHints;
    readonly artifact: GmodPluginArtifactRef;
}

export interface GmodPluginCatalog {
    readonly rootPath?: string;
    readonly generatedAt?: string;
    readonly plugins: readonly GmodPluginDescriptor[];
    readonly byId: ReadonlyMap<string, GmodPluginDescriptor>;
}

export interface GmodPluginBundleDefinition {
    readonly manifestPath: string;
    readonly gluarcPath: string;
    readonly annotationsPath: string;
    readonly gluarcFragment: Record<string, unknown>;
}

type PluginDetectionIndex = {
    manifestPatterns?: unknown;
    gamemodeBases?: unknown;
    folderNamePatterns?: unknown;
    fileNamePatterns?: unknown;
    globalNames?: unknown;
    globalPatterns?: unknown;
    globals?: unknown;
    searchHints?: unknown;
};

type PluginIndexEntry = {
    id?: unknown;
    label?: unknown;
    name?: unknown;
    description?: unknown;
    kind?: unknown;
    type?: unknown;
    category?: unknown;
    detection?: unknown;
    artifact?: unknown;
};

type PluginIndexFile = {
    generatedAt?: unknown;
    plugins?: unknown;
};

const DEFAULT_PLUGIN_BRANCH_PREFIX = 'gluals-annotations-plugin-';

const BUILTIN_PLUGINS: readonly GmodPluginDescriptor[] = [
    {
        id: 'cami',
        label: 'CAMI',
        description: 'Common Admin Mod Interface compatibility library',
        kind: 'library',
        manifestPatterns: [],
        folderNamePatterns: ['(?:^|[\\\\/_-])cami(?:[\\\\/_\\.-]|$)'],
        fileNamePatterns: ['(?:^|[\\\\/_-])cami(?:[\\\\/_\\.-]|$)'],
        globalNames: ['CAMI'],
        globalPatterns: [],
        gamemodeBases: [],
        searchHints: {
            fileGlobs: [
                '**/cami*.lua',
                '**/sh_cami.lua',
                '**/lua/autorun/**/cami*.lua',
            ],
        },
        artifact: {
            branch: `${DEFAULT_PLUGIN_BRANCH_PREFIX}cami`,
            manifest: 'plugin.json',
        },
    },
];

function asObject(value: unknown): Record<string, unknown> | undefined {
    return (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : undefined;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function readJsonFile(filePath: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

function isSafeChildPath(rootPath: string, candidatePath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function escapeForRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDetection(rawDetection: unknown): {
    manifestPatterns: readonly string[];
    gamemodeBases: readonly string[];
    folderNamePatterns: readonly string[];
    fileNamePatterns: readonly string[];
    globalNames: readonly string[];
    globalPatterns: readonly string[];
    searchHints?: GmodPluginSearchHints;
} | undefined {
    const detection = asObject(rawDetection);
    if (!detection) return undefined;

    const explicitManifestPatterns = asStringArray(detection.manifestPatterns);
    const gamemodeBases = asStringArray(detection.gamemodeBases);
    const folderNamePatterns = asStringArray(detection.folderNamePatterns);
    const fileNamePatterns = asStringArray(detection.fileNamePatterns);
    const globalNames = asStringArray(detection.globalNames).concat(asStringArray(detection.globals));
    const globalPatterns = asStringArray(detection.globalPatterns);
    const rawSearchHints = asObject(detection.searchHints);
    const fileGlobs = asStringArray(rawSearchHints?.fileGlobs);
    const searchHints = fileGlobs.length > 0 ? { fileGlobs } : undefined;

    const manifestPatterns = [
        ...explicitManifestPatterns,
        ...gamemodeBases.map((base) => `"base"\\s+"${escapeForRegex(base)}"`),
    ];

    if (
        manifestPatterns.length === 0 &&
        folderNamePatterns.length === 0 &&
        fileNamePatterns.length === 0 &&
        globalNames.length === 0 &&
        globalPatterns.length === 0
    ) {
        return undefined;
    }

    return {
        manifestPatterns,
        gamemodeBases,
        folderNamePatterns,
        fileNamePatterns,
        globalNames,
        globalPatterns,
        searchHints,
    };
}

function normalizePluginKind(rawKind: unknown, detection: {
    gamemodeBases: readonly string[];
}): GmodPluginKind {
    const normalized = typeof rawKind === 'string' ? rawKind.trim().toLowerCase() : '';
    switch (normalized) {
        case 'framework':
            return 'framework';
        case 'gamemode':
        case 'game-mode':
        case 'gamemode-base':
            return 'gamemode';
        case 'addon':
            return 'addon';
        case 'library':
        case 'lib':
            return 'library';
        default:
            return detection.gamemodeBases.length > 0 ? 'gamemode' : 'framework';
    }
}

function normalizeArtifact(id: string, rawArtifact: unknown): GmodPluginArtifactRef | undefined {
    const artifact = asObject(rawArtifact);
    const branch = typeof artifact?.branch === 'string' && artifact.branch.trim().length > 0
        ? artifact.branch.trim()
        : `${DEFAULT_PLUGIN_BRANCH_PREFIX}${id}`;
    const manifest = typeof artifact?.manifest === 'string' && artifact.manifest.trim().length > 0
        ? artifact.manifest.trim()
        : 'plugin.json';
    const version = typeof artifact?.version === 'string' && artifact.version.trim().length > 0
        ? artifact.version.trim()
        : undefined;

    if (!branch || !manifest) return undefined;
    return { branch, manifest, version };
}

function normalizePluginIndexEntry(raw: unknown): GmodPluginDescriptor | undefined {
    const entry = asObject(raw) as PluginIndexEntry | undefined;
    if (!entry) return undefined;

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) return undefined;

    const labelSource = typeof entry.label === 'string' && entry.label.trim().length > 0
        ? entry.label
        : (typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name : id);
    const description = typeof entry.description === 'string' ? entry.description : '';

    const normalizedDetection = normalizeDetection(entry.detection as PluginDetectionIndex | undefined);
    if (!normalizedDetection) return undefined;

    const artifact = normalizeArtifact(id, entry.artifact);
    if (!artifact) return undefined;

    const kind = normalizePluginKind(entry.kind ?? entry.type ?? entry.category, normalizedDetection);

    return {
        id,
        label: labelSource,
        description,
        kind,
        manifestPatterns: normalizedDetection.manifestPatterns,
        folderNamePatterns: normalizedDetection.folderNamePatterns,
        fileNamePatterns: normalizedDetection.fileNamePatterns,
        globalNames: normalizedDetection.globalNames,
        globalPatterns: normalizedDetection.globalPatterns,
        gamemodeBases: normalizedDetection.gamemodeBases,
        searchHints: normalizedDetection.searchHints,
        artifact,
    };
}

function collectPluginIndexPlugins(annotationsPath: string): { generatedAt?: string; plugins: GmodPluginDescriptor[] } {
    const indexRaw = readJsonFile(path.join(annotationsPath, 'plugin', 'index.json'));
    const index = asObject(indexRaw) as PluginIndexFile | undefined;
    if (!index) {
        return { plugins: [] };
    }

    const entries = Array.isArray(index.plugins) ? index.plugins : [];
    const plugins = entries
        .map(normalizePluginIndexEntry)
        .filter((plugin): plugin is GmodPluginDescriptor => plugin !== undefined)
        .sort((a, b) => a.id.localeCompare(b.id));

    return {
        generatedAt: typeof index.generatedAt === 'string' ? index.generatedAt : undefined,
        plugins,
    };
}

export function loadGmodPluginCatalog(options: { annotationsPath?: string } | string = {}): GmodPluginCatalog {
    const resolvedOptions = typeof options === 'string' ? { annotationsPath: options } : options;
    const byId = new Map<string, GmodPluginDescriptor>();
    let generatedAt: string | undefined;

    if (resolvedOptions.annotationsPath && fs.existsSync(resolvedOptions.annotationsPath)) {
        const parsed = collectPluginIndexPlugins(resolvedOptions.annotationsPath);
        generatedAt = parsed.generatedAt;
        for (const plugin of parsed.plugins) {
            byId.set(plugin.id, plugin);
        }
    }

    for (const plugin of getBuiltInGmodPlugins()) {
        if (!byId.has(plugin.id)) {
            byId.set(plugin.id, plugin);
        }
    }

    const plugins = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    return {
        rootPath: resolvedOptions.annotationsPath,
        generatedAt,
        plugins,
        byId,
    };
}

export function getBuiltInGmodPlugins(): readonly GmodPluginDescriptor[] {
    return BUILTIN_PLUGINS;
}

export function getGmodPluginById(
    catalog: GmodPluginCatalog,
    id: string,
): GmodPluginDescriptor | undefined {
    return catalog.byId.get(id);
}

export function loadPluginBundleDefinition(
    bundlePath: string,
    manifestRelativePath: string = 'plugin.json',
): GmodPluginBundleDefinition | undefined {
    const manifestPath = path.resolve(bundlePath, manifestRelativePath);
    if (!isSafeChildPath(bundlePath, manifestPath)) {
        return undefined;
    }
    const manifestRaw = readJsonFile(manifestPath);
    const manifest = asObject(manifestRaw);
    if (!manifest) return undefined;

    const gluarcRelPath = typeof manifest.gluarcPath === 'string' && manifest.gluarcPath.trim().length > 0
        ? manifest.gluarcPath
        : (typeof manifest.gluarc === 'string' && manifest.gluarc.trim().length > 0 ? manifest.gluarc : 'gluarc.json');
    const annotationsRelPath = typeof manifest.annotationsPath === 'string' && manifest.annotationsPath.trim().length > 0
        ? manifest.annotationsPath
        : 'annotations';

    const gluarcPath = path.resolve(bundlePath, gluarcRelPath);
    const annotationsPath = path.resolve(bundlePath, annotationsRelPath);
    if (!isSafeChildPath(bundlePath, gluarcPath) || !isSafeChildPath(bundlePath, annotationsPath)) {
        return undefined;
    }

    const gluarcRaw = readJsonFile(gluarcPath);
    const gluarcFragment = asObject(gluarcRaw);
    if (!gluarcFragment) return undefined;

    return {
        manifestPath,
        gluarcPath,
        annotationsPath,
        gluarcFragment,
    };
}
