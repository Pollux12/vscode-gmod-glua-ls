import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    buildBuiltinItems,
    buildPickItems,
    initialPickItem,
    choiceToSettings,
    chooseSaveTarget,
    GmodRoot,
    isGmodWorkspaceRoot,
    statusBackground,
    statusText,
    statusTooltip,
} from '../../gmodWorkspaceSelection';
import { alignSettingsWithGluarc, GmodWorkspaceSelection } from '../../gmodWorkspaceSelectionController';

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
    test('lists addons only and the custom gamemodes first, then the built-in, load-all and load-everything entries', () => {
        const items = buildPickItems(makeRoot());

        assert.deepStrictEqual(
            items.map((item) => [item.label, item.description]),
            [
                ['Addons only', 'no gamemode; the annotations cover base and sandbox'],
                ['helix', 'derives from sandbox'],
                ['darkrp', undefined],
                ['Show built-in gamemodes...', 'loads their source on top of the annotations'],
                ['Load all custom', 'every custom gamemode'],
                ['Load all', 'the whole folder, lua/ and built-in gamemodes included'],
            ],
        );
        assert.deepStrictEqual(items[0].choice, { kind: 'addonsOnly' });
        assert.strictEqual(items[3].showBuiltins, true);
        assert.deepStrictEqual(items[4].choice, { kind: 'allCustom' });
        assert.deepStrictEqual(items[5].choice, { kind: 'everything' });
    });

    test('omits the built-in entry when a root has no built-in gamemodes and lists built-ins separately', () => {
        const root = makeRoot();
        const customOnly = makeRoot({ gamemodes: root.gamemodes.filter((gamemode) => !gamemode.builtin) });

        assert.ok(!buildPickItems(customOnly).some((item) => item.showBuiltins));
        assert.deepStrictEqual(buildBuiltinItems(root).map((item) => item.label), ['$(arrow-left) Back', 'sandbox']);
        assert.strictEqual(buildBuiltinItems(root)[0].back, true);
    });

    test('marks the saved pick as current and starts the picker on it', () => {
        const root = makeRoot({ activeGamemode: 'darkrp', needsPick: false });
        const items = buildPickItems(root);

        assert.deepStrictEqual(items.filter((item) => item.description?.startsWith('✓ current')).map((item) => item.label), ['darkrp']);
        assert.strictEqual(initialPickItem(items, root)?.label, 'darkrp');

        const addonsOnly = makeRoot({ activeGamemode: '', needsPick: false });
        assert.strictEqual(initialPickItem(buildPickItems(addonsOnly), addonsOnly)?.label, 'Addons only');
        const everything = makeRoot({ loadEverything: true, needsPick: false });
        assert.strictEqual(initialPickItem(buildPickItems(everything), everything)?.label, 'Load all');
    });

    test('starts on the gamemode of an open file before the first pick, and on nothing without one', () => {
        const root = makeRoot();
        assert.strictEqual(initialPickItem(buildPickItems(root), root), undefined);
        assert.ok(!buildPickItems(root).some((item) => item.description?.startsWith('✓')));

        const helixOpen = makeRoot({ loaded: [...root.loaded, 'file:///games/GarrysMod/garrysmod/gamemodes/helix'] });
        assert.strictEqual(initialPickItem(buildPickItems(helixOpen), helixOpen)?.label, 'helix');
    });

    test('a built-in pick marks the built-in entry and starts both lists on it', () => {
        const root = makeRoot({ activeGamemode: 'sandbox', needsPick: false });
        const items = buildPickItems(root);
        const showBuiltins = items.find((item) => item.showBuiltins);

        assert.strictEqual(showBuiltins?.description, '✓ current: sandbox · loads their source on top of the annotations');
        assert.strictEqual(initialPickItem(items, root), showBuiltins);
        const builtins = buildBuiltinItems(root);
        assert.strictEqual(initialPickItem(builtins, root)?.label, 'sandbox');
    });

    test('maps each choice to the settings it writes', () => {
        assert.deepStrictEqual(choiceToSettings({ kind: 'addonsOnly' }), {
            activeGamemode: '',
            loadEverything: false,
        });
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
        assert.strictEqual(statusText([makeRoot({ activeGamemode: '' })]), 'GLuaLS: addons only');
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

    test('highlights the status bar while a GMod folder still needs a gamemode picked', () => {
        const picked = makeRoot({ activeGamemode: 'helix', needsPick: false });

        assert.strictEqual(statusBackground([makeRoot()]), 'statusBarItem.warningBackground');
        assert.strictEqual(statusBackground([picked, makeRoot()]), 'statusBarItem.warningBackground');
        assert.strictEqual(statusBackground([picked]), undefined);
    });

    test('keeps the automatic prompt open when focus moves away, unlike a picker the user opened', async () => {
        const originalCreateQuickPick = vscode.window.createQuickPick;
        const keptOpen: (boolean | undefined)[] = [];
        (vscode.window as any).createQuickPick = () => {
            let onHide: (() => void) | undefined;
            const quickPick = {
                ignoreFocusOut: undefined as boolean | undefined,
                selectedItems: [],
                onDidAccept: () => ({ dispose: () => undefined }),
                onDidHide: (listener: () => void) => {
                    onHide = listener;
                    return { dispose: () => undefined };
                },
                show: () => {
                    keptOpen.push(quickPick.ignoreFocusOut);
                    onHide?.();
                },
                dispose: () => undefined,
            };
            return quickPick;
        };
        const selection = new GmodWorkspaceSelection();
        try {
            selection.handleProjectsChanged({ roots: [makeRoot()] });
            await new Promise((resolve) => setTimeout(resolve, 0));
            await selection.selectGamemode();
        } finally {
            (vscode.window as any).createQuickPick = originalCreateQuickPick;
            selection.dispose();
        }

        assert.deepStrictEqual(keptOpen, [true, false]);
    });

    test('clears the folder settings that would override a pick saved to .gluarc.json', async () => {
        const { config, updates } = fakeConfig({
            activeGamemode: { workspaceFolderValue: 'helix', workspaceValue: 'darkrp' },
            loadEverything: {},
        });
        const pick = { activeGamemode: 'ixhl2rp', loadEverything: false };

        await alignSettingsWithGluarc(config, true, pick);
        const multiRoot = updates.splice(0);
        await alignSettingsWithGluarc(config, false, pick);

        assert.deepStrictEqual(multiRoot, [
            ['activeGamemode', 'ixhl2rp', vscode.ConfigurationTarget.WorkspaceFolder],
        ]);
        assert.deepStrictEqual(updates, [
            ['activeGamemode', undefined, vscode.ConfigurationTarget.WorkspaceFolder],
            ['activeGamemode', undefined, vscode.ConfigurationTarget.Workspace],
        ]);
    });

    test('keeps the pick in the folder settings where an inherited setting would override it', async () => {
        const { config, updates } = fakeConfig({
            activeGamemode: { globalValue: 'ixhl2rp', workspaceFolderValue: 'darkrp' },
            loadEverything: { globalValue: true, workspaceFolderValue: false },
        });

        await alignSettingsWithGluarc(config, false, { activeGamemode: 'ixhl2rp', loadEverything: false });

        assert.deepStrictEqual(updates, [
            ['activeGamemode', undefined, vscode.ConfigurationTarget.WorkspaceFolder],
            ['loadEverything', false, vscode.ConfigurationTarget.WorkspaceFolder],
        ]);
    });
});

