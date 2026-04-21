import * as path from 'path';
import * as vscode from 'vscode';
import type { GmodPluginCatalog, GmodPluginDescriptor } from './gmodPluginCatalog';

export interface PluginDetectionResult {
    readonly detected: readonly GmodPluginDescriptor[];
    readonly evidence: Readonly<Record<string, readonly string[]>>;
}

const REGEX_FLAGS = 'i';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_FILE_NAME_CANDIDATES = 5000;
const SYMBOL_QUERY_CONCURRENCY = 8;

interface FolderRuntimeState {
    readonly watcher: vscode.FileSystemWatcher;
    readonly cacheByCatalogFingerprint: Map<string, PluginDetectionResult>;
}

export interface PluginDetectionLsReadiness {
    readonly ready: Promise<void>;
    isRunning(): boolean;
}

let pluginDetectionLsReadiness: PluginDetectionLsReadiness | undefined;
const folderRuntimeStateByKey = new Map<string, FolderRuntimeState>();
let workspaceFolderChangeDisposable: vscode.Disposable | undefined;
let pluginDetectionOutputChannel: vscode.OutputChannel | undefined;

interface LuaFileEntry {
    readonly uri: vscode.Uri;
    readonly relativePath: string;
    readonly fileName: string;
}

export function setPluginDetectionLsReadiness(readiness: PluginDetectionLsReadiness | undefined): void {
    pluginDetectionLsReadiness = readiness;
}

export function disposePluginDetectionRuntime(): void {
    pluginDetectionLsReadiness = undefined;
    workspaceFolderChangeDisposable?.dispose();
    workspaceFolderChangeDisposable = undefined;
    for (const state of folderRuntimeStateByKey.values()) {
        state.watcher.dispose();
    }
    folderRuntimeStateByKey.clear();
    pluginDetectionOutputChannel?.dispose();
    pluginDetectionOutputChannel = undefined;
}

function getPluginDetectionOutputChannel(): vscode.OutputChannel {
    if (!pluginDetectionOutputChannel) {
        pluginDetectionOutputChannel = vscode.window.createOutputChannel('GLuaLS · Plugin Detection');
    }
    return pluginDetectionOutputChannel;
}

function ensureWorkspaceFolderRuntimeCleanup(): void {
    if (workspaceFolderChangeDisposable) {
        return;
    }

    workspaceFolderChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const removedFolder of event.removed) {
            const folderKey = removedFolder.uri.toString();
            const state = folderRuntimeStateByKey.get(folderKey);
            if (!state) continue;
            state.watcher.dispose();
            folderRuntimeStateByKey.delete(folderKey);
        }
    });
}

function ensureFolderRuntimeState(workspaceFolder: vscode.WorkspaceFolder): FolderRuntimeState {
    ensureWorkspaceFolderRuntimeCleanup();

    const folderKey = workspaceFolder.uri.toString();
    const existing = folderRuntimeStateByKey.get(folderKey);
    if (existing) {
        return existing;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder.uri, '**/*.{lua,txt}'),
    );
    const state: FolderRuntimeState = {
        watcher,
        cacheByCatalogFingerprint: new Map<string, PluginDetectionResult>(),
    };

    const invalidate = (): void => {
        state.cacheByCatalogFingerprint.clear();
    };

    watcher.onDidChange(invalidate);
    watcher.onDidCreate(invalidate);
    watcher.onDidDelete(invalidate);

    folderRuntimeStateByKey.set(folderKey, state);
    return state;
}

function buildCatalogFingerprint(plugins: readonly GmodPluginDescriptor[]): string {
    return plugins
        .map((plugin) => [
            plugin.id,
            plugin.kind,
            plugin.manifestPatterns.join('~'),
            plugin.folderNamePatterns.join('~'),
            plugin.fileNamePatterns.join('~'),
            plugin.globalNames.join('~'),
            plugin.globalPatterns.join('~'),
            plugin.searchHints?.fileGlobs?.join('~') ?? '',
        ].join('|'))
        .sort((a, b) => a.localeCompare(b))
        .join('||');
}

function compilePattern(pattern: string): RegExp | undefined {
    try {
        return new RegExp(pattern, REGEX_FLAGS);
    } catch {
        return undefined;
    }
}

function toRelativePath(workspaceFolder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    return path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

async function readTextFileIfSmall(uri: vscode.Uri, maxBytes: number): Promise<string | undefined> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > maxBytes) {
            return undefined;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return undefined;
    }
}

