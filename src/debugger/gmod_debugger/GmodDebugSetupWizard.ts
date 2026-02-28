import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fetchJson, downloadFile } from '../../netHelpers';

const SRCDS_ROOT_STATE_KEY = 'gluals.gmod.srcdsRootPath';
const LEGACY_GARRYSMOD_PATH_STATE_KEY = 'gluals.gmod.garrysmodPath';
const GMOD_DEBUGGER_TYPE = 'gluals_gmod';
const GM_RDB_REPO = 'Pollux12/gm_rdb';
export const DEFAULT_RDB_PORT = 21111;
const LEGACY_LOADER_START_MARKER = '-- gm_rdb debugger loader (added by GLuaLS)';
const LEGACY_LOADER_END_MARKER = '-- end gm_rdb';

const GM_RDB_PLATFORM_DLLS: Record<string, string> = {
    'Windows 64-bit': 'gmsv_rdb_win64.dll',
    'Windows 32-bit (default SRCDS)': 'gmsv_rdb_win32.dll',
    'Linux 64-bit': 'gmsv_rdb_linux64.dll',
    'Linux 32-bit (default SRCDS)': 'gmsv_rdb_linux.dll',
};

const ALL_RDB_DLLS = Object.values(GM_RDB_PLATFORM_DLLS);

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
    realm: string;
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

function normalizeSrcdsRootInput(rawPath: string): ResolvedSrcdsPath {
    const resolved = path.resolve(rawPath.trim());
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

function detectGmRdb(garrysmodPath: string): string | undefined {
    const binDir = path.join(garrysmodPath, 'lua', 'bin');
    if (!fs.existsSync(binDir)) {
        return undefined;
    }

    for (const dllName of ALL_RDB_DLLS) {
        if (fs.existsSync(path.join(binDir, dllName))) {
            return dllName;
        }
    }

    return undefined;
}

export async function fetchLatestRelease(): Promise<GmRdbRelease | null> {
    try {
        return await fetchJson<GmRdbRelease>(`https://api.github.com/repos/${GM_RDB_REPO}/releases/latest`, {
            headers: {
                Accept: 'application/vnd.github.v3+json',
            },
        });
    } catch {
        return null;
    }
}

function buildSharedAutorunLua(port: number): string {
    return [
        '-- [GLuaLS] Auto-managed by GLuaLS extension. Do not edit.',
        '_GLUALS = _GLUALS or {}',
        '',
        'if SERVER then',
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
        'end',
        '',
    ].join('\n');
}

export function writeAutorunFile(garrysmodPath: string, port: number): void {
    syncAutorunFile(garrysmodPath, port);
}

export function syncAutorunFile(garrysmodPath: string, port: number): AutorunSyncStatus {
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

    const content = buildSharedAutorunLua(port);
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
    const platformItems = Object.entries(GM_RDB_PLATFORM_DLLS).map(([label, dll]) => ({
        label,
        description: dll,
    }));

    const platformChoice = await vscode.window.showQuickPick(platformItems, {
        title: 'Install gm_rdb — Select Platform',
        placeHolder: 'Which platform is your SRCDS running on?',
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
            progress.report({ message: 'Fetching latest release…' });
            const release = await fetchLatestRelease();
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
            writeAutorunFile(garrysmodPath, port);

            progress.report({ message: 'Cleaning up legacy initializations…' });
            cleanupLegacyInitInjection(garrysmodPath);

            progress.report({ message: 'Installation complete!' });
        }
    );

    vscode.window.showInformationMessage(`gm_rdb installed to ${destinationPath}.`);
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
        (entry) => entry['type'] === GMOD_DEBUGGER_TYPE && entry['name'] === config.name
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

    const options: Array<{ label: string; description: string; value: 'detected' | 'saved' | 'browse' | 'manual' }> = [];
    if (detectedSrcdsPath) {
        options.push({
            label: `$(check) ${detectedSrcdsPath}`,
            description: 'Detected from workspace location',
            value: 'detected',
        });
    }
    if (savedSrcdsPath && (!detectedSrcdsPath || !samePath(savedSrcdsPath, detectedSrcdsPath))) {
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
        placeHolder: 'Workspace auto-detection is attempted first; choose or enter SRCDS root if needed',
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
            return undefined;
        }
        rawPath = selected[0].fsPath;
    } else if (picked.value === 'manual') {
        const defaultPath = savedSrcdsPath ?? detectedSrcdsPath ?? (os.platform() === 'win32' ? 'C:\\srcds' : '/home/steam/srcds');
        const typed = await vscode.window.showInputBox({
            title: 'SRCDS Root Path',
            prompt: 'Enter the SRCDS root path (the folder that contains garrysmod/)',
            value: defaultPath,
            ignoreFocusOut: true,
        });
        if (!typed?.trim()) {
            return undefined;
        }
        rawPath = typed.trim();
    } else {
        const stripped = picked.label.replace(/^\$\(\S+\)\s+/, '');
        rawPath = stripped;
    }

    const resolved = normalizeSrcdsRootInput(rawPath);
    await context.workspaceState.update(SRCDS_ROOT_STATE_KEY, resolved.srcdsRoot);

    if (!fs.existsSync(resolved.garrysmodPath)) {
        vscode.window.showWarningMessage(
            `Could not find a garrysmod folder in ${resolved.srcdsRoot}. The generated config will still use this path.`
        );
    }

    return resolved;
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

export async function promptForGarrysmodPath(context: vscode.ExtensionContext): Promise<string | undefined> {
    const workspaceFolder = getPreferredWorkspaceFolder();
    const workspaceDetection = workspaceFolder ? detectWorkspaceSrcdsLayout(workspaceFolder) : undefined;
    const selection = await promptForSrcdsPath(context, workspaceDetection);
    return selection?.garrysmodPath;
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

function pickLaunchProgram(srcdsRoot: string, srcdsRootExpression?: string): string {
    const executableName = process.platform === 'win32'
        ? (fs.existsSync(path.join(srcdsRoot, 'srcds_win64.exe')) ? 'srcds_win64.exe' : 'srcds.exe')
        : 'srcds_run';

    if (srcdsRootExpression) {
        return `${srcdsRootExpression}/${executableName}`;
    }

    return path.join(srcdsRoot, executableName);
}

function pickLaunchCwd(srcdsRoot: string, srcdsRootExpression?: string): string {
    return srcdsRootExpression ?? srcdsRoot;
}

export async function runGmodDebugSetupWizard(context: vscode.ExtensionContext): Promise<void> {
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
    }

    const requestPick = await vscode.window.showQuickPick(
        [
            {
                label: '$(plug) Attach',
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
        name: requestPick.value === 'attach' ? 'GMod Attach (SRCDS)' : 'GMod Launch (SRCDS)',
        host: '127.0.0.1',
        port: DEFAULT_RDB_PORT,
        sourceRoot,
        sourceFileMap,
        stopOnEntry: false,
        stopOnError: false,
        realm: '${config:gluals.gmod.debugRealm}',
    };

    if (requestPick.value === 'launch') {
        config.program = pickLaunchProgram(srcdsSelection.srcdsRoot, srcdsRootForLaunch);
        config.cwd = pickLaunchCwd(srcdsSelection.srcdsRoot, srcdsRootForLaunch);
        config.args = ['-console', '-game', 'garrysmod', '+map', 'gm_flatgrass'];
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