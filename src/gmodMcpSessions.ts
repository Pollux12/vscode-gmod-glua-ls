import type * as vscode from 'vscode';

const SERVER_DEBUG_TYPE = 'gluals_gmod';
const CLIENT_DEBUG_TYPE = 'gluals_gmod_client';
const DEFAULT_MAX_RETAINED_TERMINATED = 20;
const MAX_METADATA_BYTES = 1024;
const MAX_WORKSPACE_PATH_BYTES = 8 * 1024;

export type GmodMcpSessionKind = 'server' | 'client';
export type GmodMcpSessionState = 'starting' | 'connected' | 'disconnected' | 'terminated';
export type GmodMcpExecutionState = 'running' | 'paused';
export type GmodMcpSessionCapability =
    | 'serverControl'
    | 'serverTelemetry'
    | 'clientTelemetry'
    | 'pausedEvaluation'
    | 'clientScreenshot';

export interface GmodMcpWorkspaceFolder {
    readonly name: string;
    readonly path: string;
}

/** A serializable snapshot of a debugger session exposed to MCP consumers. */
export interface GmodMcpSessionDescriptor {
    readonly sessionId: string;
    readonly sessionName: string;
    readonly debugType: typeof SERVER_DEBUG_TYPE | typeof CLIENT_DEBUG_TYPE;
    readonly kind: GmodMcpSessionKind;
    readonly workspaceFolder?: GmodMcpWorkspaceFolder;
    readonly host?: string;
    readonly port?: number;
    readonly state: GmodMcpSessionState;
    readonly executionState?: GmodMcpExecutionState;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly capabilities: readonly GmodMcpSessionCapability[];
}

export interface GmodMcpServerControlTarget {
    readonly descriptor: GmodMcpSessionDescriptor;
    readonly session: vscode.DebugSession;
}

export interface GmodMcpClientScreenshotTarget {
    readonly descriptor: GmodMcpSessionDescriptor;
    readonly session: vscode.DebugSession;
}

export type GmodMcpSessionResolutionErrorCode =
    | 'NO_CONNECTED_SERVER'
    | 'AMBIGUOUS_SERVER'
    | 'NO_CONNECTED_CLIENT'
    | 'AMBIGUOUS_CLIENT'
    | 'UNKNOWN_SESSION'
    | 'CLIENT_SESSION'
    | 'SERVER_SESSION'
    | 'TERMINATED_SESSION'
    | 'SESSION_NOT_CONNECTED'
    | 'CLIENT_PAUSED';

export class GmodMcpSessionResolutionError extends Error {
    public constructor(
        public readonly code: GmodMcpSessionResolutionErrorCode,
        message: string,
        public readonly availableSessions: readonly GmodMcpSessionDescriptor[]
    ) {
        super(message);
        this.name = 'GmodMcpSessionResolutionError';
    }
}

export interface GmodMcpSessionRegistryOptions {
    readonly maxRetainedTerminated?: number;
    readonly now?: () => Date;
}

interface RegisteredSession {
    descriptor: GmodMcpSessionDescriptor;
    session?: vscode.DebugSession;
}

/**
 * Owns the extension's MCP-visible debugger sessions. It deliberately does not
 * use VS Code's active session, because MCP requests must target predictably.
 */
export class GmodMcpSessionRegistry {
    private readonly sessions = new Map<string, RegisteredSession>();
    private readonly maxRetainedTerminated: number;
    private readonly now: () => Date;

    public constructor(options: GmodMcpSessionRegistryOptions = {}) {
        const configuredMaximum = options.maxRetainedTerminated ?? DEFAULT_MAX_RETAINED_TERMINATED;
        this.maxRetainedTerminated = Number.isFinite(configuredMaximum)
            ? Math.max(0, Math.floor(configuredMaximum))
            : DEFAULT_MAX_RETAINED_TERMINATED;
        this.now = options.now ?? (() => new Date());
    }

    public register(session: vscode.DebugSession): GmodMcpSessionDescriptor | undefined {
        const sessionType = getSessionType(session.type);
        if (!sessionType) {
            return undefined;
        }

        const descriptor: GmodMcpSessionDescriptor = {
            sessionId: truncateUtf8(session.id, MAX_METADATA_BYTES),
            sessionName: truncateUtf8(session.name, MAX_METADATA_BYTES),
            debugType: sessionType.debugType,
            kind: sessionType.kind,
            workspaceFolder: getWorkspaceFolder(session),
            host: getConfiguredHost(session),
            port: getConfiguredPort(session),
            state: 'starting',
            startedAt: this.now().toISOString(),
            capabilities: getCapabilities(sessionType.kind, 'starting'),
        };
        this.sessions.set(descriptor.sessionId, { descriptor, session });
        return copyDescriptor(descriptor);
    }

