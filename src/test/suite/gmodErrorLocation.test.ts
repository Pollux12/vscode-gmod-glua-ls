import * as assert from 'assert';

import { parseGmodErrorLocation } from '../../gmodErrorView';

suite('GMod Error Location', () => {
    test('reads the file and line from a stack frame', () => {
        assert.deepStrictEqual(parseGmodErrorLocation('1. unknown - gamemodes/sandbox/gamemode/balloon_report.lua:9'), {
            filePath: 'gamemodes/sandbox/gamemode/balloon_report.lua',
            line: 9,
            column: undefined,
        });
        assert.deepStrictEqual(parseGmodErrorLocation('  12. ReportBalloons - addons/my addon/lua/autorun/x.lua:40'), {
            filePath: 'addons/my addon/lua/autorun/x.lua',
            line: 40,
            column: undefined,
        });
    });

    test('reads the file and line from an error message', () => {
        assert.deepStrictEqual(parseGmodErrorLocation('lua/autorun/server/x.lua:3: attempt to index a nil value'), {
            filePath: 'lua/autorun/server/x.lua',
            line: 3,
            column: undefined,
        });
    });

    test('ignores frames without a Lua file', () => {
        assert.strictEqual(parseGmodErrorLocation('2. Spawn - [C]:-1'), undefined);
    });
});
