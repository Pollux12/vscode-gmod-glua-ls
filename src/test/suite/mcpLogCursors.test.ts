import * as assert from 'assert';

import { DiagnosticsWatcher } from '../../mcp/codeTools';
import { GmodDebugBridge } from '../../mcp/debugBridge';
import { createAbortController, McpTool } from '../../mcp/mcpHttpServer';
import { buildMcpTools } from '../../mcp/tools';

suite('MCP log cursors', () => {
    let bridge: GmodDebugBridge;
    let tools: McpTool[];

    const call = async (name: string, args: Record<string, unknown>) => {
        const result = await tools.find((tool) => tool.definition.name === name)!.call(args, createAbortController().signal);
        return result.content.map((part) => part.text).join('\n');
    };

    setup(() => {
        bridge = new GmodDebugBridge(() => undefined);
        tools = buildMcpTools({ bridge, settings: () => ({ allowCodeExecution: true, autoAttach: false }) }, new DiagnosticsWatcher());
    });

    teardown(() => {
        bridge.dispose();
    });

    test('errors raised during a server_console call are still returned by the next server_errors wait', async () => {
        setTimeout(() => {
            bridge.events.recordError({ message: 'lua/autorun/sv_boom.lua:3: boom', fingerprint: 'boom' });
            bridge.events.pushConsole('boom printed');
        }, 30);
        const consoleReply = await call('server_console', { search: 'printed', wait_ms: 2000 });
        assert.ok(consoleReply.includes('boom printed'), consoleReply);

        const errors = await call('server_errors', { wait_ms: 300 });

        assert.ok(errors.includes('sv_boom.lua:3: boom'), errors);
    });

    test('a server_errors read does not return the same errors on the next wait', async () => {
        bridge.events.recordError({ message: 'lua/autorun/sv_boom.lua:3: boom', fingerprint: 'boom' });
        assert.ok((await call('server_errors', {})).includes('boom'));

        const again = await call('server_errors', { wait_ms: 100 });

        assert.ok(again.includes('No Lua errors'), again);
    });
});
