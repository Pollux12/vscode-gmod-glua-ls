import * as assert from 'assert';
import type { LanguageClient } from 'vscode-languageclient/node';

import {
    isExpectedLifecycleRequestError,
    isRequestCancelledError,
    isServerInitializingError,
    sendRequestWithStartupRetry,
} from '../../languageServerRequests';

suite('Language Server Request Helpers', () => {
    test('recognizes server-initializing errors', () => {
        assert.strictEqual(isServerInitializingError({ code: -32801 }), true);
        assert.strictEqual(isServerInitializingError({ code: -32801, message: 'Server Initializing...' }), true);
        assert.strictEqual(isServerInitializingError({ code: -32801, message: 'content modified' }), false);
        assert.strictEqual(isServerInitializingError({ code: -32603, message: 'Server Initializing...' }), false);
    });

    test('recognizes cancelled request errors', () => {
        assert.strictEqual(isRequestCancelledError({ code: -32800 }), true);
        assert.strictEqual(isRequestCancelledError({ code: -32801 }), false);
    });

    test('classifies expected lifecycle errors', () => {
        assert.strictEqual(isExpectedLifecycleRequestError({ code: -32800 }), true);
        assert.strictEqual(isExpectedLifecycleRequestError({ code: -32801, message: 'server initializing' }), true);
        assert.strictEqual(isExpectedLifecycleRequestError({ code: -32603, message: 'unexpected' }), false);
    });

    test('retries startup requests until success', async () => {
        const startupError = { code: -32801, message: 'server initializing' };
        let attempts = 0;

        const client = {
            sendRequest: async <T>() => {
                attempts += 1;
                if (attempts < 3) {
                    throw startupError;
                }
                return 'ok' as unknown as T;
            },
        } as unknown as LanguageClient;

        const result = await sendRequestWithStartupRetry<string>(client, 'dummy/method', {}, 5, 0);
        assert.strictEqual(result, 'ok');
        assert.strictEqual(attempts, 3);
    });

    test('stops retrying after max retries', async () => {
        const startupError = { code: -32801, message: 'server initializing' };
        let attempts = 0;

        const client = {
            sendRequest: async () => {
                attempts += 1;
                throw startupError;
            },
        } as unknown as LanguageClient;

        await assert.rejects(
            sendRequestWithStartupRetry(client, 'dummy/method', {}, 2, 0),
            (error) => {
                assert.strictEqual(error, startupError);
                return true;
            }
        );

        assert.strictEqual(attempts, 3);
    });
});
