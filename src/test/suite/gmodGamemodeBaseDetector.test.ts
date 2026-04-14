import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { detectGamemodeBaseLibraries } from '../../gmodGamemodeBaseDetector';

suite('Gamemode Base Detector', () => {
    test('skips builtin sandbox base library from gamemode txt', async () => {
        const gamemodesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gamemode-base-'));
        const derivedRoot = path.join(gamemodesRoot, 'my_mode');
        const sandboxRoot = path.join(gamemodesRoot, 'sandbox');

        try {
            fs.mkdirSync(derivedRoot, { recursive: true });
            fs.mkdirSync(sandboxRoot, { recursive: true });
            fs.writeFileSync(
                path.join(derivedRoot, 'my_mode.txt'),
                [
                    '"MyMode"',
                    '{',
                    '    // Standard GMod KeyValues format',
                    '    "base"    "Sandbox"',
                    '    "title"   "My Mode"',
                    '}',
                ].join('\n'),
                'utf8'
            );

            const workspaceFolder = {
                uri: vscode.Uri.file(derivedRoot),
                name: 'my_mode',
                index: 0,
            } as vscode.WorkspaceFolder;

            const libraries = await detectGamemodeBaseLibraries(workspaceFolder);

            assert.deepStrictEqual(libraries, []);
        } finally {
            fs.rmSync(gamemodesRoot, { recursive: true, force: true });
        }
    });

    test('keeps custom bases but stops before builtin sandbox chain', async () => {
        const gamemodesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gamemode-chain-'));
        // Use capital-F 'Framework' to match the manifest's base field value and
        // verify that original case is preserved in the library path.
        const derivedRoot = path.join(gamemodesRoot, 'my_mode');
        const frameworkRoot = path.join(gamemodesRoot, 'Framework');
        const sandboxRoot = path.join(gamemodesRoot, 'sandbox');

        try {
            fs.mkdirSync(derivedRoot, { recursive: true });
            fs.mkdirSync(frameworkRoot, { recursive: true });
            fs.mkdirSync(sandboxRoot, { recursive: true });
            fs.writeFileSync(
                path.join(derivedRoot, 'my_mode.txt'),
                [
                    '"MyMode"',
                    '{',
                    '    "base"    "Framework"',
                    '    "title"   "My Mode"',
                    '}',
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(
                path.join(frameworkRoot, 'Framework.txt'),
                [
                    '"Framework"',
                    '{',
                    '    "base"    "Sandbox"',
                    '    "title"   "Framework"',
                    '}',
                ].join('\n'),
                'utf8'
            );

            const workspaceFolder = {
                uri: vscode.Uri.file(derivedRoot),
                name: 'my_mode',
                index: 0,
            } as vscode.WorkspaceFolder;

            const libraries = await detectGamemodeBaseLibraries(workspaceFolder);

            // Original case from the manifest must be preserved in the path
            assert.deepStrictEqual(libraries, ['../Framework']);
        } finally {
            fs.rmSync(gamemodesRoot, { recursive: true, force: true });
        }
    });

    test('detects manifest when txt filename differs from folder name', async () => {
        const gamemodesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gamemode-manifest-'));
        const schemaRoot = path.join(gamemodesRoot, 'helix-hl2rp');
        const helixRoot = path.join(gamemodesRoot, 'helix');

        try {
            fs.mkdirSync(schemaRoot, { recursive: true });
            fs.mkdirSync(helixRoot, { recursive: true });
            fs.writeFileSync(
                path.join(schemaRoot, 'ixhl2rp.txt'),
                [
                    '"ixhl2rp"',
                    '{',
                    '    "base"    "helix"',
                    '    "title"   "HL2 RP"',
                    '}',
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(
                path.join(schemaRoot, 'LICENSE.txt'),
                'This is not a gamemode manifest.',
                'utf8'
            );
            fs.writeFileSync(
                path.join(helixRoot, 'helix.txt'),
                [
                    '"helix"',
                    '{',
                    '    "base"    "sandbox"',
                    '    "title"   "Helix"',
                    '}',
                ].join('\n'),
                'utf8'
            );

            const workspaceFolder = {
                uri: vscode.Uri.file(schemaRoot),
                name: 'helix-hl2rp',
                index: 0,
            } as vscode.WorkspaceFolder;

            const libraries = await detectGamemodeBaseLibraries(workspaceFolder);

            assert.deepStrictEqual(libraries, ['../helix']);
        } finally {
            fs.rmSync(gamemodesRoot, { recursive: true, force: true });
        }
    });

    test('preserves mixed-case base name in library path', async () => {
        // Verifies that the original case from the manifest "base" field is
        // used verbatim in the returned library path rather than being lowercased.
        const gamemodesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gamemode-mixedcase-'));
        const derivedRoot = path.join(gamemodesRoot, 'my_schema');
        const cityRPRoot = path.join(gamemodesRoot, 'CityRP');

        try {
            fs.mkdirSync(derivedRoot, { recursive: true });
            fs.mkdirSync(cityRPRoot, { recursive: true });

            fs.writeFileSync(
                path.join(derivedRoot, 'my_schema.txt'),
                [
                    '"MySchema"',
                    '{',
                    '    "base"    "CityRP"',
                    '    "title"   "My Schema"',
                    '}',
                ].join('\n'),
                'utf8'
            );
            // CityRP derives from sandbox → chain stops there
            fs.writeFileSync(
                path.join(cityRPRoot, 'CityRP.txt'),
                [
                    '"CityRP"',
                    '{',
                    '    "base"    "sandbox"',
                    '    "title"   "CityRP"',
                    '}',
                ].join('\n'),
                'utf8'
            );

            const workspaceFolder = {
                uri: vscode.Uri.file(derivedRoot),
                name: 'my_schema',
                index: 0,
            } as vscode.WorkspaceFolder;

            const libraries = await detectGamemodeBaseLibraries(workspaceFolder);

            // Must use 'CityRP' (original manifest case), NOT 'cityrp'
            assert.deepStrictEqual(libraries, ['../CityRP']);
        } finally {
            fs.rmSync(gamemodesRoot, { recursive: true, force: true });
        }
    });

    test('cycle detection uses lowercase comparison, path uses original case', async () => {
        // "Helix" -> "helix" would be a cycle if not handled properly with case folding.
        // Use a manifest that creates a case-variant cycle to ensure it is caught.
        const gamemodesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gamemode-cycle-'));
        const derivedRoot = path.join(gamemodesRoot, 'my_mode');
        const helixRoot = path.join(gamemodesRoot, 'Helix');

        try {
            fs.mkdirSync(derivedRoot, { recursive: true });
            fs.mkdirSync(helixRoot, { recursive: true });

            // my_mode -> Helix
            fs.writeFileSync(
                path.join(derivedRoot, 'my_mode.txt'),
                '"MyMode"\n{\n    "base"    "Helix"\n    "title"   "My Mode"\n}\n',
                'utf8'
            );
            // Helix -> helix (lowercase cycle via case folding)
            fs.writeFileSync(
                path.join(helixRoot, 'Helix.txt'),
                '"Helix"\n{\n    "base"    "helix"\n    "title"   "Helix"\n}\n',
                'utf8'
            );

            const workspaceFolder = {
                uri: vscode.Uri.file(derivedRoot),
                name: 'my_mode',
                index: 0,
            } as vscode.WorkspaceFolder;

            const libraries = await detectGamemodeBaseLibraries(workspaceFolder);

            // Should include Helix (original case), but the cycle must be caught
            // so 'helix' (the cycle target) must NOT be in the result a second time.
            assert.ok(libraries.includes('../Helix'), 'Helix must appear once (original case)');
            assert.strictEqual(libraries.length, 1, 'Cycle must be stopped after first entry');
        } finally {
            fs.rmSync(gamemodesRoot, { recursive: true, force: true });
        }
    });

    test('resolves sibling base folder using actual directory casing', async () => {
        const gamemodesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-gamemode-casefold-'));
        const derivedRoot = path.join(gamemodesRoot, 'my_mode');
        const frameworkRoot = path.join(gamemodesRoot, 'Framework');

        try {
            fs.mkdirSync(derivedRoot, { recursive: true });
            fs.mkdirSync(frameworkRoot, { recursive: true });
            fs.writeFileSync(
                path.join(derivedRoot, 'my_mode.txt'),
                '"MyMode"\n{\n    "base"    "framework"\n    "title"   "My Mode"\n}\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(frameworkRoot, 'Framework.txt'),
                '"Framework"\n{\n    "base"    "sandbox"\n    "title"   "Framework"\n}\n',
                'utf8'
            );

            const workspaceFolder = {
                uri: vscode.Uri.file(derivedRoot),
                name: 'my_mode',
                index: 0,
            } as vscode.WorkspaceFolder;

            const libraries = await detectGamemodeBaseLibraries(workspaceFolder);

            assert.deepStrictEqual(libraries, ['../Framework']);
        } finally {
            fs.rmSync(gamemodesRoot, { recursive: true, force: true });
        }
    });
});
