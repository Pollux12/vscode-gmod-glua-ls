import * as vscode from 'vscode';

import { McpEventLog } from './eventLog';
import { parseGmodLuaError } from '../debugger/gmod_debugger/GmodLuaError';
import { getAutoDetectedWorkspaceGarrysmodPath } from '../debugger/gmod_debugger/GmodDebugSetupWizard';

/** The server-realm debugger type. The client debugger (`gluals_gmod_client`) is out of scope. */
export const GMOD_SERVER_DEBUG_TYPE = 'gluals_gmod';
const THREAD_ID = 1;

export interface PauseInfo {
    /** Increments on every stop, so references from an older stop can be recognised. */
    id: number;
    reason: string;
    since: number;
}

export interface SessionState {
    connected: boolean;
    ready: boolean;
    notReadyReason?: string;
    paused: boolean;
    pauseReason?: string;
    protocolVersion?: string;
    moduleVersion?: string;
    sourceRoot?: string;
    sourceFileMap?: Record<string, string>;
}

export interface StackFrameInfo {
    index: number;
    func: string;
    /** Chunk name as Lua reports it, e.g. `@addons/x/lua/autorun/init.lua` or `=[C]`. */
    file: string;
    localPath?: string;
    line: number;
}

export interface RunReport {
    ok?: boolean;
    phase?: string;
    error?: string;
    traceback?: string[];
    returns?: string[];
    returnCount?: number;
    output?: string;
    durationMs?: number;
    bridgeVersion?: number;
}

/** A server_run_lua call whose reply went to the agent before the chunk finished. */
export interface LateRun {
    label: string;
    startedAt: number;
    report?: RunReport | null;
    error?: string;
    settled: Promise<void>;
}

export interface LimitedLogpoint {
    breakpoint: vscode.SourceBreakpoint;
    /** What the logpoint's console lines start with. */
    prefix: string;
    maxHits?: number;
    hits: number;
    expiresAt?: number;
    timer?: NodeJS.Timeout;
}

interface TrackedSession {
    session: vscode.DebugSession;
    startedAt: number;
    pause?: PauseInfo;
    terminated: boolean;
    /** When we last sent continue or a step; the adapter reports "paused" until gm_rdb confirms. */
    resumedAt?: number;
}

const RESUME_SETTLE_MS = 2000;
/** Set on the debug configuration of sessions the MCP starts. */
const AGENT_SESSION_MARKER = '__gluaslMcpAgent';

export type StepKind = 'continue' | 'step_over' | 'step_in' | 'step_out';

const STEP_REQUESTS: Record<StepKind, string> = {
    continue: 'continue',
    step_over: 'next',
    step_in: 'stepIn',
    step_out: 'stepOut',
};

/**
 * Follows the GMod server debug session for the MCP tools: whether it is paused,
 * what it printed and which Lua errors it raised, and how to attach, step and inspect.
 */
export class GmodDebugBridge implements vscode.Disposable {
    readonly events = new McpEventLog();
    /** Breakpoints the agent created, so `clear` never removes the user's own. */
    readonly agentBreakpointIds = new Set<string>();
    /** Agent logpoints that remove themselves after a number of hits or seconds. */
    readonly limitedLogpoints = new Map<string, LimitedLogpoint>();
    /** Where "new" output starts per stream for a wait without a cursor: see buildMcpTools. */
    lastReplyCursors: { console?: number; errors?: number } = {};
    /** Console lines and errors gm_rdb replayed from before the latest connection; undefined for older modules. */
    lastBacklog?: number;
    /** Where the latest described pause stopped, for the banner on other tools' replies. */
    lastPauseLocation?: { pauseId: number; text: string };
    private readonly sessions = new Map<string, TrackedSession>();
    /** Sessions the MCP started, which detach may disconnect. The user's own stay attached. */
    private readonly agentStarted = new Set<string>();
    /** Sessions that ended. Their late messages must not bring them back. */
    private readonly ended = new Set<string>();
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pauseListeners = new Set<() => void>();
    private pauseCounter = 0;
    private readonly lateRuns: LateRun[] = [];

