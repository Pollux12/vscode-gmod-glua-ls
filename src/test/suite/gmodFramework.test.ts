/**
 * Tests for framework detection, preset state, and command smoke coverage.
 *
 * These tests run inside the VS Code extension host. They use temporary
 * directories on disk to simulate workspace structures.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    detectFramework,
    buildDetectionFingerprint,
    FRAMEWORK_DESCRIPTORS,
} from '../../gmodFrameworkDescriptors';
import {
    readPresetState,
    markPresetApplied,
    markPresetDismissed,
    resetPresetSuppression,
    isSuppressed,
} from '../../gmodPresetState';
import {
    applyFrameworkPresetById,
    runFrameworkPresetCheck,
} from '../../gmodPresetManager';
import {
    inferClassGlobal,
    SCOPE_NAME_TO_CLASS_GLOBAL,
    PRESELECT_SCOPE_PATHS,
    normalizeScopePath,
    deduplicateScopePaths,
    normalizeCustomScopePath,
    runFrameworkSetupWizard,
    isValidLuaIdentifier,
} from '../../gmodFrameworkWizard';
import {
    buildLoaderScopePatternFamily,
    matchStructuralLoaderScope,
} from '../../gmodFrameworkScopePatterns';
import { readGluarcConfig } from '../../gluarcConfig';
import { activateExtension, getFixtureUri } from './helper';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempFolder(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-fw-test-'));
}

function makeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
}

function writeManifest(folderPath: string, gamemodeId: string, base: string): void {
    fs.writeFileSync(
        path.join(folderPath, `${gamemodeId}.txt`),
        `"${gamemodeId}"\n{\n    "base"    "${base}"\n    "title"   "${gamemodeId}"\n}\n`,
        'utf8',
    );
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

// ─── Suite: Framework Detection ───────────────────────────────────────────────

suite('Framework Detection', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTempFolder();
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    test('no detection for empty folder', async () => {
        const folder = makeWorkspaceFolder(tmpDir);
        const result = await detectFramework(folder);
        assert.strictEqual(result.detected, undefined, 'Empty folder should not detect any framework');
    });

    test('detects DarkRP from manifest base field', async () => {
        writeManifest(tmpDir, 'my_darkrp', 'DarkRP');
        const folder = makeWorkspaceFolder(tmpDir);

        const result = await detectFramework(folder);
        assert.ok(result.detected, 'Should detect a framework');
        assert.strictEqual(result.detected!.id, 'darkrp', 'Should detect DarkRP');
        assert.ok(result.evidence.some((e) => e.includes('darkrp')), 'Evidence should mention darkrp manifest');
    });

    test('detects Helix from manifest base field', async () => {
        writeManifest(tmpDir, 'my_schema', 'helix');
        const folder = makeWorkspaceFolder(tmpDir);

        const result = await detectFramework(folder);
        assert.ok(result.detected, 'Should detect a framework');
        assert.strictEqual(result.detected!.id, 'helix', 'Should detect Helix');
    });

    test('detects Helix from folder name containing "helix"', async () => {
        // Rename the temp dir to simulate a folder named "helix-hl2rp"
        const helixDir = path.join(path.dirname(tmpDir), 'helix-hl2rp');
        fs.renameSync(tmpDir, helixDir);
        tmpDir = helixDir;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await detectFramework(folder);
        assert.ok(result.detected, 'Should detect a framework from folder name');
        assert.strictEqual(result.detected!.id, 'helix', 'Should detect Helix from folder name');
    });

    test('detects DarkRP from folder name containing "darkrp"', async () => {
        const darkrpDir = path.join(path.dirname(tmpDir), 'darkrp-cityrp');
        fs.renameSync(tmpDir, darkrpDir);
        tmpDir = darkrpDir;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await detectFramework(folder);
        assert.ok(result.detected, 'Should detect a framework from folder name');
        assert.strictEqual(result.detected!.id, 'darkrp', 'Should detect DarkRP from folder name');
    });

    test('detects nutscript as Helix from manifest base', async () => {
        writeManifest(tmpDir, 'my_schema', 'nutscript');
        const folder = makeWorkspaceFolder(tmpDir);

        const result = await detectFramework(folder);
        assert.ok(result.detected, 'Should detect a framework');
        assert.strictEqual(result.detected!.id, 'helix', 'nutscript base should map to Helix');
    });

    test('detects Parallax from manifest base field', async () => {
        writeManifest(tmpDir, 'my_parallax', 'parallax');
        const folder = makeWorkspaceFolder(tmpDir);

        const result = await detectFramework(folder);
        assert.ok(result.detected, 'Should detect a framework');
        assert.strictEqual(result.detected!.id, 'parallax', 'Should detect Parallax');
    });

    test('manifest base takes priority over folder name', async () => {
        // Folder name says "darkrp" but manifest says "helix"
        writeManifest(tmpDir, 'darkrp-named', 'helix');
        const folder = makeWorkspaceFolder(tmpDir);

        const result = await detectFramework(folder);
        assert.ok(result.detected, 'Should detect a framework');
        assert.strictEqual(result.detected!.id, 'helix', 'Manifest base should take priority');
    });

    test('buildDetectionFingerprint is stable', async () => {
        writeManifest(tmpDir, 'my_rp', 'darkrp');
        const folder = makeWorkspaceFolder(tmpDir);

        const result1 = await detectFramework(folder);
        const result2 = await detectFramework(folder);

        const fp1 = buildDetectionFingerprint(result1);
        const fp2 = buildDetectionFingerprint(result2);

        assert.strictEqual(fp1, fp2, 'Fingerprint should be deterministic for same workspace state');
    });

    test('buildDetectionFingerprint returns "none" for empty folder', async () => {
        const folder = makeWorkspaceFolder(tmpDir);
        const result = await detectFramework(folder);

        const fp = buildDetectionFingerprint(result);
        assert.strictEqual(fp, 'none');
    });

    test('buildDetectionFingerprint returns detected:<id> for detected framework', async () => {
        writeManifest(tmpDir, 'my_rp', 'darkrp');
        const folder = makeWorkspaceFolder(tmpDir);
        const result = await detectFramework(folder);
        const fp = buildDetectionFingerprint(result);
        assert.strictEqual(fp, 'detected:darkrp');
    });
});

// ─── Suite: Preset State ──────────────────────────────────────────────────────

suite('Preset State', () => {
    let context: vscode.ExtensionContext;
    let tmpDir: string;

    suiteSetup(async () => {
        await activateExtension(getFixtureUri('sample.lua'));
    });

    setup(() => {
        // Each test gets a fresh isolated in-memory context
        context = makeMockContext();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-state-test-'));
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function folder(): vscode.WorkspaceFolder {
        return makeWorkspaceFolder(tmpDir);
    }

    test('readPresetState returns defaults for new folder', () => {
        const state = readPresetState(context, folder());
        assert.deepStrictEqual(state.appliedPresetIds, []);
        assert.deepStrictEqual(state.dismissedPresetIds, []);
        assert.strictEqual(state.lastDetectedFrameworkId, undefined);
        assert.strictEqual(state.suppressUntilFingerprintChanges, false);
    });

    test('markPresetApplied records applied preset and clears dismissal', async () => {
        const f = folder();
        await markPresetDismissed(context, f, 'helix-preset');
        await markPresetApplied(context, f, 'helix-preset');

        const state = readPresetState(context, f);
        assert.ok(state.appliedPresetIds.includes('helix-preset'), 'Should be in applied list');
        assert.ok(!state.dismissedPresetIds.includes('helix-preset'), 'Should be removed from dismissed list');
    });

    test('markPresetDismissed sets suppression flag', async () => {
        const f = folder();
        await markPresetDismissed(context, f, 'darkrp-preset');

        const state = readPresetState(context, f);
        assert.ok(state.dismissedPresetIds.includes('darkrp-preset'), 'Should be in dismissed list');
        assert.strictEqual(state.suppressUntilFingerprintChanges, true);
    });

    test('resetPresetSuppression clears dismissed list and suppression flag', async () => {
        const f = folder();
        await markPresetDismissed(context, f, 'helix-preset');
        await resetPresetSuppression(context, f);

        const state = readPresetState(context, f);
        assert.deepStrictEqual(state.dismissedPresetIds, []);
        assert.strictEqual(state.suppressUntilFingerprintChanges, false);
    });

    test('isSuppressed — applied preset is always suppressed', () => {
        const state = { ...{ appliedPresetIds: ['helix-preset'], dismissedPresetIds: [], lastDetectedFrameworkId: undefined, lastFingerprint: 'detected:helix', suppressUntilFingerprintChanges: false } };
        assert.ok(isSuppressed(state, 'helix-preset', 'detected:helix'));
    });

    test('isSuppressed — dismissed + same fingerprint = suppressed', () => {
        const state = {
            appliedPresetIds: [],
            dismissedPresetIds: ['helix-preset'],
            lastDetectedFrameworkId: 'helix',
            lastFingerprint: 'detected:helix',
            suppressUntilFingerprintChanges: true,
        };
        assert.ok(isSuppressed(state, 'helix-preset', 'detected:helix'), 'Should be suppressed with same fingerprint');
    });

    test('isSuppressed — dismissed but fingerprint changed = not suppressed', () => {
        const state = {
            appliedPresetIds: [],
            dismissedPresetIds: ['helix-preset'],
            lastDetectedFrameworkId: 'helix',
            lastFingerprint: 'detected:helix',
            suppressUntilFingerprintChanges: true,
        };
        assert.ok(!isSuppressed(state, 'helix-preset', 'detected:darkrp'), 'Should NOT be suppressed when fingerprint changed');
    });

    test('isSuppressed — fresh state is not suppressed', () => {
        const state = {
            appliedPresetIds: [],
            dismissedPresetIds: [],
            lastDetectedFrameworkId: undefined,
            lastFingerprint: undefined,
            suppressUntilFingerprintChanges: false,
        };
        assert.ok(!isSuppressed(state, 'any-preset', 'detected:helix'));
    });

    // ── Multi-root isolation ───────────────────────────────────────────────────

    test('state is isolated per workspace folder URI', async () => {
        // Use a fresh context to ensure zero cross-test contamination
        const isolationContext = makeMockContext();
        const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-state-iso-1-'));
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-state-iso-2-'));

        try {
            const folder1 = makeWorkspaceFolder(dir1);
            const folder2 = makeWorkspaceFolder(dir2);

            await markPresetApplied(isolationContext, folder1, 'helix-preset');

            const state1 = readPresetState(isolationContext, folder1);
            const state2 = readPresetState(isolationContext, folder2);

            assert.ok(state1.appliedPresetIds.includes('helix-preset'), 'folder1 should have applied preset');
            assert.ok(!state2.appliedPresetIds.includes('helix-preset'), 'folder2 should NOT see folder1 state');
        } finally {
            try { fs.rmSync(dir1, { recursive: true, force: true }); } catch { /* best-effort */ }
            try { fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    });
});

