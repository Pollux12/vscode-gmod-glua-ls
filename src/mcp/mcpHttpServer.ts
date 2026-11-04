import * as http from 'http';
import type { AddressInfo } from 'net';

/**
 * A small Model Context Protocol server over Streamable HTTP.
 *
 * It only offers tools, keeps no session state and answers every POST with a
 * single JSON body, which the spec allows in place of an SSE stream. It binds
 * to loopback and refuses requests whose Host or Origin is not local, which
 * stops web pages from reaching it through DNS rebinding.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_ENDPOINT_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpTextContent {
    type: 'text';
    text: string;
}

export interface McpToolResult {
    content: McpTextContent[];
    isError?: boolean;
}

export interface McpToolAnnotations {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface McpToolDefinition {
    name: string;
    title?: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: McpToolAnnotations;
}

export interface McpTool {
    definition: McpToolDefinition;
    /** Runs the tool. A thrown error becomes a tool result with `isError`, so the agent can read it. */
    call(args: Record<string, unknown>, signal: AbortSignalLike): Promise<McpToolResult>;
}

/** Tells a tool the agent hung up. The extension's `lib` setting predates the DOM AbortSignal. */
export interface AbortSignalLike {
    readonly aborted: boolean;
    /** Calls `listener` once on abort; returns a function that unregisters it. */
    onAbort(listener: () => void): () => void;
}

