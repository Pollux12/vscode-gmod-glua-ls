import * as vscode from 'vscode';
import { readGluarcConfig, writeGluarcConfig, setNestedValue, getNestedValue } from './gluarcConfig';

// Diagnostic code emitted by the language server for undefined global variables
// Must match the server's diagnostic code definition (see res/gluarcSettings/data.js:13)
const UNDEFINED_GLOBAL_CODE = 'undefined-global';
const CONTEXT_KEY_HAS_UNDEFINED_GLOBAL = 'gluals.hasUndefinedGlobalAtCursor';

/**
 * Setup undefined global code actions.
 * This includes:
 * - CodeActionProvider for quick fixes (lightbulb)
 * - Selection change listener to update context key
 * - Command handler for adding variables to globals
 */
export function registerUndefinedGlobalCodeActions(context: vscode.ExtensionContext): void {
    // Register CodeActionProvider for Lua files
    const codeActionProvider = vscode.languages.registerCodeActionsProvider(
        { language: 'lua' },
        new UndefinedGlobalCodeActionProvider(),
        {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        }
    );
    context.subscriptions.push(codeActionProvider);

    // Register command handler
    const commandDisposable = vscode.commands.registerCommand(
        'gluals.addUndefinedGlobalToGlobals',
        handleAddUndefinedGlobalToGlobals
    );
    context.subscriptions.push(commandDisposable);

    // Track selection changes to update context key
    const selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection(updateContextKey);
    context.subscriptions.push(selectionChangeDisposable);

    // Also update context key when editor changes
    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            void updateContextKeyForEditor(editor);
        }
    });
    context.subscriptions.push(activeEditorDisposable);

    const diagnosticsChangeDisposable = vscode.languages.onDidChangeDiagnostics((event) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return;
        }

        const activeDocumentUri = activeEditor.document.uri.toString();
        const hasActiveDocumentChanges = event.uris.some((uri) => uri.toString() === activeDocumentUri);
        if (!hasActiveDocumentChanges) {
            return;
        }

        void updateContextKeyForEditor(activeEditor);
    });
    context.subscriptions.push(diagnosticsChangeDisposable);

    // Initial update
    if (vscode.window.activeTextEditor) {
        void updateContextKeyForEditor(vscode.window.activeTextEditor);
    }
}

/**
 * Update the context key based on whether the cursor is on an undefined-global diagnostic
 */
async function updateContextKeyForEditor(editor: vscode.TextEditor): Promise<void> {
    let hasUndefinedGlobal = false;
    try {
        const position = editor.selection.active;
        hasUndefinedGlobal = hasUndefinedGlobalDiagnostic(editor, position);
    } catch (error) {
        // Silently ignore errors during shutdown/deactivation
    }

    // Always update the context key to ensure menu state consistency
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY_HAS_UNDEFINED_GLOBAL, hasUndefinedGlobal);
}

/**
 * Update the context key based on a selection change event
 */
function updateContextKey(event: vscode.TextEditorSelectionChangeEvent): void {
    // Fire and forget - errors are handled internally
    void updateContextKeyForEditor(event.textEditor);
}

/**
 * Check if there's an undefined-global diagnostic at the given position
 */
function hasUndefinedGlobalDiagnostic(editor: vscode.TextEditor, position: vscode.Position): boolean {
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);

    return diagnostics.some(diagnostic => {
        if (diagnostic.code !== UNDEFINED_GLOBAL_CODE) {
            return false;
        }
        // Check if position is within the diagnostic range
        return diagnostic.range.contains(position);
    });
}

/**
 * Get the undefined-global diagnostic at the given position, if any
 */
function getUndefinedGlobalDiagnostic(editor: vscode.TextEditor, position: vscode.Position): vscode.Diagnostic | undefined {
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);

    return diagnostics.find(diagnostic => {
        if (diagnostic.code !== UNDEFINED_GLOBAL_CODE) {
            return false;
        }
        // Check if position is within the diagnostic range
        return diagnostic.range.contains(position);
    });
}

