import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GmodPluginCatalog, GmodPluginDescriptor } from './gmodPluginCatalog';
import { hasGamemodeManifest } from './gmodGamemodeBaseDetector';

export interface PluginDetectionResult {
    readonly detected: readonly GmodPluginDescriptor[];
    readonly evidence: Readonly<Record<string, readonly string[]>>;
}

const REGEX_FLAGS = 'i';
const IGNORED_SCAN_DIRECTORIES = new Set([
    '.git',
    '.hg',
    '.svn',
    '.vscode',
    'node_modules',
]);

interface LuaFileEntry {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly fileName: string;
}

function compilePattern(pattern: string): RegExp | undefined {
    try {
        return new RegExp(pattern, REGEX_FLAGS);
    } catch {
        return undefined;
    }
}

function escapeForRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileGlobalNamePattern(globalName: string): RegExp | undefined {
    if (globalName.trim().length === 0) return undefined;
    try {
        return new RegExp(`\\b${escapeForRegex(globalName)}\\b`);
    } catch {
        return undefined;
    }
}

function readManifestContents(folderPath: string): Array<{ filePath: string; content: string }> {
    const folderName = path.basename(folderPath);
    const candidates = [path.join(folderPath, `${folderName}.txt`)];

    try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!entry.name.toLowerCase().endsWith('.txt')) continue;
            candidates.push(path.join(folderPath, entry.name));
        }
    } catch {
        return [];
    }

    const dedupedCandidates = [...new Set(candidates)];
    const manifests: Array<{ filePath: string; content: string }> = [];
    for (const filePath of dedupedCandidates) {
        try {
            manifests.push({ filePath, content: fs.readFileSync(filePath, 'utf8') });
        } catch {
            // ignore unreadable files
        }
    }

    return manifests;
}

function detectByManifestPatterns(
    manifests: Array<{ filePath: string; content: string }>,
    plugin: GmodPluginDescriptor,
): string | undefined {
    for (const patternSource of plugin.manifestPatterns) {
        const pattern = compilePattern(patternSource);
        if (!pattern) continue;
        for (const manifest of manifests) {
            if (pattern.test(manifest.content)) {
                const manifestName = path.basename(manifest.filePath);
                return `manifest "${manifestName}" matches /${patternSource}/i`;
            }
        }
    }
    return undefined;
}

function detectByFolderNamePattern(folderName: string, plugin: GmodPluginDescriptor): string | undefined {
    for (const patternSource of plugin.folderNamePatterns) {
        const pattern = compilePattern(patternSource);
        if (!pattern) continue;
        if (pattern.test(folderName)) {
            return `folder name "${folderName}" matches /${patternSource}/i`;
        }
    }
    return undefined;
}

async function collectLuaFiles(folderPath: string): Promise<LuaFileEntry[]> {
    const files: LuaFileEntry[] = [];
    const pending: string[] = [folderPath];

    while (pending.length > 0) {
        const currentDir = pending.pop();
        if (!currentDir) continue;

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            const absolutePath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (IGNORED_SCAN_DIRECTORIES.has(entry.name.toLowerCase())) {
                    continue;
                }
                pending.push(absolutePath);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!entry.name.toLowerCase().endsWith('.lua')) continue;

            const relativePath = path.relative(folderPath, absolutePath).replace(/\\/g, '/');
            files.push({
                absolutePath,
                relativePath,
                fileName: entry.name,
            });
        }
    }

    return files;
}

function detectByFileNamePattern(luaFiles: readonly LuaFileEntry[], plugin: GmodPluginDescriptor): string | undefined {
    if (plugin.fileNamePatterns.length === 0) return undefined;
    for (const patternSource of plugin.fileNamePatterns) {
        const pattern = compilePattern(patternSource);
        if (!pattern) continue;
        for (const file of luaFiles) {
            if (pattern.test(file.fileName) || pattern.test(file.relativePath)) {
                return `file "${file.relativePath}" matches /${patternSource}/i`;
            }
        }
    }
    return undefined;
}

function stripLuaCommentsAndStrings(input: string): string {
    // Replace strings and comments with spaces to preserve rough offsets while
    // avoiding false-positive global matches in non-code text.
    return input
        // Long comments: --[[ ... ]]
        .replace(/--\[\[[\s\S]*?\]\]/g, (m) => ' '.repeat(m.length))
        // Line comments: -- ...
        .replace(/--[^\r\n]*/g, (m) => ' '.repeat(m.length))
        // Long strings: [[ ... ]]
        .replace(/\[\[[\s\S]*?\]\]/g, (m) => ' '.repeat(m.length))
        // Quoted strings
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => ' '.repeat(m.length));
}