    public markConnected(sessionId: string): GmodMcpSessionDescriptor | undefined {
        const registered = this.sessions.get(truncateUtf8(sessionId, MAX_METADATA_BYTES));
        if (!registered || registered.descriptor.state === 'terminated') {
            return undefined;
        }

        registered.descriptor = this.withState(registered.descriptor, 'connected', {
            executionState: 'running',
        });
        return copyDescriptor(registered.descriptor);
    }

    /** Keeps a reconnectable debug session, but removes it from MCP control availability. */
    public markDisconnected(sessionId: string): GmodMcpSessionDescriptor | undefined {
        const registered = this.sessions.get(truncateUtf8(sessionId, MAX_METADATA_BYTES));
        if (!registered || registered.descriptor.state === 'terminated') {
            return undefined;
        }

        registered.descriptor = this.withState(registered.descriptor, 'disconnected', {
            executionState: undefined,
        });
        return copyDescriptor(registered.descriptor);
    }

    public markTerminated(sessionId: string): GmodMcpSessionDescriptor | undefined {
        const registered = this.sessions.get(truncateUtf8(sessionId, MAX_METADATA_BYTES));
        if (!registered) {
            return undefined;
        }

        if (registered.descriptor.state === 'terminated') {
            return this.getDescriptor(sessionId);
        }

        registered.descriptor = this.withState(registered.descriptor, 'terminated', {
            endedAt: this.now().toISOString(),
            executionState: undefined,
        });
        const descriptor = copyDescriptor(registered.descriptor);
        // Retained history needs metadata, not a live VS Code session object.
        registered.session = undefined;
        this.pruneTerminatedSessions();
        return descriptor;
    }

    public markPaused(sessionId: string): GmodMcpSessionDescriptor | undefined {
        return this.markExecutionState(sessionId, 'paused');
    }

    public markRunning(sessionId: string): GmodMcpSessionDescriptor | undefined {
        return this.markExecutionState(sessionId, 'running');
    }

    public getDescriptor(sessionId: string): GmodMcpSessionDescriptor | undefined {
        const registered = this.sessions.get(truncateUtf8(sessionId, MAX_METADATA_BYTES));
        return registered ? copyDescriptor(registered.descriptor) : undefined;
    }

    public getDescriptors(): GmodMcpSessionDescriptor[] {
        return [...this.sessions.values()]
            .map(({ descriptor }) => descriptor)
            .sort(compareDescriptors)
            .map(copyDescriptor);
    }

    public resolveServerControlTarget(sessionId?: string): GmodMcpServerControlTarget {
        if (sessionId !== undefined) {
            return this.resolveExplicitServerControlTarget(sessionId);
        }

        const connectedServers = [...this.sessions.values()]
            .filter(({ descriptor }) => descriptor.kind === 'server' && descriptor.state === 'connected')
            .sort((left, right) => compareDescriptors(left.descriptor, right.descriptor));

        if (connectedServers.length === 0) {
            throw new GmodMcpSessionResolutionError(
                'NO_CONNECTED_SERVER',
                'No connected Garry\'s Mod server debugger session is available.',
                this.getDescriptors()
            );
        }
        if (connectedServers.length > 1) {
            throw new GmodMcpSessionResolutionError(
                'AMBIGUOUS_SERVER',
                'Multiple connected Garry\'s Mod server debugger sessions are available; specify a session ID.',
                connectedServers.map(({ descriptor }) => copyDescriptor(descriptor))
            );
        }

        return this.toServerControlTarget(connectedServers[0]);
    }

