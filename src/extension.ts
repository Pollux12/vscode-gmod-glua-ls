import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as process from 'process';
import * as os from 'os';
import * as fs from 'fs';

import { LanguageClient, LanguageClientOptions, ServerOptions, StreamInfo } from 'vscode-languageclient/node';
import { LuaLanguageConfiguration } from './languageConfiguration';
import { EmmyContext } from './emmyContext';
import { IServerLocation, IServerPosition } from './lspExtension';
import { onDidChangeConfiguration } from './annotator';
import { ConfigurationManager } from './configManager';
import * as Annotator from './annotator';
import { EmmyrcSchemaContentProvider } from './emmyrcSchemaContentProvider';
import { SyntaxTreeManager, setClientGetter } from './syntaxTreeProvider';
import { registerTerminalLinkProvider } from './luaTerminalLinkProvider';
import { insertEmmyDebugCode, registerDebuggers } from './debugger';
import { GmodAnnotationManager } from './gmodAnnotationManager';
import { GMOD_REALMS, GmodControlResult, GmodRealm, normalizeGmodRealm } from './debugger/gmod_debugger/GmodDebugControlService';
import { GmodMcpHost } from './gmodMcpHost';
import { GmodExplorerProvider, registerGmodExplorer } from './gmodExplorer';
import { GmodRealmProvider, registerGmodRealmView } from './gmodRealmView';
import { GluarcSettingsPanel } from './gluarcSettingsPanel';
import { scaffoldNewScriptedClass } from './gmodScaffolding';
import { GluaDocSearchTool } from './tools/gluaDocSearchTool';
import { GmodGetDebugStateTool } from './tools/gmodGetDebugStateTool';
import { GmodGetErrorsTool } from './tools/gmodGetErrorsTool';
import { GmodGetOutputTool } from './tools/gmodGetOutputTool';
import { GmodRunCommandTool } from './tools/gmodRunCommandTool';
import { GmodRunFileTool } from './tools/gmodRunFileTool';
import { GmodRunLuaTool } from './tools/gmodRunLuaTool';
import { GmodRdbUpdater } from './debugger/gmod_debugger/GmodRdbUpdater';
import {
    hasAnyGmodDebugConfiguration,
    readAllWorkspaceLaunchConfigurations,
    runGmodDebugSetupWizard,
} from './debugger/gmod_debugger/GmodDebugSetupWizard';

/**
 * Command registration entry
 */
interface CommandEntry {
    readonly id: string;
    readonly handler: (...args: any[]) => any;
}

// Global state
export let extensionContext: EmmyContext;
let activeEditor: vscode.TextEditor | undefined;

let syntaxTreeManager: SyntaxTreeManager | undefined;
let gmodAnnotationManager: GmodAnnotationManager | undefined;
let gmodRdbUpdater: GmodRdbUpdater | undefined;
let gmodMcpHost: GmodMcpHost | undefined;
let gmodExplorerProvider: GmodExplorerProvider | undefined;
let gmodRealmProvider: GmodRealmProvider | undefined;
let hasGmodDebugConfiguration = false;
const gmodSessionRealms = new Map<string, GmodRealm>();
const GMOD_REALM_WORKSPACE_KEY_PREFIX = 'gluals.gmod.realm.workspace.';
const GMOD_DEBUG_CONFIG_CONTEXT_KEY = 'gluals.gmod.hasDebugConfig';
const GMOD_DEBUG_SETUP_CONTEXT_KEY = 'gluals.gmod.needsDebugSetup';
const GMOD_TOOL_LOG_MAX_SIZE = 1000;

interface GmodToolLogEntry {
    readonly timestamp: string;
    readonly source: string;
    readonly level: 'info' | 'error';
    readonly message: string;
    readonly metadata?: Record<string, unknown>;
}

const gmodToolOutputEntries: GmodToolLogEntry[] = [];
const gmodToolErrorEntries: GmodToolLogEntry[] = [];

/**
 * Extension activation entry point
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('GLuaLS extension activated!');

    // Provide `.emmyrc.json` schema with i18n support
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            'emmyrc-schema',
            new EmmyrcSchemaContentProvider(context)
        )
    );

    // Initialize extension context
    extensionContext = new EmmyContext(
        isDevelopmentMode(context),
        context
    );

    // Register all components
    registerCommands(context);
    registerEventListeners(context);
    registerLanguageConfiguration(context);
    registerDebugConfigurationProviders(context);
    registerTerminalLinkProvider(context);

    // Initialize features
    await initializeExtension();
}

/**
 * Extension deactivation
 */
