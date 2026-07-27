import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as process from 'process';
import * as os from 'os';
import * as fs from 'fs';

import { LanguageClient, LanguageClientOptions, ServerOptions, State, StreamInfo } from 'vscode-languageclient/node';
import { LuaLanguageConfiguration } from './languageConfiguration';
import { EmmyContext, ServerState } from './emmyContext';
import { IServerLocation, IServerPosition } from './lspExtension';
import { onDidChangeConfiguration } from './annotator';
import { ConfigurationManager } from './configManager';
import * as Annotator from './annotator';
import { EmmyrcSchemaContentProvider } from './emmyrcSchemaContentProvider';
import { SyntaxTreeManager, setClientGetter } from './syntaxTreeProvider';
import { registerTerminalLinkProvider } from './luaTerminalLinkProvider';
import { registerUndefinedGlobalCodeActions } from './undefinedGlobalCodeActions';
import { registerDebuggers } from './debugger';
import { GmodAnnotationManager } from './gmodAnnotationManager';
import { GMOD_REALMS, GmodControlResult, GmodRealm, normalizeGmodRealm } from './debugger/gmod_debugger/GmodDebugControlService';
import { GmodLanguageIssue, GmodMcpHost } from './gmodMcpHost';
import { GmodExplorerItem, GmodExplorerProvider, registerGmodExplorer } from './gmodExplorer';
import { GmodRealmStatusBar, registerGmodRealmView } from './gmodRealmView';
import {
    GmodErrorLocation,
    GmodErrorNotificationParams,
    GmodErrorStore,
    GmodErrorViewProvider,
    parseGmodErrorLocation,
    registerGmodErrorView,
} from './gmodErrorView';
import { EntityClassGroupFilter, EntityTreeItem, GmodEntityExplorerProvider } from './gmodEntityExplorerView';
import { GluarcSettingsPanel } from './gluarcSettingsPanel';
import { ensureGluarcExists, getNestedValue, readGluarcConfig, setNestedValue, writeGluarcConfig } from './gluarcConfig';
import { scaffoldNewScriptedClass } from './gmodScaffolding';
import { GmodRdbUpdater } from './debugger/gmod_debugger/GmodRdbUpdater';
import { GmodClientRdbUpdater } from './debugger/gmod_debugger/GmodClientRdbUpdater';
import { GmodUpdateScheduler } from './debugger/gmod_debugger/GmodUpdateScheduler';
import { detectGamemodeBaseLibraries } from './gmodGamemodeBaseDetector';
import {
    hasAnyGmodDebugConfiguration,
    runGmodDebugSetupWizard,
} from './debugger/gmod_debugger/GmodDebugSetupWizard';
import {
    isExpectedLifecycleRequestError,
    sendRequestWithStartupRetry,
} from './languageServerRequests';
import {
    enableCompletionColorPreviewHtml,
    enableCompletionColorPreviewHtmlForResult,
} from './completionColorPreview';
import { getServerLogDirectory, withServerLogPathArgument } from './serverLogPath';
import {
    STARTUP_DIAGNOSE_PROGRESS_TOKEN,
    applyServerStartupState,
    applyStartupProgressEvent,
    createStartupReadinessState,
    describeStartupProgressEvent,
    formatStartupTimeoutMessage,
    isStartupProgressToken,
    StartupServerState,
} from './startupProgress';

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
let serverStartPromise: Promise<void> | undefined;
let suppressNextStartupError = false;
let startupRunCounter = 0;
let currentStartupRunId: number | undefined;
const cancelledStartupRuns = new Set<number>();

class StartupCancelledError extends Error {
    constructor() {
        super('GLuaLS startup cancelled');
    }
}

function cancelPendingStartupRun(): void {
    if (currentStartupRunId !== undefined) {
        cancelledStartupRuns.add(currentStartupRunId);
    }
}

function throwIfStartupCancelled(startupRunId: number): void {
    if (cancelledStartupRuns.has(startupRunId)) {
        throw new StartupCancelledError();
    }
}

let syntaxTreeManager: SyntaxTreeManager | undefined;
let gmodAnnotationManager: GmodAnnotationManager | undefined;
let gmodRdbUpdater: GmodRdbUpdater | undefined;
let gmodClientRdbUpdater: GmodClientRdbUpdater | undefined;
let gmodMcpHost: GmodMcpHost | undefined;
let gmodExplorerProvider: GmodExplorerProvider | undefined;
let gmodRealmProvider: GmodRealmStatusBar | undefined;
const gmodErrorStores = new Map<string, GmodErrorStore>();
let gmodErrorViewProvider: GmodErrorViewProvider | undefined;
let gmodEntityExplorerProvider: GmodEntityExplorerProvider | undefined;
let languageConfigurationDisposable: vscode.Disposable | undefined;
let hoverProviderRegistration: vscode.Disposable | undefined;
let hasGmodDebugConfiguration = false;
const gmodSessionRealms = new Map<string, GmodRealm>();
const GMOD_REALM_WORKSPACE_KEY_PREFIX = 'gluals.gmod.realm.workspace.';
const GMOD_DEBUG_CONFIG_CONTEXT_KEY = 'gluals.gmod.hasDebugConfig';
const GMOD_DEBUG_SETUP_CONTEXT_KEY = 'gluals.gmod.needsDebugSetup';
const GMOD_MCP_PROVIDER_ID = 'gluals.gmod.runtime';
const DOCUMENT_SYMBOL_WARMUP_MAX_RETRIES = 6;
const DOCUMENT_SYMBOL_WARMUP_RETRY_DELAY_MS = 250;
const SERVER_STATUS_NOTIFICATION = 'gluals/serverStatus';
const LSP_PROGRESS_NOTIFICATION = '$/progress';
const STARTUP_COMPLETE_TIMEOUT_MS = 60000;

interface ServerStatusNotificationParams {
    readonly state: StartupServerState;
}

interface ProgressNotificationParams {
    readonly token: number | string;
    readonly value: {
        readonly kind: 'begin' | 'report' | 'end';
        readonly message?: string;
    };
}

