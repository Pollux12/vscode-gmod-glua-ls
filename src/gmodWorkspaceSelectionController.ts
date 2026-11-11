import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { readGluarcConfig, setNestedValue, writeGluarcConfig } from './gluarcConfig';
import {
    buildBuiltinItems,
    buildPickItems,
    choiceToSettings,
    chooseSaveTarget,
    GamemodeChoice,
    GamemodePickItem,
    GamemodeSettings,
    GmodRoot,
    initialPickItem,
    ProjectsChangedParams,
    statusBackground,
    statusText,
    statusTooltip,
    uriBasename,
} from './gmodWorkspaceSelection';

export const PROJECTS_CHANGED_NOTIFICATION = 'gluals/projectsChanged';

const GLUARC_FILE_NAME = '.gluarc.json';
const OTHER_CONFIG_FILE_NAMES = ['.luarc.json', '.emmyrc.json', '.emmyrc.lua'];

function isInGitRepository(folderPath: string): boolean {
    let current = folderPath;
    for (;;) {
        if (fs.existsSync(path.join(current, '.git'))) {
            return true;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return false;
        }
        current = parent;
    }
}

function resolveSaveTarget(folder: vscode.WorkspaceFolder): 'gluarc' | 'settings' {
    if (folder.uri.scheme !== 'file') {
        return 'settings';
    }

    const folderPath = folder.uri.fsPath;
    return chooseSaveTarget({
        inGitRepository: isInGitRepository(folderPath),
        hasGluarc: fs.existsSync(path.join(folderPath, GLUARC_FILE_NAME)),
        hasOtherConfig: OTHER_CONFIG_FILE_NAMES.some((name) => fs.existsSync(path.join(folderPath, name))),
    });
}

async function saveToGluarc(folder: vscode.WorkspaceFolder, settings: GamemodeSettings): Promise<boolean> {
    let config: Record<string, unknown>;
    try {
        config = await readGluarcConfig(folder);
    } catch {
        return false;
    }

    if (settings.activeGamemode !== undefined) {
        setNestedValue(config, ['gmod', 'activeGamemode'], settings.activeGamemode);
    }
    setNestedValue(config, ['gmod', 'loadEverything'], settings.loadEverything || undefined);
    if (!(await writeGluarcConfig(folder, config))) {
        return false;
    }
    try {
        await alignSettingsWithGluarc(
            vscode.workspace.getConfiguration('gluals.gmod', folder.uri),
            vscode.workspace.workspaceFile !== undefined,
            settings,
        );
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to update the gamemode settings that override .gluarc.json: ${message}`);
        return false;
    }
}

const GAMEMODE_SETTING_KEYS = ['activeGamemode', 'loadEverything'] as const;

/**
 * Keeps the settings, which the language server reads over `.gluarc.json`, from
 * overriding a pick just saved there. The folder's own setting is removed, so one
 * left from a pick saved to the settings does not win; but where a setting it
 * would inherit (user settings, or a multi-root workspace's own, which apply to
 * every folder) differs from the pick, the folder keeps the pick instead.
 */
export async function alignSettingsWithGluarc(
    config: Pick<vscode.WorkspaceConfiguration, 'inspect' | 'update'>,
    multiRoot: boolean,
    pick: GamemodeSettings,
): Promise<void> {
    for (const key of GAMEMODE_SETTING_KEYS) {
        const picked = key === 'activeGamemode' ? pick.activeGamemode : pick.loadEverything;
        const inspected = config.inspect(key);
        const inherited = multiRoot
            ? inspected?.workspaceValue ?? inspected?.globalValue
            : inspected?.globalValue;
        if (picked !== undefined && inherited !== undefined && inherited !== null && inherited !== picked) {
            await config.update(key, picked, vscode.ConfigurationTarget.WorkspaceFolder);
            continue;
        }
        if (inspected?.workspaceFolderValue !== undefined) {
            await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        // A single-folder workspace keeps its folder settings as workspace settings.
        if (!multiRoot && inspected?.workspaceValue !== undefined) {
            await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        }
    }
}

/** Saves `loadEverything` to the folder only when it is on, or when an inherited `true` would otherwise win. */
export async function saveLoadEverythingSetting(
    config: Pick<vscode.WorkspaceConfiguration, 'inspect' | 'update'>,
    multiRoot: boolean,
    loadEverything: boolean,
): Promise<void> {
    const inspected = config.inspect('loadEverything');
    const inherited = multiRoot ? inspected?.workspaceValue ?? inspected?.globalValue : inspected?.globalValue;
    const value = loadEverything || inherited === true ? loadEverything : undefined;
    await config.update('loadEverything', value, vscode.ConfigurationTarget.WorkspaceFolder);
}

async function saveToWorkspaceFolderSettings(folder: vscode.WorkspaceFolder, settings: GamemodeSettings): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('gluals.gmod', folder.uri);
    try {
        if (settings.activeGamemode !== undefined) {
            await config.update('activeGamemode', settings.activeGamemode, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        await saveLoadEverythingSetting(config, vscode.workspace.workspaceFile !== undefined, settings.loadEverything);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to save the gamemode setting: ${message}`);
        return false;
    }
}

