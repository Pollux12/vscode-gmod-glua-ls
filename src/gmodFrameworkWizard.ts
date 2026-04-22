import * as vscode from 'vscode';
import * as path from 'path';
import { applyGluarcPatch, buildPresetPatchEntries } from './gluarcPatch';
import { ensureGluarcExists } from './gluarcConfig';
import {
    categorizeScopePathRejection,
    deduplicateScopePaths,
    inferClassScopeFields,
    normalizeCustomScopePath,
    normalizeScopePath,
    PRESELECT_SCOPE_PATHS,
} from './gmodFrameworkWizardScopes';
import {
    scanWorkspaceScopes,
    shouldAcceptCustomScopePath,
} from './gmodFrameworkWizardScan';

// ─── Re-exports for external consumers ────────────────────────────────────────

export {
    deduplicateScopePaths,
    inferClassGlobal,
    normalizeCustomScopePath,
    normalizeScopePath,
    PRESELECT_SCOPE_PATHS,
    SCOPE_NAME_TO_CLASS_GLOBAL,
} from './gmodFrameworkWizardScopes';

// ─── Wizard result ────────────────────────────────────────────────────────────

export interface WizardResult {
    /** Whether the wizard completed and wrote changes. */
    applied: boolean;
    /** Workspace folder that was targeted. */
    folder: vscode.WorkspaceFolder | undefined;
}

export interface FrameworkSetupWizardOptions {
    /**
     * Optional paths to preselect in the script-folder step when they are
     * present in the workspace. Used by uncertain preset detection so the
     * guided path can start with conservative framework-specific suggestions.
     */
    recommendedScopePaths?: string[];
}

// ─── Lua identifier validation ────────────────────────────────────────────────

/**
 * Returns `true` when `name` is a syntactically valid Lua identifier:
 * it starts with a letter or underscore and contains only letters, digits,
 * and underscores.
 *
 * Used to reject obviously malformed names entered in the suppress-warning
 * input before writing them to `.gluarc.json`. Names that pass this check are
 * not guaranteed to be
 * valid *Lua globals* (they could still conflict with keywords or built-ins),
 * but they are safe to write as config values.
 */
