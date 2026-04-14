import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClassScopePreset {
    id: string;
    /**
     * The global variable name assigned to the class table in scope files (e.g. `PLUGIN`,
     * `FACTION`, `ENT`). Required by the backend — entries without classGlobal are dropped.
     */
    classGlobal: string;
    /** Glob patterns that determine which files belong to this scope. Required by the backend. */
    include: string[];
    /** Human-readable label shown in the UI. Required by the backend. */
    label: string;
    /** Path segments used to resolve the root directory. Required by the backend. */
    path: string[];
    rootDir?: string;
    fixedClassName?: string;
    /**
     * When `true`, `classGlobal` is a workspace-wide singleton (like `Schema` in Helix)
     * and will be registered as a global variable accessible from any file, rather than
     * a file-local declaration scoped to scope files only.
     */
    isGlobalSingleton?: boolean;
    /**
     * When `true`, the `sh_`, `sv_`, and `cl_` realm prefixes are stripped from the
     * filename when deriving the class name (e.g. `sh_administrator.lua` → `administrator`).
     */
    stripFilePrefix?: boolean;
    /**
     * When `true`, this scope is hidden from the outline/class explorer tree view.
     * Useful for global singletons like `Schema` that should not appear as a
     * folder because there is only ever one instance.
     */
    hideFromOutline?: boolean;
}

export interface FrameworkPreset {
    id: string;
    frameworkId: string;
    label: string;
    description: string;
    classScopes: ClassScopePreset[];
}

/**
 * A declarative framework descriptor that defines both the detection rules
 * and the preset configuration for a Garry's Mod framework/gamemode.
 *
 * Detection is based on simple, confident signals:
 *   - `gamemodeBases`: strings matched case-insensitively against the `"base"`
 *     field in the gamemode .txt manifest (e.g. `"helix"`, `"darkrp"`).
 *   - `folderNamePatterns`: regexes matched case-insensitively against the
 *     workspace folder name (e.g. `/helix/`, `/hl2rp/`, `/darkrp/`).
 *
 * If ANY signal matches, the framework is detected with confidence.
 */
export interface FrameworkDescriptor {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    /**
     * Gamemode manifest `"base"` values that identify this framework.
     * Matched case-insensitively. For example, `["helix", "nutscript"]`.
     */
    readonly gamemodeBases: readonly string[];
    /**
     * Regex patterns tested against the workspace folder name (basename).
     * Matched case-insensitively. For example, `[/helix/, /hl2rp/, /darkrp/]`.
     * A folder named "helix-hl2rp" would match `/helix/` and `/hl2rp/`.
     */
    readonly folderNamePatterns: readonly RegExp[];
    /** The preset to apply when this framework is detected. */
    getPreset(): FrameworkPreset;
}

// ─── Detection ────────────────────────────────────────────────────────────────

export interface DetectionResult {
    /** The detected framework descriptor, or undefined if nothing matched. */
    detected: FrameworkDescriptor | undefined;
    /** Human-readable evidence explaining why the framework was (or wasn't) detected. */
    evidence: string[];
}

/**
 * Reads the `"base"` field from a gamemode .txt manifest in the folder.
 */
function readGamemodeBase(folderPath: string): string | undefined {
    const folderName = path.basename(folderPath);
    const candidates = [path.join(folderPath, `${folderName}.txt`)];

    try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.txt')) {
                candidates.push(path.join(folderPath, entry.name));
            }
        }
    } catch {
        // ignore read errors
    }

    for (const candidate of candidates) {
        const base = extractBaseFromManifest(candidate);
        if (base) return base;
    }

    return undefined;
}

function extractBaseFromManifest(filePath: string): string | undefined {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const match = content.match(/"base"\s+"([^"]+)"/i);
        return match ? match[1].toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Detects which framework (if any) matches the given workspace folder.
 * Uses simple, confident signals: gamemode manifest base field and folder name.
 */
