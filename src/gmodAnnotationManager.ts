import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fetchJson, downloadAndExtractZip } from './netHelpers';
import { GmodPluginCatalog, GmodPluginDescriptor, loadPluginBundleDefinition } from './gmodPluginCatalog';

export interface LocalPluginBundleCandidateOptions {
    pluginId: string;
    pluginBundlePathOverride?: string;
    annotationPathOverride?: string;
}

export function getLocalPluginBundleCandidates(options: LocalPluginBundleCandidateOptions): string[] {
    const candidates: string[] = [];
    if (options.pluginBundlePathOverride?.trim()) {
        candidates.push(path.join(options.pluginBundlePathOverride.trim(), options.pluginId));
    }
    if (options.annotationPathOverride?.trim()) {
        const normalizedBase = path.resolve(options.annotationPathOverride.trim());
        const siblingRoot = path.join(
            path.dirname(normalizedBase),
            `${path.basename(normalizedBase)}-plugins`,
        );
        candidates.push(path.join(siblingRoot, options.pluginId));
    }

    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const candidate of candidates) {
        const normalized = path.resolve(candidate);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        deduped.push(normalized);
    }
    return deduped;
}

/**
 * Manages Garry's Mod GLuaLS annotations
 * Handles downloading and updating from the gluals-annotations branch
 */
export class GmodAnnotationManager implements vscode.Disposable {
    private readonly REPO_SLUG = 'Pollux12/annotations-gmod-glua-ls';
    private readonly ZIP_URL = 'https://github.com/Pollux12/annotations-gmod-glua-ls/archive/refs/heads/gluals-annotations.zip';
    private readonly ZIP_INNER_FOLDER = 'annotations-gmod-glua-ls-gluals-annotations';
    private readonly REMOTE_METADATA_URL = 'https://raw.githubusercontent.com/Pollux12/annotations-gmod-glua-ls/gluals-annotations/__metadata.json';
    private readonly annotationsPath: string;
    private readonly pluginStoragePath: string;

    constructor(context: vscode.ExtensionContext) {
        // Store annotations in extension's global storage
        this.annotationsPath = path.join(
            context.globalStorageUri.fsPath,
            'gmod-annotations'
        );
        this.pluginStoragePath = path.join(
            context.globalStorageUri.fsPath,
            'gmod-plugin-annotations'
        );
    }

    private getAnnotationPathOverride(): string | undefined {
        const configuredPath = vscode.workspace.getConfiguration('gluals').get<string>('ls.annotationPath');
        if (!configuredPath) {
            return undefined;
        }

        const normalizedPath = configuredPath.trim();
        return normalizedPath.length > 0 ? normalizedPath : undefined;
    }

    private getPluginBundlePathOverride(): string | undefined {
        const configuredPath = vscode.workspace.getConfiguration('gluals').get<string>('ls.pluginBundlePath');
        if (!configuredPath) {
            return undefined;
        }

        const normalizedPath = configuredPath.trim();
        return normalizedPath.length > 0 ? normalizedPath : undefined;
    }