    public resolveClientScreenshotTarget(sessionId?: string): GmodMcpClientScreenshotTarget {
        if (sessionId !== undefined) {
            return this.resolveExplicitClientScreenshotTarget(sessionId);
        }

        const connectedClients = [...this.sessions.values()]
            .filter(({ descriptor }) => descriptor.kind === 'client' && descriptor.state === 'connected')
            .sort((left, right) => compareDescriptors(left.descriptor, right.descriptor));
        const eligibleClients = connectedClients
            .filter(({ descriptor }) => descriptor.executionState === 'running');

        if (eligibleClients.length === 0) {
            const pausedClient = connectedClients.find(({ descriptor }) => descriptor.executionState === 'paused');
            throw new GmodMcpSessionResolutionError(
                pausedClient ? 'CLIENT_PAUSED' : 'NO_CONNECTED_CLIENT',
                pausedClient
                    ? 'Connected Garry\'s Mod client debugger sessions are paused and cannot capture screenshots.'
                    : 'No connected Garry\'s Mod client debugger session is available for screenshot capture.',
                this.getDescriptors()
            );
        }
        if (eligibleClients.length > 1) {
            throw new GmodMcpSessionResolutionError(
                'AMBIGUOUS_CLIENT',
                'Multiple connected Garry\'s Mod client debugger sessions are available; specify a session ID.',
                eligibleClients.map(({ descriptor }) => copyDescriptor(descriptor))
            );
        }

        return this.toClientScreenshotTarget(eligibleClients[0]);
    }

