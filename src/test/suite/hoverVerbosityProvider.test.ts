import * as assert from 'assert';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

import { HoverVerbosityProvider } from '../../hoverVerbosityProvider';

suite('Hover Verbosity Provider', () => {
    test('keeps server hover markdown untrusted', async () => {
        const client = {
            sendRequest: async () => ({
                content: { kind: 'markdown', value: '[Run](command:gluals.restartServer)' },
                maxLevel: 0,
            }),
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client);
        const document = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local value = 1' });

        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );

        assert.ok(hover);
        const markdown = hover.contents[0] as vscode.MarkdownString;
        assert.notStrictEqual(markdown.isTrusted, true);
    });

    test('starts at default verbosity level zero and increments repeated hovers', async () => {
        const levels: Array<number | undefined> = [];
        const client = {
            sendRequest: async (_method: string, params: { level?: number }) => {
                levels.push(params.level);
                return {
                    content: { kind: 'markdown', value: 'hover' },
                    maxLevel: 2,
                };
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client);
        const document = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local value = 1' });

        const firstHover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );
        assert.ok(firstHover);

        await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
            { previousHover: firstHover, verbosityDelta: 1 },
        );

        assert.deepStrictEqual(levels, [0, 1]);
    });

    test('marks initial hover with one expandable level as increasable but not decreasable', async () => {
        const client = {
            sendRequest: async () => ({
                content: { kind: 'markdown', value: 'hover' },
                maxLevel: 1,
            }),
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client);
        const document = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local value = 1' });

        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );

        assert.ok(hover);
        assert.strictEqual((hover as vscode.VerboseHover).canIncreaseVerbosity, true);
        assert.strictEqual((hover as vscode.VerboseHover).canDecreaseVerbosity, false);
    });

    test('marks non-expandable hover as neither increasable nor decreasable', async () => {
        const client = {
            sendRequest: async () => ({
                content: { kind: 'markdown', value: 'hover' },
                maxLevel: 0,
            }),
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client);
        const document = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local value = 1' });

        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );

        assert.ok(hover);
        assert.strictEqual((hover as vscode.VerboseHover).canIncreaseVerbosity, false);
        assert.strictEqual((hover as vscode.VerboseHover).canDecreaseVerbosity, false);
    });

    test('collapses expanded hover to default level zero without underflowing', async () => {
        const levels: Array<number | undefined> = [];
        const client = {
            sendRequest: async (_method: string, params: { level?: number }) => {
                levels.push(params.level);
                return {
                    content: { kind: 'markdown', value: 'hover' },
                    maxLevel: 2,
                };
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client);
        const document = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local value = 1' });

        const firstHover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );
        assert.ok(firstHover);

        const expandedHover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
            { previousHover: firstHover, verbosityDelta: 1 },
        );
        assert.ok(expandedHover);

        const collapsedHover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
            { previousHover: expandedHover, verbosityDelta: -1 },
        );
        assert.ok(collapsedHover);

        await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
            { previousHover: collapsedHover, verbosityDelta: -1 },
        );

        assert.deepStrictEqual(levels, [0, 1, 0, 0]);
    });
});
