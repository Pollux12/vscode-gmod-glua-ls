import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fetchJson, downloadFile } from '../../netHelpers';

const SRCDS_ROOT_STATE_KEY = 'gluals.gmod.srcdsRootPath';
const LEGACY_GARRYSMOD_PATH_STATE_KEY = 'gluals.gmod.garrysmodPath';
const CLIENT_GARRYSMOD_PATH_STATE_KEY = 'gluals.gmod.clientGarrysmodPath';
const GMOD_DEBUGGER_TYPE = 'gluals_gmod';
const GMOD_CLIENT_DEBUGGER_TYPE = 'gluals_gmod_client';
const GM_RDB_REPO = 'Pollux12/gm_rdb';
const EXTENSION_ID = 'Pollux.gmod-glua-ls';
const GITHUB_RELEASE_HEADERS = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};
export const DEFAULT_RDB_PORT = 21111;
export const DEFAULT_RDB_CLIENT_PORT = 21112;
const LEGACY_LOADER_START_MARKER = '-- gm_rdb debugger loader (added by GLuaLS)';
const LEGACY_LOADER_END_MARKER = '-- end gm_rdb';
const MAC_GMOD_APP_BUNDLE_NAMES = ['garrysmod.app', 'garrys mod.app'] as const;

const GM_RDB_PLATFORM_DLLS: Record<string, string> = {
    'Windows 64-bit': 'gmsv_rdb_win64.dll',
    'Windows 32-bit': 'gmsv_rdb_win32.dll',
    'Linux 64-bit': 'gmsv_rdb_linux64.dll',
    'Linux 32-bit': 'gmsv_rdb_linux.dll',
    'macOS 64-bit (experimental)': 'gmsv_rdb_osx64.dll',
};

const ALL_RDB_DLLS = Object.values(GM_RDB_PLATFORM_DLLS);

const GM_RDB_CLIENT_PLATFORM_DLLS: Record<string, string> = {
    'Windows 64-bit': 'gmcl_rdb_win64.dll',
    'Windows 32-bit': 'gmcl_rdb_win32.dll',
    'Linux 64-bit': 'gmcl_rdb_linux64.dll',
    'Linux 32-bit': 'gmcl_rdb_linux.dll',
    'macOS 64-bit (experimental)': 'gmcl_rdb_osx64.dll',
};

export const ALL_RDB_CLIENT_DLLS = Object.values(GM_RDB_CLIENT_PLATFORM_DLLS);

interface DebugConfig {
    type: string;
    request: 'attach' | 'launch';
    name: string;
    host: string;
    port: number;
    sourceRoot: string;
    sourceFileMap: Record<string, string>;
    stopOnEntry: boolean;
    stopOnError: boolean;
    realm?: string;
    program?: string;
    cwd?: string;
    args?: string[];
}

export interface ReleaseAsset {
    name: string;
    browser_download_url: string;
}

export interface GmRdbRelease {
    tag_name: string;
    prerelease?: boolean;
    assets: ReleaseAsset[];
}

type WorkspaceKind = 'addon' | 'gamemode' | 'unknown';

interface WorkspaceAutoDetection {
    kind: WorkspaceKind;
    srcdsRoot: string;
    garrysmodPath: string;
    sourceRootExpression: string;
    srcdsRootExpression: string;
    workspaceRemotePath: string;
}

interface ResolvedSrcdsPath {
    srcdsRoot: string;
    garrysmodPath: string;
}

interface ResolvedClientInstallPath {
    gameRoot: string;
    garrysmodPath: string;
}

interface LaunchProgramSelection {
    program: string;
    usedSrcdsRunFallback: boolean;
}

export interface ClientInstallPathValidation {
    warnings: string[];
}

export type AutorunSyncStatus = 'created' | 'updated' | 'unchanged';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPosixPath(input: string): string {
    return input.replace(/\\/g, '/');
}

function samePath(left: string, right: string): boolean {
    const leftResolved = path.resolve(left);
    const rightResolved = path.resolve(right);
    if (process.platform === 'win32') {
        return leftResolved.toLowerCase() === rightResolved.toLowerCase();
    }
    return leftResolved === rightResolved;
}

function toWorkspaceExpression(relativePath: string): string {
    const normalized = toPosixPath(relativePath);
    if (!normalized || normalized === '.') {
        return '${workspaceFolder}';
    }
    return `${'${workspaceFolder}'}/${normalized}`;
}

function isMacGarrysModAppBundleName(name: string): boolean {
    return MAC_GMOD_APP_BUNDLE_NAMES.includes(name.toLowerCase() as typeof MAC_GMOD_APP_BUNDLE_NAMES[number]);
}

function normalizeSrcdsRootInput(rawPath: string): ResolvedSrcdsPath {
    const resolved = path.resolve(rawPath.trim());
    if (process.platform === 'darwin') {
        if (isMacGarrysModAppBundleName(path.basename(resolved))) {
            const gameRoot = path.dirname(resolved);
            return {
                srcdsRoot: gameRoot,
                garrysmodPath: path.join(gameRoot, 'garrysmod'),
            };
        }
        const appContentMarkers = ['Contents', 'MacOS'];
        const parts = resolved.split(path.sep);
        const markerIndex = parts.findIndex((part, index) => isMacGarrysModAppBundleName(part) && parts[index + 1] === appContentMarkers[0]);
        if (markerIndex >= 0) {
            const gameRoot = parts.slice(0, markerIndex).join(path.sep) || path.sep;
            return {
                srcdsRoot: gameRoot,
                garrysmodPath: path.join(gameRoot, 'garrysmod'),
            };
        }
    }
    if (path.basename(resolved).toLowerCase() === 'garrysmod') {
        return {
            srcdsRoot: path.dirname(resolved),
            garrysmodPath: resolved,
        };
    }
    return {
        srcdsRoot: resolved,
        garrysmodPath: path.join(resolved, 'garrysmod'),
    };
}

function detectWorkspaceKind(workspaceFolder: vscode.WorkspaceFolder): WorkspaceKind {
    const root = workspaceFolder.uri.fsPath;
    if (fs.existsSync(path.join(root, 'addon.txt')) || fs.existsSync(path.join(root, 'addon.json'))) {
        return 'addon';
    }
    if (fs.existsSync(path.join(root, 'gamemode')) || fs.existsSync(path.join(root, 'gamemodes'))) {
        return 'gamemode';
    }
    return 'unknown';
}

function buildSuggestedWorkspaceRemotePath(workspaceFolder: vscode.WorkspaceFolder): string {
    const kind = detectWorkspaceKind(workspaceFolder);
    const workspaceName = path.basename(workspaceFolder.uri.fsPath);
    if (kind === 'gamemode') {
        return `gamemodes/${workspaceName}`;
    }
    return `addons/${workspaceName}`;
}

