import { ConsoleEntry, ErrorEntry } from './eventLog';
import { McpToolContext, ToolSpec } from './runtimeTools';
import { booleanArg, clampText, formatAge, mapGamePathsInText, numberArg, stringArg, ToolInputError } from './toolSupport';
import { GmodSourceMapping } from '../debugger/gmod_debugger/GmodSourcePaths';

const QUIET_AFTER_COMMAND_MS = 350;

async function currentMapping(context: McpToolContext): Promise<GmodSourceMapping | undefined> {
    const session = context.bridge.session;
    if (!session) {
        return undefined;
    }
    const state = await context.bridge.state(session).catch(() => undefined);
    return state ? { sourceRoot: state.sourceRoot, sourceFileMap: state.sourceFileMap } : undefined;
}

function renderConsole(entries: ConsoleEntry[], omitted: number, cursor: number, mapping: GmodSourceMapping | undefined, empty: string): string {
    if (entries.length === 0) {
        return `${empty} (cursor ${cursor}).`;
    }
    const header = `${entries.length} line(s)${omitted > 0 ? `, ${omitted} older matching line(s) not shown (raise limit or narrow search)` : ''}. `
        + `Cursor ${cursor}: pass after=${cursor} next time to get only newer lines.`;
    // Lines already start with the time the server printed them.
    const body = entries.map((entry) => mapGamePathsInText(entry.text, mapping)).join('\n');
    return clampText(`${header}\n${body}`);
}

function consoleTool(context: McpToolContext): ToolSpec {
    return {
        definition: {
            name: 'server_console',
            title: 'Read the GMod server console or run a console command',
            description: [
                'Read the Garry\'s Mod SERVER console (print/Msg output, engine messages, logpoint lines) as buffered by VS Code since the debugger attached.',
                'Filter with `search` (case-insensitive text, or /regex/) and `after` (a cursor from an earlier reply) to see only what is new.',
                '`wait_ms` blocks until a matching line arrives, e.g. after making something happen through a client MCP.',
                'With `command`, runs a server console command (e.g. "status", "changelevel gm_construct", "lua_refresh_file x.lua"; no ";" chaining) and returns the output it produced.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Server console command to run.' },
                    search: { type: 'string', description: 'Case-insensitive text, or /regex/.' },
                    after: { type: 'integer', minimum: 0, description: 'Only lines after this cursor.' },
                    limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most recent N matching lines (default 50).' },
                    wait_ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'Wait up to this long for a matching line.' },
                },
            },
            annotations: { title: 'Server console', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        handler: async (args, signal) => {
            const command = stringArg(args, 'command')?.trim();
            const search = stringArg(args, 'search');
            const limit = numberArg(args, 'limit', { min: 1, max: 500, fallback: 50 });
            const waitMs = numberArg(args, 'wait_ms', { min: 0, max: 30_000, fallback: command ? 1500 : 0 })!;
            const events = context.bridge.events;
            const onAbort = (listener: () => void) => signal.onAbort(listener);

            if (command) {
                if (!context.settings().allowCodeExecution) {
                    throw new ToolInputError('Console commands are turned off in this workspace (setting gluals.mcp.allowCodeExecution).');
                }
                const ensured = await context.bridge.ensureSession(context.settings().autoAttach);
                if (!ensured.session || ensured.problem) {
                    throw new ToolInputError(ensured.problem ?? 'No GMod server debug session.');
                }
                const mark = events.cursor;
                await context.bridge.consoleCommand(ensured.session, command);
                // Collect output until the console has been quiet for a moment, or wait_ms passes.
                const deadline = Date.now() + waitMs;
                let lastSeen = events.cursor;
                let quietSince = Date.now();
                while (Date.now() < deadline && !signal.aborted) {
                    const changed = await events.waitFor(() => events.cursor !== lastSeen, Math.min(QUIET_AFTER_COMMAND_MS, deadline - Date.now()), onAbort);
                    if (changed) {
                        lastSeen = events.cursor;
                        quietSince = Date.now();
                    } else if (events.cursor > mark && Date.now() - quietSince >= QUIET_AFTER_COMMAND_MS) {
                        break;
                    }
                }
                const result = events.queryConsole({ after: mark, search, limit });
                const mapping = await currentMapping(context);
                const prefix = `${ensured.attached ? 'Attached the VS Code debugger to the GMod server.\n' : ''}Ran: ${command}\n`;
                return { text: prefix + renderConsole(result.entries, result.omitted, result.cursor, mapping, 'No console output yet; it may still arrive, check again with after=' + mark) };
            }

            const after = numberArg(args, 'after', { min: 0 });
            if (waitMs > 0) {
                // Without a cursor, wait for lines newer than this call.
                const from = after ?? events.cursor;
                await events.waitFor(() => events.queryConsole({ after: from, search, limit: 1 }).entries.length > 0, waitMs, onAbort);
                const result = events.queryConsole({ after: from, search, limit });
                const mapping = await currentMapping(context);
                return { text: renderConsole(result.entries, result.omitted, result.cursor, mapping, `No matching line within ${waitMs} ms`) };
            }
            const result = events.queryConsole({ after, search, limit });
            const mapping = await currentMapping(context);
            const empty = context.bridge.session ? 'No matching console lines' : 'No console lines (the debugger is not attached; output is only collected while it is)';
            return { text: renderConsole(result.entries, result.omitted, result.cursor, mapping, empty) };
        },
    };
}

