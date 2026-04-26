import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    cleanupLegacyInitInjection,
    DEFAULT_RDB_CLIENT_PORT,
    DEFAULT_RDB_PORT,
    detectGarrysmodBranchName,
    detectGmRdb,
    getStoredGarrysmodPath,
    isGarrysmodX64,
    GmRdbRelease,
    promptForGarrysmodPath,
    ReleaseAsset,
    syncAutorunFile,
} from './GmodDebugSetupWizard';
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

export const EXPECTED_GM_RDB_VERSION = '0.0.9';

interface VersionCheckResult {
    readonly moduleVersion: string;
    readonly expectedVersion: string;
    readonly isMatch: boolean;
}

export class GmodRdbUpdater {
    private static readonly EXPECTED_VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
    private readonly SKIP_EXPECTED_VERSION_KEY = 'gmodRdbUpdater.skipExpectedVersion';
    private readonly INSTALLED_STATE_KEY = 'gmodRdbUpdater.server.installedState';
    private hasShownMacExperimentalWarning = false;

    private readonly updateState: ActiveUpdateState = {
        activeUpdate: undefined,
    };

    private readonly expectedVersionState: ExpectedVersionCacheState = SHARED_EXPECTED_VERSION_STATE;

    constructor(private readonly context: vscode.ExtensionContext) {
    }

    private checkVersion(moduleVersion: string, expectedVersion: string): VersionCheckResult {
        const normalized = this.normalizeVersion(moduleVersion);
        return {
            moduleVersion: normalized,
            expectedVersion,
            isMatch: normalized === expectedVersion,
        };
    }

    public async handleVersionMismatch(moduleVersion: string): Promise<void> {
        if (!this.shouldAutoPrompt()) {
            return;
        }

        const expectedVersion = await this.resolveExpectedVersion();
        const check = this.checkVersion(moduleVersion, expectedVersion);
        if (check.isMatch) {
            return;
        }

        if (this.isSkippedExpectedVersion(check.expectedVersion)) {
            return;
        }

        await this.promptForUpdate(check.moduleVersion, check.expectedVersion);
    }

    /**
     * Boot/periodic update check: detects binary presence, compares version against release API.
     * Called by GmodUpdateScheduler. Does not prompt or update if the binary is absent.
     */
    public async runBootTimeCheck(garrysmodPath: string): Promise<void> {
        const detected = detectGmRdb(garrysmodPath);
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
        const garrysmodPath = this.resolveKnownGarrysmodPath();
        if (!garrysmodPath) {
            const action = await vscode.window.showInformationMessage(
                'gm_rdb: path not configured.',
                'Setup'
            );
            if (action === 'Setup') {
                void vscode.commands.executeCommand('gluals.gmod.configureDebugger');
            }
            return;
        }

        const detected = detectGmRdb(garrysmodPath);
        if (!detected) {
            const action = await vscode.window.showInformationMessage(
                'gm_rdb not found in the configured path.',
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
            vscode.window.showInformationMessage(`gm_rdb is up to date (${expectedVersion}).`);
            return;
        }

        const versionInfo = installedVersion
            ? `(installed: ${installedVersion}, latest: ${expectedVersion})`
            : `(latest: ${expectedVersion})`;
        const action = await vscode.window.showInformationMessage(
            `gm_rdb update available ${versionInfo}.`,
            'Update'
        );
        if (action === 'Update') {
            await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, undefined);
            await this.runUpdateFlow();
        }
    }

