import * as assert from 'assert';
import * as path from 'path';

import {
    clientPathToGamePath,
    debuggerPathConverters,
    gamePathToClientPath,
    gamePathToLuaPath,
    relativeWithin,
} from '../../debugger/gmod_debugger/GmodSourcePaths';

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

    test('maps local files through the most specific sourceFileMap folder before sourceRoot', () => {
        const mapping = {
            sourceRoot: 'D:/Servers/GMod/garrysmod',
            sourceFileMap: {
                'D:/Servers/GMod/garrysmod/addons': 'addons',
                'D:/Servers/GMod/garrysmod/addons/cityrp': 'addons/cityrp_dev',
                'D:/Source/Repos/sandbox': 'gamemodes/sandbox',
            },
        };
        assert.strictEqual(
            clientPathToGamePath('d:\\Servers\\GMod\\garrysmod\\addons\\cityrp\\lua\\autorun\\x.lua', mapping, path.win32),
            'addons\\cityrp_dev\\lua\\autorun\\x.lua'
        );
        assert.strictEqual(
            clientPathToGamePath('d:\\source\\repos\\sandbox\\gamemode\\init.lua', mapping, path.win32),
            'gamemodes\\sandbox\\gamemode\\init.lua'
        );
        assert.strictEqual(
            clientPathToGamePath('D:/Servers/GMod/garrysmod/lua/autorun/server/x.lua', mapping, path.win32),
            'lua\\autorun\\server\\x.lua'
        );
        assert.strictEqual(clientPathToGamePath('D:/Elsewhere/x.lua', mapping, path.win32), undefined);
    });

    test('maps garrysmod-relative files back through the most specific sourceFileMap folder before sourceRoot', () => {
        const mapping = {
            sourceRoot: 'D:/Servers/GMod/garrysmod',
            sourceFileMap: {
                'D:/Servers/GMod/garrysmod/addons': 'addons',
                'D:/Source/Repos/cityrp': 'addons/cityrp_dev',
                'D:/Source/Repos/sandbox': 'gamemodes/sandbox',
            },
        };
        assert.strictEqual(
            gamePathToClientPath('addons/cityrp_dev/lua/autorun/x.lua', mapping, path.win32),
            'D:\\Source\\Repos\\cityrp\\lua\\autorun\\x.lua'
        );
        assert.strictEqual(
            gamePathToClientPath('Gamemodes/Sandbox/gamemode/balloon_report.lua', mapping, path.win32),
            'D:\\Source\\Repos\\sandbox\\gamemode\\balloon_report.lua'
        );
        assert.strictEqual(
            gamePathToClientPath('lua/autorun/server/x.lua', mapping, path.win32),
            'D:\\Servers\\GMod\\garrysmod\\lua\\autorun\\server\\x.lua'
        );
        assert.strictEqual(gamePathToClientPath('lua/x.lua', {}, path.win32), undefined);
    });

    test('maps garrysmod-relative files to the Lua search path include takes', () => {
        assert.strictEqual(gamePathToLuaPath('lua/autorun/x.lua'), 'autorun/x.lua');
        assert.strictEqual(gamePathToLuaPath('gamemodes\\sandbox\\gamemode\\init.lua'), 'sandbox/gamemode/init.lua');
        assert.strictEqual(
            gamePathToLuaPath('gamemodes/sandbox/entities/weapons/gmod_tool/stools/rope.lua'),
            'sandbox/entities/weapons/gmod_tool/stools/rope.lua'
        );
        assert.strictEqual(gamePathToLuaPath('addons/cityrp/lua/entities/door/init.lua'), 'entities/door/init.lua');
        assert.strictEqual(gamePathToLuaPath('Addons/CityRP/Gamemodes/cityrp/gamemode/init.lua'), 'cityrp/gamemode/init.lua');
    });

    test('rejects garrysmod-relative files outside the Lua search path', () => {
        assert.strictEqual(gamePathToLuaPath('cfg/lua/x.lua'), undefined);
        assert.strictEqual(gamePathToLuaPath('addons/cityrp/x.lua'), undefined);
        assert.strictEqual(gamePathToLuaPath('addons/cityrp/materials/lua/x.lua'), undefined);
        assert.strictEqual(gamePathToLuaPath('lua'), undefined);
    });

    suite('a checkout separate from the server install', () => {
        const server = 'D:/Servers/GMod/garrysmod';
        const serverMap = {
            [`${server}/addons`]: 'addons',
            [`${server}/lua`]: 'lua',
            [`${server}/gamemodes/base`]: 'gamemodes/base',
        };

        test('sends a breakpoint from another drive as its game path', () => {
            const paths = debuggerPathConverters(server, { ...serverMap, 'C:/Users/dev/repo': 'addons/repo' }, path.win32);

            assert.strictEqual(paths.toDebugger('C:\\Users\\dev\\repo\\lua\\autorun\\x.lua'), 'addons\\repo\\lua\\autorun\\x.lua');
        });

        test('opens an addon checkout over the server copy, whatever the map order', () => {
            const paths = debuggerPathConverters(server, { ...serverMap, 'D:/Source/pac3': 'addons/pac3' }, path.win32);

            assert.strictEqual(paths.toClient('@addons/pac3/lua/autorun/pac.lua'), 'D:\\Source\\pac3\\lua\\autorun\\pac.lua');
            assert.strictEqual(paths.toClient('@addons/other/lua/x.lua'), 'D:\\Servers\\GMod\\garrysmod\\addons\\other\\lua\\x.lua');
            assert.strictEqual(paths.toClient('=[C]'), '');
        });

        test('opens a whole garrysmod checkout over the server copy when the checkout has the file', () => {
            const mapping = { sourceRoot: server, sourceFileMap: { ...serverMap, 'C:/repo/garrysmod': '' } };
            const inCheckout = (file: string) => file.startsWith('C:');

            assert.strictEqual(
                gamePathToClientPath('addons/pac3/lua/x.lua', mapping, path.win32, inCheckout),
                'C:\\repo\\garrysmod\\addons\\pac3\\lua\\x.lua'
            );
            assert.strictEqual(
                gamePathToClientPath('addons/pac3/lua/x.lua', mapping, path.win32, () => false),
                'D:\\Servers\\GMod\\garrysmod\\addons\\pac3\\lua\\x.lua'
            );
        });

        test('keeps the most specific folder when the checkout is the server install itself', () => {
            const mapping = { sourceRoot: server, sourceFileMap: { ...serverMap, [server]: '' } };

            assert.strictEqual(
                gamePathToClientPath('addons/pac3/lua/x.lua', mapping, path.win32, () => true),
                'D:\\Servers\\GMod\\garrysmod\\addons\\pac3\\lua\\x.lua'
            );
        });
    });
});