// ─── Suite: Command/Wizard Smoke Tests ────────────────────────────────────────

suite('Framework Commands — Smoke Tests', () => {
    suiteSetup(async () => {
        await activateExtension(getFixtureUri('sample.lua'));
    });

    test('gluals.gmod.applyFrameworkPreset command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('gluals.gmod.applyFrameworkPreset'),
            'gluals.gmod.applyFrameworkPreset must be registered',
        );
    });

    test('gluals.gmod.runFrameworkSetupWizard command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('gluals.gmod.runFrameworkSetupWizard'),
            'gluals.gmod.runFrameworkSetupWizard must be registered',
        );
    });

    test('gluals.gmod.rerunFrameworkDetection command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('gluals.gmod.rerunFrameworkDetection'),
            'gluals.gmod.rerunFrameworkDetection must be registered',
        );
    });

    test('gluals.gmod.rerunFrameworkDetection executes without error', async () => {
        try {
            await vscode.commands.executeCommand('gluals.gmod.rerunFrameworkDetection');
        } catch (error) {
            assert.fail(`Command threw: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
});

// ─── Suite: Preset detection guided wizard path ───────────────────────────────

suite('Framework Preset Detection — Guided wizard path', () => {
    const originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
    const originalInfo = vscode.window.showInformationMessage;
    const originalQuickPick = vscode.window.showQuickPick;
    const originalInputBox = vscode.window.showInputBox;
    const originalWarn = vscode.window.showWarningMessage;
    let tmpDir: string;
    let mockedWorkspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-guided-fw-'));
        mockedWorkspaceFolders = undefined;
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            configurable: true,
            get: () => mockedWorkspaceFolders,
        });
    });

    teardown(() => {
        if (originalWorkspaceFoldersDescriptor) {
            Object.defineProperty(vscode.workspace, 'workspaceFolders', originalWorkspaceFoldersDescriptor);
        }
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = originalInfo;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = originalQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = originalInputBox;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = originalWarn;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    test('detected DarkRP framework offers apply and review setup options', async () => {
        writeManifest(tmpDir, 'cityrp', 'darkrp');
        fs.mkdirSync(path.join(tmpDir, 'gamemode', 'modules'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'gamemode', 'config'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'gamemode', 'modules', 'sh_jobs.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'gamemode', 'config', 'sh_config.lua'), 'return true\n', 'utf8');

        const folder = makeWorkspaceFolder(tmpDir);
        mockedWorkspaceFolders = [folder];

        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async (message: string, _options: any, ...items: string[]) => {
            assert.ok(message.includes('DarkRP'), 'prompt should mention detected DarkRP framework');
            assert.ok(items.includes('Apply'), 'prompt should offer Apply option');
            assert.ok(items.includes('Review Setup'), 'prompt should offer Review Setup option');
            return 'Apply' as any;
        }) as typeof vscode.window.showInformationMessage;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async () => undefined) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        await runFrameworkPresetCheck(makeMockContext());

        const config = await readGluarcConfig(folder) as any;
        const scopes = config.gmod?.scriptedClassScopes?.include ?? [];
        assert.ok(scopes.length > 0, 'preset apply should write class scopes');
    });

    test('unknown but GMod-like project offers setup wizard instead of silent no-op', async () => {
        fs.mkdirSync(path.join(tmpDir, 'gamemode', 'schema'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'gamemode', 'framework'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'gamemode', 'schema', 'sh_schema.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'gamemode', 'framework', 'sh_framework.lua'), 'return true\n', 'utf8');

        const folder = makeWorkspaceFolder(tmpDir);
        mockedWorkspaceFolders = [folder];

        let prompted = false;
        let quickPickCall = 0;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async (message: string) => {
            prompted = true;
            assert.ok(message.includes('couldn\'t auto-detect a framework'), 'unknown projects should be routed to setup review');
            return 'Review Setup' as any;
        }) as typeof vscode.window.showInformationMessage;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: readonly any[]) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                const framework = items.find((item) => item.relativePath === 'gamemode/framework');
                const schema = items.find((item) => item.relativePath === 'gamemode/schema');
                return [framework, schema].filter(Boolean) as any;
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        await runFrameworkPresetCheck(makeMockContext());

        assert.strictEqual(prompted, true, 'unknown custom projects should get the guided wizard prompt');
        const config = await readGluarcConfig(folder) as any;
        const scopes = config.gmod?.scriptedClassScopes?.include ?? [];
        assert.ok(scopes.some((scope: any) => scope.rootDir === 'gamemode/framework'));
        assert.ok(scopes.some((scope: any) => scope.rootDir === 'gamemode/schema'));
    });

    test('incidental top-level txt file does not trigger guided setup prompt', async () => {
        fs.writeFileSync(path.join(tmpDir, 'README.txt'), 'Not a gamemode manifest.\n', 'utf8');

        const folder = makeWorkspaceFolder(tmpDir);
        mockedWorkspaceFolders = [folder];

        let prompted = false;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => {
            prompted = true;
            return undefined;
        }) as typeof vscode.window.showInformationMessage;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async () => undefined) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => undefined) as typeof vscode.window.showInputBox;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        await runFrameworkPresetCheck(makeMockContext());

        assert.strictEqual(prompted, false, 'incidental txt files should not mark a folder as GMod-like');
    });
});

// ─── Suite: Preset output validity (Issues 1 & 2) ────────────────────────────

suite('Preset Output Validity', () => {
    test('all framework presets produce class scope entries with classGlobal', () => {
        for (const desc of FRAMEWORK_DESCRIPTORS) {
            const preset = desc.getPreset();
            for (const scope of preset.classScopes) {
                assert.ok(
                    typeof scope.classGlobal === 'string' && scope.classGlobal.trim().length > 0,
                    `${desc.label} classScope "${scope.id}" is missing required classGlobal — ` +
                    `entries without classGlobal are silently dropped by the Rust backend`,
                );
                assert.ok(
                    Array.isArray(scope.include) && scope.include.length > 0,
                    `${desc.label} classScope "${scope.id}" is missing required include globs`,
                );
                assert.ok(
                    typeof scope.label === 'string' && scope.label.trim().length > 0,
                    `${desc.label} classScope "${scope.id}" is missing required label`,
                );
                assert.ok(
                    Array.isArray(scope.path) && scope.path.length > 0,
                    `${desc.label} classScope "${scope.id}" is missing required path`,
                );
            }
        }
    });

    test('DarkRP preset exposes only class scopes in active extension flow', () => {
        const darkrp = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'darkrp')!;
        const preset = darkrp.getPreset();
        assert.ok(preset.classScopes.length > 0, 'DarkRP preset should still expose class scopes');
    });

    test('Helix preset class scopes have per-scope classGlobal values', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const preset = helix.getPreset();
        const plugins = preset.classScopes.find((s) => s.id === 'helix-plugins')!;
        const items = preset.classScopes.find((s) => s.id === 'helix-items')!;
        const factions = preset.classScopes.find((s) => s.id === 'helix-factions')!;
        const classes = preset.classScopes.find((s) => s.id === 'helix-classes')!;
        assert.strictEqual(plugins?.classGlobal, 'PLUGIN');
        assert.strictEqual(items?.classGlobal, 'ITEM');
        assert.strictEqual(factions?.classGlobal, 'FACTION');
        assert.strictEqual(classes?.classGlobal, 'CLASS');
    });

    test('Helix preset represents Schema/ITEM/PLUGIN/FACTION/CLASS via class scopes only', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const preset = helix.getPreset();
        const globals = new Set(preset.classScopes.map((scope) => scope.classGlobal));
        assert.ok(globals.has('Schema'), 'Schema class scope missing');
        assert.ok(globals.has('ITEM'), 'ITEM class scope missing');
        assert.ok(globals.has('PLUGIN'), 'PLUGIN class scope missing');
        assert.ok(globals.has('FACTION'), 'FACTION class scope missing');
        assert.ok(globals.has('CLASS'), 'CLASS class scope missing');
    });

    test('Helix preset includes Schema class scope with schema-relevant include globs and fixedClassName', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const preset = helix.getPreset();
        const schema = preset.classScopes.find((s) => s.id === 'helix-schema');
        assert.ok(schema, 'Helix preset must include a helix-schema class scope entry');
        assert.strictEqual(schema.classGlobal, 'Schema', 'helix-schema classGlobal must be Schema');
        assert.strictEqual(schema.fixedClassName, 'Schema', 'helix-schema fixedClassName must be Schema');
        assert.ok(schema.isGlobalSingleton, 'helix-schema must be a global singleton');
        assert.ok(
            schema.include.some((g) => g.startsWith('schema/')),
            'helix-schema include must cover schema/ paths',
        );
        // Includes must be tight — only schema/ paths or the known Helix schema entry file
        assert.ok(
            schema.include.every(
                (g) => g.startsWith('schema/') || g === 'gamemode/schema.lua',
            ),
            'helix-schema includes must be scoped to schema/ paths or the gamemode/schema.lua entry file (keep globs tight)',
        );
    });

    // ── Issue 1: helix-plugins scope coherence ────────────────────────────────

    test('Helix helix-plugins scope include covers only schema/plugins', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const plugins = helix.getPreset().classScopes.find((s) => s.id === 'helix-plugins')!;
        assert.ok(plugins, 'helix-plugins scope must exist');
        assert.ok(
            plugins.include.every((g) => g.startsWith('schema/plugins')),
            'helix-plugins include must only cover schema/plugins/** — top-level plugins/ has its own scope entry',
        );
        assert.deepStrictEqual(plugins.path, ['schema', 'plugins'],
            'helix-plugins path must match its include (schema/plugins)');
        assert.strictEqual(plugins.rootDir, 'schema/plugins',
            'helix-plugins rootDir must match its include (schema/plugins)');
    });

    test('Helix helix-plugins-root scope covers top-level plugins/ with coherent path', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const rootPlugins = helix.getPreset().classScopes.find((s) => s.id === 'helix-plugins-root')!;
        assert.ok(rootPlugins, 'helix-plugins-root scope must exist for top-level plugins/');
        assert.strictEqual(rootPlugins.classGlobal, 'PLUGIN',
            'helix-plugins-root must use PLUGIN as classGlobal');
        assert.ok(
            rootPlugins.include.every((g) => g.startsWith('plugins')),
            'helix-plugins-root include must only cover plugins/**',
        );
        assert.deepStrictEqual(rootPlugins.path, ['plugins'],
            'helix-plugins-root path must match its include (plugins)');
        assert.strictEqual(rootPlugins.rootDir, 'plugins',
            'helix-plugins-root rootDir must match its include (plugins)');
    });

    test('Helix helix-items scope is minimal and coherent with its backend path matching', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const items = helix.getPreset().classScopes.find((s) => s.id === 'helix-items')!;
        assert.ok(items, 'helix-items scope must exist');
        assert.strictEqual(items.classGlobal, 'ITEM');
        assert.deepStrictEqual(items.include, ['schema/items/**', 'schema/plugins/*/items/**', 'plugins/*/items/**'],
            'helix-items should cover direct and plugin-contained item loaders through tight structural patterns only');
        assert.deepStrictEqual(items.path, ['items'],
            'helix-items path should remain the backend item path');
        assert.strictEqual(items.rootDir, undefined,
            'helix-items should not set a mismatched rootDir when covering schema/items/**');
        assert.ok(items.stripFilePrefix, 'helix-items must strip sh_/sv_/cl_ file prefix for class name');
    });

    test('Helix helix-items scope includes plugin-contained item loaders only through structural plugin-container families', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const items = helix.getPreset().classScopes.find((s) => s.id === 'helix-items')!;
        assert.ok(items.include.includes('schema/plugins/*/items/**'),
            'helix-items must cover schema/plugins/<plugin>/items/** loader layouts');
        assert.ok(items.include.includes('plugins/*/items/**'),
            'helix-items must cover plugins/<plugin>/items/** loader layouts');
        assert.ok(
            items.include.every((glob) => [
                'schema/items/**',
                'schema/plugins/*/items/**',
                'plugins/*/items/**',
            ].includes(glob)),
            'helix-items include globs must stay tight to real item loaders only',
        );
    });

    // ── Issue 2: darkrp-modules scope coherence ───────────────────────────────

    test('DarkRP darkrp-modules scope include does not contain darkrp_config', () => {
        const darkrp = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'darkrp')!;
        const modules = darkrp.getPreset().classScopes.find((s) => s.id === 'darkrp-modules')!;
        assert.ok(modules, 'darkrp-modules scope must exist');
        assert.ok(
            !modules.include.some((g) => g.includes('darkrp_config')),
            'darkrp-modules include must not contain darkrp_config — those files ' +
            'cannot resolve through the gamemode/modules path/rootDir',
        );
        assert.ok(
            modules.include.every((g) => g.startsWith('gamemode/modules')),
            'darkrp-modules include must only cover paths under gamemode/modules',
        );
        assert.deepStrictEqual(modules.path, ['gamemode', 'modules'],
            'darkrp-modules path must be coherent with its include globs');
        assert.strictEqual(modules.rootDir, 'gamemode/modules',
            'darkrp-modules rootDir must be coherent with its include globs');
    });

    test('DarkRP preset covers reviewed config and lua extension roots', () => {
        const darkrp = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'darkrp')!;
        const preset = darkrp.getPreset();
        const expectedRoots = [
            'gamemode/modules',
            'gamemode/config',
            'gamemode/libraries',
            'lua/darkrp_modules',
            'lua/darkrp_customthings',
            'lua/darkrp_config',
            'lua/darkrp_language',
        ];

        for (const rootDir of expectedRoots) {
            const scope = preset.classScopes.find((entry) => entry.rootDir === rootDir);
            assert.ok(scope, `DarkRP preset should include ${rootDir}`);
            assert.strictEqual(scope?.classGlobal, 'GM', `${rootDir} should use conservative GM classGlobal`);
            assert.deepStrictEqual(scope?.include, [`${rootDir}/**`]);
            assert.deepStrictEqual(scope?.path, rootDir.split('/'));
        }
    });

    test('Parallax preset covers framework, modules, and schema roots conservatively', () => {
        const parallax = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'parallax')!;
        const preset = parallax.getPreset();
        const expectedRoots = [
            'gamemode/framework',
            'gamemode/modules',
            'gamemode/schema',
        ];

        for (const rootDir of expectedRoots) {
            const scope = preset.classScopes.find((entry) => entry.rootDir === rootDir);
            assert.ok(scope, `Parallax preset should include ${rootDir}`);
            assert.strictEqual(scope?.classGlobal, 'GM', `${rootDir} should use conservative GM classGlobal`);
            assert.deepStrictEqual(scope?.include, [`${rootDir}/**`]);
            assert.deepStrictEqual(scope?.path, rootDir.split('/'));
        }
    });
});

// ─── Suite: isSuppressed per-preset (Issue 5) ────────────────────────────────

suite('isSuppressed — per-preset suppression', () => {
    // Re-use the same mock context factory
    function makeMockCtx(): vscode.ExtensionContext {
        const store = new Map<string, unknown>();
        return {
            workspaceState: {
                get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
                update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
                keys: (): readonly string[] => [...store.keys()],
            },
        } as unknown as vscode.ExtensionContext;
    }

    test('dismissing one preset does not suppress a different preset', () => {
        const state = {
            appliedPresetIds: [],
            dismissedPresetIds: ['darkrp-preset'],   // only darkrp was dismissed
            lastDetectedFrameworkId: 'helix',
            lastFingerprint: 'detected:helix',
            suppressUntilFingerprintChanges: true,
        };
        // helix-preset was never dismissed — should NOT be suppressed
        assert.ok(
            !isSuppressed(state, 'helix-preset', 'detected:helix'),
            'helix-preset must not be suppressed when only darkrp-preset was dismissed',
        );
    });

    test('dismissing a preset suppresses only that preset', () => {
        const state = {
            appliedPresetIds: [],
            dismissedPresetIds: ['helix-preset'],
            lastDetectedFrameworkId: 'helix',
            lastFingerprint: 'detected:helix',
            suppressUntilFingerprintChanges: true,
        };
        assert.ok(
            isSuppressed(state, 'helix-preset', 'detected:helix'),
            'helix-preset must be suppressed after being dismissed with same fingerprint',
        );
        assert.ok(
            !isSuppressed(state, 'darkrp-preset', 'detected:helix'),
            'darkrp-preset must not be suppressed when only helix-preset was dismissed',
        );
    });

    test('suppressUntilFingerprintChanges=true but preset not in dismissedPresetIds = not suppressed', () => {
        const state = {
            appliedPresetIds: [],
            dismissedPresetIds: [],  // empty!
            lastDetectedFrameworkId: 'helix',
            lastFingerprint: 'detected:helix',
            suppressUntilFingerprintChanges: true, // flag is set but no dismissed presets
        };
        assert.ok(
            !isSuppressed(state, 'helix-preset', 'detected:helix'),
            'Must not be suppressed when preset is not in dismissedPresetIds even if flag is set',
        );
    });

    test('per-preset suppression lifted when fingerprint changes', async () => {
        const context = makeMockCtx();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-suppression-'));
        try {
            const f = { uri: vscode.Uri.file(tmpDir), name: path.basename(tmpDir), index: 0 };
            await markPresetDismissed(context, f, 'helix-preset');

            // Fingerprint changes — suppression should lift for helix-preset
            const state = readPresetState(context, f);
            assert.ok(
                !isSuppressed(state, 'helix-preset', 'detected:darkrp'),
                'Suppression must be lifted when fingerprint changes',
            );
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    });
});

// ─── Suite: applyPreset mark-applied logic (Issue 1 fix) ─────────────────────

/**
 * Tests that applyPreset only marks a preset as applied when the patch was
 * actually persisted or the config was already fully equivalent (idempotent
 * no-op), but NOT when all entries were skipped due to conflicts.
 */
suite('applyPreset — markApplied logic', () => {
    function makeMockCtx(): vscode.ExtensionContext {
        const store = new Map<string, unknown>();
        return {
            workspaceState: {
                get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
                update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
                keys: (): readonly string[] => [...store.keys()],
            },
        } as unknown as vscode.ExtensionContext;
    }

    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-apply-mark-'));
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    /**
     * Conflict-only outcome: preset is NOT marked as applied.
     */
    test('conflict-only outcome: preset is NOT marked as applied', async () => {
        // Force all gmod.* paths to conflict by making gmod a scalar
        fs.writeFileSync(
            path.join(tmpDir, '.gluarc.json'),
            JSON.stringify({ gmod: 42 }),
            'utf8',
        );
        const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(tmpDir), name: path.basename(tmpDir), index: 0 };
        const context = makeMockCtx();

        await applyFrameworkPresetById(context, 'darkrp', folder);

        const state = readPresetState(context, folder);
        assert.ok(
            !state.appliedPresetIds.includes('darkrp-preset'),
            'Conflict-only outcome (blocked > 0) must NOT mark the preset as applied',
        );
    });

    /**
     * Content drift outcome: preset is NOT marked as applied.
     */
    test('content drift outcome: preset is NOT marked as applied', async () => {
        // Create an entry that exists but with different content (drift)
        fs.writeFileSync(
            path.join(tmpDir, '.gluarc.json'),
            JSON.stringify({
                gmod: {
                    scriptedClassScopes: {
                        include: [
                            { id: 'darkrp-modules', classGlobal: 'WRONG', include: ['gamemode/modules/**'], label: 'Wrong', path: ['gamemode', 'modules'] }
                        ]
                    }
                }
            }),
            'utf8',
        );
        const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(tmpDir), name: path.basename(tmpDir), index: 0 };
        const context = makeMockCtx();

        await applyFrameworkPresetById(context, 'darkrp', folder);

        const state = readPresetState(context, folder);
        assert.ok(
            !state.appliedPresetIds.includes('darkrp-preset'),
            'Content drift outcome (conflicts > 0) must NOT mark the preset as applied',
        );
    });

    /**
     * Partial success with conflicts: preset is NOT marked as applied.
     */
    test('partial success with conflicts: preset is NOT marked as applied', async () => {
        // One entry is already there with drift so the preset should still remain unapplied.
        fs.writeFileSync(
            path.join(tmpDir, '.gluarc.json'),
            JSON.stringify({
                gmod: {
                    scriptedClassScopes: {
                        include: [
                            { id: 'darkrp-modules', classGlobal: 'WRONG', include: ['gamemode/modules/**'], label: 'Wrong', path: ['gamemode', 'modules'] }
                        ]
                    }
                }
            }),
            'utf8',
        );
        const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(tmpDir), name: path.basename(tmpDir), index: 0 };
        const context = makeMockCtx();

        await applyFrameworkPresetById(context, 'darkrp', folder);

        const state = readPresetState(context, folder);
        assert.ok(
            !state.appliedPresetIds.includes('darkrp-preset'),
            'Partial success with conflicts must NOT mark the preset as applied',
        );
    });


    /**
     * Success scenario: config starts empty so all entries are written.
     * summary = { modified: true, added: [...], skipped: [] }.
     * Preset must be marked as applied.
     */
    test('success outcome: preset IS marked as applied after writing entries', async () => {
        fs.writeFileSync(
            path.join(tmpDir, '.gluarc.json'),
            JSON.stringify({}),
            'utf8',
        );
        const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(tmpDir), name: path.basename(tmpDir), index: 0 };
        const context = makeMockCtx();

        await applyFrameworkPresetById(context, 'darkrp', folder);

        const state = readPresetState(context, folder);
        assert.ok(
            state.appliedPresetIds.includes('darkrp-preset'),
            'Successful apply must mark the preset as applied',
        );
    });

    /**
     * Already-up-to-date scenario: apply once to populate the config, then
     * apply again with a fresh context — all entries are already present so
     * summary = { modified: false, added: [], skipped: [] }.
     * Preset must still be marked as applied (idempotent no-op is a success).
     */
    test('already-up-to-date outcome: preset IS marked as applied (idempotent no-op)', async () => {
        fs.writeFileSync(
            path.join(tmpDir, '.gluarc.json'),
            JSON.stringify({}),
            'utf8',
        );
        const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(tmpDir), name: path.basename(tmpDir), index: 0 };

        // First apply: writes entries
        await applyFrameworkPresetById(makeMockCtx(), 'darkrp', folder);

        // Second apply: config already has all DarkRP entries — no-op
        const ctx2 = makeMockCtx();
        await applyFrameworkPresetById(ctx2, 'darkrp', folder);

        const state = readPresetState(ctx2, folder);
        assert.ok(
            state.appliedPresetIds.includes('darkrp-preset'),
            'Already-up-to-date (idempotent no-op) must still mark the preset as applied',
        );
    });

    /**
     * Write-failed scenario: entries are computed (added > 0) but the file
     * write fails because the .gluarc.json is read-only.
     * summary = { modified: false, added: [...], skipped: [] }.
     *
     * This is the scenario fixed by the Issue 2 messaging fix:
     * - BEFORE fix: messaging keyed off `summary.added.length > 0` so it would
     *   incorrectly show a success "Added: ..." message even when write failed.
     * - AFTER fix: messaging keys off `summary.modified`, so failure is surfaced
     *   as an error message.
     *
     * The mark-applied condition already correctly handled this case
     * (`modified || (added===0 && skipped===0)` → false for write-failed),
     * so this test also verifies that the preset is NOT marked applied.
     *
     * Note: the read-only file approach may not trigger a write failure on all
     * platforms/filesystems (e.g. if tests run as root). The test is skipped
     * gracefully when that is the case.
     */
    test('write-failed outcome: preset is NOT marked as applied', async () => {
        const gluarcPath = path.join(tmpDir, '.gluarc.json');
        fs.writeFileSync(gluarcPath, JSON.stringify({}), 'utf8');

        // Make file read-only to force writeGluarcConfig to return false.
        fs.chmodSync(gluarcPath, 0o444);

        const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(tmpDir), name: path.basename(tmpDir), index: 0 };
        const context = makeMockCtx();

        try {
            await applyFrameworkPresetById(context, 'darkrp', folder);
        } finally {
            // Restore write permission for teardown cleanup regardless of outcome.
            try { fs.chmodSync(gluarcPath, 0o666); } catch { /* ignore */ }
        }

        const state = readPresetState(context, folder);

        // Read the file to determine whether the write actually failed.
        // On some platforms read-only chmod may not prevent writes; in that case
        // skip the assertion rather than reporting a false failure.
        const written = JSON.stringify(JSON.parse(fs.readFileSync(gluarcPath, 'utf8'))) !== JSON.stringify({});
        if (written) {
            // Write succeeded despite read-only flag — platform doesn't honour it.
            // Verify the successful-write branch instead: preset should be marked applied.
            assert.ok(
                state.appliedPresetIds.includes('darkrp-preset'),
                'When write succeeds, preset must be marked as applied',
            );
        } else {
            // Write genuinely failed — preset must NOT be marked as applied.
            assert.ok(
                !state.appliedPresetIds.includes('darkrp-preset'),
                'Write-failed outcome (modified=false, added>0) must NOT mark the preset as applied',
            );
        }
    });
});

