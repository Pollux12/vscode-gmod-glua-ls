import * as assert from 'assert';
import * as vscode from 'vscode';

import {
    enableCompletionColorPreviewHtml,
    enableCompletionColorPreviewHtmlForResult,
} from '../../completionColorPreview';
import { activateExtension, getFixtureUri } from './helper';

const COLOR_COMPLETION_DOCUMENTATION = '`Color(255, 255, 255)`';

suite('Extension Integration', () => {
    test('activates and registers core commands', async () => {
        const extension = await activateExtension(getFixtureUri('sample.lua'));
        assert.strictEqual(extension.isActive, true);

        const registeredCommands = await vscode.commands.getCommands(true);
        const expectedCommands = [
            'gluals.startServer',
            'gluals.stopServer',
            'gluals.restartServer',
            'gluals.showSyntaxTree',
            'gluals.gmod.runLua',
        ];

        for (const commandId of expectedCommands) {
            assert.ok(registeredCommands.includes(commandId), `Expected command to be registered: ${commandId}`);
        }
    });

    test('executes completion provider command for fixture document', async () => {
        const docUri = getFixtureUri('sample.lua');
        await activateExtension(docUri);

        const completionList = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            docUri,
            new vscode.Position(0, 0)
        );

        assert.ok(completionList, 'Expected completion provider command to return a completion list.');
    });

    test('sets parseable detail for color completion previews', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Color;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, '#FFFFFF');
        assert.ok(item.documentation instanceof vscode.MarkdownString);
        assert.strictEqual(item.documentation.value, COLOR_COMPLETION_DOCUMENTATION);
    });

    test('adds parseable fallback documentation for initial completion list color previews', () => {
        const colorItem = new vscode.CompletionItem('color_white');
        colorItem.kind = vscode.CompletionItemKind.Color;
        (colorItem as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };
        const plainItem = new vscode.CompletionItem('plain');
        const list = new vscode.CompletionList([colorItem, plainItem]);

        enableCompletionColorPreviewHtmlForResult(list);

        assert.strictEqual(colorItem.detail, '#FFFFFF');
        assert.strictEqual(colorItem.documentation, undefined);
        assert.strictEqual(plainItem.detail, undefined);
    });

    test('does not set color detail for non-color completion items', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Variable;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, undefined);
    });

    test('uses color metadata rather than preview text for completion detail', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Color;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 0,
                green: 0,
                blue: 0,
                alpha: 255,
                hex: '#000000',
            },
        };
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, '#000000');
    });

    test('does not set color detail for documentation text without color metadata', () => {
        const item = new vscode.CompletionItem('not_a_color');
        item.documentation = new vscode.MarkdownString(COLOR_COMPLETION_DOCUMENTATION);

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, undefined);
    });

    test('does not set color detail for invalid color metadata', () => {
        const item = new vscode.CompletionItem('color_white');
        item.kind = vscode.CompletionItemKind.Color;
        (item as vscode.CompletionItem & { data?: unknown }).data = {
            color: {
                red: 300,
                green: 255,
                blue: 255,
                alpha: 255,
                hex: '#FFFFFF',
            },
        };

        enableCompletionColorPreviewHtml(item);

        assert.strictEqual(item.detail, undefined);
    });
});
