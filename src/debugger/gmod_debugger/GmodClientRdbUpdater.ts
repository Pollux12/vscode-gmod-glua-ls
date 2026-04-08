import * as vscode from 'vscode';
import {
    ALL_RDB_CLIENT_DLLS,
    detectGarrysmodBranchName,
    detectGmRdbClient,
    getStoredClientGarrysmodPath,
    isGarrysmodX64,
    GmRdbRelease,
    promptForClientGarrysmodPath,
    ReleaseAsset,
    validateClientInstallPath,
} from './GmodDebugSetupWizard';
import { EXPECTED_GM_RDB_VERSION } from './GmodRdbUpdater';
import {
    ActiveUpdateState,
    downloadAndInstallRelease,
    ExpectedVersionCacheState,
    findAssetByNameCandidates,
    normalizeComparableVersion,
    recordInstalledModuleState,
    resolveExpectedVersionWithCache,
    resolveInstalledModuleVersion,
    SHARED_EXPECTED_VERSION_STATE,
    runExclusiveUpdate,
} from './GmodRdbUpdaterShared';

export class GmodClientRdbUpdater {
    private static readonly EXPECTED_VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
    private readonly SKIP_EXPECTED_VERSION_KEY = 'gmodRdbClientUpdater.skipExpectedVersion';
    private readonly INSTALLED_STATE_KEY = 'gmodRdbUpdater.client.installedState';

    private readonly updateState: ActiveUpdateState = {
        activeUpdate: undefined,
    };

    private readonly expectedVersionState: ExpectedVersionCacheState = SHARED_EXPECTED_VERSION_STATE;

    constructor(private readonly context: vscode.ExtensionContext) {
    }

    public async handleVersionMismatch(moduleVersion: string): Promise<void> {
        if (!this.shouldAutoPrompt()) {
            return;
        }

        const expectedVersion = await this.resolveExpectedVersion();
        const normalized = this.normalizeVersion(moduleVersion);
        if (normalized === expectedVersion) {
            return;
        }

        if (this.isSkippedExpectedVersion(expectedVersion)) {
            return;
        }

        await this.promptForUpdate(normalized, expectedVersion);
    }

    /**
     * Boot/periodic update check: detects binary presence, compares version against release API.
     * Called by GmodUpdateScheduler. Does not prompt or update if the binary is absent.
     */
    public async runBootTimeCheck(garrysmodPath: string): Promise<void> {
        const detected = detectGmRdbClient(garrysmodPath);
        if (!detected) {
            return;
        }

        if (!this.shouldAutoPrompt()) {
            return;
        }

        const expectedVersion = await this.resolveExpectedVersion();
        if (this.isSkippedExpectedVersion(expectedVersion)) {
            return;
        }

        const installedVersion = await this.resolveInstalledVersion(garrysmodPath, detected);
        if (!installedVersion) {
            return;
        }

        if (this.normalizeVersion(installedVersion) === expectedVersion) {
            return;
        }

        await this.promptForUpdate(installedVersion, expectedVersion);
    }