interface StartupStateHandlerRegistration {
    readonly completion: Promise<void>;
    isDiagnosticsInProgress(): boolean;
    dispose(error?: Error): void;
}

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

    initializeGmodMcpHost(context);
    registerGmodMcpProvider(context);

    // Register all components
    registerCommands(context);
    registerEventListeners(context);
    registerLanguageConfiguration(context);
    registerDebugConfigurationProviders(context);
    registerTerminalLinkProvider(context);
    registerUndefinedGlobalCodeActions(context);

    // Initialize features
    await startGmodMcpHost(false);
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
    disposeHoverProviderRegistration();
    try {
        await extensionContext?.stopServer();
    } catch {
        // Ignore stop errors during shutdown; extension host is unloading.
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
        { id: 'gluals.startServer', handler: startServerCommand },
        { id: 'gluals.stopServer', handler: stopServer },
        { id: 'gluals.restartServer', handler: restartServer },
        { id: 'gluals.showServerMenu', handler: showServerMenu },
        { id: 'gluals.showReferences', handler: showReferences },
        { id: 'gluals.showSyntaxTree', handler: showSyntaxTree },
        // GMod annotations commands
        { id: 'gluals.gmod.updateAnnotations', handler: updateGmodAnnotations },
        { id: 'gluals.gmod.removeAnnotations', handler: removeGmodAnnotations },
        { id: 'gmodRdb.checkForUpdates', handler: checkForGmodRdbUpdates },
        { id: 'gmodRdbClient.checkForUpdates', handler: checkForGmodRdbUpdates },
        { id: 'gluals.gmod.openSettings', handler: async () => await GluarcSettingsPanel.createOrShow(context) },
        { id: 'gluals.gmod.createSettings', handler: async (uri?: vscode.Uri) => await GluarcSettingsPanel.createAndShow(context, uri) },
        { id: 'gluals.gmod.editSettings', handler: async (uri?: vscode.Uri) => await GluarcSettingsPanel.createOrShow(context, uri) },
        { id: 'gluals.gmod.addDirectoryToIgnoreList', handler: addDirectoryToIgnoreList },
        // GMod debug control commands
        { id: 'gluals.gmod.pauseSoft', handler: () => runGmodControlCommand('pauseSoft') },
        { id: 'gluals.gmod.pauseNow', handler: () => runGmodControlCommand('pauseNow') },
        { id: 'gluals.gmod.resume', handler: () => runGmodControlCommand('resume') },
        { id: 'gluals.gmod.breakHere', handler: () => runGmodControlCommand('breakHere') },
        { id: 'gluals.gmod.waitIDE', handler: () => runGmodControlCommand('waitIDE') },
        { id: 'gluals.gmod.runLua', handler: runGmodRunLua },
        { id: 'gluals.gmod.runFile', handler: runGmodRunFile },
        { id: 'gluals.gmod.refreshFile', handler: runGmodRefreshFile },
        { id: 'gluals.gmod.runSelection', handler: runGmodRunSelection },
        { id: 'gluals.gmod.runCommand', handler: runGmodRunCommand },
        { id: 'gluals.gmod.setRealm', handler: setGmodRealm },
        { id: 'gluals.gmod.explorer.refresh', handler: refreshGmodExplorer },
        { id: 'gluals.gmod.scaffold.new', handler: (treeItemOrUri?: any) => scaffoldNewScriptedClass(treeItemOrUri, context) },
        { id: 'gluals.openDocumentation', handler: openDocumentation },
        { id: 'gluals.gmod.mcp.restartHost', handler: restartGmodMcpHost },
        { id: 'gluals.gmod.mcp.copyConfiguration', handler: copyGmodMcpConfiguration },
        { id: 'gluals.gmod.configureDebugger', handler: configureGmodDebugger },
        { id: 'gmodErrors.clear', handler: clearGmodErrors },
        { id: 'gmodErrors.openLocation', handler: openGmodErrorLocation },
        { id: 'gmodEntityExplorer.refresh', handler: refreshGmodEntityExplorer },
        { id: 'gmodEntityExplorer.search', handler: searchGmodEntityExplorer },
        { id: 'gmodEntityExplorer.filter', handler: filterGmodEntityExplorer },
        { id: 'gmodEntityExplorer.searchTable', handler: searchGmodEntityExplorerTable },
        { id: 'gmodEntityExplorer.searchNetworkVars', handler: searchGmodEntityExplorerNetworkVars },
        { id: 'gmodEntityExplorer.editProperty', handler: editGmodEntityExplorerProperty },
        { id: 'gmodEntityExplorer.loadMore', handler: loadMoreGmodEntityExplorer },
        { id: 'gluals.gmod.explorer.copyRelativePath', handler: copyGmodExplorerRelativePath },
        { id: 'gluals.gmod.explorer.copyAbsolutePath', handler: copyGmodExplorerAbsolutePath },
        { id: 'gluals.gmod.explorer.copyClassName', handler: copyGmodExplorerClassName },
        { id: 'gluals.gmod.explorer.revealInExplorer', handler: revealGmodExplorerItemInExplorer },
    ];

    // Register all commands
    const commands = commandEntries.map(({ id, handler }) =>
        vscode.commands.registerCommand(id, handler)
    );

    // Override the built-in "Evaluate in Debug Console" editor action so that
    // selections are evaluated as Lua for GMod debug sessions.
    // We pass the frameId from the active stack item so that frameScopedEvaluation
    // fires correctly in the debug adapter without needing any '=' prefix.
    const evaluateInConsoleOverride = vscode.commands.registerCommand(
        'editor.debug.action.selectionToRepl',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const text = editor.document.getText(editor.selection).trim();
            if (!text) return;
            const session = vscode.debug.activeDebugSession;
            if (!session) return;
            if (session.type === 'gluals_gmod_client') {
                // Client session: evaluation is only available when paused. No control channel.
                const activeItem = vscode.debug.activeStackItem;
                const frameId = activeItem instanceof vscode.DebugStackFrame ? activeItem.frameId : undefined;
                if (frameId === undefined) {
                    vscode.debug.activeDebugConsole.appendLine('[GLuaLS] Client evaluation is only available when execution is paused.');
                    return;
                }
                try {
                    const result = await session.customRequest('evaluate', { expression: '=' + text, context: 'repl', frameId });
                    const output = typeof result?.result === 'string' ? result.result : JSON.stringify(result);
                    if (output) {
                        vscode.debug.activeDebugConsole.appendLine(output);
                    }
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    vscode.debug.activeDebugConsole.appendLine(`Evaluate error: ${msg}`);
                }
                return;
            }
            if (session.type !== 'gluals_gmod') {
                // Non-GMod session: fall back to standard evaluate behaviour.
                const activeItem = vscode.debug.activeStackItem;
                const frameId = activeItem instanceof vscode.DebugStackFrame ? activeItem.frameId : undefined;
                try {
                    await session.customRequest('evaluate', { expression: text, context: 'repl', frameId });
                } catch (error) {
                    console.warn('[GLuaLS] Debug evaluate failed for non-GMod session:', error instanceof Error ? error.message : error);
                }
                return;
            }
            const activeItem = vscode.debug.activeStackItem;
            const frameId = activeItem instanceof vscode.DebugStackFrame ? activeItem.frameId : undefined;
            if (frameId !== undefined) {
                // Paused: frameScopedEvaluation in the adapter treats the raw expression as Lua eval.
                try {
                    const result = await session.customRequest('evaluate', { expression: '=' + text, context: 'repl', frameId });
                    const output = typeof result?.result === 'string' ? result.result : JSON.stringify(result);
                    if (output) {
                        vscode.debug.activeDebugConsole.appendLine(output);
                    }
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    vscode.debug.activeDebugConsole.appendLine(`Evaluate error: ${msg}`);
                }
            } else {
                // Not paused: run via control channel so Lua executes without a stack frame.
                await runGmodControlCommand('runLua', { lua: text });
            }
        }
    );

    context.subscriptions.push(...commands, evaluateInConsoleOverride);
}

