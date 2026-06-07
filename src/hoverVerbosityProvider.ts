import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { HoverExpandParams, HoverExpandResponse } from './lspExtension';

const DEFAULT_HOVER_VERBOSITY_LEVEL = 0;

/**
 * Custom hover provider that uses VS Code's proposed `editorHoverVerbosityLevel`
 * API to show +/− buttons for expanding/collapsing class member lists inline.
 *
 * This is the same pattern used by the Lua Language Server (LuaLS).
 * When the proposed API is unavailable (stable VS Code), falls back to a
 * standard hover without verbosity controls.
 */
export class HoverVerbosityProvider implements vscode.HoverProvider {
    private readonly client: LanguageClient;
    /** Tracks the current verbosity level per hover instance. */
    private readonly hoverLevels = new WeakMap<vscode.Hover, number>();

    constructor(client: LanguageClient) {
        this.client = client;
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context?: vscode.HoverContext,
    ): Promise<vscode.Hover | null> {
        // Compute the verbosity level from context.
        let level = DEFAULT_HOVER_VERBOSITY_LEVEL;
        if (context?.previousHover) {
            const prevLevel = this.hoverLevels.get(context.previousHover) ?? DEFAULT_HOVER_VERBOSITY_LEVEL;
            level = prevLevel + (context.verbosityDelta ?? 0);
        }
        if (level < DEFAULT_HOVER_VERBOSITY_LEVEL) {
            level = DEFAULT_HOVER_VERBOSITY_LEVEL;
        }

        const params: HoverExpandParams = {
            textDocument: { uri: document.uri.toString() },
            position: { line: position.line, character: position.character },
            level,
        };

        let response: HoverExpandResponse | undefined;
        try {
            response = await this.client.sendRequest(
                'gluals/hoverExpand',
                params,
                token,
            );
        } catch {
            return null;
        }

        if (!response) {
            return null;
        }

        // Convert the LSP MarkupContent to a vscode.MarkdownString.
        const md = new vscode.MarkdownString(response.content.value, true);
        md.supportHtml = true;

        // Build the range if provided.
        const range = response.range
            ? new vscode.Range(
                new vscode.Position(response.range.start.line, response.range.start.character),
                new vscode.Position(response.range.end.line, response.range.end.character),
            )
            : undefined;

        // Check if VerboseHover is available (proposed API).
        // The constructor is `new VerboseHover(contents, range?, canIncrease?, canDecrease?)`.
        const VerboseHoverCtor = (vscode as unknown as { VerboseHover?: typeof vscode.VerboseHover })
            .VerboseHover as (new (
                contents: vscode.MarkdownString | vscode.MarkdownString[],
                range?: vscode.Range,
                canIncreaseVerbosity?: boolean,
                canDecreaseVerbosity?: boolean,
            ) => vscode.VerboseHover) | undefined;

        if (VerboseHoverCtor) {
            const canIncrease = level < response.maxLevel;
            const canDecrease = level > DEFAULT_HOVER_VERBOSITY_LEVEL;
            const hover = new VerboseHoverCtor(md, range, canIncrease, canDecrease);
            this.hoverLevels.set(hover, level);
            return hover as unknown as vscode.Hover;
        }

        // Fallback: standard hover without verbosity controls.
        return new vscode.Hover(md, range);
    }
}
