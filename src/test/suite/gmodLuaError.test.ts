import * as assert from 'assert';

import { parseGmodLuaError } from '../../debugger/gmod_debugger/GmodLuaError';

suite('GMod Lua Error', () => {
    test('splits a multi-line console error into its headline and stack frames', () => {
        const block = [
            '[ERROR] addons/sandbox/lua/autorun/server/boom.lua:3: attempt to call a nil value',
            '  1. fail - addons/sandbox/lua/autorun/server/boom.lua:3',
            '   2. unknown - addons/sandbox/lua/autorun/server/boom.lua:6',
            '',
        ].join('\n');

        const parsed = parseGmodLuaError(block.replace(/^\[ERROR\] /, ''), block);

        assert.strictEqual(parsed.message, 'addons/sandbox/lua/autorun/server/boom.lua:3: attempt to call a nil value');
        assert.deepStrictEqual(parsed.stackTrace, [
            '1. fail - addons/sandbox/lua/autorun/server/boom.lua:3',
            '2. unknown - addons/sandbox/lua/autorun/server/boom.lua:6',
        ]);
    });

    test('keeps an already clean single-line message', () => {
        const raw = '[ERROR] lua/x.lua:1: bad\r\n  1. unknown - lua/x.lua:1\r\n';

        const parsed = parseGmodLuaError('bad', raw);

        assert.strictEqual(parsed.message, 'bad');
        assert.deepStrictEqual(parsed.stackTrace, ['1. unknown - lua/x.lua:1']);
    });

    test('falls back when the error carries no text', () => {
        assert.deepStrictEqual(parseGmodLuaError(undefined, ''), { message: 'Unknown Lua error', stackTrace: [] });
    });
});