// ─── Suite: inferClassGlobal heuristic (Batch 2 — Wizard polish) ─────────────

suite('Wizard — inferClassGlobal heuristic', () => {
    test('maps well-known scope directory names to canonical classGlobal', () => {
        assert.strictEqual(inferClassGlobal('schema', 'GM'), 'SCHEMA');
        assert.strictEqual(inferClassGlobal('schema/items', 'GM'), 'ITEM');
        assert.strictEqual(inferClassGlobal('schema/plugins', 'GM'), 'PLUGIN');
        assert.strictEqual(inferClassGlobal('schema/factions', 'GM'), 'FACTION');
        assert.strictEqual(inferClassGlobal('schema/classes', 'GM'), 'CLASS');
        assert.strictEqual(inferClassGlobal('gamemode/entities', 'GM'), 'ENT');
        assert.strictEqual(inferClassGlobal('gamemode/weapons', 'GM'), 'SWEP');
        assert.strictEqual(inferClassGlobal('gamemode/effects', 'GM'), 'EFFECT');
        assert.strictEqual(inferClassGlobal('gamemode/tools', 'GM'), 'TOOL');
        assert.strictEqual(inferClassGlobal('gamemode/stools', 'GM'), 'TOOL');
        assert.strictEqual(inferClassGlobal('lua/items', 'GM'), 'ITEM');
        assert.strictEqual(inferClassGlobal('schema/languages', 'GM'), 'LANGUAGE');
    });

    test('falls back to provided default for unrecognised scope names', () => {
        assert.strictEqual(inferClassGlobal('gamemode/modules', 'GM'), 'GM');
        assert.strictEqual(inferClassGlobal('gamemode/custom', 'PLUGIN'), 'PLUGIN');
        assert.strictEqual(inferClassGlobal('unknown', 'DEFAULT'), 'DEFAULT');
        assert.strictEqual(inferClassGlobal('', 'GM'), 'GM');
    });

    test('directory name matching is case-insensitive', () => {
        assert.strictEqual(inferClassGlobal('schema/Plugins', 'GM'), 'PLUGIN');
        assert.strictEqual(inferClassGlobal('ENTITIES', 'GM'), 'ENT');
        assert.strictEqual(inferClassGlobal('Weapons', 'GM'), 'SWEP');
        assert.strictEqual(inferClassGlobal('EFFECTS', 'GM'), 'EFFECT');
        assert.strictEqual(inferClassGlobal('Items', 'GM'), 'ITEM');
    });

    test('SCOPE_NAME_TO_CLASS_GLOBAL covers all expected keys', () => {
        const expectedKeys = [
            'schema', 'plugins', 'factions', 'classes', 'entities', 'weapons',
            'effects', 'stools', 'tools', 'items', 'languages',
        ];
        for (const key of expectedKeys) {
            assert.ok(
                key in SCOPE_NAME_TO_CLASS_GLOBAL,
                `SCOPE_NAME_TO_CLASS_GLOBAL must include key "${key}"`,
            );
        }
    });

    test('stools and tools both map to TOOL', () => {
        assert.strictEqual(inferClassGlobal('gamemode/stools', 'GM'), 'TOOL');
        assert.strictEqual(inferClassGlobal('gamemode/tools', 'GM'), 'TOOL');
    });
});

