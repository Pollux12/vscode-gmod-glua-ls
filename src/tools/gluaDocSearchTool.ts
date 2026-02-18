import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { GluaDocSearchParams, GluaDocSearchResponse } from '../lspExtension';

export interface IGluaDocSearchInput {
    query: string;
    limit?: number;
}

export class GluaDocSearchTool implements vscode.LanguageModelTool<IGluaDocSearchInput> {
    constructor(private readonly getClient: () => LanguageClient | undefined) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGluaDocSearchInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Searching GLua API documentation for "${options.input.query}"...`,
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGluaDocSearchInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const client = this.getClient();
        if (!client) {
            throw new Error('GLua Language Server is not running. Cannot search documentation.');
        }

        const params: GluaDocSearchParams = {
            query: options.input.query,
            limit: Math.min(options.input.limit ?? 10, 20),
        };

        const response = await client.sendRequest<GluaDocSearchResponse>('gluals/docSearch', params);

        if (!response || response.items.length === 0) {
            return createTextResult(`No GLua API documentation found for query: "${params.query}".`);
        }

        const formatted = response.items
            .map((item) => {
                const deprecatedNote = item.deprecated ? '\n> **Deprecated**\n' : '';
                return `## \`${item.fullName}\` *(${item.kind})*\n${deprecatedNote}\n${item.documentation}`;
            })
            .join('\n\n---\n\n');

        return createTextResult(formatted);
    }
}

function createTextResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text),
    ]);
}