    private resolveExplicitServerControlTarget(sessionId: string): GmodMcpServerControlTarget {
        const registered = this.sessions.get(truncateUtf8(sessionId, MAX_METADATA_BYTES));
        if (!registered) {
            throw new GmodMcpSessionResolutionError(
                'UNKNOWN_SESSION',
                `Debugger session '${sessionId}' is not registered.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.kind === 'client') {
            throw new GmodMcpSessionResolutionError(
                'CLIENT_SESSION',
                `Debugger session '${sessionId}' is a client session and cannot control the server.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.state === 'terminated') {
            throw new GmodMcpSessionResolutionError(
                'TERMINATED_SESSION',
                `Debugger session '${sessionId}' has terminated.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.state === 'disconnected') {
            throw new GmodMcpSessionResolutionError(
                'SESSION_NOT_CONNECTED',
                `Debugger session '${sessionId}' is disconnected and cannot accept server control until it reconnects.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.state !== 'connected') {
            throw new GmodMcpSessionResolutionError(
                'SESSION_NOT_CONNECTED',
                `Debugger session '${sessionId}' is still starting and cannot accept server control.`,
                this.getDescriptors()
            );
        }

        return this.toServerControlTarget(registered);
    }

    private resolveExplicitClientScreenshotTarget(sessionId: string): GmodMcpClientScreenshotTarget {
        const registered = this.sessions.get(truncateUtf8(sessionId, MAX_METADATA_BYTES));
        if (!registered) {
            throw new GmodMcpSessionResolutionError(
                'UNKNOWN_SESSION',
                `Debugger session '${sessionId}' is not registered.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.kind === 'server') {
            throw new GmodMcpSessionResolutionError(
                'SERVER_SESSION',
                `Debugger session '${sessionId}' is a server session and cannot capture a client screenshot.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.state === 'terminated') {
            throw new GmodMcpSessionResolutionError(
                'TERMINATED_SESSION',
                `Debugger session '${sessionId}' has terminated.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.state !== 'connected') {
            throw new GmodMcpSessionResolutionError(
                'SESSION_NOT_CONNECTED',
                `Debugger session '${sessionId}' is not connected and cannot capture a screenshot.`,
                this.getDescriptors()
            );
        }
        if (registered.descriptor.executionState === 'paused') {
            throw new GmodMcpSessionResolutionError(
                'CLIENT_PAUSED',
                `Debugger session '${sessionId}' is paused and cannot capture a screenshot.`,
                this.getDescriptors()
            );
        }

        return this.toClientScreenshotTarget(registered);
    }

    private toServerControlTarget(registered: RegisteredSession): GmodMcpServerControlTarget {
        if (registered.descriptor.state !== 'connected' || !registered.session) {
            throw new GmodMcpSessionResolutionError(
                'SESSION_NOT_CONNECTED',
                `Debugger session '${registered.descriptor.sessionId}' is not available for server control.`,
                this.getDescriptors()
            );
        }
        return { descriptor: copyDescriptor(registered.descriptor), session: registered.session };
    }

    private toClientScreenshotTarget(registered: RegisteredSession): GmodMcpClientScreenshotTarget {
        if (registered.descriptor.state !== 'connected'
            || registered.descriptor.executionState !== 'running'
            || !registered.session) {
            throw new GmodMcpSessionResolutionError(
                registered.descriptor.executionState === 'paused' ? 'CLIENT_PAUSED' : 'SESSION_NOT_CONNECTED',
                `Debugger session '${registered.descriptor.sessionId}' is not available for screenshot capture.`,
                this.getDescriptors()
            );
        }
        return { descriptor: copyDescriptor(registered.descriptor), session: registered.session };
    }

    private markExecutionState(
        sessionId: string,
        executionState: GmodMcpExecutionState
    ): GmodMcpSessionDescriptor | undefined {
        const registered = this.sessions.get(truncateUtf8(sessionId, MAX_METADATA_BYTES));
        if (!registered || registered.descriptor.state !== 'connected') {
            return undefined;
        }
        registered.descriptor = this.withState(registered.descriptor, 'connected', { executionState });
        return copyDescriptor(registered.descriptor);
    }

    private pruneTerminatedSessions(): void {
        const terminated = [...this.sessions.values()]
            .filter(({ descriptor }) => descriptor.state === 'terminated')
            .sort((left, right) => compareTerminatedDescriptors(left.descriptor, right.descriptor));
        const toRemove = terminated.length - this.maxRetainedTerminated;
        for (let index = 0; index < toRemove; index += 1) {
            this.sessions.delete(terminated[index].descriptor.sessionId);
        }
    }

    private withState(
        descriptor: GmodMcpSessionDescriptor,
        state: GmodMcpSessionState,
        changes: Partial<GmodMcpSessionDescriptor> = {}
    ): GmodMcpSessionDescriptor {
        const next: GmodMcpSessionDescriptor = {
            ...descriptor,
            ...changes,
            state,
            capabilities: getCapabilities(descriptor.kind, state, changes.executionState ?? descriptor.executionState),
        };
        if (state !== 'connected') {
            delete (next as { executionState?: GmodMcpExecutionState }).executionState;
        }
        return next;
    }
}

function getSessionType(debugType: string): Pick<GmodMcpSessionDescriptor, 'debugType' | 'kind'> | undefined {
    if (debugType === SERVER_DEBUG_TYPE) {
        return { debugType: SERVER_DEBUG_TYPE, kind: 'server' };
    }
    if (debugType === CLIENT_DEBUG_TYPE) {
        return { debugType: CLIENT_DEBUG_TYPE, kind: 'client' };
    }
    return undefined;
}

function getWorkspaceFolder(session: vscode.DebugSession): GmodMcpWorkspaceFolder | undefined {
    const folder = session.workspaceFolder;
    if (!folder) {
        return undefined;
    }
    return {
        name: truncateUtf8(folder.name, MAX_METADATA_BYTES),
        path: truncateUtf8(folder.uri.fsPath, MAX_WORKSPACE_PATH_BYTES),
    };
}

function getConfiguredHost(session: vscode.DebugSession): string | undefined {
    const host = session.configuration.host;
    return typeof host === 'string' ? truncateUtf8(host, MAX_METADATA_BYTES) : undefined;
}

function getConfiguredPort(session: vscode.DebugSession): number | undefined {
    const port = session.configuration.port;
    return typeof port === 'number' && Number.isFinite(port) ? port : undefined;
}

function getCapabilities(
    kind: GmodMcpSessionKind,
    state: GmodMcpSessionState,
    executionState?: GmodMcpExecutionState
): readonly GmodMcpSessionCapability[] {
    if (state !== 'connected') {
        return [];
    }
    return kind === 'server'
        ? ['serverControl', 'serverTelemetry']
        : executionState === 'paused'
            ? ['clientTelemetry', 'pausedEvaluation']
            : ['clientTelemetry', 'clientScreenshot'];
}

function compareDescriptors(left: GmodMcpSessionDescriptor, right: GmodMcpSessionDescriptor): number {
    return left.startedAt.localeCompare(right.startedAt) || left.sessionId.localeCompare(right.sessionId);
}

function compareTerminatedDescriptors(left: GmodMcpSessionDescriptor, right: GmodMcpSessionDescriptor): number {
    return (left.endedAt ?? '').localeCompare(right.endedAt ?? '') || left.sessionId.localeCompare(right.sessionId);
}

function truncateUtf8(value: string, maximumBytes: number): string {
    if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
        return value;
    }

    const marker = ' [TRUNCATED]';
    const contentBudget = maximumBytes - Buffer.byteLength(marker, 'utf8');
    let contentBytes = 0;
    let end = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (contentBytes + characterBytes > contentBudget) {
            break;
        }
        contentBytes += characterBytes;
        end += character.length;
    }
    return `${value.slice(0, end)}${marker}`;
}

function copyDescriptor(descriptor: GmodMcpSessionDescriptor): GmodMcpSessionDescriptor {
    return {
        ...descriptor,
        workspaceFolder: descriptor.workspaceFolder && { ...descriptor.workspaceFolder },
        capabilities: [...descriptor.capabilities],
    };
}