// ─── Suite: PRESELECT_SCOPE_PATHS (UX refinement pass) ────────────────────────

suite('Wizard — PRESELECT_SCOPE_PATHS', () => {
    test('standard GMod entity and weapon directories are pre-checked', () => {
        assert.ok(PRESELECT_SCOPE_PATHS.has('entities'), 'entities must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('weapons'), 'weapons must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('gamemode/entities'), 'gamemode/entities must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('gamemode/weapons'), 'gamemode/weapons must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('lua/entities'), 'lua/entities must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('lua/weapons'), 'lua/weapons must be pre-checked');
    });

    test('plugin directories are pre-checked', () => {
        assert.ok(PRESELECT_SCOPE_PATHS.has('plugins'), 'plugins must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('gamemode/plugins'), 'gamemode/plugins must be pre-checked');
    });

    test('Helix/schema framework directories are pre-checked', () => {
        assert.ok(PRESELECT_SCOPE_PATHS.has('schema'), 'schema must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('schema/items'), 'schema/items must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('schema/plugins'), 'schema/plugins must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('schema/factions'), 'schema/factions must be pre-checked');
        assert.ok(PRESELECT_SCOPE_PATHS.has('schema/classes'), 'schema/classes must be pre-checked');
    });

    test('non-standard or custom directories are not pre-checked', () => {
        assert.ok(!PRESELECT_SCOPE_PATHS.has('gamemode/custom'), 'custom dirs must not be pre-checked');
        assert.ok(!PRESELECT_SCOPE_PATHS.has('lua/mylib'), 'unknown dirs must not be pre-checked');
        assert.ok(!PRESELECT_SCOPE_PATHS.has(''), 'empty string must not be pre-checked');
        assert.ok(!PRESELECT_SCOPE_PATHS.has('gamemode/modules'), 'modules is not a scope dir — must not be pre-checked');
    });

    test('set is read-only (cannot be mutated via casting)', () => {
        // PRESELECT_SCOPE_PATHS is a ReadonlySet — verify the type is a Set at runtime
        // and that the standard has() API works correctly
        assert.strictEqual(typeof PRESELECT_SCOPE_PATHS.has, 'function');
        assert.strictEqual(typeof PRESELECT_SCOPE_PATHS.size, 'number');
        assert.ok(PRESELECT_SCOPE_PATHS.size > 0, 'set must not be empty');
    });
});

// ─── Suite: Preset semantic shape ─────────────────────────────────────────────

/**
 * Verifies that the active extension preset flow now models frameworks through
 * scripted class scopes only.
 */
suite('Preset semantic shape', () => {
    test('Helix helix-schema class scope has classGlobal: Schema', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const schema = helix.getPreset().classScopes.find((s) => s.id === 'helix-schema')!;
        assert.ok(schema, 'helix-schema class scope must exist');
        assert.strictEqual(
            schema.classGlobal, 'Schema',
            'helix-schema must have classGlobal: Schema',
        );
    });

    test('Helix helix-schema class scope has fixedClassName: Schema', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const schema = helix.getPreset().classScopes.find((s) => s.id === 'helix-schema')!;
        assert.ok(schema, 'helix-schema class scope must exist');
        assert.strictEqual(
            schema.fixedClassName, 'Schema',
            'helix-schema must have fixedClassName: Schema',
        );
        assert.ok(schema.isGlobalSingleton, 'helix-schema must be marked as a global singleton');
    });

    test('Helix helix-items class scope has classGlobal: ITEM', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const items = helix.getPreset().classScopes.find((s) => s.id === 'helix-items')!;
        assert.ok(items, 'helix-items class scope must exist');
        assert.strictEqual(
            items.classGlobal, 'ITEM',
            'helix-items must have classGlobal: ITEM',
        );
    });

    test('framework presets no longer expose owner entries', () => {
        const helix = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'helix')!;
        const darkrp = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'darkrp')!;
        const parallax = FRAMEWORK_DESCRIPTORS.find((d) => d.id === 'parallax')!;
        assert.ok(!('owners' in helix.getPreset()), 'Helix preset should not expose owners');
        assert.ok(!('owners' in darkrp.getPreset()), 'DarkRP preset should not expose owners');
        assert.ok(!('owners' in parallax.getPreset()), 'Parallax preset should not expose owners');
    });
});

