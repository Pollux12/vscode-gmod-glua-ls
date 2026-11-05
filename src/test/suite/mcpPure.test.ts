import * as assert from 'assert';

import {
    claudeCodeCommand,
    codexTomlBlock,
    genericJsonSnippet,
    mcpUrl,
    mergeCodexToml,
    mergeJsonServerConfig,
} from '../../mcp/clientSetup';
import { clampLimit, createMatcher, McpEventLog } from '../../mcp/eventLog';
import { buildLogpointCondition, hitConditionTest, logpointLabel, luaStringLiteral, parseLogMessage } from '../../mcp/logpoint';

suite('MCP event log', () => {
    test('console entries share one cursor and filter by after and search', () => {
        const log = new McpEventLog();
        log.pushConsole('hello world\n');
        log.pushConsole('second line');
        const mark = log.cursor;
        log.pushConsole('Hello again');
        assert.deepStrictEqual(log.queryConsole().entries.map((entry) => entry.text), ['hello world', 'second line', 'Hello again']);
        assert.deepStrictEqual(log.queryConsole({ after: mark }).entries.map((entry) => entry.text), ['Hello again']);
        assert.deepStrictEqual(log.queryConsole({ search: 'HELLO' }).entries.length, 2);
        assert.deepStrictEqual(log.queryConsole({ search: '/^sec/' }).entries.map((entry) => entry.text), ['second line']);
    });

    test('limit keeps the newest console lines and reports what was left out', () => {
        const log = new McpEventLog();
        for (let i = 0; i < 10; i++) {
            log.pushConsole(`line ${i}`);
        }
        const result = log.queryConsole({ limit: 3 });
        assert.deepStrictEqual(result.entries.map((entry) => entry.text), ['line 7', 'line 8', 'line 9']);
        assert.strictEqual(result.omitted, 7);
    });

    test('console capacity drops the oldest lines', () => {
        const log = new McpEventLog(3);
        for (let i = 0; i < 5; i++) {
            log.pushConsole(`line ${i}`);
        }
        assert.deepStrictEqual(log.queryConsole().entries.map((entry) => entry.text), ['line 2', 'line 3', 'line 4']);
    });

    test('errors are grouped by fingerprint, newest first, and counted from the last clear', () => {
        let now = 1000;
        const log = new McpEventLog(100, 100, () => now);
        log.recordError({ message: 'a', fingerprint: 'fa', count: 1, stackTrace: ['1. f - x.lua:1'] });
        now += 10;
        log.recordError({ message: 'b', fingerprint: 'fb', count: 4 });
        now += 10;
        log.recordError({ message: 'a', fingerprint: 'fa', count: 2 });
        let result = log.queryErrors();
        assert.deepStrictEqual(result.entries.map((entry) => [entry.message, entry.count]), [['a', 2], ['b', 4]]);
        assert.deepStrictEqual(result.entries[0].stackTrace, ['1. f - x.lua:1']);

        assert.strictEqual(log.clearErrors(), 2);
        assert.strictEqual(log.queryErrors().entries.length, 0);
        log.recordError({ message: 'a', fingerprint: 'fa', count: 3 });
        result = log.queryErrors();
        assert.deepStrictEqual(result.entries.map((entry) => [entry.message, entry.count]), [['a', 1]]);
    });

    test('a restarted server counter is not treated as a negative count', () => {
        const log = new McpEventLog();
        log.recordError({ message: 'a', fingerprint: 'fa', count: 5 });
        log.clearErrors();
        log.recordError({ message: 'a', fingerprint: 'fa', count: 1 });
        assert.strictEqual(log.queryErrors().entries[0].count, 1);
    });

    test('waitFor resolves on a new entry and times out otherwise', async () => {
        const log = new McpEventLog();
        const mark = log.cursor;
        const waiting = log.waitFor(() => log.queryConsole({ after: mark, search: 'ready' }).entries.length > 0, 1000);
        log.pushConsole('not yet');
        setTimeout(() => log.pushConsole('server ready'), 10);
        assert.strictEqual(await waiting, true);
        assert.strictEqual(await log.waitFor(() => false, 20), false);
    });

    test('console listeners see each new line until unregistered', () => {
        const log = new McpEventLog();
        const seen: string[] = [];
        const stop = log.onConsole((entry) => seen.push(entry.text));
        log.pushConsole('first\n');
        stop();
        log.pushConsole('second');
        assert.deepStrictEqual(seen, ['first']);
    });

    test('createMatcher and clampLimit handle odd input', () => {
        assert.ok(createMatcher(undefined)('anything'));
        assert.ok(createMatcher('/[/')('a /[/ b'), 'an invalid regex falls back to substring search');
        assert.strictEqual(clampLimit(undefined), 50);
        assert.strictEqual(clampLimit(0), 1);
        assert.strictEqual(clampLimit(9999), 500);
    });
});

