import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { hasGamemodeManifest } from './gmodGamemodeBaseDetector';
import {
    detectFramework,
    buildDetectionFingerprint,
    getFrameworkDescriptor,
    FRAMEWORK_DESCRIPTORS,
    FrameworkPreset,
    DetectionResult,
} from './gmodFrameworkDescriptors';
import {
    readPresetState,
    markPresetApplied,
    markPresetDismissed,
    updateLastDetection,
    resetPresetSuppression,
    isSuppressed,
} from './gmodPresetState';
import { applyGluarcPatch, buildPresetPatchEntries } from './gluarcPatch';
import { ensureGluarcExists } from './gluarcConfig';
import { runFrameworkSetupWizard } from './gmodFrameworkWizard';

const GUIDED_WIZARD_PROMPT_ID = 'guided-framework-setup-wizard';

function folderLooksLikeGmodProject(folder: vscode.WorkspaceFolder): boolean {
    const folderPath = folder.uri.fsPath;
    const commonDirs = [
        ['gamemode'],
        ['lua'],
        ['schema'],
        ['plugins'],
        ['entities'],
        ['weapons'],
    ];

    for (const segments of commonDirs) {
        try {
            if (fs.statSync(path.join(folderPath, ...segments)).isDirectory()) {
                return true;
            }
        } catch {
            // ignore missing paths
        }
    }

    try {
        return hasGamemodeManifest(folderPath);
    } catch {
        return false;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if any open workspace folder already has a .gluarc.json config file,
 * indicating the project has already been set up and auto-prompts should be skipped.
 */
function gluarcExistsInAnyFolder(): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.some((f) => {
        try {
            return fs.statSync(path.join(f.uri.fsPath, '.gluarc.json')).isFile();
        } catch {
            return false;
        }
    });
}

/**
 * Runs the framework detection + preset prompt flow for all workspace folders.
 * Detected frameworks offer direct preset apply; undetected GMod-like projects
 * offer the setup wizard. Safe to call multiple times — suppression logic
 * prevents repeated prompts.
 *
 * In multi-root workspaces, folders that detect the same framework are grouped
 * together and produce a single notification using the first matching folder,
 * preventing duplicate prompts for sibling roots.
 *
 * When `force` is true (manual re-run), the .gluarc.json existence check is skipped
 * so the notification is shown even if the workspace is already configured.
 */
export async function runFrameworkPresetCheck(
    context: vscode.ExtensionContext,
    { force = false }: { force?: boolean } = {},
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    // Detect all folders in parallel
    const folderResults: Array<{ folder: vscode.WorkspaceFolder; result: DetectionResult }> = (
        await Promise.all(
            folders.map(async (folder) => {
                try {
                    const result = await detectFramework(folder);
                    return { folder, result } as const;
                } catch {
                    return null;
                }
            }),
        )
    ).filter((x): x is { folder: vscode.WorkspaceFolder; result: DetectionResult } => x !== null);

    // Update stored detection info for every folder before prompting
    for (const { folder, result } of folderResults) {
        await updateLastDetection(
            context,
            folder,
            result.detected?.id,
            undefined,
            buildDetectionFingerprint(result),
        );
    }

    // Group folders by their detected framework
    const frameworkGroups = new Map<
        string,
        Array<{ folder: vscode.WorkspaceFolder; result: DetectionResult }>
    >();
    for (const item of folderResults) {
        const fwId = item.result.detected?.id;
        if (!fwId) continue;
        if (!frameworkGroups.has(fwId)) {
            frameworkGroups.set(fwId, []);
        }
        frameworkGroups.get(fwId)!.push(item);
    }

    // For each framework group, fire ONE prompt using the first folder
    const promptedFolders = new Set<vscode.WorkspaceFolder>();
    for (const [, group] of frameworkGroups) {
        const best = group[0];
        promptedFolders.add(best.folder);
        try {
            await checkFolderForFrameworkPreset(context, best.folder, best.result, { force });
        } catch {
            // Silently skip detection failures to avoid disrupting the extension
        }
    }

    // Handle folders with no framework detection that look like a GMod project
    for (const { folder, result } of folderResults) {
        if (promptedFolders.has(folder)) continue;
        if (result.detected) continue;
        if (!folderLooksLikeGmodProject(folder)) continue;

        if (!force && gluarcExistsInAnyFolder()) continue;

        const fingerprint = buildDetectionFingerprint(result);
        const state = readPresetState(context, folder);
        if (isSuppressed(state, GUIDED_WIZARD_PROMPT_ID, fingerprint)) continue;

        try {
            await promptForSetupWizard(context, folder, result);
        } catch {
            // Silently skip
        }
    }
}

/**
 * Manual re-run command: clears suppression and re-runs detection for all folders.
 */
export async function manualRerunFrameworkPresetCheck(
    context: vscode.ExtensionContext,
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage('GLuaLS: No workspace folders open.');
        return;
    }

    for (const folder of folders) {
        await resetPresetSuppression(context, folder);
    }

    await runFrameworkPresetCheck(context, { force: true });
}