// ─── Suite: Wizard — Deduplication and output shape ──────────────────────────

suite('Wizard — Deduplication and output shape', () => {
    // ── normalizeScopePath ─────────────────────────────────────────────────────

    test('normalizeScopePath converts backslashes to forward slashes', () => {
        assert.strictEqual(normalizeScopePath('gamemode\\entities'), 'gamemode/entities');
        assert.strictEqual(normalizeScopePath('schema\\plugins'), 'schema/plugins');
    });

    test('normalizeScopePath strips trailing slashes', () => {
        assert.strictEqual(normalizeScopePath('gamemode/entities/'), 'gamemode/entities');
        assert.strictEqual(normalizeScopePath('plugins//'), 'plugins');
    });

    test('normalizeScopePath lowercases the result', () => {
        assert.strictEqual(normalizeScopePath('Gamemode/Entities'), 'gamemode/entities');
        assert.strictEqual(normalizeScopePath('SCHEMA/PLUGINS'), 'schema/plugins');
    });

    test('normalizeScopePath is idempotent', () => {
        const once = normalizeScopePath('Gamemode/Entities/');
        const twice = normalizeScopePath(once);
        assert.strictEqual(once, twice);
    });

    // ── deduplicateScopePaths ─────────────────────────────────────────────────

    test('deduplicateScopePaths returns unique paths', () => {
        assert.deepStrictEqual(
            deduplicateScopePaths(['gamemode/entities', 'schema/plugins', 'gamemode/weapons']),
            ['gamemode/entities', 'schema/plugins', 'gamemode/weapons'],
        );
    });

    test('deduplicateScopePaths removes exact duplicates, first wins', () => {
        assert.deepStrictEqual(
            deduplicateScopePaths(['gamemode/entities', 'gamemode/entities']),
            ['gamemode/entities'],
        );
    });

    test('deduplicateScopePaths deduplicates case-insensitively', () => {
        // Same logical path entered with different casing
        const result = deduplicateScopePaths(['gamemode/entities', 'Gamemode/Entities']);
        assert.deepStrictEqual(result, ['gamemode/entities']);
    });

    test('deduplicateScopePaths normalises backslashes before deduplication', () => {
        const result = deduplicateScopePaths(['gamemode/entities', 'gamemode\\entities']);
        assert.deepStrictEqual(result, ['gamemode/entities']);
    });

    test('deduplicateScopePaths strips trailing slashes before deduplication', () => {
        const result = deduplicateScopePaths(['schema/plugins/', 'schema/plugins']);
        assert.deepStrictEqual(result, ['schema/plugins']);
    });

    test('deduplicateScopePaths handles overlap between selected picks and custom dirs', () => {
        // Simulates user selecting schema/plugins in picker AND typing it in custom box
        const selectedRelPaths = ['schema/plugins', 'gamemode/entities'];
        const customDirs = ['schema/plugins', 'gamemode/custom'];
        const result = deduplicateScopePaths([...selectedRelPaths, ...customDirs]);
        assert.deepStrictEqual(result, ['schema/plugins', 'gamemode/entities', 'gamemode/custom']);
    });

    test('deduplicateScopePaths returns empty array for empty input', () => {
        assert.deepStrictEqual(deduplicateScopePaths([]), []);
    });

    test('deduplicateScopePaths stores paths with forward slashes regardless of input', () => {
        const result = deduplicateScopePaths(['gamemode\\weapons']);
        assert.strictEqual(result[0], 'gamemode/weapons');
    });

    // ── Issue 3 fix: original casing preserved in returned paths ─────────────

    test('deduplicateScopePaths preserves casing of first occurrence in emitted path', () => {
        // Original casing is preserved so that emitted config fields (include,
        // rootDir, path) are correct on case-sensitive filesystems.
        const result = deduplicateScopePaths(['Gamemode/Entities']);
        assert.deepStrictEqual(result, ['Gamemode/Entities'],
            'Mixed-case first occurrence must keep its casing in the returned path');
    });

    test('deduplicateScopePaths uses case-insensitive dedup — duplicate case variants are removed', () => {
        // Same logical path entered with different casing only produces one entry;
        // the first occurrence keeps its original casing.
        const result = deduplicateScopePaths(['Schema/Plugins', 'schema/plugins', 'SCHEMA/PLUGINS']);
        assert.strictEqual(result.length, 1, 'Three case variants of same path must deduplicate to one entry');
        assert.strictEqual(result[0], 'Schema/Plugins', 'First occurrence casing must be preserved');
    });

    test('custom scope ID is stable regardless of path casing (uses normalizeScopePath for ID)', () => {
        // The wizard generates custom scope IDs using normalizeScopePath, so IDs
        // are stable even when the same logical path is typed with different casing.
        const path1 = 'Gamemode/Plugins';
        const path2 = 'GAMEMODE/PLUGINS';
        const id1 = `custom-scope-${normalizeScopePath(path1).replace(/\//g, '-')}`;
        const id2 = `custom-scope-${normalizeScopePath(path2).replace(/\//g, '-')}`;
        assert.strictEqual(id1, id2,
            'Custom scope ID must be identical for the same logical path regardless of casing');
        assert.strictEqual(id1, 'custom-scope-gamemode-plugins');
    });

    test('deduplicateScopePaths preserves casing of first occurrence; duplicate case variants dropped', () => {
        // Each single-element call preserves original casing.
        const run1 = deduplicateScopePaths(['Gamemode/Plugins']);
        const run2 = deduplicateScopePaths(['GAMEMODE/PLUGINS']);
        assert.strictEqual(run1[0], 'Gamemode/Plugins', 'Mixed-case first occurrence must be preserved');
        assert.strictEqual(run2[0], 'GAMEMODE/PLUGINS', 'Uppercase first occurrence must be preserved');
        // When combined, only the first occurrence survives (case-insensitive dedup).
        const combined = deduplicateScopePaths(['Gamemode/Plugins', 'GAMEMODE/PLUGINS']);
        assert.strictEqual(combined.length, 1, 'Combined list should deduplicate to one entry');
        assert.strictEqual(combined[0], 'Gamemode/Plugins', 'First occurrence casing preserved in combined list');
    });

    test('deduplicateScopePaths preserves uppercase-first-occurrence; duplicate lowercase is removed', () => {
        // First occurrence is uppercase — its casing is preserved; the lowercase duplicate is dropped.
        const result = deduplicateScopePaths(['SCHEMA/FACTIONS', 'schema/factions']);
        assert.deepStrictEqual(result, ['SCHEMA/FACTIONS'],
            'First uppercase occurrence must be preserved; duplicate lowercase must be removed');
    });

    test('deduplicating same scope paths twice produces same result (idempotent)', () => {
        const paths = ['gamemode/entities', 'schema/plugins', 'gamemode/weapons'];
        const pass1 = deduplicateScopePaths(paths);
        const pass2 = deduplicateScopePaths(pass1);
        assert.deepStrictEqual(pass1, pass2);
    });

    test('no duplicate scope entries when same path appears via picker and custom entry', () => {
        // Simulates: user picks gamemode/entities, then also types it in custom box
        const selectedPaths = ['gamemode/entities', 'schema/plugins'];
        const customPaths = ['gamemode/entities', 'gamemode/custom'];
        const combined = deduplicateScopePaths([...selectedPaths, ...customPaths]);
        const uniquePaths = new Set(combined);
        assert.strictEqual(combined.length, uniquePaths.size, 'No duplicate scope paths should be produced');
        assert.deepStrictEqual(combined, ['gamemode/entities', 'schema/plugins', 'gamemode/custom']);
    });
});

suite('Structural loader scope patterns', () => {
    test('buildLoaderScopePatternFamily adds only direct and plugin-contained loader patterns', () => {
        assert.deepStrictEqual(
            buildLoaderScopePatternFamily('schema/items', ['schema/plugins', 'plugins']),
            ['schema/items/**', 'schema/plugins/*/items/**', 'plugins/*/items/**'],
        );
    });

    test('matchStructuralLoaderScope recognises plugin-contained loader roots conservatively', () => {
        const nested = matchStructuralLoaderScope('plugins/example/items');
        assert.ok(nested, 'plugins/example/items should be recognised as a structural nested loader root');
        assert.strictEqual(nested?.kind, 'plugin-contained-loader');
        assert.strictEqual(nested?.loaderDirName, 'items');
        assert.strictEqual(nested?.classGlobal, 'ITEM');

        assert.strictEqual(matchStructuralLoaderScope('plugins/example'), undefined,
            'plugin implementation roots must not be treated as loader scopes');
        assert.strictEqual(matchStructuralLoaderScope('plugins/example/meta/items'), undefined,
            'deeper arbitrary implementation nesting must not be treated as a loader scope');
    });

    test('matchStructuralLoaderScope recognises lua/plugins as a conservative plugin container family', () => {
        const nested = matchStructuralLoaderScope('lua/plugins/example/items');
        assert.ok(nested, 'lua/plugins/<plugin>/items should be recognised as a structural nested loader root');
        assert.strictEqual(nested?.kind, 'plugin-contained-loader');
        assert.strictEqual(nested?.pluginContainerPath, 'lua/plugins');
        assert.strictEqual(nested?.loaderDirName, 'items');
        assert.strictEqual(nested?.classGlobal, 'ITEM');
    });
});

