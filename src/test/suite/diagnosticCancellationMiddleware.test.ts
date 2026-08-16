import * as assert from 'assert';
import * as vscode from 'vscode';

import { vsdiag } from 'vscode-languageclient';

import { provideDiagnosticsPreservingOnCancel } from '../../diagnosticCancellationMiddleware';

// Pins the middleware's do-not-delete behavior (see its doc comment).
suite('diagnostic cancellation middleware', () => {
    const uri = vscode.Uri.file('/test.lua');

    test('throws when the token is cancelled while the request is in flight', async () => {
        const source = new vscode.CancellationTokenSource();
        const next = async (): Promise<vsdiag.DocumentDiagnosticReport> => {
            source.cancel();
            return { kind: vsdiag.DocumentDiagnosticReportKind.full, items: [] };
        };

        await assert.rejects(
            () => provideDiagnosticsPreservingOnCancel(uri, undefined, source.token, next),
            (error: unknown) => error instanceof vscode.CancellationError,
            'a cancelled pull must throw so pullAsync leaves the diagnostics alone',
        );
    });

    test('throws without issuing the request when already cancelled', async () => {
        const source = new vscode.CancellationTokenSource();
        source.cancel();

        let called = false;
        const next = async (): Promise<vsdiag.DocumentDiagnosticReport> => {
            called = true;
            return { kind: vsdiag.DocumentDiagnosticReportKind.full, items: [] };
        };

        await assert.rejects(() =>
            provideDiagnosticsPreservingOnCancel(uri, undefined, source.token, next),
        );
        assert.strictEqual(called, false, 'no request should be sent for a cancelled pull');
    });

    test('passes the report through untouched when not cancelled', async () => {
        const source = new vscode.CancellationTokenSource();
        const report: vsdiag.DocumentDiagnosticReport = {
            kind: vsdiag.DocumentDiagnosticReportKind.full,
            resultId: 'abc',
            items: [
                new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 1),
                    'undefined global',
                    vscode.DiagnosticSeverity.Warning,
                ),
            ],
        };

        const result = await provideDiagnosticsPreservingOnCancel(
            uri,
            'previous',
            source.token,
            async () => report,
        );

        assert.strictEqual(result, report);
    });

    test('an empty report from a live request still passes through', async () => {
        // A genuinely clean file must still be able to clear its diagnostics —
        // the middleware only suppresses *cancelled* results.
        const source = new vscode.CancellationTokenSource();
        const report: vsdiag.DocumentDiagnosticReport = {
            kind: vsdiag.DocumentDiagnosticReportKind.full,
            resultId: 'empty',
            items: [],
        };

        const result = await provideDiagnosticsPreservingOnCancel(
            uri,
            undefined,
            source.token,
            async () => report,
        );

        assert.strictEqual(result, report);
    });
});
