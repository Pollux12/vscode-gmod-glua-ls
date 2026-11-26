import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    ErrorCodes,
    HoverRequest,
    LSPErrorCodes,
    ResponseError,
    type LanguageClient,
} from 'vscode-languageclient/node';

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
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

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
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

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
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

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
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

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
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

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

    test('retries transient ContentModified errors and returns hover when analysis settles', async () => {
        let attempts = 0;
        const client = {
            sendRequest: async () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new ResponseError(LSPErrorCodes.ContentModified, 'content modified');
                }
                return {
                    content: { kind: 'markdown', value: 'settled hover' },
                    maxLevel: 0,
                };
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client, { retryDelayMs: 0 });
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );

        assert.strictEqual(attempts, 3);
        assert.ok(hover);
        const markdown = hover.contents[0] as vscode.MarkdownString;
        assert.strictEqual(markdown.value, 'settled hover');
    });

    test('retries server initializing RequestCancelled when caller token is active', async () => {
        let attempts = 0;
        const client = {
            sendRequest: async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new ResponseError(LSPErrorCodes.RequestCancelled, 'server initializing');
                }
                return {
                    content: { kind: 'markdown', value: 'ready hover' },
                    maxLevel: 0,
                };
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client, { retryDelayMs: 0 });
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );

        assert.strictEqual(attempts, 2);
        assert.ok(hover);
        assert.strictEqual((hover.contents[0] as vscode.MarkdownString).value, 'ready hover');
    });

    test('falls back to textDocument/hover after transient hoverExpand retries are exhausted', async () => {
        const methods: string[] = [];
        const client = {
            sendRequest: async (methodOrType: string | { method: string }) => {
                const method = typeof methodOrType === 'string' ? methodOrType : methodOrType.method;
                methods.push(method);
                if (method === 'gluals/hoverExpand') {
                    throw new ResponseError(LSPErrorCodes.ContentModified, 'content modified');
                }
                return {
                    contents: { kind: 'markdown', value: 'fallback hover' },
                };
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client, {
            maxTransientRetries: 1,
            retryDelayMs: 0,
        });
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );

        assert.deepStrictEqual(methods, ['gluals/hoverExpand', 'gluals/hoverExpand', HoverRequest.method]);
        assert.ok(hover);
        assert.strictEqual((hover.contents[0] as vscode.MarkdownString).value, 'fallback hover');
    });

    test('falls back immediately to textDocument/hover on MethodNotFound and remembers support', async () => {
        const methods: string[] = [];
        const client = {
            sendRequest: async (methodOrType: string | { method: string }) => {
                const method = typeof methodOrType === 'string' ? methodOrType : methodOrType.method;
                methods.push(method);
                if (method === 'gluals/hoverExpand') {
                    throw new ResponseError(ErrorCodes.MethodNotFound, 'handler not found');
                }
                return {
                    contents: { kind: 'markdown', value: 'standard hover' },
                };
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client, { retryDelayMs: 0 });
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

        const firstHover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );
        const secondHover = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );

        assert.deepStrictEqual(methods, ['gluals/hoverExpand', HoverRequest.method, HoverRequest.method]);
        assert.ok(firstHover);
        assert.ok(secondHover);
    });

    test('returns null without retrying when cancelled or connection is inactive', async () => {
        let calls = 0;
        const client = {
            sendRequest: async () => {
                calls += 1;
                throw new ResponseError(ErrorCodes.ConnectionInactive, 'Client is not running');
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client, { retryDelayMs: 0 });
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

        const inactiveResult = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            new vscode.CancellationTokenSource().token,
        );
        assert.strictEqual(inactiveResult, null);
        assert.strictEqual(calls, 1);

        const cancelledSource = new vscode.CancellationTokenSource();
        cancelledSource.cancel();
        const cancelledResult = await provider.provideHover(
            document,
            new vscode.Position(0, 6),
            cancelledSource.token,
        );
        assert.strictEqual(cancelledResult, null);
        assert.strictEqual(calls, 1);
    });

    test('does not silently swallow fatal server errors when hover fails', async () => {
        const warnings: string[] = [];
        const fatalError = new ResponseError(ErrorCodes.InternalError, 'internal server failure');
        const client = {
            warn: (message: string) => {
                warnings.push(message);
            },
            sendRequest: async () => {
                throw fatalError;
            },
        } as unknown as LanguageClient;
        const provider = new HoverVerbosityProvider(client, { retryDelayMs: 0 });
        const document = await vscode.workspace.openTextDocument({ language: 'glua', content: 'local value = 1' });

        await assert.rejects(
            () => provider.provideHover(
                document,
                new vscode.Position(0, 6),
                new vscode.CancellationTokenSource().token,
            ),
            (err: unknown) => err === fatalError,
        );
        assert.strictEqual(warnings.length, 1);
    });
});
