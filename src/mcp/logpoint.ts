/**
 * Logpoints for the GMod debugger.
 *
 * LRDB has no logpoints, but it evaluates a breakpoint's condition in the frame
 * that reaches the line, with locals and upvalues visible. A logpoint is therefore
 * a condition that prints its message and evaluates to false, so the game never
 * pauses. Each line starts with `[logpoint <label>]` so it can be found in the console.
 */

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

/** The label a logpoint prints, e.g. `lua/autorun/server/init.lua:12`. */
export function logpointLabel(file: string, line: number): string {
    return `${file.replace(/\\/g, '/')}:${line}`;
}

/** The text a logpoint's console lines start with. */
export function logpointLinePrefix(label: string): string {
    return `${LOGPOINT_PREFIX} ${label}]`;
}

/**
 * Builds the LRDB condition for a logpoint. When `condition` is set the message is
 * only printed while it holds. Interpolated values go through `_GLUALS.format` when
 * the bridge is loaded and `tostring` otherwise.
 */
export function buildLogpointCondition(logMessage: string, label: string, condition?: string): string {
    const formatter = '(_GLUALS and _GLUALS.format or tostring)';
    const pieces = [luaStringLiteral(`${logpointLinePrefix(label)} `)];
    for (const part of parseLogMessage(logMessage)) {
        pieces.push(part.kind === 'text' ? luaStringLiteral(part.value) : `${formatter}((${part.value}))`);
    }
    // print returns nothing, so `print(...) and false` is nil and the line never pauses.
    const printCall = `(print(${pieces.join(' .. ')}) and false)`;
    const trimmed = condition?.trim();
    return trimmed ? `((${trimmed}) and ${printCall})` : printCall;
}
