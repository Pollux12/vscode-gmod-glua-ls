import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    GmodControlTransport,
    GmodDebugControlService,
} from '../../debugger/gmod_debugger/GmodDebugControlService';
import { GmodSourceMapping } from '../../debugger/gmod_debugger/GmodSourcePaths';

interface DispatchedFile {
    kind: 'run' | 'refresh';
    file: string;
}

function createService(mapping: GmodSourceMapping): { service: GmodDebugControlService; dispatched: DispatchedFile[] } {
    const dispatched: DispatchedFile[] = [];
    const transport: GmodControlTransport = {
        pauseSoft: () => undefined,
        pauseNow: () => undefined,
        resume: () => undefined,
        runLua: () => undefined,
        runFile: (file) => { dispatched.push({ kind: 'run', file }); },
        refreshFile: (file) => { dispatched.push({ kind: 'refresh', file }); },
        runCommand: () => undefined,
    };
    return { service: new GmodDebugControlService(transport, 'server', mapping), dispatched };
}

suite('GMod Debug Control Service', () => {
    let tempRoot: string;
    let garrysmod: string;

    function writeLua(relativePath: string): string {
        const filePath = path.join(tempRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'print("hi")\n');
        return filePath;
    }

    setup(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-control-'));
        garrysmod = path.join(tempRoot, 'garrysmod');
    });

    teardown(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('runs and refreshes a sandbox gamemode file by its gamemode-qualified Lua path', async () => {
        const file = writeLua('garrysmod/gamemodes/sandbox/gamemode/init.lua');
        const { service, dispatched } = createService({ sourceRoot: garrysmod });

        assert.strictEqual((await service.execute('runFile', { path: file })).ok, true);
        assert.strictEqual((await service.execute('refreshFile', { path: file })).ok, true);
        assert.deepStrictEqual(dispatched, [
            { kind: 'run', file: 'sandbox/gamemode/init.lua' },
            { kind: 'refresh', file: 'sandbox/gamemode/init.lua' },
        ]);
    });

    test('runs an addon lua/ file by its path below lua/', async () => {
        const file = writeLua('garrysmod/addons/cityrp/lua/autorun/server/sv_init.lua');
        const { service, dispatched } = createService({ sourceRoot: garrysmod });

        assert.strictEqual((await service.execute('runFile', { path: file })).ok, true);
        assert.deepStrictEqual(dispatched, [{ kind: 'run', file: 'autorun/server/sv_init.lua' }]);
    });

    test('runs a file from a workspace outside sourceRoot through its sourceFileMap folder', async () => {
        const workspace = path.join(tempRoot, 'checkout');
        const file = writeLua('checkout/gamemode/cl_init.lua');
        const { service, dispatched } = createService({
            sourceRoot: garrysmod,
            sourceFileMap: { [workspace]: 'gamemodes/sandbox' },
        });

        assert.strictEqual((await service.execute('runFile', { path: file })).ok, true);
        assert.deepStrictEqual(dispatched, [{ kind: 'run', file: 'sandbox/gamemode/cl_init.lua' }]);
    });

    test('resolves a relative path against sourceRoot', async () => {
        writeLua('garrysmod/lua/autorun/x.lua');
        const { service, dispatched } = createService({ sourceRoot: garrysmod });

        assert.strictEqual((await service.execute('runFile', { path: 'lua/autorun/x.lua' })).ok, true);
        assert.deepStrictEqual(dispatched, [{ kind: 'run', file: 'autorun/x.lua' }]);
    });

    test('rejects files that escape every configured root or sit off the Lua search path', async () => {
        writeLua('outside.lua');
        const offSearchPath = writeLua('garrysmod/cfg/autoexec.lua');
        const { service, dispatched } = createService({ sourceRoot: garrysmod });

        for (const target of ['../outside.lua', path.join(tempRoot, 'outside.lua'), offSearchPath]) {
            const result = await service.execute('runFile', { path: target });
            assert.strictEqual(result.ok, false, target);
            assert.strictEqual(result.diagnostics[0].level, 'error', target);
        }
        assert.deepStrictEqual(dispatched, []);
    });
});
