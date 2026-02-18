import * as vscode from 'vscode';

export interface IGmodGetOutputToolInput {
    limit?: number;
}

interface GmodOutputEntry {
    readonly timestamp: string;
    readonly source: string;
    readonly level: 'info' | 'error';
    readonly message: string;
}

interface GmodGetOutputToolOptions {
    readonly getOutput: (limit: number) => { total: number; items: readonly GmodOutputEntry[]; };
}

export class GmodGetOutputTool implements vscode.LanguageModelTool<IGmodGetOutputToolInput> {
    public constructor(private readonly options: GmodGetOutputToolOptions) { }

    public async prepareInvocation(
        invocationOptions: vscode.LanguageModelToolInvocationPrepareOptions<IGmodGetOutputToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const requestedLimit = invocationOptions.input.limit ?? 50;
        return {
            invocationMessage: `Retrieving recent GMod output entries (up to ${Math.min(Math.max(Math.floor(requestedLimit), 1), 200)})...`,
        };
    }

    public async invoke(
        invocationOptions: vscode.LanguageModelToolInvocationOptions<IGmodGetOutputToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const limit = resolveLimit(invocationOptions.input.limit, 200, 50);
        const output = this.options.getOutput(limit);
        if (output.items.length === 0) {
            return createTextResult('No buffered output entries available.');
        }

        const lines = output.items.map((entry) =>
            `- ${entry.timestamp} | source: ${entry.source} | level: ${entry.level} | message: ${sanitizeSingleLine(entry.message)}`
        );

        return createTextResult([
            `Showing ${output.items.length} of ${output.total} output entries:`,
            ...lines,
        ].join('\n'));
    }
}

function resolveLimit(rawLimit: number | undefined, max: number, fallback: number): number {
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
        return fallback;
    }
    return Math.max(1, Math.min(max, Math.floor(rawLimit)));
}

function sanitizeSingleLine(message: string): string {
    return message.replace(/\r?\n/g, ' ').trim();
}

function createTextResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text),
    ]);
}
