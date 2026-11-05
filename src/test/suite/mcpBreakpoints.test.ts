import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { DiagnosticsWatcher } from '../../mcp/codeTools';
import { GmodDebugBridge } from '../../mcp/debugBridge';
import { createAbortController, McpTool } from '../../mcp/mcpHttpServer';
import { buildMcpTools } from '../../mcp/tools';

suite('MCP breakpoints tool', () => {
    let dir: string;
    let file: string;
    let bridge: GmodDebugBridge;
    let watcher: DiagnosticsWatcher;
    let allowCodeExecution = true;
    let breakpoints: McpTool;

    const call = async (args: Record<string, unknown>) => {
        const result = await breakpoints.call(args, createAbortController().signal);
        return { text: result.content.map((part) => part.text).join('\n'), isError: result.isError === true };
    };
    const onLine = (line: number) => vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === file && bp.location.range.start.line === line - 1);

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-mcp-bp-'));
        file = path.join(dir, 'sv_test.lua');
        fs.writeFileSync(file, 'local a = 1\nlocal b = 2\nlocal c = 3\n', 'utf8');
        bridge = new GmodDebugBridge(() => undefined);
        watcher = new DiagnosticsWatcher();
        allowCodeExecution = true;
        const tools = buildMcpTools({ bridge, settings: () => ({ allowCodeExecution, autoAttach: false }) }, watcher);
        breakpoints = tools.find((tool) => tool.definition.name === 'breakpoints')!;
    });

    teardown(() => {
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints.filter((bp) => bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath.startsWith(dir)));
        bridge.dispose();
        watcher.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('conditions and logpoints need code execution; plain breakpoints and counts do not', async () => {
        allowCodeExecution = false;
        for (const item of [{ condition: 'a > 0' }, { log_message: 'a={a}' }]) {
            const reply = await call({ action: 'set', items: [{ file, line: 1, ...item }] });
            assert.ok(reply.isError && /allowCodeExecution/.test(reply.text), reply.text);
        }
        assert.strictEqual(onLine(1).length, 0);
        const plain = await call({ action: 'set', items: [{ file, line: 1, hit_condition: '>= 3' }] });
        assert.ok(!plain.isError, plain.text);
        assert.strictEqual(onLine(1)[0]?.hitCondition, '>= 3');
    });

    test('a hit condition must be a count test, since LRDB evaluates it as Lua', async () => {
        const reply = await call({ action: 'set', items: [{ file, line: 2, hit_condition: '> 1 or RunConsoleCommand("quit")' }] });
        assert.ok(reply.isError && /not a hit count test/.test(reply.text), reply.text);
        assert.strictEqual(onLine(2).length, 0);
    });

    test("the user's breakpoints are never replaced or removed", async () => {
        const user = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(1, 0)), true, 'b == 2');
        vscode.debug.addBreakpoints([user]);

        const set = await call({ action: 'set', items: [{ file, line: 2 }, { file, line: 3 }] });
        assert.ok(/SKIPPED .*:2: the user has a breakpoint/.test(set.text), set.text);
        assert.deepStrictEqual(onLine(2).map((bp) => bp.id), [user.id]);
        assert.strictEqual(onLine(3).length, 1);

        // Re-setting the agent's own breakpoint replaces it.
        await call({ action: 'set', items: [{ file, line: 3, hit_condition: '== 2' }] });
        assert.deepStrictEqual(onLine(3).map((bp) => bp.hitCondition), ['== 2']);

        const removed = await call({ action: 'remove', items: [{ file }] });
        assert.ok(/Removed 1 breakpoint\(s\)\. 1 set by the user there were left alone\./.test(removed.text), removed.text);
        assert.deepStrictEqual(onLine(2).map((bp) => bp.id), [user.id]);
        assert.strictEqual(onLine(3).length, 0);
    });
});
