import * as assert from 'assert';

import { isLikelyGluaPath } from '../../gluaPathClassifier';

suite('GLua Path Classifier', () => {
    test('recognizes Lua files in canonical GLua folders across slash styles and casing', () => {
        assert.strictEqual(isLikelyGluaPath('garrysmod/addons/example/lua/autorun/server.lua'), true);
        assert.strictEqual(isLikelyGluaPath('C:\\GarrysMod\\garrysmod\\GAMEMODE\\core.lua'), true);
        assert.strictEqual(isLikelyGluaPath('/project/Entities/example.lua'), true);
        assert.strictEqual(isLikelyGluaPath('/project/properties/example.lua'), true);
        assert.strictEqual(isLikelyGluaPath('/project/stools/example.lua'), true);
        assert.strictEqual(isLikelyGluaPath('/project/vgui/panel.lua'), true);
    });

    test('recognizes documented GLua entrypoint names and realm prefixes', () => {
        for (const filePath of [
            'init.lua',
            'CL_INIT.LUA',
            'shared.lua',
            'menu.lua',
            'cl_hud.lua',
            'sv_database.lua',
            'sh_config.lua',
        ]) {
            assert.strictEqual(isLikelyGluaPath(filePath), true, filePath);
        }
    });

    test('does not classify ordinary or non-Lua project files as GLua', () => {
        for (const filePath of [
            'premake5.lua',
            'BuildProjects.lua',
            'project/build.lua',
            'project/cl_config.txt',
            'project/lua-notes.md',
        ]) {
            assert.strictEqual(isLikelyGluaPath(filePath), false, filePath);
        }
    });
});
