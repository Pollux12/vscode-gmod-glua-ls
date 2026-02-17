import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';

/**
 * Manages Garry's Mod EmmyLua annotations
 * Handles downloading and updating from the emmylua-annotations branch
 */
export class GmodAnnotationManager {
    private readonly REPO_URL = 'https://github.com/Pollux12/gmod-luals-addon.git';
    private readonly BRANCH = 'emmylua-annotations';
    private readonly annotationsPath: string;

    constructor(context: vscode.ExtensionContext) {
        // Store annotations in extension's global storage
        this.annotationsPath = path.join(
            context.globalStorageUri.fsPath,
            'gmod-annotations'
        );
    }

    private runGit(args: string[], cwd?: string): void {
        const result = spawnSync('git', args, {
            cwd,
            stdio: 'inherit',
            shell: false,
        });

        if (result.error) {
            throw result.error;
        }

        if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed with exit code ${result.status}`);
        }
    }

    /**
     * Get the path to annotations (only if enabled and available)
     */
    public getAnnotationsPath(): string | undefined {
        const config = vscode.workspace.getConfiguration('emmylua');
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
        return fs.existsSync(this.annotationsPath) && fs.existsSync(path.join(this.annotationsPath, '.git'));
    }

    /**
     * Initialize annotations - download if needed
     */
    public async initializeAnnotations(): Promise<void> {
        const config = vscode.workspace.getConfiguration('emmylua');
        const enabled = config.get<boolean>('gmod.autoLoadAnnotations', true);

        if (!enabled) {
            console.log('GMod annotations auto-load is disabled');
            return;
        }

        if (this.annotationsExist()) {
            console.log('GMod annotations already exist at', this.annotationsPath);
            // Could optionally check for updates here
            return;
        }

        console.log('GMod annotations not found, downloading...');
        await this.downloadAnnotations();
    }

    /**
     * Download annotations from git repository
     */
    private async downloadAnnotations(): Promise<void> {
        try {
            // Ensure parent directory exists
            const parentDir = path.dirname(this.annotationsPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            // Clone the specific branch
            console.log(`Cloning ${this.BRANCH} branch from ${this.REPO_URL}...`);
            
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Downloading GMod annotations...',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Cloning repository...' });

                    if (fs.existsSync(this.annotationsPath)) {
                        fs.rmSync(this.annotationsPath, { recursive: true, force: true });
                    }

                    this.runGit(['clone', '--depth', '1', '--branch', this.BRANCH, this.REPO_URL, this.annotationsPath]);

                    progress.report({ message: 'Download complete!' });
                }
            );

            console.log('GMod annotations downloaded successfully');
            vscode.window.showInformationMessage('GMod EmmyLua annotations downloaded successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to download GMod annotations:', errorMessage);
            vscode.window.showErrorMessage(
                `Failed to download GMod annotations: ${errorMessage}. ` +
                `You can disable auto-loading in settings (emmylua.gmod.autoLoadAnnotations).`
            );
        }
    }

    /**
     * Update annotations to latest version
     */
    public async updateAnnotations(): Promise<void> {
        if (!this.annotationsExist()) {
            await this.downloadAnnotations();
            return;
        }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Updating GMod annotations...',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Fetching updates...' });

                    this.runGit(['fetch', 'origin'], this.annotationsPath);
                    this.runGit(['checkout', this.BRANCH], this.annotationsPath);
                    this.runGit(['pull', '--ff-only', 'origin', this.BRANCH], this.annotationsPath);

                    progress.report({ message: 'Update complete!' });
                }
            );

            vscode.window.showInformationMessage('GMod annotations updated successfully');
            
            // Suggest restarting the language server
            const action = await vscode.window.showInformationMessage(
                'Annotations updated. Restart language server to apply changes?',
                'Restart',
                'Later'
            );
            
            if (action === 'Restart') {
                await vscode.commands.executeCommand('emmy.restartServer');
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
                await vscode.commands.executeCommand('emmy.restartServer');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to remove annotations: ${errorMessage}`);
        }
    }
}