suite('MCP logpoints', () => {
    test('parses interpolated expressions, including braces inside them', () => {
        assert.deepStrictEqual(parseLogMessage('hp={ply:Health()} t={ {1,2} } s={"}"}'), [
            { kind: 'text', value: 'hp=' },
            { kind: 'expression', value: 'ply:Health()' },
            { kind: 'text', value: ' t=' },
            { kind: 'expression', value: '{1,2}' },
            { kind: 'text', value: ' s=' },
            { kind: 'expression', value: '"}"' },
        ]);
        assert.deepStrictEqual(parseLogMessage('no {} or {unclosed'), [{ kind: 'text', value: 'no {} or {unclosed' }]);
    });

    test('quotes Lua strings safely', () => {
        assert.strictEqual(luaStringLiteral('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
        assert.strictEqual(luaStringLiteral('\u0001'), '"\\001"');
    });

    test('labels use the include() path, which is short and unique on the server', () => {
        assert.strictEqual(logpointLabel('addons/myaddon/lua/autorun/server/init.lua', 12), 'autorun/server/init.lua:12');
        assert.strictEqual(logpointLabel('lua\\autorun\\x.lua', 3), 'autorun/x.lua:3');
        assert.strictEqual(logpointLabel('gamemodes/sandbox/gamemode/init.lua', 5), 'sandbox/gamemode/init.lua:5');
        assert.strictEqual(logpointLabel('sample.lua', 1), 'sample.lua:1');
    });

    test('turns hit conditions into Lua tests', () => {
        assert.strictEqual(hitConditionTest('5'), 'n >= 5');
        assert.strictEqual(hitConditionTest('<= 3'), 'n <= 3');
        assert.strictEqual(hitConditionTest('% 10'), 'n % 10 == 0');
        assert.strictEqual(hitConditionTest('== 2'), 'n == 2');
        assert.strictEqual(hitConditionTest('soon'), undefined);
    });

    test('a hit condition counts on the server under the given key', () => {
        assert.strictEqual(
            buildLogpointCondition('x', 'a.lua:1', undefined, '<= 2', 'a.lua:1#7'),
            '((function(n) return n <= 2 end)((_GLUALS and _GLUALS.countLogpoint and _GLUALS.countLogpoint("a.lua:1#7") or 1)) and (print("[logpoint a.lua:1] " .. "x") and false))'
        );
    });

    test('builds a condition that prints and never pauses', () => {
        assert.strictEqual(
            buildLogpointCondition('hp={hp}', 'lua/x.lua:3'),
            '(print("[logpoint lua/x.lua:3] " .. "hp=" .. (_GLUALS and _GLUALS.format or tostring)((hp))) and false)'
        );
        assert.strictEqual(
            buildLogpointCondition('hit', 'lua/x.lua:3', 'ply:IsAdmin()'),
            '((ply:IsAdmin()) and (print("[logpoint lua/x.lua:3] " .. "hit") and false))'
        );
    });
});

suite('MCP client setup', () => {
    test('merges into JSON configs without touching other servers', () => {
        const existing = JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: true });
        const merged = JSON.parse(mergeJsonServerConfig(existing, 'mcpServers', 'gluals', { type: 'http', url: mcpUrl(1) }));
        assert.deepStrictEqual(merged, { mcpServers: { other: { command: 'x' }, gluals: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }, extra: true });
        assert.deepStrictEqual(JSON.parse(mergeJsonServerConfig(undefined, 'servers', 'gluals', { url: 'u' })), { servers: { gluals: { url: 'u' } } });
        assert.throws(() => mergeJsonServerConfig('// comment\n{}', 'servers', 'gluals', {}));
    });

    test('adds or replaces the Codex table and keeps the rest', () => {
        assert.strictEqual(mergeCodexToml(undefined, 21120), codexTomlBlock(21120));
        const existing = 'model = "x"\n\n[mcp_servers.gluals]\nurl = "http://127.0.0.1:1/mcp"\n\n[mcp_servers.other]\ncommand = "y"\n';
        const merged = mergeCodexToml(existing, 21120);
        assert.ok(merged.startsWith('model = "x"\n\n[mcp_servers.gluals]\nurl = "http://127.0.0.1:21120/mcp"\ntool_timeout_sec = 120'));
        assert.ok(merged.includes('[mcp_servers.other]\ncommand = "y"'));
        assert.strictEqual(merged.match(/\[mcp_servers\.gluals\]/g)?.length, 1);
        const appended = mergeCodexToml('model = "x"\n', 5);
        assert.ok(appended.endsWith('[mcp_servers.gluals]\nurl = "http://127.0.0.1:5/mcp"\ntool_timeout_sec = 120\n'));
    });

    test('snippets name the server and URL', () => {
        assert.strictEqual(claudeCodeCommand(21120), 'claude mcp add --transport http gluals http://127.0.0.1:21120/mcp');
        assert.deepStrictEqual(JSON.parse(genericJsonSnippet(21120)), { mcpServers: { gluals: { type: 'http', url: 'http://127.0.0.1:21120/mcp' } } });
    });
});
