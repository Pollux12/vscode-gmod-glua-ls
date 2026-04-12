import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 提供`.emmyrc.json`的 i18n
 */
export class EmmyrcSchemaContentProvider implements vscode.TextDocumentContentProvider {
    private readonly schemaBaseDir: string;

    constructor(context: vscode.ExtensionContext) {
        this.schemaBaseDir = path.join(context.extensionPath, 'syntaxes');
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const schemaIdentifier = path.posix.basename(uri.path);
        let schemaFileName: string;

        if (schemaIdentifier === 'emmyrc') {
            schemaFileName = 'schema.json';
        } else {
            return '';
        }

        // 检查schema文件是否存在, 如果不存在则使用默认的
        let schemaFilePath = path.join(this.schemaBaseDir, schemaFileName);
        if (!fs.existsSync(schemaFilePath)) {
            schemaFilePath = path.join(this.schemaBaseDir, 'schema.json');
        }

        try {
            return await fs.promises.readFile(schemaFilePath, 'utf8');
        } catch (error: any) {
            return JSON.stringify({
                "$schema": "https://json-schema.org/draft/2020-12/schema#",
                "title": "Error Loading Schema",
                "description": `Could not load schema: ${schemaFileName}. Error: ${error.message}.`
            });
        }
    }
}