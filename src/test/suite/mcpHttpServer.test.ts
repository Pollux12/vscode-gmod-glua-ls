import * as assert from 'assert';
import * as http from 'http';

import {
    isAllowedOrigin,
    isLoopbackHost,
    McpHttpServer,
    McpTool,
    negotiateProtocolVersion,
    textResult,
} from '../../mcp/mcpHttpServer';

interface HttpReply {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

function request(port: number, options: { method?: string; path?: string; body?: unknown; headers?: Record<string, string> }): Promise<HttpReply> {
    return new Promise((resolve, reject) => {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: options.method ?? 'POST',
            path: options.path ?? '/mcp',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                ...(options.headers ?? {}),
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (payload !== undefined) {
            req.write(payload);
        }
        req.end();
    });
}

function postRaw(port: number, size: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end(Buffer.alloc(size, 0x20));
    });
}

suite('MCP HTTP server', () => {
    let server: McpHttpServer;
    let port: number;
    const echo: McpTool = {
        definition: { name: 'echo', description: 'Echoes text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        call: async (args) => textResult(`echo: ${String(args.text)}`),
    };
    const failing: McpTool = {
        definition: { name: 'fail', description: 'Always throws.', inputSchema: { type: 'object' } },
        call: async () => {
            throw new Error('boom');
        },
    };

    suiteSetup(async () => {
        server = new McpHttpServer({
            info: { name: 'gluals', title: 'GLuaLS', version: '1.2.3' },
            instructions: 'Use the tools.',
            tools: () => [echo, failing],
        });
        await server.start(0);
        port = server.port!;
    });

    suiteTeardown(async () => {
        await server.stop();
    });

    test('negotiates a supported protocol version or falls back to the newest', () => {
        assert.strictEqual(negotiateProtocolVersion('2025-03-26'), '2025-03-26');
        assert.strictEqual(negotiateProtocolVersion('1999-01-01'), '2025-11-25');
        assert.strictEqual(negotiateProtocolVersion(undefined), '2025-11-25');
    });

    test('accepts loopback hosts and origins only', () => {
        assert.ok(isLoopbackHost('127.0.0.1:21120'));
        assert.ok(isLoopbackHost('localhost:21120'));
        assert.ok(isLoopbackHost('[::1]:21120'));
        assert.ok(!isLoopbackHost('evil.example:21120'));
        assert.ok(!isLoopbackHost(undefined));
        assert.ok(isAllowedOrigin(undefined));
        assert.ok(isAllowedOrigin('http://localhost:3000'));
        assert.ok(!isAllowedOrigin('https://evil.example'));
        assert.ok(!isAllowedOrigin('null'));
    });

    test('initialize returns server info, instructions and the tools capability', async () => {
        const reply = await request(port, {
            body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
        });
        assert.strictEqual(reply.status, 200);
        const message = JSON.parse(reply.body);
        assert.strictEqual(message.id, 1);
        assert.strictEqual(message.result.protocolVersion, '2025-06-18');
        assert.deepStrictEqual(message.result.capabilities, { tools: { listChanged: false } });
        assert.strictEqual(message.result.serverInfo.name, 'gluals');
        assert.strictEqual(message.result.instructions, 'Use the tools.');
    });

    test('notifications are acknowledged with 202 and no body', async () => {
        const reply = await request(port, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
        assert.strictEqual(reply.status, 202);
        assert.strictEqual(reply.body, '');
    });

    test('lists and calls tools', async () => {
        const list = JSON.parse((await request(port, { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).body);
        assert.deepStrictEqual(list.result.tools.map((tool: { name: string }) => tool.name), ['echo', 'fail']);

        const call = JSON.parse((await request(port, {
            body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } },
        })).body);
        assert.deepStrictEqual(call.result, { content: [{ type: 'text', text: 'echo: hi' }] });
    });

    test('a throwing tool becomes an error result the agent can read', async () => {
        const call = JSON.parse((await request(port, {
            body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fail', arguments: {} } },
        })).body);
        assert.deepStrictEqual(call.result, { content: [{ type: 'text', text: 'boom' }], isError: true });
    });

    test('unknown tools and methods are JSON-RPC errors', async () => {
        const unknownTool = JSON.parse((await request(port, {
            body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } },
        })).body);
        assert.strictEqual(unknownTool.error.code, -32602);
        const unknownMethod = JSON.parse((await request(port, { body: { jsonrpc: '2.0', id: 6, method: 'resources/list' } })).body);
        assert.strictEqual(unknownMethod.error.code, -32601);
    });

    test('answers batches with an array', async () => {
        const reply = JSON.parse((await request(port, {
            body: [
                { jsonrpc: '2.0', id: 7, method: 'ping' },
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { jsonrpc: '2.0', id: 8, method: 'ping' },
            ],
        })).body);
        assert.deepStrictEqual(reply.map((message: { id: number }) => message.id), [7, 8]);
    });

    test('refuses foreign hosts, foreign origins, other paths and GET', async () => {
        assert.strictEqual((await request(port, { body: {}, headers: { Host: 'evil.example' } })).status, 403);
        assert.strictEqual((await request(port, { body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
        assert.strictEqual((await request(port, { body: {}, path: '/other' })).status, 404);
        const get = await request(port, { method: 'GET' });
        assert.strictEqual(get.status, 405);
        assert.strictEqual(get.headers.allow, 'POST');
    });

    test('malformed JSON is a parse error', async () => {
        const reply = await new Promise<HttpReply>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' } }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            });
            req.on('error', reject);
            req.end('{not json');
        });
        assert.strictEqual(reply.status, 400);
        assert.strictEqual(JSON.parse(reply.body).error.code, -32700);
    });
    test('answers an oversized request with 413 instead of dropping the connection', async () => {
        assert.strictEqual(await postRaw(port, 5 * 1024 * 1024), 413);
    });
});
