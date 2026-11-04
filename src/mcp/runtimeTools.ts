import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { clientPathToGamePath, gamePathToLuaPath, GmodSourceMapping } from '../debugger/gmod_debugger/GmodSourcePaths';
import { GmodDebugBridge, PauseInfo, RunReport, SessionState, StackFrameInfo, StepKind } from './debugBridge';
import { logpointLabel, logpointLinePrefix, luaStringLiteral } from './logpoint';
import { AbortSignalLike, McpTool } from './mcpHttpServer';
import {
    displayPath,
    enumArg,
    formatAge,
    formatLrdbValue,
    isLuaIdentifier,
    mapGamePathsInText,
    numberArg,
    resolveWorkspacePath,
    sourceExcerpt,
    stringArg,
    ToolInputError,
} from './toolSupport';

export interface McpToolSettings {
    allowCodeExecution: boolean;
    autoAttach: boolean;
}

export interface McpToolContext {
    bridge: GmodDebugBridge;
    settings(): McpToolSettings;
}

/** A tool body returns text; `markPaused` says the text already describes the pause. */
export interface ToolReply {
    text: string;
    isError?: boolean;
    describesPause?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>, signal: AbortSignalLike) => Promise<ToolReply>;

export interface ToolSpec {
    definition: McpTool['definition'];
    handler: ToolHandler;
}

const LOCALS_LIMIT = 40;
const STACK_LIMIT = 12;

function mappingOf(state: SessionState | undefined): GmodSourceMapping {
    return { sourceRoot: state?.sourceRoot, sourceFileMap: state?.sourceFileMap };
}

function requireExecution(context: McpToolContext): void {
    if (!context.settings().allowCodeExecution) {
        throw new ToolInputError('Running code on the server is turned off in this workspace (setting gluals.mcp.allowCodeExecution). Ask the user to enable it.');
    }
}

async function requireSession(context: McpToolContext): Promise<{ session: vscode.DebugSession; state: SessionState; attachedNote?: string }> {
    const result = await context.bridge.ensureSession(context.settings().autoAttach);
    if (!result.session || result.problem) {
        throw new ToolInputError(result.problem ?? 'No GMod server debug session.');
    }
    const state = await context.bridge.state(result.session);
    if (!state) {
        throw new ToolInputError('The GMod debug session ended.');
    }
    return { session: result.session, state, attachedNote: result.attached ? 'Attached the VS Code debugger to the GMod server.' : undefined };
}

function frameLocation(frame: StackFrameInfo | undefined): string {
    if (!frame) {
        return 'an unknown location';
    }
    const where = frame.localPath && fs.existsSync(frame.localPath)
        ? `${displayPath(frame.localPath)}:${frame.line}`
        : `${frame.file.replace(/^[@=]/, '')}${frame.line > 0 ? `:${frame.line}` : ''}`;
    return frame.func ? `${where} in ${frame.func}` : where;
}

function breakpointOwnerAt(context: McpToolContext, frame: StackFrameInfo | undefined): string | undefined {
    if (!frame?.localPath) {
        return undefined;
    }
    const target = path.normalize(frame.localPath).toLowerCase();
    for (const breakpoint of vscode.debug.breakpoints) {
        if (breakpoint instanceof vscode.SourceBreakpoint
            && path.normalize(breakpoint.location.uri.fsPath).toLowerCase() === target
            && breakpoint.location.range.start.line + 1 === frame.line) {
            return context.bridge.agentBreakpointIds.has(breakpoint.id) ? 'set by you (the agent)' : 'set by the user in VS Code';
        }
    }
    return undefined;
}

