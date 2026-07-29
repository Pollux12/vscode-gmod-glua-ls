import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

import {
    enableCompletionColorPreviewHtml,
    enableCompletionColorPreviewHtmlForResult,
} from '../../completionColorPreview';
import { GmodClientRdbUpdater } from '../../debugger/gmod_debugger/GmodClientRdbUpdater';
import { GmodRdbUpdater } from '../../debugger/gmod_debugger/GmodRdbUpdater';
import { ServerState } from '../../emmyContext';
import {
    extensionContext,
    onDidStartDebugSession,
    onDidTerminateDebugSession,
} from '../../extension';
import { GmodAnnotationManager } from '../../gmodAnnotationManager';
import { activateExtension, getFixtureUri } from './helper';

const COLOR_COMPLETION_DOCUMENTATION = '`Color(255, 255, 255)`';

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
    const timeoutAt = Date.now() + 5_000;
    while (!condition()) {
        if (Date.now() >= timeoutAt) {
            assert.fail(message);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function countFailedStartupAttempts(command: string): Promise<number> {
    const originalClearServerVersions = extensionContext.clearServerVersions;
    let startupAttempts = 0;
    extensionContext.clearServerVersions = () => {
        startupAttempts += 1;
        originalClearServerVersions.call(extensionContext);
    };
    try {
        await vscode.commands.executeCommand(command);
    } finally {
        extensionContext.clearServerVersions = originalClearServerVersions;
    }
    return startupAttempts;
}

async function assertStopCancelsLazyInitialization(): Promise<void> {
    const originalInitializeAnnotations = GmodAnnotationManager.prototype.initializeAnnotations;
    const originalClearServerVersions = extensionContext.clearServerVersions;
    const originalStopServer = extensionContext.stopServer;
    let initializationStarted = false;
    let stopObserved = false;
    let startupAttempts = 0;
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
    });
    let startCommand: Thenable<unknown> | undefined;
    let stopCommand: Thenable<unknown> | undefined;

    GmodAnnotationManager.prototype.initializeAnnotations = async () => {
        initializationStarted = true;
        await initializationGate;
    };
    extensionContext.clearServerVersions = () => {
        startupAttempts += 1;
        originalClearServerVersions.call(extensionContext);
    };
    extensionContext.stopServer = async () => {
        stopObserved = true;
        await originalStopServer.call(extensionContext);
    };

    try {
        startCommand = vscode.commands.executeCommand('gluals.startServer');
        await waitForCondition(
            () => initializationStarted,
            'Expected lazy extension initialization to begin.'
        );

        stopCommand = vscode.commands.executeCommand('gluals.stopServer');
        await waitForCondition(
            () => stopObserved,
            'Expected Stop Server to run while initialization was pending.'
        );

        releaseInitialization();
        await Promise.all([startCommand, stopCommand]);

        assert.strictEqual(
            startupAttempts,
            0,
            'Stopping during lazy initialization must prevent language-server startup.'
        );
        assert.strictEqual(extensionContext.client, undefined);
        assert.strictEqual(extensionContext.serverStatus.state, ServerState.Stopped);
    } finally {
        releaseInitialization();
        if (startCommand) {
            try {
                await startCommand;
            } catch {
                // Preserve the original test failure while allowing cleanup to finish.
            }
        }
        if (stopCommand) {
            try {
                await stopCommand;
            } catch {
                // Preserve the original test failure while allowing cleanup to finish.
            }
        }
        GmodAnnotationManager.prototype.initializeAnnotations = originalInitializeAnnotations;
        extensionContext.clearServerVersions = originalClearServerVersions;
        extensionContext.stopServer = originalStopServer;
    }
}

