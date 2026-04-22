import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { buildCategories, Category } from './gluarcSchema';
import { readGluarcConfig, writeGluarcConfig, setNestedValue, getGluarcUri, ensureGluarcExists } from './gluarcConfig';
import { loadGmodPluginCatalog, type GmodPluginCatalog } from './gmodPluginCatalog';
import { readPresetState } from './gmodPresetState';
import { GmodAnnotationManager } from './gmodAnnotationManager';

const SAVE_DEBOUNCE_MS = 5000;
const SETTINGS_AUTO_SAVE_KEY = 'gmod.settingsAutoSave';
const SETTINGS_AUTO_SAVE_SECTION = 'gluals.gmod.settingsAutoSave';

export interface GluarcSettingsPanelTarget {
    readonly uri?: vscode.Uri;
    readonly categoryKey?: string;
}

type GluarcSettingsTargetInput = vscode.Uri | GluarcSettingsPanelTarget | undefined;

export class GluarcSettingsPanel implements vscode.Disposable {
    private static current: GluarcSettingsPanel | undefined;

    private config: Record<string, unknown> = {};
    private categories: Category[] = [];
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private _saveTimer: ReturnType<typeof setTimeout> | undefined;
    // Caches only the loaded catalog (disk read of plugin descriptors). Per-call payload
    // recomputation is required because `detected` derives from preset state that can
    // change while the panel is open (e.g. user re-runs framework detection).
    private _cachedPluginCatalog: { annotationPath: string; catalog: GmodPluginCatalog } | undefined;
    private _annotationManager: GmodAnnotationManager | undefined;
    private _pluginUpdatesAvailable = new Set<string>();
    private _hasUnsavedChanges = false;
    private _isSelfWrite = false;
    private _isInitialized = false;
    private _pendingFocusCategoryKey: string | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