export async function deactivate(): Promise<void> {
    if (gmodMcpHost) {
        await gmodMcpHost.stop();
        gmodMcpHost.dispose();
        gmodMcpHost = undefined;
    }
    extensionContext?.dispose();
    Annotator.dispose();
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
    const commandEntries: CommandEntry[] = [
        // Server commands
        { id: 'gluals.stopServer', handler: stopServer },
        { id: 'gluals.restartServer', handler: restartServer },
        { id: 'gluals.showServerMenu', handler: showServerMenu },
        { id: 'gluals.showReferences', handler: showReferences },
        { id: 'gluals.showSyntaxTree', handler: showSyntaxTree },
        // debugger commands
        { id: 'gluals.insertEmmyDebugCode', handler: insertEmmyDebugCode },
        // GMod annotations commands
        { id: 'gluals.gmod.updateAnnotations', handler: updateGmodAnnotations },
        { id: 'gluals.gmod.removeAnnotations', handler: removeGmodAnnotations },
        { id: 'gmodRdb.checkForUpdates', handler: checkForGmodRdbUpdates },
        { id: 'gluals.gmod.openSettings', handler: async () => await GluarcSettingsPanel.createOrShow(context) },
        { id: 'gluals.gmod.createSettings', handler: async (uri?: vscode.Uri) => await GluarcSettingsPanel.createOrShow(context, uri) },
        { id: 'gluals.gmod.editSettings', handler: async (uri?: vscode.Uri) => await GluarcSettingsPanel.createOrShow(context, uri) },
        // GMod debug control commands
        { id: 'gluals.gmod.pauseSoft', handler: () => runGmodControlCommand('pauseSoft') },
        { id: 'gluals.gmod.pauseNow', handler: () => runGmodControlCommand('pauseNow') },
        { id: 'gluals.gmod.resume', handler: () => runGmodControlCommand('resume') },
        { id: 'gluals.gmod.breakHere', handler: () => runGmodControlCommand('breakHere') },
        { id: 'gluals.gmod.waitIDE', handler: () => runGmodControlCommand('waitIDE') },
        { id: 'gluals.gmod.runLua', handler: runGmodRunLua },
        { id: 'gluals.gmod.runFile', handler: runGmodRunFile },
        { id: 'gluals.gmod.runCommand', handler: runGmodRunCommand },
        { id: 'gluals.gmod.setRealm', handler: setGmodRealm },
        { id: 'gluals.gmod.explorer.refresh', handler: refreshGmodExplorer },
        { id: 'gluals.gmod.scaffold.new', handler: (treeItemOrUri?: any) => scaffoldNewScriptedClass(treeItemOrUri, context) },
        { id: 'gluals.gmod.onboarding.start', handler: runGmodOnboarding },
        { id: 'gluals.gmod.diagnostics.repair', handler: runGmodDiagnosticsRepair },
        { id: 'gluals.gmod.mcp.startHost', handler: startGmodMcpHost },
        { id: 'gluals.gmod.mcp.stopHost', handler: stopGmodMcpHost },
        { id: 'gluals.gmod.mcp.restartHost', handler: restartGmodMcpHost },
        { id: 'gluals.gmod.mcp.healthCheck', handler: healthCheckGmodMcpHost },
        { id: 'gluals.gmod.configureDebugger', handler: configureGmodDebugger },
    ];

    // Register all commands
    const commands = commandEntries.map(({ id, handler }) =>
        vscode.commands.registerCommand(id, handler)
    );

    context.subscriptions.push(...commands);
}

/**
 * Register event listeners
 */
function registerEventListeners(context: vscode.ExtensionContext): void {
    const eventListeners = [
        vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        vscode.workspace.onDidChangeConfiguration(onConfigurationChanged),
        vscode.workspace.onDidChangeWorkspaceFolders(onWorkspaceFoldersChanged),
        vscode.debug.onDidStartDebugSession(onDidStartDebugSession),
        vscode.debug.onDidTerminateDebugSession(onDidTerminateDebugSession),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(onDidReceiveDebugSessionCustomEvent),
    ];

    const launchConfigWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/launch.json');
    const refreshDebuggerSetupState = () => {
        void refreshGmodDebugConfigContext();
    };

    context.subscriptions.push(
        launchConfigWatcher,
        launchConfigWatcher.onDidCreate(refreshDebuggerSetupState),
        launchConfigWatcher.onDidChange(refreshDebuggerSetupState),
        launchConfigWatcher.onDidDelete(refreshDebuggerSetupState)
    );

    context.subscriptions.push(...eventListeners);
}

/**
 * Register language configuration
 */
function registerLanguageConfiguration(context: vscode.ExtensionContext): void {
    const languageConfig = vscode.languages.setLanguageConfiguration(
        'lua',
        new LuaLanguageConfiguration()
    );

    context.subscriptions.push(languageConfig);
}

function registerDebugConfigurationProviders(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            'gluals_gmod',
            {
                provideDebugConfigurations(): vscode.DebugConfiguration[] {
                    return [];
                }
            },
            vscode.DebugConfigurationProviderTriggerKind.Initial
        )
    );
}

/**
 * Initialize all extension features
 */