async function assertStopCancelsRestartCleanup(): Promise<void> {
    const originalClearServerVersions = extensionContext.clearServerVersions;
    let cleanupStarted = false;
    let startupAttempts = 0;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
    });
    let restartCommand: Thenable<unknown> | undefined;
    let stopCommand: Thenable<unknown> | undefined;

    extensionContext.client = {
        stop: async () => {
            cleanupStarted = true;
            await cleanupGate;
        },
    } as unknown as LanguageClient;
    extensionContext.clearServerVersions = () => {
        startupAttempts += 1;
        originalClearServerVersions.call(extensionContext);
    };

    try {
        restartCommand = vscode.commands.executeCommand('gluals.restartServer');
        await waitForCondition(
            () => cleanupStarted,
            'Expected Restart Server to begin cleaning up the existing client.'
        );

        stopCommand = vscode.commands.executeCommand('gluals.stopServer');
        await stopCommand;

        releaseCleanup();
        await restartCommand;

        assert.strictEqual(
            startupAttempts,
            0,
            'Stopping during restart cleanup must prevent the replacement server from starting.'
        );
        assert.strictEqual(extensionContext.client, undefined);
        assert.strictEqual(extensionContext.serverStatus.state, ServerState.Stopped);
    } finally {
        releaseCleanup();
        if (!stopCommand) {
            stopCommand = vscode.commands.executeCommand('gluals.stopServer');
        }
        try {
            await stopCommand;
        } catch {
            // Preserve the original test failure while allowing cleanup to finish.
        }
        if (restartCommand) {
            try {
                await restartCommand;
            } catch {
                // Preserve the original test failure while allowing cleanup to finish.
            }
        }
        extensionContext.client = undefined;
        extensionContext.clearServerVersions = originalClearServerVersions;
    }
}

