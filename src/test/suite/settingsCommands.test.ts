/**
 * Extension-host smoke tests for settings panel commands.
 *
 * These tests verify that:
 * - gluals.gmod.openSettings executes without throwing
 * - gluals.gmod.createSettings creates .gluarc.json if it doesn't exist
 * - gluals.gmod.editSettings executes without throwing for an existing file
 * - gluals.gmod.createSettings in a simulated multi-root workspace only prompts once
 *
 * Tests use the test-fixtures/workspace folder as the workspace root.
 * Any created .gluarc.json is cleaned up after the test.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateExtension, getFixtureUri } from './helper';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../test-fixtures/workspace');
const GLUARC_PATH = path.join(FIXTURE_ROOT, '.gluarc.json');

function cleanupGluarc(): void {
    try {
        if (fs.existsSync(GLUARC_PATH)) {
            fs.unlinkSync(GLUARC_PATH);
        }
    } catch {
        // Best-effort cleanup
    }
}

suite('Settings Commands', () => {
    suiteSetup(async () => {
        await activateExtension(getFixtureUri('sample.lua'));
        cleanupGluarc();
    });

    suiteTeardown(() => {
        cleanupGluarc();
    });

    teardown(() => {
        // Close any open webview panels between tests
        vscode.commands.executeCommand('workbench.action.closeAllEditors').then(undefined, () => undefined);
        cleanupGluarc();
    });

    test('gluals.gmod.openSettings executes without error', async () => {
        // openSettings should open a webview panel (or show picker) without throwing
        try {
            await vscode.commands.executeCommand('gluals.gmod.openSettings');
        } catch (error) {
            // An error thrown here means the command threw, not just showed a notification
            assert.fail(`gluals.gmod.openSettings threw: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    test('gluals.gmod.createSettings creates .gluarc.json in fixture workspace', async () => {
        cleanupGluarc();
        assert.ok(!fs.existsSync(GLUARC_PATH), 'Pre-condition: .gluarc.json must not exist before test');

        const targetUri = vscode.Uri.file(FIXTURE_ROOT);

        try {
            await vscode.commands.executeCommand('gluals.gmod.createSettings', targetUri);
        } catch (error) {
            assert.fail(`gluals.gmod.createSettings threw: ${error instanceof Error ? error.message : String(error)}`);
        }

        // After createSettings, .gluarc.json should exist
        assert.ok(
            fs.existsSync(GLUARC_PATH),
            '.gluarc.json should have been created by gluals.gmod.createSettings',
        );

        // The file should be valid JSON
        const raw = fs.readFileSync(GLUARC_PATH, 'utf8');
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            assert.fail(`.gluarc.json created by createSettings is not valid JSON: ${raw}`);
        }
        assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), '.gluarc.json must be a JSON object');
    });

    test('gluals.gmod.editSettings opens settings panel for existing .gluarc.json without error', async () => {
        // Ensure the file exists first
        if (!fs.existsSync(GLUARC_PATH)) {
            fs.writeFileSync(GLUARC_PATH, '{}\n', 'utf8');
        }

        const targetUri = vscode.Uri.file(GLUARC_PATH);

        try {
            await vscode.commands.executeCommand('gluals.gmod.editSettings', targetUri);
        } catch (error) {
            assert.fail(`gluals.gmod.editSettings threw: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    /**
     * Regression test for the multi-root double-picker bug.
     *
     * Strategy: Temporarily override `vscode.workspace.workspaceFolders` to look
     * like a two-folder workspace and patch `vscode.window.showWorkspaceFolderPick`
     * to return the first (real) folder while counting invocations.
     *
     * The fix in createAndShow() passes the already-resolved workspaceFolder.uri to
     * createOrShow(), which resolves it deterministically without prompting again.
     * We assert the picker was called exactly once (for the initial resolution in
     * createAndShow) and NOT a second time inside createOrShow.
     */
    test('gluals.gmod.createSettings multi-root: showWorkspaceFolderPick called exactly once', async () => {
        cleanupGluarc();

        // Build a fake second workspace folder in a temp dir so we can inject it.
        const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-test-second-'));
        const secondFolderUri = vscode.Uri.file(secondRoot);
        const realFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(realFolder, 'Test requires at least one real workspace folder');

        const fakeSecondFolder: vscode.WorkspaceFolder = {
            uri: secondFolderUri,
            name: 'second-workspace',
            index: 1,
        };

        // Patch workspaceFolders to pretend we have two roots.
        const originalDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            configurable: true,
            get: () => [realFolder, fakeSecondFolder],
        });

        // Patch showWorkspaceFolderPick to return the real folder and record calls.
        let pickerCallCount = 0;
        const originalPick = vscode.window.showWorkspaceFolderPick;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWorkspaceFolderPick = async () => {
            pickerCallCount++;
            return realFolder;
        };

        try {
            // No targetUri — this is the command-palette path that previously double-prompted.
            await vscode.commands.executeCommand('gluals.gmod.createSettings');
        } catch (error) {
            assert.fail(`gluals.gmod.createSettings threw in multi-root path: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // Restore patches unconditionally.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showWorkspaceFolderPick = originalPick;
            if (originalDescriptor) {
                Object.defineProperty(vscode.workspace, 'workspaceFolders', originalDescriptor);
            } else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (vscode.workspace as any).workspaceFolders;
            }
            // Clean up temp dir
            try { fs.rmSync(secondRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
        }

        // The picker must have been called exactly once (in createAndShow).
        // With the bug, it would be called twice — once in createAndShow and once
        // inside createOrShow when targetUri was undefined.
        assert.strictEqual(
            pickerCallCount,
            1,
            `showWorkspaceFolderPick should be called exactly once; got ${pickerCallCount}. ` +
            'A count of 2 indicates the pre-fix double-prompt regression.',
        );

        // The file must have been created in the real (picked) workspace.
        assert.ok(
            fs.existsSync(GLUARC_PATH),
            '.gluarc.json must be created in the picked workspace folder',
        );
    });
});
