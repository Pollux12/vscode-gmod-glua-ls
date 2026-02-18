import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { buildCategories, Category } from './gluarcSchema';
import { readGluarcConfig, writeGluarcConfig, setNestedValue, getGluarcUri } from './gluarcConfig';

export class GluarcSettingsPanel implements vscode.Disposable {
    private static current: GluarcSettingsPanel | undefined;

    private config: Record<string, unknown> = {};
    private categories: Category[] = [];
    private _selfWriting: boolean = false;
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

    static async createOrShow(context: vscode.ExtensionContext, targetUri?: vscode.Uri): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('Open a workspace folder to edit GLua settings');
            return;
        }

        let workspaceFolder = targetUri
            ? GluarcSettingsPanel.resolveWorkspaceFolderFromUri(targetUri)
            : undefined;

        if (!workspaceFolder) {
            if (folders.length === 1) {
                workspaceFolder = folders[0];
            } else {
                const pickedFolder = await vscode.window.showWorkspaceFolderPick();
                if (!pickedFolder) {
                    return;
                }
                workspaceFolder = pickedFolder;
            }
        }

        const current = GluarcSettingsPanel.current;
        if (current) {
            const isSameWorkspace = current.workspaceFolder.uri.toString() === workspaceFolder.uri.toString();
            if (!isSameWorkspace) {
                GluarcSettingsPanel.current = undefined;
                current.panel.dispose();
            } else {
                current.panel.reveal(vscode.ViewColumn.One);
                return;
            }
        }

        const panel = vscode.window.createWebviewPanel(
            'gluarcSettings',
            'GLua Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'res'))],
            }
        );

        const instance = new GluarcSettingsPanel(panel, context, workspaceFolder);
        GluarcSettingsPanel.current = instance;
    }

    private static resolveWorkspaceFolderFromUri(targetUri: vscode.Uri): vscode.WorkspaceFolder | undefined {
        const isGluarcFile = path.basename(targetUri.fsPath) === '.gluarc.json';
        const folderUri = isGluarcFile ? vscode.Uri.joinPath(targetUri, '..') : targetUri;

        const workspaceFolder = vscode.workspace.workspaceFolders?.find(
            wf => wf.uri.toString() === folderUri.toString()
        ) ?? vscode.workspace.getWorkspaceFolder(folderUri);

        if (workspaceFolder) {
            return workspaceFolder;
        }

        return isGluarcFile ? vscode.workspace.getWorkspaceFolder(targetUri) : undefined;
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceFolder: vscode.WorkspaceFolder,
    ) {
        this._disposables.push(
            this.panel.onDidDispose(() => {
                GluarcSettingsPanel.current = undefined;
                this.dispose();
            })
        );

        void this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            const schemaPath = path.join(this.context.extensionPath, 'syntaxes', 'schema.json');
            const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
            const schemaJson = JSON.parse(schemaRaw) as object;
            this.categories = buildCategories(schemaJson);

            this.config = await readGluarcConfig(this.workspaceFolder);

            const htmlReady = this.setWebviewContent();
            if (!htmlReady) {
                return;
            }

            await this.panel.webview.postMessage({
                type: 'init',
                categories: this.categories,
                config: this.config,
            });

            const messageDisposable = this.panel.webview.onDidReceiveMessage(async (msg: unknown) => {
                if (!msg || typeof msg !== 'object') {
                    return;
                }

                const message = msg as { type?: unknown; path?: unknown; value?: unknown };
                if (message.type !== 'change') {
                    return;
                }

                if (!Array.isArray(message.path) || !message.path.every((segment) => typeof segment === 'string')) {
                    return;
                }

                this._selfWriting = true;
                try {
                    setNestedValue(this.config, message.path, message.value);
                    await writeGluarcConfig(this.workspaceFolder, this.config);
                } finally {
                    this._selfWriting = false;
                }
            });
            this._disposables.push(messageDisposable);

            const gluarcUri = getGluarcUri(this.workspaceFolder);
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceFolder, path.basename(gluarcUri.fsPath))
            );
            this._disposables.push(
                watcher,
                watcher.onDidChange(() => this._onExternalChange()),
                watcher.onDidCreate(() => this._onExternalChange())
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open GLua settings: ${message}`);
            this.panel.dispose();
        }
    }

    private _onExternalChange(): void {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._debounceTimer = setTimeout(async () => {
            if (this._selfWriting) {
                return;
            }

            try {
                this.config = await readGluarcConfig(this.workspaceFolder);
                await this.panel.webview.postMessage({
                    type: 'configUpdated',
                    config: this.config,
                });
            } catch {
            }
        }, 300);
    }

    private setWebviewContent(): boolean {
        try {
            const htmlPath = path.join(this.context.extensionPath, 'res', 'gluarcSettings.html');
            const htmlTemplate = fs.readFileSync(htmlPath, 'utf8');
            const nonce = crypto.randomBytes(16).toString('base64');
            const cspSource = this.panel.webview.cspSource;

            const processedHtml = htmlTemplate
                .replace(/\{\{nonce\}\}/g, nonce)
                .replace(/\{\{cspSource\}\}/g, cspSource);

            this.panel.webview.html = processedHtml;
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load GLua settings UI: ${message}`);
            this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<body>
    <h2>Failed to load GLua settings UI</h2>
    <p>${message}</p>
</body>
</html>`;
            return false;
        }
    }

    dispose(): void {
        while (this._disposables.length > 0) {
            this._disposables.pop()?.dispose();
        }

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }

        GluarcSettingsPanel.current = undefined;
    }
}