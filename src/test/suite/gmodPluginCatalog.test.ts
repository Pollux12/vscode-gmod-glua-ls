import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadGmodPluginCatalog, loadPluginBundleDefinition } from '../../gmodPluginCatalog';
import { detectGmodPlugin } from '../../gmodPluginDetection';

function makeTempFolder(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
}

function writeManifest(folderPath: string, manifestFileName: string, base: string): void {
    fs.writeFileSync(
        path.join(folderPath, manifestFileName),
        `"test"\n{\n    "base" "${base}"\n}\n`,
        'utf8',
    );
}

suite('GMod Plugin Catalog', () => {
    test('loads catalog from plugin index and ignores malformed plugins', () => {
        const bundlePath = makeTempFolder('gluals-plugin-catalog-');
        try {
            fs.mkdirSync(path.join(bundlePath, 'plugin'), { recursive: true });
            const pluginIndex = {
                version: 1,
                generatedAt: '2026-01-01T00:00:00Z',
                plugins: [
                    {
                        id: 'custom-rp',
                        name: 'Custom RP',
                        description: 'Custom RP plugin',
                        detection: {
                            gamemodeBases: ['customrp'],
                            folderNamePatterns: ['customrp'],
                        },
                        artifact: {
                            branch: 'gluals-annotations-plugin-custom-rp',
                            manifest: 'plugin.json',
                            version: '2026-01-01T00:00:00Z',
                        },
                    },
                    {
                        label: 'Broken Plugin Missing Id',
                        detection: { gamemodeBases: ['broken'] },
                    },
                    {
                        id: 'broken-no-detection',
                        label: 'Broken No Detection',
                        artifact: { branch: 'gluals-annotations-plugin-broken-no-detection', manifest: 'plugin.json' },
                    },
                ],
            };

            fs.writeFileSync(path.join(bundlePath, 'plugin', 'index.json'), JSON.stringify(pluginIndex, null, 2), 'utf8');

            const catalog = loadGmodPluginCatalog({ annotationsPath: bundlePath });
            assert.ok(catalog.byId.has('custom-rp'), 'valid plugin should be loaded from metadata');
            assert.ok(!catalog.byId.has('broken-no-detection'), 'malformed plugin should be ignored');
            assert.strictEqual(catalog.byId.get('custom-rp')?.artifact.branch, 'gluals-annotations-plugin-custom-rp');
        } finally {
            fs.rmSync(bundlePath, { recursive: true, force: true });
        }
    });

    test('loads plugin bundle definition from custom manifest path', () => {
        const bundlePath = makeTempFolder('gluals-plugin-bundle-manifest-');
        try {
            fs.writeFileSync(path.join(bundlePath, 'bundle-manifest.json'), JSON.stringify({
                id: 'custom-rp',
                gluarcPath: 'bundle-gluarc.json',
                annotationsPath: 'bundle-annotations',
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(bundlePath, 'bundle-gluarc.json'), JSON.stringify({
                gmod: { plugins: ['custom-rp'] },
            }, null, 2), 'utf8');
            fs.mkdirSync(path.join(bundlePath, 'bundle-annotations'), { recursive: true });

            const definition = loadPluginBundleDefinition(bundlePath, 'bundle-manifest.json');
            assert.ok(definition, 'bundle definition should load from custom manifest');
            assert.ok(definition?.manifestPath.endsWith('bundle-manifest.json'));
            assert.ok(definition?.gluarcPath.endsWith('bundle-gluarc.json'));
            assert.ok(definition?.annotationsPath.endsWith('bundle-annotations'));
        } finally {
            fs.rmSync(bundlePath, { recursive: true, force: true });
        }
    });

    test('detects DarkRP via manifest pattern', async () => {
        const workspacePath = makeTempFolder('gluals-plugin-darkrp-');
        const bundlePath = makeTempFolder('gluals-plugin-bundle-darkrp-');
        try {
            fs.mkdirSync(path.join(bundlePath, 'plugin'), { recursive: true });
            fs.writeFileSync(path.join(bundlePath, 'plugin', 'index.json'), JSON.stringify({
                version: 1,
                plugins: [
                    {
                        id: 'darkrp',
                        name: 'DarkRP',
                        description: 'DarkRP',
                        detection: { gamemodeBases: ['darkrp'], folderNamePatterns: ['darkrp', 'drp'] },
                        artifact: { branch: 'gluals-annotations-plugin-darkrp', manifest: 'plugin.json' },
                    },
                ],
            }, null, 2), 'utf8');
            writeManifest(workspacePath, 'darkrp_test.txt', 'DarkRP');
            const result = await detectGmodPlugin(
                makeWorkspaceFolder(workspacePath),
                loadGmodPluginCatalog({ annotationsPath: bundlePath }),
            );

            assert.ok(result.detected.length > 0, 'plugin should be detected');
            assert.ok(result.detected.some((plugin) => plugin.id === 'darkrp'));
            const darkrpEvidence = result.evidence.darkrp ?? [];
            assert.ok(darkrpEvidence.some((entry) => entry.includes('matches')), 'evidence should contain a manifest pattern match');
        } finally {
            fs.rmSync(workspacePath, { recursive: true, force: true });
            fs.rmSync(bundlePath, { recursive: true, force: true });
        }
    });

    test('detects Helix via manifest pattern', async () => {
        const workspacePath = makeTempFolder('gluals-plugin-helix-');
        const bundlePath = makeTempFolder('gluals-plugin-bundle-helix-');
        try {
            fs.mkdirSync(path.join(bundlePath, 'plugin'), { recursive: true });
            fs.writeFileSync(path.join(bundlePath, 'plugin', 'index.json'), JSON.stringify({
                version: 1,
                plugins: [
                    {
                        id: 'helix',
                        name: 'Helix',
                        description: 'Helix',
                        detection: { gamemodeBases: ['helix', 'nutscript'], folderNamePatterns: ['helix', 'hl2rp'] },
                        artifact: { branch: 'gluals-annotations-plugin-helix', manifest: 'plugin.json' },
                    },
                ],
            }, null, 2), 'utf8');
            writeManifest(workspacePath, 'schema.txt', 'helix');
            const result = await detectGmodPlugin(
                makeWorkspaceFolder(workspacePath),
                loadGmodPluginCatalog({ annotationsPath: bundlePath }),
            );

            assert.ok(result.detected.length > 0, 'plugin should be detected');
            assert.ok(result.detected.some((plugin) => plugin.id === 'helix'));
            const helixEvidence = result.evidence.helix ?? [];
            assert.ok(helixEvidence.some((entry) => entry.includes('matches')), 'evidence should contain a manifest pattern match');
        } finally {
            fs.rmSync(workspacePath, { recursive: true, force: true });
            fs.rmSync(bundlePath, { recursive: true, force: true });
        }
    });
});
