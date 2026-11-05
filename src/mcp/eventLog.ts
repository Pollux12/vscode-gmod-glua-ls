/**
 * Buffers what the game server reports (console lines and Lua errors) for the MCP tools.
 *
 * Every entry gets a number from one shared sequence, the "cursor". Any tool reply
 * carries the current cursor, so an agent can note it, do something (for example
 * through a clientside MCP), then ask for everything after it.
 */

export interface ConsoleEntry {
    seq: number;
    time: number;
    text: string;
}

export interface ErrorEntry {
    fingerprint: string;
    message: string;
    stackTrace: string[];
    /** Times seen since the last clear. */
    count: number;
    firstSeen: number;
    lastSeen: number;
    /** Cursor of the latest occurrence. */
    lastSeq: number;
    /** Repeating timers GMod removed after this error ("Timer Failed!"), oldest first. */
    removedTimers: string[];
    /** Set when the error was raised in a timer.Simple callback. */
    inSimpleTimer: boolean;
}

export interface ErrorReport {
    message: string;
    fingerprint: string;
    stackTrace?: string[];
    /** When the server raised it (ms since epoch); defaults to now. Replayed errors are older. */
    time?: number;
}

export interface QueryOptions {
    after?: number;
    search?: string;
    limit?: number;
}

export interface QueryResult<T> {
    entries: T[];
    /** Matches beyond `limit` that were left out. */
    omitted: number;
    cursor: number;
}