/**
 * Applies a specific preset by framework id to the given workspace folder,
 * bypassing detection. Used by the command palette.
 */
export async function applyFrameworkPresetById(
    context: vscode.ExtensionContext,
    frameworkId: string,
    folder: vscode.WorkspaceFolder,
): Promise<void> {
    const descriptor = getFrameworkDescriptor(frameworkId);
    if (!descriptor) {
        vscode.window.showErrorMessage(`GLuaLS: Unknown framework preset id: "${frameworkId}".`);
        return;
    }

    await applyPreset(context, folder, descriptor.getPreset());
}

/**
 * Opens a quick-pick to let the user choose which framework preset to apply.
 */
export async function showApplyPresetPicker(
    context: vscode.ExtensionContext,
    folder?: vscode.WorkspaceFolder,
): Promise<void> {
    const targetFolder = folder ?? await pickWorkspaceFolder();
    if (!targetFolder) return;

    const picks = FRAMEWORK_DESCRIPTORS.map((desc) => ({
        label: desc.label,
        description: desc.description,
        id: desc.id,
    }));

    const picked = await vscode.window.showQuickPick(picks, {
        title: 'Apply Framework Preset',
        placeHolder: 'Select a framework to apply its scripted class scope preset',
        ignoreFocusOut: true,
    });

    if (!picked) return;

    await applyFrameworkPresetById(context, picked.id, targetFolder);
}

/**
 * Launches the custom setup wizard for unknown/custom frameworks.
 */
export async function runCustomSetupWizard(
    context: vscode.ExtensionContext,
    folder?: vscode.WorkspaceFolder,
): Promise<void> {
    await runFrameworkSetupWizard(context, folder);
}

// ─── Internal detection + prompt logic ───────────────────────────────────────

async function checkFolderForFrameworkPreset(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    precomputedResult?: DetectionResult,
    { force = false }: { force?: boolean } = {},
): Promise<void> {
    const result = precomputedResult ?? await detectFramework(folder);
    const fingerprint = buildDetectionFingerprint(result);

    // Update stored detection info only when we ran detection here (not pre-supplied)
    if (!precomputedResult) {
        await updateLastDetection(
            context,
            folder,
            result.detected?.id,
            undefined,
            fingerprint,
        );
    }

    // If .gluarc.json already exists anywhere in the workspace, treat the project
    // as configured and skip auto-prompts (unless this is a forced manual re-check).
    if (!force && gluarcExistsInAnyFolder()) {
        return;
    }

    // No framework detected — offer wizard if it looks like a GMod project
    if (!result.detected) {
        if (!folderLooksLikeGmodProject(folder)) {
            return;
        }

        const state = readPresetState(context, folder);
        if (isSuppressed(state, GUIDED_WIZARD_PROMPT_ID, fingerprint)) {
            return;
        }

        await promptForSetupWizard(context, folder, result);
        return;
    }

    // Framework detected — offer preset apply
    const descriptor = result.detected;
    const preset = descriptor.getPreset();
    const state = readPresetState(context, folder);

    if (isSuppressed(state, preset.id, fingerprint)) {
        return;
    }

    // Show notification prompt
    await promptForPreset(context, folder, preset, descriptor.id);
}