export async function detectFramework(
    workspaceFolder: vscode.WorkspaceFolder,
): Promise<DetectionResult> {
    const folderPath = workspaceFolder.uri.fsPath;
    const folderName = path.basename(folderPath).toLowerCase();
    const evidence: string[] = [];

    // Check gamemode manifest base
    const gamemodeBase = readGamemodeBase(folderPath);

    // Check each descriptor — first match wins
    for (const descriptor of FRAMEWORK_DESCRIPTORS) {
        // 1. Check gamemode manifest base
        if (gamemodeBase) {
            for (const base of descriptor.gamemodeBases) {
                if (gamemodeBase === base.toLowerCase()) {
                    evidence.push(`gamemode manifest base = "${base}"`);
                    return { detected: descriptor, evidence };
                }
            }
        }

        // 2. Check folder name patterns
        for (const pattern of descriptor.folderNamePatterns) {
            if (pattern.test(folderName)) {
                evidence.push(`folder name "${folderName}" matches pattern ${pattern}`);
                return { detected: descriptor, evidence };
            }
        }
    }

    return { detected: undefined, evidence: [] };
}

// ─── Descriptor definitions ───────────────────────────────────────────────────

/**
 * Built-in framework descriptors. To add a new gamemode, simply append an
 * entry to this array following the pattern below.
 *
 * Each descriptor needs:
 *   - `id`: unique identifier (lowercase, no spaces)
 *   - `label`: human-readable name
 *   - `description`: short description for UI
 *   - `gamemodeBases`: list of `"base"` values from gamemode .txt manifests
 *   - `folderNamePatterns`: regexes that match workspace folder names
 *   - `getPreset()`: returns the class scope preset to apply
 */
