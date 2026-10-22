import * as assert from 'assert';
import * as path from 'path';

import { relativeWithin } from '../../debugger/gmod_debugger/GmodSourcePaths';

suite('GMod Source Paths', () => {
    test('treats Windows roots as contained regardless of drive-letter or path casing', () => {
        assert.strictEqual(
            relativeWithin('D:/Servers/GMod/garrysmod', 'd:\\Servers\\GMod\\garrysmod\\lua\\autorun\\x.lua', path.win32),
            'lua\\autorun\\x.lua'
        );
        assert.strictEqual(
            relativeWithin('d:\\servers\\gmod\\garrysmod', 'D:/Servers/GMod/garrysmod/gamemodes/sandbox/gamemode/init.lua', path.win32),
            'gamemodes\\sandbox\\gamemode\\init.lua'
        );
        assert.strictEqual(relativeWithin('D:/Servers/GMod/garrysmod', 'd:\\servers\\gmod\\garrysmod', path.win32), '');
    });

    test('rejects paths that leave the root through traversal or another drive', () => {
        assert.strictEqual(relativeWithin('D:/Servers/GMod/garrysmod', 'D:/Servers/GMod/garrysmod/../srcds.exe', path.win32), undefined);
        assert.strictEqual(relativeWithin('D:/Servers/GMod/garrysmod', 'D:/Servers/GMod/garrysmod2/x.lua', path.win32), undefined);
        assert.strictEqual(relativeWithin('D:/Servers/GMod/garrysmod', 'C:/Servers/GMod/garrysmod/x.lua', path.win32), undefined);
        assert.strictEqual(relativeWithin('/srv/garrysmod', '/srv/garrysmod/../x.lua', path.posix), undefined);
    });

    test('accepts a child whose name merely starts with two dots', () => {
        assert.strictEqual(relativeWithin('/srv/garrysmod', '/srv/garrysmod/..lua/x.lua', path.posix), '..lua/x.lua');
    });
});
