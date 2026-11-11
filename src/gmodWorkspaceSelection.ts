import * as fs from 'fs';
import * as path from 'path';

export interface GmodGamemode {
    name: string;
    uri: string;
    derivesFrom?: string;
    builtin: boolean;
}

export interface GmodRoot {
    folderUri: string;
    rootUri: string;
    gamemodes: GmodGamemode[];
    addons: string[];
    activeGamemode: string | null;
    loadEverything: boolean;
    loaded: string[];
    needsPick: boolean;
}

export interface ProjectsChangedParams {
    roots: GmodRoot[];
}

export const ALL_CUSTOM_GAMEMODES = '*';
export const NO_GAMEMODE = '';

export type GamemodeChoice =
    | { kind: 'addonsOnly' }
    | { kind: 'gamemode'; name: string }
    | { kind: 'allCustom' }
    | { kind: 'everything' };

export interface GamemodePickItem {
    label: string;
    description?: string;
    choice?: GamemodeChoice;
    showBuiltins?: boolean;
    back?: boolean;
}

export interface GamemodeSettings {
    activeGamemode?: string;
    loadEverything: boolean;
}

export type SaveTarget = 'gluarc' | 'settings';

export interface SaveTargetFacts {
    inGitRepository: boolean;
    hasGluarc: boolean;
    hasOtherConfig: boolean;
}

export function uriBasename(uri: string): string {
    const segments = uri.split('/').filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1] ?? uri;
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

function gamemodeItem(gamemode: GmodGamemode): GamemodePickItem {
    return {
        label: gamemode.name,
        description: gamemode.derivesFrom ? `derives from ${gamemode.derivesFrom}` : undefined,
        choice: { kind: 'gamemode', name: gamemode.name },
    };
}

/** The choice saved for `root`, or undefined before the first pick. */
export function currentChoice(root: GmodRoot): GamemodeChoice | undefined {
    if (root.loadEverything) {
        return { kind: 'everything' };
    }
    switch (root.activeGamemode) {
        case null:
            return undefined;
        case NO_GAMEMODE:
            return { kind: 'addonsOnly' };
        case ALL_CUSTOM_GAMEMODES:
            return { kind: 'allCustom' };
        default:
            return { kind: 'gamemode', name: root.activeGamemode };
    }
}

function sameChoice(left: GamemodeChoice, right: GamemodeChoice): boolean {
    return left.kind === right.kind
        && (left.kind !== 'gamemode' || (right.kind === 'gamemode' && left.name === right.name));
}

function currentBuiltin(root: GmodRoot): string | undefined {
    const current = currentChoice(root);
    return current?.kind === 'gamemode' && root.gamemodes.some((gamemode) => gamemode.builtin && gamemode.name === current.name)
        ? current.name
        : undefined;
}

function markCurrent(item: GamemodePickItem, what = 'current'): GamemodePickItem {
    return { ...item, description: item.description ? `✓ ${what} · ${item.description}` : `✓ ${what}` };
}

function markCurrentChoice(items: GamemodePickItem[], root: GmodRoot): GamemodePickItem[] {
    const current = currentChoice(root);
    return items.map((item) => (current && item.choice && sameChoice(item.choice, current) ? markCurrent(item) : item));
}

export function buildPickItems(root: GmodRoot): GamemodePickItem[] {
    const items: GamemodePickItem[] = [
        {
            label: 'Addons only',
            description: 'no gamemode; the annotations cover base and sandbox',
            choice: { kind: 'addonsOnly' },
        },
        ...root.gamemodes.filter((gamemode) => !gamemode.builtin).map(gamemodeItem),
    ];
    if (root.gamemodes.some((gamemode) => gamemode.builtin)) {
        const showBuiltins: GamemodePickItem = {
            label: 'Show built-in gamemodes...',
            description: 'loads their source on top of the annotations',
            showBuiltins: true,
        };
        const builtin = currentBuiltin(root);
        items.push(builtin ? markCurrent(showBuiltins, `current: ${builtin}`) : showBuiltins);
    }
    items.push(
        { label: 'Load all custom', description: 'every custom gamemode', choice: { kind: 'allCustom' } },
        {
            label: 'Load all',
            description: 'the whole folder, lua/ and built-in gamemodes included',
            choice: { kind: 'everything' },
        },
    );
    return markCurrentChoice(items, root);
}

