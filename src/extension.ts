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
import * as LuaRocks from './luarocks';
import { GmodAnnotationManager } from './gmodAnnotationManager';

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

/**
 * Extension activation entry point
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('EmmyLua extension activated!');

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
    registerTerminalLinkProvider(context);

    // Initialize features
    await initializeExtension();
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    extensionContext?.dispose();
    Annotator.dispose();
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
    const commandEntries: CommandEntry[] = [
        // Server commands
        { id: 'emmy.stopServer', handler: stopServer },
        { id: 'emmy.restartServer', handler: restartServer },
        { id: 'emmy.showServerMenu', handler: showServerMenu },
        { id: 'emmy.showReferences', handler: showReferences },
        { id: 'emmy.showSyntaxTree', handler: showSyntaxTree },
        // debugger commands
        { id: 'emmy.insertEmmyDebugCode', handler: insertEmmyDebugCode },
        // GMod annotations commands
        { id: 'emmy.gmod.updateAnnotations', handler: updateGmodAnnotations },
        { id: 'emmy.gmod.removeAnnotations', handler: removeGmodAnnotations },
        // LuaRocks commands
        { id: 'emmylua.luarocks.searchPackages', handler: LuaRocks.searchPackages },
        { id: 'emmylua.luarocks.installPackage', handler: LuaRocks.installPackage },
        { id: 'emmylua.luarocks.uninstallPackage', handler: LuaRocks.uninstallPackage },
        { id: 'emmylua.luarocks.showPackageInfo', handler: LuaRocks.showPackageInfo },
        { id: 'emmylua.luarocks.refreshPackages', handler: LuaRocks.refreshPackages },
        { id: 'emmylua.luarocks.showPackages', handler: LuaRocks.showPackagesView },
        { id: 'emmylua.luarocks.clearSearch', handler: LuaRocks.clearSearch },
        { id: 'emmylua.luarocks.checkInstallation', handler: LuaRocks.checkLuaRocksInstallation },
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
    ];

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

/**
 * Initialize all extension features
 */
async function initializeExtension(): Promise<void> {
    // Initialize GMod annotation manager
    gmodAnnotationManager = new GmodAnnotationManager(extensionContext.vscodeContext);
    
    // Initialize annotations before starting server
    await gmodAnnotationManager.initializeAnnotations();

    // Initialize syntax tree manager
    syntaxTreeManager = new SyntaxTreeManager();
    extensionContext.vscodeContext.subscriptions.push(syntaxTreeManager);

    // Set up client getter for syntax tree provider
    setClientGetter(() => extensionContext.client);

    await startServer();
    registerDebuggers();
    await LuaRocks.initializeLuaRocks();
}

function onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('emmylua')) {
        onDidChangeConfiguration();
    }
}

function onWorkspaceFoldersChanged(): void {
    onDidChangeConfiguration();
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
            'Failed to start EmmyLua language server',
            errorMessage
        );
        vscode.window.showErrorMessage(
            `Failed to start EmmyLua language server: ${errorMessage}`,
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
        'EmmyLua Language Server',
        serverOptions,
        clientOptions
    );

    await extensionContext.client.start();
    console.log('EmmyLua language server started successfully');
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
        serverOptions.options.env['EMMYLUALS_CONFIG'] = globalConfigPath;
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
        vscode.window.showInformationMessage('EmmyLua language server stopped');
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