async function initializeExtension(): Promise<void> {
    // Initialize GMod annotation manager
    gmodAnnotationManager = new GmodAnnotationManager(extensionContext.vscodeContext);
    gmodRdbUpdater = new GmodRdbUpdater(extensionContext.vscodeContext);

    // Initialize annotations before starting server
    await gmodAnnotationManager.initializeAnnotations();

    // Initialize syntax tree manager
    syntaxTreeManager = new SyntaxTreeManager();
    extensionContext.vscodeContext.subscriptions.push(syntaxTreeManager);

    // Set up client getter for syntax tree provider
    setClientGetter(() => extensionContext.client);

    await startServer();
    if (typeof vscode.lm.registerTool === 'function') {
        const controlToolCallbacks = {
            executeControlCommand: executeGmodControlCommand,
            getDebugState: getGmodDebugState,
            getCurrentRealm: getPersistedGmodRealm,
        };
        extensionContext.vscodeContext.subscriptions.push(
            vscode.lm.registerTool(
                'search_glua_docs',
                new GluaDocSearchTool(() => extensionContext.client)
            ),
            vscode.lm.registerTool(
                'gmod_run_lua',
                new GmodRunLuaTool(controlToolCallbacks)
            ),
            vscode.lm.registerTool(
                'gmod_run_command',
                new GmodRunCommandTool(controlToolCallbacks)
            ),
            vscode.lm.registerTool(
                'gmod_run_file',
                new GmodRunFileTool(controlToolCallbacks)
            ),
            vscode.lm.registerTool(
                'gmod_get_output',
                new GmodGetOutputTool({
                    getOutput: getRecentGmodOutputEntries,
                })
            ),
            vscode.lm.registerTool(
                'gmod_get_errors',
                new GmodGetErrorsTool({
                    getErrors: getRecentGmodErrorEntries,
                })
            ),
            vscode.lm.registerTool(
                'gmod_get_debug_state',
                new GmodGetDebugStateTool(getGmodDebugStateForTool)
            )
        );
    } else {
        console.warn('vscode.lm.registerTool is unavailable; skipping GLua docs tool registration.');
    }
    registerDebuggers();
    initializeGmodExplorer(extensionContext.vscodeContext);
    initializeGmodRealmView(extensionContext.vscodeContext);
    await refreshGmodDebugConfigContext();
    initializeGmodMcpHost(extensionContext.vscodeContext);
    await startGmodMcpHost(false);
}

function onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('gluals')) {
        onDidChangeConfiguration();
    }
    if (e.affectsConfiguration('gluals.gmod.mcp')) {
        void restartGmodMcpHost(false);
    }
}

function onWorkspaceFoldersChanged(): void {
    onDidChangeConfiguration();
    void refreshGmodDebugConfigContext();
}

function onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
    if (activeEditor &&
        activeEditor.document === event.document &&
        activeEditor.document.languageId === extensionContext.LANGUAGE_ID &&
        extensionContext.client
    ) {
        Annotator.requestAnnotators(activeEditor, extensionContext.client);
    }
}

function onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined): void {
    if (editor &&
        editor.document.languageId === extensionContext.LANGUAGE_ID &&
        extensionContext.client
    ) {
        activeEditor = editor;
        Annotator.requestAnnotators(activeEditor, extensionContext.client);
    }
}


async function startServer(): Promise<void> {
    try {
        extensionContext.setServerStarting();
        await doStartServer();
        extensionContext.setServerRunning();
        onDidChangeActiveTextEditor(vscode.window.activeTextEditor);
    } catch (reason) {
        const errorMessage = reason instanceof Error ? reason.message : String(reason);
        extensionContext.setServerError(
            'Failed to start GLua Language Server',
            errorMessage
        );
        vscode.window.showErrorMessage(
            `Failed to start GLua Language Server: ${errorMessage}`,
            'Retry',
            'Show Logs'
        ).then(action => {
            if (action === 'Retry') {
                restartServer();
            } else if (action === 'Show Logs') {
                extensionContext.client?.outputChannel?.show();
            }
        });
    }
}

/**
 * Start the language server
 */
async function doStartServer(): Promise<void> {
    const context = extensionContext.vscodeContext;
    const configManager = new ConfigurationManager(getConfigurationScope());

    // Prepare initialization options with GMod annotations path if available
    const initOptions: Record<string, any> = {};
    if (gmodAnnotationManager) {
        const annotationsPath = gmodAnnotationManager.getAnnotationsPath();
        if (annotationsPath) {
            initOptions.gmodAnnotationsPath = annotationsPath;
        }
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: extensionContext.LANGUAGE_ID }],
        initializationOptions: initOptions,
    };

    let serverOptions: ServerOptions;
    const debugPort = configManager.getDebugPort();

    if (debugPort) {
        // Connect to language server via socket (debug mode)
        serverOptions = createDebugServerOptions(debugPort);
    } else {
        // Start language server as external process
        serverOptions = createProcessServerOptions(context, configManager);
    }

    extensionContext.client = new LanguageClient(
        extensionContext.LANGUAGE_ID,
        'GLua Language Server',
        serverOptions,
        clientOptions
    );

    await extensionContext.client.start();
    console.log('GLua Language Server started successfully');
}

function getConfigurationScope(): vscode.ConfigurationScope | undefined {
    return vscode.window.activeTextEditor?.document.uri;
}

function isDevelopmentMode(context: vscode.ExtensionContext): boolean {
    return context.extensionMode === vscode.ExtensionMode.Development || process.env['EMMY_DEV'] === 'true';
}

/**
 * Create server options for debug mode (socket connection)
 */
function createDebugServerOptions(port: number): ServerOptions {
    return () => {
        const socket = net.connect({ port });
        const result: StreamInfo = {
            writer: socket,
            reader: socket as NodeJS.ReadableStream
        };

        socket.on('close', () => {
            console.error(`Language server connection closed (port ${port})`);
        });

        socket.on('error', (error) => {
            console.error(`Language server connection error:`, error);
        });

        return Promise.resolve(result);
    };
}

/**
 * Create server options for process mode
 */
