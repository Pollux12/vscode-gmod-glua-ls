import * as vscode from 'vscode';
import {
    ErrorCodes,
    HoverRequest,
    LSPErrorCodes,
    LanguageClient,
    ResponseError,
} from 'vscode-languageclient/node';
import { HoverExpandParams, HoverExpandResponse } from './lspExtension';

const DEFAULT_HOVER_VERBOSITY_LEVEL = 0;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 150;

export interface HoverVerbosityProviderOptions {
    readonly maxTransientRetries?: number;
    readonly retryDelayMs?: number;
}

function getLspErrorCode(error: unknown): number | undefined {
    if (error instanceof ResponseError) {
        return error.code;
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code: unknown }).code;
        if (typeof code === 'number') {
            return code;
        }
    }
    return undefined;
}

function isCancellationError(error: unknown, token: vscode.CancellationToken): boolean {
    return token.isCancellationRequested || error instanceof vscode.CancellationError;
}

function isInactiveConnectionError(error: unknown): boolean {
    const code = getLspErrorCode(error);
    return code === ErrorCodes.ConnectionInactive || code === ErrorCodes.PendingResponseRejected;
}

function isTransientHoverError(error: unknown, token: vscode.CancellationToken): boolean {
    if (token.isCancellationRequested) {
        return false;
    }
    const code = getLspErrorCode(error);
    return (
        code === LSPErrorCodes.ContentModified ||
        code === LSPErrorCodes.RequestCancelled ||
        code === LSPErrorCodes.ServerCancelled
    );
}

function delayWithCancellation(ms: number, token: vscode.CancellationToken): Promise<boolean> {
    if (token.isCancellationRequested) {
        return Promise.resolve(false);
    }
    if (ms <= 0) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        let settled = false;
        let subscription: vscode.Disposable | undefined;
        const finish = (completed: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            subscription?.dispose();
            resolve(completed);
        };
        const timer = setTimeout(() => finish(!token.isCancellationRequested), ms);
        subscription = typeof token.onCancellationRequested === 'function'
            ? token.onCancellationRequested(() => finish(false))
            : undefined;
    });
}

function enableHoverMarkdownFormatting(hover: vscode.Hover): vscode.Hover {
    for (const entry of hover.contents) {
        if (entry instanceof vscode.MarkdownString) {
            entry.supportHtml = true;
            entry.supportThemeIcons = true;
        }
    }
    return hover;
}

function convertFallbackHover(result: unknown): vscode.Hover | null {
    if (!result) {
        return null;
    }
    if (result instanceof vscode.Hover) {
        return result;
    }
    if (typeof result !== 'object' || !('contents' in result)) {
        return null;
    }

    const raw = result as {
        contents: unknown;
        range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    };
    const markdownValue = extractMarkdownValue(raw.contents);
    if (markdownValue === undefined) {
        return null;
    }

    const md = new vscode.MarkdownString(markdownValue, true);
    md.supportHtml = true;
    const range = raw.range
        ? new vscode.Range(
            new vscode.Position(raw.range.start.line, raw.range.start.character),
            new vscode.Position(raw.range.end.line, raw.range.end.character),
        )
        : undefined;
    return new vscode.Hover(md, range);
}

function extractMarkdownValue(contents: unknown): string | undefined {
    if (typeof contents === 'string') {
        return contents;
    }
    if (Array.isArray(contents)) {
        const parts = contents
            .map((entry) => extractMarkdownValue(entry))
            .filter((entry): entry is string => entry !== undefined);
        return parts.length > 0 ? parts.join('\n\n') : undefined;
    }
    if (typeof contents === 'object' && contents !== null && 'value' in contents) {
        const value = (contents as { value: unknown }).value;
        return typeof value === 'string' ? value : undefined;
    }
    return undefined;
}

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
    private readonly maxTransientRetries: number;
    private readonly retryDelayMs: number;
    /** Tracks the current verbosity level per hover instance. */
    private readonly hoverLevels = new WeakMap<vscode.Hover, number>();
    private hoverExpandUnsupported = false;

    constructor(client: LanguageClient, options?: HoverVerbosityProviderOptions) {
        this.client = client;
        this.maxTransientRetries = options?.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
        this.retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context?: vscode.HoverContext,
    ): Promise<vscode.Hover | null> {
        if (token.isCancellationRequested) {
            return null;
        }

        if (this.hoverExpandUnsupported) {
            return this.provideStandardHoverFallback(document, position, token);
        }

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
        for (let attempt = 0; attempt <= this.maxTransientRetries; attempt++) {
            try {
                response = await this.client.sendRequest(
                    'gluals/hoverExpand',
                    params,
                    token,
                );
                break;
            } catch (error) {
                if (isCancellationError(error, token) || isInactiveConnectionError(error)) {
                    return null;
                }

                if (getLspErrorCode(error) === ErrorCodes.MethodNotFound) {
                    this.hoverExpandUnsupported = true;
                    return this.provideStandardHoverFallback(document, position, token);
                }

                if (isTransientHoverError(error, token)) {
                    if (attempt < this.maxTransientRetries) {
                        const shouldContinue = await delayWithCancellation(
                            this.retryDelayMs * (attempt + 1),
                            token,
                        );
                        if (!shouldContinue) {
                            return null;
                        }
                        continue;
                    }
                    return this.provideStandardHoverFallback(document, position, token);
                }

                this.logHoverExpandFailure(error);
                return this.provideStandardHoverFallback(document, position, token);
            }
        }

        if (token.isCancellationRequested || !response) {
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

    private async provideStandardHoverFallback(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.Hover | null> {
        if (token.isCancellationRequested) {
            return null;
        }

        const params = this.client.code2ProtocolConverter?.asTextDocumentPositionParams
            ? this.client.code2ProtocolConverter.asTextDocumentPositionParams(document, position)
            : {
                textDocument: { uri: document.uri.toString() },
                position: { line: position.line, character: position.character },
            };

        try {
            const result = await this.client.sendRequest(HoverRequest.type, params, token);
            if (token.isCancellationRequested || !result) {
                return null;
            }
            if (this.client.protocol2CodeConverter?.asHover) {
                const hover = this.client.protocol2CodeConverter.asHover(result);
                return hover ? enableHoverMarkdownFormatting(hover) : null;
            }
            return convertFallbackHover(result);
        } catch (error) {
            if (isCancellationError(error, token) || isInactiveConnectionError(error)) {
                return null;
            }
            if (typeof this.client.handleFailedRequest === 'function') {
                return this.client.handleFailedRequest(HoverRequest.type, token, error, null);
            }
            const code = getLspErrorCode(error);
            if (code === LSPErrorCodes.ContentModified) {
                return null;
            }
            if (code === LSPErrorCodes.RequestCancelled || code === LSPErrorCodes.ServerCancelled) {
                throw new vscode.CancellationError();
            }
            throw error;
        }
    }

    private logHoverExpandFailure(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof this.client.warn === 'function') {
            this.client.warn(`gluals/hoverExpand failed, falling back to textDocument/hover: ${message}`);
            return;
        }
        console.warn(`[GLuaLS] gluals/hoverExpand failed, falling back to textDocument/hover: ${message}`);
    }
}
