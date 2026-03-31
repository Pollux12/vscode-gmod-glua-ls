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
    private readonly MIN_UPDATE_CHECK_INTERVAL_MINUTES = 5;
    private readonly MAX_UPDATE_CHECK_INTERVAL_MINUTES = 1440;
    private updateCheckInterval: NodeJS.Timeout | undefined;
    private readonly context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        // Store annotations in extension's global storage
        this.annotationsPath = path.join(
            context.globalStorageUri.fsPath,
            'gmod-annotations'
        );
    }

    /**
     * Get the path to annotations (only if enabled and available)
     */
    public getAnnotationsPath(): string | undefined {
        const config = vscode.workspace.getConfiguration('gluals');
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

        if (!enabled) {
            console.log('GMod annotations auto-load is disabled');
            return;
        }

        if (this.annotationsExist()) {
            console.log('GMod annotations already exist at', this.annotationsPath);
            // Fire-and-forget: check for updates in the background without blocking startup
            void this.checkForUpdates();
            // Start periodic update checks
            this.startPeriodicUpdateChecks();
            return;
        }

        console.log('GMod annotations not found, downloading...');
        await this.downloadAnnotations();
        // Start periodic update checks after initial download
        this.startPeriodicUpdateChecks();
    }

    /**
     * Start periodic background checks for annotation updates (once per hour by default)
     */
    private startPeriodicUpdateChecks(): void {
        // Clear any existing interval
        this.stopPeriodicUpdateChecks();

        const config = vscode.workspace.getConfiguration('gluals');
        const autoCheckEnabled = config.get<boolean>('gmod.autoCheckAnnotationUpdates', true);
        
        if (!autoCheckEnabled) {
            console.log('[GLuaLS] Annotation auto-update checks are disabled');
            return;
        }

        const configuredMinutes = config.get<number>('gmod.annotationUpdateCheckIntervalMinutes', 60);
        const normalizedMinutes = Number.isFinite(configuredMinutes)
            ? Math.min(this.MAX_UPDATE_CHECK_INTERVAL_MINUTES, Math.max(this.MIN_UPDATE_CHECK_INTERVAL_MINUTES, Math.floor(configuredMinutes)))
            : 60;
        const checkIntervalMs = normalizedMinutes * 60 * 1000;

        console.log(`[GLuaLS] Starting periodic annotation update checks every ${normalizedMinutes} minutes`);
        
        this.updateCheckInterval = setInterval(() => {
            void this.checkForUpdates();
        }, checkIntervalMs);

        // Register for cleanup when extension deactivates
        this.context.subscriptions.push({
            dispose: () => this.stopPeriodicUpdateChecks()
        });
    }

    /**
     * Stop periodic update checks
     */
    private stopPeriodicUpdateChecks(): void {
        if (this.updateCheckInterval) {
            clearInterval(this.updateCheckInterval);
            this.updateCheckInterval = undefined;
        }
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        this.stopPeriodicUpdateChecks();
    }

    /**
     * Check if a newer version of annotations is available on the remote branch.
     * Runs as a background task.
     */
    private async checkForUpdates(): Promise<void> {

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
