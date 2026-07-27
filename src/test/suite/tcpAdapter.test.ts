import * as assert from 'assert';
import * as net from 'net';

import { TcpAdapter } from '../../debugger/gmod_debugger/lrdb/Adapter/TcpAdapter';
import { TypedEventTarget } from '../../debugger/gmod_debugger/lrdb/TypedEventEmitter';

suite('TCP Debug Adapter', () => {
    test('accepts a write queued under backpressure', () => {
        const adapter = Object.create(TcpAdapter.prototype) as TcpAdapter;
        let payload: string | undefined;
        const state = adapter as unknown as {
            _connected: boolean;
            _connection: { write(data: string): boolean };
        };
        state._connected = true;
        state._connection = {
            write(data: string): boolean {
                payload = data;
                return false;
            },
        };

        const sent = adapter.send({ method: 'continue', jsonrpc: '2.0', id: 1 });

        assert.strictEqual(sent, true);
        assert.strictEqual(payload, '{"method":"continue","jsonrpc":"2.0","id":1}\n');
    });

    test('distinguishes malformed protocol input from a socket disconnect', async () => {
        let acceptedSocket: net.Socket | undefined;
        const accepted = new Promise<net.Socket>((resolve) => {
            const server = tcpServer;
            server.once('connection', (socket) => {
                acceptedSocket = socket;
                resolve(socket);
            });
        });
        await listen(tcpServer);
        const address = tcpServer.address();
        assert.ok(address && typeof address !== 'string');

        const adapter = new TcpAdapter(address.port, '127.0.0.1');
        let disconnects = 0;
        adapter.onDisconnect.on(() => { disconnects += 1; });
        try {
            await waitForEvent(adapter.onOpen);
            const socket = await accepted;
            const protocolError = waitForEvent(adapter.onError);
            socket.write('not-json\n');
            assert.match((await protocolError).message, /Failed to parse JSON-RPC message/);
            await delay(20);
            assert.strictEqual(disconnects, 0);

            const disconnected = waitForEvent(adapter.onDisconnect);
            socket.destroy();
            assert.match((await disconnected).message, /transport closed/);
            assert.strictEqual(disconnects, 1);
        } finally {
            adapter.end();
            acceptedSocket?.destroy();
            await close(tcpServer);
        }
    });
});

const tcpServer = net.createServer();

function listen(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function close(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function waitForEvent<T>(event: TypedEventTarget<T>): Promise<T> {
    return new Promise((resolve) => event.once(resolve));
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
