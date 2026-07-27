import * as assert from 'assert';

import { TcpAdapter } from '../../debugger/gmod_debugger/lrdb/Adapter/TcpAdapter';

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
});
