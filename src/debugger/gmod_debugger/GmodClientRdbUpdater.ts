import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { downloadFile } from '../../netHelpers';
import {
    ALL_RDB_CLIENT_DLLS,
    fetchReleaseForCurrentExtensionChannel,
    isGarrysmodX64,
    GmRdbRelease,
    promptForClientGarrysmodPath,
    ReleaseAsset,
    validateClientInstallPath,
} from './GmodDebugSetupWizard';
import { EXPECTED_GM_RDB_VERSION } from './GmodRdbUpdater';

export class GmodClientRdbUpdater {
    private readonly SKIP_EXPECTED_VERSION_KEY = 'gmodRdbClientUpdater.skipExpectedVersion';

    private activeUpdate: Promise<void> | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
    }

    public async handleVersionMismatch(moduleVersion: string): Promise<void> {
        const normalized = moduleVersion.trim();
        if (normalized === EXPECTED_GM_RDB_VERSION) {
            return;
        }

        if (!this.shouldAutoPrompt()) {
            return;
        }

        if (this.isSkippedExpectedVersion()) {
            return;
        }

        await this.promptForUpdate(normalized);
    }

    public async runManualUpdateCommand(): Promise<void> {
        const action = await vscode.window.showInformationMessage(
            `Check and install rdb_client ${EXPECTED_GM_RDB_VERSION} and refresh GLuaLS runtime files?`,
            'Update Now',
            'Cancel'
        );

        if (action !== 'Update Now') {
            return;
        }

        await this.runUpdateFlow();
    }

    public async ensureRuntimeFilesUpToDate(session?: vscode.DebugSession): Promise<void> {
        // Client installs must not write server runtime files.
        void session;
    }

    public async promptForUpdate(moduleVersion: string): Promise<void> {
        const action = await vscode.window.showInformationMessage(
            `rdb_client module version mismatch detected (connected: ${moduleVersion}, expected: ${EXPECTED_GM_RDB_VERSION}).`,
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
        const garrysmodPath = await promptForClientGarrysmodPath(this.context);
        if (!garrysmodPath) {
            return;
        }

        await this.downloadAndInstall(this.context, garrysmodPath);
    }

    private async downloadAndInstallInternal(_context: vscode.ExtensionContext, garrysmodPath: string): Promise<void> {
        let installGarrysmodPath = garrysmodPath;
        while (true) {
            const validation = validateClientInstallPath(installGarrysmodPath);
            if (validation.warnings.length === 0) {
                break;
            }

            const action = await vscode.window.showWarningMessage(
                `This path may not be a valid Garry's Mod client install:\n- ${validation.warnings.join('\n- ')}`,
                'Choose Different Path',
                'Use Anyway',
                'Cancel Install'
            );

            if (action === 'Choose Different Path') {
                const replacement = await promptForClientGarrysmodPath(this.context);
                if (!replacement) {
                    return;
                }
                installGarrysmodPath = replacement;
                continue;
            }

            if (action !== 'Use Anyway') {
                return;
            }

            break;
        }

        const binDir = path.join(installGarrysmodPath, 'lua', 'bin');

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Updating rdb_client...',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Fetching rdb_client release for current extension channel...' });
                    const release = await fetchReleaseForCurrentExtensionChannel();
                    if (!release) {
                        throw new Error('Failed to fetch rdb_client release metadata.');
                    }

                    const asset = this.findAssetForUpdate(release, installGarrysmodPath);
                    if (!asset) {
                        const available = release.assets.map((entry) => entry.name).join(', ') || '(none)';
                        throw new Error(`No compatible rdb_client binary found for ${os.platform()} (${os.arch()}). Available assets: ${available}`);
                    }

                    progress.report({ message: `Downloading ${asset.name} (${release.tag_name})...` });
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gmrdb-client-'));
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

                }
            );

            vscode.window.showInformationMessage('rdb_client updated successfully. Restart your GMod client to load the new module.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to update rdb_client: ${message}`);
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
        const isX64 = isGarrysmodX64(garrysmodPath);
        const preferredCandidates: string[] = process.platform === 'win32'
            ? [isX64 ? 'gmcl_rdb_win64.dll' : 'gmcl_rdb_win32.dll']
            : process.platform === 'linux'
                ? (isX64
                    ? ['gmcl_rdb_linux64.so', 'gmcl_rdb_linux64.dll']
                    : ['gmcl_rdb_linux.so', 'gmcl_rdb_linux.dll'])
                : [];

        for (const preferred of preferredCandidates) {
            const asset = release.assets.find((entry) => entry.name === preferred);
            if (asset) {
                return asset;
            }
        }

        return this.findAssetForCurrentPlatform(release);
    }

    private getAssetCandidatesForCurrentPlatform(): string[] {
        if (process.platform === 'win32') {
            return ALL_RDB_CLIENT_DLLS.filter((name) => name.endsWith('.dll') && name.includes('win'));
        }

        if (process.platform === 'linux') {
            return ALL_RDB_CLIENT_DLLS.filter((name) => name.includes('linux'));
        }

        return [];
    }

    private shouldAutoPrompt(): boolean {
        return vscode.workspace
            .getConfiguration('gluals.gmod.debugger')
            .get<boolean>('autoUpdateClientRdb', true);
    }

    private isSkippedExpectedVersion(): boolean {
        const skippedVersion = this.context.globalState.get<string>(this.SKIP_EXPECTED_VERSION_KEY);
        return skippedVersion === EXPECTED_GM_RDB_VERSION;
    }

}
