import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    isSuppressed,
    markPresetDismissed,
    readPresetState,
    resetPresetSuppression,
    updateLastDetection,
} from '../../gmodPresetState';
import { activateExtension, getFixtureUri } from './helper';

function makeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
}

function makeMockContext(): vscode.ExtensionContext {
    const store = new Map<string, unknown>();
    return {
        workspaceState: {
            get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
            update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
            keys: (): readonly string[] => [...store.keys()],
        },
    } as unknown as vscode.ExtensionContext;
}

suite('Framework command compatibility', () => {
    suiteSetup(async () => {
        await activateExtension(getFixtureUri('sample.lua'));
    });

    test('framework command ids remain registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('gluals.gmod.applyFrameworkPreset'));
        assert.ok(commands.includes('gluals.gmod.runFrameworkSetupWizard'));
        assert.ok(commands.includes('gluals.gmod.rerunFrameworkDetection'));
    });
});

suite('Preset suppression state', () => {
    let tmpDir: string;
    let folder: vscode.WorkspaceFolder;
    let context: vscode.ExtensionContext;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-preset-state-'));
        folder = makeWorkspaceFolder(tmpDir);
        context = makeMockContext();
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('dismissed preset is suppressed until fingerprint changes', async () => {
        await markPresetDismissed(context, folder, 'darkrp');
        const state = readPresetState(context, folder);
        assert.ok(isSuppressed(state, 'darkrp', state.lastFingerprint));
        assert.ok(!isSuppressed(state, 'darkrp', 'detected:helix'));
    });

    test('reset clears dismissals', async () => {
        await markPresetDismissed(context, folder, 'darkrp');
        await resetPresetSuppression(context, folder);
        const state = readPresetState(context, folder);
        assert.deepStrictEqual(state.dismissedPresetIds, []);
    });

    test('last detection stores normalized plugin ids for settings panel', async () => {
        await updateLastDetection(
            context,
            folder,
            'darkrp',
            'detected:darkrp,cami',
            [' darkrp ', 'cami', 'darkrp'],
        );
        const state = readPresetState(context, folder);
        assert.deepStrictEqual(state.lastDetectedPluginIds, ['cami', 'darkrp']);
    });
});
