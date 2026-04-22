import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyFrameworkPresetById } from '../../gmodPresetManager';
import { GmodPluginCatalog } from '../../gmodPluginCatalog';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-plugin-apply-'));
}

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

function readGluarc(folderPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(folderPath, '.gluarc.json'), 'utf8')) as Record<string, unknown>;
}

suite('Plugin Apply', () => {
    let tmpDir: string;
    let pluginBundleDir: string;
    let catalog: GmodPluginCatalog;

    setup(() => {
        tmpDir = makeTempDir();
        pluginBundleDir = path.join(tmpDir, 'plugin-darkrp');
        fs.mkdirSync(path.join(pluginBundleDir, 'annotations'), { recursive: true });
        fs.writeFileSync(path.join(pluginBundleDir, 'annotations', 'darkrp.lua'), '---@meta\nDarkRP = DarkRP or {}\n', 'utf8');
        fs.writeFileSync(path.join(pluginBundleDir, 'plugin.json'), JSON.stringify({
            id: 'darkrp',
            label: 'DarkRP',
            description: 'DarkRP plugin bundle for tests',
            gluarcPath: 'gluarc.json',
            annotationsPath: 'annotations',
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(pluginBundleDir, 'gluarc.json'), JSON.stringify({
            gmod: {
                scriptedClassScopes: {
                    include: [{
                        id: 'darkrp-modules',
                        classGlobal: 'GM',
                        include: ['gamemode/modules/**'],
                        label: 'DarkRP Modules',
                        path: ['gamemode', 'modules'],
                        rootDir: 'gamemode/modules',
                    }],
                },
            },
            diagnostics: {
                globals: ['DarkRP'],
            },
        }, null, 2), 'utf8');

        catalog = {
            plugins: [{
                id: 'darkrp',
                label: 'DarkRP',
                description: 'DarkRP plugin',
                kind: 'gamemode',
                manifestPatterns: ['"base"\\s+"darkrp"'],
                folderNamePatterns: ['darkrp'],
                fileNamePatterns: [],
                globalNames: [],
                globalPatterns: [],
                gamemodeBases: ['darkrp'],
                artifact: {
                    branch: 'gluals-annotations-plugin-darkrp',
                    manifest: 'plugin.json',
                    version: 'test-version',
                },
            }],
            byId: new Map(),
        };
        (catalog.byId as Map<string, any>).set('darkrp', catalog.plugins[0]);
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('appends plugin id and applies fragment additively', async () => {
        fs.writeFileSync(path.join(tmpDir, '.gluarc.json'), JSON.stringify({
            gmod: { defaultRealm: 'client' },
            diagnostics: { globals: ['ExistingGlobal'] },
        }, null, 2), 'utf8');

        await applyFrameworkPresetById(makeMockContext(), 'darkrp', makeWorkspaceFolder(tmpDir), {
            catalog,
            resolvePluginBundlePath: async () => pluginBundleDir,
        });
        const gluarc = readGluarc(tmpDir) as any;

        assert.deepStrictEqual(gluarc.gmod.plugins, ['darkrp']);
        assert.strictEqual(gluarc.gmod.defaultRealm, 'client', 'existing user override must be preserved');
        assert.ok(Array.isArray(gluarc.gmod.scriptedClassScopes.include), 'plugin scopes should be applied');
        assert.ok(gluarc.diagnostics.globals.includes('DarkRP'), 'plugin diagnostic globals should be applied');
        assert.ok(gluarc.diagnostics.globals.includes('ExistingGlobal'));
    });

    test('reapply is idempotent for gmod.plugins', async () => {
        fs.writeFileSync(path.join(tmpDir, '.gluarc.json'), JSON.stringify({}, null, 2), 'utf8');
        const context = makeMockContext();
        const folder = makeWorkspaceFolder(tmpDir);
        await applyFrameworkPresetById(context, 'darkrp', folder, {
            catalog,
            resolvePluginBundlePath: async () => pluginBundleDir,
        });
        await applyFrameworkPresetById(context, 'darkrp', folder, {
            catalog,
            resolvePluginBundlePath: async () => pluginBundleDir,
        });
        const gluarc = readGluarc(tmpDir) as any;
        assert.deepStrictEqual(gluarc.gmod.plugins, ['darkrp']);
    });
});
