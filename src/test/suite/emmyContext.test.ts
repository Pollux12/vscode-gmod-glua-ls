import * as assert from 'assert';
import * as vscode from 'vscode';

import { DIAGNOSING_WORKSPACE_MESSAGE, EmmyContext } from '../../emmyContext';

function getStatusBarItem(context: EmmyContext): vscode.StatusBarItem {
    return (context as any)._statusBar as vscode.StatusBarItem;
}

function getTooltipMarkdown(context: EmmyContext): string {
    const tooltip = getStatusBarItem(context).tooltip;
    assert.ok(tooltip instanceof vscode.MarkdownString);
    return tooltip.value.replace(/&nbsp;/g, ' ');
}

suite('Emmy Context', () => {
    test('treats diagnosing startup as connected but still starting', () => {
        const context = new EmmyContext(false, {} as vscode.ExtensionContext);
        try {
            context.setServerStarting();
            assert.strictEqual(context.isServerRunning, false);
            assert.strictEqual(context.isServerStarting, true);

            context.setServerDiagnosing(DIAGNOSING_WORKSPACE_MESSAGE);
            assert.strictEqual(context.isServerRunning, true);
            assert.strictEqual(context.isServerStarting, true);
        } finally {
            context.dispose();
        }
    });

    test('treats diagnostics progress messages as connected regardless of text', () => {
        const context = new EmmyContext(false, {} as vscode.ExtensionContext);
        try {
            context.setServerDiagnosing('Preparing workspace diagnostics');

            assert.strictEqual(context.isServerRunning, true);
            assert.strictEqual(context.isServerStarting, true);
        } finally {
            context.dispose();
        }
    });

    test('shows workspace loading progress in status bar and tooltip', () => {
        const context = new EmmyContext(false, {} as vscode.ExtensionContext);
        try {
            context.setServerStarting('Collecting Lua files');

            assert.match(getStatusBarItem(context).text, /Collecting Lua files/);
            assert.match(getTooltipMarkdown(context), /Status: `starting`/);
            assert.match(getTooltipMarkdown(context), /Collecting Lua files/);
        } finally {
            context.dispose();
        }
    });

    test('shows diagnosing progress as a connected diagnostics status', () => {
        const context = new EmmyContext(false, {} as vscode.ExtensionContext);
        try {
            context.setServerDiagnosing('Preparing workspace diagnostics');

            assert.match(getStatusBarItem(context).text, /Preparing workspace diagnostics/);
            assert.match(getTooltipMarkdown(context), /Status: `diagnosing`/);
            assert.match(getTooltipMarkdown(context), /Preparing workspace diagnostics/);
            assert.strictEqual(context.isServerRunning, true);
        } finally {
            context.dispose();
        }
    });

    test('uses short default status labels when running or stopped', () => {
        const context = new EmmyContext(false, {} as vscode.ExtensionContext);
        try {
            context.setServerRunning();
            assert.strictEqual(getStatusBarItem(context).text, '$(check) GLuaLS: Running');
            assert.match(getTooltipMarkdown(context), /Running/);

            context.setServerStopped();
            assert.strictEqual(getStatusBarItem(context).text, '$(circle-slash) GLuaLS: Stopped');
            assert.match(getTooltipMarkdown(context), /Stopped/);
        } finally {
            context.dispose();
        }
    });

    test('shows active server and annotation versions in the tooltip', () => {
        const context = new EmmyContext(false, {} as vscode.ExtensionContext);
        try {
            context.setServerRunning();
            context.setServerVersions({
                languageServer: '1.2.3',
                annotations: '2026-07-13T12:00:00.000Z',
            });

            const tooltip = getTooltipMarkdown(context);
            assert.match(tooltip, /Language Server: 1\.2\.3/);
            assert.match(tooltip, /Annotations: 2026-07-13T12:00:00\.000Z/);
        } finally {
            context.dispose();
        }
    });
});