function detectWorkspaceSrcdsLayout(workspaceFolder: vscode.WorkspaceFolder): WorkspaceAutoDetection | undefined {
    const workspacePath = path.resolve(workspaceFolder.uri.fsPath);
    const parsed = path.parse(workspacePath);
    const parts = path.relative(parsed.root, workspacePath)
        .split(path.sep)
        .filter((part) => part.length > 0);

    for (let index = 0; index < parts.length - 2; index += 1) {
        const current = parts[index].toLowerCase();
        const next = parts[index + 1].toLowerCase();
        if (current !== 'garrysmod' || (next !== 'addons' && next !== 'gamemodes')) {
            continue;
        }

        const workspaceInsideType = parts.slice(index + 2);
        if (workspaceInsideType.length === 0) {
            continue;
        }

        const projectName = workspaceInsideType[0];
        const rest = workspaceInsideType.slice(1).map((part) => toPosixPath(part)).join('/');
        const kind: WorkspaceKind = next === 'addons' ? 'addon' : 'gamemode';
        const remoteBase = next === 'addons' ? `addons/${projectName}` : `gamemodes/${projectName}`;
        const workspaceRemotePath = rest.length > 0 ? `${remoteBase}/${rest}` : remoteBase;

        const garrysmodPath = path.join(parsed.root, ...parts.slice(0, index + 1));
        const srcdsRoot = path.dirname(garrysmodPath);
        const sourceRootExpression = toWorkspaceExpression(path.relative(workspacePath, garrysmodPath));
        const srcdsRootExpression = toWorkspaceExpression(path.relative(workspacePath, srcdsRoot));

        return {
            kind,
            srcdsRoot,
            garrysmodPath,
            sourceRootExpression,
            srcdsRootExpression,
            workspaceRemotePath,
        };
    }

    return undefined;
}

export function detectGmRdb(garrysmodPath: string): string | undefined {
    const binDir = path.join(garrysmodPath, 'lua', 'bin');
    if (!fs.existsSync(binDir)) {
        return undefined;
    }

    const candidates = process.platform === 'linux'
        ? ['gmsv_rdb_linux64.so', 'gmsv_rdb_linux.so', 'gmsv_rdb_linux64.dll', 'gmsv_rdb_linux.dll']
        : process.platform === 'darwin'
            ? ['gmsv_rdb_osx64.dll', 'gmsv_rdb_osx.dll']
            : ALL_RDB_DLLS;

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(binDir, candidate))) {
            return candidate;
        }
    }

    return undefined;
}

export function detectGarrysmodBranchName(garrysmodPath: string): string | undefined {
    const versionFilePath = path.join(garrysmodPath, 'garrysmod.ver');
    if (!fs.existsSync(versionFilePath)) {
        return undefined;
    }

    try {
        const content = fs.readFileSync(versionFilePath, 'utf8');
        const lines = content.split(/\r?\n/);
        return lines[2]?.trim();
    } catch {
        return undefined;
    }
}

export function isGarrysmodX64(garrysmodPath: string): boolean {
    return detectGarrysmodBranchName(garrysmodPath) === 'x86-64';
}

export function hasSrcdsExecutable(srcdsRoot: string): boolean {
    if (process.platform === 'win32') {
        return fs.existsSync(path.join(srcdsRoot, 'srcds_win64.exe'))
            || fs.existsSync(path.join(srcdsRoot, 'srcds.exe'));
    }

    if (process.platform === 'linux') {
        return fs.existsSync(path.join(srcdsRoot, 'srcds_run'));
    }

    if (process.platform === 'darwin') {
        return fs.existsSync(path.join(srcdsRoot, 'srcds_run'))
            || fs.existsSync(path.join(srcdsRoot, 'srcds_osx'))
            || fs.existsSync(path.join(srcdsRoot, 'srcds_osx64'));
    }

    return false;
}

export function detectGmRdbClient(garrysmodPath: string): string | undefined {
    const binDir = path.join(garrysmodPath, 'lua', 'bin');
    if (!fs.existsSync(binDir)) {
        return undefined;
    }

    const candidates = process.platform === 'linux'
        ? ['gmcl_rdb_linux64.so', 'gmcl_rdb_linux.so', 'gmcl_rdb_linux64.dll', 'gmcl_rdb_linux.dll']
        : process.platform === 'darwin'
            ? ['gmcl_rdb_osx64.dll', 'gmcl_rdb_osx.dll']
            : ALL_RDB_CLIENT_DLLS;

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(binDir, candidate))) {
            return candidate;
        }
    }

    return undefined;
}

function isPreReleaseExtension(): boolean {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (!extension) {
        return false;
    }

    const version = String(extension.packageJSON?.version ?? '');
    const patchPart = version.split('.')[2];
    const patch = parseInt(patchPart, 10);
    if (!Number.isFinite(patch)) {
        return false;
    }

    return patch > 0;
}

function normalizeClientInstallInput(rawPath: string): ResolvedClientInstallPath {
    const resolved = path.resolve(rawPath.trim());
    const baseName = path.basename(resolved).toLowerCase();
    if (process.platform === 'darwin' && hasGarrysModAppBundle(resolved)) {
        return {
            gameRoot: resolved,
            garrysmodPath: path.join(resolved, 'garrysmod'),
        };
    }
    if (process.platform === 'darwin' && isMacGarrysModAppBundleName(baseName)) {
        const gameRoot = path.dirname(resolved);
        return {
            gameRoot,
            garrysmodPath: path.join(gameRoot, 'garrysmod'),
        };
    }
    const hasVersionInSelf = fs.existsSync(path.join(resolved, 'garrysmod.ver'));
    const hasVersionInChild = fs.existsSync(path.join(resolved, 'garrysmod', 'garrysmod.ver'));

    if (hasVersionInChild) {
        return {
            gameRoot: resolved,
            garrysmodPath: path.join(resolved, 'garrysmod'),
        };
    }

    if (baseName === 'garrysmod' && hasVersionInSelf) {
        return {
            gameRoot: path.dirname(resolved),
            garrysmodPath: resolved,
        };
    }

    return {
        gameRoot: resolved,
        garrysmodPath: path.join(resolved, 'garrysmod'),
    };
}