    constructor(private readonly log: (message: string) => void = () => undefined) {
        this.disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory(GMOD_SERVER_DEBUG_TYPE, {
                createDebugAdapterTracker: (session) => this.createTracker(session),
            }),
            vscode.debug.onDidStartDebugSession((session) => {
                if (session.type === GMOD_SERVER_DEBUG_TYPE) {
                    this.log(`Debug session started: ${session.name}`);
                    this.track(session);
                }
            }),
            vscode.debug.onDidTerminateDebugSession((session) => {
                if (session.type === GMOD_SERVER_DEBUG_TYPE) {
                    this.log(`Debug session ended: ${session.name}`);
                    this.markEnded(session);
                }
            }),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => this.onCustomEvent(event)),
            { dispose: this.events.onConsole((entry) => this.countLogpointHit(entry.text)) },
            vscode.debug.onDidChangeBreakpoints((event) => {
                for (const removed of event.removed) {
                    const limited = this.limitedLogpoints.get(removed.id);
                    if (limited) {
                        clearTimeout(limited.timer);
                        this.limitedLogpoints.delete(removed.id);
                    }
                }
            })
        );
        // Sessions that started before the MCP host did.
        if (vscode.debug.activeDebugSession?.type === GMOD_SERVER_DEBUG_TYPE) {
            this.track(vscode.debug.activeDebugSession);
        }
    }

    /** Removes `breakpoint` once it has printed `maxHits` lines or `maxSeconds` have passed. */
    limitLogpoint(breakpoint: vscode.SourceBreakpoint, prefix: string, maxHits?: number, maxSeconds?: number): void {
        const limited: LimitedLogpoint = { breakpoint, prefix, maxHits, hits: 0 };
        if (maxSeconds !== undefined) {
            limited.expiresAt = Date.now() + maxSeconds * 1000;
            limited.timer = setTimeout(() => this.removeLimitedLogpoint(limited), maxSeconds * 1000);
        }
        this.limitedLogpoints.set(breakpoint.id, limited);
    }

    private countLogpointHit(line: string): void {
        for (const limited of this.limitedLogpoints.values()) {
            if (limited.maxHits !== undefined && line.includes(limited.prefix)) {
                limited.hits += 1;
                if (limited.hits >= limited.maxHits) {
                    this.removeLimitedLogpoint(limited);
                }
            }
        }
    }

    private removeLimitedLogpoint(limited: LimitedLogpoint): void {
        clearTimeout(limited.timer);
        this.limitedLogpoints.delete(limited.breakpoint.id);
        this.agentBreakpointIds.delete(limited.breakpoint.id);
        vscode.debug.removeBreakpoints([limited.breakpoint]);
    }

    dispose(): void {
        for (const limited of this.limitedLogpoints.values()) {
            clearTimeout(limited.timer);
        }
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        this.pauseListeners.clear();
    }

    /** The server session the tools act on: the focused one when it is a GMod server session, else the newest. */
    get session(): vscode.DebugSession | undefined {
        const active = vscode.debug.activeDebugSession;
        if (active?.type === GMOD_SERVER_DEBUG_TYPE && this.sessions.has(active.id)) {
            return active;
        }
        let newest: TrackedSession | undefined;
        for (const tracked of this.sessions.values()) {
            if (!tracked.terminated && (!newest || tracked.startedAt > newest.startedAt)) {
                newest = tracked;
            }
        }
        return newest?.session;
    }

    isAlive(session: vscode.DebugSession): boolean {
        return this.sessions.has(session.id);
    }

    get sessionCount(): number {
        return this.sessions.size;
    }

    /** Where the target session is stopped, if it is. */
    get pause(): PauseInfo | undefined {
        const session = this.session;
        return session ? this.sessions.get(session.id)?.pause : undefined;
    }

    /** Runs that finished after their tool call had already answered; cleared once read. */
    takeLateRuns(): LateRun[] {
        const finished = this.lateRuns.filter((run) => run.report !== undefined || run.error !== undefined);
        for (const run of finished) {
            this.lateRuns.splice(this.lateRuns.indexOf(run), 1);
        }
        return finished;
    }

    get pendingRunCount(): number {
        return this.lateRuns.filter((run) => run.report === undefined && run.error === undefined).length;
    }

    /** Keeps following a run the agent stopped waiting for and reports it later. */
    followLateRun(label: string, run: Promise<RunReport | null>): void {
        const entry = { label, startedAt: Date.now() } as LateRun;
        entry.settled = run.then(
            (report) => {
                entry.report = report;
            },
            (error: unknown) => {
                entry.error = error instanceof Error ? error.message : String(error);
            }
        );
        this.lateRuns.push(entry);
    }

    /** Waits up to `timeoutMs` for followed runs to finish. */
    async waitForLateRuns(timeoutMs: number): Promise<void> {
        const pending = this.lateRuns.filter((run) => run.report === undefined && run.error === undefined);
        if (pending.length === 0) {
            return;
        }
        await Promise.race([Promise.all(pending.map((run) => run.settled)), delay(timeoutMs)]);
    }

    /**
     * Reads the adapter's own state and reconciles the tracked pause with it. This
     * matters for sessions that started (and maybe paused) before the MCP host did.
     */
    async state(session = this.session): Promise<SessionState | undefined> {
        if (!session) {
            return undefined;
        }
        const state = await session.customRequest('gmod.mcp.state') as SessionState;
        const tracked = this.track(session);
        const settling = tracked.resumedAt !== undefined && Date.now() - tracked.resumedAt < RESUME_SETTLE_MS;
        if (state.paused && !tracked.pause && !settling) {
            tracked.pause = { id: ++this.pauseCounter, reason: state.pauseReason ?? 'pause', since: Date.now() };
            this.firePauseChange();
        } else if (!state.paused && tracked.pause) {
            tracked.pause = undefined;
            this.firePauseChange();
        }
        return state;
    }

    /**
     * Returns a ready server session, attaching one when `autoAttach` is set and none
     * exists. Attach never stops on entry, so the game keeps running.
     */
    async ensureSession(autoAttach: boolean, timeoutMs = 10_000): Promise<{ session?: vscode.DebugSession; attached: boolean; problem?: string }> {
        const deadline = Date.now() + timeoutMs;
        let attached = false;
        let attempts = 0;
        let lastReason: string | undefined;
        while (true) {
            let session = this.session;
            if (!session) {
                if (!autoAttach) {
                    return { attached, problem: 'No GMod server debug session is running. Call debugger with action "attach".' };
                }
                attempts += 1;
                const started = await this.attach();
                if (started.problem) {
                    return { attached, problem: started.problem };
                }
                attached = true;
                session = this.session;
            }
            if (session) {
                // Wait until the adapter has connected to gm_rdb and finished its handshake.
                let state: SessionState | undefined;
                let failures = 0;
                while (this.sessions.has(session.id) && Date.now() < deadline) {
                    state = await this.state(session).catch(() => undefined);
                    if (state?.ready) {
                        return { session, attached };
                    }
                    // A session that no longer answers at all is gone, whatever VS Code reported.
                    failures = state ? 0 : failures + 1;
                    if (failures >= 4) {
                        this.markEnded(session);
                        break;
                    }
                    lastReason = state?.notReadyReason ?? lastReason;
                    await delay(250);
                }
                if (this.sessions.has(session.id)) {
                    return {
                        session,
                        attached,
                        problem: `The debugger has not finished connecting to the game server (${lastReason ?? 'no response'}). Try again in a moment.`,
                    };
                }
            }
            // The session ended: usually nothing is listening on the debugger port yet.
            if (Date.now() + 1000 >= deadline) {
                break;
            }
            await delay(1000);
        }
        return {
            attached,
            problem: `Could not connect to the GMod server debugger${attempts > 1 ? ` (${attempts} attempts)` : ''}: the debug session ended because nothing answered on the debugger port. `
                + 'Check that srcds is running (it takes a few seconds to start) with gm_rdb installed and the GLuaLS autorun file in place, and that the port matches launch.json (default 21111).',
        };
    }

    /** Starts the user's GMod attach configuration, or a default one on 127.0.0.1:21111. */
    async attach(): Promise<{ problem?: string }> {
        if (this.session) {
            return {};
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        let folder: vscode.WorkspaceFolder | undefined;
        let config: vscode.DebugConfiguration | undefined;
        for (const candidate of folders) {
            const configurations = vscode.workspace.getConfiguration('launch', candidate.uri).get<vscode.DebugConfiguration[]>('configurations') ?? [];
            const match = configurations.find((entry) => entry?.type === GMOD_SERVER_DEBUG_TYPE && entry.request === 'attach');
            if (match) {
                folder = candidate;
                config = { ...match };
                break;
            }
        }
        if (!config) {
            folder = folders[0];
            config = { type: GMOD_SERVER_DEBUG_TYPE, request: 'attach', name: 'GLuaLS MCP: Attach to GMod server' };
            const sourceRoot = folder && getAutoDetectedWorkspaceGarrysmodPath(folder);
            if (sourceRoot) {
                config.sourceRoot = sourceRoot;
            }
        }
        // A stop on entry would freeze the server the moment an agent connects.
        config.stopOnEntry = false;
        // Marks the session as the agent's, so detach never disconnects one the user started.
        config[AGENT_SESSION_MARKER] = true;

        const waitForStart = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                listener.dispose();
                resolve(false);
            }, 10_000);
            const listener = vscode.debug.onDidStartDebugSession((session) => {
                if (session.type === GMOD_SERVER_DEBUG_TYPE && session.configuration?.[AGENT_SESSION_MARKER] === true) {
                    this.agentStarted.add(session.id);
                    clearTimeout(timer);
                    listener.dispose();
                    resolve(true);
                }
            });
        });
        const ok = await vscode.debug.startDebugging(folder, config);
        if (!ok) {
            return { problem: `VS Code could not start the "${config.name}" debug configuration.` };
        }
        if (!this.session && !(await waitForStart)) {
            return { problem: 'The GMod debug session did not start within 10 seconds.' };
        }
        return {};
    }

    async stack(session: vscode.DebugSession): Promise<StackFrameInfo[]> {
        return await session.customRequest('gmod.mcp.stack') as StackFrameInfo[];
    }

    async frameVariables(session: vscode.DebugSession, frame: number, depth = 0): Promise<{ locals: Record<string, unknown>; upvalues: Record<string, unknown> }> {
        return await session.customRequest('gmod.mcp.frame', { frame, depth }) as { locals: Record<string, unknown>; upvalues: Record<string, unknown> };
    }

    /** Evaluates a Lua expression in a paused frame; locals and upvalues are in scope. */
    async evaluate(session: vscode.DebugSession, frame: number, chunk: string, depth = 1): Promise<unknown[]> {
        const result = await session.customRequest('gmod.mcp.eval', { frame, chunk, depth }) as { values?: unknown };
        return Array.isArray(result.values) ? result.values : [];
    }

    /** Calls the server bridge's `_GLUALS.runLua` in `mode`; see GmodMcpBridgeLua.ts. */
    runLua(session: vscode.DebugSession, lua: string, mode: 'capture' | 'defer' | 'take' | 'cancel' | 'trace' | 'untrace' | 'traces', timeoutMs: number): Promise<unknown> {
        return Promise.resolve(session.customRequest('gmod.mcp.runLua', { lua, mode, timeoutMs }))
            .then((result: { report?: unknown }) => result?.report ?? null);
    }

    async consoleCommand(session: vscode.DebugSession, command: string): Promise<void> {
        await session.customRequest('gmod.mcp.command', { command });
    }

    /** Breakpoints as gm_rdb holds them, with hit counts. */
    async serverBreakpoints(session: vscode.DebugSession): Promise<Array<{ file?: string; line?: number; condition?: string; hit_count?: number }>> {
        const result = await session.customRequest('gmod.mcp.breakpoints') as { breakpoints?: Array<{ file?: string; line?: number; condition?: string; hit_count?: number }> };
        return result.breakpoints ?? [];
    }

    /**
     * Continues or steps, then waits up to `timeoutMs` for the next stop. Returns the
     * new pause, or undefined when the game is still running at the deadline.
     */
    async step(session: vscode.DebugSession, kind: StepKind, timeoutMs: number, onAbort?: (listener: () => void) => () => void): Promise<PauseInfo | undefined> {
        const tracked = this.sessions.get(session.id);
        const before = tracked?.pause?.id ?? this.pauseCounter;
        // Clear the pause ourselves: a step can be answered before (or without) a continued event.
        if (tracked) {
            tracked.pause = undefined;
            tracked.resumedAt = Date.now();
            this.firePauseChange();
        }
        await session.customRequest(STEP_REQUESTS[kind], { threadId: THREAD_ID });
        return this.waitForPause(timeoutMs, before, onAbort);
    }

    async requestPause(session: vscode.DebugSession, timeoutMs: number, onAbort?: (listener: () => void) => () => void): Promise<PauseInfo | undefined> {
        const existing = this.pause;
        if (existing) {
            return existing;
        }
        await session.customRequest('pause', { threadId: THREAD_ID });
        return this.waitForPause(timeoutMs, this.pauseCounter, onAbort);
    }

    /** Resolves with the first pause newer than `afterPauseId` (any current one if omitted). */
    waitForPause(timeoutMs: number, afterPauseId?: number, onAbort?: (listener: () => void) => () => void): Promise<PauseInfo | undefined> {
        const check = () => {
            const pause = this.pause;
            return pause && (afterPauseId === undefined || pause.id > afterPauseId) ? pause : undefined;
        };
        const immediate = check();
        if (immediate) {
            return Promise.resolve(immediate);
        }
        return new Promise((resolve) => {
            let done = false;
            // Declared first: onAbort calls its listener at once when the request is already aborted.
            let unregister: (() => void) | undefined;
            const finish = (value: PauseInfo | undefined) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                this.pauseListeners.delete(listener);
                unregister?.();
                resolve(value);
            };
            const listener = () => {
                const pause = check();
                if (pause) {
                    finish(pause);
                } else if (!this.session) {
                    finish(undefined);
                }
            };
            const timer = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
            this.pauseListeners.add(listener);
            unregister = onAbort?.(() => finish(undefined));
        });
    }

    get currentPauseCounter(): number {
        return this.pauseCounter;
    }

    /** True when the MCP started this debug session rather than the user. */
    startedByAgent(session: vscode.DebugSession): boolean {
        return this.agentStarted.has(session.id);
    }

    private markEnded(session: vscode.DebugSession): void {
        this.ended.add(session.id);
        const tracked = this.sessions.get(session.id);
        if (tracked) {
            tracked.terminated = true;
            tracked.pause = undefined;
            this.sessions.delete(session.id);
        }
        this.firePauseChange();
    }

    private track(session: vscode.DebugSession): TrackedSession {
        if (this.ended.has(session.id)) {
            // A late event from an ended session: answer with a record that is not kept.
            return { session, startedAt: 0, terminated: true };
        }
        let tracked = this.sessions.get(session.id);
        if (!tracked) {
            tracked = { session, startedAt: Date.now(), terminated: false };
            this.sessions.set(session.id, tracked);
        }
        return tracked;
    }

    private createTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
        return {
            onDidSendMessage: (message: { type?: string; event?: string; body?: { reason?: string; category?: string; output?: string } }) => {
                if (message?.type !== 'event') {
                    return;
                }
                if (message.event === 'output' && message.body?.category !== 'stdout' && typeof message.body?.output === 'string') {
                    // The adapter's own messages (connection, failures); game console lines are stdout.
                    this.log(`Debugger: ${message.body.output.trim()}`);
                }
                const tracked = this.track(session);
                if (message.event === 'stopped') {
                    tracked.pause = { id: ++this.pauseCounter, reason: message.body?.reason ?? 'pause', since: Date.now() };
                    this.firePauseChange();
                } else if (message.event === 'continued') {
                    tracked.pause = undefined;
                    this.firePauseChange();
                } else if (message.event === 'terminated' || message.event === 'exited') {
                    this.markEnded(session);
                }
            },
            onExit: () => {
                const tracked = this.sessions.get(session.id);
                if (tracked) {
                    tracked.pause = undefined;
                    this.firePauseChange();
                }
            },
        };
    }

    private onCustomEvent(event: vscode.DebugSessionCustomEvent): void {
        if (event.session.type !== GMOD_SERVER_DEBUG_TYPE) {
            return;
        }
        this.track(event.session);
        const body = (event.body ?? {}) as Record<string, unknown>;
        switch (event.event) {
            case 'gmod.output':
                if (typeof body.message === 'string') {
                    this.events.pushConsole(body.message);
                }
                break;
            case 'gmod.error': {
                const parsed = parseGmodLuaError(body.message, undefined);
                this.events.recordError({
                    message: typeof body.message === 'string' ? body.message : parsed.message,
                    fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : `error:${parsed.message}`,
                    stackTrace: Array.isArray(body.stackTrace) ? body.stackTrace.filter((line): line is string => typeof line === 'string') : [],
                    time: typeof body.timestamp === 'number' ? body.timestamp : undefined,
                });
                break;
            }
            case 'gmod.connected':
                this.log(`GMod debugger connected (module ${String(body.moduleVersion ?? 'unknown')}).`);
                this.lastBacklog = typeof body.backlog === 'number' ? body.backlog : undefined;
                break;
        }
    }

    private firePauseChange(): void {
        for (const listener of [...this.pauseListeners]) {
            listener();
        }
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
