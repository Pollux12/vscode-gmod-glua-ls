import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { ConfigurationManager } from './configManager';
import { AutoInsertEndResponse } from './lspExtension';
import { isLuaAutoEndBlockStart } from './luaEnterPatterns';
import { sendRequestWithTimeout } from './languageServerRequests';

const AUTO_INSERT_END_REQUEST = 'gluals/autoInsertEnd';
const AUTO_INSERT_END_TIMEOUT_MS = 75;

export async function handleLuaSmartEnter(getClient: () => LanguageClient | undefined): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'lua') {
        await typeDefaultNewline();
        return;
    }

    const configManager = new ConfigurationManager(editor.document.uri);
    if (!configManager.isAutoInsertEndEnabled() || !shouldRequestAutoInsertEnd(editor)) {
        await typeDefaultNewline();
        return;
    }

    const client = getClient();
    if (!client) {
        await typeDefaultNewline();
        return;
    }

    const document = editor.document;
    const position = editor.selection.active;
    const requestVersion = document.version;
    const requestSelection = editor.selection;
    const requestPosition = position;

    let response: AutoInsertEndResponse | undefined;
    try {
        response = await sendRequestWithTimeout<AutoInsertEndResponse>(
            client,
            AUTO_INSERT_END_REQUEST,
            {
                uri: document.uri.toString(),
                position: {
                    line: position.line,
                    character: position.character,
                },
                version: requestVersion,
            },
            AUTO_INSERT_END_TIMEOUT_MS,
        );
    } catch {
        await typeDefaultNewline();
        return;
    }

    if (!response?.shouldInsert || !isStillSameCursorState(editor, requestVersion, requestSelection, requestPosition)) {
        await typeDefaultNewline();
        return;
    }

    const snippet = new vscode.SnippetString(buildInsertSnippet(editor, response.closeKeyword));

    await editor.insertSnippet(snippet, position, {
        undoStopBefore: true,
        undoStopAfter: true,
    });
}

async function typeDefaultNewline(): Promise<void> {
    await vscode.commands.executeCommand('default:type', { text: '\n' });
}

function shouldRequestAutoInsertEnd(editor: vscode.TextEditor): boolean {
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

    return true;
}

function isStillSameCursorState(
    editor: vscode.TextEditor,
    version: number,
    selection: vscode.Selection,
    position: vscode.Position,
): boolean {
    return editor.document.version === version
        && editor.selections.length === 1
        && editor.selection.isEmpty
        && editor.selection.active.line === position.line
        && editor.selection.active.character === position.character
        && editor.selection.anchor.line === selection.anchor.line
        && editor.selection.anchor.character === selection.anchor.character;
}

function buildInsertSnippet(editor: vscode.TextEditor, closeKeyword: string): string {
    const document = editor.document;
    const lineText = document.lineAt(editor.selection.active.line).text;
    const baseIndent = lineText.match(/^\s*/)?.[0] ?? '';
    const indentUnit = editor.options.insertSpaces ? ' '.repeat(Number(editor.options.tabSize ?? 4)) : '\t';
    const closer = closeKeyword === 'until' ? 'until ' : 'end';
    return `\n${baseIndent}${indentUnit}$0\n${baseIndent}${closer}`;
}