function collectSteamRootsForPlatform(): string[] {
    const roots: string[] = [];
    const home = os.homedir();

    if (process.platform === 'win32') {
        const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
        const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
        roots.push(
            path.join(programFilesX86, 'Steam'),
            path.join(programFiles, 'Steam')
        );
    } else if (process.platform === 'linux') {
        roots.push(
            path.join(home, '.steam', 'steam'),
            path.join(home, '.steam', 'root'),
            path.join(home, '.steam', 'debian-installation'),
            path.join(home, '.local', 'share', 'Steam'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
            path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam')
        );
    } else if (process.platform === 'darwin') {
        roots.push(
            path.join(home, 'Library', 'Application Support', 'Steam')
        );
    }

    const seen = new Set<string>();
    return roots.filter((entry) => {
        const key = path.resolve(entry);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function collectSteamLibraryPaths(): string[] {
    const roots = collectSteamRootsForPlatform();
    const libraries = new Set<string>();

    for (const root of roots) {
        libraries.add(path.resolve(root));

        const libraryVdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
        if (!fs.existsSync(libraryVdfPath)) {
            continue;
        }

        try {
            const content = fs.readFileSync(libraryVdfPath, 'utf8');
            const pattern = /"path"\s+"([^"]+)"/g;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                const raw = match[1].replace(/\\\\/g, '\\');
                if (raw.trim().length > 0) {
                    libraries.add(path.resolve(raw));
                }
            }
        } catch {
            // Ignore malformed or unreadable library manifest files.
        }
    }

    return [...libraries];
}

function detectClientGarrysmodInstallPath(): string | undefined {
    const libraries = collectSteamLibraryPaths();
    for (const library of libraries) {
        const gameRoot = path.join(library, 'steamapps', 'common', 'GarrysMod');
        const garrysmodPath = path.join(gameRoot, 'garrysmod');
        const versionPath = path.join(garrysmodPath, 'garrysmod.ver');
        if (!fs.existsSync(versionPath)) {
            continue;
        }

        if (process.platform === 'win32' && !fs.existsSync(path.join(gameRoot, 'gmod.exe'))) {
            continue;
        }

        if (process.platform === 'darwin' && !hasGarrysModAppBundle(gameRoot)) {
            continue;
        }

        return gameRoot;
    }

    return undefined;
}

function hasGarrysModAppBundle(gameRoot: string): boolean {
    return findGarrysModAppBundleName(gameRoot) !== undefined;
}

function findGarrysModAppBundleName(gameRoot: string): string | undefined {
    let entries: string[];
    try {
        entries = fs.readdirSync(gameRoot);
    } catch {
        return undefined;
    }

    for (const appName of entries) {
        if (!isMacGarrysModAppBundleName(appName)) {
            continue;
        }

        const appPath = path.join(gameRoot, appName);
        const executablePath = path.join(appPath, 'Contents', 'MacOS', 'gmod_osx');
        if (fs.existsSync(executablePath)) {
            return appName;
        }
    }

    return undefined;
}

function ensureExecutableIfPossible(filePath: string): boolean {
    if (process.platform === 'win32') {
        return fs.existsSync(filePath);
    }

    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        try {
            fs.chmodSync(filePath, 0o755);
            fs.accessSync(filePath, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
}

export function validateClientInstallPath(inputPath: string): ClientInstallPathValidation {
    const warnings: string[] = [];
    const normalized = normalizeClientInstallInput(inputPath);
    const gameRoot = normalized.gameRoot;
    const garrysmodPath = normalized.garrysmodPath;
    const hasSrcdsExe = hasSrcdsExecutable(gameRoot);
    const hasGmodExe = process.platform === 'win32' && fs.existsSync(path.join(gameRoot, 'gmod.exe'));
    const hasGmodApp = process.platform === 'darwin' && hasGarrysModAppBundle(gameRoot);

    if (!fs.existsSync(garrysmodPath)) {
        warnings.push(`The garrysmod folder does not exist at ${garrysmodPath}.`);
    }

    if (!fs.existsSync(path.join(garrysmodPath, 'garrysmod.ver'))) {
        warnings.push(`Could not find garrysmod.ver in ${garrysmodPath}.`);
    }

    if (hasSrcdsExe && !hasGmodExe && !hasGmodApp) {
        warnings.push(`Found SRCDS executable in ${gameRoot}, which suggests this is a server install.`);
    }

    if (process.platform === 'win32' && !hasGmodExe) {
        warnings.push(`Could not find gmod.exe in ${gameRoot}, so this may not be a client install.`);
    }

    if (process.platform === 'darwin' && !hasGmodApp) {
        warnings.push(`Could not find a valid GarrysMod.app bundle in ${gameRoot}, so this may not be a macOS client install.`);
    }

    return { warnings };
}

export async function fetchLatestRelease(): Promise<GmRdbRelease | null> {
    try {
        return await fetchJson<GmRdbRelease>(`https://api.github.com/repos/${GM_RDB_REPO}/releases/latest`, {
            headers: GITHUB_RELEASE_HEADERS,
        });
    } catch {
        return null;
    }
}

async function fetchLatestPreRelease(): Promise<GmRdbRelease | null> {
    try {
        const releases = await fetchJson<GmRdbRelease[]>(`https://api.github.com/repos/${GM_RDB_REPO}/releases`, {
            headers: GITHUB_RELEASE_HEADERS,
        });

        const preRelease = releases.find((release) => {
            if (release?.prerelease !== true || !Array.isArray(release.assets) || release.assets.length === 0) {
                return false;
            }

            return release.assets.some((asset) => {
                return typeof asset?.name === 'string'
                    && (ALL_RDB_DLLS.includes(asset.name) || ALL_RDB_CLIENT_DLLS.includes(asset.name))
                    && typeof asset?.browser_download_url === 'string';
            });
        }) ?? null;

        return preRelease;
    } catch {
        return null;
    }
}

async function fetchLatestReleaseIncludingPreReleases(): Promise<GmRdbRelease | null> {
    try {
        const releases = await fetchJson<GmRdbRelease[]>(`https://api.github.com/repos/${GM_RDB_REPO}/releases`, {
            headers: GITHUB_RELEASE_HEADERS,
        });

        const latest = releases.find((release) => {
            if (!Array.isArray(release?.assets) || release.assets.length === 0) {
                return false;
            }

            return release.assets.some((asset) => {
                return typeof asset?.name === 'string'
                    && (ALL_RDB_DLLS.includes(asset.name) || ALL_RDB_CLIENT_DLLS.includes(asset.name))
                    && typeof asset?.browser_download_url === 'string';
            });
        }) ?? null;

        return latest;
    } catch {
        return null;
    }
}

export async function fetchReleaseForCurrentExtensionChannel(): Promise<GmRdbRelease | null> {
    if (isPreReleaseExtension()) {
        const latest = await fetchLatestReleaseIncludingPreReleases();
        if (latest) {
            return latest;
        }

        const preRelease = await fetchLatestPreRelease();
        if (preRelease) {
            return preRelease;
        }

        console.warn('No gm_rdb release with assets is available yet. Falling back to latest stable release.');
    }

    return fetchLatestRelease();
}

function buildSharedAutorunLua(port: number, clientPort: number = DEFAULT_RDB_CLIENT_PORT): string {
    return [
        '-- [GLuaLS] Auto-managed by GLuaLS extension. Do not edit.',
        '_GLUALS = _GLUALS or {}',
        '',
        'if SERVER then',
        '    if not (util and util.IsBinaryModuleInstalled and util.IsBinaryModuleInstalled("rdb")) then',
        '        return',
        '    end',
        '    require("rdb")',
        `    rdb.activate(${port})`,
        '    util.AddNetworkString("gm_rdb_exec")',
        '',
        '    local function normalizeRealm(realm)',
        '        realm = string.lower(tostring(realm or "server"))',
        '        if realm ~= "server" and realm ~= "client" and realm ~= "shared" then',
        '            realm = "server"',
        '        end',
        '        return realm',
        '    end',
        '',
        '    local function sendClientExec(kind, payload)',
        '        net.Start("gm_rdb_exec")',
        '        net.WriteString(kind)',
        '        net.WriteString(payload)',
        '        net.Broadcast()',
        '    end',
        '',
        '    local function runServerChunk(code, chunkName)',
        '        local fn, compileErr = CompileString(code, chunkName or "gluals_run_lua", false)',
        '        if not isfunction(fn) then',
        '            return false, tostring(compileErr)',
        '        end',
        '        local ok, runtimeErr = xpcall(fn, debug.traceback)',
        '        if not ok then',
        '            return false, tostring(runtimeErr)',
        '        end',
        '        return true',
        '    end',
        '',
        '    local function includeServerFile(filePath)',
        '        local ok, includeErr = pcall(include, filePath)',
        '        if not ok then',
        '            return false, tostring(includeErr)',
        '        end',
        '        return true',
        '    end',
        '',
        '    local function readServerFileForClient(filePath)',
        '        local content = file.Read(filePath, "LUA")',
        '        if isstring(content) then',
        '            return content',
        '        end',
        '',
        '        content = file.Read("lua/" .. filePath, "GAME")',
        '        if isstring(content) then',
        '            return content',
        '        end',
        '',
        '        return nil, "unable to read file for client execution: " .. filePath',
        '    end',
        '',
        '    function _GLUALS.runLua(realm, code)',
        '        realm = normalizeRealm(realm)',
        '        if type(code) ~= "string" then',
        '            return false, "lua chunk must be a string"',
        '        end',
        '',
        '        if realm == "server" or realm == "shared" then',
        '            local ok, err = runServerChunk(code, "gluals_run_lua")',
        '            if not ok then',
        '                return false, err',
        '            end',
        '        end',
        '',
        '        if realm == "client" or realm == "shared" then',
        '            sendClientExec("lua", code)',
        '        end',
        '',
        '        return true',
        '    end',
        '',
        '    function _GLUALS.runFile(realm, filePath)',
        '        realm = normalizeRealm(realm)',
        '        filePath = tostring(filePath or "")',
        '        if filePath == "" then',
        '            return false, "file path is required"',
        '        end',
        '',
        '        if realm == "server" or realm == "shared" then',
        '            local ok, err = includeServerFile(filePath)',
        '            if not ok then',
        '                return false, err',
        '            end',
        '        end',
        '',
        '        if realm == "client" or realm == "shared" then',
        '            local clientCode, readErr = readServerFileForClient(filePath)',
        '            if not isstring(clientCode) then',
        '                return false, tostring(readErr)',
        '            end',
        '            sendClientExec("lua", clientCode)',
        '        end',
        '',
        '        return true',
        '    end',
        '',
        '    function _GLUALS.refreshFile(filePath)',
        '        filePath = tostring(filePath or "")',
        '        if filePath == "" then',
        '            return false, "file path is required"',
        '        end',
        '',
        '        if not game or not game.ConsoleCommand then',
        '            return false, "game.ConsoleCommand is unavailable"',
        '        end',
        '',
        '        local quotedPath = string.format("%q", filePath)',
        '        game.ConsoleCommand("lua_refresh_file " .. quotedPath .. "\\n")',
        '        return true',
        '    end',
        'end',
        '',
        'if CLIENT then',
        '    net.Receive("gm_rdb_exec", function()',
        '        local kind = net.ReadString()',
        '        local payload = net.ReadString()',
        '        if kind == "lua" then',
        '            local func, err = CompileString(payload, "gluals_client_exec", false)',
        '            if not isfunction(func) then',
        '                ErrorNoHalt("[GLuaLS] Client exec compile error: " .. tostring(err) .. "\\n")',
        '                return',
        '            end',
        '',
        '            local ok, runtimeErr = xpcall(func, debug.traceback)',
        '            if not ok then',
        '                ErrorNoHalt("[GLuaLS] Client exec runtime error: " .. tostring(runtimeErr) .. "\\n")',
        '            end',
        '            return',
        '        end',
        '',
        '        ErrorNoHalt("[GLuaLS] Unknown exec kind: " .. tostring(kind) .. "\\n")',
        '    end)',
        '    if util and util.IsBinaryModuleInstalled and util.IsBinaryModuleInstalled("rdb") then',
        '        local ok, requiredModule = pcall(require, "rdb")',
        '        if ok and istable(requiredModule) and isfunction(requiredModule.activate) then',
        `            requiredModule.activate(${clientPort})`,
        '        elseif ok and istable(rdb_client) and isfunction(rdb_client.activate) then',
        `            rdb_client.activate(${clientPort})`,
        '        else',
        '            ErrorNoHalt("[GLuaLS] Failed to load client debugger module via require(\\"rdb\\").\\n")',
        '        end',
        '    end',
        'end',
        '',
    ].join('\n');
}

export function writeAutorunFile(garrysmodPath: string, port: number, clientPort: number = DEFAULT_RDB_CLIENT_PORT): void {
    syncAutorunFile(garrysmodPath, port, clientPort);
}

export function syncAutorunFile(garrysmodPath: string, port: number, clientPort: number = DEFAULT_RDB_CLIENT_PORT): AutorunSyncStatus {
    const autorunDir = path.join(garrysmodPath, 'lua', 'autorun');
    // the debugger runtime script used to live at sh_luals.lua; we now create debug.lua
    const autorunPath = path.join(autorunDir, 'debug.lua');

    // if an old sh_luals.lua file still exists, remove it so users don't get confused
    const legacyPath = path.join(autorunDir, 'sh_luals.lua');
    if (fs.existsSync(legacyPath) && legacyPath !== autorunPath) {
        try {
            fs.unlinkSync(legacyPath);
        } catch {
            // ignore failures
        }
    }

    const content = buildSharedAutorunLua(port, clientPort);
    const hadExistingFile = fs.existsSync(autorunPath);

    if (hadExistingFile) {
        try {
            const existing = fs.readFileSync(autorunPath, 'utf8');
            if (existing === content) {
                return 'unchanged';
            }
        } catch {
            // Fall through and rewrite the file if it cannot be read.
        }
    }

    fs.mkdirSync(autorunDir, { recursive: true });
    fs.writeFileSync(autorunPath, content, 'utf8');
    return hadExistingFile ? 'updated' : 'created';
}

export function cleanupLegacyInitInjection(garrysmodPath: string): void {
    const initLuaPath = path.join(garrysmodPath, 'lua', 'includes', 'init.lua');
    if (!fs.existsSync(initLuaPath)) {
        return;
    }

    const existing = fs.readFileSync(initLuaPath, 'utf8');
    const start = existing.indexOf(LEGACY_LOADER_START_MARKER);
    if (start < 0) {
        return;
    }

    const end = existing.indexOf(LEGACY_LOADER_END_MARKER, start);
    const cutEnd = end >= 0
        ? end + LEGACY_LOADER_END_MARKER.length
        : start + LEGACY_LOADER_START_MARKER.length;
    const before = existing.slice(0, start);
    const after = existing.slice(cutEnd).replace(/^\s*\r?\n/, '');
    fs.writeFileSync(initLuaPath, `${before}${after}`, 'utf8');
}

async function runGmRdbInstaller(garrysmodPath: string, port: number): Promise<void> {
    const srcdsRoot = path.dirname(garrysmodPath);
    if (!hasSrcdsExecutable(srcdsRoot)) {
        vscode.window.showErrorMessage(
            `Could not find SRCDS executable in ${srcdsRoot}. This path looks like a client install; refusing to install gm_rdb server binary.`
        );
        return;
    }

    const platformItems = Object.entries(GM_RDB_PLATFORM_DLLS).map(([label, dll]) => ({
        label,
        description: dll,
    }));

    if (process.platform === 'win32' || process.platform === 'linux') {
        const detectedIsX64 = isGarrysmodX64(garrysmodPath);
        const detectedIndex = platformItems.findIndex((item) =>
            process.platform === 'win32'
                ? item.description === (detectedIsX64 ? 'gmsv_rdb_win64.dll' : 'gmsv_rdb_win32.dll')
                : item.description === (detectedIsX64 ? 'gmsv_rdb_linux64.dll' : 'gmsv_rdb_linux.dll')
        );
        if (detectedIndex >= 0) {
            const [detectedItem] = platformItems.splice(detectedIndex, 1);
            detectedItem.label = `${detectedItem.label} (detected from garrysmod.ver)`;
            platformItems.unshift(detectedItem);
        }
    }

    if (process.platform === 'darwin') {
        const detectedIndex = platformItems.findIndex((item) => item.description === 'gmsv_rdb_osx64.dll');
        if (detectedIndex >= 0) {
            const [detectedItem] = platformItems.splice(detectedIndex, 1);
            detectedItem.label = `${detectedItem.label} (detected)`;
            platformItems.unshift(detectedItem);
        }
        vscode.window.showWarningMessage(
            'macOS gm_rdb support is experimental. Install only if you are using a compatible macOS Garry\'s Mod/SRCDS setup; Windows/Linux behavior is unchanged.'
        );
    }

    const platformChoice = await vscode.window.showQuickPick(platformItems, {
        title: 'Install gm_rdb — Select Server Platform',
        placeHolder: 'Which platform is your SRCDS (server) running on? (NOT your client)',
        ignoreFocusOut: true,
    });
    if (!platformChoice?.description) {
        return;
    }

    const dllName = platformChoice.description;
    const binDir = path.join(garrysmodPath, 'lua', 'bin');
    const destinationPath = path.join(binDir, dllName);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Installing gm_rdb…',
            cancellable: false,
        },
        async (progress) => {
            progress.report({ message: 'Fetching gm_rdb release…' });
            const release = await fetchReleaseForCurrentExtensionChannel();
            if (!release) {
                throw new Error(
                    'No releases found for gm_rdb (https://github.com/Pollux12/gm_rdb). Build it manually and place the DLL/SO in garrysmod/lua/bin/.'
                );
            }

            const asset = release.assets.find((entry) => entry.name === dllName);
            if (!asset) {
                const available = release.assets.map((entry) => entry.name).join(', ') || '(none)';
                throw new Error(`Release ${release.tag_name} does not include ${dllName}. Available assets: ${available}`);
            }

            progress.report({ message: `Downloading ${dllName} (${release.tag_name})…` });
            fs.mkdirSync(binDir, { recursive: true });
            await downloadFile(asset.browser_download_url, destinationPath, progress);

            progress.report({ message: 'Writing shared debugger autorun file…' });
            writeAutorunFile(garrysmodPath, port, DEFAULT_RDB_CLIENT_PORT);

            progress.report({ message: 'Cleaning up legacy initializations…' });
            cleanupLegacyInitInjection(garrysmodPath);

            progress.report({ message: 'Installation complete!' });
        }
    );

    const macNote = process.platform === 'darwin' ? ' macOS debugger support is experimental; restart SRCDS and verify manually before relying on it.' : '';
    vscode.window.showInformationMessage(`gm_rdb installed to ${destinationPath}.${macNote}`);
}

function getLaunchFileUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
}

