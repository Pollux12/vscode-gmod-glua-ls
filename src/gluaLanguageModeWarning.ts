import * as path from 'path';
import * as vscode from 'vscode';

import { isLikelyGluaPath } from './gluaPathClassifier';

export const USE_GLUA_LANGUAGE_MODE_COMMAND = 'gluals.useGluaLanguageMode';

const GLUA_LANGUAGE_ID = 'glua';
const LUA_LANGUAGE_ID = 'lua';
const USE_GLUA_ACTION = 'Use GLua';
const LANGUAGE_MODE_WARNING =
    'This looks like a Garry’s Mod Lua file, but VS Code opened it in Lua mode. GLuaLS is inactive for this file.';

function isLikelyGluaDocumentUsingLua(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'file'
        && document.languageId === LUA_LANGUAGE_ID
        && isLikelyGluaPath(document.uri.fsPath);
}

function createDocumentSelector(document: vscode.TextDocument): vscode.DocumentSelector {
    const directory = vscode.Uri.file(path.dirname(document.uri.fsPath));
    return [{
        scheme: 'file',
        language: LUA_LANGUAGE_ID,
        pattern: new vscode.RelativePattern(directory, path.basename(document.uri.fsPath)),
    }];
}

async function useGluaLanguageMode(uri?: vscode.Uri): Promise<void> {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri) {
        return;
    }

    const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === targetUri.toString()
    ) ?? await vscode.workspace.openTextDocument(targetUri);

    if (document.languageId !== GLUA_LANGUAGE_ID) {
        await vscode.languages.setTextDocumentLanguage(document, GLUA_LANGUAGE_ID);
    }
}

/**
 * Reports likely Garry's Mod files that are using VS Code's standard Lua mode.
 */
export function registerGluaLanguageModeWarning(context: vscode.ExtensionContext): void {
    const statusItem = vscode.languages.createLanguageStatusItem(
        'gluals.languageMode',
        []
    );
    statusItem.name = 'GLuaLS Language Mode';
    statusItem.severity = vscode.LanguageStatusSeverity.Warning;
    statusItem.text = '$(warning) GLuaLS inactive';
    statusItem.detail = 'This likely Garry’s Mod Lua file is using Lua mode.';

    const updateStatusItem = (editor: vscode.TextEditor | undefined): void => {
        const document = editor?.document;
        if (!document || !isLikelyGluaDocumentUsingLua(document)) {
            statusItem.selector = [];
            statusItem.command = undefined;
            return;
        }

        statusItem.selector = createDocumentSelector(document);
        statusItem.command = {
            command: USE_GLUA_LANGUAGE_MODE_COMMAND,
            title: USE_GLUA_ACTION,
            arguments: [document.uri],
        };
    };

    const notifyIfNeeded = (document: vscode.TextDocument): void => {
        if (!isLikelyGluaDocumentUsingLua(document)) {
            return;
        }

        void vscode.window.showWarningMessage(
            LANGUAGE_MODE_WARNING,
            USE_GLUA_ACTION
        ).then((action) => {
            if (action === USE_GLUA_ACTION) {
                void useGluaLanguageMode(document.uri);
            }
        });
    };

    context.subscriptions.push(
        statusItem,
        vscode.commands.registerCommand(
            USE_GLUA_LANGUAGE_MODE_COMMAND,
            useGluaLanguageMode
        ),
        vscode.workspace.onDidOpenTextDocument((document) => {
            notifyIfNeeded(document);
            if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
                setTimeout(() => updateStatusItem(vscode.window.activeTextEditor), 0);
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(updateStatusItem)
    );

    updateStatusItem(vscode.window.activeTextEditor);
    if (vscode.window.activeTextEditor) {
        notifyIfNeeded(vscode.window.activeTextEditor.document);
    }
}