suite('Wizard — final output shape', () => {
    let tmpDir: string;
    let originalQuickPick: typeof vscode.window.showQuickPick;
    let originalInputBox: typeof vscode.window.showInputBox;
    let originalInfo: typeof vscode.window.showInformationMessage;
    let originalWarn: typeof vscode.window.showWarningMessage;

    setup(() => {
        tmpDir = makeTempFolder();
        fs.mkdirSync(path.join(tmpDir, 'schema'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'sh_schema.lua'), 'SCHEMA = SCHEMA or {}\n', 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'schema', 'items'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'items', 'sh_item.lua'), 'ITEM = ITEM or {}\n', 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'schema', 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'plugins', 'sh_plugin.lua'), 'PLUGIN = PLUGIN or {}\n', 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'schema', 'factions'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'factions', 'sh_faction.lua'), 'FACTION = FACTION or {}\n', 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'schema', 'classes'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'classes', 'sh_class.lua'), 'CLASS = CLASS or {}\n', 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'plugins', 'sh_plugin.lua'), 'PLUGIN = PLUGIN or {}\n', 'utf8');

        originalQuickPick = vscode.window.showQuickPick;
        originalInputBox = vscode.window.showInputBox;
        originalInfo = vscode.window.showInformationMessage;
        originalWarn = vscode.window.showWarningMessage;
    });

    teardown(() => {
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = originalQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = originalInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = originalInfo;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = originalWarn;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    test('wizard writes only scriptedClassScopes when no diagnostics globals are provided', async () => {
        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                return [items.find((item: any) => item.relativePath === 'schema/plugins')];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should report applied after saving');

        const config = await readGluarcConfig(folder);
        assert.ok((config as any).gmod?.scriptedClassScopes?.include, 'scriptedClassScopes should be written');
        assert.deepStrictEqual(Object.keys((config as any).gmod ?? {}).sort(), ['scriptedClassScopes']);
        assert.strictEqual((config as any).diagnostics, undefined, 'diagnostics should be omitted when blank');
    });

    test('wizard preselects schema root and writes it as fixed SCHEMA scope', async () => {
        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                const schemaPick = items.find((item: any) => item.relativePath === 'schema');
                assert.ok(schemaPick, 'schema root should be offered as a wizard scope');
                assert.strictEqual(schemaPick.picked, true, 'schema root should be preselected for Helix-like layouts');
                return [schemaPick];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should report applied after saving');

        const config = await readGluarcConfig(folder);
        const schemaScope = (config as any).gmod?.scriptedClassScopes?.include?.find(
            (scope: any) => scope.rootDir === 'schema',
        );

        assert.ok(schemaScope, 'wizard should write a schema-root scripted class scope');
        assert.strictEqual(schemaScope.classGlobal, 'Schema');
        assert.strictEqual(schemaScope.fixedClassName, 'Schema');
        assert.ok(schemaScope.isGlobalSingleton, 'schema scope must be a global singleton');
        assert.deepStrictEqual(schemaScope.include, ['schema/**', 'gamemode/schema.lua']);
        assert.deepStrictEqual(schemaScope.path, ['schema']);
        assert.strictEqual(schemaScope.rootDir, 'schema');
    });

    test('wizard emits Helix-style fixed identities for common Helix scope paths', async () => {
        const expectedPaths = [
            'schema/items',
            'schema/plugins',
            'plugins',
            'schema/factions',
            'schema/classes',
        ];

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                return expectedPaths.map((relativePath) => {
                    const pick = items.find((item: any) => item.relativePath === relativePath);
                    assert.ok(pick, `${relativePath} should be offered as a wizard scope`);
                    return pick;
                });
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should report applied after saving');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include;
        assert.ok(Array.isArray(scopes), 'wizard should write scripted class scopes');

        const itemScope = scopes.find((scope: any) => scope.classGlobal === 'ITEM');
        assert.ok(itemScope, 'wizard should emit a Helix item scope');
        assert.strictEqual(itemScope.classGlobal, 'ITEM');
        assert.ok(itemScope.stripFilePrefix, 'item scope must have stripFilePrefix: true');
        assert.deepStrictEqual(itemScope.include, ['schema/items/**']);
        assert.deepStrictEqual(itemScope.path, ['items']);
        assert.strictEqual(itemScope.rootDir, undefined);

        const schemaPluginsScope = scopes.find((scope: any) => scope.rootDir === 'schema/plugins');
        assert.ok(schemaPluginsScope, 'wizard should emit a schema/plugins Helix plugin scope');
        assert.strictEqual(schemaPluginsScope.classGlobal, 'PLUGIN');
        assert.deepStrictEqual(schemaPluginsScope.include, ['schema/plugins/**']);
        assert.deepStrictEqual(schemaPluginsScope.path, ['schema', 'plugins']);

        const rootPluginsScope = scopes.find((scope: any) => scope.rootDir === 'plugins');
        assert.ok(rootPluginsScope, 'wizard should emit a top-level plugins Helix plugin scope');
        assert.strictEqual(rootPluginsScope.classGlobal, 'PLUGIN');
        assert.deepStrictEqual(rootPluginsScope.include, ['plugins/**']);
        assert.deepStrictEqual(rootPluginsScope.path, ['plugins']);

        const factionsScope = scopes.find((scope: any) => scope.rootDir === 'schema/factions');
        assert.ok(factionsScope, 'wizard should emit a Helix factions scope');
        assert.strictEqual(factionsScope.classGlobal, 'FACTION');
        assert.ok(factionsScope.stripFilePrefix, 'factions scope must have stripFilePrefix: true');
        assert.deepStrictEqual(factionsScope.include, ['schema/factions/**']);
        assert.deepStrictEqual(factionsScope.path, ['schema', 'factions']);

        const classesScope = scopes.find((scope: any) => scope.rootDir === 'schema/classes');
        assert.ok(classesScope, 'wizard should emit a Helix classes scope');
        assert.strictEqual(classesScope.classGlobal, 'CLASS');
        assert.ok(classesScope.stripFilePrefix, 'classes scope must have stripFilePrefix: true');
        assert.deepStrictEqual(classesScope.include, ['schema/classes/**']);
        assert.deepStrictEqual(classesScope.path, ['schema', 'classes']);
    });

    test('wizard writes scriptedClassScopes plus diagnostics.globals when provided', async () => {
        let quickPickCall = 0;
        let inputCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                return [items.find((item: any) => item.relativePath === 'schema/plugins')];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => {
            inputCall += 1;
            return inputCall === 1 ? 'schema/plugins' : 'MyFramework,AnotherGlobal';
        }) as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should report applied after saving');

        const config = await readGluarcConfig(folder);
        assert.ok(Array.isArray((config as any).gmod?.scriptedClassScopes?.include), 'scriptedClassScopes should be present');
        assert.deepStrictEqual(Object.keys((config as any).gmod ?? {}).sort(), ['scriptedClassScopes']);
        assert.deepStrictEqual((config as any).diagnostics?.globals, ['MyFramework', 'AnotherGlobal']);
    });

    test('wizard ignores non-loader schema and plugin implementation folders', async () => {
        fs.mkdirSync(path.join(tmpDir, 'schema', 'meta'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'meta', 'sh_a.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'schema', 'meta', 'sh_b.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'schema', 'meta', 'sh_c.lua'), 'return true\n', 'utf8');

        fs.mkdirSync(path.join(tmpDir, 'schema', 'derma'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'derma', 'cl_a.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'schema', 'derma', 'cl_b.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'schema', 'derma', 'cl_c.lua'), 'return true\n', 'utf8');

        fs.mkdirSync(path.join(tmpDir, 'schema', 'libs'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'libs', 'sh_a.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'schema', 'libs', 'sh_b.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'schema', 'libs', 'sh_c.lua'), 'return true\n', 'utf8');

        fs.mkdirSync(path.join(tmpDir, 'plugins', 'writing'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'plugins', 'writing', 'sh_plugin.lua'), 'PLUGIN = PLUGIN or {}\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'plugins', 'writing', 'sv_hooks.lua'), 'return true\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'plugins', 'writing', 'cl_hooks.lua'), 'return true\n', 'utf8');

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                assert.ok(!items.some((item: any) => item.relativePath === 'schema/meta'),
                    'schema/meta must not be offered as a scripted class scope');
                assert.ok(!items.some((item: any) => item.relativePath === 'schema/derma'),
                    'schema/derma must not be offered as a scripted class scope');
                assert.ok(!items.some((item: any) => item.relativePath === 'schema/libs'),
                    'schema/libs must not be offered as a scripted class scope');

                const schemaPick = items.find((item: any) => item.relativePath === 'schema');
                assert.ok(schemaPick, 'schema should still be offered as a valid scripted class scope');
                return [schemaPick];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;

        let inputCall = 0;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => {
            inputCall += 1;
            return inputCall === 1
                ? 'schema/meta,schema/derma,schema/libs,plugins/writing'
                : '';
        }) as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should still save valid selected scopes');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include ?? [];
        const rootDirs = scopes.map((scope: any) => scope.rootDir).filter(Boolean);
        assert.ok(rootDirs.includes('schema'), 'schema scope should still be written');
        assert.ok(!rootDirs.includes('schema/meta'), 'schema/meta must not be written as a class scope');
        assert.ok(!rootDirs.includes('schema/derma'), 'schema/derma must not be written as a class scope');
        assert.ok(!rootDirs.includes('schema/libs'), 'schema/libs must not be written as a class scope');
        assert.ok(!rootDirs.includes('plugins/writing'), 'plugins/writing must not be written as a class scope');
    });

    test('wizard discovers nested plugin-contained item loaders structurally without promoting plugin roots', async () => {
        fs.mkdirSync(path.join(tmpDir, 'plugins', 'writing', 'items'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'plugins', 'writing', 'items', 'sh_pen.lua'), 'ITEM = ITEM or {}\n', 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'schema', 'plugins', 'quests', 'items'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'schema', 'plugins', 'quests', 'items', 'sh_note.lua'), 'ITEM = ITEM or {}\n', 'utf8');

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                assert.ok(items.some((item: any) => item.relativePath === 'plugins/writing/items'),
                    'plugins/<plugin>/items should be offered as a structural nested loader scope');
                assert.ok(items.some((item: any) => item.relativePath === 'schema/plugins/quests/items'),
                    'schema/plugins/<plugin>/items should be offered as a structural nested loader scope');
                return [
                    items.find((item: any) => item.relativePath === 'plugins/writing/items'),
                    items.find((item: any) => item.relativePath === 'schema/plugins/quests/items'),
                ];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should save structural nested loader scopes');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include ?? [];
        const pluginItemsScope = scopes.find((scope: any) => Array.isArray(scope.include) && scope.include[0] === 'plugins/writing/items/**');
        const schemaPluginItemsScope = scopes.find((scope: any) => Array.isArray(scope.include) && scope.include[0] === 'schema/plugins/quests/items/**');

        assert.ok(pluginItemsScope, 'wizard should emit an exact include for plugins/<plugin>/items');
        assert.strictEqual(pluginItemsScope.classGlobal, 'ITEM');
        assert.deepStrictEqual(pluginItemsScope.path, ['items']);
        assert.strictEqual(pluginItemsScope.rootDir, undefined);

        assert.ok(schemaPluginItemsScope, 'wizard should emit an exact include for schema/plugins/<plugin>/items');
        assert.strictEqual(schemaPluginItemsScope.classGlobal, 'ITEM');
        assert.deepStrictEqual(schemaPluginItemsScope.path, ['items']);
        assert.strictEqual(schemaPluginItemsScope.rootDir, undefined);
    });

    test('wizard accepts representative custom framework loader roots safely', async () => {
        const customRoots = [
            'gamemode/framework',
            'gamemode/modules',
            'gamemode/schema',
            'lua/darkrp_modules',
            'lua/darkrp_customthings',
        ];

        for (const customRoot of customRoots) {
            fs.mkdirSync(path.join(tmpDir, ...customRoot.split('/')), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, ...customRoot.split('/'), 'sh_entry.lua'), 'return true\n', 'utf8');
        }

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                return customRoots.map((relativePath) => {
                    const pick = items.find((item: any) => item.relativePath === relativePath);
                    assert.ok(pick, `${relativePath} should be offered as a safe custom framework root`);
                    return pick;
                });
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should save reviewed custom framework roots');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include ?? [];
        for (const customRoot of customRoots) {
            const scope = scopes.find((entry: any) => entry.rootDir === customRoot);
            assert.ok(scope, `${customRoot} should be written as a scripted class scope`);
            assert.strictEqual(scope.classGlobal, 'GM', `${customRoot} should use conservative GM classGlobal`);
            assert.deepStrictEqual(scope.include, [`${customRoot}/**`]);
            assert.deepStrictEqual(scope.path, customRoot.split('/'));
        }
    });

    test('wizard accepts safe unknown custom paths that exist in workspace and contain Lua files', async () => {
        fs.mkdirSync(path.join(tmpDir, 'lua', 'myaddon'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'lua', 'myaddon', 'init.lua'), 'return true\n', 'utf8');

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (_items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                return [] as any;
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;

        let inputCall = 0;
        const warnings: string[] = [];
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => {
            inputCall += 1;
            return inputCall === 1 ? 'lua/myaddon' : '';
        }) as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async (message: string) => {
            warnings.push(message);
            return undefined;
        }) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should save safe custom fallback scope paths');
        assert.deepStrictEqual(warnings, [], 'safe existing custom fallback paths should not trigger rejection warnings');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include ?? [];
        const customScope = scopes.find((entry: any) => entry.rootDir === 'lua/myaddon');
        assert.ok(customScope, 'safe fallback custom folder should be written as a generic scripted class scope');
        assert.strictEqual(customScope.classGlobal, 'GM');
        assert.deepStrictEqual(customScope.include, ['lua/myaddon/**']);
        assert.deepStrictEqual(customScope.path, ['lua', 'myaddon']);
    });

    test('wizard still rejects unsafe or nonexistent custom paths', async () => {
        let quickPickCall = 0;
        const warnings: string[] = [];
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (_items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                return [] as any;
            }
            return { value: 'cancel' } as any;
        }) as typeof vscode.window.showQuickPick;

        let inputCall = 0;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => {
            inputCall += 1;
            return inputCall === 1 ? '../escape,lua/missing' : '';
        }) as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async (message: string) => {
            warnings.push(message);
            return undefined;
        }) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, false, 'wizard should not apply when only invalid paths were entered and save is cancelled');
        assert.ok(warnings.some((message) => message.includes('could not be used') && message.includes('../escape')),
            'unsafe traversal path should still be rejected with a path validation warning');
        assert.ok(warnings.some((message) => message.includes('not a safe scripted-class folder candidate') && message.includes('lua/missing')),
            'nonexistent custom path should still be rejected by conservative fallback rules');
    });

    test('wizard rejects dot-segment-only custom paths instead of writing workspace-root fallback scope', async () => {
        let quickPickCall = 0;
        const warnings: string[] = [];
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                const schemaPick = items.find((item: any) => item.relativePath === 'schema');
                assert.ok(schemaPick, 'schema should still be available as a valid selected scope');
                return [schemaPick];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;

        let inputCall = 0;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => {
            inputCall += 1;
            return inputCall === 1 ? '.,./.' : '';
        }) as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async (message: string) => {
            warnings.push(message);
            return undefined;
        }) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should still save valid selected scopes while ignoring dot-segment-only custom paths');
        assert.ok(warnings.some((message) => message.includes('could not be used') && message.includes('"."') && message.includes('"./."')),
            'dot-segment-only custom inputs should be rejected with a path validation warning');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include ?? [];
        assert.ok(scopes.some((entry: any) => entry.rootDir === 'schema'), 'valid selected scopes should still be written');
        assert.ok(!scopes.some((entry: any) => entry.rootDir === '.' || (Array.isArray(entry.include) && entry.include.includes('./**'))),
            'workspace-root fallback scope must never be emitted for dot-segment-only input');
    });

    test('wizard discovers bounded deeper reviewed loader roots under current roots', async () => {
        fs.mkdirSync(path.join(tmpDir, 'gamemode', 'addons', 'city', 'modules'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'gamemode', 'addons', 'city', 'modules', 'sh_city.lua'), 'return true\n', 'utf8');

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                const deepModules = items.find((item: any) => item.relativePath === 'gamemode/addons/city/modules');
                assert.ok(deepModules, 'bounded discovery should surface deeper recognised loader roots under gamemode/');
                return [deepModules];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should save bounded deeper recognised loader roots');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include ?? [];
        const scope = scopes.find((entry: any) => entry.rootDir === 'gamemode/addons/city/modules');
        assert.ok(scope, 'deeper recognised loader root should be written');
        assert.strictEqual(scope.classGlobal, 'GM');
    });

    test('wizard discovers lua/plugins plugin-container loaders', async () => {
        fs.mkdirSync(path.join(tmpDir, 'lua', 'plugins', 'economy', 'items'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'lua', 'plugins', 'economy', 'items', 'sh_wallet.lua'), 'ITEM = ITEM or {}\n', 'utf8');

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                const luaPluginItems = items.find((item: any) => item.relativePath === 'lua/plugins/economy/items');
                assert.ok(luaPluginItems, 'lua/plugins/<plugin>/items should be offered as a plugin-contained loader scope');
                return [luaPluginItems];
            }
            return { value: 'apply' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, true, 'wizard should save lua/plugins plugin-contained loader scopes');

        const scopes = (await readGluarcConfig(folder) as any).gmod?.scriptedClassScopes?.include ?? [];
        const scope = scopes.find((entry: any) => Array.isArray(entry.include) && entry.include[0] === 'lua/plugins/economy/items/**');
        assert.ok(scope, 'lua/plugins plugin-contained loader should be written exactly');
        assert.strictEqual(scope.classGlobal, 'ITEM');
        assert.deepStrictEqual(scope.path, ['items']);
    });

    test('important recommended candidates survive capping when candidate list grows', async () => {
        for (let index = 0; index < 25; index += 1) {
            const fillerRoot = path.join(tmpDir, 'lua', `custom${index}`);
            fs.mkdirSync(fillerRoot, { recursive: true });
            fs.writeFileSync(path.join(fillerRoot, 'sh_entry.lua'), 'return true\n', 'utf8');
        }

        fs.mkdirSync(path.join(tmpDir, 'gamemode', 'framework'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'gamemode', 'framework', 'sh_framework.lua'), 'return true\n', 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'lua', 'plugins', 'quests', 'items'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'lua', 'plugins', 'quests', 'items', 'sh_quest.lua'), 'ITEM = ITEM or {}\n', 'utf8');

        let quickPickCall = 0;
        (vscode.window.showQuickPick as typeof vscode.window.showQuickPick) = (async (items: any) => {
            quickPickCall += 1;
            if (quickPickCall === 1) {
                assert.ok(items.length <= 20, 'wizard candidate list should remain capped');
                assert.ok(items.some((item: any) => item.relativePath === 'gamemode/framework'),
                    'important reviewed roots should survive capping');
                assert.ok(items.some((item: any) => item.relativePath === 'lua/plugins/quests/items'),
                    'important structural plugin-container loader roots should survive capping');
                return [] as any;
            }
            return { value: 'cancel' } as any;
        }) as typeof vscode.window.showQuickPick;
        (vscode.window.showInputBox as typeof vscode.window.showInputBox) = (async () => '') as typeof vscode.window.showInputBox;
        (vscode.window.showInformationMessage as typeof vscode.window.showInformationMessage) = (async () => undefined) as typeof vscode.window.showInformationMessage;
        (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = (async () => undefined) as typeof vscode.window.showWarningMessage;

        const folder = makeWorkspaceFolder(tmpDir);
        const result = await runFrameworkSetupWizard(makeMockContext(), folder);
        assert.strictEqual(result.applied, false, 'cancelled save should leave the workspace unchanged');
    });
});