export function createAbortController(): { signal: AbortSignalLike; abort(): void } {
    const listeners = new Set<() => void>();
    let aborted = false;
    return {
        signal: {
            get aborted() {
                return aborted;
            },
            onAbort(listener: () => void) {
                if (aborted) {
                    listener();
                    return () => undefined;
                }
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        },
        abort() {
            if (aborted) {
                return;
            }
            aborted = true;
            for (const listener of [...listeners]) {
                listener();
            }
            listeners.clear();
        },
    };
}

export interface McpServerInfo {
    name: string;
    title: string;
    version: string;
}

export interface McpHttpServerOptions {
    info: McpServerInfo;
    instructions: string;
    /** Read on every request so tools can be enabled or disabled while running. */
    tools: () => McpTool[];
    log?: (message: string) => void;
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number | null;
    method?: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

export function textResult(text: string, isError = false): McpToolResult {
    return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/** Picks the protocol version to answer `initialize` with. */
export function negotiateProtocolVersion(requested: unknown): string {
    if (typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
        return requested;
    }
    return MCP_PROTOCOL_VERSIONS[0];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(hostHeader: string): string {
    const trimmed = hostHeader.trim().toLowerCase();
    if (trimmed.startsWith('[')) {
        const end = trimmed.indexOf(']');
        return end > 0 ? trimmed.slice(0, end + 1) : trimmed;
    }
    const colon = trimmed.lastIndexOf(':');
    return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

/** True when a Host header names this machine. A missing header is refused. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
    return hostHeader !== undefined && LOOPBACK_HOSTS.has(hostnameOf(hostHeader));
}

/** True when a request may proceed given its Origin header. Agents send none; browsers always do. */
export function isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined || origin.length === 0) {
        return true;
    }
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    } catch {
        return false;
    }
}

export class McpHttpServer {
    private server?: http.Server;

    constructor(private readonly options: McpHttpServerOptions) {}

    get port(): number | undefined {
        const address = this.server?.address();
        return address && typeof address === 'object' ? (address as AddressInfo).port : undefined;
    }

    /** Listens on 127.0.0.1. Pass port 0 to let the OS choose (used by tests). */
    start(port: number): Promise<void> {
        if (this.server) {
            return Promise.resolve();
        }
        const server = http.createServer((req, res) => {
            this.handle(req, res).catch((error) => {
                this.options.log?.(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) {
                    this.sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
                } else {
                    res.end();
                }
            });
        });
        // Tool calls may wait for a breakpoint, so do not cut slow requests off.
        server.requestTimeout = 0;
        server.keepAliveTimeout = 5000;
        return new Promise((resolve, reject) => {
            const onError = (error: Error) => {
                server.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                server.on('error', (error) => this.options.log?.(`MCP server error: ${error.message}`));
                this.server = server;
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
        });
    }

    stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (!server) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        });
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!isLoopbackHost(req.headers.host)) {
            this.sendPlain(res, 403, 'Forbidden: the GLuaLS MCP server only accepts requests addressed to localhost.');
            return;
        }
        if (!isAllowedOrigin(firstHeader(req.headers.origin))) {
            this.sendPlain(res, 403, 'Forbidden: cross-origin requests are not allowed.');
            return;
        }

        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== MCP_ENDPOINT_PATH && url.pathname !== `${MCP_ENDPOINT_PATH}/`) {
            this.sendPlain(res, 404, `Not found. The MCP endpoint is ${MCP_ENDPOINT_PATH}.`);
            return;
        }

        if (req.method !== 'POST') {
            // No server-initiated stream and no sessions to delete.
            res.setHeader('Allow', 'POST');
            this.sendPlain(res, 405, 'Method not allowed. Send JSON-RPC messages with POST.');
            return;
        }

        let body: string;
        try {
            body = await readBody(req);
        } catch (error) {
            this.sendPlain(res, 413, error instanceof Error ? error.message : 'Request body too large.');
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            this.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } });
            return;
        }

        const signal = createAbortSignal(res);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        if (messages.length === 0) {
            this.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_REQUEST, message: 'Empty batch' } });
            return;
        }
        const responses: JsonRpcResponse[] = [];
        for (const message of messages) {
            const response = await this.dispatch(message, signal);
            if (response) {
                responses.push(response);
            }
        }

        if (responses.length === 0) {
            // Only notifications or client responses: acknowledge without a body.
            res.statusCode = 202;
            res.end();
            return;
        }
        this.sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
    }

    private async dispatch(message: unknown, signal: AbortSignalLike): Promise<JsonRpcResponse | undefined> {
        if (!message || typeof message !== 'object') {
            return { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_REQUEST, message: 'Invalid request' } };
        }
        const request = message as JsonRpcRequest;
        const hasId = request.id !== undefined && request.id !== null;
        if (typeof request.method !== 'string') {
            // A response to something we never sent, or garbage.
            return hasId ? { jsonrpc: '2.0', id: request.id!, error: { code: JSON_RPC_INVALID_REQUEST, message: 'Invalid request' } } : undefined;
        }
        if (!hasId) {
            // Notifications such as notifications/initialized need no answer.
            return undefined;
        }
        const id = request.id!;
        const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {};

        switch (request.method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: this.options.info,
                        instructions: this.options.instructions,
                    },
                };
            case 'ping':
                return { jsonrpc: '2.0', id, result: {} };
            case 'tools/list':
                return { jsonrpc: '2.0', id, result: { tools: this.options.tools().map((tool) => tool.definition) } };
            case 'tools/call':
                return this.callTool(id, params, signal);
            default:
                return { jsonrpc: '2.0', id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Method not found: ${request.method}` } };
        }
    }

    private async callTool(id: string | number, params: Record<string, unknown>, signal: AbortSignalLike): Promise<JsonRpcResponse> {
        const name = typeof params.name === 'string' ? params.name : '';
        const tool = this.options.tools().find((candidate) => candidate.definition.name === name);
        if (!tool) {
            return { jsonrpc: '2.0', id, error: { code: JSON_RPC_INVALID_PARAMS, message: `Unknown tool: ${name}` } };
        }
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? params.arguments as Record<string, unknown>
            : {};
        try {
            return { jsonrpc: '2.0', id, result: await tool.call(args, signal) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { jsonrpc: '2.0', id, result: textResult(message, true) };
        }
    }

    private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
        const body = JSON.stringify(payload);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.end(body);
    }

    private sendPlain(res: http.ServerResponse, status: number, text: string): void {
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(text);
    }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Request body too large.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** Aborts when the client hangs up before we answer, so long waits can stop early. */
function createAbortSignal(res: http.ServerResponse): AbortSignalLike {
    const controller = createAbortController();
    res.on('close', () => {
        if (!res.writableFinished) {
            controller.abort();
        }
    });
    return controller.signal;
}