const DEFAULT_CONSOLE_CAPACITY = 5000;
const DEFAULT_ERROR_CAPACITY = 500;
const MAX_LINE_LENGTH = 2000;
/** GMod prints "Timer Failed!" right after the error; later lines belong to something else. */
const TIMER_LINK_MS = 2000;
const MAX_REMOVED_TIMERS = 50;
const TIMER_FAILED = /Timer Failed! \[(.*?)\]\[@/;

/**
 * Turns a search string into a predicate. `/pattern/flags` is a regular expression;
 * anything else is a case-insensitive substring.
 */
export function createMatcher(search: string | undefined): (text: string) => boolean {
    const trimmed = search?.trim();
    if (!trimmed) {
        return () => true;
    }
    const regexMatch = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
    if (regexMatch) {
        try {
            const flags = regexMatch[2].includes('i') ? regexMatch[2] : `${regexMatch[2]}i`;
            const regex = new RegExp(regexMatch[1], flags.replace(/[gy]/g, ''));
            return (text) => regex.test(text);
        } catch {
            // Fall through to a plain substring search.
        }
    }
    const needle = trimmed.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
}

export class McpEventLog {
    private seq = 0;
    private readonly consoleEntries: ConsoleEntry[] = [];
    private readonly errors = new Map<string, ErrorEntry>();
    private readonly listeners = new Set<() => void>();
    private readonly consoleListeners = new Set<(entry: ConsoleEntry) => void>();
    /** The error recorded last and when it arrived, for linking a following "Timer Failed!" line. */
    private lastError?: { fingerprint: string; receivedAt: number };

    constructor(
        private readonly consoleCapacity = DEFAULT_CONSOLE_CAPACITY,
        private readonly errorCapacity = DEFAULT_ERROR_CAPACITY,
        private readonly now: () => number = Date.now
    ) {}

    get cursor(): number {
        return this.seq;
    }

    pushConsole(text: string): void {
        const line = text.replace(/\r?\n$/, '');
        this.consoleEntries.push({
            seq: ++this.seq,
            time: this.now(),
            text: line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}... (${line.length} chars)` : line,
        });
        // Trim in batches: dropping one line per new line would shift the whole buffer every time.
        if (this.consoleEntries.length > this.consoleCapacity + Math.max(1, Math.floor(this.consoleCapacity / 10))) {
            this.consoleEntries.splice(0, this.consoleEntries.length - this.consoleCapacity);
        }
        const entry = this.consoleEntries[this.consoleEntries.length - 1];
        this.linkTimerFailure(line);
        for (const listener of [...this.consoleListeners]) {
            listener(entry);
        }
        this.notify();
    }

    /** Calls `listener` for every new console line; returns a function that unregisters it. */
    onConsole(listener: (entry: ConsoleEntry) => void): () => void {
        this.consoleListeners.add(listener);
        return () => this.consoleListeners.delete(listener);
    }

    recordError(report: ErrorReport): void {
        // Counted here rather than from the server's total, which does not reset when the
        // debugger reattaches and includes errors from before the log was listening.
        const time = report.time ?? this.now();
        const existing = this.errors.get(report.fingerprint);
        const entry: ErrorEntry = {
            fingerprint: report.fingerprint,
            message: report.message,
            stackTrace: report.stackTrace && report.stackTrace.length > 0 ? report.stackTrace : existing?.stackTrace ?? [],
            count: (existing?.count ?? 0) + 1,
            firstSeen: existing?.firstSeen ?? time,
            lastSeen: time,
            lastSeq: ++this.seq,
            removedTimers: existing?.removedTimers ?? [],
            inSimpleTimer: existing?.inSimpleTimer ?? false,
        };
        this.lastError = { fingerprint: report.fingerprint, receivedAt: this.now() };
        this.errors.delete(report.fingerprint);
        this.errors.set(report.fingerprint, entry);
        while (this.errors.size > this.errorCapacity) {
            const oldest = this.errors.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.errors.delete(oldest);
        }
        this.notify();
    }

    /**
     * When a timer's callback errors, GMod prints the error and then "Timer Failed! [name][@file (line n)]",
     * and removes the timer if it repeats. That line only reaches the console, so note it on the error.
     */
    private linkTimerFailure(line: string): void {
        const match = TIMER_FAILED.exec(line);
        const last = this.lastError;
        if (!match || !last || this.now() - last.receivedAt > TIMER_LINK_MS) {
            return;
        }
        const entry = this.errors.get(last.fingerprint);
        if (!entry) {
            return;
        }
        if (match[1] === 'Simple') {
            entry.inSimpleTimer = true;
        } else if (!entry.removedTimers.includes(match[1])) {
            entry.removedTimers.push(match[1]);
            if (entry.removedTimers.length > MAX_REMOVED_TIMERS) {
                entry.removedTimers.shift();
            }
        }
    }

    /** Forgets every error; later occurrences count from zero. Returns how many were cleared. */
    clearErrors(): number {
        const cleared = this.errors.size;
        this.errors.clear();
        return cleared;
    }

    queryConsole(options: QueryOptions = {}): QueryResult<ConsoleEntry> {
        const matches = createMatcher(options.search);
        const after = options.after ?? 0;
        const found = this.consoleEntries.filter((entry) => entry.seq > after && matches(entry.text));
        return this.page(found, options.limit, true);
    }

    queryErrors(options: QueryOptions = {}): QueryResult<ErrorEntry> {
        const matches = createMatcher(options.search);
        const after = options.after ?? 0;
        const found = [...this.errors.values()]
            .filter((entry) => entry.lastSeq > after && (matches(entry.message) || entry.stackTrace.some(matches)))
            .sort((a, b) => b.lastSeq - a.lastSeq);
        return this.page(found, options.limit, false);
    }

    get errorCount(): number {
        return this.errors.size;
    }

    /**
     * Resolves true once `test` passes, checking now and after every new entry, or
     * false when `timeoutMs` passes or `signal` aborts first.
     */
    waitFor(test: () => boolean, timeoutMs: number, onAbort?: (listener: () => void) => () => void): Promise<boolean> {
        if (test()) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            let done = false;
            // Declared first: onAbort calls its listener at once when the request is already aborted.
            let unregisterAbort: (() => void) | undefined;
            const finish = (value: boolean) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                this.listeners.delete(check);
                unregisterAbort?.();
                resolve(value);
            };
            const check = () => {
                if (test()) {
                    finish(true);
                }
            };
            const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
            this.listeners.add(check);
            unregisterAbort = onAbort?.(() => finish(false));
        });
    }

    private page<T>(found: T[], limit: number | undefined, keepNewest: boolean): QueryResult<T> {
        const max = clampLimit(limit);
        if (found.length <= max) {
            return { entries: found, omitted: 0, cursor: this.seq };
        }
        const entries = keepNewest ? found.slice(found.length - max) : found.slice(0, max);
        return { entries, omitted: found.length - max, cursor: this.seq };
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

export function clampLimit(limit: number | undefined, fallback = 50, max = 500): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return fallback;
    }
    return Math.min(max, Math.max(1, Math.floor(limit)));
}
