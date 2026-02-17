import * as path from 'path';
import * as vscode from 'vscode';
import { GmodRealm } from './debugger/gmod_debugger/GmodDebugControlService';

type GmodExplorerCategory = 'runtimeTargets' | 'entities' | 'resources';
type GmodExplorerItemType = 'category' | 'runtimeTarget' | 'file';

class GmodExplorerItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: GmodExplorerItemType,
        public readonly category?: GmodExplorerCategory,
        public readonly realm?: GmodRealm,
        public readonly resourceUri?: vscode.Uri
    ) {
        super(label, collapsibleState);
        this.configure();
    }

    private configure(): void {
        if (this.itemType === 'category') {
            this.iconPath = new vscode.ThemeIcon('list-tree');
            this.contextValue = this.category;
            return;
        }

        if (this.itemType === 'runtimeTarget' && this.realm) {
            this.iconPath = new vscode.ThemeIcon('debug-alt-small');
            this.description = this.realm;
            this.command = {
                command: 'gluals.gmod.setRealm',
                title: 'Set GMod Realm',
                arguments: [this.realm]
            };
            this.contextValue = 'runtimeTarget';
            return;
        }

        if (this.itemType === 'file' && this.resourceUri) {
            this.iconPath = new vscode.ThemeIcon('file-code');
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.resourceUri);
            if (workspaceFolder) {
                this.description = path.relative(workspaceFolder.uri.fsPath, this.resourceUri.fsPath);
            }
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [this.resourceUri]
            };
            this.contextValue = 'file';
        }
    }
}

export class GmodExplorerProvider implements vscode.TreeDataProvider<GmodExplorerItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GmodExplorerItem | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    private entityFiles: vscode.Uri[] | undefined;
    private resourceFiles: vscode.Uri[] | undefined;

    refresh(): void {
        this.entityFiles = undefined;
        this.resourceFiles = undefined;
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: GmodExplorerItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: GmodExplorerItem): Promise<GmodExplorerItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [];
        }

        if (!element) {
            return [
                new GmodExplorerItem('Runtime Targets', vscode.TreeItemCollapsibleState.Expanded, 'category', 'runtimeTargets'),
                new GmodExplorerItem('Entity Scripts', vscode.TreeItemCollapsibleState.Collapsed, 'category', 'entities'),
                new GmodExplorerItem('Resources', vscode.TreeItemCollapsibleState.Collapsed, 'category', 'resources'),
            ];
        }

        if (element.itemType !== 'category' || !element.category) {
            return [];
        }

        switch (element.category) {
            case 'runtimeTargets':
                return [
                    new GmodExplorerItem('Server Runtime', vscode.TreeItemCollapsibleState.None, 'runtimeTarget', undefined, 'server'),
                    new GmodExplorerItem('Client Runtime', vscode.TreeItemCollapsibleState.None, 'runtimeTarget', undefined, 'client'),
                    new GmodExplorerItem('Menu Runtime', vscode.TreeItemCollapsibleState.None, 'runtimeTarget', undefined, 'menu'),
                ];

            case 'entities':
                if (!this.entityFiles) {
                    this.entityFiles = await vscode.workspace.findFiles('**/lua/entities/*/*.lua', '**/node_modules/**', 200);
                }
                return this.entityFiles.map((uri) =>
                    new GmodExplorerItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None, 'file', undefined, undefined, uri)
                );

            case 'resources':
                if (!this.resourceFiles) {
                    this.resourceFiles = await vscode.workspace.findFiles('**/{materials,models,sound,resource}/**/*', '**/node_modules/**', 200);
                }
                return this.resourceFiles.map((uri) =>
                    new GmodExplorerItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None, 'file', undefined, undefined, uri)
                );
        }
    }

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }
}

export function registerGmodExplorer(context: vscode.ExtensionContext): GmodExplorerProvider {
    const provider = new GmodExplorerProvider();
    const treeView = vscode.window.createTreeView('gluals.gmodExplorer', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    context.subscriptions.push(provider, treeView);
    return provider;
}