/**
 * Register event listeners
 */
function registerEventListeners(context: vscode.ExtensionContext): void {
    const eventListeners = [
        vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument),
        vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        vscode.workspace.onDidChangeConfiguration(onConfigurationChanged),
        vscode.workspace.onDidChangeWorkspaceFolders(onWorkspaceFoldersChanged),
        vscode.debug.onDidStartDebugSession(onDidStartDebugSession),
        vscode.debug.onDidTerminateDebugSession(onDidTerminateDebugSession),
        vscode.debug.onDidChangeActiveDebugSession(onDidChangeActiveDebugSession),
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
    refreshLanguageConfiguration();
    context.subscriptions.push({
        dispose: () => {
            languageConfigurationDisposable?.dispose();
            languageConfigurationDisposable = undefined;
        }
    });
}

function refreshLanguageConfiguration(): void {
    languageConfigurationDisposable?.dispose();
    languageConfigurationDisposable = vscode.languages.setLanguageConfiguration(
        'lua',
        new LuaLanguageConfiguration()
    );
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
    gmodClientRdbUpdater = new GmodClientRdbUpdater(extensionContext.vscodeContext);
    void gmodRdbUpdater.ensureRuntimeFilesUpToDate();

    // Initialize annotations before starting server
    await gmodAnnotationManager.initializeAnnotations();

    // Boot-time + periodic update scheduler (annotations + debugger modules)
    new GmodUpdateScheduler(
        extensionContext.vscodeContext,
        gmodAnnotationManager,
        gmodRdbUpdater,
        gmodClientRdbUpdater,
    ).start();

    // Initialize syntax tree manager
    syntaxTreeManager = new SyntaxTreeManager();
    extensionContext.vscodeContext.subscriptions.push(syntaxTreeManager);

    // Set up client getter for syntax tree provider
    setClientGetter(() => extensionContext.client);

    await startServer();
    if (vscode.window.activeTextEditor && extensionContext.client) {
        activeEditor = vscode.window.activeTextEditor;
    }
    registerDebuggers();
    initializeGmodExplorer(extensionContext.vscodeContext);
    initializeGmodRealmView(extensionContext.vscodeContext);
    initializeGmodErrorView(extensionContext.vscodeContext);
    initializeGmodEntityExplorerView(extensionContext.vscodeContext);
    await refreshGmodDebugConfigContext();
}

function onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('gluals')) {
        onDidChangeConfiguration();
    }
    if (e.affectsConfiguration('gluals.language.completeAnnotation')) {
        refreshLanguageConfiguration();
    }
    if (e.affectsConfiguration('gluals.gmod.mcp')) {
        void restartGmodMcpHost(false);
    }
}

function onWorkspaceFoldersChanged(): void {
    onDidChangeConfiguration();
    void refreshGmodDebugConfigContext();
}

function onDidOpenTextDocument(document: vscode.TextDocument): void {
    if (!extensionContext.client || !isLuaDocumentForLanguageServer(document)) {
        return;
    }

    void warmupDocumentSymbolsForDocument(document);
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
    activeEditor = editor;
    if (editor &&
        editor.document.languageId === extensionContext.LANGUAGE_ID &&
        extensionContext.client
    ) {
        Annotator.requestAnnotators(editor, extensionContext.client);
    }
}

function isLuaDocumentForLanguageServer(document: vscode.TextDocument): boolean {
    return document.languageId === extensionContext.LANGUAGE_ID && document.uri.scheme === 'file';
}

async function warmupOpenDocumentSymbols(): Promise<void> {
    const candidates = vscode.workspace.textDocuments.filter((document) => isLuaDocumentForLanguageServer(document));
    await Promise.all(candidates.map((document) => warmupDocumentSymbolsForDocument(document)));
}

async function warmupDocumentSymbolsForDocument(document: vscode.TextDocument): Promise<void> {
    const client = extensionContext.client;
    if (!client || !isLuaDocumentForLanguageServer(document)) {
        return;
    }

    const params = {
        textDocument: {
            uri: document.uri.toString(),
        },
    };

    for (let attempt = 0; attempt <= DOCUMENT_SYMBOL_WARMUP_MAX_RETRIES; attempt += 1) {
        try {
            await sendRequestWithStartupRetry<unknown[]>(client, 'textDocument/documentSymbol', params, 1, 0);
            return;
        } catch (error) {
            if (!isExpectedLifecycleRequestError(error) || attempt >= DOCUMENT_SYMBOL_WARMUP_MAX_RETRIES) {
                return;
            }

            await delay(DOCUMENT_SYMBOL_WARMUP_RETRY_DELAY_MS * (attempt + 1));
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}


async function startServer(): Promise<void> {
    if (serverStartPromise) {
        await serverStartPromise;
        return;
    }

    if (extensionContext.client?.isRunning()) {
        extensionContext.setServerRunning();
        return;
    }

    const startupRunId = ++startupRunCounter;
    currentStartupRunId = startupRunId;
    serverStartPromise = (async () => {
        try {
            extensionContext.clearServerVersions();
            extensionContext.setServerStarting();
            const startupStateHandlers = await doStartServer(startupRunId);
            if (startupStateHandlers.isDiagnosticsInProgress()) {
                extensionContext.setServerDiagnosing();
            } else {
                extensionContext.setServerRunning();
            }
            void warmupOpenDocumentSymbols();
            onDidChangeActiveTextEditor(vscode.window.activeTextEditor);
        } catch (reason) {
            const errorMessage = reason instanceof Error ? reason.message : String(reason);
            const client = extensionContext.client;
            extensionContext.client = undefined;
            if (client) {
                try {
                    await client.stop();
                } catch {
                    // Ignore cleanup failures after startup errors.
                }
            }

            if (suppressNextStartupError || reason instanceof StartupCancelledError) {
                extensionContext.setServerStopped();
                return;
            }

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
                    void showServerLogs(extensionContext.vscodeContext);
                }
            });
        } finally {
            cancelledStartupRuns.delete(startupRunId);
            if (currentStartupRunId === startupRunId) {
                currentStartupRunId = undefined;
            }
            suppressNextStartupError = false;
            serverStartPromise = undefined;
        }
    })();

    await serverStartPromise;
}

