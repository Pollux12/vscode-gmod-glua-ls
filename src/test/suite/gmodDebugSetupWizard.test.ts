import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { syncAutorunFile } from '../../debugger/gmod_debugger/GmodDebugSetupWizard';

suite('GMod Debug Setup Wizard', () => {
    test('generates bounded chunked client execution bridge', () => {
        const garrysmodPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-autorun-'));
        const autorunPath = path.join(garrysmodPath, 'lua', 'autorun', 'debug.lua');

        try {
            assert.strictEqual(syncAutorunFile(garrysmodPath, 21111, 21112), 'created');
            const generated = fs.readFileSync(autorunPath, 'utf8');

            assert.ok(generated.includes('net.WriteData(chunk, chunkBytes)'));
            assert.ok(generated.includes('local chunk = net.ReadData(chunkBytes)'));
            assert.ok(generated.includes('local MAX_CLIENT_EXEC_CHUNK_BYTES = 60 * 1024'));
            assert.ok(generated.includes('local MAX_INLINE_CLIENT_EXEC_BYTES = 256 * 1024'));
            assert.ok(generated.includes('local MAX_FILE_CLIENT_EXEC_BYTES = 1024 * 1024'));
            assert.ok(generated.includes('local MAX_PENDING_CLIENT_EXEC_TRANSFERS = 4'));
            assert.ok(generated.includes('local CLIENT_EXEC_TRANSFER_TIMEOUT = 10'));
            assert.ok(generated.includes('timer.Create("gluals_client_exec_cleanup", 1, 0, function()'));
            assert.ok(generated.includes('sendClientExec("lua", code, MAX_INLINE_CLIENT_EXEC_BYTES)'));
            assert.ok(generated.includes('sendClientExec("lua", clientCode, MAX_FILE_CLIENT_EXEC_BYTES)'));
            assert.ok(generated.indexOf('if #clientCode > MAX_FILE_CLIENT_EXEC_BYTES then')
                < generated.indexOf('local ok, err = includeServerFile(filePath)'));
            assert.ok(generated.includes('local MAX_RETURN_VALUES = 8'));
            assert.ok(generated.includes('collectCallResults(xpcall(fn, debug.traceback))'));
            assert.ok(generated.includes('executedAt = os.date("!%Y-%m-%dT%H:%M:%SZ")'));
            assert.ok(generated.includes('returnsTruncated = returnsTruncated'));
            assert.ok(generated.includes('net.WriteUInt(transferId, 32)'));
            assert.ok(generated.includes('if #payload ~= totalBytes then'));
            assert.ok(!generated.includes('lua_openscript_cl'));
            assert.ok(!generated.includes('net.WriteString(payload)'));
        } finally {
            fs.rmSync(garrysmodPath, { recursive: true, force: true });
        }
    });
});
