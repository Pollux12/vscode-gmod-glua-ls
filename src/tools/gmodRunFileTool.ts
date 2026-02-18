import * as vscode from 'vscode';
import { GmodControlResult, GmodRealm, normalizeGmodRealm } from '../debugger/gmod_debugger/GmodDebugControlService';

export interface IGmodRunFileToolInput {
    path: string;
    realm?: string;
}

interface GmodRunFileToolOptions {
    readonly executeControlCommand: (command: 'runLua' | 'runCommand' | 'runFile', args: Record<string, unknown>) => Promise<GmodControlResult>;
    readonly getDebugState: () => Record<string, unknown>;
    readonly getCurrentRealm: () => GmodRealm;
}

export class GmodRunFileTool implements vscode.LanguageModelTool<IGmodRunFileToolInput> {
    public constructor(private readonly options: GmodRunFileToolOptions) { }

    public async prepareInvocation(
        invocationOptions: vscode.LanguageModelToolInvocationPrepareOptions<IGmodRunFileToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Dispatching Lua file in Garry's Mod: ${invocationOptions.input.path}`,
        };
    }

    public async invoke(
        invocationOptions: vscode.LanguageModelToolInvocationOptions<IGmodRunFileToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        ensureActiveDebugSession(this.options.getDebugState(), 'gmod_run_file');

        const filePath = invocationOptions.input.path ?? '';
        if (filePath.trim().length === 0) {
            throw new Error('gmod_run_file requires non-empty "path".');
        }

        const realm = normalizeGmodRealm(invocationOptions.input.realm ?? this.options.getCurrentRealm());
        const result = await this.options.executeControlCommand('runFile', {
            path: filePath,
            realm,
        });

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
