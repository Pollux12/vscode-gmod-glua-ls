import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fetchJson, downloadAndExtractZip } from './netHelpers';
import { getExtensionChannel } from './extensionChannel';
import {
    AnnotationChannel,
    AnnotationSource,
    AnnotationSourceConfig,
    buildAnnotationSourceWarning,
    describeAnnotationSource,
    getChannelBranch,
    normalizeAnnotationChannel,
    normalizeBranch,
    normalizeCommit,
    normalizeGitHubRepository,
    resolveAnnotationSource,
} from './gmodAnnotationSource';

const DEFAULT_ANNOTATION_REPOSITORY = 'Pollux12/annotations-gmod-glua-ls';

type AnnotationMetadata = {
    lastUpdate?: string;
    glualsAnnotationSource?: string;
};

/**
 * Manages Garry's Mod GLuaLS annotations.
 */
export class GmodAnnotationManager implements vscode.Disposable {
    private readonly annotationsPath: string;
    private warnedAboutAdvancedSource = false;

    constructor(context: vscode.ExtensionContext) {
        this.annotationsPath = path.join(context.globalStorageUri.fsPath, 'gmod-annotations');
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

    private getExplicitConfiguredString(section: string): string | undefined {
        const inspect = vscode.workspace.getConfiguration('gluals').inspect<unknown>(section);
        const value = inspect?.workspaceFolderValue
            ?? inspect?.workspaceValue
            ?? inspect?.globalValue
            ?? inspect?.workspaceFolderLanguageValue
            ?? inspect?.workspaceLanguageValue
            ?? inspect?.globalLanguageValue
            ?? inspect?.defaultLanguageValue;

        if (typeof value !== 'string') {
            return undefined;
        }

        const normalized = value.trim();
        return normalized.length > 0 ? normalized : undefined;
    }

    private getAnnotationSourceConfig(): AnnotationSourceConfig {
        const configuredRepository = this.getConfiguredString('gmod.annotationsRepository', DEFAULT_ANNOTATION_REPOSITORY);
        const repository = normalizeGitHubRepository(configuredRepository, DEFAULT_ANNOTATION_REPOSITORY);

        const buildChannel = getExtensionChannel();
        const configuredChannel = this.getConfiguredString('gmod.annotationsChannel', 'auto');
        const channel = normalizeAnnotationChannel(configuredChannel) as AnnotationChannel;
        if (configuredChannel !== channel) {
            console.warn(`[GLuaLS] Invalid annotations channel setting '${configuredChannel}', falling back to auto`);
        }

        const defaultBranch = getChannelBranch(channel === 'auto' ? buildChannel : channel);

        const explicitBranch = this.getExplicitConfiguredString('gmod.annotationsBranch');
        const configuredBranch = explicitBranch ?? this.getConfiguredString('gmod.annotationsBranch', defaultBranch);
        const branch = normalizeBranch(configuredBranch, defaultBranch);
        const sanitizedBranchInput = configuredBranch.replace(/^refs\/heads\//i, '').replace(/^\/+|\/+$/g, '');
        if (configuredBranch.length > 0 && branch === defaultBranch && sanitizedBranchInput !== defaultBranch) {
            console.warn(`[GLuaLS] Invalid annotations branch setting '${configuredBranch}', falling back to ${defaultBranch}`);
        }

        const configuredCommit = this.getExplicitConfiguredString('gmod.annotationsCommit') ?? '';
        const commit = normalizeCommit(configuredCommit);
        if (configuredCommit && !commit) {
            console.warn(`[GLuaLS] Invalid annotations commit setting '${configuredCommit}', ignoring commit pin`);
        }

        return {
            repository,
            buildChannel,
            channel,
            hasExplicitBranch: typeof explicitBranch === 'string' && explicitBranch.length > 0,
            branch,
            commit,
        };
    }

    private getAnnotationSource(): AnnotationSource {
        return resolveAnnotationSource(this.getAnnotationSourceConfig());
    }

    private logResolvedSource(context: string, source: AnnotationSource): void {
        console.log(`[GLuaLS] ${context}: ${describeAnnotationSource(source)}`);
    }

    private maybeWarnAboutAdvancedSource(source: AnnotationSource): void {
        if (this.warnedAboutAdvancedSource) {
            return;
        }

        const warning = buildAnnotationSourceWarning(this.getAnnotationSourceConfig(), source);
        if (!warning) {
            return;
        }

        this.warnedAboutAdvancedSource = true;
        console.warn(`[GLuaLS] ${warning}`);
        void vscode.window.showWarningMessage(warning);
    }

    private isAccessibleDirectory(dirPath: string): boolean {
        try {
            return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
        } catch {
            return false;
        }
    }

    public getAnnotationsPath(): string | undefined {
        const config = vscode.workspace.getConfiguration('gluals');
        const overridePath = this.getAnnotationPathOverride();
        if (overridePath) {
            if (this.isAccessibleDirectory(overridePath)) {
                return overridePath;
            }

            console.warn(`[GLuaLS] Configured annotation override path is invalid, inaccessible, or not a directory: ${overridePath}`);
            return undefined;
        }

        if (!config.get<boolean>('gmod.autoLoadAnnotations', true)) {
            return undefined;
        }

        if (!this.annotationsExist()) {
            return undefined;
        }

        const source = this.getAnnotationSource();
        if (this.isCurrentAnnotationSource(this.readLocalMetadata(), source)) {
            this.logResolvedSource('Using managed annotations source', source);
            return this.annotationsPath;
        }

        console.warn('[GLuaLS] Ignoring managed annotations from a different source until they are refreshed');
        return undefined;
    }

    public getAnnotationVersion(): string | undefined {
        const annotationsPath = this.getAnnotationsPath();
        if (!annotationsPath) {
            return undefined;
        }

        return this.readMetadata(annotationsPath)?.lastUpdate;
    }

    private annotationsExist(): boolean {
        return fs.existsSync(this.annotationsPath) && fs.existsSync(path.join(this.annotationsPath, '__metadata.json'));
    }

    private readLocalMetadata(): AnnotationMetadata | undefined {
        return this.readMetadata(this.annotationsPath);
    }

    private readMetadata(annotationsPath: string): AnnotationMetadata | undefined {
        const metadataPath = path.join(annotationsPath, '__metadata.json');
        if (!fs.existsSync(metadataPath)) {
            return undefined;
        }

        try {
            return JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as AnnotationMetadata;
        } catch {
            return undefined;
        }
    }

    private isCurrentAnnotationSource(metadata: AnnotationMetadata | undefined, source = this.getAnnotationSource()): boolean {
        return metadata?.glualsAnnotationSource === source.sourceId;
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

    public async initializeAnnotations(): Promise<void> {
        const config = vscode.workspace.getConfiguration('gluals');
        const enabled = config.get<boolean>('gmod.autoLoadAnnotations', true);
        const overridePath = this.getAnnotationPathOverride();

        if (overridePath) {
            console.log(`[GLuaLS] Using custom annotation path override: ${overridePath}`);
            if (!this.isAccessibleDirectory(overridePath)) {
                vscode.window.showWarningMessage(`Configured annotation path is invalid, inaccessible, or not a directory: ${overridePath}`);
            }
            return;
        }

        if (!enabled) {
            console.log('GMod annotations auto-load is disabled');
            return;
        }

        const source = this.getAnnotationSource();
        this.logResolvedSource('Resolved managed annotations source', source);
        this.maybeWarnAboutAdvancedSource(source);

        if (this.annotationsExist() && this.isCurrentAnnotationSource(this.readLocalMetadata(), source)) {
            console.log(`[GLuaLS] GMod annotations already exist at ${this.annotationsPath} (${describeAnnotationSource(source)})`);
            return;
        }

        console.log(`[GLuaLS] GMod annotations not found or from a different source, downloading ${describeAnnotationSource(source)}...`);
        await this.downloadAnnotations();
    }

    public dispose(): void {
    }

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
            if (!source.autoUpdates) {
                return;
            }

            const remoteMetadata = await fetchJson<{ lastUpdate?: string }>(source.metadataUrl, { timeoutMs: 10000 });
            if (!remoteMetadata?.lastUpdate) {
                return;
            }

            const needsSourceRefresh = !this.isCurrentAnnotationSource(localMetadata, source);
            if (!localMetadata.lastUpdate && !needsSourceRefresh) {
                return;
            }

            const hasRemoteUpdate = localMetadata.lastUpdate
                ? new Date(remoteMetadata.lastUpdate) > new Date(localMetadata.lastUpdate)
                : false;

            if (needsSourceRefresh || hasRemoteUpdate) {
                const action = await vscode.window.showInformationMessage(
                    `GMod GLuaLS annotations update available for ${describeAnnotationSource(source)}.`,
                    'Update Now',
                    'Later'
                );
                if (action === 'Update Now') {
                    await this.updateAnnotations();
                }
            }
        } catch {
            // Silently ignore network failures or parse errors — this is best-effort.
        }
    }

    private async downloadAnnotationsZip(): Promise<void> {
        const source = this.getAnnotationSource();
        this.logResolvedSource('Downloading annotations source', source);
        console.log(`Downloading annotations zip from ${source.zipUrl}...`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Downloading GMod annotations...',
                cancellable: false,
            },
            async (progress) => {
                await downloadAndExtractZip(source.zipUrl, this.annotationsPath, progress);
                this.markCurrentAnnotationSource(source.sourceId);
                progress.report({ message: 'Download complete!' });
            }
        );
    }

    private async downloadAnnotations(): Promise<void> {
        try {
            const source = this.getAnnotationSource();
            await this.downloadAnnotationsZip();
            console.log(`[GLuaLS] GMod annotations downloaded successfully from ${describeAnnotationSource(source)}`);
            vscode.window.showInformationMessage(`GMod GLuaLS annotations downloaded successfully (${describeAnnotationSource(source)})`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to download GMod annotations:', errorMessage);
            vscode.window.showErrorMessage(
                `Failed to download GMod annotations: ${errorMessage}. `
                + 'You can disable auto-loading in settings (gluals.gmod.autoLoadAnnotations).'
            );
        }
    }

    public async updateAnnotations(): Promise<void> {
        try {
            const source = this.getAnnotationSource();
            await this.downloadAnnotationsZip();
            console.log(`[GLuaLS] GMod annotations updated successfully from ${describeAnnotationSource(source)}`);
            vscode.window.showInformationMessage(`GMod GLuaLS annotations updated successfully (${describeAnnotationSource(source)})`);

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
