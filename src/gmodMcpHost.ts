import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { GMOD_REALMS, GmodControlResult, GmodRealm, normalizeGmodRealm } from './debugger/gmod_debugger/GmodDebugControlService';

type GmodMcpToolName =
    | 'run_lua'
    | 'run_command'
    | 'run_file'
    | 'get_output'
    | 'get_errors'
    | 'get_debug_state'
    | 'list_realms';

type GmodMcpErrorCode =
    | 'E_AUTH_REQUIRED'
    | 'E_ROUTE_NOT_FOUND'
    | 'E_RATE_LIMIT'
    | 'E_INVALID_JSON'
    | 'E_INVALID_REQUEST'
    | 'E_TOOL_NOT_ALLOWED'
    | 'E_DEBUG_SESSION_MISSING'
    | 'E_BACKEND_FAILURE'
    | 'E_BACKEND_REJECTED'
    | 'E_FORBIDDEN_REMOTE'
    | 'E_HOST_DISABLED'
    | 'E_INTERNAL';

interface GmodMcpHostOptions {
    readonly executeControlCommand: (command: 'runLua' | 'runCommand' | 'runFile', args: Record<string, unknown>) => Promise<GmodControlResult>;
    readonly getDebugState: () => Record<string, unknown>;
    readonly getCurrentRealm: () => GmodRealm;
}

interface GmodMcpRequestPayload {
    readonly request_id?: unknown;
    readonly tool?: unknown;
    readonly arguments?: unknown;
}

interface GmodMcpOutputEntry {
    readonly timestamp: string;
    readonly source: string;
    readonly level: 'info' | 'error';
    readonly message: string;
    readonly metadata?: Record<string, unknown>;
}

interface GmodMcpAuditEntry {
    readonly timestamp: string;
    readonly requestId: string;
    readonly event: string;
    readonly success: boolean;
    readonly code: string;
    readonly details?: Record<string, unknown>;
}

interface GmodMcpSuccessResponse {
    readonly ok: true;
    readonly code: 'OK';
    readonly request_id: string;
    readonly tool?: GmodMcpToolName;
    readonly timestamp: string;
    readonly data: unknown;
}

interface GmodMcpErrorResponse {
    readonly ok: false;
    readonly code: GmodMcpErrorCode;
    readonly request_id: string;
    readonly tool?: string;
    readonly timestamp: string;
    readonly error: {
        readonly message: string;
        readonly details?: unknown;
    };
}

interface GmodMcpHealth {
    readonly enabled: boolean;
    readonly running: boolean;
    readonly host: string;
    readonly port: number;
    readonly startedAt?: string;
    readonly tokenHint?: string;
    readonly rateLimitPerMinute: number;
}

class HostError extends Error {
    constructor(
        public readonly code: GmodMcpErrorCode,
        message: string,
        public readonly statusCode: number,
        public readonly details?: unknown
    ) {
        super(message);
    }
}

const MCP_TOOLS: ReadonlySet<GmodMcpToolName> = new Set([
    'run_lua',
    'run_command',
    'run_file',
    'get_output',
    'get_errors',
    'get_debug_state',
    'list_realms',
]);

export class GmodMcpHost implements vscode.Disposable {
    private readonly outputChannel = vscode.window.createOutputChannel('GMod MCP Host');
    private server?: http.Server;
    private authToken = '';
    private enabled = true;
    private startedAt?: Date;
    private port = 0;
    private rateLimitPerMinute = 60;
    private readonly host = '127.0.0.1';
    private readonly outputEntries: GmodMcpOutputEntry[] = [];
    private readonly errorEntries: GmodMcpOutputEntry[] = [];
    private readonly auditEntries: GmodMcpAuditEntry[] = [];
    private readonly rateLimitBuckets = new Map<string, number[]>();

    public constructor(
        private readonly options: GmodMcpHostOptions
    ) { }

