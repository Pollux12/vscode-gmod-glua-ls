import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { downloadFile } from '../../netHelpers';
import { fetchReleaseForCurrentExtensionChannel, GmRdbRelease, ReleaseAsset } from './GmodDebugSetupWizard';

const execFileAsync = promisify(child_process.execFile);

export interface InstalledModuleState {
    readonly version: string;
    readonly tag: string;
    readonly installedAt: number;
    readonly garrysmodPath: string;
}

type InstalledModuleStateStore = Record<string, InstalledModuleState>;

export interface ExpectedVersionCacheState {
    expectedVersionCache: {
        readonly value: string;
        readonly fetchedAt: number;
    } | undefined;
    expectedVersionRequest: Promise<string> | undefined;
}

export const SHARED_EXPECTED_VERSION_STATE: ExpectedVersionCacheState = {
    expectedVersionCache: undefined,
    expectedVersionRequest: undefined,
};

export interface ActiveUpdateState {
    activeUpdate: Promise<void> | undefined;
}

interface InstallHookContext {
    readonly progress: vscode.Progress<{ message?: string; increment?: number; }>;
    readonly release: GmRdbRelease;
    readonly asset: ReleaseAsset;
    readonly garrysmodPath: string;
}

interface InstallReleaseOptions {
    readonly garrysmodPath: string;
    readonly progressTitle: string;
    readonly fetchProgressMessage: string;
    readonly missingReleaseMessage: string;
    readonly incompatibleBinaryLabel: string;
    readonly tempDirPrefix: string;
    readonly successMessage: string;
    readonly failurePrefix: string;
    readonly selectAsset: (release: GmRdbRelease) => ReleaseAsset | undefined;
    readonly afterInstall?: (context: InstallHookContext) => Promise<void>;
}

function normalizePathKey(garrysmodPath: string): string {
    let resolved = path.resolve(garrysmodPath);
    if (resolved.endsWith(path.sep) && resolved.length > path.sep.length) {
        resolved = resolved.slice(0, -path.sep.length);
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInstalledModuleState(value: unknown): value is InstalledModuleState {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const state = value as Partial<InstalledModuleState>;
    return typeof state.version === 'string'
        && typeof state.tag === 'string'
        && typeof state.installedAt === 'number'
        && typeof state.garrysmodPath === 'string';
}

function coerceInstalledStateStore(value: unknown): InstalledModuleStateStore {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    if (isInstalledModuleState(value)) {
        return {
            [normalizePathKey(value.garrysmodPath)]: value,
        };
    }

    const store: InstalledModuleStateStore = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (isInstalledModuleState(entry)) {
            store[key] = entry;
        }
    }
    return store;
}

function tryGetMajor(version: string): number | undefined {
    const match = normalizeComparableVersion(version).match(/^(\d+)\./);
    if (!match) {
        return undefined;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isLikelyFileInUseError(error: unknown): boolean {
    const err = error as NodeJS.ErrnoException | undefined;
    const code = err?.code;
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function toInstallError(error: unknown, assetName: string): Error {
    if (isLikelyFileInUseError(error)) {
        return new Error(
            `Cannot replace ${assetName} because it is in use. Stop Garry's Mod or SRCDS, then retry the update.`
        );
    }

    return error instanceof Error ? error : new Error(String(error));
}

async function cleanupStaleBackups(binDir: string, assetName: string): Promise<void> {
    let entries: string[];
    try {
        entries = await fs.promises.readdir(binDir);
    } catch {
        return;
    }

    const backupPrefix = `${assetName}.old-`;
    for (const entry of entries) {
        if (!entry.startsWith(backupPrefix)) {
            continue;
        }

        const backupPath = path.join(binDir, entry);
        await fs.promises.unlink(backupPath).catch(() => {});
    }
}

function getModuleVersionSidecarPath(modulePath: string): string {
    return `${modulePath}.version`;
}

async function readModuleVersionSidecar(modulePath: string): Promise<string | undefined> {
    if (process.platform === 'win32') {
        return undefined;
    }

    try {
        const raw = await fs.promises.readFile(getModuleVersionSidecarPath(modulePath), 'utf8');
        const version = raw.trim();
        return version.length > 0 ? normalizeComparableVersion(version) : undefined;
    } catch {
        return undefined;
    }
}

async function writeModuleVersionSidecar(modulePath: string, releaseTag: string): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }

    await fs.promises.writeFile(
        getModuleVersionSidecarPath(modulePath),
        `${normalizeComparableVersion(releaseTag)}\n`,
        'utf8'
    );
}

async function makeInstalledModuleUsable(modulePath: string): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }

    await fs.promises.chmod(modulePath, 0o755).catch(() => {});

    if (process.platform === 'darwin') {
        await execFileAsync('xattr', ['-d', 'com.apple.quarantine', modulePath], { timeout: 8000 }).catch(() => {});
    }
}

