export const STARTUP_LOAD_PROGRESS_TOKEN = 0;
export const STARTUP_DIAGNOSE_PROGRESS_TOKEN = 1;

export type StartupProgressToken =
    | typeof STARTUP_LOAD_PROGRESS_TOKEN
    | typeof STARTUP_DIAGNOSE_PROGRESS_TOKEN;

export type StartupServerState = 'workspaceLoaded' | 'startupComplete';

export interface StartupProgressEvent {
    readonly token: number | string;
    readonly kind: 'begin' | 'report' | 'end';
    readonly message?: string;
}

export interface StartupReadinessState {
    readonly ready: boolean;
    readonly diagnosticsInProgress: boolean;
    readonly completedTasks: ReadonlySet<StartupProgressToken>;
}

export function createStartupReadinessState(): StartupReadinessState {
    return {
        ready: false,
        diagnosticsInProgress: false,
        completedTasks: new Set(),
    };
}

export function isStartupProgressToken(token: number | string): token is StartupProgressToken {
    return token === STARTUP_LOAD_PROGRESS_TOKEN || token === STARTUP_DIAGNOSE_PROGRESS_TOKEN;
}

export function applyServerStartupState(
    state: StartupReadinessState,
    serverState: StartupServerState
): StartupReadinessState {
    if (serverState === 'startupComplete') {
        return {
            ready: true,
            diagnosticsInProgress: false,
            completedTasks: new Set([
                ...state.completedTasks,
                STARTUP_LOAD_PROGRESS_TOKEN,
                STARTUP_DIAGNOSE_PROGRESS_TOKEN,
            ]),
        };
    }

    return {
        ...state,
        ready: true,
        diagnosticsInProgress: false,
        completedTasks: new Set([
            ...state.completedTasks,
            STARTUP_LOAD_PROGRESS_TOKEN,
        ]),
    };
}

export function applyStartupProgressEvent(
    state: StartupReadinessState,
    event: StartupProgressEvent
): StartupReadinessState {
    if (!isStartupProgressToken(event.token)) {
        return state;
    }

    if (event.token === STARTUP_DIAGNOSE_PROGRESS_TOKEN && event.kind !== 'end') {
        return {
            ...state,
            diagnosticsInProgress: true,
        };
    }

    if (event.kind !== 'end') {
        return state;
    }

    const completedTasks = new Set(state.completedTasks);
    completedTasks.add(event.token);

    return {
        ready: state.ready || event.token === STARTUP_LOAD_PROGRESS_TOKEN,
        diagnosticsInProgress:
            event.token === STARTUP_DIAGNOSE_PROGRESS_TOKEN
                ? false
                : state.diagnosticsInProgress,
        completedTasks,
    };
}

export function describeStartupProgressEvent(event: StartupProgressEvent): string {
    const message = event.message?.trim();
    if (message) {
        return message;
    }

    if (!isStartupProgressToken(event.token)) {
        return 'unknown startup progress';
    }

    const phase =
        event.token === STARTUP_LOAD_PROGRESS_TOKEN
            ? 'workspace loading'
            : 'workspace diagnostics';

    switch (event.kind) {
        case 'begin':
            return `${phase} started`;
        case 'report':
            return `${phase} in progress`;
        case 'end':
            return `${phase} completed`;
    }
}

export function formatStartupTimeoutMessage(timeoutMs: number, lastKnownPhase: string): string {
    return `LS_STARTUP_TIMEOUT after ${timeoutMs / 1000}s; last phase: ${lastKnownPhase}`;
}
