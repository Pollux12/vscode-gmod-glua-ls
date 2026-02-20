import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    downloadFile,
    fetchLatestRelease,
    GmRdbRelease,
    promptForGarrysmodPath,
    ReleaseAsset,
} from './GmodDebugSetupWizard';

export const EXPECTED_GM_RDB_VERSION = '1.2.0';

interface VersionCheckResult {
    readonly moduleVersion: string;
    readonly expectedVersion: string;
    readonly isMatch: boolean;
}

export class GmodRdbUpdater {
    private readonly UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
    private readonly LAST_PROMPT_STATE_KEY = 'gmodRdbUpdater.lastPromptAt';
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

        if (this.isPromptRateLimited()) {
            return;
        }

        await this.promptForUpdate(check.moduleVersion);
    }

    public async runManualUpdateCommand(): Promise<void> {
        const action = await vscode.window.showInformationMessage(
            `Check and install gm_rdb ${EXPECTED_GM_RDB_VERSION} from GitHub releases?`,
            'Update Now',
            'Cancel'
        );

        if (action !== 'Update Now') {
            return;
        }

        await this.runUpdateFlow();
    }

    public async promptForUpdate(moduleVersion: string): Promise<void> {
        await this.context.globalState.update(this.LAST_PROMPT_STATE_KEY, Date.now());

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
                    progress.report({ message: 'Fetching latest gm_rdb release...' });
                    const release = await fetchLatestRelease();
                    if (!release) {
                        throw new Error('Failed to fetch gm_rdb release metadata.');
                    }

                    const asset = this.findAssetForCurrentPlatform(release);
                    if (!asset) {
                        const available = release.assets.map((entry) => entry.name).join(', ') || '(none)';
                        throw new Error(`No compatible gm_rdb server binary found for ${os.platform()} (${os.arch()}). Available assets: ${available}`);
                    }

                    progress.report({ message: `Downloading ${asset.name} (${release.tag_name})...` });
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gmrdb-'));
                    const tempFilePath = path.join(tempDir, asset.name);
                    const destinationPath = path.join(binDir, asset.name);

                    try {
                        await downloadFile(asset.browser_download_url, tempFilePath);
                        await fs.promises.mkdir(binDir, { recursive: true });
                        await fs.promises.copyFile(tempFilePath, destinationPath);
                    } finally {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }

                    progress.report({ message: `Installed ${asset.name} to garrysmod/lua/bin.` });
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

    private isPromptRateLimited(): boolean {
        const lastPrompt = this.context.globalState.get<number>(this.LAST_PROMPT_STATE_KEY, 0);
        return Date.now() - lastPrompt < this.UPDATE_CHECK_INTERVAL_MS;
    }

    private isSkippedExpectedVersion(): boolean {
        const skippedVersion = this.context.globalState.get<string>(this.SKIP_EXPECTED_VERSION_KEY);
        return skippedVersion === EXPECTED_GM_RDB_VERSION;
    }
}