function renderError(entry: ErrorEntry, index: number, mapping: GmodSourceMapping | undefined): string {
    const lines = [`#${index + 1} (${entry.count}x, last ${formatAge(Date.now() - entry.lastSeen)}) ${mapGamePathsInText(entry.message, mapping)}`];
    for (const frame of entry.stackTrace.slice(0, 12)) {
        lines.push(`    ${mapGamePathsInText(frame, mapping)}`);
    }
    if (entry.stackTrace.length > 12) {
        lines.push(`    ... ${entry.stackTrace.length - 12} more frames`);
    }
    return lines.join('\n');
}

function errorsTool(context: McpToolContext): ToolSpec {
    return {
        definition: {
            name: 'server_errors',
            title: 'Read Lua errors from the GMod server',
            description: [
                'Unique Lua runtime errors raised on the Garry\'s Mod SERVER (hooks, timers, net receivers, entities), newest first, with counts and stack traces mapped to workspace files.',
                'Errors from server_run_lua are reported by that tool directly.',
                'Typical loop: clear: true, reproduce the problem (server_run_lua, a client MCP or the user), then read again, or use `wait_ms` to block until an error arrives.',
                '`after` takes a cursor from an earlier reply; `search` filters by text or /regex/.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    clear: { type: 'boolean', description: 'Forget all errors seen so far (later occurrences count from zero).' },
                    search: { type: 'string' },
                    after: { type: 'integer', minimum: 0 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
                    wait_ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'Wait up to this long for a new matching error.' },
                },
            },
            annotations: { title: 'Server errors', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        handler: async (args, signal) => {
            const events = context.bridge.events;
            if (booleanArg(args, 'clear')) {
                const cleared = events.clearErrors();
                return { text: `Cleared ${cleared} error(s). Cursor ${events.cursor}.` };
            }
            const search = stringArg(args, 'search');
            const limit = numberArg(args, 'limit', { min: 1, max: 100, fallback: 20 });
            const waitMs = numberArg(args, 'wait_ms', { min: 0, max: 30_000, fallback: 0 })!;
            let after = numberArg(args, 'after', { min: 0 });
            if (waitMs > 0) {
                const from = after ?? events.cursor;
                await events.waitFor(() => events.queryErrors({ after: from, search, limit: 1 }).entries.length > 0, waitMs, (listener) => signal.onAbort(listener));
                after = from;
            }
            const result = events.queryErrors({ after, search, limit });
            const mapping = await currentMapping(context);
            if (result.entries.length === 0) {
                const scope = after !== undefined ? ` after cursor ${after}` : '';
                const note = context.bridge.session ? '' : ' The debugger is not attached, so errors are not being collected.';
                return { text: `No Lua errors${scope}${waitMs > 0 ? ` within ${waitMs} ms` : ''}.${note} Cursor ${result.cursor}.` };
            }
            const header = `${result.entries.length} error(s)${result.omitted > 0 ? ` (${result.omitted} more not shown)` : ''}. Cursor ${result.cursor}.`;
            return { text: clampText(`${header}\n${result.entries.map((entry, index) => renderError(entry, index, mapping)).join('\n')}`) };
        },
    };
}

export function logTools(context: McpToolContext): ToolSpec[] {
    return [consoleTool(context), errorsTool(context)];
}