export function buildBuiltinItems(root: GmodRoot): GamemodePickItem[] {
    return [
        { label: '$(arrow-left) Back', back: true },
        ...markCurrentChoice(root.gamemodes.filter((gamemode) => gamemode.builtin).map(gamemodeItem), root),
    ];
}

/** The item the picker starts on: the saved choice, or else a gamemode loaded because one of its files is open. */
export function initialPickItem(items: readonly GamemodePickItem[], root: GmodRoot): GamemodePickItem | undefined {
    const openGamemode = loadedCustomGamemodes(root)[0];
    const target = currentChoice(root) ?? (openGamemode !== undefined ? { kind: 'gamemode', name: openGamemode } as const : undefined);
    if (!target) {
        return undefined;
    }
    return items.find((item) => item.choice && sameChoice(item.choice, target))
        ?? (currentBuiltin(root) !== undefined ? items.find((item) => item.showBuiltins) : undefined);
}

export function choiceToSettings(choice: GamemodeChoice): GamemodeSettings {
    switch (choice.kind) {
        case 'addonsOnly':
            return { activeGamemode: NO_GAMEMODE, loadEverything: false };
        case 'gamemode':
            return { activeGamemode: choice.name, loadEverything: false };
        case 'allCustom':
            return { activeGamemode: ALL_CUSTOM_GAMEMODES, loadEverything: false };
        case 'everything':
            return { loadEverything: true };
    }
}

export function chooseSaveTarget(facts: SaveTargetFacts): SaveTarget {
    return facts.inGitRepository && (facts.hasGluarc || !facts.hasOtherConfig) ? 'gluarc' : 'settings';
}

function loadedCustomGamemodes(root: GmodRoot): string[] {
    const loaded = new Set(root.loaded);
    return root.gamemodes
        .filter((gamemode) => !gamemode.builtin && loaded.has(gamemode.uri))
        .map((gamemode) => gamemode.name);
}

export function rootLabel(root: GmodRoot): string {
    if (root.loadEverything) {
        return 'everything';
    }
    if (root.activeGamemode === ALL_CUSTOM_GAMEMODES) {
        return 'all custom';
    }
    if (root.activeGamemode === NO_GAMEMODE) {
        return 'addons only';
    }
    if (root.activeGamemode) {
        return root.activeGamemode;
    }
    const loaded = loadedCustomGamemodes(root);
    return loaded.length > 0 ? loaded.join(', ') : 'no gamemode';
}

export function statusText(roots: readonly GmodRoot[]): string {
    const labels = new Set(roots.map(rootLabel));
    if (labels.size === 1) {
        return `GLuaLS: ${[...labels][0]}`;
    }
    return `GLuaLS: ${roots.length} GMod folders`;
}

export function statusBackground(roots: readonly GmodRoot[]): string | undefined {
    return roots.some((root) => root.needsPick) ? 'statusBarItem.warningBackground' : undefined;
}

export function statusTooltip(roots: readonly GmodRoot[]): string {
    const lines: string[] = [];
    for (const root of roots) {
        lines.push(`${uriBasename(root.folderUri)}: ${rootLabel(root)}`);
        for (const loaded of root.loaded) {
            lines.push(`  ${uriBasename(loaded)}`);
        }
    }
    lines.push('Click to select the gamemode');
    return lines.join('\n');
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/** Mirrors the language server's root discovery: a `garrysmod` folder or child, or `addons/` beside `gamemodes/`. */
export function isGmodWorkspaceRoot(folderPath: string): boolean {
    const name = path.basename(folderPath).toLowerCase();
    return name === 'garrysmod'
        || isDirectory(path.join(folderPath, 'garrysmod'))
        || (isDirectory(path.join(folderPath, 'addons')) && isDirectory(path.join(folderPath, 'gamemodes')));
}
