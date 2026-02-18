import * as vscode from 'vscode';
import { GMOD_REALMS, GmodRealm } from './debugger/gmod_debugger/GmodDebugControlService';

const REALM_LABELS: Record<GmodRealm, string> = {
    server: 'Server',
    client: 'Client',
    menu: 'Menu',
};

const REALM_DESCRIPTIONS: Record<GmodRealm, string> = {
    server: 'RunLua / BreakHere targets server-side Lua',
    client: 'RunLua / BreakHere targets client-side Lua',
    menu: 'RunLua / BreakHere targets menu-state Lua',
};

type RealmViewItemKind = 'realm' | 'action' | 'info';

interface RealmViewItemData {
    kind: RealmViewItemKind;
    label: string;
    description?: string;
    tooltip?: string;
    realm?: GmodRealm;
}

class RealmViewItem extends vscode.TreeItem {
    constructor(public readonly data: RealmViewItemData, isActiveRealm: boolean = false) {
        super(data.label, vscode.TreeItemCollapsibleState.None);

        this.description = data.description;
        this.tooltip = data.tooltip ?? data.description;

        if (data.kind === 'realm' && data.realm) {
            this.iconPath = new vscode.ThemeIcon(isActiveRealm ? 'check' : 'circle-outline');
            this.command = {
                command: 'gluals.gmod.setRealm',
                title: 'Set Execution Realm',
                arguments: [data.realm],
            };
            this.contextValue = 'gmodRealmItem';
            return;
        }

        if (data.kind === 'action') {
            this.iconPath = new vscode.ThemeIcon('debug-configure');
            this.command = {
                command: 'gluals.gmod.configureDebugger',
                title: 'Set up GMod Debugger',
            };
            this.contextValue = 'gmodSetupAction';
            return;
        }

        this.iconPath = new vscode.ThemeIcon('info');
        this.contextValue = 'gmodSetupInfo';
    }
}

export class GmodRealmProvider implements vscode.TreeDataProvider<RealmViewItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RealmViewItem | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(
        private readonly getCurrentRealm: () => GmodRealm,
        private readonly hasDebuggerConfig: () => boolean
    ) {}

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: RealmViewItem): vscode.TreeItem {
        return element;
    }

    getChildren(_element?: RealmViewItem): RealmViewItem[] {
        if (!this.hasDebuggerConfig()) {
            return [
                new RealmViewItem({
                    kind: 'action',
                    label: 'Set up GMod debugger',
                    description: 'Create a gluals_gmod launch configuration',
                }),
                new RealmViewItem({
                    kind: 'info',
                    label: '1) Run setup wizard',
                    description: 'Auto-detect SRCDS from workspace, or enter srcds path manually',
                }),
                new RealmViewItem({
                    kind: 'info',
                    label: '2) Ensure gm_rdb is loaded',
                    description: 'Wizard can install it and inject require("rdb") into init.lua',
                }),
                new RealmViewItem({
                    kind: 'info',
                    label: '3) Start GMod Attach (SRCDS)',
                    description: 'Use Run and Debug after setup writes launch.json',
                }),
            ];
        }

        const activeRealm = this.getCurrentRealm();
        const realmItems = GMOD_REALMS.map(
            (realm) =>
                new RealmViewItem(
                    {
                        kind: 'realm',
                        label: REALM_LABELS[realm],
                        description: realm === activeRealm ? '(active)' : undefined,
                        tooltip: REALM_DESCRIPTIONS[realm],
                        realm,
                    },
                    realm === activeRealm
                )
        );

        return [
            new RealmViewItem({
                kind: 'action',
                label: 'Setup / update GMod debugger',
                description: 'Regenerate or repair launch mappings',
            }),
            ...realmItems,
        ];
    }

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }
}

export function registerGmodRealmView(
    context: vscode.ExtensionContext,
    getCurrentRealm: () => GmodRealm,
    hasDebuggerConfig: () => boolean
): GmodRealmProvider {
    const provider = new GmodRealmProvider(getCurrentRealm, hasDebuggerConfig);
    const treeView = vscode.window.createTreeView('gluals.gmodRealmSelector', {
        treeDataProvider: provider,
        showCollapseAll: false,
    });
    context.subscriptions.push(provider, treeView);
    return provider;
}