async function readManifestContents(
    workspaceFolder: vscode.WorkspaceFolder,
    token?: vscode.CancellationToken,
): Promise<Array<{ uri: vscode.Uri; content: string }>> {
    const manifestPattern = new vscode.RelativePattern(workspaceFolder.uri, '*.txt');
    const candidates = await vscode.workspace.findFiles(manifestPattern, undefined, 64, token);
    const manifests: Array<{ uri: vscode.Uri; content: string }> = [];
    for (const candidate of candidates) {
        const content = await readTextFileIfSmall(candidate, MAX_MANIFEST_BYTES);
        if (content === undefined) continue;
        manifests.push({ uri: candidate, content });
    }
    return manifests;
}

function detectByManifestPatterns(
    manifests: Array<{ uri: vscode.Uri; content: string }>,
    plugin: GmodPluginDescriptor,
): string | undefined {
    for (const patternSource of plugin.manifestPatterns) {
        const pattern = compilePattern(patternSource);
        if (!pattern) continue;
        for (const manifest of manifests) {
            if (pattern.test(manifest.content)) {
                const manifestName = path.basename(manifest.uri.fsPath);
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

async function findLuaCandidatesForPlugin(
    workspaceFolder: vscode.WorkspaceFolder,
    plugin: GmodPluginDescriptor,
    searchCacheByGlob: Map<string, Promise<readonly vscode.Uri[]>>,
    token?: vscode.CancellationToken,
): Promise<LuaFileEntry[]> {
    const queryGlobs = plugin.searchHints?.fileGlobs && plugin.searchHints.fileGlobs.length > 0
        ? plugin.searchHints.fileGlobs
        : ['**/*.lua'];

    const dedupedByUri = new Map<string, vscode.Uri>();
    for (const glob of queryGlobs) {
        let urisPromise = searchCacheByGlob.get(glob);
        if (!urisPromise) {
            urisPromise = Promise.resolve(vscode.workspace.findFiles(
                new vscode.RelativePattern(workspaceFolder.uri, glob),
                undefined,
                MAX_FILE_NAME_CANDIDATES,
                token,
            ));
            searchCacheByGlob.set(glob, urisPromise);
        }
        const uris = await urisPromise;
        for (const uri of uris) {
            dedupedByUri.set(uri.toString(), uri);
        }
    }

    const files: LuaFileEntry[] = [];
    for (const uri of dedupedByUri.values()) {
        if (!uri.fsPath.toLowerCase().endsWith('.lua')) continue;
        files.push({
            uri,
            relativePath: toRelativePath(workspaceFolder, uri),
            fileName: path.basename(uri.fsPath),
        });
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

function deriveQueryHintFromPatternSource(patternSource: string): string | undefined {
    const cleaned = patternSource.replace(/\\./g, ' ');
    const matches = [...cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)]
        .map((match) => match[0])
        .filter((token) => token.length >= 2);
    if (matches.length === 0) {
        return undefined;
    }

    // First symbol-ish token is usually the lookup anchor (e.g. CAMI.RegisterPrivilege -> CAMI).
    return matches[0];
}

function isUriInsideWorkspaceFolder(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): boolean {
    if (uri.scheme !== workspaceFolder.uri.scheme) {
        return false;
    }

    if (uri.scheme === 'file') {
        const folderPath = path.resolve(workspaceFolder.uri.fsPath);
        const filePath = path.resolve(uri.fsPath);
        const normalizedFolder = process.platform === 'win32' ? folderPath.toLowerCase() : folderPath;
        const normalizedFile = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
        const relative = path.relative(normalizedFolder, normalizedFile);
        return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    const folderBase = workspaceFolder.uri.toString().replace(/\/$/, '');
    return uri.toString().startsWith(`${folderBase}/`) || uri.toString() === folderBase;
}

function createCancellationPromise(token: vscode.CancellationToken): Promise<void> {
    return new Promise((_, reject) => {
        if (token.isCancellationRequested) {
            reject(new vscode.CancellationError());
            return;
        }

        const disposable = token.onCancellationRequested(() => {
            disposable.dispose();
            reject(new vscode.CancellationError());
        });
    });
}

async function waitForLanguageServerReadiness(token?: vscode.CancellationToken): Promise<void> {
    if (!pluginDetectionLsReadiness || pluginDetectionLsReadiness.isRunning()) {
        return;
    }

    if (!token) {
        await pluginDetectionLsReadiness.ready;
        return;
    }

    await Promise.race([
        pluginDetectionLsReadiness.ready,
        createCancellationPromise(token),
    ]);
}

async function mapLimit<T>(
    values: readonly T[],
    limit: number,
    runner: (value: T) => Promise<void>,
): Promise<void> {
    if (values.length === 0) return;

    const workers = Array.from({ length: Math.min(limit, values.length) }, async (_, workerIndex) => {
        for (let index = workerIndex; index < values.length; index += Math.min(limit, values.length)) {
            await runner(values[index]);
        }
    });

    await Promise.all(workers);
}

async function detectByWorkspaceSymbols(
    workspaceFolder: vscode.WorkspaceFolder,
    unresolvedGlobalPlugins: readonly GmodPluginDescriptor[],
    markDetected: (plugin: GmodPluginDescriptor, reason: string) => void,
    token?: vscode.CancellationToken,
): Promise<void> {
    await waitForLanguageServerReadiness(token);

    const pluginById = new Map(unresolvedGlobalPlugins.map((plugin) => [plugin.id, plugin]));
    const unresolvedPluginIds = new Set(unresolvedGlobalPlugins.map((plugin) => plugin.id));
    const globalNameQueryToPluginIds = new Map<string, Set<string>>();
    const globalPatternQueryToEntries = new Map<string, Array<{ pluginId: string; source: string; pattern: RegExp }>>();

    for (const plugin of unresolvedGlobalPlugins) {
        for (const globalName of plugin.globalNames) {
            const normalizedGlobalName = globalName.trim();
            if (normalizedGlobalName.length === 0) continue;

            const pluginIds = globalNameQueryToPluginIds.get(normalizedGlobalName) ?? new Set<string>();
            pluginIds.add(plugin.id);
            globalNameQueryToPluginIds.set(normalizedGlobalName, pluginIds);
        }

        for (const patternSource of plugin.globalPatterns) {
            const pattern = compilePattern(patternSource);
            if (!pattern) continue;
            const queryHint = deriveQueryHintFromPatternSource(patternSource);
            if (!queryHint) continue;

            const entries = globalPatternQueryToEntries.get(queryHint) ?? [];
            entries.push({
                pluginId: plugin.id,
                source: patternSource,
                pattern,
            });
            globalPatternQueryToEntries.set(queryHint, entries);
        }
    }

    const allQueries = [...new Set([
        ...globalNameQueryToPluginIds.keys(),
        ...globalPatternQueryToEntries.keys(),
    ])];

    await mapLimit(allQueries, SYMBOL_QUERY_CONCURRENCY, async (query) => {
        if (unresolvedPluginIds.size === 0) {
            return;
        }
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query,
        ) ?? [];
        if (symbols.length === 0) {
            return;
        }

        for (const symbol of symbols) {
            if (unresolvedPluginIds.size === 0) {
                break;
            }

            const symbolUri = symbol.location.uri;
            if (!isUriInsideWorkspaceFolder(symbolUri, workspaceFolder)) {
                continue;
            }

            const symbolName = symbol.name;
            const relativePath = toRelativePath(workspaceFolder, symbolUri);

            if (symbolName === query) {
                const pluginIds = globalNameQueryToPluginIds.get(query);
                if (pluginIds) {
                    for (const pluginId of pluginIds) {
                        if (!unresolvedPluginIds.has(pluginId)) continue;
                        const plugin = pluginById.get(pluginId);
                        if (!plugin) continue;
                        markDetected(plugin, `global "${query}" symbol found in "${relativePath}"`);
                        unresolvedPluginIds.delete(pluginId);
                    }
                }
            }

            const patternEntries = globalPatternQueryToEntries.get(query);
            if (!patternEntries) {
                continue;
            }

            for (const entry of patternEntries) {
                if (!unresolvedPluginIds.has(entry.pluginId)) continue;
                if (!entry.pattern.test(symbolName)) continue;

                const plugin = pluginById.get(entry.pluginId);
                if (!plugin) continue;
                markDetected(plugin, `global pattern /${entry.source}/i matched symbol "${symbolName}" in "${relativePath}"`);
                unresolvedPluginIds.delete(entry.pluginId);
            }
        }
    });
}

export async function detectFrameworkPlugin(
    workspaceFolder: vscode.WorkspaceFolder,
    plugins: readonly GmodPluginDescriptor[],
    options?: { token?: vscode.CancellationToken; bypassCache?: boolean },
): Promise<PluginDetectionResult> {
    const token = options?.token;
    const bypassCache = options?.bypassCache ?? false;
    const startedAt = Date.now();
    const runtimeState = ensureFolderRuntimeState(workspaceFolder);
    const catalogFingerprint = buildCatalogFingerprint(plugins);
    if (!bypassCache) {
        const cachedResult = runtimeState.cacheByCatalogFingerprint.get(catalogFingerprint);
        if (cachedResult) {
            getPluginDetectionOutputChannel().appendLine(
                `[cache-hit] folder=${workspaceFolder.name} detected=${cachedResult.detected.length} elapsedMs=${Date.now() - startedAt}`,
            );
            return cachedResult;
        }
    } else {
        runtimeState.cacheByCatalogFingerprint.delete(catalogFingerprint);
    }

    let manifestMs = 0;
    let fileNameMs = 0;
    let symbolMs = 0;

    const manifestStartedAt = Date.now();
    const folderName = path.basename(workspaceFolder.uri.fsPath).toLowerCase();
    const manifests = await readManifestContents(workspaceFolder, token);
    manifestMs = Date.now() - manifestStartedAt;
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

    const fileNameStartedAt = Date.now();
    const luaSearchCacheByGlob = new Map<string, Promise<readonly vscode.Uri[]>>();
    for (const plugin of plugins) {
        if (detectedById.has(plugin.id)) continue;
        if (plugin.fileNamePatterns.length === 0) continue;

        const luaFiles = await findLuaCandidatesForPlugin(workspaceFolder, plugin, luaSearchCacheByGlob, token);
        const fileNameEvidence = detectByFileNamePattern(luaFiles, plugin);
        if (fileNameEvidence) {
            markDetected(plugin, fileNameEvidence);
        }
    }
    fileNameMs = Date.now() - fileNameStartedAt;

    const unresolvedGlobalPlugins = plugins.filter((plugin) =>
        !detectedById.has(plugin.id) &&
        (plugin.globalNames.length > 0 || plugin.globalPatterns.length > 0),
    );

    let symbolDetectionFailed = false;
    if (unresolvedGlobalPlugins.length > 0) {
        const symbolStartedAt = Date.now();
        try {
            await detectByWorkspaceSymbols(workspaceFolder, unresolvedGlobalPlugins, markDetected, token);
        } catch {
            // Keep detection resilient if symbol provider lookups fail.
            symbolDetectionFailed = true;
        }
        symbolMs = Date.now() - symbolStartedAt;
    }

    const detected = [...detectedById.values()]
        .map((entry) => entry.plugin)
        .sort((a, b) => a.id.localeCompare(b.id));
    const evidence: Record<string, readonly string[]> = {};
    for (const [pluginId, entry] of detectedById) {
        evidence[pluginId] = [...entry.evidence];
    }

    const result = { detected, evidence };
    if (!symbolDetectionFailed) {
        runtimeState.cacheByCatalogFingerprint.set(catalogFingerprint, result);
    }
    getPluginDetectionOutputChannel().appendLine(
        `[scan] folder=${workspaceFolder.name} detected=${detected.length} manifests=${manifests.length} ` +
        `manifestMs=${manifestMs} fileNameMs=${fileNameMs} symbolMs=${symbolMs} elapsedMs=${Date.now() - startedAt} ` +
        `cacheSaved=${symbolDetectionFailed ? 'false' : 'true'}`,
    );

    return result;
}

export function buildPluginDetectionFingerprint(result: PluginDetectionResult): string {
    if (result.detected.length === 0) return 'none';
    const ids = result.detected.map((plugin) => plugin.id).sort();
    return `detected:${ids.join(',')}`;
}

export async function detectGmodPlugin(
    workspaceFolder: vscode.WorkspaceFolder,
    catalog: GmodPluginCatalog,
    options?: { token?: vscode.CancellationToken; bypassCache?: boolean },
): Promise<PluginDetectionResult> {
    return detectFrameworkPlugin(workspaceFolder, catalog.plugins, {
        token: options?.token,
        bypassCache: options?.bypassCache,
    });
}
