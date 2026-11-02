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

export type GamemodeChoice =
    | { kind: 'gamemode'; name: string }
    | { kind: 'allCustom' }
    | { kind: 'everything' };

export interface GamemodePickItem {
    label: string;
    description?: string;
    choice?: GamemodeChoice;
    showBuiltins?: boolean;
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

export function buildPickItems(root: GmodRoot): GamemodePickItem[] {
    const items = root.gamemodes.filter((gamemode) => !gamemode.builtin).map(gamemodeItem);
    if (root.gamemodes.some((gamemode) => gamemode.builtin)) {
        items.push({ label: 'Show built-in gamemodes...', showBuiltins: true });
    }
    items.push(
        { label: 'Load all custom', description: 'every custom gamemode', choice: { kind: 'allCustom' } },
        {
            label: 'Load all',
            description: 'the whole folder, lua/ and built-in gamemodes included',
            choice: { kind: 'everything' },
        },
    );
    return items;
}

export function buildBuiltinItems(root: GmodRoot): GamemodePickItem[] {
    return root.gamemodes.filter((gamemode) => gamemode.builtin).map(gamemodeItem);
}

export function choiceToSettings(choice: GamemodeChoice): GamemodeSettings {
    switch (choice.kind) {
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