export async function readWorkspaceLaunchConfigurations(workspaceFolder: vscode.WorkspaceFolder): Promise<Record<string, unknown>[]> {
    const launchFile = getLaunchFileUri(workspaceFolder);
    try {
        const raw = await vscode.workspace.fs.readFile(launchFile);
        const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
        if (!isRecord(parsed)) {
            return [];
        }
        const configurations = parsed['configurations'];
        if (!Array.isArray(configurations)) {
            return [];
        }
        return configurations.filter(isRecord);
    } catch {
        return [];
    }
}

export async function readAllWorkspaceLaunchConfigurations(): Promise<Record<string, unknown>[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return [];
    }

    const perWorkspace = await Promise.all(folders.map((folder) => readWorkspaceLaunchConfigurations(folder)));
    return perWorkspace.flat();
}

export async function hasAnyGmodDebugConfiguration(): Promise<boolean> {
    const configurations = await readAllWorkspaceLaunchConfigurations();
    return configurations.some((entry) => entry['type'] === GMOD_DEBUGGER_TYPE);
}

async function writeLaunchConfig(workspaceFolder: vscode.WorkspaceFolder, config: DebugConfig): Promise<void> {
    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
    const launchFile = getLaunchFileUri(workspaceFolder);
    await vscode.workspace.fs.createDirectory(vscodeDir);

    let existing: Record<string, unknown> = { version: '0.2.0', configurations: [] };
    try {
        const raw = await vscode.workspace.fs.readFile(launchFile);
        const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
        if (isRecord(parsed)) {
            existing = parsed;
        }
    } catch {
        existing = { version: '0.2.0', configurations: [] };
    }

    const existingConfigurations = Array.isArray(existing['configurations'])
        ? existing['configurations'].filter(isRecord)
        : [];

    const index = existingConfigurations.findIndex(
        (entry) => entry['type'] === config.type && entry['name'] === config.name
    );
    const configRecord: Record<string, unknown> = { ...config };

    if (index >= 0) {
        existingConfigurations[index] = configRecord;
    } else {
        existingConfigurations.push(configRecord);
    }

    existing['configurations'] = existingConfigurations;
    if (typeof existing['version'] !== 'string') {
        existing['version'] = '0.2.0';
    }

    const json = JSON.stringify(existing, null, 4);
    await vscode.workspace.fs.writeFile(launchFile, Uint8Array.from(Buffer.from(json, 'utf8')));
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }

    const picked = await vscode.window.showQuickPick(
        folders.map((folder) => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder,
        })),
        {
            title: 'GMod Debugger Setup — Select Workspace',
            placeHolder: 'Choose the workspace folder to configure',
            ignoreFocusOut: true,
        }
    );

    return picked?.folder;
}