/** Text describing where the server is paused: location, source, stack, locals and upvalues. */
export async function describePause(context: McpToolContext, session: vscode.DebugSession, pause: PauseInfo, frameIndex: number): Promise<string> {
    const lines: string[] = [];
    let stack: StackFrameInfo[] = [];
    try {
        stack = await context.bridge.stack(session);
    } catch (error) {
        lines.push(`SERVER PAUSED (${pause.reason}), but the stack could not be read: ${errorText(error)}`);
        return lines.join('\n');
    }
    const frame = stack[frameIndex];
    const top = stack[0];
    const owner = pause.reason === 'breakpoint' ? breakpointOwnerAt(context, top) : undefined;
    lines.push(`SERVER PAUSED (${pause.reason}${owner ? `, breakpoint ${owner}` : ''}) at ${frameLocation(top)}  [pause #${pause.id}, ${formatAge(Date.now() - pause.since)}]`);
    context.bridge.lastPauseLocation = { pauseId: pause.id, text: frameLocation(top) };
    if (!frame) {
        lines.push(`Frame ${frameIndex} does not exist; the stack has ${stack.length} frames (0-${Math.max(0, stack.length - 1)}).`);
        return lines.join('\n');
    }

    if (frame.localPath && fs.existsSync(frame.localPath) && frame.line > 0) {
        const excerpt = sourceExcerpt(frame.localPath, frame.line);
        if (excerpt) {
            lines.push('', `${displayPath(frame.localPath)} (frame ${frameIndex}):`, excerpt);
        }
    }

    lines.push('', 'Stack:');
    for (const entry of stack.slice(0, STACK_LIMIT)) {
        lines.push(`  ${entry.index === frameIndex ? '*' : ' '}#${entry.index} ${frameLocation(entry)}`);
    }
    if (stack.length > STACK_LIMIT) {
        lines.push(`   ... ${stack.length - STACK_LIMIT} more frames`);
    }

    try {
        lines.push('', ...(await describeFrameVariables(context, session, frameIndex)));
    } catch (error) {
        lines.push('', `Locals could not be read: ${errorText(error)}`);
    }

    lines.push(
        '',
        'Every player on the server is frozen while it is paused. When done: debugger {"action":"continue"} (or step_over / step_in / step_out).',
        `Inspect further with server_run_lua {"frame": ${frameIndex}, "code": "<expression>"}; other frames with debugger {"action":"status","frame":N}.`
    );
    return lines.join('\n');
}

async function describeFrameVariables(context: McpToolContext, session: vscode.DebugSession, frameIndex: number): Promise<string[]> {
    const { locals, upvalues } = await context.bridge.frameVariables(session, frameIndex, 0);
    const out: string[] = [];
    for (const [title, values] of [['Locals', locals], ['Upvalues', upvalues]] as const) {
        const names = Object.keys(values).filter(isLuaIdentifier);
        if (names.length === 0) {
            out.push(`${title}: (none)`);
            continue;
        }
        const shown = names.slice(0, LOCALS_LIMIT);
        let rendered: string | undefined;
        try {
            // The bridge renders values the same way server_run_lua does.
            const chunk = `_GLUALS.formatNamed({${shown.map((name) => luaStringLiteral(name)).join(', ')}}, ${shown.join(', ')})`;
            const values = await context.bridge.evaluate(session, frameIndex, chunk, 0);
            if (typeof values[0] === 'string') {
                rendered = values[0];
            }
        } catch {
            rendered = undefined;
        }
        if (rendered === undefined) {
            rendered = shown.map((name) => `${name} = ${formatLrdbValue(values[name], 0)}`).join('\n');
        }
        out.push(`${title}:`, ...indent(rendered, '  '));
        if (names.length > shown.length) {
            out.push(`  ... ${names.length - shown.length} more`);
        }
    }
    return out;
}

function indent(text: string, prefix: string): string[] {
    return text.split('\n').map((line) => `${prefix}${line}`);
}

function errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    // LRDB errors arrive as JSON; show the message (and detail, when there is one) only.
    try {
        const parsed = JSON.parse(message) as { message?: string; data?: { detail?: unknown } };
        if (parsed && typeof parsed.message === 'string') {
            const detail = typeof parsed.data?.detail === 'string' ? `: ${parsed.data.detail}` : '';
            return `${parsed.message}${detail}`;
        }
    } catch {
        // not JSON
    }
    return message;
}

