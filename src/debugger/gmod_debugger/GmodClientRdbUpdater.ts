import * as vscode from 'vscode';
import {
    detectGmRdbClient,
    detectInstalledGmRdbClientModules,
    getStoredClientGarrysmodPath,
    hasAllExpectedGmRdbClientModules,
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
    findAssetsForArchGroups,
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
    private hasShownMacExperimentalWarning = false;

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
        const installedModules = detectInstalledGmRdbClientModules(garrysmodPath);
        if (installedModules.length === 0) {
            return;
        }

        if (!this.shouldAutoPrompt()) {
            return;
        }

        const expectedVersion = await this.resolveExpectedVersion();
        if (this.isSkippedExpectedVersion(expectedVersion)) {
            return;
        }

        const versions = await Promise.all(
            installedModules.map((moduleName) => this.resolveInstalledVersion(garrysmodPath, moduleName))
        );
        const knownVersions = versions.filter((v): v is string => typeof v === 'string');
        if (knownVersions.length === 0) {
            return;
        }

        const mismatchedVersion = knownVersions.find((v) => this.normalizeVersion(v) !== expectedVersion);
        if (mismatchedVersion) {
            await this.promptForUpdate(mismatchedVersion, expectedVersion);
            return;
        }

        if (!hasAllExpectedGmRdbClientModules(garrysmodPath)) {
            await this.promptForUpdate(knownVersions[0], expectedVersion);
        }
    }

    public async runManualUpdateCommand(): Promise<void> {
        const garrysmodPath = getStoredClientGarrysmodPath(this.context);
        if (!garrysmodPath) {
            const action = await vscode.window.showInformationMessage(
                'gm_rdb (client): Garry\'s Mod game folder is not configured. Click Setup to select your Garry\'s Mod folder.',
                'Setup'
            );
            if (action === 'Setup') {
                void vscode.commands.executeCommand('gluals.gmod.configureDebugger');
            }
            return;
        }

        const installedModules = detectInstalledGmRdbClientModules(garrysmodPath);
        if (installedModules.length === 0) {
            const action = await vscode.window.showInformationMessage(
                'gm_rdb (client): gm_rdb client binary was not found in your Garry\'s Mod folder. Click Setup to install it.',
                'Setup'
            );
            if (action === 'Setup') {
                void vscode.commands.executeCommand('gluals.gmod.configureDebugger');
            }
            return;
        }

        const [expectedVersion, ...installedVersions] = await Promise.all([
            this.resolveExpectedVersion(),
            ...installedModules.map((moduleName) => this.resolveInstalledVersion(garrysmodPath, moduleName)),
        ]);

        const knownVersions = installedVersions.filter((v): v is string => typeof v === 'string');
        const allMatch = knownVersions.length === installedModules.length
            && knownVersions.every((v) => this.normalizeVersion(v) === expectedVersion)
            && hasAllExpectedGmRdbClientModules(garrysmodPath);

        if (allMatch) {
            vscode.window.showInformationMessage(`gm_rdb client binary is up to date (${expectedVersion}).`);
            return;
        }

        const displayInstalled = knownVersions.find((v) => this.normalizeVersion(v) !== expectedVersion) ?? knownVersions[0];
        const versionInfo = displayInstalled
            ? `(installed: ${displayInstalled}, latest: ${expectedVersion})`
            : `(latest: ${expectedVersion})`;
        const action = await vscode.window.showInformationMessage(
            `gm_rdb client binary update available ${versionInfo}.`,
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
            `gm_rdb client version mismatch (connected: ${moduleVersion}, expected: ${expectedVersion}). Update the client binary to avoid debugging issues.`,
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
        this.showMacExperimentalWarningOnce();

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
            selectAssets: (release) => this.findAssetsForCurrentPlatform(release),
        });

        if (!installedRelease) {
            return;
        }

        await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, undefined);
        await this.recordInstall(installGarrysmodPath, installedRelease);
    }

    private findAssetsForCurrentPlatform(release: GmRdbRelease): ReleaseAsset[] {
        return findAssetsForArchGroups(release, this.getArchCandidateGroupsForCurrentPlatform());
    }

    private getArchCandidateGroupsForCurrentPlatform(): readonly (readonly string[])[] {
        if (process.platform === 'win32') {
            return [
                ['gmcl_rdb_win64.dll'],
                ['gmcl_rdb_win32.dll'],
            ];
        }

        if (process.platform === 'linux') {
            return [
                ['gmcl_rdb_linux64.so', 'gmcl_rdb_linux64.dll'],
                ['gmcl_rdb_linux.so', 'gmcl_rdb_linux.dll'],
            ];
        }

        if (process.platform === 'darwin') {
            return [
                ['gmcl_rdb_osx64.dll', 'gmcl_rdb_osx.dll'],
            ];
        }

        return [];
    }

    private showMacExperimentalWarningOnce(): void {
        if (process.platform !== 'darwin' || this.hasShownMacExperimentalWarning) {
            return;
        }

        this.hasShownMacExperimentalWarning = true;
        vscode.window.showWarningMessage(
            'macOS rdb_client updates are experimental. The updater will use Garry\'s Mod _osx64.dll/_osx.dll module names and may not match all client layouts.'
        );
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
        void detectGmRdbClient;
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