function createProcessServerOptions(
    context: vscode.ExtensionContext,
    configManager: ConfigurationManager
): ServerOptions {
    const executablePath = resolveExecutablePath(context, configManager);
    const startParameters = configManager.getStartParameters();
    const globalConfigPath = configManager.getGlobalConfigPath();

    const serverOptions: ServerOptions = {
        command: executablePath,
        args: startParameters,
        options: { env: { ...process.env } }
    };

    // Set global config path if specified
    if (globalConfigPath?.trim()) {
        if (!serverOptions.options) {
            serverOptions.options = { env: {} };
        }
        if (!serverOptions.options.env) {
            serverOptions.options.env = {};
        }
        serverOptions.options.env['GLUALS_CONFIG'] = globalConfigPath;
    }

    return serverOptions;
}

/**
 * Resolve the language server executable path
 */
function resolveExecutablePath(
    context: vscode.ExtensionContext,
    configManager: ConfigurationManager
): string {
    let executablePath = configManager.getExecutablePath()?.trim();

    if (!executablePath && extensionContext.debugMode) {
        executablePath = resolveDevLocalExecutablePath(context);
    }

    if (!executablePath) {
        // Use bundled language server
        const platform = os.platform();
        const executableName = platform === 'win32' ? 'emmylua_ls.exe' : 'emmylua_ls';
        executablePath = path.join(context.extensionPath, 'server', executableName);
        // Make executable on Unix-like systems
        if (platform !== 'win32') {
            try {
                fs.chmodSync(executablePath, '777');
            } catch (error) {
                console.warn(`Failed to chmod language server:`, error);
            }
        }
    }

    return executablePath;
}

function resolveDevLocalExecutablePath(context: vscode.ExtensionContext): string | undefined {
    const platform = os.platform();
    const executableName = platform === 'win32' ? 'emmylua_ls.exe' : 'emmylua_ls';
    const envPath = process.env['EMMY_DEV_LS_PATH']?.trim();

    const candidates: string[] = [];
    if (envPath) {
        candidates.push(path.normalize(envPath));
    }

    candidates.push(
        path.resolve(context.extensionPath, '..', 'emmylua-analyzer-rust', 'target', 'debug', executableName),
        path.resolve(context.extensionPath, '..', 'emmylua-analyzer-rust', 'target', 'release', executableName)
    );

    for (const candidatePath of candidates) {
        if (fs.existsSync(candidatePath)) {
            if (platform !== 'win32') {
                try {
                    fs.chmodSync(candidatePath, '777');
                } catch (error) {
                    console.warn(`Failed to chmod dev language server:`, error);
                }
            }

            console.log(`Using dev language server executable: ${candidatePath}`);
            return candidatePath;
        }
    }

    return undefined;
}

async function restartServer(): Promise<void> {
    const client = extensionContext.client;
    if (!client) {
        await startServer();
    } else {
        extensionContext.setServerStopping('Restarting server...');
        try {
            if (client.isRunning()) {
                await client.stop();
            }
            await startServer();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            extensionContext.setServerError('Failed to restart server', errorMessage);
            vscode.window.showErrorMessage(`Failed to restart server: ${errorMessage}`);
        }
    }
}

function showServerMenu(): void {
    extensionContext.showServerMenu();
}

function showReferences(uri: string, pos: IServerPosition, locations: IServerLocation[]) {
    const u = vscode.Uri.parse(uri);
    const p = new vscode.Position(pos.line, pos.character);
    const vscodeLocations = locations.map(loc =>
        new vscode.Location(
            vscode.Uri.parse(loc.uri),
            new vscode.Range(
                new vscode.Position(loc.range.start.line, loc.range.start.character),
                new vscode.Position(loc.range.end.line, loc.range.end.character)
            )));
    vscode.commands.executeCommand("editor.action.showReferences", u, p, vscodeLocations);
}