export function normalizeComparableVersion(version: string): string {
    const normalized = version.trim().replace(/^v/i, '');
    const match = normalized.match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1] : normalized;
}

export async function readWindowsFileVersion(filePath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve(undefined);
            return;
        }
        if (!fs.existsSync(filePath)) {
            resolve(undefined);
            return;
        }
        const escaped = filePath.replace(/'/g, "''");
        child_process.execFile(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$v=(Get-Item '${escaped}').VersionInfo; if($v.ProductVersion){$v.ProductVersion}elseif($v.FileVersion){$v.FileVersion}`
            ],
            { timeout: 8000 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve(undefined);
                    return;
                }
                const raw = stdout.trim();
                if (!raw) {
                    resolve(undefined);
                    return;
                }
                const dotted = raw.replace(/,\s*/g, '.');
                const match = dotted.match(/^(\d+)\.(\d+)\.(\d+)/);
                resolve(match ? `${match[1]}.${match[2]}.${match[3]}` : raw.replace(/^v/i, ''));
            }
        );
    });
}

export async function runExclusiveUpdate(state: ActiveUpdateState, runner: () => Promise<void>): Promise<void> {
    if (state.activeUpdate) {
        await state.activeUpdate;
        return;
    }

    state.activeUpdate = runner();
    try {
        await state.activeUpdate;
    } finally {
        state.activeUpdate = undefined;
    }
}

export async function resolveExpectedVersionWithCache(
    state: ExpectedVersionCacheState,
    fallbackVersion: string,
    cacheTtlMs: number
): Promise<string> {
    const fallback = normalizeComparableVersion(fallbackVersion);
    const now = Date.now();

    if (state.expectedVersionCache && now - state.expectedVersionCache.fetchedAt < cacheTtlMs) {
        return state.expectedVersionCache.value;
    }

    if (state.expectedVersionRequest) {
        return state.expectedVersionRequest;
    }

    state.expectedVersionRequest = (async () => {
        const release = await fetchReleaseForCurrentExtensionChannel();
        let version = normalizeComparableVersion(release?.tag_name ?? fallback);

        // Guard against accidentally adopting an incompatible major release.
        const fallbackMajor = tryGetMajor(fallback);
        const fetchedMajor = tryGetMajor(version);
        if (fallbackMajor !== undefined && fetchedMajor !== undefined && fallbackMajor !== fetchedMajor) {
            version = fallback;
        }

        state.expectedVersionCache = {
            value: version,
            fetchedAt: Date.now(),
        };
        return version;
    })().catch(() => {
        state.expectedVersionCache = {
            value: fallback,
            fetchedAt: Date.now(),
        };
        return fallback;
    }).finally(() => {
        state.expectedVersionRequest = undefined;
    });

    return state.expectedVersionRequest;
}

export async function resolveInstalledModuleVersion(
    context: vscode.ExtensionContext,
    installedStateKey: string,
    garrysmodPath: string,
    binaryName: string
): Promise<string | undefined> {
    const binaryPath = path.join(garrysmodPath, 'lua', 'bin', binaryName);
    const pathKey = normalizePathKey(garrysmodPath);
    const stateStore = coerceInstalledStateStore(context.globalState.get<unknown>(installedStateKey));

    if (process.platform === 'win32') {
        const fileVersion = await readWindowsFileVersion(binaryPath);
        if (fileVersion) {
            const state = stateStore[pathKey];
            if (!state || state.version !== fileVersion) {
                stateStore[pathKey] = {
                    version: fileVersion,
                    tag: state?.tag ?? '',
                    installedAt: Date.now(),
                    garrysmodPath,
                };
                await context.globalState.update(installedStateKey, stateStore);
            }
            return fileVersion;
        }
    }

    const state = stateStore[pathKey];
    if (state) {
        return state.version;
    }

    const sidecarVersion = await readModuleVersionSidecar(binaryPath);
    if (sidecarVersion) {
        return sidecarVersion;
    }

    return undefined;
}

export async function recordInstalledModuleState(
    context: vscode.ExtensionContext,
    installedStateKey: string,
    garrysmodPath: string,
    releaseTag: string
): Promise<void> {
    const pathKey = normalizePathKey(garrysmodPath);
    const stateStore = coerceInstalledStateStore(context.globalState.get<unknown>(installedStateKey));
    stateStore[pathKey] = {
        version: normalizeComparableVersion(releaseTag),
        tag: releaseTag,
        installedAt: Date.now(),
        garrysmodPath,
    };
    await context.globalState.update(installedStateKey, stateStore);
}

export function findAssetByNameCandidates(release: GmRdbRelease, candidates: readonly string[]): ReleaseAsset | undefined {
    for (const name of candidates) {
        const asset = release.assets.find((entry) => entry.name === name);
        if (asset) {
            return asset;
        }
    }

    return undefined;
}

export async function downloadAndInstallRelease(options: InstallReleaseOptions): Promise<GmRdbRelease | undefined> {
    let installedRelease: GmRdbRelease | undefined;
    const binDir = path.join(options.garrysmodPath, 'lua', 'bin');

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: options.progressTitle,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: options.fetchProgressMessage });
                const release = await fetchReleaseForCurrentExtensionChannel();
                if (!release) {
                    throw new Error(options.missingReleaseMessage);
                }

                const asset = options.selectAsset(release);
                if (!asset) {
                    const available = release.assets.map((entry) => entry.name).join(', ') || '(none)';
                    throw new Error(`No compatible ${options.incompatibleBinaryLabel} binary found for ${os.platform()} (${os.arch()}). Available assets: ${available}`);
                }

                progress.report({ message: `Downloading ${asset.name} (${release.tag_name})...` });
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), options.tempDirPrefix));
                const safeName = path.basename(asset.name);
                if (safeName !== asset.name) {
                    throw new Error(`Release asset name contains path separators: ${asset.name}`);
                }
                const tempFilePath = path.join(tempDir, safeName);
                const destinationPath = path.join(binDir, safeName);

                try {
                    await downloadFile(asset.browser_download_url, tempFilePath, progress);

                    progress.report({ message: `Installing ${asset.name}...` });
                    await fs.promises.mkdir(binDir, { recursive: true });
                    await cleanupStaleBackups(binDir, safeName);
                    const stagingPath = destinationPath + '.installing';
                    let backupPath: string | undefined;
                    try {
                        await fs.promises.copyFile(tempFilePath, stagingPath);

                        if (process.platform === 'win32' && fs.existsSync(destinationPath)) {
                            backupPath = `${destinationPath}.old-${Date.now()}`;
                            await fs.promises.rename(destinationPath, backupPath);
                        }

                        await fs.promises.rename(stagingPath, destinationPath);

                        await makeInstalledModuleUsable(destinationPath);
                        await writeModuleVersionSidecar(destinationPath, release.tag_name).catch(() => {});

                        if (backupPath) {
                            await fs.promises.unlink(backupPath).catch(() => {});
                        }
                    } catch (error) {
                        if (backupPath && !fs.existsSync(destinationPath)) {
                            await fs.promises.rename(backupPath, destinationPath).catch(() => {});
                        }
                        throw toInstallError(error, asset.name);
                    } finally {
                        await fs.promises.unlink(stagingPath).catch(() => {});
                    }

                    if (options.afterInstall) {
                        await options.afterInstall({
                            progress,
                            release,
                            asset,
                            garrysmodPath: options.garrysmodPath,
                        });
                    }

                    progress.report({ message: 'Update complete!' });
                } finally {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }

                progress.report({ message: `Installed ${asset.name} to garrysmod/lua/bin.` });
                installedRelease = release;
            }
        );
        vscode.window.showInformationMessage(options.successMessage);
        return installedRelease;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`${options.failurePrefix}: ${message}`);
        return undefined;
    }
}
