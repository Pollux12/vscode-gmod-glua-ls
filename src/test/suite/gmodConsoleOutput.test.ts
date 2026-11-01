import * as assert from 'assert';

import { GmodConsoleLine, GmodConsoleLineAssembler } from '../../debugger/gmod_debugger/GmodConsoleOutput';

const WHITE = { r: 255, g: 255, b: 255, a: 255 };
const BLUE = { r: 0, g: 128, b: 255, a: 255 };

function collect(): { lines: GmodConsoleLine[]; assembler: GmodConsoleLineAssembler } {
    const lines: GmodConsoleLine[] = [];
    return { lines, assembler: new GmodConsoleLineAssembler((line) => lines.push(line), 60_000) };
}

suite('GMod Console Output', () => {
    test('joins the fragments of one print into a single tag-free line', () => {
        const { lines, assembler } = collect();
        for (const message of ['a', '\t', '42', '\t', 'b', '\n']) {
            assembler.push({ channel_id: 3, severity: 0, timestamp: '12:00:00.000', message, color: WHITE });
        }

        assert.deepStrictEqual(lines.map((line) => line.text), ['[12:00:00.000] a\t42\tb\n']);
    });

    test('splits a fragment holding several lines and keeps the remainder pending', () => {
        const { lines, assembler } = collect();
        assembler.push({ timestamp: 't', message: 'one\r\ntwo\nthr', color: WHITE });
        assembler.push({ timestamp: 'u', message: 'ee\n', color: WHITE });

        assert.deepStrictEqual(lines.map((line) => line.text), ['[t] one\n', '[t] two\n', '[t] three\n']);
    });

    test('keeps a blank print as an empty line', () => {
        const { lines, assembler } = collect();
        assembler.push({ timestamp: 't', message: '\n' });

        assert.deepStrictEqual(lines.map((line) => line.text), ['\n']);
    });

    test('colors each segment of a MsgC line and names a spew group', () => {
        const { lines, assembler } = collect();
        assembler.push({ group: 'Developer', timestamp: 't', message: '[addon] ', color: BLUE });
        assembler.push({ group: 'Developer', timestamp: 't', message: 'ready\n', color: WHITE });

        assert.strictEqual(lines.length, 1);
        assert.strictEqual(lines[0].text, '[t] [Developer] [addon] ready\n');
        assert.strictEqual(
            lines[0].ansi,
            '[t] [Developer] \u001b[38;2;0;128;255m[addon] \u001b[38;2;255;255;255mready\u001b[0m\n'
        );
    });

    test('flush emits a line that never received its newline', () => {
        const { lines, assembler } = collect();
        assembler.push({ timestamp: 't', message: 'partial' });
        assert.strictEqual(lines.length, 0);

        assembler.flush();
        assembler.flush();

        assert.deepStrictEqual(lines.map((line) => line.text), ['[t] partial\n']);
    });
});