export function formatRunReport(report: RunReport | null, mapping: GmodSourceMapping): { text: string; isError: boolean } {
    if (!report || typeof report !== 'object') {
        return {
            isError: true,
            text: 'The code was sent, but the server returned no result, so the bridge on the server is out of date.\n'
                + 'Fix: restart the map or server so it loads the updated lua/autorun/debug.lua, and make sure gm_rdb is current '
                + '(command "GMod Debugger: Check for Updates"). Anything it printed still shows up in server_console.',
        };
    }
    const lines: string[] = [];
    const duration = typeof report.durationMs === 'number' ? ` in ${report.durationMs} ms` : '';
    if (report.ok) {
        const returns = Array.isArray(report.returns) ? report.returns : [];
        if (returns.length === 0) {
            lines.push(`OK${duration}. No return values (add "return <expr>" to see values).`);
        } else if (returns.length === 1) {
            lines.push(`OK${duration}. Returned:`, ...indent(returns[0], '  '));
        } else {
            lines.push(`OK${duration}. Returned ${returns.length} values:`);
            returns.forEach((value, index) => lines.push(...indent(`${index + 1}: ${value}`, '  ')));
        }
    } else {
        lines.push(`ERROR (${report.phase ?? 'runtime'})${duration}: ${mapGamePathsInText(report.error ?? 'unknown error', mapping)}`);
        if (Array.isArray(report.traceback) && report.traceback.length > 0) {
            lines.push('Traceback:', ...report.traceback.map((line) => `  ${mapGamePathsInText(line, mapping)}`));
        }
    }
    const output = typeof report.output === 'string' ? report.output.replace(/\n$/, '') : '';
    if (output.length > 0) {
        lines.push(report.ok ? 'Printed:' : 'Printed before the error:', ...indent(output, '  '));
    }
    return { text: lines.join('\n'), isError: !report.ok };
}

function luaPathForFile(file: string, mapping: GmodSourceMapping): string {
    const gamePath = clientPathToGamePath(file, mapping);
    if (gamePath === undefined) {
        throw new ToolInputError(`${displayPath(file)} is outside the debugger's sourceRoot/sourceFileMap, so the server cannot include it.`);
    }
    const luaPath = gamePathToLuaPath(gamePath);
    if (luaPath === undefined) {
        throw new ToolInputError(`${gamePath} is not under lua/, gamemodes/ or addons/<name>/lua/, so include() cannot load it.`);
    }
    return luaPath;
}

function isSyntaxError(message: string): boolean {
    return /expected near|unexpected symbol|'<eof>'|near '/.test(message);
}

async function evaluateInFrame(context: McpToolContext, session: vscode.DebugSession, frame: number, code: string): Promise<ToolReply> {
    const asExpression = `_GLUALS.formatAll(${code})`;
    const asBlock = `return _GLUALS.formatAll((function()\n${code}\nend)())`;
    let values: unknown[];
    try {
        values = await context.bridge.evaluate(session, frame, asExpression, 0);
    } catch (first) {
        if (!isSyntaxError(errorText(first))) {
            return { text: `ERROR in frame ${frame}: ${errorText(first)}`, isError: true };
        }
        try {
            values = await context.bridge.evaluate(session, frame, asBlock, 0);
        } catch (second) {
            return { text: `ERROR in frame ${frame}: ${errorText(second)}`, isError: true };
        }
    }
    const rendered = typeof values[0] === 'string' ? values[0] : values.map((value) => formatLrdbValue(value, 2)).join('\n');
    return { text: `Frame ${frame}:\n${indent(rendered, '  ').join('\n')}` };
}