async function stopServer(): Promise<void> {
    try {
        await extensionContext.stopServer();
        vscode.window.showInformationMessage('GLua Language Server stopped');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to stop server: ${errorMessage}`);
    }
}


/**
 * Show syntax tree for current document
 * Similar to rust-analyzer's "View Syntax Tree" feature
 */
async function showSyntaxTree(): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const document = editor.document;

    if (document.languageId !== extensionContext.LANGUAGE_ID) {
        vscode.window.showWarningMessage('Current file is not a Lua file');
        return;
    }

    if (!extensionContext.client) {
        vscode.window.showWarningMessage('Language server is not running');
        return;
    }

    if (!syntaxTreeManager) {
        vscode.window.showErrorMessage('Syntax tree manager is not initialized');
        return;
    }

    // Show syntax tree using the manager
    await syntaxTreeManager.show(document.uri, editor.selection);
}

/**
 * Update GMod annotations
 */
async function updateGmodAnnotations(): Promise<void> {
    if (!gmodAnnotationManager) {
        vscode.window.showErrorMessage('GMod annotation manager not initialized');
        return;
    }
    await gmodAnnotationManager.updateAnnotations();
}

/**
 * Remove GMod annotations
 */
async function removeGmodAnnotations(): Promise<void> {
    if (!gmodAnnotationManager) {
        vscode.window.showErrorMessage('GMod annotation manager not initialized');
        return;
    }
    await gmodAnnotationManager.removeAnnotations();
}

async function checkForGmodRdbUpdates(): Promise<void> {
    if (!gmodRdbUpdater) {
        vscode.window.showErrorMessage('gm_rdb updater is not initialized');
        return;
    }

    await gmodRdbUpdater.runManualUpdateCommand();
}

type GmodControlCommand =
    | 'pauseSoft'
    | 'pauseNow'
    | 'resume'
    | 'breakHere'
    | 'waitIDE'
    | 'runLua'
    | 'runFile'
    | 'runCommand'
    | 'setRealm';

function getActiveGmodDebugSession(): vscode.DebugSession | undefined {
    const session = vscode.debug.activeDebugSession;
    if (session?.type === 'gluals_gmod') {
        return session;
    }
    return undefined;
}

function getGmodRealmWorkspaceFolder(session?: vscode.DebugSession): vscode.WorkspaceFolder | undefined {
    const activeSession = session?.type === 'gluals_gmod' ? session : getActiveGmodDebugSession();
    if (activeSession?.workspaceFolder) {
        return activeSession.workspaceFolder;
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (folder) {
            return folder;
        }
    }
    return vscode.workspace.workspaceFolders?.[0];
}

function getGmodRealmWorkspaceStateKey(folder: vscode.WorkspaceFolder): string {
    return `${GMOD_REALM_WORKSPACE_KEY_PREFIX}${folder.uri.toString()}`;
}

function getPersistedGmodRealm(session?: vscode.DebugSession): GmodRealm {
    const activeSession = session?.type === 'gluals_gmod' ? session : getActiveGmodDebugSession();
    if (activeSession) {
        const sessionRealm = gmodSessionRealms.get(activeSession.id);
        if (sessionRealm) {
            return sessionRealm;
        }
    }
    const folder = getGmodRealmWorkspaceFolder(activeSession);
    if (folder) {
        const storedRealm = extensionContext.vscodeContext.workspaceState.get<string>(getGmodRealmWorkspaceStateKey(folder));
        if (storedRealm) {
            return normalizeGmodRealm(storedRealm);
        }
    }
    const configured = vscode.workspace
        .getConfiguration('gluals.gmod', folder)
        .get<string>('debugRealm');
    return normalizeGmodRealm(configured);
}

async function runGmodControlCommand(command: GmodControlCommand, args: Record<string, unknown> = {}): Promise<void> {
    try {
        await executeGmodControlCommand(command, args);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`GMod debug command "${command}" failed: ${errorMessage}`);
    }
}

async function executeGmodControlCommand(command: GmodControlCommand, args: Record<string, unknown> = {}): Promise<GmodControlResult> {
    const session = getActiveGmodDebugSession();
    if (!session) {
        throw new Error('No active GMod debug session.');
    }

    const realmAwareCommands: GmodControlCommand[] = ['breakHere', 'waitIDE', 'runLua', 'runFile', 'setRealm'];
    const payload = realmAwareCommands.includes(command)
        ? { realm: getPersistedGmodRealm(session), ...args }
        : args;
    const response = await session.customRequest('gmod.control', { command, ...payload });
    return response as GmodControlResult;
}

async function runGmodRunLua(): Promise<void> {
    const lua = await vscode.window.showInputBox({
        title: 'Run Lua in Garry\'s Mod',
        prompt: 'Enter Lua code to execute',
        ignoreFocusOut: true
    });
    if (!lua) {
        return;
    }

    await runGmodControlCommand('runLua', { lua });
}

async function runGmodRunFile(uri?: vscode.Uri): Promise<void> {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri?.fsPath) {
        vscode.window.showWarningMessage('No Lua file selected.');
        return;
    }
    await runGmodControlCommand('runFile', { path: targetUri.fsPath });
}

async function runGmodRunCommand(): Promise<void> {
    const command = await vscode.window.showInputBox({
        title: 'Run Garry\'s Mod Console Command',
        prompt: 'Enter console command',
        ignoreFocusOut: true
    });
    if (!command) {
        return;
    }

    await runGmodControlCommand('runCommand', { command });
}

async function setGmodRealm(realm?: string): Promise<void> {
    const pickedRealm = realm ?? await vscode.window.showQuickPick(
        [...GMOD_REALMS],
        {
            title: 'Select Garry\'s Mod Debug Realm',
            placeHolder: `Current: ${getPersistedGmodRealm()}`
        }
    );
    if (!pickedRealm) {
        return;
    }
    const selectedRealm = normalizeGmodRealm(pickedRealm);
    const session = getActiveGmodDebugSession();
    const folder = getGmodRealmWorkspaceFolder(session);
    const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Workspace;
    await vscode.workspace
        .getConfiguration('gluals.gmod', folder)
        .update('debugRealm', selectedRealm, target);
    if (folder) {
        await extensionContext.vscodeContext.workspaceState.update(getGmodRealmWorkspaceStateKey(folder), selectedRealm);
    }
    if (session) {
        gmodSessionRealms.set(session.id, selectedRealm);
    }

    if (session) {
        await session.customRequest('setRealm', { realm: selectedRealm });
    }
    gmodRealmProvider?.refresh();
    vscode.window.showInformationMessage(`GMod debug realm set to ${selectedRealm}.`);
}

function onDidStartDebugSession(session: vscode.DebugSession): void {
    if (session.type !== 'gluals_gmod') {
        return;
    }
    gmodSessionRealms.set(session.id, getPersistedGmodRealm(session));
    gmodRealmProvider?.refresh();
}

function onDidTerminateDebugSession(session: vscode.DebugSession): void {
    if (session.type !== 'gluals_gmod') {
        return;
    }
    gmodSessionRealms.delete(session.id);
    gmodRealmProvider?.refresh();
}

function initializeGmodExplorer(context: vscode.ExtensionContext): void {
    if (gmodExplorerProvider) {
        return;
    }

    gmodExplorerProvider = registerGmodExplorer(context);
}

function initializeGmodRealmView(context: vscode.ExtensionContext): void {
    if (gmodRealmProvider) {
        return;
    }
    gmodRealmProvider = registerGmodRealmView(context, getPersistedGmodRealm, () => hasGmodDebugConfiguration);
}

function refreshGmodExplorer(): void {
    gmodExplorerProvider?.refresh();
}

async function configureGmodDebugger(): Promise<void> {
    await runGmodDebugSetupWizard(extensionContext.vscodeContext);
    await refreshGmodDebugConfigContext();
}

async function refreshGmodDebugConfigContext(): Promise<void> {
    try {
        hasGmodDebugConfiguration = await hasAnyGmodDebugConfiguration();
    } catch {
        hasGmodDebugConfiguration = false;
    }

    await vscode.commands.executeCommand('setContext', GMOD_DEBUG_CONFIG_CONTEXT_KEY, hasGmodDebugConfiguration);
    await vscode.commands.executeCommand('setContext', GMOD_DEBUG_SETUP_CONTEXT_KEY, !hasGmodDebugConfiguration);
    gmodRealmProvider?.refresh();
}

interface GmodSetupIssue {
    readonly id: string;
    readonly severity: 'warning' | 'error';
    readonly message: string;
    readonly repairLabel: string;
    readonly repair: () => Promise<void>;
}

function getBundledServerExecutablePath(): string {
    const executableName = os.platform() === 'win32' ? 'emmylua_ls.exe' : 'emmylua_ls';
    return path.join(extensionContext.vscodeContext.extensionPath, 'server', executableName);
}

async function readLaunchConfigurations(): Promise<Record<string, unknown>[]> {
    return readAllWorkspaceLaunchConfigurations();
}

function getGmodMcpHealth(): ReturnType<GmodMcpHost['getHealth']> | undefined {
    return gmodMcpHost?.getHealth();
}

async function collectGmodSetupIssues(): Promise<GmodSetupIssue[]> {
    const issues: GmodSetupIssue[] = [];
    const lsConfig = vscode.workspace.getConfiguration('gluals.ls', getConfigurationScope());
    const configuredExecutable = (lsConfig.get<string>('executablePath') ?? '').trim();
    if (configuredExecutable.length > 0 && !fs.existsSync(configuredExecutable)) {
        issues.push({
            id: 'missing-configured-binary',
            severity: 'error',
            message: `Configured language server binary is missing: ${configuredExecutable}`,
            repairLabel: 'Open GLua Language Server Binary Setting',
            repair: async () => {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'gluals.ls.executablePath');
            }
        });
    }

    if (configuredExecutable.length === 0 && !fs.existsSync(getBundledServerExecutablePath())) {
        issues.push({
            id: 'missing-bundled-binary',
            severity: 'error',
            message: 'Bundled GLua Language Server binary is missing from the extension server folder.',
            repairLabel: 'Open GLua Language Server Binary Setting',
            repair: async () => {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'gluals.ls.executablePath');
            }
        });
    }

    const launchConfigs = await readLaunchConfigurations();
    const gmodConfigs = launchConfigs.filter((entry) => entry['type'] === 'gluals_gmod');
    if (gmodConfigs.length === 0) {
        issues.push({
            id: 'missing-gmod-launch-config',
            severity: 'warning',
            message: 'No `gluals_gmod` debug configuration found in workspace launch.json files.',
            repairLabel: 'Run GMod Debugger Setup',
            repair: async () => {
                await configureGmodDebugger();
            }
        });
    } else {
        const hasValidSourceMap = gmodConfigs.some((config) => {
            const sourceMap = config['sourceFileMap'];
            if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) {
                return false;
            }
            return Object.keys(sourceMap).some((key) => key.includes('${workspaceFolder}') || key.includes('${workspaceRoot}'));
        });
        if (!hasValidSourceMap) {
            issues.push({
                id: 'bad-source-file-map',
                severity: 'error',
                message: 'GMod debug configuration is missing a workspace `sourceFileMap` mapping.',
                repairLabel: 'Open launch.json',
                repair: async () => {
                    await vscode.commands.executeCommand('workbench.action.openLaunchJson');
                }
            });
        }
    }

    const health = getGmodMcpHealth();
    const mcpConfig = vscode.workspace.getConfiguration('gluals.gmod.mcp');
    const mcpEnabled = mcpConfig.get<boolean>('enabled', true);
    const configuredToken = (mcpConfig.get<string>('authToken', '') ?? '').trim();

    if (!mcpEnabled) {
        issues.push({
            id: 'mcp-disabled',
            severity: 'error',
            message: 'GMod MCP host is disabled.',
            repairLabel: 'Enable MCP Host',
            repair: async () => {
                await mcpConfig.update('enabled', true, vscode.ConfigurationTarget.Global);
                await startGmodMcpHost(false);
            }
        });
    }

    if (mcpEnabled && health && !health.running) {
        issues.push({
            id: 'mcp-stopped',
            severity: 'warning',
            message: 'GMod MCP host is enabled but not running.',
            repairLabel: 'Start MCP Host',
            repair: async () => {
                await startGmodMcpHost(false);
            }
        });
    }

    if (mcpEnabled && health?.running && !getActiveGmodDebugSession()) {
        issues.push({
            id: 'stale-session',
            severity: 'warning',
            message: 'MCP host is running without an active GMod debug session (possible stale runtime target).',
            repairLabel: 'Restart MCP Host',
            repair: async () => {
                await restartGmodMcpHost(false);
            }
        });
    }

    if (configuredToken.length > 0 && configuredToken.length < 12) {
        issues.push({
            id: 'weak-mcp-token',
            severity: 'warning',
            message: 'Configured MCP auth token is short and easy to mistype for external clients.',
            repairLabel: 'Reset MCP Token',
            repair: async () => {
                await mcpConfig.update('authToken', '', vscode.ConfigurationTarget.Global);
                await restartGmodMcpHost(false);
            }
        });
    }

    return issues;
}

async function runGmodOnboarding(): Promise<void> {
    const start = await vscode.window.showInformationMessage(
        'GMod setup wizard will verify debugger mapping, runtime realm, and MCP health.',
        'Start',
        'Cancel'
    );
    if (start !== 'Start') {
        return;
    }

    await setGmodRealm();
    const issues = await collectGmodSetupIssues();
    if (issues.length === 0) {
        vscode.window.showInformationMessage('GMod setup complete. Diagnostics found no common issues.');
        return;
    }

    const action = await vscode.window.showWarningMessage(
        `GMod setup found ${issues.length} issue(s).`,
        'Repair All',
        'Review'
    );
    if (action === 'Repair All') {
        for (const issue of issues) {
            await issue.repair();
        }
        vscode.window.showInformationMessage('GMod setup repairs completed.');
        return;
    }

    if (action === 'Review') {
        await runGmodDiagnosticsRepair();
    }
}

async function runGmodDiagnosticsRepair(): Promise<void> {
    const issues = await collectGmodSetupIssues();
    if (issues.length === 0) {
        vscode.window.showInformationMessage('GMod diagnostics: no issues detected.');
        return;
    }

    const picks = issues.map((issue) => ({
        label: issue.severity === 'error' ? `$(error) ${issue.message}` : `$(warning) ${issue.message}`,
        description: issue.repairLabel,
        issue
    }));
    const selected = await vscode.window.showQuickPick(picks, {
        title: 'GMod Diagnostics & Repair',
        placeHolder: 'Select an issue to repair',
        ignoreFocusOut: true
    });
    if (!selected) {
        return;
    }

    await selected.issue.repair();
    vscode.window.showInformationMessage(`GMod diagnostics repair applied: ${selected.issue.id}`);
}

function initializeGmodMcpHost(context: vscode.ExtensionContext): void {
    if (gmodMcpHost) {
        return;
    }

    gmodMcpHost = new GmodMcpHost({
        executeControlCommand: executeGmodControlCommand,
        getDebugState: getGmodDebugState,
        getCurrentRealm: getPersistedGmodRealm,
    });
    context.subscriptions.push(gmodMcpHost);
}

async function startGmodMcpHost(showNotification: boolean = true): Promise<void> {
    if (!gmodMcpHost) {
        initializeGmodMcpHost(extensionContext.vscodeContext);
    }
    if (!gmodMcpHost) {
        return;
    }

    try {
        await gmodMcpHost.start();
        if (showNotification) {
            const health = gmodMcpHost.getHealth();
            vscode.window.showInformationMessage(`GMod MCP host listening on ${health.host}:${health.port}.`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to start GMod MCP host: ${errorMessage}`);
    }
}