function registerLanguageClientStateHandlers(client: LanguageClient): StartupStateHandlerRegistration {
    let startupSettled = false;
    let readinessState = createStartupReadinessState();
    let lastStartupPhase = 'awaiting startup progress';
    let notificationDisposable: vscode.Disposable | undefined;
    let progressDisposable: vscode.Disposable | undefined;
    let startupTimeout: NodeJS.Timeout | undefined;
    let resolveStartupPromise!: () => void;
    let rejectStartupPromise!: (error: Error) => void;

    const clearStartupTimeout = (): void => {
        if (startupTimeout) {
            clearTimeout(startupTimeout);
            startupTimeout = undefined;
        }
    };

    const cleanup = (): void => {
        clearStartupTimeout();
        notificationDisposable?.dispose();
        progressDisposable?.dispose();
    };

    const resolveStartup = (): void => {
        if (startupSettled) {
            return;
        }

        startupSettled = true;
        clearStartupTimeout();
        resolveStartupPromise();
    };

    const rejectStartup = (error: Error): void => {
        if (startupSettled) {
            return;
        }

        startupSettled = true;
        cleanup();
        rejectStartupPromise(error);
    };

    const completion = new Promise<void>((resolve, reject) => {
        resolveStartupPromise = resolve;
        rejectStartupPromise = reject;
    });
    void completion.catch(() => undefined);

    client.onDidChangeState((event) => {
        const isActiveClient = extensionContext.client === client;

        switch (event.newState) {
            case State.Starting:
                lastStartupPhase = 'client starting';
                if (isActiveClient) {
                    extensionContext.setServerStarting();
                }
                break;
            case State.Running:
                if (isActiveClient && !readinessState.ready) {
                    lastStartupPhase = 'workspace loading and diagnostics in progress';
                    extensionContext.setServerStarting('Loading workspace and diagnostics...');
                }
                break;
            case State.Stopped:
                if (isActiveClient) {
                    extensionContext.client = undefined;
                    disposeHoverProviderRegistration();
                    if (extensionContext.serverStatus.state !== ServerState.Error) {
                        extensionContext.setServerStopped();
                    }
                }
                if (!readinessState.ready) {
                    rejectStartup(new Error('GLua Language Server stopped before startup completed'));
                }
                break;
            default:
                break;
        }
    });

    notificationDisposable = client.onNotification(
        SERVER_STATUS_NOTIFICATION,
        (params: ServerStatusNotificationParams) => {
            readinessState = applyServerStartupState(readinessState, params.state);
            if (params.state === 'workspaceLoaded') {
                logLanguageServerOutput(client, 'Workspace loaded; diagnostics may continue in the background.');
            } else {
                logLanguageServerOutput(client, 'Workspace diagnostics completed.');
            }
            if (extensionContext.client === client && readinessState.ready) {
                resolveStartup();
            }
            if (
                params.state === 'startupComplete' &&
                extensionContext.client === client &&
                !readinessState.diagnosticsInProgress
            ) {
                extensionContext.setServerRunning();
            }
            if (params.state === 'startupComplete') {
                cleanup();
            }
        }
    );

    progressDisposable = client.onNotification(
        LSP_PROGRESS_NOTIFICATION,
        (params: ProgressNotificationParams) => {
            if (!isStartupProgressToken(params.token)) {
                return;
            }

            lastStartupPhase = describeStartupProgressEvent({
                token: params.token,
                kind: params.value.kind,
                message: params.value.message,
            });

            readinessState = applyStartupProgressEvent(readinessState, {
                token: params.token,
                kind: params.value.kind,
            });

            if (readinessState.ready) {
                resolveStartup();
            }

            if (extensionContext.client === client && params.value.message) {
                if (readinessState.ready && readinessState.diagnosticsInProgress) {
                    extensionContext.setServerDiagnosing(params.value.message);
                } else {
                    extensionContext.setServerStarting(params.value.message);
                }
            }

            if (params.value.kind !== 'end') {
                return;
            }

            if (extensionContext.client === client && !readinessState.diagnosticsInProgress) {
                extensionContext.setServerRunning();
                if (params.token === STARTUP_DIAGNOSE_PROGRESS_TOKEN) {
                    cleanup();
                }
            }
        }
    );

    startupTimeout = setTimeout(() => {
        rejectStartup(new Error(formatStartupTimeoutMessage(STARTUP_COMPLETE_TIMEOUT_MS, lastStartupPhase)));
    }, STARTUP_COMPLETE_TIMEOUT_MS);

    return {
        completion,
        isDiagnosticsInProgress(): boolean {
            return readinessState.diagnosticsInProgress;
        },
        dispose(error?: Error): void {
            if (!error) {
                cleanup();
                return;
            }
            rejectStartup(error);
        },
    };
}

function disposeHoverProviderRegistration(): void {
    hoverProviderRegistration?.dispose();
    hoverProviderRegistration = undefined;
}

async function cleanupExistingClient(): Promise<void> {
    const existingClient = extensionContext.client;
    disposeHoverProviderRegistration();
    if (!existingClient) {
        return;
    }

    extensionContext.client = undefined;
    try {
        await existingClient.stop();
    } catch {
        // Ignore stale-client cleanup failures and continue with a fresh start.
    }
}

/**
 * Start the language server
 */
async function doStartServer(startupRunId: number): Promise<StartupStateHandlerRegistration> {
    await cleanupExistingClient();
    throwIfStartupCancelled(startupRunId);
    const context = extensionContext.vscodeContext;
    const configManager = new ConfigurationManager(getConfigurationScope());

    // Prepare initialization options with GMod annotations path if available
    const initOptions: Record<string, any> = {};
    let annotationVersion: string | undefined;
    if (gmodAnnotationManager) {
        const annotationsPath = gmodAnnotationManager.getAnnotationsPath();
        if (annotationsPath) {
            initOptions.gmodAnnotationsPath = annotationsPath;
            annotationVersion = gmodAnnotationManager.getAnnotationVersion();
        }
    }

    // Detect gamemode base libraries for each workspace folder
    const gamemodeBaseLibraries: string[] = [];
    const config = vscode.workspace.getConfiguration('gluals');
    const autoDetectEnabled = config.get<boolean>('gmod.autoDetectGamemodeBase', true);
    if (autoDetectEnabled && vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            try {
                throwIfStartupCancelled(startupRunId);
                const detected = await detectGamemodeBaseLibraries(folder);
                throwIfStartupCancelled(startupRunId);
                gamemodeBaseLibraries.push(...detected);
            } catch (error) {
                if (error instanceof StartupCancelledError) {
                    throw error;
                }
                // Silently skip detection failures
            }
        }
    }
    if (gamemodeBaseLibraries.length > 0) {
        initOptions.gamemodeBaseLibraries = gamemodeBaseLibraries;
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: extensionContext.LANGUAGE_ID }],
        initializationOptions: initOptions,
        middleware: {
            async provideCompletionItem(document, position, context, token, next) {
                const result = await next(document, position, context, token);
                return enableCompletionColorPreviewHtmlForResult(result);
            },
            async resolveCompletionItem(item, token, next) {
                const resolvedItem = await next(item, token);
                if (!resolvedItem) {
                    return resolvedItem;
                }

                return enableCompletionColorPreviewHtml(resolvedItem);
            },
            async provideHover() {
                // Suppress the language client's default hover.
                // Our custom HoverVerbosityProvider handles all hover requests.
                return undefined;
            },
        },
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

    throwIfStartupCancelled(startupRunId);

    const client = new LanguageClient(
        extensionContext.LANGUAGE_ID,
        'GLua Language Server',
        serverOptions,
        clientOptions
    );
    const startupStateHandlers = registerLanguageClientStateHandlers(client);
    extensionContext.client = client;

    try {
        throwIfStartupCancelled(startupRunId);
        await client.start();
        throwIfStartupCancelled(startupRunId);
        extensionContext.setServerVersions({
            languageServer: client.initializeResult?.serverInfo?.version,
            annotations: annotationVersion,
        });
        await startupStateHandlers.completion;
    } catch (error) {
        const startupError = error instanceof Error ? error : new Error(String(error));
        startupStateHandlers.dispose(startupError);
        throw startupError;
    }
    throwIfStartupCancelled(startupRunId);
    console.log('GLua Language Server started successfully');

    // Register the custom hover provider with verbosity controls (+/− buttons).
    const { HoverVerbosityProvider } = await import('./hoverVerbosityProvider.js');
    const verbosityProvider = new HoverVerbosityProvider(client);
    disposeHoverProviderRegistration();
    hoverProviderRegistration = vscode.languages.registerHoverProvider(
        { language: extensionContext.LANGUAGE_ID, scheme: 'file' },
        verbosityProvider,
    );

    return startupStateHandlers;
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
    const startParameters = withServerLogPathArgument(
        configManager.getStartParameters(),
        getServerLogDirectory(context)
    );
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

