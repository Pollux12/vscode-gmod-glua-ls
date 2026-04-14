import * as vscode from 'vscode';

// ─── State shape ──────────────────────────────────────────────────────────────

/**
 * Persisted, workspace-scoped state for the framework preset prompt system.
 * Keyed by workspace folder URI so that multi-root workspaces are isolated.
 */
export interface FrameworkPromptState {
    /** IDs of presets that have been applied to this workspace. */
    appliedPresetIds: string[];
    /** IDs of presets the user explicitly dismissed for this workspace. */
    dismissedPresetIds: string[];
    /** Framework ID that was last detected. */
    lastDetectedFrameworkId: string | undefined;
    /**
     * Stable fingerprint of the last detection result.
     * When this changes the suppression is lifted and detection runs again.
     */
    lastFingerprint: string | undefined;
    /**
     * When true, suppress re-prompting for the dismissed preset until the
     * detection fingerprint changes or a manual re-run is requested.
     */
    suppressUntilFingerprintChanges: boolean;
}

// ─── Storage key helpers ──────────────────────────────────────────────────────

const STATE_KEY_PREFIX = 'gluals.gmod.frameworkPresetState.';

function stateKey(folderUri: vscode.Uri): string {
    return `${STATE_KEY_PREFIX}${folderUri.toString()}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads the persisted prompt state for a workspace folder.
 * Returns defaults for any fields that are missing or unset.
 * Always returns fresh array copies to prevent shared-reference mutation bugs.
 */
export function readPresetState(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
): FrameworkPromptState {
    const raw = context.workspaceState.get<Partial<FrameworkPromptState>>(stateKey(folder.uri));
    // Always return fresh arrays — never hand out shared DEFAULT_STATE references
    return {
        appliedPresetIds: raw?.appliedPresetIds ? [...raw.appliedPresetIds] : [],
        dismissedPresetIds: raw?.dismissedPresetIds ? [...raw.dismissedPresetIds] : [],
        lastDetectedFrameworkId: raw?.lastDetectedFrameworkId ?? undefined,
        lastFingerprint: raw?.lastFingerprint ?? undefined,
        suppressUntilFingerprintChanges: raw?.suppressUntilFingerprintChanges ?? false,
    };
}

/**
 * Writes updated prompt state for a workspace folder.
 */
export async function writePresetState(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    state: FrameworkPromptState,
): Promise<void> {
    await context.workspaceState.update(stateKey(folder.uri), state);
}

/**
 * Records that the user applied a preset.
 * Clears any dismissal for the same preset.
 */
export async function markPresetApplied(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    presetId: string,
): Promise<void> {
    const state = readPresetState(context, folder);
    if (!state.appliedPresetIds.includes(presetId)) {
        state.appliedPresetIds.push(presetId);
    }
    state.dismissedPresetIds = state.dismissedPresetIds.filter((id) => id !== presetId);
    await writePresetState(context, folder, state);
}

/**
 * Records that the user dismissed a preset.
 * Sets the suppress flag so the prompt is not shown again until the
 * detection fingerprint changes.
 */
export async function markPresetDismissed(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    presetId: string,
): Promise<void> {
    const state = readPresetState(context, folder);
    if (!state.dismissedPresetIds.includes(presetId)) {
        state.dismissedPresetIds.push(presetId);
    }
    state.suppressUntilFingerprintChanges = true;
    await writePresetState(context, folder, state);
}

/**
 * Updates the last-detected framework info for a workspace folder.
 */
export async function updateLastDetection(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    frameworkId: string | undefined,
    _band: undefined,
    fingerprint: string | undefined,
): Promise<void> {
    const state = readPresetState(context, folder);
    const fingerprintChanged = state.lastFingerprint !== fingerprint;

    state.lastDetectedFrameworkId = frameworkId;
    state.lastFingerprint = fingerprint;

    // Lift suppression when the fingerprint changes
    if (fingerprintChanged) {
        state.suppressUntilFingerprintChanges = false;
    }

    await writePresetState(context, folder, state);
}

/**
 * Clears suppression and the dismissed list for a workspace folder.
 * Used by the "re-run detection" manual command.
 */
export async function resetPresetSuppression(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
): Promise<void> {
    const state = readPresetState(context, folder);
    state.appliedPresetIds = [];
    state.dismissedPresetIds = [];
    state.suppressUntilFingerprintChanges = false;
    await writePresetState(context, folder, state);
}

/**
 * Returns true if prompting should be suppressed for the given preset.
 * Suppression rules:
 *  1. .gluarc.json already exists in the workspace — checked by callers before
 *     calling this function, not here.
 *  2. Preset was explicitly dismissed AND the fingerprint hasn't changed.
 *
 * Note: "applied" state is tracked in appliedPresetIds for auditing but does NOT
 * suppress re-prompting on its own. Presence of .gluarc.json is the runtime guard.
 */
export function isSuppressed(
    state: FrameworkPromptState,
    presetId: string,
    currentFingerprint: string | undefined,
): boolean {
    // Fingerprint-based suppression only applies when this specific preset was dismissed.
    if (state.suppressUntilFingerprintChanges && state.dismissedPresetIds.includes(presetId)) {
        const fingerprintChanged = state.lastFingerprint !== currentFingerprint;
        if (!fingerprintChanged) {
            return true;
        }
    }

    return false;
}
