import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { extensionContext } from '../../extension';
import { ServerState } from '../../emmyContext';
import { getFixtureUri } from '../suite/helper';

const samples: Record<string, number[]> = {};

async function eventually<T>(name: string, read: () => Thenable<T>, accepts: (value: T) => boolean): Promise<T> {
    const start = performance.now();
    let value: T;
    do {
        value = await read();
        if (accepts(value)) {
            (samples[name] ??= []).push(performance.now() - start);
            return value;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (performance.now() - start < 30_000);
    assert.fail(`${name} did not converge. Last result: ${JSON.stringify(value)}`);
}

function position(document: vscode.TextDocument, marker: string): vscode.Position {
    const offset = document.getText().indexOf(marker);
    assert.notStrictEqual(offset, -1, `Missing marker ${marker}`);
    return document.positionAt(offset + marker.length);
}

async function open(relativePath: string, text: string): Promise<vscode.TextDocument> {
    const uri = getFixtureUri(`real-server/lua/autorun/${relativePath}`);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    assert.strictEqual(document.languageId, 'glua');
    return document;
}

async function replace(document: vscode.TextDocument, before: string, after: string): Promise<void> {
    const offset = document.getText().indexOf(before);
    assert.notStrictEqual(offset, -1);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + before.length)), after);
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
}

function labels(result: vscode.CompletionList | undefined): string[] {
    return result?.items.map(item => typeof item.label === 'string' ? item.label : item.label.label) ?? [];
}

async function complete(document: vscode.TextDocument, marker: string, expected: string, name = 'completion'): Promise<vscode.CompletionList | undefined> {
    return eventually(name, () => vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', document.uri, position(document, marker), undefined, 10
    ), result => labels(result).includes(expected));
}

function diagnosticCodes(document: vscode.TextDocument): string[] {
    return vscode.languages.getDiagnostics(document.uri).map(diagnostic => {
        const code = diagnostic.code;
        return String(typeof code === 'object' ? code.value : code);
    });
}