async function promptForSrcdsPath(
    context: vscode.ExtensionContext,
    workspaceDetection: WorkspaceAutoDetection | undefined
): Promise<ResolvedSrcdsPath | undefined> {
    const legacyPath = context.workspaceState.get<string>(LEGACY_GARRYSMOD_PATH_STATE_KEY);
    const legacySrcdsPath = legacyPath ? path.dirname(legacyPath) : undefined;
    const savedSrcdsPath = context.workspaceState.get<string>(SRCDS_ROOT_STATE_KEY) ?? legacySrcdsPath;
    const detectedSrcdsPath = workspaceDetection?.srcdsRoot;

    while (true) {
        const detectedSrcdsPathValid = !!detectedSrcdsPath && hasSrcdsExecutable(detectedSrcdsPath);
        const savedSrcdsPathValid = !!savedSrcdsPath && hasSrcdsExecutable(savedSrcdsPath);

        const options: Array<{ label: string; description: string; value: 'detected' | 'saved' | 'browse' | 'manual' }> = [];
        if (detectedSrcdsPath && detectedSrcdsPathValid) {
            options.push({
                label: `$(check) ${detectedSrcdsPath}`,
                description: 'Detected from workspace location',
                value: 'detected',
            });
        }
        if (savedSrcdsPath && savedSrcdsPathValid && (!detectedSrcdsPath || !samePath(savedSrcdsPath, detectedSrcdsPath))) {
            options.push({
                label: `$(history) ${savedSrcdsPath}`,
                description: 'Previously used SRCDS path',
                value: 'saved',
            });
        }
        options.push(
            {
                label: '$(folder-opened) Browse…',
                description: 'Pick your SRCDS root folder',
                value: 'browse',
            },
            {
                label: '$(edit) Enter path manually…',
                description: 'Type the SRCDS root path (folder containing garrysmod/)',
                value: 'manual',
            }
        );

        const picked = await vscode.window.showQuickPick(options, {
            title: 'GMod Debugger Setup (1/4) — SRCDS Root Path',
            placeHolder: detectedSrcdsPath && !detectedSrcdsPathValid
                ? 'Detected workspace path is not a valid SRCDS root; choose or enter your actual SRCDS path'
                : 'Workspace auto-detection is attempted first; choose or enter SRCDS root if needed',
            ignoreFocusOut: true,
        });
        if (!picked) {
            return undefined;
        }

        let rawPath: string;
        if (picked.value === 'browse') {
            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: 'Select SRCDS Root (folder containing garrysmod)',
            });
            if (!selected?.length) {
                continue;
            }
            rawPath = selected[0].fsPath;
        } else if (picked.value === 'manual') {
            const defaultPath = (savedSrcdsPathValid ? savedSrcdsPath : undefined)
                ?? (detectedSrcdsPathValid ? detectedSrcdsPath : undefined)
                ?? savedSrcdsPath
                ?? detectedSrcdsPath
                ?? (os.platform() === 'win32' ? 'C:\\srcds' : os.platform() === 'darwin' ? path.join(os.homedir(), 'srcds') : '/home/steam/srcds');
            const typed = await vscode.window.showInputBox({
                title: 'SRCDS Root Path',
                prompt: 'Enter the SRCDS root path (the folder that contains garrysmod/)',
                value: defaultPath,
                ignoreFocusOut: true,
            });
            if (typed === undefined) {
                continue;
            }
            if (!typed.trim()) {
                vscode.window.showWarningMessage('Path cannot be empty.');
                continue;
            }
            rawPath = typed.trim();
        } else {
            rawPath = picked.label.replace(/^\$\(\S+\)\s+/, '');
        }

        const resolved = normalizeSrcdsRootInput(rawPath);
        if (!hasSrcdsExecutable(resolved.srcdsRoot)) {
            const action = await vscode.window.showWarningMessage(
                `No SRCDS executable was found in ${resolved.srcdsRoot}. Choose a different path, or continue anyway for custom/symlink setups.`,
                'Choose Different Path',
                'Use Anyway',
                'Cancel Setup'
            );
            if (action === 'Choose Different Path') {
                continue;
            }
            if (action !== 'Use Anyway') {
                return undefined;
            }
        }

        await context.workspaceState.update(SRCDS_ROOT_STATE_KEY, resolved.srcdsRoot);

        if (!fs.existsSync(resolved.garrysmodPath)) {
            vscode.window.showWarningMessage(
                `Could not find a garrysmod folder in ${resolved.srcdsRoot}. The generated config will still use this path.`
            );
        }

        return resolved;
    }
}

function getPreferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    if (activeEditorUri) {
        const folder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
        if (folder) {
            return folder;
        }
    }

    return vscode.workspace.workspaceFolders?.[0];
}

export function getAutoDetectedWorkspaceGarrysmodPath(workspaceFolder: vscode.WorkspaceFolder): string | undefined {
    return detectWorkspaceSrcdsLayout(workspaceFolder)?.garrysmodPath;
}

export function getAutoDetectedClientGarrysmodPath(): string | undefined {
    const detectedClientPath = detectClientGarrysmodInstallPath();
    if (!detectedClientPath) {
        return undefined;
    }

    return normalizeClientInstallInput(detectedClientPath).garrysmodPath;
}

export async function promptForGarrysmodPath(context: vscode.ExtensionContext): Promise<string | undefined> {
    const workspaceFolder = getPreferredWorkspaceFolder();
    const workspaceDetection = workspaceFolder ? detectWorkspaceSrcdsLayout(workspaceFolder) : undefined;
    const selection = await promptForSrcdsPath(context, workspaceDetection);
    return selection?.garrysmodPath;
}

export async function promptForClientGarrysmodPath(context: vscode.ExtensionContext): Promise<string | undefined> {
    const savedClientPath = context.globalState.get<string>(CLIENT_GARRYSMOD_PATH_STATE_KEY);
    const detectedClientPath = detectClientGarrysmodInstallPath();
    const normalizedSavedPath = savedClientPath ? normalizeClientInstallInput(savedClientPath) : undefined;
    const normalizedDetectedPath = detectedClientPath ? normalizeClientInstallInput(detectedClientPath) : undefined;
    const manualDefaultPath = normalizedSavedPath?.gameRoot
        ?? normalizedDetectedPath?.gameRoot
        ?? (os.platform() === 'win32'
            ? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\GarrysMod'
            : os.platform() === 'darwin'
                ? path.join(os.homedir(), 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'GarrysMod')
                : '/home/steam/.steam/steam/steamapps/common/GarrysMod');

    while (true) {
        const detectedValidation = normalizedDetectedPath ? validateClientInstallPath(normalizedDetectedPath.gameRoot) : undefined;
        const savedValidation = normalizedSavedPath ? validateClientInstallPath(normalizedSavedPath.gameRoot) : undefined;
        const options: Array<{ label: string; description: string; value: 'detected' | 'saved' | 'browse' | 'manual' }> = [];
        if (normalizedDetectedPath && detectedValidation && detectedValidation.warnings.length === 0) {
            options.push({
                label: `$(search) ${normalizedDetectedPath.gameRoot}`,
                description: 'Auto-detected from Steam libraries',
                value: 'detected',
            });
        }
        if (
            normalizedSavedPath
            && savedValidation
            && savedValidation.warnings.length === 0
            && (!normalizedDetectedPath || !samePath(normalizedSavedPath.gameRoot, normalizedDetectedPath.gameRoot))
        ) {
            options.push({
                label: `$(history) ${normalizedSavedPath.gameRoot}`,
                description: 'Previously used Garry\'s Mod client path',
                value: 'saved',
            });
        }

        options.push(
            {
                label: '$(folder-opened) Browse…',
                description: 'Pick your Garry\'s Mod game install folder',
                value: 'browse',
            },
            {
                label: '$(edit) Enter path manually…',
                description: 'Type Garry\'s Mod install path (folder containing garrysmod/ and bin/)',
                value: 'manual',
            }
        );

        const picked = await vscode.window.showQuickPick(options, {
            title: 'GMod Client Debugger — Garry\'s Mod Install Path',
            placeHolder: (detectedValidation && detectedValidation.warnings.length > 0)
                ? 'Auto-detected client path did not pass validation; choose or enter the correct client install path'
                : 'Choose the game install root (or garrysmod folder) for client debugger installation',
            ignoreFocusOut: true,
        });
        if (!picked) {
            const cancelAction = await vscode.window.showWarningMessage(
                'Client install path selection was cancelled.',
                'Back to Path Selection',
                'Skip Client Debugger Step'
            );
            if (cancelAction === 'Back to Path Selection') {
                continue;
            }
            return undefined;
        }

        let rawPath: string | undefined;
        if (picked.value === 'browse') {
            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: 'Select Garry\'s Mod Install Folder',
            });
            if (!selected?.length) {
                continue;
            }
            rawPath = selected[0].fsPath;
        } else if (picked.value === 'manual') {
            const typed = await vscode.window.showInputBox({
                title: 'Garry\'s Mod Install Path',
                prompt: 'Enter Garry\'s Mod install path (folder containing garrysmod/ and bin/)',
                value: manualDefaultPath,
                ignoreFocusOut: true,
            });
            if (typed === undefined) {
                continue;
            }
            if (!typed.trim()) {
                vscode.window.showWarningMessage('Path cannot be empty.');
                continue;
            }
            rawPath = typed.trim();
        } else {
            rawPath = picked.label.replace(/^\$\(\S+\)\s+/, '');
        }

        const resolved = normalizeClientInstallInput(rawPath);
        const validation = validateClientInstallPath(resolved.gameRoot);
        if (validation.warnings.length > 0) {
            const action = await vscode.window.showWarningMessage(
                `This path may not be a valid Garry's Mod client install:\n- ${validation.warnings.join('\n- ')}`,
                'Choose Different Path',
                'Use Anyway',
                'Cancel Setup'
            );
            if (action === 'Choose Different Path') {
                continue;
            }
            if (action !== 'Use Anyway') {
                return undefined;
            }
        }

        await context.globalState.update(CLIENT_GARRYSMOD_PATH_STATE_KEY, resolved.gameRoot);

        if (!fs.existsSync(resolved.garrysmodPath)) {
            vscode.window.showWarningMessage(
                `Could not find a garrysmod folder in ${resolved.gameRoot}. Installation will still use ${resolved.garrysmodPath}.`
            );
        }

        return resolved.garrysmodPath;
    }
}

