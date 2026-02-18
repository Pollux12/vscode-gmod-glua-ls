import * as vscode from 'vscode';

export class GmodGetDebugStateTool implements vscode.LanguageModelTool<Record<string, never>> {
    public constructor(private readonly getDebugState: () => Record<string, unknown>) { }

    public async prepareInvocation(
        _invocationOptions: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: 'Retrieving full GMod debug state...',
        };
    }

    public async invoke(
        _invocationOptions: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const state = this.getDebugState();
        return createTextResult(`\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``);
    }
}

function createTextResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text),
    ]);
}
