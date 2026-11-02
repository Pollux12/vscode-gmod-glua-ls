import * as assert from 'assert';
import * as vscode from 'vscode';

import {
    buildBuiltinItems,
    buildPickItems,
    choiceToSettings,
    chooseSaveTarget,
    GmodRoot,
    statusText,
    statusTooltip,
} from '../../gmodWorkspaceSelection';
import { GmodWorkspaceSelection } from '../../gmodWorkspaceSelectionController';

function makeRoot(overrides: Partial<GmodRoot> = {}): GmodRoot {
    return {
        folderUri: 'file:///games/GarrysMod',
        rootUri: 'file:///games/GarrysMod/garrysmod',
        gamemodes: [
            { name: 'helix', uri: 'file:///games/GarrysMod/garrysmod/gamemodes/helix', derivesFrom: 'sandbox', builtin: false },
            { name: 'darkrp', uri: 'file:///games/GarrysMod/garrysmod/gamemodes/darkrp', builtin: false },
            { name: 'sandbox', uri: 'file:///games/GarrysMod/garrysmod/gamemodes/sandbox', builtin: true },
        ],
        addons: ['file:///games/GarrysMod/garrysmod/addons/ulx'],
        activeGamemode: null,
        loadEverything: false,
        loaded: ['file:///games/GarrysMod/garrysmod/addons/ulx'],
        needsPick: true,
        ...overrides,
    };
}

suite('GMod Workspace Selection', () => {
    test('lists custom gamemodes first, then the built-in, load-all and load-everything entries', () => {
        const items = buildPickItems(makeRoot());

        assert.deepStrictEqual(
            items.map((item) => [item.label, item.description]),
            [
                ['helix', 'derives from sandbox'],
                ['darkrp', undefined],
                ['Show built-in gamemodes...', undefined],
                ['Load all custom', 'every custom gamemode'],
                ['Load all', 'the whole folder, lua/ and built-in gamemodes included'],
            ],
        );
        assert.strictEqual(items[2].showBuiltins, true);
        assert.deepStrictEqual(items[3].choice, { kind: 'allCustom' });
        assert.deepStrictEqual(items[4].choice, { kind: 'everything' });
    });

    test('omits the built-in entry when a root has no built-in gamemodes and lists built-ins separately', () => {
        const root = makeRoot();
        const customOnly = makeRoot({ gamemodes: root.gamemodes.filter((gamemode) => !gamemode.builtin) });

        assert.ok(!buildPickItems(customOnly).some((item) => item.showBuiltins));
        assert.deepStrictEqual(buildBuiltinItems(root).map((item) => item.label), ['sandbox']);
    });

    test('maps each choice to the settings it writes', () => {
        assert.deepStrictEqual(choiceToSettings({ kind: 'gamemode', name: 'helix' }), {
            activeGamemode: 'helix',
            loadEverything: false,
        });
        assert.deepStrictEqual(choiceToSettings({ kind: 'allCustom' }), {
            activeGamemode: '*',
            loadEverything: false,
        });
        assert.deepStrictEqual(choiceToSettings({ kind: 'everything' }), { loadEverything: true });
    });

    test('saves to .gluarc.json only inside a git repository without another config file taking over', () => {
        const base = { inGitRepository: true, hasGluarc: false, hasOtherConfig: false };

        assert.strictEqual(chooseSaveTarget(base), 'gluarc');
        assert.strictEqual(chooseSaveTarget({ ...base, hasGluarc: true, hasOtherConfig: true }), 'gluarc');
        assert.strictEqual(chooseSaveTarget({ ...base, hasOtherConfig: true }), 'settings');
        assert.strictEqual(chooseSaveTarget({ ...base, inGitRepository: false }), 'settings');
        assert.strictEqual(chooseSaveTarget({ ...base, inGitRepository: false, hasGluarc: true }), 'settings');
    });

    test('describes the active gamemode in the status text', () => {
        assert.strictEqual(statusText([makeRoot({ activeGamemode: 'helix' })]), 'GLuaLS: helix');
        assert.strictEqual(statusText([makeRoot({ activeGamemode: '*' })]), 'GLuaLS: all custom');
        assert.strictEqual(statusText([makeRoot({ loadEverything: true })]), 'GLuaLS: everything');
        assert.strictEqual(statusText([makeRoot()]), 'GLuaLS: no gamemode');
    });

    test('names the gamemode that loaded on its own when none is configured', () => {
        const root = makeRoot({
            gamemodes: [makeRoot().gamemodes[0]],
            loaded: ['file:///games/GarrysMod/garrysmod/gamemodes/helix'],
            needsPick: false,
        });

        assert.strictEqual(statusText([root]), 'GLuaLS: helix');
    });

    test('summarises several GMod folders and lists the loaded folders in the tooltip', () => {
        const first = makeRoot({ activeGamemode: 'helix' });
        const second = makeRoot({ folderUri: 'file:///other/Server', activeGamemode: 'darkrp' });

        assert.strictEqual(statusText([first, first]), 'GLuaLS: helix');
        assert.strictEqual(statusText([first, second]), 'GLuaLS: 2 GMod folders');
        assert.strictEqual(
            statusTooltip([first]),
            'GarrysMod: helix\n  ulx\nClick to select the gamemode',
        );
    });

    test('keeps the automatic prompt open when focus moves away, unlike a picker the user opened', async () => {
        const originalShowQuickPick = vscode.window.showQuickPick;
        const keptOpen: (boolean | undefined)[] = [];
        (vscode.window as any).showQuickPick = async (_items: unknown, options?: vscode.QuickPickOptions) => {
            keptOpen.push(options?.ignoreFocusOut);
            return undefined;
        };
        const selection = new GmodWorkspaceSelection();
        try {
            selection.handleProjectsChanged({ roots: [makeRoot()] });
            await new Promise((resolve) => setTimeout(resolve, 0));
            await selection.selectGamemode();
        } finally {
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            selection.dispose();
        }

        assert.deepStrictEqual(keptOpen, [true, false]);
    });
});
