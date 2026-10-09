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
    ProjectsChangedParams,
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
    return writeGluarcConfig(folder, config);
}

async function saveToWorkspaceFolderSettings(folder: vscode.WorkspaceFolder, settings: GamemodeSettings): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('gluals.gmod', folder.uri);
    try {
        if (settings.activeGamemode !== undefined) {
            await config.update('activeGamemode', settings.activeGamemode, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        await config.update(
            'loadEverything',
            settings.loadEverything || undefined,
            vscode.ConfigurationTarget.WorkspaceFolder,
        );
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

    get roots(): readonly GmodRoot[] {
        return this.currentRoots;
    }

    handleProjectsChanged(params: ProjectsChangedParams): void {
        this.currentRoots = params.roots ?? [];

        for (const root of this.currentRoots) {
            if (root.needsPick && !this.prompted.has(root.folderUri)) {
                this.prompted.add(root.folderUri);
                this.promptQueue = this.promptQueue.then(() => this.pickAndSave(root));
            }
        }
    }

    reset(): void {
        this.currentRoots = [];
    }

    async selectGamemode(): Promise<void> {
        const roots = this.currentRoots;
        if (roots.length === 0) {
            vscode.window.showInformationMessage('No Garry\'s Mod folder is open in this workspace.');
            return;
        }

        const root = roots.length === 1 ? roots[0] : await this.pickRoot(roots);
        if (root) {
            await this.pickAndSave(root);
        }
    }

    dispose(): void {
        this.reset();
    }

    private async pickRoot(roots: readonly GmodRoot[]): Promise<GmodRoot | undefined> {
        const picked = await vscode.window.showQuickPick(
            roots.map((root) => ({ label: uriBasename(root.folderUri), root })),
            { title: 'Select Gamemode', placeHolder: 'Which Garry\'s Mod folder?' },
        );
        return picked?.root;
    }

    private async pickChoice(root: GmodRoot): Promise<GamemodeChoice | undefined> {
        const folderName = uriBasename(root.folderUri);
        const picked = await this.showItems(
            buildPickItems(root),
            `Select Gamemode (${folderName})`,
            'Gamemode to load with the addons',
        );
        if (picked?.showBuiltins) {
            const builtin = await this.showItems(
                buildBuiltinItems(root),
                `Built-in gamemodes (${folderName})`,
                'Built-in gamemode to load with the addons',
            );
            return builtin?.choice;
        }
        return picked?.choice;
    }

    private showItems(
        items: GamemodePickItem[],
        title: string,
        placeHolder: string,
    ): Thenable<GamemodePickItem | undefined> {
        return vscode.window.showQuickPick(items, { title, placeHolder });
    }

    private async pickAndSave(root: GmodRoot): Promise<void> {
        const choice = await this.pickChoice(root);
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
