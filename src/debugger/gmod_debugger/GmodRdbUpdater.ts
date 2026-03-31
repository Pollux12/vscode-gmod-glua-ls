import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { downloadFile } from '../../netHelpers';
import {
    cleanupLegacyInitInjection,
    DEFAULT_RDB_PORT,
    getDllForSrcdsExecutable,
    fetchReleaseForCurrentExtensionChannel,
    getStoredGarrysmodPath,
    GmRdbRelease,
    promptForGarrysmodPath,
    ReleaseAsset,
    syncAutorunFile,
} from './GmodDebugSetupWizard';

export const EXPECTED_GM_RDB_VERSION = '1.2.0';

interface VersionCheckResult {
    readonly moduleVersion: string;
    readonly expectedVersion: string;
    readonly isMatch: boolean;
}

export class GmodRdbUpdater {
    private readonly SKIP_EXPECTED_VERSION_KEY = 'gmodRdbUpdater.skipExpectedVersion';

    private activeUpdate: Promise<void> | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
    }

    public checkVersion(moduleVersion: string): VersionCheckResult {
        const normalized = moduleVersion.trim();
        return {
            moduleVersion: normalized,
            expectedVersion: EXPECTED_GM_RDB_VERSION,
            isMatch: normalized === EXPECTED_GM_RDB_VERSION,
        };
    }

    public async handleVersionMismatch(moduleVersion: string): Promise<void> {
        const check = this.checkVersion(moduleVersion);
        if (check.isMatch) {
            return;
        }

        if (!this.shouldAutoPrompt()) {
            return;
        }

        if (this.isSkippedExpectedVersion()) {
            return;
        }

        await this.promptForUpdate(check.moduleVersion);
    }

    public async runManualUpdateCommand(): Promise<void> {
        const action = await vscode.window.showInformationMessage(
            `Check and install gm_rdb ${EXPECTED_GM_RDB_VERSION} and refresh GLuaLS runtime files?`,
            'Update Now',
            'Cancel'
        );

        if (action !== 'Update Now') {
            return;
        }

        await this.runUpdateFlow();
    }

    public async ensureRuntimeFilesUpToDate(session?: vscode.DebugSession): Promise<void> {
        const garrysmodPath = this.resolveKnownGarrysmodPath(session);
        if (!garrysmodPath) {
            return;
        }

        try {
            const debugPort = this.resolveDebugPort(session?.workspaceFolder);
            const autorunStatus = syncAutorunFile(garrysmodPath, debugPort);
            cleanupLegacyInitInjection(garrysmodPath);

            if (autorunStatus !== 'unchanged') {
                console.log(`[GLuaLS] Updated runtime file: lua/autorun/debug.lua (${autorunStatus}).`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[GLuaLS] Failed to sync runtime files: ${message}`);
        }
    }

    public async promptForUpdate(moduleVersion: string): Promise<void> {
        const action = await vscode.window.showInformationMessage(
            `gm_rdb module version mismatch detected (connected: ${moduleVersion}, expected: ${EXPECTED_GM_RDB_VERSION}).`,
            'Update Now',
            'Later',
            'Skip This Version'
        );

        if (action === 'Update Now') {
            await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, undefined);
            await this.runUpdateFlow();
            return;
        }

        if (action === 'Skip This Version') {
            await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, EXPECTED_GM_RDB_VERSION);
        }
    }

    public async downloadAndInstall(context: vscode.ExtensionContext, garrysmodPath: string): Promise<void> {
        if (this.activeUpdate) {
            await this.activeUpdate;
            return;
        }

        this.activeUpdate = this.downloadAndInstallInternal(context, garrysmodPath);
        try {
            await this.activeUpdate;
        } finally {
            this.activeUpdate = undefined;
        }
    }

    private async runUpdateFlow(): Promise<void> {
        const garrysmodPath = await promptForGarrysmodPath(this.context);
        if (!garrysmodPath) {
            return;
        }

        await this.downloadAndInstall(this.context, garrysmodPath);
    }

    private async downloadAndInstallInternal(_context: vscode.ExtensionContext, garrysmodPath: string): Promise<void> {
        const binDir = path.join(garrysmodPath, 'lua', 'bin');

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Updating gm_rdb...',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Fetching gm_rdb release for current extension channel...' });
                    const release = await fetchReleaseForCurrentExtensionChannel();
                    if (!release) {
                        throw new Error('Failed to fetch gm_rdb release metadata.');
                    }

                    const asset = this.findAssetForUpdate(release, garrysmodPath);
                    if (!asset) {
                        const available = release.assets.map((entry) => entry.name).join(', ') || '(none)';
                        throw new Error(`No compatible gm_rdb server binary found for ${os.platform()} (${os.arch()}). Available assets: ${available}`);
                    }

                    progress.report({ message: `Downloading ${asset.name} (${release.tag_name})...` });
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gmrdb-'));
                    const tempFilePath = path.join(tempDir, asset.name);
                    const destinationPath = path.join(binDir, asset.name);

                    try {
                        await downloadFile(asset.browser_download_url, tempFilePath, progress);

                        progress.report({ message: `Installing ${asset.name}...` });
                        await fs.promises.mkdir(binDir, { recursive: true });
                        await fs.promises.copyFile(tempFilePath, destinationPath);

                        progress.report({ message: 'Update complete!' });
                    } finally {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }

                    progress.report({ message: `Installed ${asset.name} to garrysmod/lua/bin.` });

                    const debugPort = this.resolveDebugPort();

                    progress.report({ message: 'Writing shared debugger autorun file...' });
                    syncAutorunFile(garrysmodPath, debugPort);
                    cleanupLegacyInitInjection(garrysmodPath);
                }
            );

            vscode.window.showInformationMessage('gm_rdb updated successfully. Restart SRCDS to load the new module.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to update gm_rdb: ${message}`);
        }
    }

    private findAssetForCurrentPlatform(release: GmRdbRelease): ReleaseAsset | undefined {
        const candidates = this.getAssetCandidatesForCurrentPlatform();
        for (const name of candidates) {
            const asset = release.assets.find((entry) => entry.name === name);
            if (asset) {
                return asset;
            }
        }

        return undefined;
    }

    private findAssetForUpdate(release: GmRdbRelease, garrysmodPath: string): ReleaseAsset | undefined {
        if (process.platform === 'win32') {
            const binDir = path.join(garrysmodPath, 'lua', 'bin');
            const hasWin64 = fs.existsSync(path.join(binDir, 'gmsv_rdb_win64.dll'));
            const hasWin32 = fs.existsSync(path.join(binDir, 'gmsv_rdb_win32.dll'));

            let installed: string | undefined;
            if (hasWin64 && hasWin32) {
                installed = getDllForSrcdsExecutable(path.dirname(garrysmodPath));
            } else if (hasWin64) {
                installed = 'gmsv_rdb_win64.dll';
            } else if (hasWin32) {
                installed = 'gmsv_rdb_win32.dll';
            }

            if (installed === 'gmsv_rdb_win64.dll' || installed === 'gmsv_rdb_win32.dll') {
                const asset = release.assets.find((entry) => entry.name === installed);
                if (asset) {
                    return asset;
                }
            }
        }

        return this.findAssetForCurrentPlatform(release);
    }

    private getAssetCandidatesForCurrentPlatform(): string[] {
        if (process.platform === 'win32') {
            return ['gmsv_rdb_win64.dll', 'gmsv_rdb_win32.dll'];
        }

        if (process.platform === 'linux') {
            return [
                'gmsv_rdb_linux64.so',
                'gmsv_rdb_linux.so',
                'gmsv_rdb_linux64.dll',
                'gmsv_rdb_linux.dll',
            ];
        }

        return [];
    }

    private shouldAutoPrompt(): boolean {
        return vscode.workspace
            .getConfiguration('gluals.gmod.debugger')
            .get<boolean>('autoUpdateRdb', true);
    }

    private isSkippedExpectedVersion(): boolean {
        const skippedVersion = this.context.globalState.get<string>(this.SKIP_EXPECTED_VERSION_KEY);
        return skippedVersion === EXPECTED_GM_RDB_VERSION;
    }

    private resolveKnownGarrysmodPath(session?: vscode.DebugSession): string | undefined {
        const sourceRoot = this.resolveSessionSourceRoot(session);
        if (sourceRoot) {
            return sourceRoot;
        }

        return getStoredGarrysmodPath(this.context);
    }

    private resolveSessionSourceRoot(session?: vscode.DebugSession): string | undefined {
        if (!session || session.type !== 'gluals_gmod') {
            return undefined;
        }

        const sourceRoot = this.coerceSessionSourceRoot(session);
        if (!sourceRoot || sourceRoot.includes('${')) {
            return undefined;
        }

        const resolved = path.resolve(sourceRoot);
        if (path.basename(resolved).toLowerCase() === 'garrysmod') {
            return resolved;
        }

        const garrysmodCandidate = path.join(resolved, 'garrysmod');
        if (fs.existsSync(garrysmodCandidate)) {
            return garrysmodCandidate;
        }

        return undefined;
    }

    private coerceSessionSourceRoot(session: vscode.DebugSession): string | undefined {
        if (!session.configuration || typeof session.configuration !== 'object') {
            return undefined;
        }

        const sourceRoot = (session.configuration as Record<string, unknown>)['sourceRoot'];
        if (typeof sourceRoot !== 'string') {
            return undefined;
        }

        const trimmed = sourceRoot.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    private resolveDebugPort(scope?: vscode.ConfigurationScope): number {
        const configuredPort = vscode.workspace
            .getConfiguration('gluals.gmod', scope)
            .get<number>('debugPort');
        return typeof configuredPort === 'number' && Number.isFinite(configuredPort)
            ? Math.max(1, Math.floor(configuredPort))
            : DEFAULT_RDB_PORT;
    }
}