    public async runManualUpdateCommand(): Promise<void> {
        const garrysmodPath = getStoredClientGarrysmodPath(this.context);
        if (!garrysmodPath) {
            const action = await vscode.window.showInformationMessage(
                'rdb_client: path not configured.',
                'Setup'
            );
            if (action === 'Setup') {
                void vscode.commands.executeCommand('gluals.gmod.configureDebugger');
            }
            return;
        }

        const detected = detectGmRdbClient(garrysmodPath);
        if (!detected) {
            const action = await vscode.window.showInformationMessage(
                'rdb_client not found in the configured path.',
                'Setup'
            );
            if (action === 'Setup') {
                void vscode.commands.executeCommand('gluals.gmod.configureDebugger');
            }
            return;
        }

        const [expectedVersion, installedVersion] = await Promise.all([
            this.resolveExpectedVersion(),
            this.resolveInstalledVersion(garrysmodPath, detected),
        ]);

        if (installedVersion && this.normalizeVersion(installedVersion) === expectedVersion) {
            vscode.window.showInformationMessage(`rdb_client is up to date (${expectedVersion}).`);
            return;
        }

        const versionInfo = installedVersion
            ? `(installed: ${installedVersion}, latest: ${expectedVersion})`
            : `(latest: ${expectedVersion})`;
        const action = await vscode.window.showInformationMessage(
            `rdb_client update available ${versionInfo}.`,
            'Update'
        );
        if (action === 'Update') {
            await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, undefined);
            await this.runUpdateFlow();
        }
    }

    public async ensureRuntimeFilesUpToDate(session?: vscode.DebugSession): Promise<void> {
        void session;
        // Intentionally no-op: debug.lua is server-owned and should only be written
        // to SRCDS garrysmod/lua/autorun so clients receive it via server distribution.
    }

    public async promptForUpdate(moduleVersion: string, expectedVersion: string): Promise<void> {
        const action = await vscode.window.showInformationMessage(
            `rdb_client module version mismatch detected (connected: ${moduleVersion}, expected: ${expectedVersion}).`,
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
            await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, expectedVersion);
        }
    }

    public async downloadAndInstall(context: vscode.ExtensionContext, garrysmodPath: string): Promise<void> {
        void context;
        await runExclusiveUpdate(this.updateState, async () => {
            await this.downloadAndInstallInternal(garrysmodPath);
        });
    }

    private async runUpdateFlow(): Promise<void> {
        const garrysmodPath = await promptForClientGarrysmodPath(this.context);
        if (!garrysmodPath) {
            return;
        }

        await this.downloadAndInstall(this.context, garrysmodPath);
    }

    private async downloadAndInstallInternal(garrysmodPath: string): Promise<void> {
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

        const installedRelease = await downloadAndInstallRelease({
            garrysmodPath: installGarrysmodPath,
            progressTitle: 'Updating rdb_client...',
            fetchProgressMessage: 'Fetching rdb_client release for current extension channel...',
            missingReleaseMessage: 'Failed to fetch rdb_client release metadata.',
            incompatibleBinaryLabel: 'rdb_client',
            tempDirPrefix: 'gluals-gmrdb-client-',
            successMessage: 'rdb_client updated successfully. Restart your GMod client to load the new module.',
            failurePrefix: 'Failed to update rdb_client',
            selectAsset: (release) => this.findAssetForUpdate(release, installGarrysmodPath),
        });

        if (!installedRelease) {
            return;
        }

        await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, undefined);
        await this.recordInstall(installGarrysmodPath, installedRelease);
    }

    private findAssetForCurrentPlatform(release: GmRdbRelease): ReleaseAsset | undefined {
        return findAssetByNameCandidates(release, this.getAssetCandidatesForCurrentPlatform());
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

        const preferredAsset = findAssetByNameCandidates(release, preferredCandidates);
        if (preferredAsset) {
            return preferredAsset;
        }

        // If branch architecture is known, avoid silently falling back to a mismatched binary.
        if (detectGarrysmodBranchName(garrysmodPath)) {
            return undefined;
        }

        return this.findAssetForCurrentPlatform(release);
    }

    private getAssetCandidatesForCurrentPlatform(): string[] {
        if (process.platform === 'win32') {
            return ALL_RDB_CLIENT_DLLS.filter((name) => name.endsWith('.dll') && name.includes('win'));
        }

        if (process.platform === 'linux') {
            return [
                'gmcl_rdb_linux64.so',
                'gmcl_rdb_linux.so',
                ...ALL_RDB_CLIENT_DLLS.filter((name) => name.includes('linux')),
            ];
        }

        return [];
    }

    private shouldAutoPrompt(): boolean {
        return vscode.workspace
            .getConfiguration('gluals.gmod.debugger')
            .get<boolean>('autoUpdateRdb', true);
    }

    private isSkippedExpectedVersion(expectedVersion: string): boolean {
        const skippedVersion = this.context.globalState.get<string>(this.SKIP_EXPECTED_VERSION_KEY);
        return skippedVersion === expectedVersion;
    }

    private normalizeVersion(version: string): string {
        return normalizeComparableVersion(version);
    }

    private async resolveExpectedVersion(): Promise<string> {
        return resolveExpectedVersionWithCache(
            this.expectedVersionState,
            EXPECTED_GM_RDB_VERSION,
            GmodClientRdbUpdater.EXPECTED_VERSION_CACHE_TTL_MS,
        );
    }

    private async resolveInstalledVersion(garrysmodPath: string, binaryName: string): Promise<string | undefined> {
        return resolveInstalledModuleVersion(
            this.context,
            this.INSTALLED_STATE_KEY,
            garrysmodPath,
            binaryName,
        );
    }

    private async recordInstall(garrysmodPath: string, release: GmRdbRelease): Promise<void> {
        await recordInstalledModuleState(
            this.context,
            this.INSTALLED_STATE_KEY,
            garrysmodPath,
            release.tag_name,
        );
    }
}