    public async ensureRuntimeFilesUpToDate(session?: vscode.DebugSession): Promise<void> {
        const garrysmodPath = this.resolveKnownGarrysmodPath(session);
        if (!garrysmodPath) {
            return;
        }

        try {
            const debugPort = this.resolveDebugPort(session?.workspaceFolder);
            const autorunStatus = syncAutorunFile(garrysmodPath, debugPort, DEFAULT_RDB_CLIENT_PORT);
            cleanupLegacyInitInjection(garrysmodPath);

            if (autorunStatus !== 'unchanged') {
                console.log(`[GLuaLS] Updated runtime file: lua/autorun/debug.lua (${autorunStatus}).`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[GLuaLS] Failed to sync runtime files: ${message}`);
        }
    }

    public async promptForUpdate(moduleVersion: string, expectedVersion: string): Promise<void> {
        const action = await vscode.window.showInformationMessage(
            `gm_rdb module version mismatch detected (connected: ${moduleVersion}, expected: ${expectedVersion}).`,
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
        const garrysmodPath = await promptForGarrysmodPath(this.context);
        if (!garrysmodPath) {
            return;
        }

        await this.downloadAndInstall(this.context, garrysmodPath);
    }

    private async downloadAndInstallInternal(garrysmodPath: string): Promise<void> {
        this.showMacExperimentalWarningOnce();

        const installedRelease = await downloadAndInstallRelease({
            garrysmodPath,
            progressTitle: 'Updating gm_rdb...',
            fetchProgressMessage: 'Fetching gm_rdb release for current extension channel...',
            missingReleaseMessage: 'Failed to fetch gm_rdb release metadata.',
            incompatibleBinaryLabel: 'gm_rdb server',
            tempDirPrefix: 'gluals-gmrdb-',
            successMessage: 'gm_rdb updated successfully. Restart SRCDS to load the new module.',
            failurePrefix: 'Failed to update gm_rdb',
            selectAsset: (release) => this.findAssetForUpdate(release, garrysmodPath),
            afterInstall: async ({ progress }) => {
                const debugPort = this.resolveDebugPort();
                progress.report({ message: 'Writing shared debugger autorun file...' });
                syncAutorunFile(garrysmodPath, debugPort, DEFAULT_RDB_CLIENT_PORT);
                cleanupLegacyInitInjection(garrysmodPath);
            },
        });

        if (!installedRelease) {
            return;
        }

        await this.context.globalState.update(this.SKIP_EXPECTED_VERSION_KEY, undefined);
        await this.recordInstall(garrysmodPath, installedRelease);
    }

    private findAssetForCurrentPlatform(release: GmRdbRelease): ReleaseAsset | undefined {
        return findAssetByNameCandidates(release, this.getAssetCandidatesForCurrentPlatform());
    }

    private findAssetForUpdate(release: GmRdbRelease, garrysmodPath: string): ReleaseAsset | undefined {
        const isX64 = isGarrysmodX64(garrysmodPath);
        const preferredCandidates: string[] = process.platform === 'win32'
            ? [isX64 ? 'gmsv_rdb_win64.dll' : 'gmsv_rdb_win32.dll']
            : process.platform === 'linux'
                ? (isX64
                    ? ['gmsv_rdb_linux64.so', 'gmsv_rdb_linux64.dll']
                    : ['gmsv_rdb_linux.so', 'gmsv_rdb_linux.dll'])
                : process.platform === 'darwin'
                    ? ['gmsv_rdb_osx64.dll', 'gmsv_rdb_osx.dll']
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

        if (process.platform === 'darwin') {
            return ['gmsv_rdb_osx64.dll', 'gmsv_rdb_osx.dll'];
        }

        return [];
    }

    private showMacExperimentalWarningOnce(): void {
        if (process.platform !== 'darwin' || this.hasShownMacExperimentalWarning) {
            return;
        }

        this.hasShownMacExperimentalWarning = true;
        vscode.window.showWarningMessage(
            'macOS gm_rdb updates are experimental. The updater will use Garry\'s Mod _osx64.dll/_osx.dll module names and may not match all SRCDS layouts.'
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
            GmodRdbUpdater.EXPECTED_VERSION_CACHE_TTL_MS,
        );
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
            ? Math.min(65535, Math.max(1, Math.floor(configuredPort)))
            : DEFAULT_RDB_PORT;
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