type Inspected = { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown };

function fakeConfig(values: Record<string, Inspected>) {
    const updates: [string, unknown, vscode.ConfigurationTarget | boolean | null | undefined][] = [];
    const config = {
        inspect: (key: string) => ({ key, ...values[key] }),
        update: async (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean | null) => {
            updates.push([key, value, target]);
        },
    } as unknown as Pick<vscode.WorkspaceConfiguration, 'inspect' | 'update'>;
    return { config, updates };
}

suite('GMod workspace root detection', () => {
    let temp: string;

    setup(() => {
        temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-root-'));
    });

    teardown(() => {
        fs.rmSync(temp, { recursive: true, force: true });
    });

    function folder(...segments: string[]): string {
        const target = path.join(temp, ...segments);
        fs.mkdirSync(target, { recursive: true });
        return target;
    }

    test('recognises a folder with a garrysmod child, named garrysmod, or holding addons and gamemodes', () => {
        folder('srcds', 'garrysmod');
        assert.strictEqual(isGmodWorkspaceRoot(path.join(temp, 'srcds')), true);
        assert.strictEqual(isGmodWorkspaceRoot(folder('x', 'GarrysMod')), true);
        folder('both', 'addons');
        folder('both', 'gamemodes');
        assert.strictEqual(isGmodWorkspaceRoot(path.join(temp, 'both')), true);
    });

    test('rejects plain folders, addons folders and folders with only one of addons or gamemodes', () => {
        folder('plain', 'src');
        assert.strictEqual(isGmodWorkspaceRoot(folder('y', 'addons')), false);
        folder('half', 'gamemodes');
        assert.strictEqual(isGmodWorkspaceRoot(path.join(temp, 'plain')), false);
        assert.strictEqual(isGmodWorkspaceRoot(path.join(temp, 'half')), false);
        assert.strictEqual(isGmodWorkspaceRoot(path.join(temp, 'missing')), false);
    });
});
