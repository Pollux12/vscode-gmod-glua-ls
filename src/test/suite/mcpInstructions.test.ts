import * as assert from 'assert';

import { DiagnosticsWatcher } from '../../mcp/codeTools';
import { McpToolContext } from '../../mcp/runtimeTools';
import { buildMcpTools, MCP_INSTRUCTIONS } from '../../mcp/tools';

interface Schema {
    type?: string;
    enum?: string[];
    properties?: Record<string, Schema>;
    items?: Schema;
}

/** Finds `tool {json}` examples in the instructions, balancing braces so nested objects are included. */
function examples(text: string): Array<{ tool: string; json: string }> {
    const found: Array<{ tool: string; json: string }> = [];
    const pattern = /\b([a-z_]+) \{/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
        const start = match.index + match[1].length + 1;
        let depth = 0;
        let quoted = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '\\') i++;
                else if (ch === '"') quoted = false;
                continue;
            }
            if (ch === '"') quoted = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) {
                found.push({ tool: match[1], json: text.slice(start, i + 1) });
                break;
            }
        }
    }
    return found;
}

function checkValue(value: unknown, schema: Schema, where: string): void {
    if (schema.enum) {
        assert.ok(schema.enum.includes(value as string), `${where}: "${String(value)}" is not one of ${schema.enum.join(', ')}`);
    }
    if (schema.type === 'array') {
        assert.ok(Array.isArray(value), `${where} must be a list`);
        (value as unknown[]).forEach((item, index) => checkValue(item, schema.items ?? {}, `${where}[${index}]`));
    } else if (schema.type === 'object' || schema.properties) {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${where} must be an object`);
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
            const property = schema.properties?.[key];
            assert.ok(property, `${where}: unknown argument "${key}"`);
            checkValue(inner, property, `${where}.${key}`);
        }
    } else if (schema.type === 'integer' || schema.type === 'number') {
        assert.strictEqual(typeof value, 'number', `${where} must be a number`);
    } else if (schema.type === 'string') {
        assert.strictEqual(typeof value, 'string', `${where} must be a string`);
    } else if (schema.type === 'boolean') {
        assert.strictEqual(typeof value, 'boolean', `${where} must be true or false`);
    }
}

suite('MCP instructions', () => {
    // Agents often call a tool from these instructions before its schema has loaded, so every example must be exact.
    test('every example call is valid against its tool schema', () => {
        const tools = buildMcpTools({} as McpToolContext, {} as DiagnosticsWatcher);
        const schemas = new Map(tools.map((tool) => [tool.definition.name, tool.definition.inputSchema as Schema]));
        const calls = examples(MCP_INSTRUCTIONS).filter((call) => schemas.has(call.tool));
        assert.ok(calls.length >= 12, `expected at least 12 example calls, found ${calls.length}`);
        for (const call of calls) {
            let args: unknown;
            assert.doesNotThrow(() => { args = JSON.parse(call.json); }, `${call.tool} ${call.json} is not valid JSON`);
            checkValue(args, schemas.get(call.tool)!, call.tool);
        }
        const mentioned = new Set(calls.map((call) => call.tool));
        for (const name of schemas.keys()) {
            assert.ok(mentioned.has(name), `the instructions have no example call for ${name}`);
        }
    });
});
