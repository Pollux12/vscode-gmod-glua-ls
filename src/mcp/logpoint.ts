/**
 * Logpoints for the GMod debugger.
 *
 * LRDB has no logpoints, but it evaluates a breakpoint's condition in the frame
 * that reaches the line, with locals and upvalues visible. A logpoint is therefore
 * a condition that prints its message and evaluates to false, so the game never
 * pauses. Each line starts with `[logpoint <label>]` so it can be found in the console.
 */

import { gamePathToLuaPath } from '../debugger/gmod_debugger/GmodSourcePaths';

export const LOGPOINT_PREFIX = '[logpoint';

interface LogMessagePart {
    kind: 'text' | 'expression';
    value: string;
}

/** Splits a DAP log message such as `hp = {ply:Health()}` into text and `{expression}` parts. */
export function parseLogMessage(message: string): LogMessagePart[] {
    const parts: LogMessagePart[] = [];
    let text = '';
    let index = 0;
    while (index < message.length) {
        const ch = message[index];
        if (ch === '{') {
            const end = findClosingBrace(message, index);
            if (end !== undefined) {
                const expression = message.slice(index + 1, end).trim();
                if (expression.length > 0) {
                    if (text.length > 0) {
                        parts.push({ kind: 'text', value: text });
                        text = '';
                    }
                    parts.push({ kind: 'expression', value: expression });
                    index = end + 1;
                    continue;
                }
            }
        }
        text += ch;
        index += 1;
    }
    if (text.length > 0) {
        parts.push({ kind: 'text', value: text });
    }
    return parts;
}

/** Finds the `}` matching the `{` at `start`, skipping braces inside Lua strings and table constructors. */
function findClosingBrace(text: string, start: number): number | undefined {
    let depth = 0;
    let quote: string | undefined;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') {
                i += 1;
            } else if (ch === quote) {
                quote = undefined;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return undefined;
}

/** Quotes text as a Lua string literal. */
export function luaStringLiteral(text: string): string {
    let out = '"';
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (ch === '\\') {
            out += '\\\\';
        } else if (ch === '"') {
            out += '\\"';
        } else if (ch === '\n') {
            out += '\\n';
        } else if (ch === '\r') {
            out += '\\r';
        } else if (ch === '\t') {
            out += '\\t';
        } else if (code < 32 || code === 127) {
            out += `\\${code.toString().padStart(3, '0')}`;
        } else {
            out += ch;
        }
    }
    return `${out}"`;
}

/**
 * The label a logpoint prints, e.g. `autorun/server/init.lua:12` for
 * `addons/myaddon/lua/autorun/server/init.lua`: the path include() would use, which
 * is short and still unique on the server. Files outside lua/ keep their game path.
 */
export function logpointLabel(gamePath: string, line: number): string {
    const normalized = gamePath.replace(/\\/g, '/');
    return `${gamePathToLuaPath(normalized) ?? normalized}:${line}`;
}

/** The text a logpoint's console lines start with. */
export function logpointLinePrefix(label: string): string {
    return `${LOGPOINT_PREFIX} ${label}]`;
}

/**
 * Turns a hit condition ("5", ">= 5", "<= 3", "% 10") into a Lua test of `n`, the
 * number of times the logpoint was reached. A bare number means ">= n", as LRDB reads it.
 */
export function hitConditionTest(hitCondition: string): string | undefined {
    const match = /^\s*(<=|>=|==|<|>|%)?\s*(\d+)\s*$/.exec(hitCondition);
    if (!match) {
        return undefined;
    }
    const operator = match[1] ?? '>=';
    return operator === '%' ? `n % ${match[2]} == 0` : `n ${operator} ${match[2]}`;
}

/**
 * Builds the LRDB condition for a logpoint. When `condition` is set the message is
 * only printed while it holds. A `hitCondition` counts hits on the server under
 * `counterKey`, so "<= 3" prints exactly three times. Interpolated values go through
 * `_GLUALS.format` when the bridge is loaded and `tostring` otherwise.
 *
 * Everything runs inside pcall and the condition always returns false: LRDB treats a
 * condition that raises an error as true, so an error (say `ply` is nil in
 * "{ply:Health()}") would otherwise pause the server. The error is printed instead.
 */
export function buildLogpointCondition(logMessage: string, label: string, condition?: string, hitCondition?: string, counterKey?: string): string {
    const formatter = '(_GLUALS and _GLUALS.format or tostring)';
    const prefix = `${logpointLinePrefix(label)} `;
    const pieces = [luaStringLiteral(prefix)];
    for (const part of parseLogMessage(logMessage)) {
        pieces.push(part.kind === 'text' ? luaStringLiteral(part.value) : `${formatter}((${part.value}))`);
    }
    const gates: string[] = [];
    const trimmed = condition?.trim();
    if (trimmed) {
        gates.push(`(${trimmed})`);
    }
    const test = hitCondition ? hitConditionTest(hitCondition) : undefined;
    if (test) {
        // A server still running an older lua/autorun/debug.lua has no countLogpoint, so count in a global table instead.
        const fallback = 'function(k) local t = rawget(_G, "__glualsLogpointCounts") or {} rawset(_G, "__glualsLogpointCounts", t) t[k] = (t[k] or 0) + 1 return t[k] end';
        const counter = `((_GLUALS and _GLUALS.countLogpoint) or ${fallback})(${luaStringLiteral(counterKey ?? label)})`;
        gates.push(`(function(n) return ${test} end)(${counter})`);
    }
    const printCall = `print(${pieces.join(' .. ')})`;
    const body = gates.length > 0 ? `if ${gates.join(' and ')} then ${printCall} end` : printCall;
    return `(function() local ok, err = pcall(function() ${body} end) if not ok then print(${luaStringLiteral(`${prefix}error: `)} .. (tostring(err):gsub("^%b[]:%d+: ", ""))) end return false end)()`;
}
