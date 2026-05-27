import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fetchJson, downloadAndExtractZip } from './netHelpers';

const DEFAULT_ANNOTATION_REPOSITORY = 'Pollux12/annotations-gmod-glua-ls';
const DEFAULT_ANNOTATION_BRANCH = 'gluals-annotations';

type AnnotationSource = {
    repository: string;
    branch: string;
    sourceId: string;
    zipUrl: string;
    zipInnerFolder: string;
    metadataUrl: string;
};

type AnnotationMetadata = {
    lastUpdate?: string;
    glualsAnnotationSource?: string;
};

function encodeGitHubRefPath(ref: string): string {
    return ref.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Manages Garry's Mod GLuaLS annotations
 * Handles downloading and updating from the gluals-annotations branch
 */
export class GmodAnnotationManager implements vscode.Disposable {
    private readonly annotationsPath: string;

    constructor(context: vscode.ExtensionContext) {
        // Store annotations in extension's global storage
        this.annotationsPath = path.join(
            context.globalStorageUri.fsPath,
            'gmod-annotations'
        );
    }

    private getAnnotationPathOverride(): string | undefined {
        const configuredPath = vscode.workspace.getConfiguration('gluals').get<unknown>('ls.annotationPath');
        if (typeof configuredPath !== 'string') {
            return undefined;
        }

        const normalizedPath = configuredPath.trim();
        return normalizedPath.length > 0 ? normalizedPath : undefined;
    }

    private getConfiguredString(section: string, defaultValue: string): string {
        const configuredValue = vscode.workspace.getConfiguration('gluals').get<unknown>(section, defaultValue);
        if (typeof configuredValue !== 'string') {
            console.warn(`[GLuaLS] Invalid ${section} setting value, falling back to ${defaultValue}`);
            return defaultValue;
        }

        const normalizedValue = configuredValue.trim();
        return normalizedValue.length > 0 ? normalizedValue : defaultValue;
    }

    private getAnnotationRepository(): string {
        const configuredRepository = this.getConfiguredString('gmod.annotationsRepository', DEFAULT_ANNOTATION_REPOSITORY);
        let repository = configuredRepository
            .replace(/^https?:\/\/github\.com\//i, '')
            .replace(/^github\.com\//i, '')
            .replace(/^git@github\.com:/i, '')
            .replace(/\/tree\/.*$/i, '')
            .replace(/\/+$/g, '')
            .replace(/\.git$/i, '');

        const parts = repository.split('/').filter(Boolean);
        if (parts.length >= 2) {
            repository = `${parts[0]}/${parts[1]}`;
        }

        if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
            return repository;
        }

        console.warn(`[GLuaLS] Invalid annotations repository setting '${configuredRepository}', falling back to ${DEFAULT_ANNOTATION_REPOSITORY}`);
        return DEFAULT_ANNOTATION_REPOSITORY;
    }

    private getAnnotationBranch(): string {
        const configuredBranch = this.getConfiguredString('gmod.annotationsBranch', DEFAULT_ANNOTATION_BRANCH);
        const branch = configuredBranch.replace(/^refs\/heads\//i, '').replace(/^\/+|\/+$/g, '');

        if (branch.length > 0 && /^[^\s\\]+$/.test(branch) && !branch.startsWith('gluals-annotations-plugin-')) {
            return branch;
        }

        console.warn(`[GLuaLS] Invalid annotations branch setting '${configuredBranch}', falling back to ${DEFAULT_ANNOTATION_BRANCH}`);
        return DEFAULT_ANNOTATION_BRANCH;
    }

    private getAnnotationSource(): AnnotationSource {
        const repository = this.getAnnotationRepository();
        const branch = this.getAnnotationBranch();
        const repositoryName = repository.split('/').pop() ?? repository;
        const branchFolderName = branch.replace(/[\\/]/g, '-');
        const encodedBranchPath = encodeGitHubRefPath(branch);

        return {
            repository,
            branch,
            sourceId: `${repository}:${branch}`,
            zipUrl: `https://github.com/${repository}/archive/refs/heads/${encodedBranchPath}.zip`,
            zipInnerFolder: `${repositoryName}-${branchFolderName}`,
            metadataUrl: `https://raw.githubusercontent.com/${repository}/${encodedBranchPath}/__metadata.json`,
        };
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

        if (!this.annotationsExist()) {
            return undefined;
        }

        if (this.isCurrentAnnotationSource(this.readLocalMetadata())) {
            return this.annotationsPath;
        }

        console.warn('[GLuaLS] Ignoring managed annotations from a different source until they are refreshed');
        return undefined;
    }

    /**
     * Check if annotations are already downloaded
     */
    private annotationsExist(): boolean {
        return fs.existsSync(this.annotationsPath) && fs.existsSync(path.join(this.annotationsPath, '__metadata.json'));
    }

    private readLocalMetadata(): AnnotationMetadata | undefined {
        const localMetadataPath = path.join(this.annotationsPath, '__metadata.json');
        if (!fs.existsSync(localMetadataPath)) {
            return undefined;
        }

        try {
            return JSON.parse(fs.readFileSync(localMetadataPath, 'utf-8')) as AnnotationMetadata;
        } catch {
            return undefined;
        }
    }

    private isCurrentAnnotationSource(metadata: AnnotationMetadata | undefined): boolean {
        return metadata?.glualsAnnotationSource === this.getAnnotationSource().sourceId;
    }

    private markCurrentAnnotationSource(sourceId: string): void {
        const metadata = this.readLocalMetadata();
        if (!metadata) {
            console.warn('[GLuaLS] Downloaded annotations archive did not include a valid __metadata.json; writing source metadata only');
        }

        const nextMetadata: AnnotationMetadata = {
            ...(metadata ?? {}),
            glualsAnnotationSource: sourceId,
        };
        fs.writeFileSync(path.join(this.annotationsPath, '__metadata.json'), JSON.stringify(nextMetadata, null, 2));
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

        if (this.annotationsExist() && this.isCurrentAnnotationSource(this.readLocalMetadata())) {
            console.log('GMod annotations already exist at', this.annotationsPath);
            return;
        }

        console.log('GMod annotations not found or from an old source, downloading...');
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
            const config = vscode.workspace.getConfiguration('gluals');
            if (this.getAnnotationPathOverride() || !config.get<boolean>('gmod.autoLoadAnnotations', true)) {
                return;
            }

            const localMetadata = this.readLocalMetadata();
            if (!localMetadata) {
                return;
            }

            const source = this.getAnnotationSource();
            const remoteMetadata = await fetchJson<{ lastUpdate?: string }>(source.metadataUrl, { timeoutMs: 10000 });
            if (!remoteMetadata || !remoteMetadata.lastUpdate) {
                return;
            }

            const needsSourceRefresh = !this.isCurrentAnnotationSource(localMetadata);
            if (!localMetadata.lastUpdate && !needsSourceRefresh) {
                return;
            }

            const hasRemoteUpdate = localMetadata.lastUpdate
                ? new Date(remoteMetadata.lastUpdate) > new Date(localMetadata.lastUpdate)
                : false;

            if (needsSourceRefresh || hasRemoteUpdate) {
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
        const source = this.getAnnotationSource();
        console.log(`Downloading annotations zip from ${source.zipUrl}...`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Downloading GMod annotations...',
                cancellable: false,
            },
            async (progress) => {
                await downloadAndExtractZip(source.zipUrl, this.annotationsPath, source.zipInnerFolder, progress);
                this.markCurrentAnnotationSource(source.sourceId);
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