export const FRAMEWORK_DESCRIPTORS: readonly FrameworkDescriptor[] = [
    // ── DarkRP ────────────────────────────────────────────────────────────────
    {
        id: 'darkrp',
        label: 'DarkRP',
        description: 'Scripted class scope preset for DarkRP gamemode development.',
        gamemodeBases: ['darkrp'],
        folderNamePatterns: [/darkrp/, /drp/],
        getPreset(): FrameworkPreset {
            return {
                id: 'darkrp-preset',
                frameworkId: this.id,
                label: this.label,
                description: this.description,
                classScopes: [
                    {
                        id: 'darkrp-modules',
                        classGlobal: 'GM',
                        include: ['gamemode/modules/**'],
                        label: 'DarkRP Modules',
                        path: ['gamemode', 'modules'],
                        rootDir: 'gamemode/modules',
                    },
                    {
                        id: 'darkrp-config',
                        classGlobal: 'GM',
                        include: ['gamemode/config/**'],
                        label: 'DarkRP Config',
                        path: ['gamemode', 'config'],
                        rootDir: 'gamemode/config',
                    },
                    {
                        id: 'darkrp-libraries',
                        classGlobal: 'GM',
                        include: ['gamemode/libraries/**'],
                        label: 'DarkRP Libraries',
                        path: ['gamemode', 'libraries'],
                        rootDir: 'gamemode/libraries',
                    },
                    {
                        id: 'darkrp-modules-lua',
                        classGlobal: 'GM',
                        include: ['lua/darkrp_modules/**'],
                        label: 'DarkRP Lua Modules',
                        path: ['lua', 'darkrp_modules'],
                        rootDir: 'lua/darkrp_modules',
                    },
                    {
                        id: 'darkrp-customthings',
                        classGlobal: 'GM',
                        include: ['lua/darkrp_customthings/**'],
                        label: 'DarkRP Custom Things',
                        path: ['lua', 'darkrp_customthings'],
                        rootDir: 'lua/darkrp_customthings',
                    },
                    {
                        id: 'darkrp-config-lua',
                        classGlobal: 'GM',
                        include: ['lua/darkrp_config/**'],
                        label: 'DarkRP Lua Config',
                        path: ['lua', 'darkrp_config'],
                        rootDir: 'lua/darkrp_config',
                    },
                    {
                        id: 'darkrp-language',
                        classGlobal: 'GM',
                        include: ['lua/darkrp_language/**'],
                        label: 'DarkRP Language',
                        path: ['lua', 'darkrp_language'],
                        rootDir: 'lua/darkrp_language',
                    },
                ],
            };
        },
    },

    // ── Helix ─────────────────────────────────────────────────────────────────
    {
        id: 'helix',
        label: 'Helix',
        description: 'Scripted class scope preset for Helix (ix_) schema development.',
        gamemodeBases: ['helix', 'nutscript'],
        folderNamePatterns: [/helix/, /hl2rp/, /nutscript/],
        getPreset(): FrameworkPreset {
            return {
                id: 'helix-preset',
                frameworkId: this.id,
                label: this.label,
                description: this.description,
                classScopes: [
                    {
                        id: 'helix-schema',
                        classGlobal: 'Schema',
                        fixedClassName: 'Schema',
                        isGlobalSingleton: true,
                        hideFromOutline: true,
                        include: ['schema/**', 'gamemode/schema.lua'],
                        label: 'Helix Schema',
                        path: ['schema'],
                        rootDir: 'schema',
                    },
                    {
                        id: 'helix-plugins',
                        classGlobal: 'PLUGIN',
                        include: ['plugins/**'],
                        label: 'Helix Plugins',
                        path: ['plugins'],
                    },
                    {
                        id: 'helix-items',
                        classGlobal: 'ITEM',
                        stripFilePrefix: true,
                        include: ['items/**'],
                        label: 'Helix Items',
                        path: ['items'],
                    },
                    {
                        id: 'helix-factions',
                        classGlobal: 'FACTION',
                        stripFilePrefix: true,
                        include: ['factions/**'],
                        label: 'Helix Factions',
                        path: ['factions'],
                        rootDir: 'schema/factions',
                    },
                    {
                        id: 'helix-classes',
                        classGlobal: 'CLASS',
                        stripFilePrefix: true,
                        include: ['classes/**'],
                        label: 'Helix Classes',
                        path: ['classes'],
                        rootDir: 'schema/classes',
                    },
                    {
                        id: 'helix-attributes',
                        classGlobal: 'ATTRIBUTE',
                        stripFilePrefix: true,
                        include: ['attributes/**'],
                        label: 'Helix Attributes',
                        path: ['schema', 'attributes'],
                        rootDir: 'schema/attributes',
                    },
                ],
            };
        },
    },

    // ── Parallax ──────────────────────────────────────────────────────────────
    {
        id: 'parallax',
        label: 'Parallax',
        description: 'Scripted class scope preset for Parallax framework development.',
        gamemodeBases: ['parallax'],
        folderNamePatterns: [/parallax/],
        getPreset(): FrameworkPreset {
            return {
                id: 'parallax-preset',
                frameworkId: this.id,
                label: this.label,
                description: this.description,
                classScopes: [
                    {
                        id: 'parallax-framework',
                        classGlobal: 'GM',
                        include: ['gamemode/framework/**'],
                        label: 'Parallax Framework',
                        path: ['gamemode', 'framework'],
                        rootDir: 'gamemode/framework',
                    },
                    {
                        id: 'parallax-modules',
                        classGlobal: 'GM',
                        include: ['gamemode/modules/**'],
                        label: 'Parallax Modules',
                        path: ['gamemode', 'modules'],
                        rootDir: 'gamemode/modules',
                    },
                    {
                        id: 'parallax-schema',
                        classGlobal: 'GM',
                        include: ['gamemode/schema/**'],
                        label: 'Parallax Schema',
                        path: ['gamemode', 'schema'],
                        rootDir: 'gamemode/schema',
                    },
                ],
            };
        },
    },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Returns the FrameworkDescriptor for the given id, or undefined.
 */
export function getFrameworkDescriptor(id: string): FrameworkDescriptor | undefined {
    return FRAMEWORK_DESCRIPTORS.find((d) => d.id === id);
}

/**
 * Builds a stable "fingerprint" string for a detection result.
 * Used to detect when the project's framework signals change between sessions.
 */
export function buildDetectionFingerprint(result: DetectionResult): string {
    if (!result.detected) return 'none';
    return `detected:${result.detected.id}`;
}
