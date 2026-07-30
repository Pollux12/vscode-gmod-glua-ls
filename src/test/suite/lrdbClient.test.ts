import * as assert from 'assert';

import { Client, DebugClientAdapter, DebugRequest } from '../../debugger/gmod_debugger/lrdb/Client';
import { JsonRpcMessage } from '../../debugger/gmod_debugger/lrdb/JsonRpc';
import { TypedEventEmitter } from '../../debugger/gmod_debugger/lrdb/TypedEventEmitter';

suite('LRDB Client', () => {
    test('serializes runtime status and screenshot requests', async () => {
        const adapter = new MockAdapter();
        const client = new Client(adapter);

        const statusPromise = client.getRuntimeStatus();
        assert.strictEqual(adapter.sent[0].method, 'get_runtime_status');
        adapter.respond(adapter.sent[0].id, {
            map: 'gm_construct',
            gamemode: 'sandbox',
            dedicated: true,
            singlePlayer: false,
            playerCount: 1,
            maxPlayers: 16,
        });
        assert.strictEqual((await statusPromise).result.map, 'gm_construct');

        const screenshotPromise = client.captureScreenshot({ quality: 70 });
        assert.strictEqual(adapter.sent[1].method, 'capture_screenshot');
        assert.deepStrictEqual(adapter.sent[1].params, { quality: 70 });
        adapter.respond(adapter.sent[1].id, {
            mimeType: 'image/jpeg',
            data: '/9j/2Q==',
            byteCount: 4,
            quality: 70,
        });
        assert.strictEqual((await screenshotPromise).result.byteCount, 4);
    });

    test('rejects a pending screenshot when the transport closes', async () => {
        const adapter = new MockAdapter();
        const client = new Client(adapter);
        const screenshot = client.captureScreenshot({ quality: 70 });
        adapter.onClose.emit();
        await assert.rejects(screenshot, /Connection closed while waiting for response: capture_screenshot/);
    });
});

class MockAdapter implements DebugClientAdapter {
    public readonly sent: DebugRequest[] = [];
    public readonly onMessage = new TypedEventEmitter<JsonRpcMessage>();
    public readonly onOpen = new TypedEventEmitter<void>();
    public readonly onDisconnect = new TypedEventEmitter<Error>();
    public readonly onClose = new TypedEventEmitter<void>();
    public readonly onError = new TypedEventEmitter<Error>();

    public send(request: DebugRequest): boolean {
        this.sent.push(request);
        return true;
    }

    public end(): void {
        this.onClose.emit();
    }

    public respond(id: number | string, result: unknown): void {
        this.onMessage.emit({ jsonrpc: '2.0', id, result });
    }
}
