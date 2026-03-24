import * as assert from 'assert';
import * as vscode from 'vscode';

import { activateExtension, getFixtureUri } from './helper';

suite('Extension Integration', () => {
    test('activates and registers core commands', async () => {
        const extension = await activateExtension(getFixtureUri('sample.lua'));
        assert.strictEqual(extension.isActive, true);

        const registeredCommands = await vscode.commands.getCommands(true);
        const expectedCommands = [
            'gluals.startServer',
            'gluals.stopServer',
            'gluals.restartServer',
            'gluals.showSyntaxTree',
            'gluals.gmod.runLua',
        ];

        for (const commandId of expectedCommands) {
            assert.ok(registeredCommands.includes(commandId), `Expected command to be registered: ${commandId}`);
        }
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
});
