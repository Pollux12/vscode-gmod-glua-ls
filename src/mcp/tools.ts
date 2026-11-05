import { codeTools, DiagnosticsWatcher } from './codeTools';
import { logTools } from './logTools';
import { McpTool, textResult } from './mcpHttpServer';
import { formatRunReport, McpToolContext, runtimeTools, ToolReply } from './runtimeTools';
import { ToolInputError } from './toolSupport';

/** Sent to agents in the MCP `initialize` result. Keep it short; tool descriptions carry the details. */
export const MCP_INSTRUCTIONS = `GLuaLS tools for the Garry's Mod SERVER realm, provided by the GLuaLS VS Code extension. For clientside Lua, player input or screenshots, use a client MCP (for example gmcl_mcp) alongside these.

Start with debugger {"action":"status"}. Server tools attach the VS Code debugger to the server automatically.

Workflows:
- Check code: diagnostics {"paths":[...]} after editing; code_lookup for types, docs and definitions, including the GMod API (e.g. "Player:Nick").
- Try something: server_run_lua with "return ..." to see values. Its errors come back with a traceback.
- Runtime errors: server_errors {"clear":true}, reproduce, then server_errors (or pass wait_ms).
- Trace without stopping the game: breakpoints trace [{"function":"MyAddon.Score"}] logs each call's arguments and return values; breakpoints set with log_message logs values at a line (max_hits makes it remove itself). Trigger the code, then server_console {"search":"[trace"} or {"search":"[logpoint"}. Lines from code you ran with server_run_lua also appear in its "Printed" output.
- Inspect state: breakpoints set (optionally with a condition), trigger the code (server_run_lua, a client MCP or ask the user), debugger {"action":"wait"}, read the locals, dig in with server_run_lua {"frame":0,"code":"..."}, then debugger continue or step.
- Hangs: debugger {"action":"pause"} shows where the server is stuck.

Rules:
- While paused the whole server is frozen for every player, and connected clients drop after cl_timeout (30 s by default). Continue as soon as you are done. Prefer traces and logpoints while a client MCP or a person is playing.
- "Still running" from debugger wait is normal: trigger the code and wait again.
- Replies include a cursor. Pass it as "after" to server_console or server_errors to see only what happened since.
- Paths are workspace-relative or absolute local paths; lines are 1-based.
- Clean up when done: debugger {"action":"detach"} removes your breakpoints and traces, resumes, and disconnects if you attached it. To keep the debugger attached, use breakpoints {"action":"clear"} instead.`;

/** Builds the MCP tools. Every reply warns when the server is paused and reports runs that finished late. */
export function buildMcpTools(context: McpToolContext, watcher: DiagnosticsWatcher): McpTool[] {
    const specs = [...runtimeTools(context), ...logTools(context), ...codeTools(context, watcher)];
    const order = ['server_run_lua', 'server_console', 'server_errors', 'diagnostics', 'breakpoints', 'debugger', 'code_lookup'];
    specs.sort((a, b) => order.indexOf(a.definition.name) - order.indexOf(b.definition.name));
    return specs.map((spec) => ({
        definition: spec.definition,
        call: async (args, signal) => {
            const startCursor = context.bridge.events.cursor;
            let reply: ToolReply;
            try {
                reply = await spec.handler(args, signal);
            } catch (error) {
                if (!(error instanceof ToolInputError)) {
                    throw error;
                }
                reply = { text: error.message, isError: true };
            }
            const sections: string[] = [];
            const pause = context.bridge.pause;
            if (pause && !reply.describesPause) {
                const known = context.bridge.lastPauseLocation;
                const where = known && known.pauseId === pause.id ? ` at ${known.text}` : '';
                sections.push(`[SERVER PAUSED (${pause.reason})${where}. Every player is frozen. Inspect with debugger {"action":"status"} or resume with {"action":"continue"}.]`);
            }
            sections.push(reply.text);
            for (const late of context.bridge.takeLateRuns()) {
                const body = late.error !== undefined
                    ? `failed: ${late.error}`
                    : formatRunReport(late.report ?? null, {}).text;
                sections.push(`[An earlier server_run_lua (${late.label}) has now finished]\n${body}`);
            }
            // "Since your previous call" covers what that call caused, except output a console or
            // errors read already showed.
            context.bridge.lastReplyCursor = spec.definition.name === 'server_console' || spec.definition.name === 'server_errors'
                ? context.bridge.events.cursor
                : startCursor;
            return textResult(sections.join('\n\n'), reply.isError === true);
        },
    }));
}