suite('Real language server editor workflows', function () {
    this.timeout(90_000);
    const savedSettings = new Map<string, unknown>();
    const root = getFixtureUri('real-server');

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension('Pollux.gmod-glua-ls');
        assert.ok(extension);
        const executable = process.env.GLUALS_TEST_SERVER || path.resolve(__dirname,
            '../../../../gmod-glua-ls/target/dist', process.platform === 'win32' ? 'glua_ls.exe' : 'glua_ls');
        const annotations = process.env.GLUALS_TEST_ANNOTATIONS || path.resolve(__dirname,
            '../../../../annotations-gmod-glua-ls/output');
        assert.ok(fs.existsSync(executable), `Build cargo build --profile dist -p glua_ls or set GLUALS_TEST_SERVER: ${executable}`);
        assert.ok(fs.existsSync(annotations), `Set GLUALS_TEST_ANNOTATIONS to generated GMod annotations: ${annotations}`);
        const config = vscode.workspace.getConfiguration('gluals');
        for (const [key, value] of Object.entries({
            'ls.executablePath': executable, 'ls.annotationPath': annotations,
            'ls.debugPort': null, 'gmod.autoLoadAnnotations': true,
        })) {
            savedSettings.set(key, config.inspect(key)?.workspaceValue);
            await config.update(key, value, vscode.ConfigurationTarget.Workspace);
        }
        await config.update('gmod.mcp.enabled', false, vscode.ConfigurationTarget.Global);
        await extension.activate();
        console.log(`REAL_SERVER ${JSON.stringify({ executable, annotations, vscode: vscode.version })}`);
        const started = performance.now();
        await vscode.commands.executeCommand('gluals.startServer');
        await eventually('startup-ready', async () => extensionContext.serverStatus.state, state => state === ServerState.Running);
        samples['server-start-command'] = [performance.now() - started];
    });

    teardown(async () => {
        for (const document of vscode.workspace.textDocuments) {
            if (document.uri.fsPath.startsWith(root.fsPath + path.sep) && document.isDirty) {
                await document.save();
            }
        }
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        if (fs.existsSync(root.fsPath)) {
            await vscode.workspace.fs.delete(root, { recursive: true });
        }
        const config = vscode.workspace.getConfiguration('gluals');
        for (const [key, value] of savedSettings) {
            await config.update(key, value, vscode.ConfigurationTarget.Workspace);
        }
        console.log(`EDITOR_TIMINGS_MS ${JSON.stringify(samples)}`);
        if (process.env.GLUALS_TEST_METRICS) {
            fs.writeFileSync(process.env.GLUALS_TEST_METRICS, JSON.stringify(samples, null, 2));
        }
        await vscode.commands.executeCommand('gluals.stopServer');
    });

    test('completes real GMod members and resolves hover and signature help', async () => {
        const document = await open('sh_members.lua', '---@param ply Player\nlocal function greet(ply)\n    ply:GetPos()\n    print(ply)\nend\n');
        await complete(document, 'ply:', 'GetPos', 'gmod-member-completion');
        await eventually('hover', () => vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', document.uri, position(document, 'ply:GetPo')
        ), result => result?.some(hover => hover.contents.some(content =>
            (typeof content === 'string' ? content : content.value).includes('Vector')
        )) ?? false);
        await eventually('signature-help', () => vscode.commands.executeCommand<vscode.SignatureHelp>(
            'vscode.executeSignatureHelpProvider', document.uri, position(document, 'print(')
        ), result => (result?.signatures.length ?? 0) > 0);
    });

    test('publishes and clears real diagnostics after unsaved edits and rapid typing', async () => {
        const document = await open('sh_diagnostics.lua', '---@type number\nlocal score = "wrong"\nprint(score)\n');
        await eventually('initial-diagnostic', async () => diagnosticCodes(document), codes => codes.includes('assign-type-mismatch'));
        await replace(document, '"wrong"', '42');
        assert.strictEqual(document.isDirty, true);
        await eventually('edit-diagnostic-clear', async () => diagnosticCodes(document), codes => !codes.includes('assign-type-mismatch'));
        for (const [before, after] of [['42', '"one"'], ['"one"', '43'], ['43', '"final"']]) {
            await replace(document, before, after);
        }
        await eventually('typing-burst-diagnostic', async () => diagnosticCodes(document), codes => codes.includes('assign-type-mismatch'));
        await replace(document, '"final"', '44');
        await eventually('typing-burst-clear', async () => diagnosticCodes(document), codes => !codes.includes('assign-type-mismatch'));
        assert.strictEqual(await document.save(), true);
    });

    test('updates cross-file completion and definition after an unsaved member rename', async () => {
        const provider = await open('sh_provider.lua', 'EditorProbe = {}\nfunction EditorProbe.Before() return 1 end\n');
        const consumer = await open('sh_consumer.lua', 'EditorProbe.Before()\n');
        await complete(consumer, 'EditorProbe.', 'Before');
        await eventually('definition', () => vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
            'vscode.executeDefinitionProvider', consumer.uri, position(consumer, 'EditorProbe.Befo')
        ), result => result?.some(location => ('targetUri' in location ? location.targetUri : location.uri).toString() === provider.uri.toString()) ?? false);
        await replace(provider, 'Before', 'After');
        await eventually('cross-file-edit-completion', () => vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', consumer.uri, position(consumer, 'EditorProbe.')
        ), result => labels(result).includes('After') && !labels(result).includes('Before'));
        await replace(consumer, 'Before', 'After');
        assert.strictEqual(await provider.save(), true);
        assert.strictEqual(await consumer.save(), true);
    });

    test('removes deleted file members and indexes recreated files', async () => {
        await open('sh_lifecycle_base.lua', 'EditorLifecycle = {}\nfunction EditorLifecycle.Keep() end\n');
        const removed = await open('sh_lifecycle_removed.lua', 'function EditorLifecycle.Transient() end\n');
        const consumer = await open('sh_lifecycle_consumer.lua', 'EditorLifecycle.Keep()\n');
        await complete(consumer, 'EditorLifecycle.', 'Transient');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const edit = new vscode.WorkspaceEdit();
        edit.deleteFile(removed.uri);
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        const reopened = await vscode.workspace.openTextDocument(consumer.uri);
        await vscode.window.showTextDocument(reopened);
        await eventually('delete-file-completion', () => vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', reopened.uri, position(reopened, 'EditorLifecycle.')
        ), result => labels(result).includes('Keep') && !labels(result).includes('Transient'));
        await open('sh_lifecycle_removed.lua', 'function EditorLifecycle.Recreated() end\n');
        await complete(reopened, 'EditorLifecycle.', 'Recreated', 'recreate-file-completion');
    });

    test('recovers diagnostics and completion after an incomplete expression', async () => {
        const document = await open('sh_syntax.lua', 'local options = { Enabled = true }\nprint(options.Enabled)\n');
        await complete(document, 'options.', 'Enabled');
        await replace(document, 'print(options.Enabled)', 'print(options.');
        await eventually('syntax-diagnostic', async () => diagnosticCodes(document), codes => codes.includes('syntax-error'));
        await complete(document, 'options.', 'Enabled', 'incomplete-expression-completion');
        await replace(document, 'print(options.', 'print(options.Enabled)');
        await eventually('syntax-recovery', async () => diagnosticCodes(document), codes => !codes.includes('syntax-error'));
        assert.strictEqual(await document.save(), true);
    });
    test('preserves completion after save, close, reopen and server restart', async () => {
        const document = await open('sh_reopen.lua', 'local settings = { Enabled = true }\nprint(settings.Enabled)\n');
        await complete(document, 'settings.', 'Enabled');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await eventually('editor-close', async () => vscode.window.visibleTextEditors,
            editors => editors.every(editor => editor.document.uri.toString() !== document.uri.toString()));
        const reopened = await vscode.workspace.openTextDocument(document.uri);
        await vscode.window.showTextDocument(reopened);
        await complete(reopened, 'settings.', 'Enabled', 'reopen-completion');
        const client = extensionContext.client;
        const started = performance.now();
        await vscode.commands.executeCommand('gluals.restartServer');
        await eventually('restart-ready', async () => extensionContext.serverStatus.state, state => state === ServerState.Running);
        samples['server-restart-command'] = [performance.now() - started];
        assert.notStrictEqual(extensionContext.client, client);
        await complete(reopened, 'settings.', 'Enabled', 'restart-completion');
    });

});
