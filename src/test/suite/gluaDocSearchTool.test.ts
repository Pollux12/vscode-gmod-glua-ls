import * as assert from 'assert';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

import {
    GluaDocSearchTool,
    IGluaDocSearchInput,
} from '../../tools/gluaDocSearchTool';

suite('GLua Documentation Search Tool', () => {
    test('retries a request while the server finishes cold startup', async () => {
        const startupError = { code: -32801, message: 'server initializing' };
        let attempts = 0;
        const client = {
            sendRequest: async <T>() => {
                attempts += 1;
                if (attempts === 1) {
                    throw startupError;
                }

                return { items: [] } as T;
            },
        } as unknown as LanguageClient;
        const tool = new GluaDocSearchTool(() => client);
        const cancellation = new vscode.CancellationTokenSource();

        try {
            const result = await tool.invoke(
                {
                    input: { query: 'Entity:GetPos' },
                } as vscode.LanguageModelToolInvocationOptions<IGluaDocSearchInput>,
                cancellation.token
            );

            assert.ok(result);
            assert.strictEqual(attempts, 2);
        } finally {
            cancellation.dispose();
        }
    });
});
