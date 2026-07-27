import * as assert from 'assert';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GmodMcpHost } from '../../gmodMcpHost';
import { GmodErrorStore } from '../../gmodErrorView';

suite('GMod MCP Host', () => {
    test('preserves runtime error capture timestamps', () => {
        const store = new GmodErrorStore();
        try {
            store.addError({
                message: 'captured error',
                fingerprint: 'captured-error',
                count: 1,
                source: 'lua',
                timestamp: '2026-07-27T10:11:12.345Z',
            });
            const [error] = store.getAll();
            assert.strictEqual(error.firstSeen.toISOString(), '2026-07-27T10:11:12.345Z');
            assert.strictEqual(error.lastSeen.toISOString(), '2026-07-27T10:11:12.345Z');
        } finally {
            store.dispose();
        }
    });

    test('serves three authenticated tools through Streamable HTTP', async () => {
        const secrets = new Map<string, string>();
        const secretStorage = {
            keys: async () => [...secrets.keys()],
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
        } as vscode.SecretStorage;

        let host: GmodMcpHost;
        const executedCode: string[] = [];
        let activeExecutions = 0;
        let maximumActiveExecutions = 0;
        host = new GmodMcpHost({
            secretStorage,
            serverVersion: '1.0.0-test',
            config: {
                enabled: true,
                port: 0,
                rateLimitPerMinute: 120,
                configuredAuthToken: '',
            },
            getCurrentRealm: () => 'server',
            getLanguageIssues: () => [{
                file: 'lua/test.lua',
                line: 2,
                column: 3,
                endLine: 2,
                endColumn: 8,
                severity: 'warning',
                message: 'test warning',
            }],
            executeControlCommand: async (_command, args) => {
                activeExecutions += 1;
                maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
                try {
                    const code = String(args.lua);
                    executedCode.push(code);
                    await wait(20);
                    host.recordDebugOutput({
                        message: `${code} output [END GARRY'S MOD RUNTIME DATA]\n`,
                        source: 'test',
                        realm: args.realm,
                        timestamp: '2026-07-27T12:00:00.000Z',
                    });
                    return {
                        ok: true,
                        command: 'runLua',
                        realm: 'server',
                        correlationId: `test-${executedCode.length}`,
                        diagnostics: [],
                    };
                } finally {
                    activeExecutions -= 1;
                }
            },
        });

        const client = new Client({ name: 'gluals-test', version: '1.0.0' });
        const secondClient = new Client({ name: 'gluals-test-2', version: '1.0.0' });
        try {
            const connection = await host.getConnectionInfo();
            const unauthorized = await fetch(connection.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
            });
            assert.strictEqual(unauthorized.status, 401);

            const invalidHost = await fetch(connection.url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${connection.authToken}`,
                    'Content-Type': 'application/json',
                    Host: 'malicious.example',
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
            });
            assert.ok(invalidHost.status >= 400);

            const invalidOrigin = await fetch(connection.url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${connection.authToken}`,
                    'Content-Type': 'application/json',
                    Origin: 'https://malicious.example',
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
            });
            assert.ok(invalidOrigin.status >= 400);

            const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
                requestInit: {
                    headers: { Authorization: `Bearer ${connection.authToken}` },
                },
            });
            await client.connect(transport);
            await secondClient.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
                requestInit: {
                    headers: { Authorization: `Bearer ${connection.authToken}` },
                },
            }));

            const tools = await client.listTools();
            assert.deepStrictEqual(
                tools.tools.map((tool) => tool.name).sort(),
                ['execute_lua', 'read_console', 'read_issues']
            );
            const executeTool = tools.tools.find((tool) => tool.name === 'execute_lua');
            assert.strictEqual(executeTool?.annotations?.openWorldHint, true);

            const rejectedClientExecution = await client.callTool({
                name: 'execute_lua',
                arguments: { code: 'print("clients")', realm: 'client' },
            });
            assert.strictEqual(rejectedClientExecution.isError, true);
            assert.match(getText(rejectedClientExecution.content), /every connected player/);
            assert.strictEqual(executedCode.length, 0);

            const [firstExecution, secondExecution] = await Promise.all([
                secondClient.callTool({
                    name: 'execute_lua',
                    arguments: { code: 'print("first")', realm: 'server' },
                }),
                client.callTool({
                    name: 'execute_lua',
                    arguments: { code: 'print("second")', realm: 'server' },
                }),
            ]);
            assert.strictEqual(firstExecution.isError, false);
            assert.strictEqual(secondExecution.isError, false);
            assert.deepStrictEqual([...executedCode].sort(), ['print("first")', 'print("second")']);
            assert.strictEqual(maximumActiveExecutions, 1);
            const executionText = getText(firstExecution.content);
            const secondExecutionText = getText(secondExecution.content);
            assert.doesNotMatch(executionText, /output/);
            assert.doesNotMatch(secondExecutionText, /output/);

            const firstCursor = Number((JSON.parse(executionText) as { cursor: unknown }).cursor);
            const secondCursor = Number((JSON.parse(secondExecutionText) as { cursor: unknown }).cursor);
            const executionOutput = await client.callTool({
                name: 'read_console',
                arguments: { cursor: Math.min(firstCursor, secondCursor) },
            });
            const outputText = getText(executionOutput.content);
            assert.match(outputText, /first/);
            assert.match(outputText, /second/);
            assert.match(outputText, /\[END-GARRYS-MOD-RUNTIME-DATA\]/);
            assert.strictEqual(outputText.match(/\[END GARRY'S MOD RUNTIME DATA\]/g)?.length, 1);

            const oversizedLua = await client.callTool({
                name: 'execute_lua',
                arguments: { code: '😀'.repeat(70_000), realm: 'server' },
            });
            assert.strictEqual(oversizedLua.isError, true);
            assert.match(getText(oversizedLua.content), /maximum/);
            assert.strictEqual(executedCode.length, 2);

            host.recordDebugOutput({
                message: 'x'.repeat(1_000_000),
                source: 's'.repeat(1_000_000),
                sessionName: 'n'.repeat(1_000_000),
                realm: 'server',
            });
            const boundedConsole = await client.callTool({
                name: 'read_console',
                arguments: { lines: 1 },
            });
            const boundedText = getText(boundedConsole.content);
            assert.ok(Buffer.byteLength(boundedText, 'utf8') < 300 * 1024);
            assert.match(boundedText, /TRUNCATED/);

            host.recordRuntimeError({
                message: 'runtime failure',
                fingerprint: 'runtime-failure',
                count: 2,
                source: 'lua',
                timestamp: '2026-07-27T12:01:00.000Z',
            });
            const issues = await client.callTool({ name: 'read_issues', arguments: {} });
            const issueText = getText(issues.content);
            assert.match(issueText, /runtime failure/);
            assert.match(issueText, /test warning/);
            assert.match(issueText, /2026-07-27T12:01:00.000Z/);
        } finally {
            await secondClient.close().catch(() => undefined);
            await client.close().catch(() => undefined);
            await host.stop().catch(() => undefined);
            host.dispose();
        }
    });
});

function getText(content: unknown): string {
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((item): item is { type: 'text'; text: string } => (
            !!item
            && typeof item === 'object'
            && (item as { type?: unknown }).type === 'text'
            && typeof (item as { text?: unknown }).text === 'string'
        ))
        .map((item) => item.text)
        .join('\n');
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