/**
 * Get the variable name from the diagnostic range in the document
 */
function getVariableNameFromDiagnostic(editor: vscode.TextEditor, diagnostic: vscode.Diagnostic): string | undefined {
    return editor.document.getText(diagnostic.range);
}

/**
 * Handle the command to add the undefined global at cursor to diagnostics.globals
 */
async function handleAddUndefinedGlobalToGlobals(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    // Get the workspace folder
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found. Cannot update .gluarc.json.');
        return;
    }

    // Get the undefined-global diagnostic at the cursor
    const position = editor.selection.active;
    const diagnostic = getUndefinedGlobalDiagnostic(editor, position);
    if (!diagnostic) {
        vscode.window.showWarningMessage('No undefined-global diagnostic found at the cursor position.');
        return;
    }

    // Extract the variable name from the diagnostic range
    const variableName = getVariableNameFromDiagnostic(editor, diagnostic);
    if (!variableName) {
        vscode.window.showErrorMessage('Could not determine the variable name from the diagnostic.');
        return;
    }

    try {
        // Read the current configuration
        const config = await readGluarcConfig(workspaceFolder);

        // Get current globals array or create empty one
        const currentGlobals = getNestedValue(config, ['diagnostics', 'globals']) as string[] | undefined;
        const isValidGlobalsArray = currentGlobals && Array.isArray(currentGlobals);

        // Check for duplicates
        if (isValidGlobalsArray && currentGlobals.includes(variableName)) {
            vscode.window.showInformationMessage(`'${variableName}' is already in diagnostics.globals.`);
            return;
        }

        // Add the variable to globals array
        const newGlobals = isValidGlobalsArray
            ? [...currentGlobals, variableName]
            : [variableName];

        // Update the config
        setNestedValue(config, ['diagnostics', 'globals'], newGlobals);

        // Write the updated config back
        const writeSucceeded = await writeGluarcConfig(workspaceFolder, config);
        if (!writeSucceeded) {
            return;
        }

        vscode.window.showInformationMessage(`Added '${variableName}' to diagnostics.globals.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to add '${variableName}' to globals: ${message}`);
    }
}

/**
 * CodeActionProvider for undefined-global quick fixes
 */
class UndefinedGlobalCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] | undefined {
        // Find undefined-global diagnostics in the range
        const undefinedGlobalDiagnostics = context.diagnostics.filter(
            diagnostic => diagnostic.code === UNDEFINED_GLOBAL_CODE
        );

        if (undefinedGlobalDiagnostics.length === 0) {
            return undefined;
        }

        // Only create a code action if there's exactly one undefined-global diagnostic
        // and the range roughly matches the diagnostic range
        const diagnostic = undefinedGlobalDiagnostics[0];

        // Check that the range is approximately within the diagnostic range
        // This prevents the action from appearing when user selects entire file
        const isRangeRelevant = diagnostic.range.intersection(range) !== undefined ||
                               range.contains(diagnostic.range) ||
                               diagnostic.range.contains(range.start);

        if (!isRangeRelevant) {
            return undefined;
        }

        // Get the variable name from the diagnostic range
        const variableName = document.getText(diagnostic.range);

        if (!variableName || variableName.trim().length === 0) {
            return undefined;
        }

        // Create the code action
        const action = new vscode.CodeAction(
            `Add unknown '${variableName}' to global table (config)`,
            vscode.CodeActionKind.QuickFix
        );
        action.command = {
            command: 'gluals.addUndefinedGlobalToGlobals',
            title: `Add unknown '${variableName}' to global table (config)`,
            tooltip: `Add unknown '${variableName}' to the diagnostics.globals configuration`
        };
        action.diagnostics = [diagnostic];
        action.isPreferred = false;

        return [action];
    }
}