function buildSourceFileMap(sourceRoot: string, workspaceRemotePath: string): Record<string, string> {
    const sourceFileMap: Record<string, string> = {
        [`${sourceRoot}/addons`]: 'addons',
        [`${sourceRoot}/lua`]: 'lua',
        [`${sourceRoot}/gamemodes/base`]: 'gamemodes/base',
        [`${sourceRoot}/gamemodes/sandbox`]: 'gamemodes/sandbox',
        '${workspaceFolder}': workspaceRemotePath,
    };
    return sourceFileMap;
}

function pickLaunchProgram(srcdsRoot: string, srcdsRootExpression?: string): LaunchProgramSelection {
    const executableName = pickLaunchExecutableName(srcdsRoot);
    const executablePath = path.join(srcdsRoot, executableName);

    if (process.platform !== 'win32') {
        if (!ensureExecutableIfPossible(executablePath)) {
            vscode.window.showWarningMessage(
                `Could not make "${executablePath}" executable. The launch configuration may not work correctly — check file permissions.`
            );
        }
    }

    const program = srcdsRootExpression
        ? `${srcdsRootExpression}/${executableName}`
        : executablePath;

    return {
        program,
        usedSrcdsRunFallback: process.platform === 'darwin' && executableName === 'srcds_run',
    };
}

function pickLaunchExecutableName(srcdsRoot: string): string {
    if (process.platform === 'win32') {
        return fs.existsSync(path.join(srcdsRoot, 'srcds_win64.exe')) ? 'srcds_win64.exe' : 'srcds.exe';
    }

    if (process.platform === 'darwin') {
        for (const candidate of ['srcds_osx64', 'srcds_osx']) {
            const candidatePath = path.join(srcdsRoot, candidate);
            if (fs.existsSync(candidatePath) && ensureExecutableIfPossible(candidatePath)) {
                return candidate;
            }
        }

        return 'srcds_run';
    }

    return 'srcds_run';
}

function pickLaunchCwd(srcdsRoot: string, srcdsRootExpression?: string): string {
    return srcdsRootExpression ?? srcdsRoot;
}

interface DebugWizardOptions {
    installClientDebugger?: (garrysmodPath: string) => Promise<void>;
}

async function runOptionalClientDebuggerStep(
    context: vscode.ExtensionContext,
    installClientDebugger?: (garrysmodPath: string) => Promise<void>
): Promise<boolean> {
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: '$(remove) Skip',
                description: 'Default. Do this later using "Check for rdb_client Updates"',
                value: 'skip' as const,
            },
            {
                label: '$(check) Yes',
                description: 'Install or update rdb_client for client-side debugging',
                value: 'yes' as const,
            },
        ],
        {
            title: 'GMod Debugger Setup — Optional Client Debugger Step',
            placeHolder: 'Install client debugger (rdb_client) in your Garry\'s Mod game folder?',
            ignoreFocusOut: true,
        }
    );

    if (!choice || choice.value === 'skip') {
        return false;
    }

    if (!installClientDebugger) {
        vscode.window.showWarningMessage('Client debugger installer is unavailable right now.');
        return false;
    }

    const garrysmodPath = await promptForClientGarrysmodPath(context);
    if (!garrysmodPath) {
        return false;
    }

    await installClientDebugger(garrysmodPath);
    return true;
}

