import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fetchJson, downloadAndExtractZip } from './netHelpers';

/**
 * Manages Garry's Mod GLuaLS annotations
 * Handles downloading and updating from the gluals-annotations branch
 */
export class GmodAnnotationManager implements vscode.Disposable {
    private readonly ZIP_URL = 'https://github.com/Pollux12/gmod-luals-addon/archive/refs/heads/gluals-annotations.zip';
    private readonly ZIP_INNER_FOLDER = 'gmod-luals-addon-gluals-annotations';
    private readonly REMOTE_METADATA_URL = 'https://raw.githubusercontent.com/Pollux12/gmod-luals-addon/gluals-annotations/__metadata.json';
    private readonly annotationsPath: string;

    constructor(context: vscode.ExtensionContext) {
        // Store annotations in extension's global storage
        this.annotationsPath = path.join(
            context.globalStorageUri.fsPath,
            'gmod-annotations'
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