export function isValidLuaIdentifier(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// ─── Wizard implementation ────────────────────────────────────────────────────

/**
 * Multi-step wizard for setting up an unknown or custom framework project.
 * Writes only `gmod.scriptedClassScopes.include` (plus optionally `diagnostics.globals`).
 *
 * Pressing Escape / Cancel at any step aborts the wizard and writes nothing.
 */
export async function runFrameworkSetupWizard(
    targetFolder?: vscode.WorkspaceFolder,
    options?: FrameworkSetupWizardOptions,
): Promise<WizardResult> {
    // ── Resolve workspace folder ──────────────────────────────────────────────
    // When a folder is directly targeted (or there is only one workspace folder)
    // we skip asking the user to pick — it is already unambiguous.
    const folder = await resolveWorkspaceFolder(targetFolder);
    if (!folder) {
        return { applied: false, folder: undefined };
    }

    const folderPath = folder.uri.fsPath;
    const recommendedScopePaths = new Set(
        (options?.recommendedScopePaths ?? []).map((p) => normalizeScopePath(p)),
    );

    // ── Step 1: Script Folders ────────────────────────────────────────────────
    // Scan the workspace and pre-check directories that are clearly GMod scope
    // folders (entities, weapons, plugins, etc.).
    const scannedScopes = await scanWorkspaceScopes(folderPath);
    const scopePicks = scannedScopes.map((s) => ({
        label: s.relativePath,
        description: `${s.fileCount} Lua file(s)`,
        picked: PRESELECT_SCOPE_PATHS.has(s.relativePath) || recommendedScopePaths.has(normalizeScopePath(s.relativePath)),
        scopeId: s.id,
        relativePath: s.relativePath,
    }));

    const selectedScopePicks = await vscode.window.showQuickPick(scopePicks, {
        title: 'GLuaLS Setup (1/3) — Script Folders',
        placeHolder: 'Choose script-loader folders. Auto-selected items are conservative, high-confidence matches.',
        canPickMany: true,
        ignoreFocusOut: true,
    });
    if (selectedScopePicks === undefined) {
        return { applied: false, folder };
    }

    const customScopesRaw = await vscode.window.showInputBox({
        title: 'GLuaLS Setup (1/3) — Extra Script Folders',
        prompt: 'Add extra relative folder paths only when needed. They must exist and contain Lua files.',
        placeHolder: 'e.g. gamemode/custom,lua/mylib',
        ignoreFocusOut: true,
    });
    if (customScopesRaw === undefined) {
        return { applied: false, folder };
    }

    const customScopeDirs: string[] = [];
    const rejectedScopePaths: string[] = [];
    const rejectedNonLoaderScopePaths: string[] = [];
    for (const raw of customScopesRaw.split(',')) {
        const normalized = normalizeCustomScopePath(raw);
        if (normalized !== null) {
            if (await shouldAcceptCustomScopePath(folderPath, normalized)) {
                customScopeDirs.push(normalized);
            } else {
                rejectedNonLoaderScopePaths.push(normalized);
            }
        } else if (raw.trim().length > 0) {
            rejectedScopePaths.push(raw.trim());
        }
    }
    if (rejectedScopePaths.length > 0) {
        const desc = rejectedScopePaths
            .map((p) => `"${p}" (${categorizeScopePathRejection(p)})`)
            .join(', ');
        void vscode.window.showWarningMessage(
            `GLuaLS: ${rejectedScopePaths.length === 1 ? 'One folder path was' : `${rejectedScopePaths.length} folder paths were`} ` +
            `ignored because ${rejectedScopePaths.length === 1 ? 'it' : 'they'} could not be used: ${desc}.`,
        );
    }
    if (rejectedNonLoaderScopePaths.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${rejectedNonLoaderScopePaths.length === 1 ? 'One folder was' : `${rejectedNonLoaderScopePaths.length} folders were`} ` +
            `ignored because ${rejectedNonLoaderScopePaths.length === 1 ? 'it is' : 'they are'} not a safe scripted-class folder candidate: ` +
            rejectedNonLoaderScopePaths.map((p) => `"${p}"`).join(', ') +
            `. Use a real loader root, or a folder that exists inside this workspace and already contains Lua files. ` +
            `Examples: schema, plugins, items, classes, factions, entities, weapons, effects, stools, tools, ` +
            `or reviewed framework roots like gamemode/framework, gamemode/modules, gamemode/schema, gamemode/config, gamemode/libraries, ` +
            `lua/darkrp_modules, lua/darkrp_customthings, lua/darkrp_config, lua/darkrp_language, or lua/plugins.`,
        );
    }

    // ── Step 2: Suppress Unknown-Variable Warnings (advanced, optional) ───────
    // This is an escape hatch for globals that the language server cannot detect
    // automatically.  Most users can leave this blank.
    const suppressRaw = await vscode.window.showInputBox({
        title: 'GLuaLS Setup (2/3) — Suppress Unknown-Variable Warnings (Advanced, Optional)',
        prompt:
            'Getting "unknown global" warnings for variables that are definitely valid? ' +
            'List them here (comma-separated). Leave blank to skip — this should be used sparingly.',
        placeHolder: 'e.g. MyFramework,MyLib,GlobalTable',
        ignoreFocusOut: true,
    });
    if (suppressRaw === undefined) {
        return { applied: false, folder };
    }

    const diagnosticsGlobals: string[] = [];
    const rejectedDiagnosticsGlobals: string[] = [];
    for (const raw of suppressRaw.split(',')) {
        const name = raw.trim();
        if (name.length === 0) { continue; }
        if (isValidLuaIdentifier(name)) {
            diagnosticsGlobals.push(name);
        } else {
            rejectedDiagnosticsGlobals.push(name);
        }
    }
    if (rejectedDiagnosticsGlobals.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${rejectedDiagnosticsGlobals.length === 1 ? 'One name was' : `${rejectedDiagnosticsGlobals.length} names were`} ` +
            `ignored in the suppress-warnings list because ${rejectedDiagnosticsGlobals.length === 1 ? 'it does' : 'they do'} not look like valid Lua identifiers: ` +
            rejectedDiagnosticsGlobals.map((n) => `"${n}"`).join(', ') +
            `. Names must start with a letter or underscore and contain only letters, digits, and underscores.`,
        );
    }

    // ── Step 3: Review and Save ───────────────────────────────────────────────
    // Resolve the default class global: Falls back to 'GM' so entries are never
    // silently dropped by the backend.
    const defaultClassGlobal = 'GM';

    // Merge selected scope paths with any custom-entered dirs, deduplicating
    // overlaps so that re-running the wizard (or typing the same path in the
    // custom-entry box that was already ticked in the picker) never produces
    // duplicate entries.  Path comparison is case-insensitive and backslash-
    // tolerant.  Selected picker paths take precedence (they retain their
    // pre-computed scopeId).
    const allScopePaths = deduplicateScopePaths([
        ...selectedScopePicks.map((p) => p.relativePath),
        ...customScopeDirs,
    ]);

    const classScopeEntries = allScopePaths.map((p) => {
        // Reuse the scanned pick's stable scopeId when this path came from the
        // picker; fall back to a generated ID for custom-entered paths.
        const pick = selectedScopePicks.find(
            (sp) => normalizeScopePath(sp.relativePath) === normalizeScopePath(p),
        );
        const inferred = inferClassScopeFields(p, defaultClassGlobal);
        return {
            id: pick ? pick.scopeId : `custom-scope-${normalizeScopePath(p).replace(/\//g, '-')}`,
            classGlobal: inferred.classGlobal,
            fixedClassName: inferred.fixedClassName,
            isGlobalSingleton: inferred.isGlobalSingleton,
            stripFilePrefix: inferred.stripFilePrefix,
            hideFromOutline: inferred.hideFromOutline,
            include: inferred.include,
            label: path.basename(p),
            path: inferred.path,
            rootDir: inferred.rootDir,
        };
    });

    const previewLines: string[] = [];
    if (classScopeEntries.length > 0) {
        previewLines.push(
            `Script folders: ${classScopeEntries
                .map((e) => e.rootDir ?? e.include[0]?.replace(/\/\*\*$/, ''))
                .filter((p): p is string => typeof p === 'string' && p.length > 0)
                .join(', ')}`,
        );
    }
    if (diagnosticsGlobals.length > 0) {
        previewLines.push(`Suppress warnings for: ${diagnosticsGlobals.join(', ')}`);
    }
    if (previewLines.length === 0) {
        void vscode.window.showInformationMessage(
            'Nothing was selected — no changes were made.',
            'OK',
        );
        return { applied: false, folder };
    }

    const applyPick = await vscode.window.showQuickPick(
        [
            { label: '$(check) Save Settings', description: 'Write your choices to .gluarc.json', value: 'apply' },
            { label: '$(x) Discard', description: 'Cancel and write nothing', value: 'cancel' },
        ],
        {
            title: `GLuaLS Setup (3/3) — Review & Save\n${previewLines.join('\n')}`,
            placeHolder: previewLines.join(' | '),
            ignoreFocusOut: true,
        },
    );

    if (!applyPick || applyPick.value !== 'apply') {
        return { applied: false, folder };
    }

    // ── Write ─────────────────────────────────────────────────────────────────
    const created = await ensureGluarcExists(folder);
    if (!created) {
        return { applied: false, folder };
    }

    const patchEntries = buildPresetPatchEntries({
        classScopes: classScopeEntries,
        diagnosticsGlobals: diagnosticsGlobals.length > 0 ? diagnosticsGlobals : undefined,
    });

    const summary = await applyGluarcPatch(folder, patchEntries);

    if (summary.added.length > 0 && !summary.modified) {
        // The write itself failed (e.g. file is read-only).
        void vscode.window.showErrorMessage(
            `GLuaLS: Could not save settings to .gluarc.json. ` +
                `Check that the file is not read-only and try again.`,
        );
    } else if (summary.blocked.length > 0) {
        // Structural conflicts were found (e.g. a setting expected an object but found a single value).
        void vscode.window.showWarningMessage(
            `GLuaLS: Could not apply all settings due to structural conflicts in .gluarc.json. Update manually if needed.`,
        );
    } else if (summary.conflicts.length > 0) {
        // Some existing settings have different values and were not overwritten.
        void vscode.window.showWarningMessage(
            `GLuaLS: Could not apply all settings. Some existing settings have different values and were not overwritten. Update .gluarc.json manually if needed.`,
        );
    } else if (summary.modified) {
        const alreadySetNote =
            summary.skipped.length > 0
                ? ' Some settings were already configured and were left as-is.'
                : '';
        void vscode.window.showInformationMessage(
            `GLuaLS: Settings saved to ${path.basename(summary.filePath)}.${alreadySetNote}`,
        );
        // Restart the server so the new configuration takes effect immediately.
        await vscode.commands.executeCommand('gluals.restartServer');
    } else if (
        summary.added.length === 0 &&
        summary.skipped.length === 0 &&
        summary.conflicts.length === 0 &&
        summary.blocked.length === 0
    ) {
        // Config was already fully up to date — nothing to write.
        void vscode.window.showInformationMessage(
            `GLuaLS: Your settings are already up to date — nothing new to add.`,
        );
    } else if (summary.skipped.length > 0 && summary.added.length === 0) {
        // All selected settings were already configured.
        void vscode.window.showInformationMessage(
            `GLuaLS: All selected settings were already configured — nothing new to add.`,
        );
    }

    // Report applied=true only when the write actually persisted, or when the
    // config was already genuinely up to date (no conflicts, no skips, no blocks).
    const appliedOk =
        (summary.modified ||
        (summary.added.length === 0 &&
            summary.skipped.length === 0 &&
            summary.conflicts.length === 0 &&
            summary.blocked.length === 0)) &&
        summary.blocked.length === 0;
    return { applied: appliedOk, folder };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveWorkspaceFolder(
    hint?: vscode.WorkspaceFolder,
): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(
            'GLuaLS: Please open a folder or workspace before running the setup wizard.',
        );
        return undefined;
    }

    if (folders.length === 1) return folders[0];

    // In multi-root workspaces always show a picker so the user can choose
    // which root to configure. If a hint was provided (e.g. from a detection
    // notification), sort it to the top as the suggested choice.
    const orderedFolders = hint
        ? [hint, ...folders.filter((f) => f !== hint)]
        : [...folders];

    const picks = orderedFolders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        folder: f,
    }));

    const picked = await vscode.window.showQuickPick(picks, {
        title: 'GLuaLS Setup — Select Workspace Folder',
        placeHolder: 'Which workspace folder do you want to configure?',
        ignoreFocusOut: true,
    });

    return picked?.folder;
}