async function stopGmodMcpHost(showNotification: boolean = true): Promise<void> {
    if (!gmodMcpHost) {
        return;
    }

    try {
        await gmodMcpHost.stop();
        if (showNotification) {
            vscode.window.showInformationMessage('GMod MCP host stopped.');
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to stop GMod MCP host: ${errorMessage}`);
    }
}

async function restartGmodMcpHost(showNotification: boolean = true): Promise<void> {
    if (!gmodMcpHost) {
        initializeGmodMcpHost(extensionContext.vscodeContext);
    }
    if (!gmodMcpHost) {
        return;
    }

    try {
        await gmodMcpHost.restart();
        if (showNotification) {
            const health = gmodMcpHost.getHealth();
            vscode.window.showInformationMessage(`GMod MCP host restarted on ${health.host}:${health.port}.`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to restart GMod MCP host: ${errorMessage}`);
    }
}

function healthCheckGmodMcpHost(): void {
    if (!gmodMcpHost) {
        vscode.window.showWarningMessage('GMod MCP host is not initialized.');
        return;
    }

    const health = gmodMcpHost.getHealth();
    vscode.window.showInformationMessage(
        `GMod MCP host: ${health.running ? 'running' : 'stopped'} at ${health.host}:${health.port}.`,
        'Run Diagnostics',
        'Setup Wizard'
    ).then((action) => {
        if (action === 'Run Diagnostics') {
            void runGmodDiagnosticsRepair();
        } else if (action === 'Setup Wizard') {
            void runGmodOnboarding();
        }
    });
}

