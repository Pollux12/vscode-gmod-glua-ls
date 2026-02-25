import * as vscode from 'vscode';
import { GMOD_REALMS, GmodRealm } from './debugger/gmod_debugger/GmodDebugControlService';

const REALM_LABELS: Record<GmodRealm, string> = {
    server: 'Server',
    client: 'Client',
    shared: 'Shared',
};

// descriptions now focus on where Lua code will execute rather than mentioning breakHere,
// since the debugger only ever runs on the server and the setting simply controls execution realm
const REALM_DESCRIPTIONS: Record<GmodRealm, string> = {
    server: 'Execute Lua on the server',
    client: 'Execute Lua on connected clients',
    shared: 'Execute Lua on both server and clients',
};

interface RealmQuickPickItem extends vscode.QuickPickItem {
    realm: GmodRealm;
}

interface SetupQuickPickItem extends vscode.QuickPickItem {
    action: 'setup';
}

function isSetupQuickPickItem(item: vscode.QuickPickItem): item is SetupQuickPickItem {
    return (item as SetupQuickPickItem).action === 'setup';
}

function isRealmQuickPickItem(item: vscode.QuickPickItem): item is RealmQuickPickItem {
    return typeof (item as RealmQuickPickItem).realm === 'string';
}

export class GmodRealmStatusBar implements vscode.Disposable {
    private readonly statusBarItem: vscode.StatusBarItem;

    constructor(
        private readonly getCurrentRealm: () => GmodRealm
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        this.statusBarItem.command = 'gluals.gmod.showRealmMenu';
        this.refresh();
        this.statusBarItem.show();
    }

    refresh(): void {
        const activeRealm = this.getCurrentRealm();
        // emphasize that this setting controls the Lua execution realm
        this.statusBarItem.text = `$(broadcast) GMod Lua: ${REALM_LABELS[activeRealm]}`;
        this.statusBarItem.tooltip = REALM_DESCRIPTIONS[activeRealm];
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}

export function registerGmodRealmView(
    context: vscode.ExtensionContext,
    getCurrentRealm: () => GmodRealm,
    hasDebuggerConfig: () => boolean
): GmodRealmStatusBar {
    const statusBar = new GmodRealmStatusBar(getCurrentRealm);

    context.subscriptions.push(
        statusBar,
        vscode.commands.registerCommand('gluals.gmod.showRealmMenu', async () => {
            const activeRealm = getCurrentRealm();

            const items: Array<vscode.QuickPickItem | RealmQuickPickItem | SetupQuickPickItem> = GMOD_REALMS.map(realm => ({
                label: `${realm === activeRealm ? '$(check) ' : ''}${REALM_LABELS[realm]}`,
                description: REALM_DESCRIPTIONS[realm],
                realm
            }));

            if (!hasDebuggerConfig()) {
                items.push({
                    label: '',
                    kind: vscode.QuickPickItemKind.Separator
                });
                items.push({
                    label: '$(debug-configure) Set up GMod Debugger',
                    description: 'Create a gluals_gmod launch configuration',
                    action: 'setup'
                });
            } else {
                items.push({
                    label: '',
                    kind: vscode.QuickPickItemKind.Separator
                });
                items.push({
                    label: '$(debug-configure) Setup / update GMod debugger',
                    description: 'Regenerate or repair launch mappings',
                    action: 'setup'
                });
            }

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select GMod Lua Execution Realm'
            });

            if (selected) {
                if (isSetupQuickPickItem(selected)) {
                    void vscode.commands.executeCommand('gluals.gmod.configureDebugger');
                } else if (isRealmQuickPickItem(selected)) {
                    const targetRealm = selected.realm;
                    if (targetRealm !== activeRealm) {
                        void vscode.commands.executeCommand('gluals.gmod.setRealm', targetRealm);
                    }
                }
            }
        })
    );

    return statusBar;
}
