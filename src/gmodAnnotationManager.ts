import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { spawn } from 'child_process';

/**
 * Manages Garry's Mod GLuaLS annotations
 * Handles downloading and updating from the gluals-annotations branch
 */
export class GmodAnnotationManager {
    private readonly REPO_URL = 'https://github.com/Pollux12/gmod-luals-addon.git';
    private readonly BRANCH = 'gluals-annotations';
    private readonly REMOTE_METADATA_URL = 'https://raw.githubusercontent.com/Pollux12/gmod-luals-addon/gluals-annotations/__metadata.json';
    private readonly UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
    private readonly UPDATE_CHECK_STATE_KEY = 'gmodAnnotations.lastUpdateCheck';
    private readonly context: vscode.ExtensionContext;
    private readonly annotationsPath: string;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        // Store annotations in extension's global storage
        this.annotationsPath = path.join(
            context.globalStorageUri.fsPath,
            'gmod-annotations'
        );
    }

    /**
     * Run a git command with all I/O piped (no terminal windows).
     * Rejects with a message that includes captured stderr on failure.
     */
    private runGit(args: string[], cwd?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn('git', args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
                windowsHide: true,
            });

            let stderr = '';
            proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

            proc.on('error', reject);
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    const detail = stderr.trim();
                    reject(new Error(
                        `git ${args.join(' ')} failed with exit code ${code}` +
                        (detail ? `\n${detail}` : '')
                    ));
                }
            });
        });
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
        return fs.existsSync(this.annotationsPath) && fs.existsSync(path.join(this.annotationsPath, '.git'));
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
            return;
        }

        console.log('GMod annotations not found, downloading...');
        await this.downloadAnnotations();
    }

    /**
     * Fetch JSON from a URL using Node's https module with a timeout.
     * Returns undefined on any error (network failure, bad status, parse error).
     */
    private fetchJson<T>(url: string, timeoutMs: number): Promise<T | undefined> {
        return new Promise((resolve) => {
            const req = https.get(url, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(undefined);
                    return;
                }
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data) as T);
                    } catch {
                        resolve(undefined);
                    }
                });
            });
            req.setTimeout(timeoutMs, () => { req.destroy(); resolve(undefined); });
            req.on('error', () => resolve(undefined));
        });
    }

    /**
     * Check if a newer version of annotations is available on the remote branch.
     * Rate-limited to once per 24 hours. Runs as a background task.
     */
    private async checkForUpdates(): Promise<void> {
        const lastCheck = this.context.globalState.get<number>(this.UPDATE_CHECK_STATE_KEY, 0);
        if (Date.now() - lastCheck < this.UPDATE_CHECK_INTERVAL_MS) {
            return;
        }

        // Update the timestamp before the network call so concurrent activations don't all fire
        await this.context.globalState.update(this.UPDATE_CHECK_STATE_KEY, Date.now());

        try {
            const localMetadataPath = path.join(this.annotationsPath, '__metadata.json');
            if (!fs.existsSync(localMetadataPath)) {
                return;
            }

            const localMetadata = JSON.parse(
                fs.readFileSync(localMetadataPath, 'utf-8')
            ) as { lastUpdate?: string };

            const remoteMetadata = await this.fetchJson<{ lastUpdate?: string }>(
                this.REMOTE_METADATA_URL,
                10_000
            );
            if (!remoteMetadata) {
                return;
            }

            if (!localMetadata.lastUpdate || !remoteMetadata.lastUpdate) {
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

                    await this.runGit(['clone', '--depth', '1', '--branch', this.BRANCH, this.REPO_URL, this.annotationsPath]);

                    progress.report({ message: 'Download complete!' });
                }
            );

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

                    // For a shallow clone, fetch the latest then hard-reset to it.
                    // fetch+checkout+pull --ff-only fails on shallow repos (exit 128).
                    await this.runGit(['fetch', '--depth', '1', 'origin', this.BRANCH], this.annotationsPath);
                    await this.runGit(['reset', '--hard', `origin/${this.BRANCH}`], this.annotationsPath);

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
