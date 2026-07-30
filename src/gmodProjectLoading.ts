import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

const SELECTED_GAMEMODE_KEY = 'gluals.gmod.selectedGamemodeUri';
const SELECT_GAMEMODE_COMMAND = 'gluals.gmod.selectGamemode';
const BUILT_IN_GAMEMODES = new Set(['base', 'sandbox', 'terrortown']);

export interface GmodProjectLoadingInitializationOptions {
    interactiveGamemodeSelection: true;
    selectedGamemodeUri?: string;
}

interface GamemodeCandidate {
    id: string;
    name: string;
    rootUri: string;
}

interface ChooseGamemodeParams {
    candidates: GamemodeCandidate[];
    currentGamemodeId?: string;
    requestedGamemodeId?: string;
    reason: 'initial' | 'documentOpen';
}

interface ChooseGamemodeResult {
    selectedGamemodeId: string | null;
}

interface ProjectLoadingState {
    candidates: GamemodeCandidate[];
    currentGamemodeId?: string;
}

interface OpenDocumentSnapshot {
    uri: string;
    text: string;
    version: number;
}

interface GamemodeQuickPickItem extends vscode.QuickPickItem {
    candidate?: GamemodeCandidate;
    showBuiltIns?: true;
}

export function getGmodProjectLoadingInitializationOptions(
    context: vscode.ExtensionContext,
): GmodProjectLoadingInitializationOptions {
    const selectedGamemodeUri = context.workspaceState.get<string>(SELECTED_GAMEMODE_KEY);
    return {
        interactiveGamemodeSelection: true,
        ...(selectedGamemodeUri ? { selectedGamemodeUri } : {}),
    };
}

export function registerGmodProjectLoading(
    client: LanguageClient,
    context: vscode.ExtensionContext,
    onProjectsChanged: () => void,
): vscode.Disposable {
    let candidates: GamemodeCandidate[] = [];
    let currentGamemodeId: string | undefined;
    let pendingChoice: Promise<ChooseGamemodeResult> | undefined;
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    statusBar.name = 'GLuaLS Active Gamemode';
    statusBar.command = SELECT_GAMEMODE_COMMAND;

    const updateStatusBar = (): void => {
        if (candidates.length === 0) {
            statusBar.hide();
            return;
        }
        const current = candidates.find(candidate => candidate.id === currentGamemodeId);
        statusBar.text = current
            ? `$(server) GLuaLS: ${current.name}`
            : '$(server) GLuaLS: Select Gamemode';
        statusBar.tooltip = current
            ? `Active gamemode: ${current.name}\n\nClick to select another gamemode.`
            : 'Click to select the gamemode GLuaLS should index.';
        statusBar.show();
    };

    const activateGamemode = async (candidate: GamemodeCandidate): Promise<void> => {
        currentGamemodeId = candidate.id;
        updateStatusBar();
        await context.workspaceState.update(SELECTED_GAMEMODE_KEY, candidate.rootUri);
        await setActiveGamemode(client, candidate);
    };

    const chooseHandler = client.onRequest(
        'gluals/chooseGamemode',
        async (params: ChooseGamemodeParams): Promise<ChooseGamemodeResult> => {
            candidates = normalizeCandidates(params.candidates);
            currentGamemodeId = params.currentGamemodeId;
            updateStatusBar();
            if (pendingChoice) {
                return pendingChoice;
            }

            pendingChoice = chooseGamemode(params, candidates);
            try {
                const result = await pendingChoice;
                if (!result.selectedGamemodeId) {
                    return result;
                }

                const selected = candidates.find(candidate => candidate.id === result.selectedGamemodeId);
                if (!selected) {
                    return { selectedGamemodeId: null };
                }
                currentGamemodeId = selected.id;
                updateStatusBar();
                await context.workspaceState.update(SELECTED_GAMEMODE_KEY, selected.rootUri);

                if (params.reason === 'documentOpen') {
                    queueMicrotask(() => {
                        void setActiveGamemode(client, selected).catch(error => {
                            console.warn('Failed to send open gamemode documents to GLuaLS:', error);
                        });
                    });
                }
                return result;
            } finally {
                pendingChoice = undefined;
            }
        },
    );

    const activeEditorHandler = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor || editor.document.languageId !== 'glua' || candidates.length === 0) {
            return;
        }
        const candidate = candidateContainingUri(candidates, editor.document.uri);
        if (!candidate || candidate.id === currentGamemodeId || pendingChoice) {
            return;
        }

        const params: ChooseGamemodeParams = {
            candidates,
            currentGamemodeId,
            requestedGamemodeId: candidate.id,
            reason: 'documentOpen',
        };
        pendingChoice = chooseGamemode(params, candidates);
        void pendingChoice
            .then(async result => {
                if (result.selectedGamemodeId !== candidate.id) {
                    return;
                }
                await activateGamemode(candidate);
            })
            .catch(error => {
                console.warn('Failed to activate gamemode in GLuaLS:', error);
            })
            .finally(() => {
                pendingChoice = undefined;
            });
    });
    const selectCommandHandler = vscode.commands.registerCommand(
        SELECT_GAMEMODE_COMMAND,
        async () => {
            if (candidates.length === 0 || pendingChoice) {
                return;
            }
            const params: ChooseGamemodeParams = {
                candidates,
                currentGamemodeId,
                reason: 'initial',
            };
            pendingChoice = chooseGamemode(params, candidates);
            try {
                const result = await pendingChoice;
                const selected = candidates.find(candidate => candidate.id === result.selectedGamemodeId);
                if (selected) {
                    await activateGamemode(selected);
                }
            } finally {
                pendingChoice = undefined;
            }
        },
    );
    const projectsChangedHandler = client.onNotification(
        'gluals/projectsChanged',
        (state: ProjectLoadingState | undefined) => {
            if (state) {
                candidates = normalizeCandidates(state.candidates);
                currentGamemodeId = typeof state.currentGamemodeId === 'string'
                    ? state.currentGamemodeId
                    : undefined;
                updateStatusBar();
            }
            onProjectsChanged();
        },
    );

    return vscode.Disposable.from(
        chooseHandler,
        activeEditorHandler,
        selectCommandHandler,
        projectsChangedHandler,
        statusBar,
    );
}