function getGmodDebugState(): Record<string, unknown> {
    const session = getActiveGmodDebugSession();
    return {
        hasActiveSession: !!session,
        sessionId: session?.id ?? null,
        sessionName: session?.name ?? null,
        sessionType: session?.type ?? null,
        realm: getPersistedGmodRealm(),
        serverState: extensionContext.serverStatus.state,
    };
}

function getGmodDebugStateForTool(): Record<string, unknown> {
    return {
        ...getGmodDebugState(),
        mcpHost: gmodMcpHost?.getHealth() ?? null,
        outputCount: gmodToolOutputEntries.length,
        errorCount: gmodToolErrorEntries.length,
    };
}

function getRecentGmodOutputEntries(limit: number): { total: number; items: GmodToolLogEntry[]; } {
    const safeLimit = resolveGmodToolLogLimit(limit, 200, 50);
    return {
        total: gmodToolOutputEntries.length,
        items: gmodToolOutputEntries.slice(-safeLimit),
    };
}

function getRecentGmodErrorEntries(limit: number): { total: number; items: GmodToolLogEntry[]; } {
    const safeLimit = resolveGmodToolLogLimit(limit, 200, 50);
    return {
        total: gmodToolErrorEntries.length,
        items: gmodToolErrorEntries.slice(-safeLimit),
    };
}

