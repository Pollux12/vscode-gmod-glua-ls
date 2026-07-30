import * as assert from 'assert';
import type * as vscode from 'vscode';

import {
    GmodMcpSessionRegistry,
    GmodMcpSessionResolutionError,
} from '../../gmodMcpSessions';

suite('GMod MCP Sessions', () => {
    test('resolves the only connected server when no session ID is provided', () => {
        const registry = createRegistry();
        const server = createSession('server-1', 'gluals_gmod');
        registry.register(server);
        registry.markConnected(server.id);

        const target = registry.resolveServerControlTarget();
        assert.strictEqual(target.session, server);
        assert.strictEqual(target.descriptor.sessionId, server.id);
        assert.deepStrictEqual(target.descriptor.capabilities, ['serverControl', 'serverTelemetry']);
    });

    test('reports no server when no server is connected, including client-only sessions', () => {
        const registry = createRegistry();
        const client = createSession('client-1', 'gluals_gmod_client');
        registry.register(client);
        registry.markConnected(client.id);

        const error = resolveError(() => registry.resolveServerControlTarget());
        assert.strictEqual(error.code, 'NO_CONNECTED_SERVER');
        assert.deepStrictEqual(error.availableSessions.map((session) => session.sessionId), ['client-1']);
    });

    test('requires an explicit ID when multiple servers are connected', () => {
        const registry = createRegistry();
        const later = createSession('server-b', 'gluals_gmod');
        const earlier = createSession('server-a', 'gluals_gmod');
        registry.register(later);
        registry.register(earlier);
        registry.markConnected(later.id);
        registry.markConnected(earlier.id);

        const error = resolveError(() => registry.resolveServerControlTarget());
        assert.strictEqual(error.code, 'AMBIGUOUS_SERVER');
        assert.deepStrictEqual(error.availableSessions.map((session) => session.sessionId), ['server-b', 'server-a']);
    });

    test('resolves an explicitly selected connected server', () => {
        const registry = createRegistry();
        const server = createSession('server-1', 'gluals_gmod');
        registry.register(server);
        registry.markConnected(server.id);

        assert.strictEqual(registry.resolveServerControlTarget(server.id).session, server);
    });

    test('rejects an explicitly selected client session', () => {
        const registry = createRegistry();
        const client = createSession('client-1', 'gluals_gmod_client');
        registry.register(client);
        registry.markConnected(client.id);

        const error = resolveError(() => registry.resolveServerControlTarget(client.id));
        assert.strictEqual(error.code, 'CLIENT_SESSION');
        assert.match(error.message, /client session/);
    });

    test('rejects unknown and terminated session IDs distinctly while retaining termination metadata', () => {
        const registry = createRegistry();
        const server = createSession('server-1', 'gluals_gmod');
        registry.register(server);
        registry.markConnected(server.id);
        registry.markTerminated(server.id);

        assert.strictEqual(resolveError(() => registry.resolveServerControlTarget('missing')).code, 'UNKNOWN_SESSION');
        assert.strictEqual(resolveError(() => registry.resolveServerControlTarget(server.id)).code, 'TERMINATED_SESSION');
        assert.deepStrictEqual(registry.getDescriptor(server.id), {
            sessionId: 'server-1',
            sessionName: 'server-1 name',
            debugType: 'gluals_gmod',
            kind: 'server',
            workspaceFolder: { name: 'workspace', path: 'C:\\workspace' },
            host: '127.0.0.1',
            port: 21111,
            state: 'terminated',
            startedAt: '2026-07-27T12:00:00.000Z',
            endedAt: '2026-07-27T12:00:01.000Z',
            capabilities: [],
        });
    });

    test('derives capabilities from the current lifecycle state and revalidates an exact target', () => {
        const registry = createRegistry();
        const server = createSession('server-1', 'gluals_gmod');
        const client = createSession('client-1', 'gluals_gmod_client');
        registry.register(server);
        registry.register(client);

        assert.strictEqual(registry.getDescriptor(server.id)?.state, 'starting');
        assert.deepStrictEqual(registry.getDescriptor(server.id)?.capabilities, []);
        assert.deepStrictEqual(registry.getDescriptor(client.id)?.capabilities, []);
        assert.strictEqual(resolveError(() => registry.resolveServerControlTarget(server.id)).code, 'SESSION_NOT_CONNECTED');
        assert.deepStrictEqual(registry.markConnected(server.id)?.capabilities, ['serverControl', 'serverTelemetry']);
        assert.deepStrictEqual(registry.markConnected(client.id)?.capabilities, ['clientTelemetry', 'clientScreenshot']);
        assert.strictEqual(registry.resolveClientScreenshotTarget(client.id).session, client);
        assert.deepStrictEqual(registry.markPaused(client.id)?.capabilities, ['clientTelemetry', 'pausedEvaluation']);
        assert.strictEqual(resolveError(() => registry.resolveClientScreenshotTarget(client.id)).code, 'CLIENT_PAUSED');
        assert.deepStrictEqual(registry.markRunning(client.id)?.capabilities, ['clientTelemetry', 'clientScreenshot']);

        assert.strictEqual(registry.resolveServerControlTarget(server.id).session, server);
        assert.deepStrictEqual(registry.markDisconnected(server.id)?.capabilities, []);
        const disconnected = resolveError(() => registry.resolveServerControlTarget(server.id));
        assert.strictEqual(disconnected.code, 'SESSION_NOT_CONNECTED');
        assert.match(disconnected.message, /disconnected.*until it reconnects/i);

        assert.strictEqual(registry.markConnected(server.id)?.state, 'connected');
        assert.strictEqual(registry.resolveServerControlTarget(server.id).session, server);

        assert.deepStrictEqual(registry.markTerminated(server.id)?.capabilities, []);
        assert.strictEqual(registry.markConnected(server.id), undefined);
        assert.strictEqual(resolveError(() => registry.resolveServerControlTarget(server.id)).code, 'TERMINATED_SESSION');
    });

    test('resolves only a sole running client for screenshots', () => {
        const registry = createRegistry();
        const first = createSession('client-1', 'gluals_gmod_client');
        const second = createSession('client-2', 'gluals_gmod_client');
        const server = createSession('server-1', 'gluals_gmod');
        for (const session of [first, second, server]) {
            registry.register(session);
            registry.markConnected(session.id);
        }

        assert.strictEqual(resolveError(() => registry.resolveClientScreenshotTarget()).code, 'AMBIGUOUS_CLIENT');
        assert.strictEqual(registry.resolveClientScreenshotTarget(first.id).session, first);
        assert.strictEqual(resolveError(() => registry.resolveClientScreenshotTarget(server.id)).code, 'SERVER_SESSION');

        registry.markPaused(first.id);
        assert.strictEqual(registry.resolveClientScreenshotTarget().session, second);
        registry.markPaused(second.id);
        assert.strictEqual(resolveError(() => registry.resolveClientScreenshotTarget()).code, 'CLIENT_PAUSED');
        registry.markDisconnected(second.id);
        assert.strictEqual(resolveError(() => registry.resolveClientScreenshotTarget(second.id)).code, 'SESSION_NOT_CONNECTED');
        registry.markTerminated(first.id);
        assert.strictEqual(resolveError(() => registry.resolveClientScreenshotTarget(first.id)).code, 'TERMINATED_SESSION');
        assert.strictEqual(resolveError(() => registry.resolveClientScreenshotTarget('missing')).code, 'UNKNOWN_SESSION');
    });

    test('returns descriptors in started-at then session-ID order', () => {
        const times = [
            '2026-07-27T12:00:01.000Z',
            '2026-07-27T12:00:00.000Z',
            '2026-07-27T12:00:00.000Z',
        ];
        const registry = new GmodMcpSessionRegistry({ now: () => new Date(times.shift()!) });
        registry.register(createSession('server-z', 'gluals_gmod'));
        registry.register(createSession('server-b', 'gluals_gmod'));
        registry.register(createSession('server-a', 'gluals_gmod'));

        assert.deepStrictEqual(registry.getDescriptors().map((session) => session.sessionId), [
            'server-a',
            'server-b',
            'server-z',
        ]);
    });

    test('bounds retained terminated descriptors without removing connected sessions', () => {
        const registry = createRegistry({ maxRetainedTerminated: 2 });
        const connected = createSession('connected', 'gluals_gmod');
        registry.register(connected);
        registry.markConnected(connected.id);
        for (const id of ['terminated-1', 'terminated-2', 'terminated-3']) {
            const session = createSession(id, 'gluals_gmod');
            registry.register(session);
            registry.markTerminated(id);
        }

        assert.deepStrictEqual(registry.getDescriptors().map((session) => session.sessionId), [
            'connected',
            'terminated-2',
            'terminated-3',
        ]);
        assert.strictEqual(registry.getDescriptor('terminated-1'), undefined);
    });

    test('prunes the earliest termination rather than the earliest start', () => {
        const registry = createRegistry({ maxRetainedTerminated: 2 });
        const oldestStart = createSession('oldest-start', 'gluals_gmod');
        const middleStart = createSession('middle-start', 'gluals_gmod');
        const newestStart = createSession('newest-start', 'gluals_gmod');
        registry.register(oldestStart);
        registry.register(middleStart);
        registry.register(newestStart);

        registry.markTerminated(newestStart.id);
        registry.markTerminated(middleStart.id);
        registry.markTerminated(oldestStart.id);

        assert.strictEqual(registry.getDescriptor(newestStart.id), undefined);
        assert.ok(registry.getDescriptor(middleStart.id));
        assert.ok(registry.getDescriptor(oldestStart.id));
    });

    test('uses the session ID as a deterministic tie-breaker when pruning terminated sessions', () => {
        const registry = new GmodMcpSessionRegistry({
            maxRetainedTerminated: 2,
            now: () => new Date('2026-07-27T12:00:00.000Z'),
        });
        for (const id of ['server-z', 'server-b', 'server-a']) {
            const session = createSession(id, 'gluals_gmod');
            registry.register(session);
            registry.markTerminated(id);
        }

        assert.strictEqual(registry.getDescriptor('server-a'), undefined);
        assert.deepStrictEqual(registry.getDescriptors().map((session) => session.sessionId), ['server-b', 'server-z']);
    });

    test('retains no more than the default 20 terminated descriptors', () => {
        const registry = createRegistry();
        for (let index = 0; index <= 20; index += 1) {
            const session = createSession(`terminated-${index}`, 'gluals_gmod');
            registry.register(session);
            registry.markTerminated(session.id);
        }

        assert.strictEqual(registry.getDescriptors().filter((session) => session.state === 'terminated').length, 20);
        assert.strictEqual(registry.getDescriptor('terminated-0'), undefined);
    });

    test('bounds captured metadata without splitting UTF-8 characters', () => {
        const oversized = '😀'.repeat(3_000);
        const registry = createRegistry();
        const session = createSession(`id-${oversized}`, 'gluals_gmod', {
            name: `name-${oversized}`,
            workspaceName: `workspace-${oversized}`,
            workspacePath: `C:\\${oversized}`,
            host: `host-${oversized}`,
        });
        const descriptor = registry.register(session)!;

        assertUtf8Bounded(descriptor.sessionId, 1024);
        assertUtf8Bounded(descriptor.sessionName, 1024);
        assertUtf8Bounded(descriptor.host!, 1024);
        assertUtf8Bounded(descriptor.workspaceFolder!.name, 1024);
        assertUtf8Bounded(descriptor.workspaceFolder!.path, 8 * 1024);
        assert.strictEqual(registry.getDescriptor(session.id)?.sessionId, descriptor.sessionId);
    });
});