export async function runGmodDebugSetupWizard(context: vscode.ExtensionContext, options?: DebugWizardOptions): Promise<void> {
    const workspaceFolder = await pickWorkspaceFolder();
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
    }

    const workspaceDetection = detectWorkspaceSrcdsLayout(workspaceFolder);
    const srcdsSelection = await promptForSrcdsPath(context, workspaceDetection);
    if (!srcdsSelection) {
        return;
    }

    const useWorkspaceRelativePaths = !!workspaceDetection && samePath(workspaceDetection.srcdsRoot, srcdsSelection.srcdsRoot);
    const sourceRoot = useWorkspaceRelativePaths && workspaceDetection
        ? workspaceDetection.sourceRootExpression
        : srcdsSelection.garrysmodPath;
    const srcdsRootForLaunch = useWorkspaceRelativePaths && workspaceDetection
        ? workspaceDetection.srcdsRootExpression
        : undefined;

    const existingDll = detectGmRdb(srcdsSelection.garrysmodPath);
    if (!existingDll) {
        const installChoice = await vscode.window.showWarningMessage(
            'gm_rdb debugger module was not found in garrysmod/lua/bin/. Install it now?',
            { modal: false },
            'Install',
            'Skip'
        );

        if (installChoice === 'Install') {
            try {
                await runGmRdbInstaller(srcdsSelection.garrysmodPath, DEFAULT_RDB_PORT);
            } catch (error) {
                vscode.window.showErrorMessage(`gm_rdb install failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    } else {
        const latestRelease = await fetchReleaseForCurrentExtensionChannel().catch(() => null);
        const versionInfo = latestRelease ? ` Latest release: ${latestRelease.tag_name}.` : '';
        const updateChoice = await vscode.window.showInformationMessage(
            `gm_rdb (${existingDll}) is already installed.${versionInfo} Update to the latest release?`,
            { modal: false },
            'Update',
            'Skip'
        );

        if (updateChoice === 'Update') {
            try {
                await runGmRdbInstaller(srcdsSelection.garrysmodPath, DEFAULT_RDB_PORT);
            } catch (error) {
                vscode.window.showErrorMessage(`gm_rdb update failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    const serverDebuggerInstalled = !!detectGmRdb(srcdsSelection.garrysmodPath);
    let includeClientAttachConfig = false;
    if (serverDebuggerInstalled) {
        includeClientAttachConfig = await runOptionalClientDebuggerStep(context, options?.installClientDebugger);
    }

    const requestPick = await vscode.window.showQuickPick(
        [
            {
                label: '$(plug) Attach (recommended)',
                description: 'Connect to an already running SRCDS process',
                value: 'attach' as const,
            },
            {
                label: '$(play) Launch',
                description: 'Launch SRCDS directly from VS Code',
                value: 'launch' as const,
            },
        ],
        {
            title: 'GMod Debugger Setup (2/4) — Debug Type',
            placeHolder: 'How should VS Code connect to SRCDS?',
            ignoreFocusOut: true,
        }
    );
    if (!requestPick) {
        return;
    }

    const suggestedWorkspaceRemotePath = workspaceDetection?.workspaceRemotePath ?? buildSuggestedWorkspaceRemotePath(workspaceFolder);
    const mappingPick = await vscode.window.showQuickPick(
        [
            {
                label: `$(check) ${suggestedWorkspaceRemotePath}`,
                description: workspaceDetection
                    ? `Detected from workspace location (${workspaceDetection.kind})`
                    : 'Suggested from workspace name',
                value: 'suggested' as const,
            },
            {
                label: '$(edit) Override…',
                description: 'Enter a custom debugger remote path',
                value: 'custom' as const,
            },
        ],
        {
            title: 'GMod Debugger Setup (3/4) — Workspace Mapping',
            placeHolder: 'Confirm how your workspace maps to the SRCDS filesystem',
            ignoreFocusOut: true,
        }
    );
    if (!mappingPick) {
        return;
    }

    let workspaceRemotePath = suggestedWorkspaceRemotePath;
    if (mappingPick.value === 'custom') {
        const typed = await vscode.window.showInputBox({
            title: 'Workspace Remote Path',
            prompt: 'Path as seen by the debugger (example: addons/my_addon or gamemodes/cityrp)',
            value: suggestedWorkspaceRemotePath,
            ignoreFocusOut: true,
        });
        if (!typed?.trim()) {
            return;
        }
        workspaceRemotePath = toPosixPath(typed.trim().replace(/^\/+/, ''));
    }

    const sourceFileMap = buildSourceFileMap(sourceRoot, workspaceRemotePath);

    const config: DebugConfig = {
        type: GMOD_DEBUGGER_TYPE,
        request: requestPick.value,
        name: requestPick.value === 'attach' ? '[SERVER] Attach to SRCDS' : 'GMod Launch (SRCDS)',
        host: '127.0.0.1',
        port: DEFAULT_RDB_PORT,
        sourceRoot,
        sourceFileMap,
        stopOnEntry: false,
        stopOnError: false,
        realm: 'server',
    };

    if (requestPick.value === 'launch') {
        const launchProgram = pickLaunchProgram(srcdsSelection.srcdsRoot, srcdsRootForLaunch);
        config.program = launchProgram.program;
        config.cwd = pickLaunchCwd(srcdsSelection.srcdsRoot, srcdsRootForLaunch);
        config.args = ['-console', '-game', 'garrysmod', '+map', 'gm_flatgrass'];

        if (launchProgram.usedSrcdsRunFallback) {
            vscode.window.showWarningMessage(
                'Could not find executable srcds_osx64/srcds_osx in the selected SRCDS path. The launch configuration will use srcds_run as a fallback.'
            );
        }
    }

    const preview = JSON.stringify(config, null, 4);
    const confirm = await vscode.window.showInformationMessage(
        'Review your GMod debug configuration.',
        {
            detail: preview,
            modal: true,
        },
        'Write to launch.json',
        'Cancel'
    );
    if (confirm !== 'Write to launch.json') {
        return;
    }

    await writeLaunchConfig(workspaceFolder, config);

    if (includeClientAttachConfig) {
        const clientConfig: DebugConfig = {
            type: GMOD_CLIENT_DEBUGGER_TYPE,
            request: 'attach',
            name: '[CLIENT] Attach to Gmod',
            host: '127.0.0.1',
            port: DEFAULT_RDB_CLIENT_PORT,
            sourceRoot,
            sourceFileMap,
            stopOnEntry: true,
            stopOnError: false,
        };
        await writeLaunchConfig(workspaceFolder, clientConfig);
    }

    const openLaunch = await vscode.window.showInformationMessage(
        'GMod debug configuration written to .vscode/launch.json.',
        'Open launch.json'
    );
    if (openLaunch === 'Open launch.json') {
        const document = await vscode.workspace.openTextDocument(getLaunchFileUri(workspaceFolder));
        await vscode.window.showTextDocument(document);
    }

    if (requestPick.value === 'attach' && !existingDll) {
        vscode.window.showInformationMessage('If gm_rdb was just installed, restart SRCDS before attaching.');
    }
}

export function getStoredGarrysmodPath(context: vscode.ExtensionContext): string | undefined {
    const legacyPath = context.workspaceState.get<string>(LEGACY_GARRYSMOD_PATH_STATE_KEY);
    const legacySrcdsPath = legacyPath ? path.dirname(legacyPath) : undefined;
    const savedSrcdsPath = context.workspaceState.get<string>(SRCDS_ROOT_STATE_KEY) ?? legacySrcdsPath;
    if (!savedSrcdsPath || savedSrcdsPath.trim().length === 0) {
        return undefined;
    }

    return normalizeSrcdsRootInput(savedSrcdsPath).garrysmodPath;
}

export function getStoredClientGarrysmodPath(context: vscode.ExtensionContext): string | undefined {
    const savedPath = context.globalState.get<string>(CLIENT_GARRYSMOD_PATH_STATE_KEY);
    if (!savedPath || savedPath.trim().length === 0) {
        return undefined;
    }

    return normalizeClientInstallInput(savedPath).garrysmodPath;
}
