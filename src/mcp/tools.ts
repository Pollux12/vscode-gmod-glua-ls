import { codeTools, DiagnosticsWatcher } from './codeTools';
import { logTools } from './logTools';
import { McpTool, textResult } from './mcpHttpServer';
import { formatRunReport, McpToolContext, runtimeTools, ToolReply } from './runtimeTools';
import { ToolInputError } from './toolSupport';

/** Sent to agents in the MCP `initialize` result. Keep it short; tool descriptions carry the details. */
export const MCP_INSTRUCTIONS = `GLuaLS tools for the Garry's Mod SERVER realm, provided by the GLuaLS VS Code extension. For clientside Lua, player input or screenshots, use a client MCP (for example gmcl_mcp) alongside these.

Server tools attach the VS Code debugger automatically. debugger {} shows the connection, run state and, when paused, where.

Common calls, with their exact arguments:
- Run Lua and see values: server_run_lua {"code":"return #player.GetAll(), MyAddon.Config"}
- Lua errors, including ones from before the debugger attached: server_errors {}. Start fresh with server_errors {"clear":true}; wait for a new one with server_errors {"wait_ms":10000}.
- Console output (prints, engine messages such as "Dropped <name> from server"): server_console {"search":"dropped","limit":50}. Run a command: server_console {"command":"status"}. Wait for lines: server_console {"search":"[logpoint","wait_ms":10000,"wait_count":3}.
- Log values at a line without pausing (logpoint): breakpoints {"action":"set","items":[{"file":"lua/myaddon/sv_init.lua","line":42,"log_message":"hp={ply:Health()}","max_hits":5}]}
- Log every call of a function: breakpoints {"action":"trace","items":[{"function":"MyAddon.Score","max_calls":10}]}
- Pause at a line: breakpoints {"action":"set","items":[{"file":"lua/myaddon/sv_init.lua","line":42,"condition":"amount < 0"}]}, trigger the code, then debugger {"action":"wait"}. Read values with server_run_lua {"frame":0,"code":"return ply, amount"}, then debugger {"action":"continue"} (or step_over, step_in, step_out).
- Find a hang: debugger {"action":"pause"}
- Check code: diagnostics {"paths":["lua/myaddon/sv_init.lua"]} after editing; code_lookup {"symbol":"Player:Nick"} for docs, types and definitions.
- Clean up: breakpoints {"action":"clear"} removes everything you set; debugger {"action":"detach"} also resumes and disconnects if you attached it.

Rules:
- "items" is always a list, even for one breakpoint. Lines are 1-based. Paths can be workspace-relative, relative to lua/ as include() uses them, or absolute.
- While paused the whole server is frozen for every player, and connected clients drop after cl_timeout (30 s by default). Continue as soon as you are done. Prefer logpoints and traces while a person or a client MCP is playing.
- "Still running" from debugger wait is normal: trigger the code and wait again.
- Replies include a cursor. Pass it as "after" to server_console or server_errors to see only what happened since.`;

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