    /**
     * Ensures .gluarc.json exists in the resolved workspace folder (creating a
     * minimal `{}` skeleton if missing), then opens the settings panel.
     * Used by the `gluals.gmod.createSettings` command.
     */
    static async createAndShow(context: vscode.ExtensionContext, target?: GluarcSettingsTargetInput): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('Open a workspace folder to create GLua settings');
            return;
        }

        const { uri: targetUri, categoryKey } = GluarcSettingsPanel.normalizeTarget(target);

        let workspaceFolder = targetUri
            ? GluarcSettingsPanel.resolveWorkspaceFolderFromUri(targetUri)
            : undefined;

        if (!workspaceFolder) {
            if (folders.length === 1) {
                workspaceFolder = folders[0];
            } else {
                const pickedFolder = await vscode.window.showWorkspaceFolderPick();
                if (!pickedFolder) {
                    return;
                }
                workspaceFolder = pickedFolder;
            }
        }

        const created = await ensureGluarcExists(workspaceFolder);
        if (!created) {
            // ensureGluarcExists already showed an error message
            return;
        }

        // Pass the already-resolved workspaceFolder directly to avoid a
        // second showWorkspaceFolderPick call in multi-root workspaces.
        await GluarcSettingsPanel.createOrShow(context, { uri: workspaceFolder.uri, categoryKey });
    }

    static async createOrShow(context: vscode.ExtensionContext, target?: GluarcSettingsTargetInput): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('Open a workspace folder to edit GLua settings');
            return;
        }

        const { uri: targetUri, categoryKey } = GluarcSettingsPanel.normalizeTarget(target);

        let workspaceFolder = targetUri
            ? GluarcSettingsPanel.resolveWorkspaceFolderFromUri(targetUri)
            : undefined;

        if (!workspaceFolder) {
            if (folders.length === 1) {
                workspaceFolder = folders[0];
            } else {
                const pickedFolder = await vscode.window.showWorkspaceFolderPick();
                if (!pickedFolder) {
                    return;
                }
                workspaceFolder = pickedFolder;
            }
        }

        const current = GluarcSettingsPanel.current;
        if (current) {
            const isSameWorkspace = current.workspaceFolder.uri.toString() === workspaceFolder.uri.toString();
            if (!isSameWorkspace) {
                GluarcSettingsPanel.current = undefined;
                current.panel.dispose();
            } else {
                current.panel.reveal(vscode.ViewColumn.One);
                await current.focusCategory(categoryKey);
                return;
            }
        }

        const panel = vscode.window.createWebviewPanel(
            'gluarcSettings',
            'GLua Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'res'))],
            }
        );

        const instance = new GluarcSettingsPanel(panel, context, workspaceFolder, categoryKey);
        GluarcSettingsPanel.current = instance;
    }

    private static normalizeTarget(target: GluarcSettingsTargetInput): GluarcSettingsPanelTarget {
        if (target instanceof vscode.Uri) {
            return { uri: target };
        }

        return target ?? {};
    }

    private static resolveWorkspaceFolderFromUri(targetUri: vscode.Uri): vscode.WorkspaceFolder | undefined {
        const isGluarcFile = path.basename(targetUri.fsPath) === '.gluarc.json';
        const folderUri = isGluarcFile ? vscode.Uri.joinPath(targetUri, '..') : targetUri;

        const workspaceFolder = vscode.workspace.workspaceFolders?.find(
            wf => wf.uri.toString() === folderUri.toString()
        ) ?? vscode.workspace.getWorkspaceFolder(folderUri);

        if (workspaceFolder) {
            return workspaceFolder;
        }

        return isGluarcFile ? vscode.workspace.getWorkspaceFolder(targetUri) : undefined;
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceFolder: vscode.WorkspaceFolder,
        initialCategoryKey?: string,
    ) {
        this._pendingFocusCategoryKey = initialCategoryKey;
        this._disposables.push(
            this.panel.onDidDispose(() => {
                GluarcSettingsPanel.current = undefined;
                this.dispose();
            })
        );

        void this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            const schemaPath = path.join(this.context.extensionPath, 'syntaxes', 'schema.json');
            const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
            const schemaJson = JSON.parse(schemaRaw) as object;
            this.categories = buildCategories(schemaJson);

            this.config = await readGluarcConfig(this.workspaceFolder);

            const htmlReady = this.setWebviewContent();
            if (!htmlReady) {
                return;
            }

            await this.panel.webview.postMessage({
                type: 'init',
                categories: this.categories,
                config: this.config,
                autoSaveEnabled: this._isAutoSaveEnabled(),
                pluginCatalog: this._getPluginCatalogPayload(),
                initialCategoryKey: this._pendingFocusCategoryKey,
            });
            this._isInitialized = true;

            // Best-effort: probe the network for plugin annotation updates after
            // the panel renders. Silent on failure; pushes a refreshed payload
            // when results are in.
            void this._refreshPluginUpdatesAvailable();

            const messageDisposable = this.panel.webview.onDidReceiveMessage(async (msg: unknown) => {
                if (!msg || typeof msg !== 'object') {
                    return;
                }

                const message = msg as { type?: unknown; path?: unknown; value?: unknown; url?: unknown; pluginId?: unknown };
                if (message.type === 'reloadServer') {
                    await vscode.commands.executeCommand('gluals.restartServer');
                    return;
                }

                if (message.type === 'openExternal') {
                    if (typeof message.url === 'string') {
                        try {
                            const parsed = vscode.Uri.parse(message.url, true);
                            if (parsed.scheme === 'https' || parsed.scheme === 'http') {
                                await vscode.env.openExternal(parsed);
                            }
                        } catch {
                            // Ignore malformed URLs.
                        }
                    }
                    return;
                }

                if (message.type === 'updatePlugin') {
                    if (typeof message.pluginId !== 'string' || message.pluginId.length === 0) {
                        return;
                    }
                    const catalog = loadGmodPluginCatalog(this._resolvedAnnotationPath());
                    const plugin = catalog.byId.get(message.pluginId);
                    if (!plugin) return;
                    const result = await this._getAnnotationManager().updatePluginBundle(plugin);
                    if (result) {
                        this._pluginUpdatesAvailable.delete(plugin.id);
                        await this._postPluginCatalogPayload();
                        const action = await vscode.window.showInformationMessage(
                            `${plugin.label} plugin annotations updated. Restart language server to apply?`,
                            'Restart',
                            'Later',
                        );
                        if (action === 'Restart') {
                            await vscode.commands.executeCommand('gluals.restartServer');
                        }
                    }
                    return;
                }

                if (message.type === 'checkPluginUpdates') {
                    void this._refreshPluginUpdatesAvailable();
                    return;
                }

                if (message.type === 'saveNow') {
                    this._flushSave();
                    return;
                }

                if (message.type === 'resetAll') {
                    const choice = await vscode.window.showWarningMessage(
                        'Are you sure you want to reset all settings to their defaults? This cannot be undone.',
                        { modal: true },
                        'Reset All'
                    );
                    if (choice !== 'Reset All') {
                        return;
                    }
                    this._cancelPendingSave();
                    const schemaRef = this.config['$schema'];
                    for (const key of Object.keys(this.config)) {
                        delete this.config[key];
                    }
                    if (typeof schemaRef === 'string') {
                        this.config['$schema'] = schemaRef;
                    }
                    this._isSelfWrite = true;
                    const writeSucceeded = await writeGluarcConfig(this.workspaceFolder, this.config);
                    if (!writeSucceeded) {
                        this._isSelfWrite = false;
                        return;
                    }
                    this._hasUnsavedChanges = false;
                    setTimeout(() => { this._isSelfWrite = false; }, 500);
                    await this.panel.webview.postMessage({
                        type: 'resetCompleted',
                        config: this.config,
                        autoSaveEnabled: this._isAutoSaveEnabled(),
                        pluginCatalog: this._getPluginCatalogPayload(),
                    });
                    return;
                }

                if (message.type !== 'change') {
                    return;
                }

                if (!Array.isArray(message.path) || !message.path.every((segment) => typeof segment === 'string')) {
                    return;
                }

                setNestedValue(this.config, message.path, message.value);
                this._hasUnsavedChanges = true;
                if (this._isAutoSaveEnabled()) {
                    this._scheduleSave();
                } else {
                    this._cancelPendingSave();
                }
            });
            this._disposables.push(messageDisposable);

            const gluarcUri = getGluarcUri(this.workspaceFolder);
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceFolder, path.basename(gluarcUri.fsPath))
            );
            this._disposables.push(
                watcher,
                watcher.onDidChange(() => this._onExternalChange()),
                watcher.onDidCreate(() => this._onExternalChange())
            );

            const configurationDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
                if (!event.affectsConfiguration(SETTINGS_AUTO_SAVE_SECTION, this.workspaceFolder.uri)) {
                    return;
                }

                const autoSaveEnabled = this._isAutoSaveEnabled();
                if (autoSaveEnabled) {
                    if (this._hasUnsavedChanges) {
                        this._scheduleSave();
                    }
                } else {
                    this._cancelPendingSave();
                }

                void this.panel.webview.postMessage({
                    type: 'settingsUpdated',
                    autoSaveEnabled,
                });
            });
            this._disposables.push(configurationDisposable);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open GLua settings: ${message}`);
            this.panel.dispose();
        }
    }

    private _onExternalChange(): void {
        if (this._isSelfWrite) {
            return;
        }

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._debounceTimer = setTimeout(async () => {
            try {
                const updatedConfig = await readGluarcConfig(this.workspaceFolder);
                if (JSON.stringify(updatedConfig) === JSON.stringify(this.config)) {
                    return;
                }

                this.config = updatedConfig;
                this._hasUnsavedChanges = false;
                await this.panel.webview.postMessage({
                    type: 'configUpdated',
                    config: this.config,
                    autoSaveEnabled: this._isAutoSaveEnabled(),
                    pluginCatalog: this._getPluginCatalogPayload(),
                });
            } catch (error) {
                console.warn('[GLuaLS] Failed to reload .gluarc.json:', error instanceof Error ? error.message : error);
            }
        }, 300);
    }

    private _scheduleSave(): void {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
        }

        this._saveTimer = setTimeout(() => {
            void this._writeToDisk();
        }, SAVE_DEBOUNCE_MS);
    }

    private _cancelPendingSave(): void {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
        }
    }

    private _flushSave(): void {
        this._cancelPendingSave();
        void this._writeToDisk();
    }

    private async _writeToDisk(): Promise<void> {
        this._saveTimer = undefined;
        if (!this._hasUnsavedChanges) {
            return;
        }

        this._isSelfWrite = true;
        const writeSucceeded = await writeGluarcConfig(this.workspaceFolder, this.config);
        if (!writeSucceeded) {
            this._isSelfWrite = false;
            return;
        }
        this._hasUnsavedChanges = false;
        setTimeout(() => { this._isSelfWrite = false; }, 500);
        await this.panel.webview.postMessage({ type: 'saved' });
    }

    private _isAutoSaveEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('gluals', this.workspaceFolder.uri)
            .get<boolean>(SETTINGS_AUTO_SAVE_KEY, false);
    }

    private _getPluginCatalogPayload(): Array<{
        id: string;
        label: string;
        description: string;
        kind: string;
        detected: boolean;
        sourceUrl: string;
        updateAvailable: boolean;
    }> {
        const annotationPath = vscode.workspace.getConfiguration('gluals', this.workspaceFolder.uri).get<string>('ls.annotationPath');
        const resolvedAnnotationPath = annotationPath?.trim()
            ? annotationPath
            : path.join(this.context.globalStorageUri.fsPath, 'gmod-annotations');
        let catalog: GmodPluginCatalog;
        if (this._cachedPluginCatalog && this._cachedPluginCatalog.annotationPath === resolvedAnnotationPath) {
            catalog = this._cachedPluginCatalog.catalog;
        } else {
            catalog = loadGmodPluginCatalog(resolvedAnnotationPath);
            this._cachedPluginCatalog = { annotationPath: resolvedAnnotationPath, catalog };
        }
        const presetState = readPresetState(this.context, this.workspaceFolder);
        const detectedPluginIds = new Set(presetState.lastDetectedPluginIds);
        return catalog.plugins.map((plugin) => ({
            id: plugin.id,
            label: plugin.label,
            description: plugin.description,
            kind: plugin.kind,
            detected: detectedPluginIds.has(plugin.id),
            sourceUrl: `https://github.com/Pollux12/annotations-gmod-glua-ls/tree/${plugin.artifact.branch}`,
            updateAvailable: this._pluginUpdatesAvailable.has(plugin.id),
        }));
    }

    private _getAnnotationManager(): GmodAnnotationManager {
        if (!this._annotationManager) {
            this._annotationManager = new GmodAnnotationManager(this.context);
        }
        return this._annotationManager;
    }

    private _resolvedAnnotationPath(): string {
        const configured = vscode.workspace
            .getConfiguration('gluals', this.workspaceFolder.uri)
            .get<string>('ls.annotationPath');
        return configured?.trim()
            ? configured.trim()
            : path.join(this.context.globalStorageUri.fsPath, 'gmod-annotations');
    }

    private async _refreshPluginUpdatesAvailable(): Promise<void> {
        try {
            const catalog = loadGmodPluginCatalog(this._resolvedAnnotationPath());
            const ids = catalog.plugins.map((p) => p.id);
            const updates = this._getAnnotationManager().checkPluginUpdates(ids, catalog);
            this._pluginUpdatesAvailable = new Set(updates);
            await this._postPluginCatalogPayload();
        } catch (error) {
            console.warn('[GLuaLS] Plugin update detection failed:', error instanceof Error ? error.message : error);
        }
    }

    private async _postPluginCatalogPayload(): Promise<void> {
        try {
            await this.panel.webview.postMessage({
                type: 'pluginCatalogUpdated',
                pluginCatalog: this._getPluginCatalogPayload(),
            });
        } catch {
            // Webview disposed; ignore.
        }
    }

    private setWebviewContent(): boolean {
        try {
            const htmlPath = path.join(this.context.extensionPath, 'res', 'gluarcSettings.html');
            const htmlTemplate = fs.readFileSync(htmlPath, 'utf8');
            const nonce = crypto.randomBytes(16).toString('base64');
            const cspSource = this.panel.webview.cspSource;

            const hljsUri = this.panel.webview.asWebviewUri(
                vscode.Uri.file(path.join(this.context.extensionPath, 'res', 'hljs-lua.js'))
            );
            const stylesUri = this.panel.webview.asWebviewUri(
                vscode.Uri.file(path.join(this.context.extensionPath, 'res', 'gluarcSettings', 'styles.css'))
            );
            const mainScriptUri = this.panel.webview.asWebviewUri(
                vscode.Uri.file(path.join(this.context.extensionPath, 'res', 'gluarcSettings', 'main.js'))
            );

            const processedHtml = htmlTemplate
                .replace(/\{\{nonce\}\}/g, nonce)
                .replace(/\{\{cspSource\}\}/g, cspSource)
                .replace(/\{\{hljsUri\}\}/g, hljsUri.toString())
                .replace(/\{\{stylesUri\}\}/g, stylesUri.toString())
                .replace(/\{\{mainScriptUri\}\}/g, mainScriptUri.toString());

            this.panel.webview.html = processedHtml;
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load GLua settings UI: ${message}`);
            const safeMessage = message
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head>
<body>
    <h2>Failed to load GLua settings UI</h2>
    <p>${safeMessage}</p>
</body>
</html>`;
            return false;
        }
    }

    private async focusCategory(categoryKey: string | undefined): Promise<void> {
        if (!categoryKey) {
            return;
        }

        this._pendingFocusCategoryKey = categoryKey;
        if (!this._isInitialized) {
            return;
        }

        await this.panel.webview.postMessage({
            type: 'focusCategory',
            categoryKey,
        });
    }

    dispose(): void {
        // Flush any pending debounced save synchronously to prevent data loss
        if (this._saveTimer && this._isAutoSaveEnabled()) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
            try {
                const gluarcUri = getGluarcUri(this.workspaceFolder);
                const serialized = `${JSON.stringify(this.config, null, 2)}\n`;
                fs.writeFileSync(gluarcUri.fsPath, serialized, 'utf8');
            } catch {
                // Best-effort: if sync write fails, changes are lost
            }
        }

        while (this._disposables.length > 0) {
            this._disposables.pop()?.dispose();
        }

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }

        GluarcSettingsPanel.current = undefined;
        this._isInitialized = false;
    }
}
