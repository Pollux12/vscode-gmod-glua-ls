import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { hasLuaBlockCloser, isLuaAutoEndBlockStart } from './luaEnterPatterns';

export async function handleLuaSmartEnter(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'lua') {
        await typeDefaultNewline();
        return;
    }

    const configManager = new ConfigurationManager(editor.document.uri);
    if (!configManager.isAutoInsertEndEnabled() || !shouldAutoInsertEnd(editor)) {
        await typeDefaultNewline();
        return;
    }

    const position = editor.selection.active;
    const snippet = new vscode.SnippetString('\n\t$0\nend');

    await editor.insertSnippet(snippet, position, {
        undoStopBefore: true,
        undoStopAfter: true,
    });
}

async function typeDefaultNewline(): Promise<void> {
    await vscode.commands.executeCommand('default:type', { text: '\n' });
}

function shouldAutoInsertEnd(editor: vscode.TextEditor): boolean {
    if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
        return false;
    }

    const position = editor.selection.active;
    const document = editor.document;
    const currentLine = document.lineAt(position.line);
    const beforeCursor = currentLine.text.slice(0, position.character);
    const afterCursor = currentLine.text.slice(position.character);
    if (afterCursor.trim().length > 0) {
        return false;
    }

    const trimmedLine = beforeCursor.trimEnd();
    if (!isLuaAutoEndBlockStart(trimmedLine)) {
        return false;
    }

    if (position.line + 1 >= document.lineCount) {
        return true;
    }

    for (let lineIndex = position.line + 1; lineIndex < document.lineCount; lineIndex += 1) {
        const nextLine = document.lineAt(lineIndex).text;
        if (nextLine.trim().length === 0) {
            continue;
        }

        return !hasLuaBlockCloser(nextLine);
    }

    return true;
}