function runLuaTool(context: McpToolContext): ToolSpec {
    return {
        definition: {
            name: 'server_run_lua',
            title: 'Run Lua on the GMod server',
            description: [
                'Run Lua in the Garry\'s Mod SERVER realm and get back its return values, everything it printed, and any error with a traceback.',
                'Use `return` to see values, e.g. `return #player.GetAll(), game.GetMap()`. Entities, vectors and tables are shown readably.',
                '`file` runs a workspace Lua file on the server with include() (useful after editing it).',
                'While the server is paused, pass `frame` (0 = top of the stack) to evaluate in that frame with its locals and upvalues in scope.',
                'If the code hits a breakpoint the reply says where the server paused; the code\'s own result is reported by a later reply after you continue.',
                'Server only: for clientside Lua use a client MCP. Attaches the debugger automatically if needed.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'Lua source to run. In frame mode an expression (or statements with return).' },
                    file: { type: 'string', description: 'Workspace Lua file to include() on the server instead of code.' },
                    frame: { type: 'integer', minimum: 0, description: 'Only while paused: stack frame to evaluate in.' },
                    timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'How long to wait for a result (default 15000).' },
                },
            },
            annotations: { title: 'Run server Lua', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        },
        handler: async (args, signal) => {
            requireExecution(context);
            const code = stringArg(args, 'code');
            const file = stringArg(args, 'file');
            const frame = numberArg(args, 'frame', { min: 0 });
            const timeoutMs = numberArg(args, 'timeout_ms', { min: 1000, max: 120_000, fallback: 15_000 })!;
            if ((code === undefined || code.trim() === '') === (file === undefined || file.trim() === '')) {
                throw new ToolInputError('Pass exactly one of "code" or "file".');
            }
            const { session, state, attachedNote } = await requireSession(context);
            const mapping = mappingOf(state);
            const prefix = attachedNote ? `${attachedNote}\n` : '';

            if (frame !== undefined) {
                if (!context.bridge.pause && !state.paused) {
                    throw new ToolInputError('"frame" only works while the server is paused. Remove it to run in the global environment.');
                }
                if (file !== undefined) {
                    throw new ToolInputError('"file" cannot be combined with "frame".');
                }
                const reply = await evaluateInFrame(context, session, Math.floor(frame), code!);
                return { ...reply, text: prefix + reply.text };
            }

            let lua = code ?? '';
            let label = lua.split('\n')[0].slice(0, 60);
            if (file !== undefined) {
                const resolved = resolveWorkspacePath(file, state.sourceRoot);
                if (!resolved || !fs.existsSync(resolved)) {
                    throw new ToolInputError(`File not found: ${file}`);
                }
                const luaPath = luaPathForFile(resolved, mapping);
                lua = `return include(${luaStringLiteral(luaPath)})`;
                label = `include("${luaPath}")`;
            }

            const pauseBefore = context.bridge.currentPauseCounter;
            const wasPaused = context.bridge.pause !== undefined;
            // The adapter request outlives our timeout so a late result can still be reported.
            const run = context.bridge.runLua(session, lua, 10 * 60_000);
            type Outcome = { kind: 'done'; report: RunReport | null } | { kind: 'failed'; error: unknown } | { kind: 'paused'; pause: PauseInfo } | { kind: 'timeout' };
            const outcomes: Array<Promise<Outcome>> = [
                run.then((report) => ({ kind: 'done', report }) as Outcome, (error) => ({ kind: 'failed', error }) as Outcome),
                new Promise<Outcome>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)),
            ];
            if (!wasPaused) {
                outcomes.push(context.bridge.waitForPause(timeoutMs + 1000, pauseBefore, (listener) => signal.onAbort(listener))
                    .then((pause) => pause ? { kind: 'paused', pause } as Outcome : { kind: 'timeout' } as Outcome));
            }
            const outcome = await Promise.race(outcomes);
            switch (outcome.kind) {
                case 'done': {
                    const formatted = formatRunReport(outcome.report, mapping);
                    return { text: prefix + formatted.text, isError: formatted.isError };
                }
                case 'failed':
                    return { text: `${prefix}The server rejected the request: ${errorText(outcome.error)}`, isError: true };
                case 'paused': {
                    context.bridge.followLateRun(label, run);
                    const snapshot = await describePause(context, session, outcome.pause, 0);
                    return {
                        text: `${prefix}The code hit a breakpoint and is still running inside the paused server. Its result will be reported after you continue.\n\n${snapshot}`,
                        describesPause: true,
                    };
                }
                case 'timeout':
                    context.bridge.followLateRun(label, run);
                    return {
                        text: `${prefix}No result after ${timeoutMs} ms. The code may be stuck in a loop or waiting; the server is unresponsive while it runs.\n`
                            + 'Use debugger {"action":"pause"} to see where it is. A late result will be reported in a later reply.',
                        isError: true,
                    };
            }
        },
    };
}