async function promptForPreset(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    preset: FrameworkPreset,
    frameworkId: string,
): Promise<void> {
    const folderName = folder.name;
    const message =
        `GLuaLS detected the ${preset.label} framework in "${folderName}". ` +
        `Apply the ${preset.label} preset, or review setup in the wizard?`;

    const action = await vscode.window.showInformationMessage(
        message,
        { modal: false },
        'Apply',
        'Review Setup',
        'Dismiss',
    );

    if (action === 'Apply') {
        await applyPreset(context, folder, preset);
    } else if (action === 'Review Setup') {
        const descriptor = getFrameworkDescriptor(frameworkId);
        const suggestedScopePaths = descriptor?.getPreset().classScopes
            .map((scope) => scope.rootDir)
            .filter((rootDir): rootDir is string => typeof rootDir === 'string' && rootDir.length > 0) ?? [];

        const wizardResult = await runFrameworkSetupWizard(context, folder, {
            recommendedScopePaths: suggestedScopePaths,
        });

        if (wizardResult.applied) {
            await markPresetApplied(context, folder, GUIDED_WIZARD_PROMPT_ID);
        }
    } else if (action === 'Dismiss') {
        await markPresetDismissed(context, folder, preset.id);
    }
    // No action (closed notification) = don't suppress
}

async function promptForSetupWizard(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    result: DetectionResult,
): Promise<void> {
    const folderName = folder.name;
    const descriptor = result.detected;
    const suggestedScopePaths = descriptor?.getPreset().classScopes
        .map((scope) => scope.rootDir)
        .filter((rootDir): rootDir is string => typeof rootDir === 'string' && rootDir.length > 0) ?? [];

    let message = `GLuaLS found a Garry's Mod project in "${folderName}", but couldn't auto-detect a framework. Review setup in the wizard?`;

    const action = await vscode.window.showInformationMessage(
        message,
        { modal: false },
        'Review Setup',
        'Dismiss',
    );

    if (action === 'Review Setup') {
        const wizardResult = await runFrameworkSetupWizard(context, folder, {
            recommendedScopePaths: suggestedScopePaths,
        });

        if (wizardResult.applied) {
            await markPresetApplied(context, folder, GUIDED_WIZARD_PROMPT_ID);
        }
        return;
    }

    if (action === 'Dismiss') {
        await markPresetDismissed(context, folder, GUIDED_WIZARD_PROMPT_ID);
        return;
    }
}

async function applyPreset(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    preset: FrameworkPreset,
): Promise<void> {
    const created = await ensureGluarcExists(folder);
    if (!created) return;

    const entries = buildPresetPatchEntries({
        classScopes: preset.classScopes,
    });

    const summary = await applyGluarcPatch(folder, entries);

    const isCleanIdempotent = summary.added.length === 0 &&
        summary.skipped.length === 0 &&
        summary.conflicts.length === 0 &&
        summary.blocked.length === 0;

    if ((summary.modified || isCleanIdempotent) && summary.conflicts.length === 0 && summary.blocked.length === 0) {
        await markPresetApplied(context, folder, preset.id);
    }

    if (summary.added.length > 0 && !summary.modified) {
        void vscode.window.showErrorMessage(
            `GLuaLS: ${preset.label} preset: failed to write changes to .gluarc.json. Check if the file is read-only.`,
        );
    } else if (summary.blocked.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${preset.label} preset: could not apply due to structural conflicts in .gluarc.json (e.g. expected an object but found a single value). Update manually if needed.`,
        );
    } else if (summary.conflicts.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${preset.label} preset: some entries were not applied because they already exist with different content. Update manually if needed.`,
        );
    } else if (summary.modified) {
        const alreadySetNote = summary.skipped.length > 0
            ? ` Some entries were already set and left as-is.`
            : '';
        void vscode.window.showInformationMessage(
            `GLuaLS: Applied ${preset.label} preset. Added: ${summary.added.join(', ')}.${alreadySetNote}`,
        );
        await vscode.commands.executeCommand('gluals.restartServer');
    } else if (summary.added.length === 0 && summary.skipped.length === 0 && summary.conflicts.length === 0 && summary.blocked.length === 0) {
        void vscode.window.showInformationMessage(
            `GLuaLS: ${preset.label} preset applied — .gluarc.json already up to date.`,
        );
    } else if (summary.skipped.length > 0 && summary.added.length === 0) {
        void vscode.window.showInformationMessage(
            `GLuaLS: ${preset.label} preset: all entries already set — nothing new to add.`,
        );
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('GLuaLS: No workspace folders open.');
        return undefined;
    }
    if (folders.length === 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({
        placeHolder: 'Select the workspace folder to configure',
    });
}