async function showServerLogs(context: vscode.ExtensionContext): Promise<void> {
    const serverLogDirectory = getServerLogDirectory(context);

    try {
        await vscode.workspace.fs.createDirectory(serverLogDirectory);
        await vscode.commands.executeCommand('revealFileInOS', serverLogDirectory);
    } catch {
        vscode.window.showWarningMessage(
            `Could not reveal GLuaLS log folder. Log path: ${serverLogDirectory.fsPath}`
        );
        extensionContext.client?.outputChannel?.show();
    }
}

function logLanguageServerOutput(client: LanguageClient, message: string): void {
    client.outputChannel?.appendLine(`[GLuaLS] ${message}`);
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
        const executableName = platform === 'win32' ? 'glua_ls.exe' : 'glua_ls';
        executablePath = path.join(context.extensionPath, 'server', executableName);
        // Make executable on Unix-like systems
        if (platform !== 'win32') {
            try {
                fs.chmodSync(executablePath, 0o755);
            } catch (error) {
                console.warn(`Failed to chmod language server:`, error);
            }
        }
    }

    return executablePath;
}

function resolveDevLocalExecutablePath(context: vscode.ExtensionContext): string | undefined {
    const platform = os.platform();
    const executableName = platform === 'win32' ? 'glua_ls.exe' : 'glua_ls';
    const legacyEnvPath = process.env['EMMY_DEV_LS_PATH']?.trim();
    const envPath = process.env['GLUALS_DEV_LS_PATH']?.trim();

    const candidates: string[] = [];
    if (legacyEnvPath) {
        candidates.push(path.normalize(legacyEnvPath));
    }
    if (envPath) {
        candidates.push(path.normalize(envPath));
    }

    candidates.push(
        path.resolve(context.extensionPath, '..', 'gmod-glua-ls', 'target', 'debug', executableName),
        path.resolve(context.extensionPath, '..', 'gmod-glua-ls', 'target', 'release', executableName)
    );

    for (const candidatePath of candidates) {
        if (fs.existsSync(candidatePath)) {
            if (platform !== 'win32') {
                try {
                    fs.chmodSync(candidatePath, 0o755);
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
    extensionContext.setServerStopping('Restarting server...');
    const pendingStart = serverStartPromise;
    if (pendingStart) {
        // Restart during startup should cancel the in-flight start without surfacing a failure toast.
        suppressNextStartupError = true;
        cancelPendingStartupRun();
    }

    try {
        await cleanupExistingClient();
        if (pendingStart) {
            await pendingStart.catch(() => {
                // Intentional cancellation during restart.
            });
        }
        await startServer();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        extensionContext.setServerError('Failed to restart server', errorMessage);
        vscode.window.showErrorMessage(`Failed to restart server: ${errorMessage}`);
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

async function startServerCommand(): Promise<void> {
    await startServer();
}

async function stopServer(): Promise<void> {
    const pendingStart = serverStartPromise;
    try {
        if (pendingStart) {
            // Stopping while startup is in-flight is intentional, so suppress startup-failed toast.
            suppressNextStartupError = true;
            cancelPendingStartupRun();
        }
        disposeHoverProviderRegistration();
        await extensionContext.stopServer();
        if (pendingStart) {
            await pendingStart.catch(() => {
                // Intentional cancellation during stop.
            });
        }
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
    await Promise.all([
        gmodRdbUpdater?.runManualUpdateCommand() ?? Promise.resolve(),
        gmodClientRdbUpdater?.runManualUpdateCommand() ?? Promise.resolve(),
    ]);
}

type GmodControlCommand =
    | 'pauseSoft'
    | 'pauseNow'
    | 'resume'
    | 'breakHere'
    | 'waitIDE'
    | 'runLua'
    | 'runFile'
    | 'refreshFile'
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

    const realmAwareCommands: GmodControlCommand[] = ['breakHere', 'waitIDE', 'runLua', 'runFile', 'refreshFile', 'setRealm'];
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

async function runGmodRefreshFile(uri?: vscode.Uri): Promise<void> {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri?.fsPath) {
        vscode.window.showWarningMessage('No Lua file selected.');
        return;
    }
    await runGmodControlCommand('refreshFile', { path: targetUri.fsPath });
}

async function runGmodRunSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor.');
        return;
    }
    const selection = editor.selection;
    const lua = editor.document.getText(selection);
    if (!lua.trim()) {
        vscode.window.showWarningMessage('No text selected.');
        return;
    }
    await runGmodControlCommand('runLua', { lua });
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

function normalizeWorkspaceIgnoreDirEntry(entry: string): string {
    return entry.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

async function addDirectoryToIgnoreList(targetUri?: vscode.Uri): Promise<void> {
    if (!targetUri) {
        vscode.window.showWarningMessage('No directory selected.');
        return;
    }

    let stats: vscode.FileStat;
    try {
        stats = await vscode.workspace.fs.stat(targetUri);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to inspect selected directory: ${message}`);
        return;
    }

    if ((stats.type & vscode.FileType.Directory) === 0) {
        vscode.window.showWarningMessage('The selected Explorer item is not a directory.');
        return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found. Cannot update .gluarc.json.');
        return;
    }

    const relativeDirectory = normalizeWorkspaceIgnoreDirEntry(
        path.relative(workspaceFolder.uri.fsPath, targetUri.fsPath)
    );
    if (!relativeDirectory) {
        vscode.window.showWarningMessage('The workspace root cannot be added to workspace.ignoreDir.');
        return;
    }

    try {
        const exists = await ensureGluarcExists(workspaceFolder);
        if (!exists) {
            return;
        }

        const config = await readGluarcConfig(workspaceFolder);
        const currentIgnoreDir = getNestedValue(config, ['workspace', 'ignoreDir']);
        const currentEntries = Array.isArray(currentIgnoreDir) ? [...currentIgnoreDir] : [];
        const alreadyIgnored = currentEntries.some((entry) =>
            typeof entry === 'string' && normalizeWorkspaceIgnoreDirEntry(entry) === relativeDirectory
        );

        if (alreadyIgnored) {
            vscode.window.showInformationMessage(`'${relativeDirectory}' is already in workspace.ignoreDir.`);
            return;
        }

        currentEntries.push(relativeDirectory);
        setNestedValue(config, ['workspace', 'ignoreDir'], currentEntries);

        const writeSucceeded = await writeGluarcConfig(workspaceFolder, config);
        if (!writeSucceeded) {
            return;
        }

        vscode.window.showInformationMessage(`Added '${relativeDirectory}' to workspace.ignoreDir.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to add directory to workspace.ignoreDir: ${message}`);
    }
}

async function setGmodRealm(realm?: string): Promise<void> {
    const pickedRealm = realm ?? await vscode.window.showQuickPick(
        [...GMOD_REALMS],
        {
            title: 'Select GMod Lua Execution Realm',
            placeHolder: `Current: ${getPersistedGmodRealm()}`
        }
    );
    if (!pickedRealm) {
        return;
    }
    const selectedRealm = normalizeGmodRealm(pickedRealm);
    const currentRealm = getPersistedGmodRealm();
    if (selectedRealm === currentRealm) {
        return;
    }
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
    vscode.window.showInformationMessage(`GMod Lua execution realm set to ${selectedRealm}.`);
}

function onDidStartDebugSession(session: vscode.DebugSession): void {
    if (session.type === 'gluals_gmod') {
        void gmodRdbUpdater?.ensureRuntimeFilesUpToDate(session);
        gmodErrorStores.set(session.id, new GmodErrorStore());
        gmodEntityExplorerProvider?.clear();
        gmodSessionRealms.set(session.id, getPersistedGmodRealm(session));
        gmodRealmProvider?.refresh();
    } else if (session.type === 'gluals_gmod_client') {
        void gmodClientRdbUpdater?.ensureRuntimeFilesUpToDate(session);
        gmodErrorStores.set(session.id, new GmodErrorStore());
    }

    // If this new session is already the active one, reflect it in the views.
    if (vscode.debug.activeDebugSession?.id === session.id) {
        updateActiveSessionViews();
    }
}

function onDidTerminateDebugSession(session: vscode.DebugSession): void {
    const store = gmodErrorStores.get(session.id);
    if (store) {
        store.dispose();
        gmodErrorStores.delete(session.id);
    }

    if (session.type === 'gluals_gmod') {
        gmodEntityExplorerProvider?.clear();
        gmodSessionRealms.delete(session.id);
        gmodRealmProvider?.refresh();
    } else if (session.type === 'gluals_gmod_client') {
        gmodSessionRealms.delete(session.id);
    }

    // Update views in case the terminated session was the active one.
    updateActiveSessionViews();
}

function onDidChangeActiveDebugSession(_session: vscode.DebugSession | undefined): void {
    updateActiveSessionViews();
}

/**
 * Called whenever the active debug session changes (start, terminate, or user switching).
 * Swaps the error view to show errors for the newly active session, and immediately
 * clears/reloads the entity explorer so it reflects the correct session's state.
 */
function updateActiveSessionViews(): void {
    const session = vscode.debug.activeDebugSession;
    const store = session ? gmodErrorStores.get(session.id) : undefined;
    gmodErrorViewProvider?.switchStore(store);
    gmodEntityExplorerProvider?.clear();
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

function initializeGmodErrorView(context: vscode.ExtensionContext): void {
    if (gmodErrorViewProvider) {
        return;
    }

    const registered = registerGmodErrorView(context);
    gmodErrorViewProvider = registered.provider;
}

function initializeGmodEntityExplorerView(context: vscode.ExtensionContext): void {
    if (gmodEntityExplorerProvider) {
        return;
    }

    gmodEntityExplorerProvider = new GmodEntityExplorerProvider(getActiveGmodDebugSession);
    const treeView = vscode.window.createTreeView('gmodEntityExplorer', {
        treeDataProvider: gmodEntityExplorerProvider,
        showCollapseAll: true,
    });

    gmodEntityExplorerProvider.setViewVisible(treeView.visible);
    context.subscriptions.push(treeView.onDidChangeVisibility((event) => {
        gmodEntityExplorerProvider?.setViewVisible(event.visible);
    }));
    context.subscriptions.push(treeView.onDidCollapseElement((event) => {
        if (event.element.data.kind === 'entityTableSection') {
            gmodEntityExplorerProvider?.onEntityTableSectionCollapsed(event.element.data.entityIndex);
            return;
        }

        if (event.element.data.kind === 'networkVarSection') {
            gmodEntityExplorerProvider?.onEntityNetworkVarSectionCollapsed(event.element.data.entityIndex);
        }
    }));

    context.subscriptions.push(gmodEntityExplorerProvider, treeView);
}

function refreshGmodExplorer(): void {
    gmodExplorerProvider?.refresh();
}

function clearGmodErrors(): void {
    gmodErrorViewProvider?.clear();
    const session = vscode.debug.activeDebugSession;
    if (session?.type === 'gluals_gmod' || session?.type === 'gluals_gmod_client') {
        gmodMcpHost?.clearRuntimeErrors(session.id);
    }
}

async function copyGmodExplorerRelativePath(item?: GmodExplorerItem): Promise<void> {
    const preferFolder = item?.data.type !== 'file';
    const uri = await gmodExplorerProvider?.resolveItemUri(item, preferFolder);
    if (!uri) {
        vscode.window.showWarningMessage('No path is available for this item.');
        return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
        : uri.fsPath;

    await vscode.env.clipboard.writeText(relativePath);
    vscode.window.showInformationMessage(`Copied relative path: ${relativePath}`);
}

async function copyGmodExplorerAbsolutePath(item?: GmodExplorerItem): Promise<void> {
    const preferFolder = item?.data.type !== 'file';
    const uri = await gmodExplorerProvider?.resolveItemUri(item, preferFolder);
    if (!uri) {
        vscode.window.showWarningMessage('No path is available for this item.');
        return;
    }

    await vscode.env.clipboard.writeText(uri.fsPath);
    vscode.window.showInformationMessage(`Copied absolute path: ${uri.fsPath}`);
}

async function copyGmodExplorerClassName(item?: GmodExplorerItem): Promise<void> {
    const className = item?.data?.className;
    if (!className) {
        vscode.window.showWarningMessage('No class name available for this item.');
        return;
    }

    await vscode.env.clipboard.writeText(className);
    vscode.window.showInformationMessage(`Copied class name: ${className}`);
}

async function revealGmodExplorerItemInExplorer(item?: GmodExplorerItem): Promise<void> {
    const preferFolder = item?.data.type !== 'file';
    const uri = await gmodExplorerProvider?.resolveItemUri(item, preferFolder);
    if (!uri) {
        vscode.window.showWarningMessage('No file or folder could be resolved for this item.');
        return;
    }

    await vscode.commands.executeCommand('revealInExplorer', uri);
}

async function openGmodErrorLocation(location?: GmodErrorLocation | string): Promise<void> {
    const resolvedLocation = (() => {
        if (typeof location === 'string') {
            return parseGmodErrorLocation(location);
        }
        return location;
    })();

    if (!resolvedLocation) {
        vscode.window.showWarningMessage('No source location could be parsed from this error entry.');
        return;
    }

    const line = Math.max(1, resolvedLocation.line);
    const column = Math.max(1, resolvedLocation.column ?? 1);

    let targetPath = resolvedLocation.filePath;
    if (!path.isAbsolute(targetPath)) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const matchedFolder = folders.find((folder) =>
            fs.existsSync(path.join(folder.uri.fsPath, targetPath))
        );

        if (matchedFolder) {
            targetPath = path.join(matchedFolder.uri.fsPath, targetPath);
        } else if (folders.length > 0) {
            targetPath = path.join(folders[0].uri.fsPath, targetPath);
        }
    }

    const targetUri = vscode.Uri.file(path.normalize(targetPath));
    if (!fs.existsSync(targetUri.fsPath)) {
        vscode.window.showWarningMessage(`Could not find source file: ${targetUri.fsPath}`);
        return;
    }

    const document = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(line - 1, column - 1);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function refreshGmodEntityExplorer(): Promise<void> {
    if (!gmodEntityExplorerProvider) {
        return;
    }

    await gmodEntityExplorerProvider.loadEntities();
}

async function searchGmodEntityExplorer(): Promise<void> {
    if (!gmodEntityExplorerProvider) {
        return;
    }

    const text = await vscode.window.showInputBox({
        title: 'Filter entities',
        prompt: 'Filter by class name or numeric entity index',
        placeHolder: 'Example: prop_physics or 42',
        value: '',
        ignoreFocusOut: true,
    });

    if (text === undefined) {
        return;
    }

    gmodEntityExplorerProvider.setFilter(text);
}

async function filterGmodEntityExplorer(): Promise<void> {
    if (!gmodEntityExplorerProvider) {
        return;
    }

    const currentFilter = gmodEntityExplorerProvider.getClassGroupFilter();
    const picks: Array<vscode.QuickPickItem & { value: EntityClassGroupFilter; }> = [
        {
            label: `${currentFilter === 'all' ? '$(check) ' : ''}All entities`,
            description: 'Show every runtime entity class group',
            value: 'all',
        },
        {
            label: `${currentFilter === 'player' ? '$(check) ' : ''}Players`,
            description: 'Show only player entities',
            value: 'player',
        },
        {
            label: `${currentFilter === 'luaDefined' ? '$(check) ' : ''}Lua defined`,
            description: 'Show only scripted Lua entity classes',
            value: 'luaDefined',
        },
        {
            label: `${currentFilter === 'other' ? '$(check) ' : ''}Other entities`,
            description: 'Show non-player, non-scripted runtime classes',
            value: 'other',
        },
    ];

    const picked = await vscode.window.showQuickPick(picks, {
        title: 'Filter Entity Groups',
        placeHolder: 'Select which entity categories to show',
        ignoreFocusOut: true,
    });

    if (!picked) {
        return;
    }

    gmodEntityExplorerProvider.setClassGroupFilter(picked.value);
}

async function searchGmodEntityExplorerTable(item?: EntityTreeItem): Promise<void> {
    if (!gmodEntityExplorerProvider) {
        return;
    }

    if (!item || (item.data.kind !== 'entityTableSection' && item.data.kind !== 'entityTableSearch')) {
        vscode.window.showWarningMessage('Expand an Entity:GetTable() section and run search from that item.');
        return;
    }

    await gmodEntityExplorerProvider.searchEntityTable(item.data.entityIndex);
}

async function searchGmodEntityExplorerNetworkVars(item?: EntityTreeItem): Promise<void> {
    if (!gmodEntityExplorerProvider) {
        return;
    }

    if (!item || (item.data.kind !== 'networkVarSection' && item.data.kind !== 'networkVarSearch')) {
        vscode.window.showWarningMessage('Expand a NetworkVars section and run search from that item.');
        return;
    }

    await gmodEntityExplorerProvider.searchEntityNetworkVars(item.data.entityIndex);
}

async function editGmodEntityExplorerProperty(item?: EntityTreeItem): Promise<void> {
    if (!gmodEntityExplorerProvider) {
        return;
    }

    if (!item || (
        item.data.kind !== 'property'
        && item.data.kind !== 'tableProperty'
        && item.data.kind !== 'networkVarProperty'
    ) || !item.data.editable) {
        vscode.window.showWarningMessage('Select an editable entity property first.');
        return;
    }

    const editableValue = item.data.value;

    if (editableValue === undefined) {
        vscode.window.showWarningMessage('Selected value is read-only and cannot be edited.');
        return;
    }

    if (item.data.kind === 'networkVarProperty') {
        await gmodEntityExplorerProvider.editNetworkVar(item.data.entityIndex, item.data.property, editableValue);
        return;
    }

    if (item.data.kind === 'tableProperty') {
        await gmodEntityExplorerProvider.editTableValue(item.data.entityIndex, item.data.property, editableValue);
        return;
    }

    await gmodEntityExplorerProvider.editProperty(item.data.entityIndex, item.data.property, editableValue);
}

async function loadMoreGmodEntityExplorer(): Promise<void> {
    if (!gmodEntityExplorerProvider) {
        return;
    }

    await gmodEntityExplorerProvider.loadMore();
}

async function configureGmodDebugger(): Promise<void> {
    await runGmodDebugSetupWizard(extensionContext.vscodeContext, {
        installClientDebugger: async (garrysmodPath: string) => {
            if (!gmodClientRdbUpdater) {
                throw new Error('rdb_client updater is not initialized');
            }

            await gmodClientRdbUpdater.downloadAndInstall(extensionContext.vscodeContext, garrysmodPath);
        },
    });
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

async function openDocumentation(): Promise<void> {
    const url = 'https://gluals.arnux.net/';
    await vscode.env.openExternal(vscode.Uri.parse(url));
}

function initializeGmodMcpHost(context: vscode.ExtensionContext): void {
    if (gmodMcpHost) {
        return;
    }

    gmodMcpHost = new GmodMcpHost({
        secretStorage: context.secrets,
        serverVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
        executeControlCommand: executeGmodControlCommand,
        getCurrentRealm: getPersistedGmodRealm,
        getLanguageIssues: getGmodLanguageIssues,
    });
    context.subscriptions.push(gmodMcpHost);
}

function registerGmodMcpProvider(context: vscode.ExtensionContext): void {
    if (typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
        return;
    }

    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(
        GMOD_MCP_PROVIDER_ID,
        {
            onDidChangeMcpServerDefinitions: gmodMcpHost?.onDidChangeConnection,
            async provideMcpServerDefinitions() {
                if (!gmodMcpHost) {
                    return [];
                }
                try {
                    const connection = await gmodMcpHost.getConnectionInfo();
                    return [createGmodMcpDefinition(connection, false)];
                } catch {
                    return [];
                }
            },
            async resolveMcpServerDefinition() {
                if (!gmodMcpHost) {
                    return undefined;
                }
                const connection = await gmodMcpHost.getConnectionInfo();
                return createGmodMcpDefinition(connection, true);
            },
        }
    ));
}

function createGmodMcpDefinition(
    connection: { url: string; authToken: string; version: string },
    includeAuthentication: boolean
): vscode.McpHttpServerDefinition {
    return new vscode.McpHttpServerDefinition(
        'GLuaLS Garry\'s Mod Runtime',
        vscode.Uri.parse(connection.url),
        includeAuthentication ? { Authorization: `Bearer ${connection.authToken}` } : {},
        connection.version
    );
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

async function copyGmodMcpConfiguration(): Promise<void> {
    if (!gmodMcpHost) {
        return;
    }
    try {
        const connection = await gmodMcpHost.getConnectionInfo();
        const config = {
            servers: {
                'gluals-gmod': {
                    type: 'http',
                    url: connection.url,
                    headers: {
                        Authorization: `Bearer ${connection.authToken}`,
                    },
                },
            },
        };
        await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
        vscode.window.showInformationMessage('Copied the GLuaLS MCP server configuration.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Could not copy MCP configuration: ${message}`);
    }
}

function getGmodLanguageIssues(): GmodLanguageIssue[] {
    const workspaceUris = vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
    const issues: GmodLanguageIssue[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file' || !workspaceUris.some((root) => isUriWithinRoot(uri, root))) {
            continue;
        }
        for (const diagnostic of diagnostics) {
            if (diagnostic.source !== 'GLuaLS') {
                continue;
            }
            const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error
                ? 'error'
                : diagnostic.severity === vscode.DiagnosticSeverity.Warning
                    ? 'warning'
                    : undefined;
            if (!severity) {
                continue;
            }
            const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
            issues.push({
                file: uri.fsPath,
                line: diagnostic.range.start.line + 1,
                column: diagnostic.range.start.character + 1,
                endLine: diagnostic.range.end.line + 1,
                endColumn: diagnostic.range.end.character + 1,
                severity,
                message: diagnostic.message,
                code,
                source: diagnostic.source,
            });
        }
    }
    issues.sort((left, right) => {
        const severity = left.severity === right.severity ? 0 : left.severity === 'error' ? -1 : 1;
        return severity
            || left.file.localeCompare(right.file)
            || left.line - right.line
            || left.column - right.column;
    });
    return issues;
}

function isUriWithinRoot(uri: vscode.Uri, root: vscode.Uri): boolean {
    const relative = path.relative(root.fsPath, uri.fsPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

interface GmodConnectedBody {
    moduleVersion?: unknown;
}

function onDidReceiveDebugSessionCustomEvent(event: vscode.DebugSessionCustomEvent): void {
    if (event.session.type !== 'gluals_gmod' && event.session.type !== 'gluals_gmod_client') {
        return;
    }

    if (event.event === 'gmod.rdb.versionMismatch' && event.session.type === 'gluals_gmod') {
        // Keep legacy event for compatibility, but avoid double prompts.
        // Active version checks are handled on `gmod.connected`.
        return;
    }

    if (event.event === 'gmod.rdb.client.versionMismatch' && event.session.type === 'gluals_gmod_client') {
        // Keep legacy event for compatibility, but avoid double prompts.
        // Active version checks are handled on `gmod.client.connected`.
        return;
    }

    if (event.event === 'gmod.output' && event.body && typeof event.body === 'object') {
        const outputBody = event.body as Record<string, unknown>;
        gmodMcpHost?.recordDebugOutput({
            ...outputBody,
            sessionId: event.session.id,
            sessionName: event.session.name,
        });
        return;
    }

    if (event.event === 'gmod.connected') {
        if (event.body && typeof event.body === 'object' && gmodRdbUpdater) {
            const body = event.body as GmodConnectedBody;
            if (typeof body.moduleVersion === 'string' && body.moduleVersion.length > 0) {
                void gmodRdbUpdater.handleVersionMismatch(body.moduleVersion);
            }
        }
        void gmodEntityExplorerProvider?.loadEntities();
        return;
    }

    if (event.event === 'gmod.client.connected') {
        if (event.body && typeof event.body === 'object' && gmodClientRdbUpdater) {
            const body = event.body as GmodConnectedBody;
            if (typeof body.moduleVersion === 'string' && body.moduleVersion.length > 0) {
                void gmodClientRdbUpdater.handleVersionMismatch(body.moduleVersion);
            }
        }
        return;
    }

    if (event.event === 'gmod.errors.clear') {
        gmodErrorStores.get(event.session.id)?.clear();
        gmodMcpHost?.clearRuntimeErrors(event.session.id);
        return;
    }

    if (event.event === 'gmod.error') {
        const params = coerceGmodErrorNotificationParams(event.body);
        if (params) {
            gmodErrorStores.get(event.session.id)?.addError(params);
            gmodMcpHost?.recordRuntimeError(params, {
                id: event.session.id,
                name: event.session.name,
                realm: event.session.type === 'gluals_gmod_client' ? 'client' : 'server',
            });
        }
        return;
    }

    if (event.event === 'gmod.controlResult' && event.body && typeof event.body === 'object') {
        const result = event.body as GmodControlResult;
        if (result.command === 'setRealm') {
            gmodSessionRealms.set(event.session.id, normalizeGmodRealm(result.realm));
        }
        return;
    }

    if (event.event === 'gmod.controlError') {
        const body = event.body as { message?: unknown; details?: unknown } | undefined;
        const message = typeof body?.message === 'string' ? body.message : 'Unknown control error';
        gmodMcpHost?.recordBackendError(message, {
            id: event.session.id,
            name: event.session.name,
            realm: event.session.type === 'gluals_gmod_client' ? 'client' : 'server',
        });
    }
}

function coerceGmodErrorNotificationParams(body: unknown): GmodErrorNotificationParams | undefined {
    if (!body || typeof body !== 'object') {
        return undefined;
    }

    const raw = body as Record<string, unknown>;
    const message = typeof raw.message === 'string' ? raw.message.trim() : '';
    if (message.length === 0) {
        return undefined;
    }

    const rawFingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint.trim() : '';
    const fingerprint = rawFingerprint.length > 0 ? rawFingerprint : `error:${message}`;
    const source = raw.source === 'console' ? 'console' : 'lua';
    const count = typeof raw.count === 'number' && Number.isFinite(raw.count)
        ? Math.max(1, Math.floor(raw.count))
        : 1;
    const stackTrace = Array.isArray(raw.stackTrace)
        ? (raw.stackTrace as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined;
    const timestamp = typeof raw.timestamp === 'string' || typeof raw.timestamp === 'number'
        ? raw.timestamp
        : undefined;

    return {
        message,
        fingerprint,
        count,
        source,
        stackTrace,
        timestamp,
    };
}