const DEBUGGER_ACTIONS = ['status', 'attach', 'wait', 'continue', 'step_over', 'step_in', 'step_out', 'pause'] as const;

function debuggerTool(context: McpToolContext): ToolSpec {
    return {
        definition: {
            name: 'debugger',
            title: 'Control the GMod server debugger',
            description: [
                'Status and control of the VS Code debugger attached to the Garry\'s Mod server.',
                'status: connection, run state and, when paused, the paused location with source, stack, locals and upvalues (choose a frame with `frame`).',
                'attach: connect the debugger (other tools also do this automatically).',
                'wait: block until a breakpoint is hit (up to timeout_ms, default 25000). "Still running" is a normal answer: trigger the code (server_run_lua, a client MCP or the user) and call wait again.',
                'continue: resume; by default returns at once, or pass timeout_ms to also wait for the next hit.',
                'step_over / step_in / step_out: step while paused and return the new location.',
                'pause: break wherever the server is now (finds infinite loops and hangs).',
                'While paused the whole server is frozen for every player, so always continue when done.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: [...DEBUGGER_ACTIONS] },
                    frame: { type: 'integer', minimum: 0, description: 'Stack frame to show locals for when paused (default 0).' },
                    timeout_ms: { type: 'integer', minimum: 0, maximum: 55000, description: 'How long to wait for a stop.' },
                },
                required: ['action'],
            },
            annotations: { title: 'Debugger', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        handler: async (args, signal) => {
            const action = enumArg(args, 'action', DEBUGGER_ACTIONS);
            const frame = Math.floor(numberArg(args, 'frame', { min: 0, fallback: 0 })!);
            const onAbort = (listener: () => void) => signal.onAbort(listener);

            if (action === 'status' && !context.bridge.session) {
                return {
                    text: 'Debugger: not attached. Any server tool attaches it automatically, or call debugger {"action":"attach"}.\n'
                        + `Console cursor: ${context.bridge.events.cursor}.`,
                };
            }
            const { session, state, attachedNote } = await requireSession(context);
            const prefix = attachedNote ? `${attachedNote}\n` : '';

            const describe = async (pause: PauseInfo | undefined, waitedFor?: string): Promise<ToolReply> => {
                const current = pause ?? context.bridge.pause;
                if (current) {
                    return { text: prefix + await describePause(context, session, current, frame), describesPause: true };
                }
                return { text: prefix + (waitedFor ? `${waitedFor}\n` : '') + await describeRunning(context, session, state) };
            };

            switch (action) {
                case 'status':
                case 'attach':
                    return describe(undefined);
                case 'wait': {
                    const timeout = numberArg(args, 'timeout_ms', { min: 0, max: 55_000, fallback: 25_000 })!;
                    const pause = await context.bridge.waitForPause(timeout, undefined, onAbort);
                    return describe(pause, pause ? undefined : `Still running after ${timeout} ms: no breakpoint was hit. This is normal; trigger the code and call wait again.`);
                }
                case 'pause': {
                    const pause = await context.bridge.requestPause(session, numberArg(args, 'timeout_ms', { min: 0, max: 55_000, fallback: 5000 })!, onAbort);
                    return describe(pause, pause ? undefined : 'Pause was requested but the server has not stopped yet. It stops at the next Lua line it runs; call wait.');
                }
                case 'continue':
                case 'step_over':
                case 'step_in':
                case 'step_out': {
                    if (!context.bridge.pause && !state.paused) {
                        throw new ToolInputError(`The server is not paused, so there is nothing to ${action.replace('_', ' ')}. Use wait to wait for a breakpoint.`);
                    }
                    const fallback = action === 'continue' ? 0 : 5000;
                    const timeout = numberArg(args, 'timeout_ms', { min: 0, max: 55_000, fallback })!;
                    const pause = await context.bridge.step(session, action as StepKind, timeout, onAbort);
                    const note = action === 'continue'
                        ? (timeout > 0 ? `Resumed; no breakpoint hit within ${timeout} ms.` : 'Resumed. The server is running.')
                        : `Stepped, but the server did not stop again within ${timeout} ms (execution left Lua or ran on). It is running.`;
                    return describe(pause, pause ? undefined : note);
                }
            }
        },
    };
}

async function describeRunning(context: McpToolContext, session: vscode.DebugSession, state: SessionState): Promise<string> {
    const lines = [`Debugger: attached (gm_rdb ${state.moduleVersion ?? 'unknown'}, protocol ${state.protocolVersion ?? 'unknown'}). The server is RUNNING.`];
    const sourceBreakpoints = vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint);
    const agent = sourceBreakpoints.filter((bp) => context.bridge.agentBreakpointIds.has(bp.id)).length;
    const logpoints = sourceBreakpoints.filter((bp) => bp.logMessage).length;
    lines.push(`Breakpoints: ${sourceBreakpoints.length} (${agent} set by you, ${logpoints} logpoints).`);
    lines.push(`Lua errors since last clear: ${context.bridge.events.errorCount}. Console cursor: ${context.bridge.events.cursor}.`);
    if (state.sourceRoot) {
        lines.push(`Game paths map to: ${state.sourceRoot}`);
    }
    void session;
    return lines.join('\n');
}