async function chooseGamemode(
    params: ChooseGamemodeParams,
    candidates: readonly GamemodeCandidate[],
): Promise<ChooseGamemodeResult> {
    const requested = params.requestedGamemodeId
        ? candidates.find(candidate => candidate.id === params.requestedGamemodeId)
        : undefined;
    if (requested) {
        const selected = await showGamemodeQuickPick(params, [requested], requested);
        return { selectedGamemodeId: selected?.id ?? null };
    }

    const builtIns = candidates.filter(candidate => isBuiltInGamemode(candidate));
    const custom = candidates.filter(candidate => !isBuiltInGamemode(candidate));
    if (custom.length === 0) {
        const selected = await showGamemodeQuickPick(params, builtIns);
        return { selectedGamemodeId: selected?.id ?? null };
    }

    const items = createGamemodeQuickPickItems(params, custom);
    if (builtIns.length > 0) {
        items.push({
            label: '$(list-tree) Show built-in gamemodes…',
            description: 'base, sandbox, terrortown',
            showBuiltIns: true,
        });
    }
    const selected = await vscode.window.showQuickPick(items, quickPickOptions(params));
    if (!selected) {
        return { selectedGamemodeId: null };
    }
    if (selected.showBuiltIns) {
        const builtIn = await showGamemodeQuickPick(params, builtIns);
        return { selectedGamemodeId: builtIn?.id ?? null };
    }
    return { selectedGamemodeId: selected.candidate?.id ?? null };
}

function createGamemodeQuickPickItems(
    params: ChooseGamemodeParams,
    candidates: readonly GamemodeCandidate[],
): GamemodeQuickPickItem[] {
    const items = candidates.map<GamemodeQuickPickItem>(candidate => ({
        label: candidate.name,
        description: candidate.id === params.currentGamemodeId
            ? 'Current gamemode'
            : candidate.id === params.requestedGamemodeId
                ? 'Opened gamemode'
                : undefined,
        detail: vscode.Uri.parse(candidate.rootUri).fsPath,
        candidate,
    }));
    items.sort((left, right) => {
        if (left.candidate?.id === params.requestedGamemodeId) {
            return -1;
        }
        if (right.candidate?.id === params.requestedGamemodeId) {
            return 1;
        }
        return left.label.localeCompare(right.label);
    });
    return items;
}

async function showGamemodeQuickPick(
    params: ChooseGamemodeParams,
    candidates: readonly GamemodeCandidate[],
    requested?: GamemodeCandidate,
): Promise<GamemodeCandidate | undefined> {
    const selected = await vscode.window.showQuickPick(
        createGamemodeQuickPickItems(params, candidates),
        quickPickOptions(params, requested),
    );
    return selected?.candidate;
}

function quickPickOptions(
    params: ChooseGamemodeParams,
    requested?: GamemodeCandidate,
): vscode.QuickPickOptions {
    return {
        placeHolder: requested
            ? `Switch GLuaLS indexing to ${requested.name}?`
            : 'Select the gamemode for GLuaLS to index',
        title: params.reason === 'initial'
            ? 'Select active Garry’s Mod gamemode'
            : 'Switch active Garry’s Mod gamemode',
        ignoreFocusOut: true,
    };
}

function isBuiltInGamemode(candidate: GamemodeCandidate): boolean {
    return BUILT_IN_GAMEMODES.has(candidate.name.toLowerCase());
}

async function setActiveGamemode(
    client: LanguageClient,
    candidate: GamemodeCandidate,
): Promise<void> {
    const openDocuments = collectOpenDocumentSnapshots(candidate);
    await client.sendRequest('gluals/setActiveGamemode', {
        selectedGamemodeId: candidate.id,
        openDocuments,
    });
}

function collectOpenDocumentSnapshots(candidate: GamemodeCandidate): OpenDocumentSnapshot[] {
    const root = vscode.Uri.parse(candidate.rootUri);
    return vscode.workspace.textDocuments
        .filter(document => document.uri.scheme === 'file' && uriIsWithin(document.uri, root))
        .map(document => ({
            uri: document.uri.toString(),
            text: document.getText(),
            version: document.version,
        }));
}

function normalizeCandidates(candidates: readonly GamemodeCandidate[] | undefined): GamemodeCandidate[] {
    if (!Array.isArray(candidates)) {
        return [];
    }
    return candidates
        .filter(candidate =>
            typeof candidate?.id === 'string'
            && typeof candidate.name === 'string'
            && typeof candidate.rootUri === 'string',
        )
        .sort((left, right) =>
            left.name.localeCompare(right.name) || left.rootUri.localeCompare(right.rootUri),
        );
}

function candidateContainingUri(
    candidates: readonly GamemodeCandidate[],
    uri: vscode.Uri,
): GamemodeCandidate | undefined {
    return candidates
        .filter(candidate => uriIsWithin(uri, vscode.Uri.parse(candidate.rootUri)))
        .sort((left, right) => right.rootUri.length - left.rootUri.length)[0];
}

function uriIsWithin(uri: vscode.Uri, root: vscode.Uri): boolean {
    if (uri.scheme !== root.scheme) {
        return false;
    }
    const relative = path.relative(root.fsPath, uri.fsPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
