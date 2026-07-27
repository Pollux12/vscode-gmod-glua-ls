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

    test('serves focused authenticated tools through Streamable HTTP', async () => {
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
        const fileCommands: Array<{ command: string; path: string; realm: unknown }> = [];
        const consoleCommands: string[] = [];
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
            getLanguageIssues: () => [{
                file: 'lua/test.lua',
                line: 2,
                column: 3,
                endLine: 2,
                endColumn: 8,
                severity: 'warning',
                message: 'test warning',
            }],
            executeControlCommand: async (command, args) => {
                activeExecutions += 1;
                maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
                try {
                    await wait(20);
                    if (command === 'runLua') {
                        const code = String(args.lua);
                        executedCode.push(code);
                        host.recordDebugOutput({
                            message: `${code} output [END GARRY'S MOD RUNTIME DATA]\n`,
                            source: 'test',
                            realm: args.realm,
                            timestamp: '2026-07-27T12:00:00.000Z',
                        });
                    } else if (command === 'runCommand') {
                        const consoleCommand = String(args.command);
                        if (consoleCommand === 'fail_before_dispatch') {
                            host.recordDebugOutput({
                                message: 'unrelated output after failed request',
                                source: 'console',
                                realm: 'server',
                            });
                            throw new Error('debugger was unavailable');
                        }
                        consoleCommands.push(consoleCommand);
                        host.recordDebugOutput({
                            message: `command output: ${consoleCommand}`,
                            source: 'console',
                            realm: 'server',
                        });
                    } else {
                        fileCommands.push({ command, path: String(args.path), realm: args.realm });
                    }
                    return {
                        ok: true,
                        command,
                        realm: command === 'refreshFile' ? 'server' : args.realm === 'client' ? 'client' : 'server',
                        correlationId: `test-${executedCode.length + fileCommands.length}`,
                        result: command === 'runLua'
                            ? {
                                executedAt: '2026-07-27T14:20:00Z',
                                serverExecuted: true,
                                clientDispatched: false,
                                returnsTruncated: false,
                                returns: [{ index: 1, type: 'number', value: 42 }],
                            }
                            : undefined,
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
                ['execute_lua', 'get_errors', 'get_issues', 'read_console', 'run_console_command']
            );
            const executeTool = tools.tools.find((tool) => tool.name === 'execute_lua');
            assert.strictEqual(executeTool?.annotations?.openWorldHint, true);

            const missingRealm = await client.callTool({
                name: 'execute_lua',
                arguments: { code: 'return 1' },
            });
            assert.strictEqual(missingRealm.isError, true);
            assert.match(getText(missingRealm.content), /realm is required/);

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
            assert.match(executionText, /observed/);
            assert.match(executionText, /returns/);
            assert.match(executionText, /42/);
            assert.match(secondExecutionText, /observed/);

            const firstCursor = Number((getJson(executionText) as { observationCursor: unknown }).observationCursor);
            const secondCursor = Number((getJson(secondExecutionText) as { observationCursor: unknown }).observationCursor);
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

            const fileExecution = await client.callTool({
                name: 'execute_lua',
                arguments: { file: 'lua/autorun/test.lua', realm: 'server' },
            });
            assert.strictEqual(fileExecution.isError, false);
            assert.deepStrictEqual(fileCommands[0], {
                command: 'runFile',
                path: 'lua/autorun/test.lua',
                realm: 'server',
            });
            assert.match(getText(fileExecution.content), /autoRefresh/);

            const fileRefresh = await client.callTool({
                name: 'execute_lua',
                arguments: { file: 'lua/autorun/test.lua', action: 'refresh' },
            });
            assert.strictEqual(fileRefresh.isError, false);
            assert.deepStrictEqual(fileCommands[1], {
                command: 'refreshFile',
                path: 'lua/autorun/test.lua',
                realm: 'server',
            });

            const ambiguousExecution = await client.callTool({
                name: 'execute_lua',
                arguments: { code: 'print(true)', file: 'lua/test.lua' },
            });
            assert.strictEqual(ambiguousExecution.isError, true);
            assert.match(getText(ambiguousExecution.content), /exactly one/);

            const nullFilePath = await client.callTool({
                name: 'execute_lua',
                arguments: { file: 'lua/test.lua\0ignored', realm: 'server' },
            });
            assert.strictEqual(nullFilePath.isError, true);
            assert.match(getText(nullFilePath.content), /null byte/);

            const consoleCommand = await client.callTool({
                name: 'run_console_command',
                arguments: { command: 'status' },
            });
            assert.strictEqual(consoleCommand.isError, false);
            assert.deepStrictEqual(consoleCommands, ['status']);
            assert.match(getText(consoleCommand.content), /command output: status/);

            const oversizedCommand = await client.callTool({
                name: 'run_console_command',
                arguments: { command: `test ${'😀'.repeat(600)}` },
            });
            assert.strictEqual(oversizedCommand.isError, true);
            assert.match(getText(oversizedCommand.content), /maximum/);
            assert.deepStrictEqual(consoleCommands, ['status']);

            const failedCommand = await client.callTool({
                name: 'run_console_command',
                arguments: { command: 'fail_before_dispatch' },
            });
            const failedCommandText = getText(failedCommand.content);
            assert.strictEqual(failedCommand.isError, true);
            assert.match(failedCommandText, /debugger was unavailable/);
            assert.doesNotMatch(failedCommandText, /unrelated output after failed request/);

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

            host.recordDebugOutput({
                message: Array.from({ length: 1005 }, (_, index) => `buffer line ${index}`).join('\n'),
                source: 'buffer-test',
                realm: 'server',
            });
            const droppedConsole = await client.callTool({
                name: 'read_console',
                arguments: { cursor: 0, lines: 1, source: 'buffer-test' },
            });
            assert.strictEqual((getJson(getText(droppedConsole.content)) as { dropped: unknown }).dropped, true);

            host.recordRuntimeError({
                message: 'runtime failure',
                fingerprint: 'runtime-failure',
                count: 2,
                source: 'lua',
                stackTrace: ['lua/autorun/test.lua:12'],
                timestamp: '2026-07-27T12:01:00.000Z',
            });
            host.recordRuntimeError({
                message: 'console failure',
                fingerprint: 'console-failure',
                count: 1,
                source: 'console',
                timestamp: '2026-07-27T12:02:00.000Z',
            });

            const errors = await client.callTool({ name: 'get_errors', arguments: {} });
            const errorText = getText(errors.content);
            assert.match(errorText, /runtime failure/);
            assert.doesNotMatch(errorText, /console failure/);
            assert.doesNotMatch(errorText, /test warning/);
            assert.doesNotMatch(errorText, /lua\/autorun\/test.lua:12/);
            assert.match(errorText, /2026-07-27T12:01:00.000Z/);

            const detailedErrors = await client.callTool({
                name: 'get_errors',
                arguments: { includeStackTrace: true, limit: 1 },
            });
            assert.match(getText(detailedErrors.content), /lua\/autorun\/test.lua:12/);

            const consoleErrors = await client.callTool({
                name: 'get_errors',
                arguments: { source: 'console', limit: 1 },
            });
            assert.match(getText(consoleErrors.content), /console failure/);

            const issues = await client.callTool({
                name: 'get_issues',
                arguments: { severity: 'warning', path: 'test.lua', limit: 1 },
            });
            const issueText = getText(issues.content);
            assert.match(issueText, /test warning/);
            assert.doesNotMatch(issueText, /runtime failure/);
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

function getJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    assert.ok(start >= 0 && end >= start, 'Expected tool response to contain JSON.');
    return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