function resolveGmodToolLogLimit(rawLimit: unknown, max: number, fallback: number): number {
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
        return fallback;
    }
    return Math.max(1, Math.min(max, Math.floor(rawLimit)));
}

function recordGmodToolDebugOutput(payload: Record<string, unknown>): void {
    const rawMessage = typeof payload.message === 'string' ? payload.message : '';
    if (rawMessage.trim().length === 0) {
        return;
    }

    pushGmodToolEntry(gmodToolOutputEntries, {
        timestamp: coerceGmodToolTimestamp(payload.timestamp),
        source: typeof payload.source === 'string' ? payload.source : 'debug',
        level: 'info',
        message: rawMessage,
        metadata: {
            severity: typeof payload.severity === 'number' ? payload.severity : undefined,
            realm: normalizeGmodRealm(payload.realm),
        },
    });
}

function recordGmodToolControlResult(result: GmodControlResult): void {
    const runFilePath = result.command === 'runFile'
        ? result.diagnostics
            .find((diagnostic) => diagnostic.message.startsWith('File dispatched: '))
            ?.message.slice('File dispatched: '.length)
        : undefined;
    const summary = runFilePath
        ? `command=${result.command} correlationId=${result.correlationId} file=${runFilePath}`
        : `command=${result.command} correlationId=${result.correlationId}`;

    pushGmodToolEntry(gmodToolOutputEntries, {
        timestamp: new Date().toISOString(),
        source: 'control',
        level: result.ok ? 'info' : 'error',
        message: summary,
        metadata: {
            realm: result.realm,
            request: result.request,
            diagnostics: result.diagnostics,
            ok: result.ok,
        },
    });

    if (!result.ok) {
        pushGmodToolEntry(gmodToolErrorEntries, {
            timestamp: new Date().toISOString(),
            source: 'control',
            level: 'error',
            message: `Control command rejected: ${result.command}`,
            metadata: {
                diagnostics: result.diagnostics,
                correlationId: result.correlationId,
            },
        });
    }
}

function recordGmodToolBackendError(message: string, details?: unknown): void {
    pushGmodToolEntry(gmodToolErrorEntries, {
        timestamp: new Date().toISOString(),
        source: 'backend',
        level: 'error',
        message,
        metadata: details && typeof details === 'object'
            ? details as Record<string, unknown>
            : undefined,
    });
}

function pushGmodToolEntry(target: GmodToolLogEntry[], entry: GmodToolLogEntry): void {
    target.push(entry);
    if (target.length > GMOD_TOOL_LOG_MAX_SIZE) {
        target.splice(0, target.length - GMOD_TOOL_LOG_MAX_SIZE);
    }
}

function coerceGmodToolTimestamp(value: unknown): string {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    return new Date().toISOString();
}

interface GmodRdbVersionMismatchBody {
    moduleVersion?: unknown;
}

function onDidReceiveDebugSessionCustomEvent(event: vscode.DebugSessionCustomEvent): void {
    if (event.session.type !== 'gluals_gmod') {
        return;
    }

    if (event.event === 'gmod.rdb.versionMismatch') {
        if (event.body && typeof event.body === 'object') {
            const body = event.body as GmodRdbVersionMismatchBody;
            if (typeof body.moduleVersion === 'string' && gmodRdbUpdater) {
                void gmodRdbUpdater.handleVersionMismatch(body.moduleVersion);
            }
        }
        return;
    }

    if (event.event === 'gmod.output' && event.body && typeof event.body === 'object') {
        recordGmodToolDebugOutput(event.body as Record<string, unknown>);
        gmodMcpHost?.recordDebugOutput(event.body as Record<string, unknown>);
        return;
    }

    if (event.event === 'gmod.controlResult' && event.body && typeof event.body === 'object') {
        const result = event.body as GmodControlResult;
        if (result.command === 'setRealm') {
            gmodSessionRealms.set(event.session.id, normalizeGmodRealm(result.realm));
        }
        recordGmodToolControlResult(result);
        gmodMcpHost?.recordControlResult(result);
        return;
    }

    if (event.event === 'gmod.controlError') {
        const body = event.body as { message?: unknown; details?: unknown } | undefined;
        const message = typeof body?.message === 'string' ? body.message : 'Unknown control error';
        recordGmodToolBackendError(message, body?.details);
        gmodMcpHost?.recordBackendError(message, body?.details);
    }
}

