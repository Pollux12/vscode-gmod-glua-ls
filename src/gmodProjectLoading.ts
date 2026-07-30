import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

const SELECTED_GAMEMODE_KEY = 'gluals.gmod.selectedGamemodeUri';

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

interface OpenDocumentSnapshot {
    uri: string;
    text: string;
    version: number;
}

interface GamemodeQuickPickItem extends vscode.QuickPickItem {
    candidate: GamemodeCandidate;
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

    const chooseHandler = client.onRequest(
        'gluals/chooseGamemode',
        async (params: ChooseGamemodeParams): Promise<ChooseGamemodeResult> => {
            candidates = normalizeCandidates(params.candidates);
            currentGamemodeId = params.currentGamemodeId;
            if (pendingChoice) {
                return pendingChoice;
            }

            pendingChoice = chooseGamemode(params, candidates, context);
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
        pendingChoice = chooseGamemode(params, candidates, context);
        void pendingChoice
            .then(async result => {
                if (result.selectedGamemodeId !== candidate.id) {
                    return;
                }
                currentGamemodeId = candidate.id;
                await context.workspaceState.update(SELECTED_GAMEMODE_KEY, candidate.rootUri);
                await setActiveGamemode(client, candidate);
            })
            .catch(error => {
                console.warn('Failed to activate gamemode in GLuaLS:', error);
            })
            .finally(() => {
                pendingChoice = undefined;
            });
    });
    const projectsChangedHandler = client.onNotification('gluals/projectsChanged', onProjectsChanged);

    return vscode.Disposable.from(chooseHandler, activeEditorHandler, projectsChangedHandler);
}

async function chooseGamemode(
    params: ChooseGamemodeParams,
    candidates: readonly GamemodeCandidate[],
    context: vscode.ExtensionContext,
): Promise<ChooseGamemodeResult> {
    const requested = params.requestedGamemodeId
        ? candidates.find(candidate => candidate.id === params.requestedGamemodeId)
        : undefined;
    const visibleCandidates = requested ? [requested] : candidates;
    const items = visibleCandidates.map<GamemodeQuickPickItem>(candidate => ({
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
        if (left.candidate.id === requested?.id) {
            return -1;
        }
        if (right.candidate.id === requested?.id) {
            return 1;
        }
        return left.label.localeCompare(right.label);
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: requested
            ? `Switch GLuaLS indexing to ${requested.name}?`
            : 'Select the gamemode for GLuaLS to index',
        title: params.reason === 'initial'
            ? 'Select active Garry’s Mod gamemode'
            : 'Switch active Garry’s Mod gamemode',
        ignoreFocusOut: true,
    });
    if (!selected) {
        return { selectedGamemodeId: null };
    }

    await context.workspaceState.update(SELECTED_GAMEMODE_KEY, selected.candidate.rootUri);
    return { selectedGamemodeId: selected.candidate.id };
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
