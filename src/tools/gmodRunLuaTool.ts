import * as vscode from 'vscode';
import { GmodControlResult, GmodRealm, normalizeGmodRealm } from '../debugger/gmod_debugger/GmodDebugControlService';

export interface IGmodRunLuaToolInput {
    lua: string;
    realm?: string;
}

interface GmodRunLuaToolOptions {
    readonly executeControlCommand: (command: 'runLua' | 'runCommand' | 'runFile', args: Record<string, unknown>) => Promise<GmodControlResult>;
    readonly getDebugState: () => Record<string, unknown>;
    readonly getCurrentRealm: () => GmodRealm;
}

export class GmodRunLuaTool implements vscode.LanguageModelTool<IGmodRunLuaToolInput> {
    public constructor(private readonly options: GmodRunLuaToolOptions) { }

    public async prepareInvocation(
        invocationOptions: vscode.LanguageModelToolInvocationPrepareOptions<IGmodRunLuaToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Running Lua in Garry's Mod${invocationOptions.input.realm ? ` (${invocationOptions.input.realm})` : ''}...`,
        };
    }

    public async invoke(
        invocationOptions: vscode.LanguageModelToolInvocationOptions<IGmodRunLuaToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        ensureActiveDebugSession(this.options.getDebugState(), 'gmod_run_lua');

        const lua = invocationOptions.input.lua ?? '';
        if (lua.trim().length === 0) {
            throw new Error('gmod_run_lua requires non-empty "lua".');
        }

        const realm = normalizeGmodRealm(invocationOptions.input.realm ?? this.options.getCurrentRealm());
        const result = await this.options.executeControlCommand('runLua', {
            lua,
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
