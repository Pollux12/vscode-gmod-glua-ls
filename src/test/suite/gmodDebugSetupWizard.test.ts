import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildSourceFileMap, detectSrcdsLayoutAt, parseWorkspaceRemotePathInput } from '../../debugger/gmod_debugger/GmodDebugSetupWizard';
import { clientPathToGamePath } from '../../debugger/gmod_debugger/GmodSourcePaths';

function srcdsMarker(): string {
    return process.platform === 'win32' ? 'srcds.exe' : 'srcds_run';
}

suite('GMod debug setup wizard layout detection', () => {
    let temp: string;
    let srcds: string;
    let garrysmod: string;

    setup(() => {
        temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-wizard-'));
        srcds = path.join(temp, 'srcds');
        garrysmod = path.join(srcds, 'garrysmod');
        fs.mkdirSync(path.join(garrysmod, 'addons', 'pac3', 'lua'), { recursive: true });
        fs.mkdirSync(path.join(garrysmod, 'gamemodes', 'helix', 'gamemode'), { recursive: true });
        fs.writeFileSync(path.join(srcds, srcdsMarker()), '');
    });

    teardown(() => {
        fs.rmSync(temp, { recursive: true, force: true });
    });

    test('detects the garrysmod folder opened as the workspace', () => {
        const detection = detectSrcdsLayoutAt(garrysmod);

        assert.strictEqual(detection?.kind, 'garrysmod');
        assert.strictEqual(detection?.garrysmodPath, garrysmod);
        assert.strictEqual(detection?.srcdsRoot, srcds);
        assert.strictEqual(detection?.workspaceRemotePath, '');
        assert.strictEqual(detection?.sourceRootExpression, '${workspaceFolder}');
    });

    test('detects the SRCDS root opened as the workspace', () => {
        const detection = detectSrcdsLayoutAt(srcds);

        assert.strictEqual(detection?.kind, 'garrysmod');
        assert.strictEqual(detection?.garrysmodPath, garrysmod);
        assert.strictEqual(detection?.workspaceRemotePath, '');
        assert.strictEqual(detection?.sourceRootExpression, '${workspaceFolder}/garrysmod');
        assert.strictEqual(detection?.srcdsRootExpression, '${workspaceFolder}');
        assert.strictEqual(detection?.mappedFolderExpression, '${workspaceFolder}/garrysmod');
    });

    test('keeps the addon and gamemode remote paths', () => {
        const addon = detectSrcdsLayoutAt(path.join(garrysmod, 'addons', 'pac3'));
        const gamemode = detectSrcdsLayoutAt(path.join(garrysmod, 'gamemodes', 'helix'));
        const nested = detectSrcdsLayoutAt(path.join(garrysmod, 'addons', 'pac3', 'lua'));

        assert.deepStrictEqual([addon?.kind, addon?.workspaceRemotePath, addon?.sourceRootExpression], ['addon', 'addons/pac3', '${workspaceFolder}/../..']);
        assert.deepStrictEqual([gamemode?.kind, gamemode?.workspaceRemotePath], ['gamemode', 'gamemodes/helix']);
        assert.deepStrictEqual([nested?.kind, nested?.workspaceRemotePath], ['addon', 'addons/pac3/lua']);
    });

    test('maps the addons folder and other folders inside garrysmod by their path', () => {
        const addons = detectSrcdsLayoutAt(path.join(garrysmod, 'addons'));

        assert.strictEqual(addons?.kind, 'unknown');
        assert.strictEqual(addons?.workspaceRemotePath, 'addons');
        assert.strictEqual(addons?.garrysmodPath, garrysmod);
    });

    test('ignores a garrysmod folder whose parent has no server executable', () => {
        const client = path.join(temp, 'client');
        fs.mkdirSync(path.join(client, 'garrysmod', 'addons', 'pac3'), { recursive: true });
        fs.writeFileSync(path.join(client, 'gmod.exe'), '');

        assert.strictEqual(detectSrcdsLayoutAt(client), undefined);
        assert.strictEqual(detectSrcdsLayoutAt(path.join(client, 'garrysmod')), undefined);
        assert.strictEqual(detectSrcdsLayoutAt(path.join(client, 'garrysmod', 'addons', 'pac3')), undefined);
    });

    test('ignores folders outside any garrysmod folder', () => {
        assert.strictEqual(detectSrcdsLayoutAt(temp), undefined);
    });
});

suite('GMod debug source file map', () => {
    const workspace = '/home/dev/srcds';
    const separateInstall = '/srv/gmod/garrysmod';

    /** Resolves `${workspaceFolder}` the way VS Code does, then maps the file the way the debugger does. */
    function gamePath(sourceRoot: string, mappedFolder: string, remotePath: string, file: string): string | undefined {
        const resolve = (value: string) => value.split('${workspaceFolder}').join(workspace);
        const sourceFileMap = Object.fromEntries(
            Object.entries(buildSourceFileMap(sourceRoot, mappedFolder, remotePath)).map(([source, target]) => [resolve(source), target]),
        );
        return clientPathToGamePath(`${workspace}/${file}`, { sourceRoot: resolve(sourceRoot), sourceFileMap }, path.posix);
    }

    test('maps an addon workspace to its remote path', () => {
        assert.strictEqual(gamePath(separateInstall, '${workspaceFolder}', 'addons/pac3', 'lua/autorun/pac.lua'), 'addons/pac3/lua/autorun/pac.lua');
    });

    test('maps a garrysmod workspace to the root of a separate server install', () => {
        assert.strictEqual(gamePath(separateInstall, '${workspaceFolder}', '', 'gamemodes/helix/gamemode/init.lua'), 'gamemodes/helix/gamemode/init.lua');
    });

    test('maps an SRCDS root workspace through its garrysmod folder, for its own and a separate install', () => {
        const file = 'garrysmod/gamemodes/helix/gamemode/init.lua';
        assert.strictEqual(gamePath('${workspaceFolder}/garrysmod', '${workspaceFolder}/garrysmod', '', file), 'gamemodes/helix/gamemode/init.lua');
        assert.strictEqual(gamePath(separateInstall, '${workspaceFolder}/garrysmod', '', file), 'gamemodes/helix/gamemode/init.lua');
    });

    test('reads "." as the garrysmod root and strips leading slashes', () => {
        assert.strictEqual(parseWorkspaceRemotePathInput(' . '), '');
        assert.strictEqual(parseWorkspaceRemotePathInput('/addons/pac3'), 'addons/pac3');
    });
});