suite('Extension Integration', () => {
    test('activates lightweight guidance for a likely GMod file opened as standard Lua', async () => {
        const extension = vscode.extensions.getExtension('Pollux.gmod-glua-ls');
        assert.ok(extension, 'Expected the GLuaLS extension to be installed in the test host.');
        assert.strictEqual(extension.isActive, false, 'This test must exercise cold-start activation.');

        const docUri = getFixtureUri('cold-start-gamemode/gamemode/init.lua');
        const document = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(document);
        await waitForCondition(
            () => extension.isActive,
            'Expected standard Lua activation to start the lightweight GLuaLS client.'
        );

        assert.strictEqual(document.languageId, 'lua');
        assert.strictEqual(extension.isActive, true);
        assert.strictEqual(
            extensionContext.client,
            undefined,
            'Opening a standard Lua document must not start GLuaLS.'
        );

        const registeredCommands = await vscode.commands.getCommands(true);
        assert.ok(registeredCommands.includes('gluals.useGluaLanguageMode'));
        assert.ok(
            vscode.lm.tools.some((tool) => tool.name === 'search_glua_docs'),
            'Non-language providers must register during lightweight activation.'
        );

        const originalServerRuntimeSync = GmodRdbUpdater.prototype.ensureRuntimeFilesUpToDate;
        const originalClientRuntimeSync = GmodClientRdbUpdater.prototype.ensureRuntimeFilesUpToDate;
        const serverRuntimeSyncSessions: Array<vscode.DebugSession | undefined> = [];
        const clientRuntimeSyncSessions: Array<vscode.DebugSession | undefined> = [];
        GmodRdbUpdater.prototype.ensureRuntimeFilesUpToDate = async (session) => {
            serverRuntimeSyncSessions.push(session);
        };
        GmodClientRdbUpdater.prototype.ensureRuntimeFilesUpToDate = async (session) => {
            clientRuntimeSyncSessions.push(session);
        };
        const serverDebugSession = { id: 'test-server', type: 'gluals_gmod' } as vscode.DebugSession;
        const clientDebugSession = { id: 'test-client', type: 'gluals_gmod_client' } as vscode.DebugSession;
        try {
            onDidStartDebugSession(serverDebugSession);
            onDidStartDebugSession(clientDebugSession);
        } finally {
            onDidTerminateDebugSession(serverDebugSession);
            onDidTerminateDebugSession(clientDebugSession);
            GmodRdbUpdater.prototype.ensureRuntimeFilesUpToDate = originalServerRuntimeSync;
            GmodClientRdbUpdater.prototype.ensureRuntimeFilesUpToDate = originalClientRuntimeSync;
        }
        assert.deepStrictEqual(serverRuntimeSyncSessions, [serverDebugSession]);
        assert.deepStrictEqual(clientRuntimeSyncSessions, [clientDebugSession]);
        assert.strictEqual(
            extensionContext.client,
            undefined,
            'Debug runtime setup must not start the language server.'
        );

        const glualsConfig = vscode.workspace.getConfiguration('gluals');
        const executablePathWorkspaceValue = glualsConfig.inspect<string>('ls.executablePath')?.workspaceValue;
        const debugPortWorkspaceValue = glualsConfig.inspect<number | null>('ls.debugPort')?.workspaceValue;
        await glualsConfig.update(
            'ls.executablePath',
            getFixtureUri('__missing-glua-ls.exe').fsPath,
            vscode.ConfigurationTarget.Workspace
        );
        await glualsConfig.update('ls.debugPort', null, vscode.ConfigurationTarget.Workspace);
        try {
            await assertStopCancelsLazyInitialization();
            await assertStopCancelsRestartCleanup();

            let toolFailureMessage = '';
            await assert.rejects(
                async () => await vscode.lm.invokeTool(
                    'search_glua_docs',
                    {
                        toolInvocationToken: undefined,
                        input: { query: 'Entity:GetPos' },
                    }
                ),
                (error: unknown) => {
                    toolFailureMessage = error instanceof Error ? error.message : String(error);
                    return true;
                }
            );
            const startupFailureDetails = extensionContext.serverStatus.details;
            assert.ok(startupFailureDetails, 'Expected the failed tool startup to record its reason.');
            assert.ok(
                toolFailureMessage.includes(startupFailureDetails),
                `Expected the tool caller to receive "${startupFailureDetails}", got "${toolFailureMessage}".`
            );

            assert.strictEqual(
                await countFailedStartupAttempts('gluals.startServer'),
                1,
                'A failed start command must make exactly one language-server startup attempt.'
            );
            assert.strictEqual(
                await countFailedStartupAttempts('gluals.restartServer'),
                1,
                'A failed restart command must make exactly one language-server startup attempt.'
            );
        } finally {
            await glualsConfig.update(
                'ls.executablePath',
                executablePathWorkspaceValue,
                vscode.ConfigurationTarget.Workspace
            );
            await glualsConfig.update(
                'ls.debugPort',
                debugPortWorkspaceValue,
                vscode.ConfigurationTarget.Workspace
            );
        }

        await vscode.commands.executeCommand('gluals.useGluaLanguageMode', docUri);
        await Promise.all([
            vscode.commands.executeCommand('gluals.startServer'),
            vscode.commands.executeCommand('gluals.startServer'),
        ]);
        const switchedDocument = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === docUri.toString()
        );
        assert.strictEqual(switchedDocument?.languageId, 'glua');
        assert.notStrictEqual(
            extensionContext.serverStatus.state,
            ServerState.Stopped,
            'Selecting GLua must attempt full language-server startup.'
        );
    });

    test('activates and registers core commands', async () => {
        const docUri = getFixtureUri('sample.lua');
        const extension = await activateExtension(docUri);
        assert.strictEqual(extension.isActive, true);
        assert.strictEqual(
            vscode.workspace.textDocuments.find((document) => document.uri.toString() === docUri.toString())?.languageId,
            'glua'
        );

        const registeredCommands = await vscode.commands.getCommands(true);
        const expectedCommands = [
            'gluals.startServer',
            'gluals.stopServer',
            'gluals.restartServer',
            'gluals.showSyntaxTree',
            'gluals.gmod.runLua',
            'gluals.useGluaLanguageMode',
        ];

        for (const commandId of expectedCommands) {
            assert.ok(registeredCommands.includes(commandId), `Expected command to be registered: ${commandId}`);
        }

        const registeredLanguages = await vscode.languages.getLanguages();
        assert.ok(registeredLanguages.includes('glua'));
        assert.ok(registeredLanguages.includes('lua'));
    });

    test('executes completion provider command for fixture document', async () => {
        const docUri = getFixtureUri('sample.lua');
        await activateExtension(docUri);

        const completionList = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            docUri,
            new vscode.Position(0, 0)
        );

        assert.ok(completionList, 'Expected completion provider command to return a completion list.');
    });

    test('does not apply GLua quick fixes to standard Lua documents', async () => {
        const docUri = getFixtureUri('sample.lua');
        const gluarcPath = getFixtureUri('.gluarc.json').fsPath;
        if (fs.existsSync(gluarcPath)) {
            fs.unlinkSync(gluarcPath);
        }

        await activateExtension(docUri);
        const openedDocument = await vscode.workspace.openTextDocument(docUri);
        const luaDocument = await vscode.languages.setTextDocumentLanguage(openedDocument, 'lua');
        const editor = await vscode.window.showTextDocument(luaDocument);
        editor.selection = new vscode.Selection(0, 7, 0, 7);

        const diagnostics = vscode.languages.createDiagnosticCollection('gluals-language-isolation-test');
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(0, 6, 0, 11),
            'Undefined global value',
            vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = 'undefined-global';
        diagnostics.set(docUri, [diagnostic]);

        try {
            await vscode.commands.executeCommand('gluals.addUndefinedGlobalToGlobals');
            assert.strictEqual(
                fs.existsSync(gluarcPath),
                false,
                'Standard Lua diagnostics must not update .gluarc.json'
            );
        } finally {
            diagnostics.dispose();
            if (fs.existsSync(gluarcPath)) {
                fs.unlinkSync(gluarcPath);
            }
            const restoredDocument = await vscode.languages.setTextDocumentLanguage(luaDocument, 'glua');
            await vscode.window.showTextDocument(restoredDocument);
        }
    });

    test('uses GLua for conventional Garry’s Mod paths outside the game directory', async () => {
        const fixturePaths = [
            'standalone-addon/lua/autorun/server/example.lua',
            'standalone-gamemode/gamemode/init.lua',
            'standalone-script/sh_config.lua',
        ];

        for (const fixturePath of fixturePaths) {
            const document = await vscode.workspace.openTextDocument(getFixtureUri(fixturePath));
            assert.strictEqual(document.languageId, 'glua', fixturePath);
        }
    });

    test('switches a likely Garry’s Mod file from Lua to GLua on request', async () => {
        const docUri = getFixtureUri('standalone-gamemode/gamemode/init.lua');
        const openedDocument = await vscode.workspace.openTextDocument(docUri);
        const luaDocument = await vscode.languages.setTextDocumentLanguage(openedDocument, 'lua');
        assert.strictEqual(luaDocument.languageId, 'lua');

        await vscode.commands.executeCommand('gluals.useGluaLanguageMode', docUri);

        const switchedDocument = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === docUri.toString()
        );
        assert.strictEqual(switchedDocument?.languageId, 'glua');
    });

    test('sets parseable detail for color completion previews', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Color;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, '#FFFFFF');
        assert.ok(item.documentation instanceof vscode.MarkdownString);
        assert.strictEqual(item.documentation.value, COLOR_COMPLETION_DOCUMENTATION);
    });

    test('adds parseable fallback documentation for initial completion list color previews', () => {
        const colorItem = new vscode.CompletionItem('color_white');
        colorItem.kind = vscode.CompletionItemKind.Color;
        (colorItem as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };
        const plainItem = new vscode.CompletionItem('plain');
        const list = new vscode.CompletionList([colorItem, plainItem]);

        enableCompletionColorPreviewHtmlForResult(list);

        assert.strictEqual(colorItem.detail, '#FFFFFF');
        assert.strictEqual(colorItem.documentation, undefined);
        assert.strictEqual(plainItem.detail, undefined);
    });

    test('does not set color detail for non-color completion items', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Variable;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, undefined);
    });

    test('uses color metadata rather than preview text for completion detail', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Color;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 0,
                green: 0,
                blue: 0,
                alpha: 255,
                hex: '#000000',
            },
        };
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, '#000000');
    });

    test('does not set color detail for documentation text without color metadata', () => {
        const item = new vscode.CompletionItem('not_a_color');
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, undefined);
    });

    test('does not set color detail for invalid color metadata', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Color;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 300,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, undefined);
    });
});