const BREAKPOINT_ACTIONS = ['set', 'remove', 'list', 'clear'] as const;

interface BreakpointItem {
    file: string;
    line?: number;
    condition?: string;
    hit_condition?: string;
    log_message?: string;
}

function parseItems(args: Record<string, unknown>, requireLine: boolean): BreakpointItem[] {
    const raw = args.items;
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw)) {
        throw new ToolInputError('"items" must be an array of {file, line, ...}.');
    }
    return raw.map((item, index) => {
        if (!item || typeof item !== 'object') {
            throw new ToolInputError(`items[${index}] must be an object.`);
        }
        const entry = item as Record<string, unknown>;
        const file = stringArg(entry, 'file');
        if (!file) {
            throw new ToolInputError(`items[${index}].file is required.`);
        }
        const line = numberArg(entry, 'line', { min: 1 });
        if (requireLine && line === undefined) {
            throw new ToolInputError(`items[${index}].line is required.`);
        }
        return {
            file,
            line: line === undefined ? undefined : Math.floor(line),
            condition: stringArg(entry, 'condition'),
            hit_condition: stringArg(entry, 'hit_condition'),
            log_message: stringArg(entry, 'log_message'),
        };
    });
}

/** Moves a line down past blank and comment-only lines, as the debug adapter does. */
function effectiveLine(file: string, line: number): number {
    try {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        let current = line;
        while (current <= lines.length) {
            const text = lines[current - 1].trim();
            if (text.length > 0 && !text.startsWith('--')) {
                return current;
            }
            current += 1;
        }
    } catch {
        // keep the line as given
    }
    return line;
}

/** Files in these places usually only run on clients, so a server breakpoint never hits. */
export function looksClientOnly(file: string): boolean {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    const base = path.posix.basename(normalized);
    if (base.startsWith('cl_') || base === 'cl_init.lua') {
        return true;
    }
    return /\/(autorun\/client|vgui|effects|matproxy|postprocess|skins)\//.test(normalized);
}

