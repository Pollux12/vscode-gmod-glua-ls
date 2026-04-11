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
        const derivedRoot = path.join(gamemodesRoot, 'my_mode');
        const frameworkRoot = path.join(gamemodesRoot, 'framework');
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
                path.join(frameworkRoot, 'framework.txt'),
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

            assert.deepStrictEqual(libraries, ['../framework']);
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
});