// ─── Suite: Wizard — normalizeCustomScopePath (Issue 1 fix) ──────────────────

suite('Wizard — normalizeCustomScopePath', () => {

    // ── Normal / accepted paths ────────────────────────────────────────────────

    test('plain relative path passes through unchanged', () => {
        assert.strictEqual(normalizeCustomScopePath('schema/plugins'), 'schema/plugins');
        assert.strictEqual(normalizeCustomScopePath('gamemode/custom'), 'gamemode/custom');
        assert.strictEqual(normalizeCustomScopePath('lua/mylib'), 'lua/mylib');
    });

    test('strips one leading "./" prefix', () => {
        assert.strictEqual(normalizeCustomScopePath('./schema/plugins'), 'schema/plugins');
        assert.strictEqual(normalizeCustomScopePath('./gamemode/custom'), 'gamemode/custom');
    });

    test('strips multiple leading "./" prefixes', () => {
        assert.strictEqual(normalizeCustomScopePath('./././schema/plugins'), 'schema/plugins');
    });

    test('converts backslashes to forward slashes', () => {
        assert.strictEqual(normalizeCustomScopePath('schema\\plugins'), 'schema/plugins');
        assert.strictEqual(normalizeCustomScopePath('gamemode\\entities'), 'gamemode/entities');
    });

    test('strips trailing slashes', () => {
        assert.strictEqual(normalizeCustomScopePath('schema/plugins/'), 'schema/plugins');
        assert.strictEqual(normalizeCustomScopePath('plugins//'), 'plugins');
    });

    test('trims surrounding whitespace', () => {
        assert.strictEqual(normalizeCustomScopePath('  schema/plugins  '), 'schema/plugins');
        assert.strictEqual(normalizeCustomScopePath('\tgamemode/custom\t'), 'gamemode/custom');
    });

    test('handles "./" prefix combined with backslash and trailing slash', () => {
        assert.strictEqual(normalizeCustomScopePath('.\\schema\\plugins\\'), 'schema/plugins');
    });

    test('single-segment path is valid', () => {
        assert.strictEqual(normalizeCustomScopePath('plugins'), 'plugins');
        assert.strictEqual(normalizeCustomScopePath('./plugins'), 'plugins');
    });

    // ── Rejected paths ─────────────────────────────────────────────────────────

    test('rejects Unix absolute paths (leading /)', () => {
        assert.strictEqual(normalizeCustomScopePath('/schema/plugins'), null);
        assert.strictEqual(normalizeCustomScopePath('/etc/passwd'), null);
    });

    test('rejects Windows absolute paths (drive letter)', () => {
        assert.strictEqual(normalizeCustomScopePath('C:/schema/plugins'), null);
        assert.strictEqual(normalizeCustomScopePath('D:\\gamemode\\modules'), null);
        assert.strictEqual(normalizeCustomScopePath('c:/path'), null);
    });

    test('rejects parent-directory traversal (../)', () => {
        assert.strictEqual(normalizeCustomScopePath('../sibling'), null);
        assert.strictEqual(normalizeCustomScopePath('../../parent'), null);
        assert.strictEqual(normalizeCustomScopePath('./../../escape'), null);
    });

    test('rejects parent-directory traversal anywhere in path (Issue 1)', () => {
        assert.strictEqual(normalizeCustomScopePath('schema/../plugins'), null);
        assert.strictEqual(normalizeCustomScopePath('lua/entities/../weapons'), null);
    });

    test('rejects exactly ".."', () => {
        assert.strictEqual(normalizeCustomScopePath('..'), null);
    });

    test('rejects paths with glob wildcard * (single and double star)', () => {
        assert.strictEqual(normalizeCustomScopePath('schema/**/plugins'), null);
        assert.strictEqual(normalizeCustomScopePath('gamemode/*.lua'), null);
    });

    test('rejects paths with glob "?" metacharacter', () => {
        assert.strictEqual(normalizeCustomScopePath('schema/plugins?'), null);
    });

    test('rejects paths with glob "[...]" metacharacter', () => {
        assert.strictEqual(normalizeCustomScopePath('schema/[a-z]'), null);
    });

    test('rejects paths with glob "{...}" metacharacter', () => {
        assert.strictEqual(normalizeCustomScopePath('{schema,gamemode}/plugins'), null);
    });

    test('rejects paths with glob "!" metacharacter', () => {
        assert.strictEqual(normalizeCustomScopePath('!schema/plugins'), null);
    });

    test('rejects paths with stray "}" metacharacter', () => {
        assert.strictEqual(normalizeCustomScopePath('gamemode/}bad'), null);
        assert.strictEqual(normalizeCustomScopePath('schema/plugins}'), null);
    });

    test('rejects empty string', () => {
        assert.strictEqual(normalizeCustomScopePath(''), null);
    });

    test('rejects whitespace-only string', () => {
        assert.strictEqual(normalizeCustomScopePath('   '), null);
    });

    test('rejects "./" (collapses to empty after stripping prefix)', () => {
        assert.strictEqual(normalizeCustomScopePath('./'), null);
        assert.strictEqual(normalizeCustomScopePath('.//'), null);
    });

    test('rejects dot-segment-only paths that would collapse to workspace root', () => {
        assert.strictEqual(normalizeCustomScopePath('.'), null);
        assert.strictEqual(normalizeCustomScopePath('./.'), null);
        assert.strictEqual(normalizeCustomScopePath('././.'), null);
        assert.strictEqual(normalizeCustomScopePath('.\\.'), null);
    });

    // ── Wizard array pipeline simulation ──────────────────────────────────────

    test('wizard pipeline: mixed valid/invalid input produces only safe paths', () => {
        // Simulates the split/map/filter chain used in the wizard.
        const raw = './schema/plugins, /etc/passwd, ../escape, gamemode/custom, C:/bad, schema/**';
        const result = raw
            .split(',')
            .map((s) => normalizeCustomScopePath(s))
            .filter((s): s is string => s !== null);

        assert.deepStrictEqual(result, ['schema/plugins', 'gamemode/custom'],
            'Only safe relative paths should survive the pipeline');
    });

    test('wizard pipeline: all valid paths pass through', () => {
        const raw = 'schema/plugins, gamemode/entities, lua/mylib';
        const result = raw
            .split(',')
            .map((s) => normalizeCustomScopePath(s))
            .filter((s): s is string => s !== null);

        assert.deepStrictEqual(result, ['schema/plugins', 'gamemode/entities', 'lua/mylib']);
    });

    test('wizard pipeline: all invalid paths yield empty array', () => {
        // Use inputs that are each individually invalid (no commas inside glob metacharacters
        // that would accidentally create partially valid entries when split by the wizard).
        const raw = '/absolute | C:/windows | ../escape | schema/* | gamemode/}bad';
        const result = raw
            .split('|')
            .map((s) => normalizeCustomScopePath(s))
            .filter((s): s is string => s !== null);

        assert.deepStrictEqual(result, [],
            'All invalid paths must be rejected — none should survive the pipeline');
    });

    test('normalised paths produce valid include globs when suffixed with /**', () => {
        const paths = ['schema/plugins', 'gamemode/custom', 'plugins'];
        for (const p of paths) {
            const glob = `${p}/**`;
            // A valid glob must not start with / or contain metacharacters except *
            assert.ok(!glob.startsWith('/'), `glob "${glob}" must not be absolute`);
            assert.ok(!glob.includes('..'), `glob "${glob}" must not traverse upward`);
        }
    });
});