function sameFile(a: string, b: string): boolean {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function describeBreakpoint(context: McpToolContext, bp: vscode.SourceBreakpoint, hits: number | undefined): string {
    const where = `${displayPath(bp.location.uri.fsPath)}:${bp.location.range.start.line + 1}`;
    const parts = [where];
    parts.push(bp.logMessage ? `logpoint "${bp.logMessage}"` : 'breakpoint');
    if (bp.condition) {
        parts.push(`if ${bp.condition}`);
    }
    if (bp.hitCondition && !bp.logMessage) {
        parts.push(`hits ${bp.hitCondition}`);
    }
    if (!bp.enabled) {
        parts.push('(disabled)');
    }
    parts.push(context.bridge.agentBreakpointIds.has(bp.id) ? '[yours]' : '[user]');
    if (hits !== undefined) {
        parts.push(`hit ${hits}x`);
    }
    return parts.join('  ');
}

function breakpointsTool(context: McpToolContext): ToolSpec {
    return {
        definition: {
            name: 'breakpoints',
            title: 'Manage GMod server breakpoints and logpoints',
            description: [
                'Set, remove, list or clear breakpoints in server Lua files. They show up in the user\'s VS Code editor.',
                'set: items [{file, line, condition?, hit_condition?, log_message?}]. Lines are 1-based; blank or comment lines move to the next code line.',
                '`condition` is a Lua expression using the frame\'s locals; `hit_condition` like ">= 3" or "% 10".',
                '`log_message` makes a LOGPOINT: it prints e.g. "hp={ply:Health()}" to server_console and never pauses. Prefer logpoints when something else (a client MCP or a player) is driving the game, because a breakpoint freezes the whole server.',
                'list: all breakpoints with hit counts. remove: items [{file, line?}]. clear: removes the breakpoints you set (never the user\'s), optionally only in `file`.',
                'Breakpoints in clientside files never hit on the server.',
            ].join(' '),
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: [...BREAKPOINT_ACTIONS] },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                file: { type: 'string', description: 'Workspace-relative or absolute path.' },
                                line: { type: 'integer', minimum: 1 },
                                condition: { type: 'string' },
                                hit_condition: { type: 'string' },
                                log_message: { type: 'string', description: 'Text with {lua expressions}; makes a logpoint.' },
                            },
                            required: ['file'],
                        },
                    },
                    file: { type: 'string', description: 'For clear/list: only this file.' },
                },
                required: ['action'],
            },
            annotations: { title: 'Breakpoints', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        handler: async (args) => {
            const action = enumArg(args, 'action', BREAKPOINT_ACTIONS);
            const session = context.bridge.session;
            const state = session ? await context.bridge.state(session).catch(() => undefined) : undefined;
            const sourceRoot = state?.sourceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const fileFilterArg = stringArg(args, 'file');
            const fileFilter = fileFilterArg ? resolveWorkspacePath(fileFilterArg, sourceRoot) : undefined;
            const all = () => vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint);

            if (action === 'set') {
                const items = parseItems(args, true);
                if (items.length === 0) {
                    throw new ToolInputError('"items" is required for set.');
                }
                const lines: string[] = [];
                const created: vscode.SourceBreakpoint[] = [];
                const replaced: vscode.SourceBreakpoint[] = [];
                for (const item of items) {
                    const resolved = resolveWorkspacePath(item.file, sourceRoot);
                    if (!resolved || !fs.existsSync(resolved)) {
                        lines.push(`SKIPPED ${item.file}: file not found.`);
                        continue;
                    }
                    const line = effectiveLine(resolved, item.line!);
                    replaced.push(...all().filter((bp) => sameFile(bp.location.uri.fsPath, resolved) && bp.location.range.start.line + 1 === line));
                    const bp = new vscode.SourceBreakpoint(
                        new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(line - 1, 0)),
                        true,
                        item.condition?.trim() || undefined,
                        item.log_message ? undefined : item.hit_condition?.trim() || undefined,
                        item.log_message?.trim() || undefined
                    );
                    created.push(bp);
                    const notes: string[] = [];
                    if (line !== item.line) {
                        notes.push(`moved from line ${item.line} to the next code line`);
                    }
                    if (looksClientOnly(resolved)) {
                        notes.push('WARNING: this looks like a clientside file; server breakpoints there will not hit');
                    }
                    lines.push(`SET ${describeBreakpoint(context, bp, undefined).replace(/\s+\[user\]$/, '')}${notes.length ? ` (${notes.join('; ')})` : ''}`);
                }
                if (replaced.length > 0) {
                    vscode.debug.removeBreakpoints(replaced);
                }
                if (created.length > 0) {
                    vscode.debug.addBreakpoints(created);
                    for (const bp of created) {
                        context.bridge.agentBreakpointIds.add(bp.id);
                    }
                }
                if (!session) {
                    lines.push('The debugger is not attached yet; these become active when it attaches (any server tool attaches it).');
                }
                return { text: lines.join('\n') };
            }

            if (action === 'remove') {
                const items = parseItems(args, false);
                if (items.length === 0) {
                    throw new ToolInputError('"items" is required for remove (use clear to remove all of yours).');
                }
                const toRemove = new Set<vscode.SourceBreakpoint>();
                for (const item of items) {
                    const resolved = resolveWorkspacePath(item.file, sourceRoot);
                    for (const bp of all()) {
                        if (resolved && sameFile(bp.location.uri.fsPath, resolved)
                            && (item.line === undefined || bp.location.range.start.line + 1 === effectiveLine(resolved, item.line))) {
                            toRemove.add(bp);
                        }
                    }
                }
                vscode.debug.removeBreakpoints([...toRemove]);
                for (const bp of toRemove) {
                    context.bridge.agentBreakpointIds.delete(bp.id);
                }
                return { text: toRemove.size === 0 ? 'No matching breakpoints.' : `Removed ${toRemove.size} breakpoint(s).` };
            }

            if (action === 'clear') {
                const mine = all().filter((bp) => context.bridge.agentBreakpointIds.has(bp.id)
                    && (!fileFilter || sameFile(bp.location.uri.fsPath, fileFilter)));
                vscode.debug.removeBreakpoints(mine);
                for (const bp of mine) {
                    context.bridge.agentBreakpointIds.delete(bp.id);
                }
                const userCount = all().length;
                return { text: `Removed ${mine.length} breakpoint(s) you set.${userCount > 0 ? ` ${userCount} remain (set by the user; left alone).` : ''}` };
            }

            // list
            const listed = all().filter((bp) => !fileFilter || sameFile(bp.location.uri.fsPath, fileFilter));
            if (listed.length === 0) {
                return { text: 'No breakpoints.' };
            }
            const hitCounts = new Map<string, number>();
            const mapping = mappingOf(state);
            if (session) {
                try {
                    for (const entry of await context.bridge.serverBreakpoints(session)) {
                        if (entry.file && typeof entry.line === 'number') {
                            hitCounts.set(`${entry.file.replace(/\\/g, '/').toLowerCase()}:${entry.line}`, entry.hit_count ?? 0);
                        }
                    }
                } catch {
                    // hit counts are optional
                }
            }
            const lines = listed.map((bp) => {
                const line = bp.location.range.start.line + 1;
                const gamePath = clientPathToGamePath(bp.location.uri.fsPath, mapping);
                let hits: number | undefined;
                if (gamePath !== undefined) {
                    if (bp.logMessage) {
                        const prefix = logpointLinePrefix(logpointLabel(gamePath, line));
                        hits = context.bridge.events.queryConsole({ search: prefix, limit: 500 }).entries.length;
                    } else if (session) {
                        hits = hitCounts.get(`${gamePath.replace(/\\/g, '/').toLowerCase()}:${line}`);
                    }
                }
                return describeBreakpoint(context, bp, hits);
            });
            if (!session) {
                lines.push('(The debugger is not attached, so hit counts are unknown.)');
            }
            return { text: lines.join('\n') };
        },
    };
}

export function runtimeTools(context: McpToolContext): ToolSpec[] {
    return [runLuaTool(context), debuggerTool(context), breakpointsTool(context)];
}
