import * as vscode from 'vscode';
import { GmodControlResult } from '../debugger/gmod_debugger/GmodDebugControlService';

export interface IGmodRunCommandToolInput {
    command: string;
}

interface GmodRunCommandToolOptions {
    readonly executeControlCommand: (command: 'runLua' | 'runCommand' | 'runFile', args: Record<string, unknown>) => Promise<GmodControlResult>;
    readonly getDebugState: () => Record<string, unknown>;
}

export class GmodRunCommandTool implements vscode.LanguageModelTool<IGmodRunCommandToolInput> {
    public constructor(private readonly options: GmodRunCommandToolOptions) { }

    public async prepareInvocation(
        invocationOptions: vscode.LanguageModelToolInvocationPrepareOptions<IGmodRunCommandToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Running Garry's Mod console command: ${invocationOptions.input.command}`,
        };
    }

    public async invoke(
        invocationOptions: vscode.LanguageModelToolInvocationOptions<IGmodRunCommandToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        ensureActiveDebugSession(this.options.getDebugState(), 'gmod_run_command');

        const command = invocationOptions.input.command ?? '';
        if (command.trim().length === 0) {
            throw new Error('gmod_run_command requires non-empty "command".');
        }

        const result = await this.options.executeControlCommand('runCommand', { command });

        return createTextResult(formatCommandResult(result));
    }
}

function ensureActiveDebugSession(debugState: Record<string, unknown>, toolName: string): void {
    if (debugState['hasActiveSession'] !== true) {
        throw new Error(`No active GMod debug session. Start a debug session first to use ${toolName}.`);
    }
}

function formatCommandResult(result: GmodControlResult): string {
    const diagnostics = result.diagnostics.length > 0
        ? result.diagnostics.map((entry) => `[${entry.level}] ${entry.message}`).join(' | ')
        : 'None';
    const requestSuffix = result.request ? ` | request: ${result.request}` : '';
    const status = result.ok ? 'ok' : 'error';

    return [
        `**Command executed in ${result.realm} realm**`,
        `Result: ${status} (correlationId: ${result.correlationId})${requestSuffix}`,
        `Diagnostics: ${diagnostics}`,
    ].join('\n');
}

function createTextResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text),
    ]);
}