    public async start(): Promise<void> {
        if (this.server) {
            return;
        }

        const config = this.readConfig();
        this.enabled = config.enabled;
        this.rateLimitPerMinute = config.rateLimitPerMinute;
        this.authToken = config.authToken;
        if (!this.enabled) {
            this.appendAudit({
                timestamp: new Date().toISOString(),
                requestId: 'host-start',
                event: 'host.disabled',
                success: false,
                code: 'E_HOST_DISABLED',
            });
            this.outputChannel.appendLine('[MCP] host disabled by configuration.');
            return;
        }

        const server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.respondWithError(res, this.createRequestId(), new HostError('E_INTERNAL', message, 500));
            });
        });
        server.keepAliveTimeout = 15_000;
        server.headersTimeout = 20_000;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(config.port, this.host, () => {
                server.removeListener('error', reject);
                resolve();
            });
        });

        this.server = server;
        this.startedAt = new Date();
        const address = server.address();
        if (address && typeof address !== 'string') {
            this.port = address.port;
        } else {
            this.port = config.port;
        }

        this.outputChannel.appendLine(`[MCP] listening on ${this.host}:${this.port} token:${this.getTokenHint()}`);
    }

    public async stop(): Promise<void> {
        if (!this.server) {
            return;
        }

        const server = this.server;
        this.server = undefined;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        this.outputChannel.appendLine('[MCP] host stopped.');
    }

    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    public getHealth(): GmodMcpHealth {
        return {
            enabled: this.enabled,
            running: !!this.server,
            host: this.host,
            port: this.port,
            startedAt: this.startedAt?.toISOString(),
            tokenHint: this.server ? this.getTokenHint() : undefined,
            rateLimitPerMinute: this.rateLimitPerMinute,
        };
    }

    public recordDebugOutput(payload: Record<string, unknown>): void {
        const rawMessage = typeof payload.message === 'string' ? payload.message : '';
        if (rawMessage.trim().length === 0) {
            return;
        }
        this.pushOutputEntry(this.outputEntries, {
            timestamp: this.coerceTimestamp(payload.timestamp),
            source: typeof payload.source === 'string' ? payload.source : 'debug',
            level: 'info',
            message: rawMessage,
            metadata: {
                severity: typeof payload.severity === 'number' ? payload.severity : undefined,
                realm: normalizeGmodRealm(payload.realm),
            },
        });
    }

    public recordControlResult(result: GmodControlResult): void {
        this.pushOutputEntry(this.outputEntries, {
            timestamp: new Date().toISOString(),
            source: 'control',
            level: result.ok ? 'info' : 'error',
            message: `command=${result.command} correlationId=${result.correlationId}`,
            metadata: {
                realm: result.realm,
                request: result.request,
                diagnostics: result.diagnostics,
                ok: result.ok,
            },
        });
        if (!result.ok) {
            this.pushOutputEntry(this.errorEntries, {
                timestamp: new Date().toISOString(),
                source: 'control',
                level: 'error',
                message: `Control command rejected: ${result.command}`,
                metadata: {
                    diagnostics: result.diagnostics,
                    correlationId: result.correlationId,
                },
            });
        }
    }

    public recordBackendError(message: string, details?: unknown): void {
        this.pushOutputEntry(this.errorEntries, {
            timestamp: new Date().toISOString(),
            source: 'backend',
            level: 'error',
            message,
            metadata: details && typeof details === 'object'
                ? details as Record<string, unknown>
                : undefined,
        });
    }

    public dispose(): void {
        this.stop().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[MCP] stop failed during dispose: ${message}`);
        });
        this.outputChannel.dispose();
    }

    private readConfig(): { enabled: boolean; port: number; authToken: string; rateLimitPerMinute: number; } {
        const config = vscode.workspace.getConfiguration('emmylua.gmod.mcp');
        const enabled = config.get<boolean>('enabled', true);
        const configuredPort = config.get<number>('port', 0);
        const port = Number.isFinite(configuredPort) ? Math.max(0, Math.floor(configuredPort)) : 0;
        const configuredRateLimit = config.get<number>('rateLimitPerMinute', 60);
        const rateLimitPerMinute = Number.isFinite(configuredRateLimit)
            ? Math.min(600, Math.max(1, Math.floor(configuredRateLimit)))
            : 60;
        const configuredToken = (config.get<string>('authToken', '') ?? '').trim();
        const authToken = configuredToken.length > 0
            ? configuredToken
            : crypto.randomBytes(24).toString('hex');
        return { enabled, port, authToken, rateLimitPerMinute };
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const path = (req.url ?? '').split('?')[0];
        const requestId = this.extractRequestId(req);
        const method = req.method ?? 'GET';
        const remoteAddress = req.socket.remoteAddress ?? 'unknown';

        if (!this.isLoopbackAddress(remoteAddress)) {
            this.respondWithError(res, requestId, new HostError('E_FORBIDDEN_REMOTE', 'Only local loopback requests are accepted.', 403));
            return;
        }

        if (!this.checkRateLimit(remoteAddress)) {
            this.respondWithError(res, requestId, new HostError('E_RATE_LIMIT', 'Rate limit exceeded.', 429, { rateLimitPerMinute: this.rateLimitPerMinute }));
            return;
        }

        if (!this.isAuthorized(req)) {
            this.respondWithError(res, requestId, new HostError('E_AUTH_REQUIRED', 'Missing or invalid MCP authentication token.', 401));
            return;
        }

        if (method === 'GET' && path === '/health') {
            this.respondWithSuccess(res, requestId, { ...this.getHealth(), tools: [...MCP_TOOLS] });
            return;
        }

        if (method === 'POST' && path === '/tool') {
            const payload = await this.readJsonBody(req);
            const toolName = typeof payload.tool === 'string' ? payload.tool : '';
            const tool = this.validateToolName(toolName);
            const args = this.coerceArgs(payload.arguments);
            const toolRequestId = typeof payload.request_id === 'string' && payload.request_id.trim().length > 0
                ? payload.request_id
                : requestId;
            try {
                const data = await this.executeTool(tool, args);
                this.appendAudit({
                    timestamp: new Date().toISOString(),
                    requestId: toolRequestId,
                    event: `tool.${tool}`,
                    success: true,
                    code: 'OK',
                });
                this.respondWithSuccess(res, toolRequestId, data, tool);
            } catch (error) {
                const hostError = this.normalizeError(error);
                this.appendAudit({
                    timestamp: new Date().toISOString(),
                    requestId: toolRequestId,
                    event: `tool.${tool}`,
                    success: false,
                    code: hostError.code,
                    details: hostError.details && typeof hostError.details === 'object'
                        ? hostError.details as Record<string, unknown>
                        : undefined,
                });
                this.respondWithError(res, toolRequestId, hostError, tool);
            }
            return;
        }

        this.respondWithError(res, requestId, new HostError('E_ROUTE_NOT_FOUND', `Unsupported route: ${method} ${path}`, 404));
    }

    private async executeTool(tool: GmodMcpToolName, args: Record<string, unknown>): Promise<unknown> {
        if ((tool === 'run_lua' || tool === 'run_command' || tool === 'run_file') && !this.hasActiveDebugSession()) {
            throw new HostError('E_DEBUG_SESSION_MISSING', 'No active GMod debug session.', 409);
        }

        switch (tool) {
            case 'run_lua': {
                const lua = typeof args.lua === 'string'
                    ? args.lua
                    : typeof args.chunk === 'string'
                        ? args.chunk
                        : '';
                if (lua.trim().length === 0) {
                    throw new HostError('E_INVALID_REQUEST', 'run_lua requires non-empty "lua" or "chunk".', 400);
                }
                const result = await this.options.executeControlCommand('runLua', {
                    lua,
                    realm: normalizeGmodRealm(args.realm ?? this.options.getCurrentRealm()),
                });
                this.handleControlResult(result);
                return result;
            }

            case 'run_command': {
                const command = typeof args.command === 'string' ? args.command : '';
                if (command.trim().length === 0) {
                    throw new HostError('E_INVALID_REQUEST', 'run_command requires non-empty "command".', 400);
                }
                const result = await this.options.executeControlCommand('runCommand', { command });
                this.handleControlResult(result);
                return result;
            }

            case 'run_file': {
                const filePath = typeof args.path === 'string'
                    ? args.path
                    : typeof args.file === 'string'
                        ? args.file
                        : '';
                if (filePath.trim().length === 0) {
                    throw new HostError('E_INVALID_REQUEST', 'run_file requires non-empty "path" or "file".', 400);
                }
                const result = await this.options.executeControlCommand('runFile', {
                    path: filePath,
                    realm: normalizeGmodRealm(args.realm ?? this.options.getCurrentRealm()),
                });
                this.handleControlResult(result);
                return result;
            }

            case 'get_output': {
                const limit = this.resolveLimit(args.limit, 200, 50);
                return {
                    total: this.outputEntries.length,
                    items: this.outputEntries.slice(-limit),
                };
            }

            case 'get_errors': {
                const limit = this.resolveLimit(args.limit, 200, 50);
                return {
                    total: this.errorEntries.length,
                    items: this.errorEntries.slice(-limit),
                };
            }

            case 'get_debug_state':
                return {
                    ...this.options.getDebugState(),
                    mcpHost: this.getHealth(),
                    outputCount: this.outputEntries.length,
                    errorCount: this.errorEntries.length,
                    auditCount: this.auditEntries.length,
                };

            case 'list_realms':
                return {
                    available: [...GMOD_REALMS],
                    current: this.options.getCurrentRealm(),
                };
        }
    }

    private handleControlResult(result: GmodControlResult): void {
        this.recordControlResult(result);
        if (!result.ok) {
            throw new HostError('E_BACKEND_REJECTED', 'Backend rejected control command.', 422, {
                command: result.command,
                realm: result.realm,
                correlationId: result.correlationId,
                diagnostics: result.diagnostics,
            });
        }
    }

    private hasActiveDebugSession(): boolean {
        const debugState = this.options.getDebugState();
        const active = debugState['hasActiveSession'];
        return active === true;
    }

    private resolveLimit(rawLimit: unknown, max: number, fallback: number): number {
        if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
            return fallback;
        }
        return Math.max(1, Math.min(max, Math.floor(rawLimit)));
    }

    private validateToolName(value: string): GmodMcpToolName {
        if (!MCP_TOOLS.has(value as GmodMcpToolName)) {
            throw new HostError('E_TOOL_NOT_ALLOWED', `Tool "${value}" is not allow-listed.`, 403, {
                allowedTools: [...MCP_TOOLS],
            });
        }
        return value as GmodMcpToolName;
    }

    private coerceArgs(args: unknown): Record<string, unknown> {
        if (args == null) {
            return {};
        }
        if (typeof args !== 'object' || Array.isArray(args)) {
            throw new HostError('E_INVALID_REQUEST', 'Request "arguments" must be an object.', 400);
        }
        return args as Record<string, unknown>;
    }

    private async readJsonBody(req: http.IncomingMessage): Promise<GmodMcpRequestPayload> {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
            const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            total += part.length;
            if (total > 64 * 1024) {
                throw new HostError('E_INVALID_REQUEST', 'Request body too large.', 413);
            }
            chunks.push(part);
        }

        if (chunks.length === 0) {
            return {};
        }

        const raw = Buffer.concat(chunks).toString('utf8');
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new HostError('E_INVALID_REQUEST', 'JSON payload must be an object.', 400);
            }
            return parsed as GmodMcpRequestPayload;
        } catch (error) {
            if (error instanceof HostError) {
                throw error;
            }
            throw new HostError('E_INVALID_JSON', 'Invalid JSON payload.', 400);
        }
    }

    private extractRequestId(req: http.IncomingMessage): string {
        const headerValue = req.headers['x-request-id'];
        if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
            return headerValue.slice(0, 128);
        }
        return this.createRequestId();
    }

    private createRequestId(): string {
        return `mcp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    }

    private isLoopbackAddress(address: string): boolean {
        return address === '127.0.0.1'
            || address === '::1'
            || address === '::ffff:127.0.0.1';
    }

    private checkRateLimit(key: string): boolean {
        const now = Date.now();
        const windowStart = now - 60_000;
        const bucket = this.rateLimitBuckets.get(key) ?? [];
        const updated = bucket.filter((timestamp) => timestamp >= windowStart);
        if (updated.length >= this.rateLimitPerMinute) {
            this.rateLimitBuckets.set(key, updated);
            return false;
        }
        updated.push(now);
        this.rateLimitBuckets.set(key, updated);
        return true;
    }

    private isAuthorized(req: http.IncomingMessage): boolean {
        const authHeader = req.headers.authorization;
        const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length).trim()
            : '';
        const explicitToken = typeof req.headers['x-emmy-mcp-token'] === 'string'
            ? req.headers['x-emmy-mcp-token']
            : '';
        const incomingToken = bearerToken || explicitToken;
        if (!incomingToken) {
            return false;
        }
        const expected = Buffer.from(this.authToken, 'utf8');
        const actual = Buffer.from(incomingToken, 'utf8');
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }

    private respondWithSuccess(res: http.ServerResponse, requestId: string, data: unknown, tool?: GmodMcpToolName): void {
        const payload: GmodMcpSuccessResponse = {
            ok: true,
            code: 'OK',
            request_id: requestId,
            tool,
            timestamp: new Date().toISOString(),
            data,
        };
        this.respondJson(res, 200, payload);
    }

    private respondWithError(res: http.ServerResponse, requestId: string, error: HostError, tool?: string): void {
        if (error.code === 'E_BACKEND_FAILURE' || error.code === 'E_INTERNAL') {
            this.pushOutputEntry(this.errorEntries, {
                timestamp: new Date().toISOString(),
                source: 'mcp',
                level: 'error',
                message: error.message,
                metadata: error.details && typeof error.details === 'object'
                    ? error.details as Record<string, unknown>
                    : undefined,
            });
        }

        const payload: GmodMcpErrorResponse = {
            ok: false,
            code: error.code,
            request_id: requestId,
            tool,
            timestamp: new Date().toISOString(),
            error: {
                message: error.message,
                details: error.details,
            },
        };
        this.respondJson(res, error.statusCode, payload);
    }

    private respondJson(res: http.ServerResponse, statusCode: number, payload: GmodMcpSuccessResponse | GmodMcpErrorResponse): void {
        const serialized = JSON.stringify(payload);
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(serialized);
    }

    private appendAudit(entry: GmodMcpAuditEntry): void {
        this.pushOutputEntry(this.outputEntries, {
            timestamp: entry.timestamp,
            source: 'audit',
            level: entry.success ? 'info' : 'error',
            message: `${entry.event} code=${entry.code}`,
            metadata: {
                requestId: entry.requestId,
                details: entry.details,
            },
        });
        this.pushBounded(this.auditEntries, entry, 500);
        this.outputChannel.appendLine(`[MCP][AUDIT] ${JSON.stringify(entry)}`);
    }

    private normalizeError(error: unknown): HostError {
        if (error instanceof HostError) {
            return error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No active GMod debug session')) {
            return new HostError('E_DEBUG_SESSION_MISSING', message, 409);
        }
        return new HostError('E_BACKEND_FAILURE', message, 502);
    }

    private pushOutputEntry(target: GmodMcpOutputEntry[], entry: GmodMcpOutputEntry): void {
        this.pushBounded(target, entry, 1000);
    }

    private pushBounded<T>(target: T[], value: T, maxSize: number): void {
        target.push(value);
        if (target.length > maxSize) {
            target.splice(0, target.length - maxSize);
        }
    }

    private getTokenHint(): string {
        if (this.authToken.length <= 8) {
            return this.authToken;
        }
        return `${this.authToken.slice(0, 4)}...${this.authToken.slice(-4)}`;
    }

    private coerceTimestamp(value: unknown): string {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return new Date(value).toISOString();
        }
        return new Date().toISOString();
    }
}
