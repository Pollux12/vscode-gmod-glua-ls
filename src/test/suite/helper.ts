import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'Pollux.gmod-glua-ls';
const FIXTURE_ROOT = path.resolve(__dirname, '../../../test-fixtures/workspace');

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getFixtureUri(relativePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(FIXTURE_ROOT, relativePath));
}

export async function activateExtension(docUri?: vscode.Uri): Promise<vscode.Extension<unknown>> {
    const gmodConfig = vscode.workspace.getConfiguration('gluals.gmod');
    await gmodConfig.update('autoLoadAnnotations', false, vscode.ConfigurationTarget.Global);
    await gmodConfig.update('mcp.enabled', false, vscode.ConfigurationTarget.Global);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (!extension) {
        throw new Error(`Extension ${EXTENSION_ID} was not found.`);
    }

    await extension.activate();

    if (docUri) {
        const document = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(document);
    }

    await sleep(250);

    return extension;
}