export async function detectFrameworkPlugin(
    workspaceFolder: vscode.WorkspaceFolder,
    plugins: readonly GmodPluginDescriptor[],
): Promise<PluginDetectionResult> {
    const folderPath = workspaceFolder.uri.fsPath;
    const folderName = path.basename(folderPath).toLowerCase();
    const manifests = readManifestContents(folderPath);
    const detectedById = new Map<string, { plugin: GmodPluginDescriptor; evidence: Set<string> }>();

    const markDetected = (plugin: GmodPluginDescriptor, reason: string): void => {
        const existing = detectedById.get(plugin.id);
        if (existing) {
            existing.evidence.add(reason);
            return;
        }
        detectedById.set(plugin.id, { plugin, evidence: new Set([reason]) });
    };

    for (const plugin of plugins) {
        const manifestEvidence = detectByManifestPatterns(manifests, plugin);
        if (manifestEvidence) {
            markDetected(plugin, manifestEvidence);
            continue;
        }

        const folderEvidence = detectByFolderNamePattern(folderName, plugin);
        if (folderEvidence) {
            markDetected(plugin, folderEvidence);
        }
    }

    let luaFilesPromise: Promise<LuaFileEntry[]> | undefined;
    const getLuaFiles = async (): Promise<LuaFileEntry[]> => {
        if (!luaFilesPromise) {
            luaFilesPromise = collectLuaFiles(folderPath);
        }
        return luaFilesPromise;
    };

    let hasPendingFileNameMatchers = false;
    for (const plugin of plugins) {
        if (detectedById.has(plugin.id)) continue;
        if (plugin.fileNamePatterns.length > 0) {
            hasPendingFileNameMatchers = true;
        }
    }

    if (hasPendingFileNameMatchers) {
        const luaFiles = await getLuaFiles();
        for (const plugin of plugins) {
            if (detectedById.has(plugin.id)) continue;
            if (plugin.fileNamePatterns.length === 0) continue;
            const fileNameEvidence = detectByFileNamePattern(luaFiles, plugin);
            if (fileNameEvidence) {
                markDetected(plugin, fileNameEvidence);
            }
        }
    }

    const unresolvedGlobalPlugins = plugins.filter((plugin) =>
        !detectedById.has(plugin.id) &&
        (plugin.globalNames.length > 0 || plugin.globalPatterns.length > 0),
    );

    if (unresolvedGlobalPlugins.length > 0) {
        const luaFiles = await getLuaFiles();
        const globalNameMatchersByName = new Map<string, Array<{ pluginId: string; pattern: RegExp }>>();
        const globalPatternMatchers = new Map<string, RegExp[]>();

        for (const plugin of unresolvedGlobalPlugins) {
            for (const globalName of plugin.globalNames) {
                const matcher = compileGlobalNamePattern(globalName);
                if (!matcher) continue;
                const existing = globalNameMatchersByName.get(globalName);
                const entry = { pluginId: plugin.id, pattern: matcher };
                if (existing) {
                    existing.push(entry);
                } else {
                    globalNameMatchersByName.set(globalName, [entry]);
                }
            }

            const regexMatchers = plugin.globalPatterns
                .map((patternSource) => compilePattern(patternSource))
                .filter((entry): entry is RegExp => entry !== undefined);
            globalPatternMatchers.set(plugin.id, regexMatchers);
        }

        const unresolvedById = new Map<string, GmodPluginDescriptor>(
            unresolvedGlobalPlugins.map((plugin) => [plugin.id, plugin]),
        );

        for (const luaFile of luaFiles) {
            if (unresolvedById.size === 0) break;

            let content: string;
            try {
                content = await fs.promises.readFile(luaFile.absolutePath, 'utf8');
            } catch {
                continue;
            }

            const codeOnlyContent = stripLuaCommentsAndStrings(content);

            for (const [globalName, matchers] of globalNameMatchersByName) {
                if (!codeOnlyContent.includes(globalName)) continue;
                for (const matcher of matchers) {
                    const plugin = unresolvedById.get(matcher.pluginId);
                    if (!plugin) continue;
                    if (!matcher.pattern.test(codeOnlyContent)) continue;
                    markDetected(plugin, `global "${globalName}" found in "${luaFile.relativePath}"`);
                    unresolvedById.delete(plugin.id);
                }
            }

            for (const plugin of [...unresolvedById.values()]) {
                for (const matcher of globalPatternMatchers.get(plugin.id) ?? []) {
                    if (!matcher.test(codeOnlyContent)) continue;
                    markDetected(plugin, `global pattern /${matcher.source}/i matched in "${luaFile.relativePath}"`);
                    unresolvedById.delete(plugin.id);
                    break;
                }
            }
        }
    }

    const detected = [...detectedById.values()]
        .map((entry) => entry.plugin)
        .sort((a, b) => a.id.localeCompare(b.id));
    const evidence: Record<string, readonly string[]> = {};
    for (const [pluginId, entry] of detectedById) {
        evidence[pluginId] = [...entry.evidence];
    }

    return { detected, evidence };
}

export function buildPluginDetectionFingerprint(result: PluginDetectionResult): string {
    if (result.detected.length === 0) return 'none';
    const ids = result.detected.map((plugin) => plugin.id).sort();
    return `detected:${ids.join(',')}`;
}

export async function detectGmodPlugin(
    workspaceFolder: vscode.WorkspaceFolder,
    catalog: GmodPluginCatalog,
): Promise<PluginDetectionResult> {
    return detectFrameworkPlugin(workspaceFolder, catalog.plugins);
}

export function folderLooksLikeGmodProject(folder: vscode.WorkspaceFolder): boolean {
    const folderPath = folder.uri.fsPath;
    const commonDirs = [
        ['gamemode'],
        ['lua'],
        ['schema'],
        ['plugins'],
        ['entities'],
        ['weapons'],
    ];

    for (const segments of commonDirs) {
        try {
            if (fs.statSync(path.join(folderPath, ...segments)).isDirectory()) {
                return true;
            }
        } catch {
            // ignore missing paths
        }
    }

    try {
        return hasGamemodeManifest(folderPath);
    } catch {
        return false;
    }
}