export class GmodWorkspaceSelection implements vscode.Disposable {
    private currentRoots: GmodRoot[] = [];
    private readonly prompted = new Set<string>();
    private promptQueue: Promise<void> = Promise.resolve();
    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor() {
        this.statusBar.command = 'gluals.gmod.selectGamemode';
    }

    get roots(): readonly GmodRoot[] {
        return this.currentRoots;
    }

    handleProjectsChanged(params: ProjectsChangedParams): void {
        this.currentRoots = params.roots ?? [];
        this.render();

        for (const root of this.currentRoots) {
            if (root.needsPick && !this.prompted.has(root.folderUri)) {
                this.prompted.add(root.folderUri);
                this.promptQueue = this.promptQueue.then(() => this.pickAndSave(root, true));
            }
        }
    }

    reset(): void {
        this.currentRoots = [];
        this.render();
    }

    async selectGamemode(): Promise<void> {
        const roots = this.currentRoots;
        if (roots.length === 0) {
            vscode.window.showInformationMessage('No Garry\'s Mod folder is open in this workspace.');
            return;
        }

        const root = roots.length === 1 ? roots[0] : await this.pickRoot(roots);
        if (root) {
            await this.pickAndSave(root, false);
        }
    }

    dispose(): void {
        this.statusBar.dispose();
        this.changeEmitter.dispose();
    }

    private render(): void {
        if (this.currentRoots.length === 0) {
            this.statusBar.hide();
        } else {
            this.statusBar.text = `$(folder-library) ${statusText(this.currentRoots)}`;
            this.statusBar.tooltip = statusTooltip(this.currentRoots);
            const background = statusBackground(this.currentRoots);
            this.statusBar.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
            this.statusBar.show();
        }
        this.changeEmitter.fire();
    }

    private async pickRoot(roots: readonly GmodRoot[]): Promise<GmodRoot | undefined> {
        const picked = await vscode.window.showQuickPick(
            roots.map((root) => ({ label: uriBasename(root.folderUri), root })),
            { title: 'Select Gamemode', placeHolder: 'Which Garry\'s Mod folder?' },
        );
        return picked?.root;
    }

    private async pickChoice(root: GmodRoot, keepOpen: boolean): Promise<GamemodeChoice | undefined> {
        const folderName = uriBasename(root.folderUri);
        for (;;) {
            const picked = await this.showItems(
                buildPickItems(root),
                root,
                `Select Gamemode (${folderName})`,
                'Gamemode to load with the addons',
                keepOpen,
            );
            if (!picked?.showBuiltins) {
                return picked?.choice;
            }
            const builtin = await this.showItems(
                buildBuiltinItems(root),
                root,
                `Built-in gamemodes (${folderName})`,
                'Built-in gamemode to load with the addons',
                keepOpen,
            );
            if (!builtin?.back) {
                return builtin?.choice;
            }
        }
    }

    private showItems(
        items: GamemodePickItem[],
        root: GmodRoot,
        title: string,
        placeHolder: string,
        keepOpen: boolean,
    ): Promise<GamemodePickItem | undefined> {
        const quickPick = vscode.window.createQuickPick<GamemodePickItem>();
        quickPick.items = items;
        quickPick.title = title;
        quickPick.placeholder = placeHolder;
        quickPick.ignoreFocusOut = keepOpen;
        const initial = initialPickItem(items, root);
        if (initial) {
            quickPick.activeItems = [initial];
        }
        return new Promise((resolve) => {
            let accepted: GamemodePickItem | undefined;
            quickPick.onDidAccept(() => {
                accepted = quickPick.selectedItems[0];
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                quickPick.dispose();
                resolve(accepted);
            });
            quickPick.show();
        });
    }

    private async pickAndSave(root: GmodRoot, keepOpen: boolean): Promise<void> {
        const choice = await this.pickChoice(root, keepOpen);
        if (!choice) {
            return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(root.folderUri));
        if (!folder) {
            vscode.window.showErrorMessage('The selected Garry\'s Mod folder is no longer part of the workspace.');
            return;
        }

        const settings = choiceToSettings(choice);
        if (resolveSaveTarget(folder) === 'gluarc') {
            await saveToGluarc(folder, settings);
        } else {
            await saveToWorkspaceFolderSettings(folder, settings);
        }
    }
}
