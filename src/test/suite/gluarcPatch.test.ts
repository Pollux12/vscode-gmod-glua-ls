/**
 * Tests for the additive .gluarc.json patch engine.
 *
 * These tests run inside the VS Code extension host but do not require a
 * language server or open editor. They create temporary workspace folders on
 * disk and verify that applyGluarcPatch produces correct results.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { applyGluarcPatch, buildPresetPatchEntries, BUILTIN_ARRAY_IDENTITY_RULES } from '../../gluarcPatch';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTempFolder(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-patch-test-'));
}

function makeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
}

function writeGluarc(folderPath: string, content: Record<string, unknown>): void {
    fs.writeFileSync(path.join(folderPath, '.gluarc.json'), JSON.stringify(content, null, 2) + '\n', 'utf8');
}

function readGluarc(folderPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(folderPath, '.gluarc.json'), 'utf8')) as Record<string, unknown>;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('GluarcPatch — additive patch engine', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTempFolder();
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // ── Scalar keys ───────────────────────────────────────────────────────────

    test('adds new scalar key to empty config', async () => {
        writeGluarc(tmpDir, {});
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'enabled'], value: true },
        ]);

        assert.ok(summary.modified, 'Expected file to be modified');
        assert.ok(summary.added.includes('gmod.enabled'), 'Expected gmod.enabled to be added');
        const result = readGluarc(tmpDir);
        assert.strictEqual((result as any)?.gmod?.enabled, true);
    });

    test('does not overwrite existing scalar key', async () => {
        writeGluarc(tmpDir, { gmod: { enabled: false } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'enabled'], value: true },
        ]);

        assert.ok(!summary.modified, 'File should not be modified when key already exists');
        assert.ok(summary.skipped.includes('gmod.enabled'), 'Expected gmod.enabled to be skipped');
        const result = readGluarc(tmpDir);
        assert.strictEqual((result as any)?.gmod?.enabled, false, 'Original value must be preserved');
    });

    test('creates missing intermediate objects', async () => {
        writeGluarc(tmpDir, {});
        const folder = makeWorkspaceFolder(tmpDir);

        await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [] },
        ]);

        const result = readGluarc(tmpDir);
        assert.ok(typeof (result as any)?.gmod === 'object', 'gmod parent should be created');
        assert.ok(typeof (result as any)?.gmod?.scriptedClassScopes === 'object', 'scriptedClassScopes should be created');
        assert.deepStrictEqual((result as any)?.gmod?.scriptedClassScopes?.include, []);
    });

    test('preserves unrelated keys', async () => {
        writeGluarc(tmpDir, {
            diagnostics: { globals: ['MY_GLOBAL'] },
            gmod: { enabled: true },
        });
        const folder = makeWorkspaceFolder(tmpDir);

        await applyGluarcPatch(folder, [
            { path: ['gmod', 'defaultRealm'], value: 'server' },
        ]);

        const result = readGluarc(tmpDir);
        assert.deepStrictEqual((result as any)?.diagnostics?.globals, ['MY_GLOBAL'], 'Unrelated keys must be preserved');
        assert.strictEqual((result as any)?.gmod?.enabled, true, 'Existing gmod fields must be preserved');
        assert.strictEqual((result as any)?.gmod?.defaultRealm, 'server');
    });

    // ── Array identity merge ──────────────────────────────────────────────────

    test('scriptedClassScopes.include merges by id', async () => {
        const existing = { id: 'entities', classGlobal: 'ENT', include: ['entities/**'], label: 'Entities', path: ['entities'], rootDir: 'lua/entities' };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existing] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const newScope = { id: 'plugins', include: ['plugins/**'], label: 'Plugins', path: ['plugins'], rootDir: 'plugins' };
        await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [existing, newScope] },
        ]);

        const result = readGluarc(tmpDir);
        const include = (result as any)?.gmod?.scriptedClassScopes?.include as unknown[];
        assert.strictEqual(include.length, 2);
    });

    // ── Conflict behavior ─────────────────────────────────────────────────────

    test('skips conflict when intermediate path is occupied by a scalar', async () => {
        writeGluarc(tmpDir, { gmod: 42 }); // gmod is a scalar, not an object
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'enabled'], value: true },
        ]);

        assert.ok(!summary.modified, 'Should not modify when intermediate path is non-object');
        assert.ok(summary.blocked.length > 0, 'Expected at least one block');
        assert.ok(summary.blocked.includes('gmod'), 'Expected "gmod" to be blocked');
    });

    test('conflict summary includes skipped differing keys', async () => {
        writeGluarc(tmpDir, { gmod: { defaultRealm: 'server' } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'defaultRealm'], value: 'client' },
        ]);

        assert.ok(summary.skipped.includes('gmod.defaultRealm'), 'Expected gmod.defaultRealm in skipped');
        const result = readGluarc(tmpDir);
        assert.strictEqual((result as any)?.gmod?.defaultRealm, 'server', 'Existing value must not be overwritten');
    });

    // ── .gluarc.json only ─────────────────────────────────────────────────────

    test('only writes .gluarc.json — no other files created', async () => {
        writeGluarc(tmpDir, {});
        const folder = makeWorkspaceFolder(tmpDir);

        await applyGluarcPatch(folder, [
            { path: ['gmod', 'enabled'], value: true },
        ]);

        const files = fs.readdirSync(tmpDir);
        assert.deepStrictEqual(files, ['.gluarc.json'], 'Only .gluarc.json should exist in folder');
    });

    // ── buildPresetPatchEntries ───────────────────────────────────────────────

    test('buildPresetPatchEntries produces classScope entries without owners', () => {
        const classScopes = [{ id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Plugins', path: ['plugins'], rootDir: 'plugins' }];

        const entries = buildPresetPatchEntries({ classScopes });

        assert.strictEqual(entries.length, 1);
        assert.deepStrictEqual(entries[0].path, ['gmod', 'scriptedClassScopes', 'include']);
        assert.deepStrictEqual(entries[0].value, classScopes);
    });

    test('buildPresetPatchEntries includes diagnosticsGlobals only when provided', () => {
        const entries = buildPresetPatchEntries({ diagnosticsGlobals: ['MY_GLOBAL'] });

        assert.strictEqual(entries.length, 1);
        assert.deepStrictEqual(entries[0].path, ['diagnostics', 'globals']);
        assert.deepStrictEqual(entries[0].value, ['MY_GLOBAL']);
    });

    test('buildPresetPatchEntries emits nothing for empty opts', () => {
        const entries = buildPresetPatchEntries({});
        assert.strictEqual(entries.length, 0);
    });

    // ── BUILTIN_ARRAY_IDENTITY_RULES exported ─────────────────────────────────

    test('BUILTIN_ARRAY_IDENTITY_RULES covers scriptedClassScopes and diagnostics.globals', () => {
        const paths = BUILTIN_ARRAY_IDENTITY_RULES.map((r) => r.path.join('.'));
        assert.ok(paths.includes('gmod.scriptedClassScopes.include'), 'scriptedClassScopes.include rule missing');
        assert.ok(paths.includes('diagnostics.globals'), 'diagnostics.globals rule missing');

        // diagnostics.globals must be a primitive-value rule (no idKey)
        const globalsRule = BUILTIN_ARRAY_IDENTITY_RULES.find((r) => r.path.join('.') === 'diagnostics.globals');
        assert.ok(globalsRule, 'diagnostics.globals rule not found');
        assert.strictEqual(globalsRule!.idKey, undefined, 'diagnostics.globals rule must have no idKey (primitive identity)');
    });

    // ── Duplicate-id deduplication (Issue 6) ──────────────────────────────────

    test('deduplicates duplicate ids within incoming class scope value on first-write path', async () => {
        writeGluarc(tmpDir, {});
        const folder = makeWorkspaceFolder(tmpDir);

        const dupeScopes = [
            { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'First Plugins', path: ['plugins'] },
            { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Duplicate Plugins', path: ['plugins'] },
        ];

        await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: dupeScopes },
        ]);

        const result = readGluarc(tmpDir);
        const include = (result as any)?.gmod?.scriptedClassScopes?.include as unknown[];
        assert.strictEqual(include.length, 1, 'Duplicate ids in incoming value must be deduplicated');
        assert.strictEqual((include[0] as any).label, 'First Plugins', 'First occurrence must win');
    });

    test('deduplicates duplicate ids within incoming class scope value on merge path', async () => {
        const existingScope = { id: 'entities', classGlobal: 'ENT', include: ['entities/**'], label: 'Entities', path: ['entities'] };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existingScope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const incoming = [
            { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'First Plugins', path: ['plugins'] },
            { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Dupe Plugins', path: ['plugins'] },
            existingScope,
        ];

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: incoming },
        ]);

        const result = readGluarc(tmpDir);
        const include = (result as any)?.gmod?.scriptedClassScopes?.include as unknown[];
        assert.strictEqual(include.length, 2, 'Should have existing entities + one new plugins scope');
        assert.ok(summary.added[0]?.includes('[+1]'), 'Should report +1 added');
        const plugins = include.find((e: any) => e.id === 'plugins') as any;
        assert.strictEqual(plugins?.label, 'First Plugins', 'First occurrence of duplicate must win');
    });

    // ── Case-insensitive ID deduplication (Issue 5) ───────────────────────────

    test('case-variant existing id prevents re-adding same class scope entry', async () => {
        const existingScope = { id: 'MyScope', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Plugins', path: ['plugins'] };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existingScope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [{ id: 'myscope', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Plugins', path: ['plugins'] }] },
        ]);

        assert.ok(!summary.modified, 'File should not be modified when same id already exists (case-insensitive)');
        const result = readGluarc(tmpDir);
        const include = (result as any)?.gmod?.scriptedClassScopes?.include as unknown[];
        assert.strictEqual(include.length, 1, 'Should still have exactly one entry');
        assert.strictEqual((include[0] as any).id, 'MyScope', 'Original casing must be preserved');
    });

    test('case-variant deduplication within incoming class scope value array', async () => {
        writeGluarc(tmpDir, {});
        const folder = makeWorkspaceFolder(tmpDir);

        const incoming = [
            { id: 'MyScope', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Original', path: ['plugins'] },
            { id: 'myscope', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Duplicate lowercase', path: ['plugins'] },
        ];

        await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: incoming },
        ]);

        const result = readGluarc(tmpDir);
        const include = (result as any)?.gmod?.scriptedClassScopes?.include as unknown[];
        assert.strictEqual(include.length, 1, 'Case-variant incoming duplicates must be deduplicated');
        assert.strictEqual((include[0] as any).label, 'Original', 'First occurrence must win');
    });
});

// ─── Suite: diagnostics.globals — primitive array merge (Issue 2 fix) ─────────

suite('GluarcPatch — diagnostics.globals primitive array merge', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTempFolder();
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    test('creates diagnostics.globals from scratch', async () => {
        writeGluarc(tmpDir, {});
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['diagnostics', 'globals'], value: ['MYGLOBAL', 'ANOTHER'] },
        ]);

        assert.ok(summary.modified, 'File should be modified on first write');
        assert.ok(summary.added[0]?.includes('[+2]'), 'Should report 2 added');
        const result = readGluarc(tmpDir);
        assert.deepStrictEqual((result as any)?.diagnostics?.globals, ['MYGLOBAL', 'ANOTHER']);
    });

    test('merges new string values additively into existing diagnostics.globals', async () => {
        writeGluarc(tmpDir, { diagnostics: { globals: ['EXISTING'] } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['diagnostics', 'globals'], value: ['EXISTING', 'NEW'] },
        ]);

        assert.ok(summary.modified, 'File should be modified when new values are appended');
        assert.ok(summary.added[0]?.includes('[+1]'), 'Should report exactly 1 new entry appended');
        const result = readGluarc(tmpDir);
        assert.deepStrictEqual(
            (result as any)?.diagnostics?.globals,
            ['EXISTING', 'NEW'],
            'Result must contain existing values followed by new values, no duplicates',
        );
    });

    test('idempotent: re-applying same diagnostics.globals is a no-op', async () => {
        writeGluarc(tmpDir, { diagnostics: { globals: ['ALPHA', 'BETA'] } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['diagnostics', 'globals'], value: ['ALPHA', 'BETA'] },
        ]);

        assert.ok(!summary.modified, 'File should NOT be modified when all values already present');
        assert.strictEqual(summary.added.length, 0, 'No entries should be reported as added');
        assert.strictEqual(summary.skipped.length, 0, 'Idempotent no-op must not report skipped conflicts');
        const result = readGluarc(tmpDir);
        assert.deepStrictEqual((result as any)?.diagnostics?.globals, ['ALPHA', 'BETA']);
    });

    test('deduplicates duplicate values within incoming diagnostics.globals', async () => {
        writeGluarc(tmpDir, { diagnostics: { globals: ['A'] } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['diagnostics', 'globals'], value: ['B', 'B', 'C'] },
        ]);

        assert.ok(summary.modified, 'File should be modified');
        assert.ok(summary.added[0]?.includes('[+2]'), 'Should report 2 new entries (B and C, with B deduped)');
        const result = readGluarc(tmpDir);
        const globals = (result as any)?.diagnostics?.globals as string[];
        assert.strictEqual(globals.filter((g) => g === 'B').length, 1, 'Incoming duplicate B must appear only once');
        assert.ok(globals.includes('C'), 'C must be appended');
        assert.ok(globals.includes('A'), 'Existing A must be preserved');
    });

    test('preserves case of existing globals and does not deduplicate case-variants', async () => {
        // diagnostics.globals uses case-sensitive identity (Lua globals are case-sensitive)
        writeGluarc(tmpDir, { diagnostics: { globals: ['MyGlobal'] } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['diagnostics', 'globals'], value: ['myglobal'] },
        ]);

        // 'myglobal' ≠ 'MyGlobal' (case-sensitive), so it should be appended
        assert.ok(summary.modified, 'Case-variant should be treated as a new distinct entry');
        const result = readGluarc(tmpDir);
        const globals = (result as any)?.diagnostics?.globals as string[];
        assert.ok(globals.includes('MyGlobal'), 'Original casing must be preserved');
        assert.ok(globals.includes('myglobal'), 'Case-variant must be added as a distinct entry');
    });

    test('conflict when diagnostics.globals is occupied by a non-array scalar', async () => {
        writeGluarc(tmpDir, { diagnostics: { globals: 'not-an-array' } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['diagnostics', 'globals'], value: ['GLOBAL'] },
        ]);

        assert.ok(!summary.modified, 'Should not modify when existing value is not an array');
        assert.ok(summary.blocked.includes('diagnostics.globals'), 'diagnostics.globals must be in blocked on conflict');
    });

    test('buildPresetPatchEntries diagnostics.globals patch applies additively', async () => {
        writeGluarc(tmpDir, { diagnostics: { globals: ['PREEXISTING'] } });
        const folder = makeWorkspaceFolder(tmpDir);

        const entries = buildPresetPatchEntries({ diagnosticsGlobals: ['PREEXISTING', 'NEW_FROM_PRESET'] });
        const summary = await applyGluarcPatch(folder, entries);

        assert.ok(summary.modified, 'Should be modified when new globals added');
        const result = readGluarc(tmpDir);
        const globals = (result as any)?.diagnostics?.globals as string[];
        assert.ok(globals.includes('PREEXISTING'), 'Existing global must be preserved');
        assert.ok(globals.includes('NEW_FROM_PRESET'), 'New global from preset must be appended');
        assert.strictEqual(globals.filter((g) => g === 'PREEXISTING').length, 1, 'No duplicate PREEXISTING');
    });
});

// ─── Suite: Content-drift / conflict reporting (Batch 2 refinement) ────────────

suite('GluarcPatch — content drift / conflict reporting', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTempFolder();
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    test('reports content drift when same class scope id exists with different content', async () => {
        const existingScope = { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Old Label', path: ['plugins'] };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existingScope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const updatedScope = { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'New Label', path: ['plugins'] };
        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [updatedScope] },
        ]);

        assert.ok(!summary.modified, 'Content drift must not overwrite existing entry');
        assert.ok(summary.conflicts.length > 0, 'Content drift must be reported in conflicts');
        assert.ok(
            summary.conflicts.some((c) => c.includes('plugins')),
            'Conflict entry must identify the drifted id',
        );
        const result = readGluarc(tmpDir);
        const include = (result as any)?.gmod?.scriptedClassScopes?.include as unknown[];
        assert.strictEqual((include[0] as any).label, 'Old Label', 'Original content must be preserved on drift');
    });

    test('idempotent no-op does not report conflicts', async () => {
        const scope = { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Plugins', path: ['plugins'] };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [scope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [scope] },
        ]);

        assert.ok(!summary.modified, 'Identical re-apply must be a no-op');
        assert.strictEqual(summary.conflicts.length, 0, 'Identical re-apply must not produce conflicts');
        assert.strictEqual(summary.added.length, 0, 'Identical re-apply must not report added');
    });

    test('mixed apply: new class scopes added, existing drifted entry reported', async () => {
        const existingScope = { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Old', path: ['plugins'] };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existingScope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const driftedScope = { id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Changed', path: ['plugins'] };
        const newScope = { id: 'items', classGlobal: 'ITEM', include: ['items/**'], label: 'Items', path: ['items'] };

        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [driftedScope, newScope] },
        ]);

        assert.ok(summary.modified, 'New entry should cause file modification');
        assert.ok(summary.added.some((a) => a.includes('[+1]')), 'New item must be reported as added');
        assert.ok(summary.conflicts.some((c) => c.includes('plugins')), 'Drifted plugins scope must be in conflicts');
        const result = readGluarc(tmpDir);
        const include = (result as any)?.gmod?.scriptedClassScopes?.include as unknown[];
        const pluginsEntry = include.find((e: any) => e.id === 'plugins') as any;
        assert.strictEqual(pluginsEntry.label, 'Old', 'Original entry must not be overwritten');
    });

    test('content drift with case-insensitive class scope id match still detected', async () => {
        const existingScope = { id: 'MyScope', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Original', path: ['plugins'] };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existingScope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const incomingScope = { id: 'myscope', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Changed', path: ['plugins'] };
        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [incomingScope] },
        ]);

        assert.ok(!summary.modified, 'Must not overwrite existing case-variant entry');
        assert.ok(
            summary.conflicts.some((c) => c.toLowerCase().includes('myscope')),
            'Drift must be detected for case-insensitive id match with different content',
        );
    });

    test('PatchSummary.conflicts is an empty array when no drift occurs', async () => {
        writeGluarc(tmpDir, {});
        const folder = makeWorkspaceFolder(tmpDir);

        const scopes = [{ id: 'plugins', classGlobal: 'PLUGIN', include: ['plugins/**'], label: 'Plugins', path: ['plugins'] }];
        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: scopes },
        ]);

        assert.ok(summary.modified, 'First write should modify');
        assert.ok(Array.isArray(summary.conflicts), 'conflicts must always be an array');
        assert.strictEqual(summary.conflicts.length, 0, 'No drift on first write');
    });

    test('primitive arrays never report drift (identity = value)', async () => {
        // diagnostics.globals is a primitive array — same value = same identity = no drift possible
        writeGluarc(tmpDir, { diagnostics: { globals: ['MYGLOBAL'] } });
        const folder = makeWorkspaceFolder(tmpDir);

        // Re-apply the same value
        const summary = await applyGluarcPatch(folder, [
            { path: ['diagnostics', 'globals'], value: ['MYGLOBAL'] },
        ]);

        assert.ok(!summary.modified);
        assert.strictEqual(summary.conflicts.length, 0, 'Primitive arrays must never report content drift');
    });

    // ── Issue 2 fix: order-insensitive include-array comparison ───────────────

    test('reordered include in class scope entry does not produce false drift conflict', async () => {
        const existingScope = {
            id: 'plugins',
            classGlobal: 'PLUGIN',
            include: ['schema/plugins/**', 'gamemode/plugins/**'],
            label: 'Plugins',
            path: ['schema', 'plugins'],
        };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existingScope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const reorderedScope = {
            id: 'plugins',
            classGlobal: 'PLUGIN',
            include: ['gamemode/plugins/**', 'schema/plugins/**'],   // reversed
            label: 'Plugins',
            path: ['schema', 'plugins'],
        };
        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [reorderedScope] },
        ]);

        assert.ok(!summary.modified,
            'Reordered include in class scope must be a no-op');
        assert.strictEqual(summary.conflicts.length, 0,
            'Reordered include in class scope must not produce false drift conflict');
    });

    test('genuine content change alongside reordered class scope include still reports drift', async () => {
        const existingScope = {
            id: 'plugins',
            classGlobal: 'PLUGIN',
            include: ['schema/classes/**', 'schema/items/**'],
            label: 'Old Label',
            path: ['plugins'],
        };
        writeGluarc(tmpDir, { gmod: { scriptedClassScopes: { include: [existingScope] } } });
        const folder = makeWorkspaceFolder(tmpDir);

        const changedScope = {
            id: 'plugins',
            classGlobal: 'PLUGIN',
            include: ['schema/items/**', 'schema/classes/**'],
            label: 'New Label',
            path: ['plugins'],
        };
        const summary = await applyGluarcPatch(folder, [
            { path: ['gmod', 'scriptedClassScopes', 'include'], value: [changedScope] },
        ]);

        assert.ok(!summary.modified, 'Additive semantics: must not overwrite existing entry');
        assert.ok(summary.conflicts.length > 0,
            'Genuine label change must still be reported as drift even when include is reordered');
        assert.ok(summary.conflicts.some((c) => c.includes('plugins')),
            'Conflict must identify the drifted entry id');
    });
});
