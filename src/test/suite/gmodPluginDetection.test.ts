import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectGmodPlugin } from '../../gmodPluginDetection';
import { GmodPluginCatalog } from '../../gmodPluginCatalog';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-plugin-detect-'));
}

function makeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
}

function writeManifest(folderPath: string, fileName: string, base: string): void {
    fs.writeFileSync(
        path.join(folderPath, fileName),
        `"test"\n{\n  "base" "${base}"\n}\n`,
        'utf8',
    );
}

const CATALOG: GmodPluginCatalog = {
    plugins: [
        {
            id: 'darkrp',
            label: 'DarkRP',
            description: '',
            kind: 'gamemode',
            manifestPatterns: ['"base"\\s+"darkrp"'],
            folderNamePatterns: ['darkrp', 'drp'],
            fileNamePatterns: [],
            globalNames: [],
            globalPatterns: [],
            gamemodeBases: ['darkrp'],
            artifact: { branch: 'gluals-annotations-plugin-darkrp', manifest: 'plugin.json' },
        },
        {
            id: 'helix',
            label: 'Helix',
            description: '',
            kind: 'gamemode',
            manifestPatterns: ['"base"\\s+"helix"', '"base"\\s+"nutscript"'],
            folderNamePatterns: ['helix', 'hl2rp'],
            fileNamePatterns: [],
            globalNames: [],
            globalPatterns: [],
            gamemodeBases: ['helix', 'nutscript'],
            artifact: { branch: 'gluals-annotations-plugin-helix', manifest: 'plugin.json' },
        },
        {
            id: 'cami',
            label: 'CAMI',
            description: '',
            kind: 'library',
            manifestPatterns: [],
            folderNamePatterns: [],
            fileNamePatterns: ['cami'],
            globalNames: ['CAMI'],
            globalPatterns: [],
            gamemodeBases: [],
            artifact: { branch: 'gluals-annotations-plugin-cami', manifest: 'plugin.json' },
        },
    ],
    byId: new Map(),
};

suite('Plugin Detection', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTempDir();
    });

    teardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('detects by manifest base', async () => {
        writeManifest(tmpDir, 'gamemode.txt', 'darkrp');
        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(result.detected.some((plugin) => plugin.id === 'darkrp'));
    });

    test('detects by folder pattern', async () => {
        const target = path.join(path.dirname(tmpDir), 'helix-hl2rp');
        fs.renameSync(tmpDir, target);
        tmpDir = target;

        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(result.detected.some((plugin) => plugin.id === 'helix'));
    });

    test('detects by global keyword in nested lua file', async () => {
        const nestedDir = path.join(tmpDir, 'lua', 'autorun', 'server');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(
            path.join(nestedDir, 'sv_permissions.lua'),
            'if CAMI then\n    CAMI.RegisterPrivilege({ Name = "test" })\nend\n',
            'utf8',
        );

        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(result.detected.some((plugin) => plugin.id === 'cami'));
    });

    test('does not detect CAMI from comments or string literals', async () => {
        const nestedDir = path.join(tmpDir, 'lua', 'autorun', 'server');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(
            path.join(nestedDir, 'sv_misc.lua'),
            '-- CAMI mention in comment only\nprint("CAMI in string only")\n',
            'utf8',
        );

        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(!result.detected.some((plugin) => plugin.id === 'cami'));
    });

    test('detects multiple plugins in one workspace', async () => {
        writeManifest(tmpDir, 'darkrp.txt', 'darkrp');
        fs.mkdirSync(path.join(tmpDir, 'lua', 'autorun'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'lua', 'autorun', 'cami_boot.lua'), 'CAMI = CAMI or {}\n', 'utf8');

        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        const detectedIds = new Set(result.detected.map((plugin) => plugin.id));
        assert.ok(detectedIds.has('darkrp'));
        assert.ok(detectedIds.has('cami'));
    });
});
