import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DiagnosticsWatcher } from '../../mcp/codeTools';
import { GmodDebugBridge } from '../../mcp/debugBridge';
import { createAbortController, McpTool } from '../../mcp/mcpHttpServer';
import { buildMcpTools } from '../../mcp/tools';

suite('MCP diagnostics tool', () => {
    let dir: string;
    let file: string;
    let bridge: GmodDebugBridge;
    let watcher: DiagnosticsWatcher;
    let diagnostics: McpTool;

    const call = async (args: Record<string, unknown>) => {
        const started = Date.now();
        const result = await diagnostics.call(args, createAbortController().signal);
        return { text: result.content.map((part) => part.text).join('\n'), elapsed: Date.now() - started };
    };

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-mcp-diag-'));
        file = path.join(dir, 'sv_test.lua');
        fs.writeFileSync(file, 'local a = 1\n', 'utf8');
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(file, past, past);
        bridge = new GmodDebugBridge(() => undefined);
        watcher = new DiagnosticsWatcher();
        diagnostics = buildMcpTools({ bridge, settings: () => ({ allowCodeExecution: true, autoAttach: false }) }, watcher)
            .find((tool) => tool.definition.name === 'diagnostics')!;
    });

    teardown(() => {
        watcher.dispose();
        bridge.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('does not wait for a requested file that has not changed', async () => {
        const reply = await call({ paths: [file], wait_ms: 3000 });

        assert.ok(reply.elapsed < 2000, `waited ${reply.elapsed} ms`);
        assert.ok(!reply.text.includes('may be stale'), reply.text);
    });

    test('waits for a requested file edited after the diagnostics were last published', async () => {
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(file, future, future);

        const reply = await call({ paths: [file], wait_ms: 400 });

        assert.ok(reply.elapsed >= 350, `returned after ${reply.elapsed} ms`);
        assert.ok(reply.text.includes('1 file(s) had not been re-analysed after 400 ms'), reply.text);
    });
});