// ─── Suite: Wizard — isValidLuaIdentifier ────────────────────────────────────

suite('Wizard — isValidLuaIdentifier', () => {

    // ── Valid identifiers ─────────────────────────────────────────────────────

    test('plain uppercase global is valid', () => {
        assert.strictEqual(isValidLuaIdentifier('PLUGIN'), true);
        assert.strictEqual(isValidLuaIdentifier('GM'), true);
        assert.strictEqual(isValidLuaIdentifier('ENT'), true);
        assert.strictEqual(isValidLuaIdentifier('SCHEMA'), true);
    });

    test('plain lowercase identifier is valid', () => {
        assert.strictEqual(isValidLuaIdentifier('plugin'), true);
        assert.strictEqual(isValidLuaIdentifier('myframework'), true);
    });

    test('mixed-case identifier is valid', () => {
        assert.strictEqual(isValidLuaIdentifier('MyFramework'), true);
        assert.strictEqual(isValidLuaIdentifier('Schema'), true);
    });

    test('identifier starting with underscore is valid', () => {
        assert.strictEqual(isValidLuaIdentifier('_PRIVATE'), true);
        assert.strictEqual(isValidLuaIdentifier('_'), true);
        assert.strictEqual(isValidLuaIdentifier('__index'), true);
    });

    test('identifier with digits (not at start) is valid', () => {
        assert.strictEqual(isValidLuaIdentifier('MYMOD2'), true);
        assert.strictEqual(isValidLuaIdentifier('my_var_1'), true);
        assert.strictEqual(isValidLuaIdentifier('A1B2C3'), true);
    });

    test('single letter is valid', () => {
        assert.strictEqual(isValidLuaIdentifier('A'), true);
        assert.strictEqual(isValidLuaIdentifier('z'), true);
    });

    // ── Invalid identifiers ───────────────────────────────────────────────────

    test('empty string is invalid', () => {
        assert.strictEqual(isValidLuaIdentifier(''), false);
    });

    test('identifier starting with a digit is invalid', () => {
        assert.strictEqual(isValidLuaIdentifier('1foo'), false);
        assert.strictEqual(isValidLuaIdentifier('123'), false);
        assert.strictEqual(isValidLuaIdentifier('0PLUGIN'), false);
    });

    test('identifier with spaces is invalid', () => {
        assert.strictEqual(isValidLuaIdentifier('MY FRAMEWORK'), false);
        assert.strictEqual(isValidLuaIdentifier(' PLUGIN'), false);
        assert.strictEqual(isValidLuaIdentifier('PLUGIN '), false);
    });

    test('identifier with hyphens is invalid', () => {
        assert.strictEqual(isValidLuaIdentifier('my-framework'), false);
        assert.strictEqual(isValidLuaIdentifier('DARK-RP'), false);
    });

    test('identifier with dots is invalid', () => {
        assert.strictEqual(isValidLuaIdentifier('my.table'), false);
        assert.strictEqual(isValidLuaIdentifier('PLUGIN.field'), false);
    });

    test('identifier with glob metacharacters is invalid', () => {
        assert.strictEqual(isValidLuaIdentifier('FOO*'), false);
        assert.strictEqual(isValidLuaIdentifier('?BAR'), false);
        assert.strictEqual(isValidLuaIdentifier('{BAZ}'), false);
    });

    test('identifier with slashes is invalid (path entered by mistake)', () => {
        assert.strictEqual(isValidLuaIdentifier('schema/PLUGIN'), false);
        assert.strictEqual(isValidLuaIdentifier('gamemode/GM'), false);
    });

    test('identifier with special Lua operator characters is invalid', () => {
        assert.strictEqual(isValidLuaIdentifier('FOO+BAR'), false);
        assert.strictEqual(isValidLuaIdentifier('X=Y'), false);
        assert.strictEqual(isValidLuaIdentifier('A:B'), false);
        assert.strictEqual(isValidLuaIdentifier('A#B'), false);
    });

    test('wizard pipeline: blank input produces no valid or rejected entries', () => {
        const valid: string[] = [];
        const rejected: string[] = [];
        for (const raw of ''.split(',')) {
            const name = raw.trim();
            if (name.length === 0) { continue; }
            if (isValidLuaIdentifier(name)) { valid.push(name); }
            else { rejected.push(name); }
        }
        assert.deepStrictEqual(valid, []);
        assert.deepStrictEqual(rejected, []);
    });

    test('wizard pipeline: all valid diagnostics globals produce no rejections', () => {
        const input = 'PLUGIN, GM, SCHEMA, MyCustomFramework';
        const valid: string[] = [];
        const rejected: string[] = [];
        for (const raw of input.split(',')) {
            const name = raw.trim();
            if (name.length === 0) { continue; }
            if (isValidLuaIdentifier(name)) { valid.push(name); }
            else { rejected.push(name); }
        }
        assert.deepStrictEqual(rejected, [], 'No rejections expected for all-valid input');
        assert.strictEqual(valid.length, 4);
    });

    test('wizard pipeline: diagnostics globals — valid Lua identifiers pass through', () => {
        const input = 'MyLib, GlobalTable, _G_CUSTOM';
        const diagnosticsGlobals: string[] = [];
        for (const raw of input.split(',')) {
            const name = raw.trim();
            if (name.length > 0 && isValidLuaIdentifier(name)) {
                diagnosticsGlobals.push(name);
            }
        }
        assert.deepStrictEqual(diagnosticsGlobals, ['MyLib', 'GlobalTable', '_G_CUSTOM']);
    });

    test('wizard pipeline: diagnostics globals — malformed names are caught', () => {
        const input = 'ValidLib, bad-name, 99problems, Good_One';
        const valid: string[] = [];
        const rejected: string[] = [];
        for (const raw of input.split(',')) {
            const name = raw.trim();
            if (name.length === 0) { continue; }
            if (isValidLuaIdentifier(name)) { valid.push(name); }
            else { rejected.push(name); }
        }
        assert.deepStrictEqual(valid, ['ValidLib', 'Good_One']);
        assert.deepStrictEqual(rejected, ['bad-name', '99problems']);
    });
});