function createRegistry(options: { maxRetainedTerminated?: number } = {}): GmodMcpSessionRegistry {
    let time = Date.parse('2026-07-27T12:00:00.000Z');
    return new GmodMcpSessionRegistry({
        ...options,
        now: () => {
            const current = new Date(time);
            time += 1_000;
            return current;
        },
    });
}

function createSession(
    id: string,
    type: 'gluals_gmod' | 'gluals_gmod_client',
    options: {
        name?: string;
        workspaceName?: string;
        workspacePath?: string;
        host?: string;
    } = {}
): vscode.DebugSession {
    return {
        id,
        type,
        name: options.name ?? `${id} name`,
        workspaceFolder: {
            name: options.workspaceName ?? 'workspace',
            uri: { fsPath: options.workspacePath ?? 'C:\\workspace' },
        },
        configuration: { host: options.host ?? '127.0.0.1', port: type === 'gluals_gmod' ? 21111 : 21112 },
    } as unknown as vscode.DebugSession;
}

function assertUtf8Bounded(value: string, maximumBytes: number): void {
    assert.ok(Buffer.byteLength(value, 'utf8') <= maximumBytes);
    assert.strictEqual(Buffer.from(value, 'utf8').toString('utf8'), value);
}

function resolveError(resolve: () => unknown): GmodMcpSessionResolutionError {
    try {
        resolve();
    } catch (error) {
        assert.ok(error instanceof GmodMcpSessionResolutionError);
        return error;
    }
    assert.fail('Expected server control resolution to throw.');
}
