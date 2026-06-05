import * as vscode from 'vscode';

export const SERVER_LOG_PATH_ARGUMENT = '--log-path';

export function getServerLogDirectory(context: vscode.ExtensionContext): vscode.Uri {
    return vscode.Uri.joinPath(context.logUri, 'server');
}

export function withServerLogPathArgument(
    startParameters: readonly string[],
    serverLogDirectory: vscode.Uri
): string[] {
    if (hasExplicitLogPathArgument(startParameters)) {
        return [...startParameters];
    }

    return [
        ...startParameters,
        SERVER_LOG_PATH_ARGUMENT,
        serverLogDirectory.fsPath,
    ];
}

function hasExplicitLogPathArgument(startParameters: readonly string[]): boolean {
    return startParameters.some(parameter =>
        parameter === SERVER_LOG_PATH_ARGUMENT ||
        parameter.startsWith(`${SERVER_LOG_PATH_ARGUMENT}=`)
    );
}
