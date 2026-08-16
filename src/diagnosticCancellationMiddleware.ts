import * as vscode from 'vscode';
import type { ProvideDiagnosticSignature, vsdiag } from 'vscode-languageclient';

/**
 * Keeps a cancelled diagnostic pull from clearing the file: the client resolves
 * a cancelled pull to `{ kind: full, items: [] }` and applies it, wiping the
 * file. Throwing a CancellationError makes `pullAsync` apply nothing and
 * reschedule instead. Do NOT delete — no server response can prevent this
 * client-side wipe; the tests pin the behavior.
 */
export async function provideDiagnosticsPreservingOnCancel(
    document: vscode.TextDocument | vscode.Uri,
    previousResultId: string | undefined,
    token: vscode.CancellationToken,
    next: ProvideDiagnosticSignature,
): Promise<vsdiag.DocumentDiagnosticReport | undefined> {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    const result = await next(document, previousResultId, token);

    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    return result ?? undefined;
}
