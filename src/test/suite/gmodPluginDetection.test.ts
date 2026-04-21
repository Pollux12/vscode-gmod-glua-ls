import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectGmodPlugin, disposePluginDetectionRuntime } from '../../gmodPluginDetection';
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

function makeSymbol(name: string, filePath: string): vscode.SymbolInformation {
    const location = new vscode.Location(
        vscode.Uri.file(filePath),
        new vscode.Range(0, 0, 0, 1),
    );
    return new vscode.SymbolInformation(name, vscode.SymbolKind.Variable, '', location);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    let symbolResolver: (query: string) => vscode.SymbolInformation[] = () => [];
    let symbolProviderDisposable: vscode.Disposable | undefined;

    suiteSetup(() => {
        symbolProviderDisposable = vscode.languages.registerWorkspaceSymbolProvider({
            provideWorkspaceSymbols(query: string): vscode.ProviderResult<vscode.SymbolInformation[]> {
                return symbolResolver(query);
            },
            resolveWorkspaceSymbol(symbol: vscode.SymbolInformation): vscode.ProviderResult<vscode.SymbolInformation> {
                return symbol;
            },
        });
    });

    suiteTeardown(() => {
        symbolProviderDisposable?.dispose();
    });

    setup(() => {
        disposePluginDetectionRuntime();
        tmpDir = makeTempDir();
        symbolResolver = () => [];
    });

    teardown(() => {
        disposePluginDetectionRuntime();
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
        const filePath = path.join(nestedDir, 'sv_permissions.lua');
        fs.writeFileSync(
            filePath,
            'if CAMI then\n    CAMI.RegisterPrivilege({ Name = "test" })\nend\n',
            'utf8',
        );
        symbolResolver = (query) => query === 'CAMI' ? [makeSymbol('CAMI', filePath)] : [];

        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(result.detected.some((plugin) => plugin.id === 'cami'));
    });

    test('does not detect CAMI when symbol provider has no CAMI symbol', async () => {
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
        const filePath = path.join(tmpDir, 'lua', 'autorun', 'cami_boot.lua');
        fs.writeFileSync(filePath, 'CAMI = CAMI or {}\n', 'utf8');
        symbolResolver = (query) => query === 'CAMI' ? [makeSymbol('CAMI', filePath)] : [];

        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        const detectedIds = new Set(result.detected.map((plugin) => plugin.id));
        assert.ok(detectedIds.has('darkrp'));
        assert.ok(detectedIds.has('cami'));
    });

    test('reuses cached result when workspace files are unchanged', async () => {
        const nestedDir = path.join(tmpDir, 'lua', 'autorun', 'server');
        fs.mkdirSync(nestedDir, { recursive: true });
        const filePath = path.join(nestedDir, 'sv_permissions.lua');
        fs.writeFileSync(filePath, 'if CAMI then\nend\n', 'utf8');

        let symbolQueryCalls = 0;
        symbolResolver = (query) => {
            if (query === 'CAMI') {
                symbolQueryCalls += 1;
                return [makeSymbol('CAMI', filePath)];
            }
            return [];
        };

        const first = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(first.detected.some((plugin) => plugin.id === 'cami'));
        const callsAfterFirst = symbolQueryCalls;

        const second = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(second.detected.some((plugin) => plugin.id === 'cami'));
        assert.strictEqual(symbolQueryCalls, callsAfterFirst, 'second call should reuse cached detection result');
    });

    test('invalidates cached result after lua file changes', async () => {
        const nestedDir = path.join(tmpDir, 'lua', 'autorun', 'server');
        fs.mkdirSync(nestedDir, { recursive: true });
        const filePath = path.join(nestedDir, 'sv_permissions.lua');
        fs.writeFileSync(filePath, 'if CAMI then\nend\n', 'utf8');

        let symbolQueryCalls = 0;
        symbolResolver = (query) => {
            if (query === 'CAMI') {
                symbolQueryCalls += 1;
                return [makeSymbol('CAMI', filePath)];
            }
            return [];
        };

        const first = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(first.detected.some((plugin) => plugin.id === 'cami'));
        const callsAfterFirst = symbolQueryCalls;

        fs.writeFileSync(filePath, 'if CAMI then\n    print("changed")\nend\n', 'utf8');
        let invalidated = false;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            const probe = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
            assert.ok(probe.detected.some((plugin) => plugin.id === 'cami'));

            if (symbolQueryCalls > callsAfterFirst) {
                invalidated = true;
                break;
            }

            await sleep(50);
        }

        assert.ok(invalidated, 'cache should invalidate after lua file changes');
    });

    test('detects global pattern using first identifier as symbol query hint', async () => {
        const nestedDir = path.join(tmpDir, 'lua', 'autorun');
        fs.mkdirSync(nestedDir, { recursive: true });
        const filePath = path.join(nestedDir, 'cami_boot.lua');
        fs.writeFileSync(filePath, 'CAMI.RegisterPrivilege = CAMI.RegisterPrivilege or function() end\n', 'utf8');

        const patternCatalog: GmodPluginCatalog = {
            plugins: [{
                id: 'pattern-cami',
                label: 'Pattern CAMI',
                description: '',
                kind: 'library',
                manifestPatterns: [],
                folderNamePatterns: [],
                fileNamePatterns: [],
                globalNames: [],
                globalPatterns: ['CAMI\\.RegisterPrivilege'],
                gamemodeBases: [],
                artifact: { branch: 'gluals-annotations-plugin-cami', manifest: 'plugin.json' },
            }],
            byId: new Map(),
        };

        symbolResolver = (query) => query === 'CAMI'
            ? [makeSymbol('CAMI.RegisterPrivilege', filePath)]
            : [];

        const result = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), patternCatalog);
        assert.ok(result.detected.some((plugin) => plugin.id === 'pattern-cami'));
    });

    test('filters workspace symbol evidence to the requested workspace folder', async () => {
        const otherDir = makeTempDir();
        try {
            const localNestedDir = path.join(tmpDir, 'lua', 'autorun');
            fs.mkdirSync(localNestedDir, { recursive: true });
            const localPath = path.join(localNestedDir, 'local.lua');
            fs.writeFileSync(localPath, 'print("local")\n', 'utf8');

            const otherNestedDir = path.join(otherDir, 'lua', 'autorun');
            fs.mkdirSync(otherNestedDir, { recursive: true });
            const otherPath = path.join(otherNestedDir, 'sv_permissions.lua');
            fs.writeFileSync(otherPath, 'if CAMI then\nend\n', 'utf8');

            symbolResolver = (query) => query === 'CAMI' ? [makeSymbol('CAMI', otherPath)] : [];

            const localResult = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
            assert.ok(!localResult.detected.some((plugin) => plugin.id === 'cami'));

            const otherResult = await detectGmodPlugin(makeWorkspaceFolder(otherDir), CATALOG);
            assert.ok(otherResult.detected.some((plugin) => plugin.id === 'cami'));
        } finally {
            try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch { /* noop */ }
        }
    });

    test('does not cache degraded result when symbol query fails', async () => {
        const nestedDir = path.join(tmpDir, 'lua', 'autorun', 'server');
        fs.mkdirSync(nestedDir, { recursive: true });
        const filePath = path.join(nestedDir, 'sv_permissions.lua');
        fs.writeFileSync(filePath, 'if CAMI then\nend\n', 'utf8');

        let shouldThrow = true;
        let symbolQueryCalls = 0;
        symbolResolver = (query) => {
            if (query !== 'CAMI') {
                return [];
            }

            symbolQueryCalls += 1;
            if (shouldThrow) {
                throw new Error('simulated symbol failure');
            }

            return [makeSymbol('CAMI', filePath)];
        };

        const first = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(!first.detected.some((plugin) => plugin.id === 'cami'));

        shouldThrow = false;
        const second = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(second.detected.some((plugin) => plugin.id === 'cami'));
        assert.ok(symbolQueryCalls >= 2, 'second run should re-query symbols instead of using degraded cache');
    });

    test('bypasses cache when requested', async () => {
        const nestedDir = path.join(tmpDir, 'lua', 'autorun', 'server');
        fs.mkdirSync(nestedDir, { recursive: true });
        const filePath = path.join(nestedDir, 'sv_permissions.lua');
        fs.writeFileSync(filePath, 'if CAMI then\nend\n', 'utf8');

        let symbolQueryCalls = 0;
        symbolResolver = (query) => {
            if (query !== 'CAMI') {
                return [];
            }

            symbolQueryCalls += 1;
            return [makeSymbol('CAMI', filePath)];
        };

        const first = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(first.detected.some((plugin) => plugin.id === 'cami'));
        const callsAfterFirst = symbolQueryCalls;

        const second = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG);
        assert.ok(second.detected.some((plugin) => plugin.id === 'cami'));
        assert.strictEqual(symbolQueryCalls, callsAfterFirst, 'second run should use cache by default');

        const third = await detectGmodPlugin(makeWorkspaceFolder(tmpDir), CATALOG, { bypassCache: true });
        assert.ok(third.detected.some((plugin) => plugin.id === 'cami'));
        assert.ok(symbolQueryCalls > callsAfterFirst, 'bypassCache should force a new symbol query');
    });
});