    private isAccessibleDirectory(dirPath: string): boolean {
        try {
            return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Get the path to annotations (only if enabled and available)
     */
    public getAnnotationsPath(): string | undefined {
        const config = vscode.workspace.getConfiguration('gluals');

        // Check for annotation path override first
        const overridePath = this.getAnnotationPathOverride();
        if (overridePath) {
            // When override is set, use it directly without checking autoLoadAnnotations
            // Verify the path exists
            if (this.isAccessibleDirectory(overridePath)) {
                return overridePath;
            }
            console.warn(`[GLuaLS] Configured annotation override path is invalid, inaccessible, or not a directory: ${overridePath}`);
            return undefined;
        }
        
        // No override, check built-in annotations
        const enabled = config.get<boolean>('gmod.autoLoadAnnotations', true);

        if (!enabled) {
            return undefined;
        }

        // Return path only if annotations exist
        if (this.annotationsExist()) {
            return this.annotationsPath;
        }

        return undefined;
    }

    /**
     * Check if annotations are already downloaded
     */
    private annotationsExist(): boolean {
        return fs.existsSync(this.annotationsPath) && fs.existsSync(path.join(this.annotationsPath, '__metadata.json'));
    }

    /**
     * Initialize annotations - download if needed
     */
    public async initializeAnnotations(): Promise<void> {
        const config = vscode.workspace.getConfiguration('gluals');
        const enabled = config.get<boolean>('gmod.autoLoadAnnotations', true);
        const overridePath = this.getAnnotationPathOverride();

        // If override path is set, skip built-in annotation management entirely
        if (overridePath) {
            console.log(`[GLuaLS] Using custom annotation path override: ${overridePath}`);
            if (!this.isAccessibleDirectory(overridePath)) {
                vscode.window.showWarningMessage(
                    `Configured annotation path is invalid, inaccessible, or not a directory: ${overridePath}`
                );
            }
            return;
        }

        if (!enabled) {
            console.log('GMod annotations auto-load is disabled');
            return;
        }

        if (this.annotationsExist()) {
            console.log('GMod annotations already exist at', this.annotationsPath);
            return;
        }

        console.log('GMod annotations not found, downloading...');
        await this.downloadAnnotations();
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
    }

    public getPluginStoragePath(): string {
        return this.pluginStoragePath;
    }

    private getPluginInstallPath(pluginId: string): string {
        return path.join(this.pluginStoragePath, pluginId);
    }

    private getPluginBranchZipUrl(branch: string): string {
        return `https://github.com/${this.REPO_SLUG}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
    }

    private getPluginBranchInnerFolder(branch: string): string {
        return `${this.REPO_SLUG.split('/')[1]}-${branch}`;
    }

    private getInstalledPluginVersion(pluginInstallPath: string): string | undefined {
        try {
            const metadataPath = path.join(pluginInstallPath, '__plugin_metadata.json');
            if (!fs.existsSync(metadataPath)) return undefined;
            const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { version?: unknown };
            return typeof parsed.version === 'string' && parsed.version.trim().length > 0
                ? parsed.version.trim()
                : undefined;
        } catch {
            return undefined;
        }
    }

    private isPluginBundleCurrent(plugin: GmodPluginDescriptor, pluginInstallPath: string): boolean {
        const manifestRelPath = plugin.artifact.manifest || 'plugin.json';
        if (!fs.existsSync(path.join(pluginInstallPath, manifestRelPath))) {
            return false;
        }

        const expectedVersion = plugin.artifact.version;
        if (!expectedVersion) {
            return true;
        }

        return this.getInstalledPluginVersion(pluginInstallPath) === expectedVersion;
    }

    private resolveLocalPluginBundle(plugin: GmodPluginDescriptor): string | undefined {
        const manifestRelPath = plugin.artifact.manifest || 'plugin.json';
        const candidates = getLocalPluginBundleCandidates({
            pluginId: plugin.id,
            pluginBundlePathOverride: this.getPluginBundlePathOverride(),
            annotationPathOverride: this.getAnnotationPathOverride(),
        });

        for (const candidate of candidates) {
            if (!this.isAccessibleDirectory(candidate)) continue;
            const bundle = loadPluginBundleDefinition(candidate, manifestRelPath);
            if (bundle) {
                return candidate;
            }
        }

        return undefined;
    }

    public async ensurePluginBundle(plugin: GmodPluginDescriptor): Promise<string | undefined> {
        const localBundlePath = this.resolveLocalPluginBundle(plugin);
        if (localBundlePath) {
            return localBundlePath;
        }

        const localOverrideMode = !!this.getAnnotationPathOverride() || !!this.getPluginBundlePathOverride();
        if (localOverrideMode) {
            console.warn(`[GLuaLS] Local plugin bundle not found for ${plugin.id}. Skipping remote fallback in local override mode.`);
            return undefined;
        }

        const pluginInstallPath = this.getPluginInstallPath(plugin.id);
        if (this.isPluginBundleCurrent(plugin, pluginInstallPath)) {
            return pluginInstallPath;
        }

        const zipUrl = this.getPluginBranchZipUrl(plugin.artifact.branch);
        const innerFolder = this.getPluginBranchInnerFolder(plugin.artifact.branch);
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Downloading ${plugin.label} plugin annotations...`,
                    cancellable: false,
                },
                async (progress) => {
                    await downloadAndExtractZip(zipUrl, pluginInstallPath, innerFolder, progress);
                },
            );

            const manifestRelPath = plugin.artifact.manifest || 'plugin.json';
            if (!fs.existsSync(path.join(pluginInstallPath, manifestRelPath))) {
                throw new Error(`Plugin manifest "${plugin.artifact.manifest}" missing after download`);
            }

            if (plugin.artifact.version) {
                fs.writeFileSync(
                    path.join(pluginInstallPath, '__plugin_metadata.json'),
                    `${JSON.stringify({ version: plugin.artifact.version }, null, 2)}\n`,
                    'utf8',
                );
            }

            return pluginInstallPath;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(
                `GLuaLS: Failed to download ${plugin.label} plugin bundle (${plugin.artifact.branch}): ${errorMessage}`,
            );
            return undefined;
        }
    }

    public async resolvePluginAnnotationLibraryPaths(
        pluginIds: readonly string[],
        catalog: GmodPluginCatalog,
    ): Promise<string[]> {
        const paths: string[] = [];
        const seen = new Set<string>();

        for (const pluginId of pluginIds) {
            const plugin = catalog.byId.get(pluginId);
            if (!plugin) continue;

            const bundlePath = await this.ensurePluginBundle(plugin);
            if (!bundlePath) continue;

            const bundle = loadPluginBundleDefinition(bundlePath, plugin.artifact.manifest || 'plugin.json');
            if (!bundle) continue;

            if (!fs.existsSync(bundle.annotationsPath) || !fs.statSync(bundle.annotationsPath).isDirectory()) {
                continue;
            }

            if (seen.has(bundle.annotationsPath)) continue;
            seen.add(bundle.annotationsPath);
            paths.push(bundle.annotationsPath);
        }

        return paths;
    }

    /**
     * Check if a newer version of annotations is available on the remote branch.
     * Called by GmodUpdateScheduler on boot and periodically.
     */
    public async checkForUpdates(): Promise<void> {

        try {
            const localMetadataPath = path.join(this.annotationsPath, '__metadata.json');
            if (!fs.existsSync(localMetadataPath)) {
                return;
            }

            const localMetadata = JSON.parse(
                fs.readFileSync(localMetadataPath, 'utf-8')
            ) as { lastUpdate?: string };

            const remoteMetadata = await fetchJson<{ lastUpdate?: string }>(this.REMOTE_METADATA_URL, { timeoutMs: 10000 });
            if (!remoteMetadata || !remoteMetadata.lastUpdate) {
                return;
            }

            if (!localMetadata.lastUpdate) {
                return;
            }

            if (new Date(remoteMetadata.lastUpdate) > new Date(localMetadata.lastUpdate)) {
                const action = await vscode.window.showInformationMessage(
                    'GMod GLuaLS annotations update available.',
                    'Update Now',
                    'Later'
                );
                if (action === 'Update Now') {
                    await this.updateAnnotations();
                }
            }
        } catch {
            // Silently ignore network failures or parse errors — this is best-effort
        }
    }

    /**
     * Download or update annotations by downloading the zip file and extracting it
     */
    private async downloadAnnotationsZip(): Promise<void> {
        console.log(`Downloading annotations zip from ${this.ZIP_URL}...`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Downloading GMod annotations...',
                cancellable: false,
            },
            async (progress) => {
                await downloadAndExtractZip(this.ZIP_URL, this.annotationsPath, this.ZIP_INNER_FOLDER, progress);
                progress.report({ message: 'Download complete!' });
            }
        );
    }

    /**
     * Download annotations
     */
    private async downloadAnnotations(): Promise<void> {
        try {
            await this.downloadAnnotationsZip();
            console.log('GMod annotations downloaded successfully');
            vscode.window.showInformationMessage('GMod GLuaLS annotations downloaded successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to download GMod annotations:', errorMessage);
            vscode.window.showErrorMessage(
                `Failed to download GMod annotations: ${errorMessage}. ` +
                `You can disable auto-loading in settings (gluals.gmod.autoLoadAnnotations).`
            );
        }
    }

    /**
     * Update annotations to latest version
     */
    public async updateAnnotations(): Promise<void> {
        try {
            await this.downloadAnnotationsZip();
            vscode.window.showInformationMessage('GMod annotations updated successfully');

            // Suggest restarting the language server
            const action = await vscode.window.showInformationMessage(
                'Annotations updated. Restart language server to apply changes?',
                'Restart',
                'Later'
            );

            if (action === 'Restart') {
                await vscode.commands.executeCommand('gluals.restartServer');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to update GMod annotations:', errorMessage);
            vscode.window.showErrorMessage(`Failed to update GMod annotations: ${errorMessage}`);
        }
    }

    /**
     * Remove annotations
     */
    public async removeAnnotations(): Promise<void> {
        if (!this.annotationsExist()) {
            vscode.window.showInformationMessage('GMod annotations are not installed');
            return;
        }

        const action = await vscode.window.showWarningMessage(
            'Remove GMod annotations? They will be re-downloaded on next start if auto-load is enabled.',
            'Remove',
            'Cancel'
        );

        if (action !== 'Remove') {
            return;
        }

        try {
            fs.rmSync(this.annotationsPath, { recursive: true, force: true });
            vscode.window.showInformationMessage('GMod annotations removed');

            // Suggest restarting
            const restartAction = await vscode.window.showInformationMessage(
                'Restart language server to apply changes?',
                'Restart',
                'Later'
            );

            if (restartAction === 'Restart') {
                await vscode.commands.executeCommand('gluals.restartServer');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to remove annotations: ${errorMessage}`);
        }
    }
}
