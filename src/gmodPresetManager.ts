import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    GmodPluginCatalog,
    GmodPluginDescriptor,
    getGmodPluginById,
    loadGmodPluginCatalog,
    loadPluginBundleDefinition,
} from './gmodPluginCatalog';
import {
    buildPluginDetectionFingerprint,
    detectGmodPlugin,
    folderLooksLikeGmodProject,
    PluginDetectionResult,
} from './gmodPluginDetection';
import {
    readPresetState,
    markPresetApplied,
    markPresetDismissed,
    updateLastDetection,
    resetPresetSuppression,
    isSuppressed,
} from './gmodPresetState';
import { applyGluarcPatch, buildPluginPatchEntries } from './gluarcPatch';
import { ensureGluarcExists } from './gluarcConfig';
import { runFrameworkSetupWizard } from './gmodFrameworkWizard';

const GUIDED_WIZARD_PROMPT_ID = 'guided-framework-setup-wizard';

interface CatalogOptions {
    annotationsPath?: string;
    catalog?: GmodPluginCatalog;
    resolvePluginBundlePath?: (plugin: GmodPluginDescriptor) => Promise<string | undefined>;
}

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

function resolveCatalog(options?: CatalogOptions): GmodPluginCatalog {
    if (options?.catalog) {
        return options.catalog;
    }
    return loadGmodPluginCatalog(options?.annotationsPath);
}

function extractRecommendedScopePaths(fragment: Record<string, unknown>): string[] {
    const include = (fragment as any)?.gmod?.scriptedClassScopes?.include;
    if (!Array.isArray(include)) return [];
    return include
        .map((entry) => entry?.rootDir)
        .filter((rootDir): rootDir is string => typeof rootDir === 'string' && rootDir.length > 0);
}

export async function runFrameworkPresetCheck(
    context: vscode.ExtensionContext,
    { force = false, annotationsPath, catalog, resolvePluginBundlePath }: {
        force?: boolean;
        annotationsPath?: string;
        catalog?: GmodPluginCatalog;
        resolvePluginBundlePath?: (plugin: GmodPluginDescriptor) => Promise<string | undefined>;
    } = {},
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    if (!force && gluarcExistsInAnyFolder()) return;

    const activeCatalog = resolveCatalog({ annotationsPath, catalog });

    const folderResults: Array<{ folder: vscode.WorkspaceFolder; result: PluginDetectionResult }> = (
        await Promise.all(
            folders.map(async (folder) => {
                try {
                    const result = await detectGmodPlugin(folder, activeCatalog);
                    return { folder, result } as const;
                } catch {
                    return null;
                }
            }),
        )
    ).filter((x): x is { folder: vscode.WorkspaceFolder; result: PluginDetectionResult } => x !== null);

    for (const { folder, result } of folderResults) {
        await updateLastDetection(
            context,
            folder,
            result.detected[0]?.id,
            undefined,
            buildPluginDetectionFingerprint(result),
        );
    }

    for (const { folder, result } of folderResults) {
        if (result.detected.length > 0) {
            try {
                await checkFolderForPluginPreset(context, folder, activeCatalog, result, { force, resolvePluginBundlePath });
            } catch {
                // Keep auto-detection resilient if one folder has malformed config.
            }
            continue;
        }

        if (!folderLooksLikeGmodProject(folder)) continue;
        if (!force && gluarcExistsInAnyFolder()) continue;

        const fingerprint = buildPluginDetectionFingerprint(result);
        const state = readPresetState(context, folder);
        if (isSuppressed(state, GUIDED_WIZARD_PROMPT_ID, fingerprint)) continue;

        try {
            await promptForSetupWizard(context, folder, undefined, { resolvePluginBundlePath });
        } catch {
            // Ignore per-folder setup prompt failures.
        }
    }
}

export async function manualRerunFrameworkPresetCheck(
    context: vscode.ExtensionContext,
    options?: CatalogOptions,
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage('GLuaLS: No workspace folders open.');
        return;
    }

    for (const folder of folders) {
        await resetPresetSuppression(context, folder);
    }

    await runFrameworkPresetCheck(context, { force: true, ...options });
}

export async function applyFrameworkPresetById(
    context: vscode.ExtensionContext,
    frameworkId: string,
    folder: vscode.WorkspaceFolder,
    options?: CatalogOptions,
): Promise<void> {
    const activeCatalog = resolveCatalog(options);
    const plugin = getGmodPluginById(activeCatalog, frameworkId);
    if (!plugin) {
        vscode.window.showErrorMessage(`GLuaLS: Unknown plugin preset id: "${frameworkId}".`);
        return;
    }
    await applyPluginPreset(context, folder, plugin, options);
}

export async function showApplyPresetPicker(
    context: vscode.ExtensionContext,
    folder?: vscode.WorkspaceFolder,
    options?: CatalogOptions,
): Promise<void> {
    const targetFolder = folder ?? await pickWorkspaceFolder();
    if (!targetFolder) return;

    const activeCatalog = resolveCatalog(options);
    const picks = activeCatalog.plugins.map((plugin) => ({
        label: plugin.label,
        description: plugin.description,
        id: plugin.id,
    }));

    if (picks.length === 0) {
        vscode.window.showInformationMessage('GLuaLS: No plugins found in annotation bundle metadata.');
        return;
    }

    const picked = await vscode.window.showQuickPick(picks, {
        title: 'Apply Plugin Preset',
        placeHolder: 'Select a plugin to apply its additive .gluarc.json fragment',
        ignoreFocusOut: true,
    });

    if (!picked) return;
    await applyFrameworkPresetById(context, picked.id, targetFolder, options);
}

export async function runCustomSetupWizard(
    context: vscode.ExtensionContext,
    folder?: vscode.WorkspaceFolder,
): Promise<void> {
    await runFrameworkSetupWizard(context, folder);
}

async function checkFolderForPluginPreset(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    catalog: GmodPluginCatalog,
    precomputedResult?: PluginDetectionResult,
    {
        force = false,
        resolvePluginBundlePath,
    }: {
        force?: boolean;
        resolvePluginBundlePath?: (plugin: GmodPluginDescriptor) => Promise<string | undefined>;
    } = {},
): Promise<void> {
    const result = precomputedResult ?? await detectGmodPlugin(folder, catalog);
    const fingerprint = buildPluginDetectionFingerprint(result);

    if (!precomputedResult) {
        await updateLastDetection(
            context,
            folder,
            result.detected[0]?.id,
            undefined,
            fingerprint,
        );
    }

    if (!force && gluarcExistsInAnyFolder()) {
        return;
    }

    if (result.detected.length === 0) {
        if (!folderLooksLikeGmodProject(folder)) return;
        const state = readPresetState(context, folder);
        if (isSuppressed(state, GUIDED_WIZARD_PROMPT_ID, fingerprint)) return;
        await promptForSetupWizard(context, folder, undefined, { resolvePluginBundlePath });
        return;
    }

    const state = readPresetState(context, folder);
    const eligiblePlugins = result.detected.filter((plugin) => !isSuppressed(state, plugin.id, fingerprint));
    if (eligiblePlugins.length === 0) return;
    await promptForPluginPreset(context, folder, eligiblePlugins, { resolvePluginBundlePath });
}

async function promptForPluginPreset(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    plugins: readonly GmodPluginDescriptor[],
    options?: CatalogOptions,
): Promise<void> {
    const folderName = folder.name;
    const pluginSummary = plugins
        .map((plugin) => (plugin.kind === 'framework' ? plugin.label : `${plugin.label} (${plugin.kind})`))
        .join(', ');
    const message =
        `GLuaLS detected plugin(s) in "${folderName}": ${pluginSummary}. ` +
        'Apply selected plugin configs, or review setup in the wizard?';

    const action = await vscode.window.showInformationMessage(
        message,
        { modal: false },
        'Apply Selected',
        'Review Setup',
        'Dismiss',
    );

    if (action === 'Apply Selected') {
        const picks = await vscode.window.showQuickPick(
            plugins.map((plugin) => ({
                label: plugin.label,
                description: plugin.kind,
                detail: plugin.description,
                pluginId: plugin.id,
                picked: true,
            })),
            {
                title: 'Select detected plugins to apply',
                placeHolder: 'Uncheck any plugin you do not want to apply',
                ignoreFocusOut: true,
                canPickMany: true,
            },
        );
        if (!picks || picks.length === 0) {
            return;
        }

        const selectedPluginIds = new Set(picks.map((pick) => pick.pluginId));
        for (const plugin of plugins) {
            if (!selectedPluginIds.has(plugin.id)) {
                await markPresetDismissed(context, folder, plugin.id);
            }
        }
        let restartRequired = false;
        for (const plugin of plugins) {
            if (!selectedPluginIds.has(plugin.id)) continue;
            const applyResult = await applyPluginPreset(context, folder, plugin, options, {
                restartServerOnSuccess: false,
            });
            if (applyResult.restartRequired) {
                restartRequired = true;
            }
        }

        if (restartRequired) {
            await vscode.commands.executeCommand('gluals.restartServer');
        }
    } else if (action === 'Review Setup') {
        const scopePathSet = new Set<string>();
        for (const plugin of plugins) {
            const fragment = await loadPluginFragment(plugin, options);
            for (const scopePath of extractRecommendedScopePaths(fragment)) {
                scopePathSet.add(scopePath);
            }
        }
        const wizardResult = await runFrameworkSetupWizard(context, folder, {
            recommendedScopePaths: [...scopePathSet],
        });
        if (wizardResult.applied) {
            await markPresetApplied(context, folder, GUIDED_WIZARD_PROMPT_ID);
        }
    } else if (action === 'Dismiss') {
        for (const plugin of plugins) {
            await markPresetDismissed(context, folder, plugin.id);
        }
    }
}

async function promptForSetupWizard(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    detectedPlugin?: GmodPluginDescriptor,
    options?: CatalogOptions,
): Promise<void> {
    const fragment = detectedPlugin ? await loadPluginFragment(detectedPlugin, options) : {};
    const folderName = folder.name;
    const suggestedScopePaths = extractRecommendedScopePaths(fragment);

    const message = `GLuaLS found a Garry's Mod project in "${folderName}", but couldn't auto-detect a plugin. Review setup in the wizard?`;
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
    }
}

async function applyPluginPreset(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    plugin: GmodPluginDescriptor,
    options?: CatalogOptions,
    runtimeOptions?: {
        restartServerOnSuccess?: boolean;
    },
): Promise<{ restartRequired: boolean }> {
    const restartServerOnSuccess = runtimeOptions?.restartServerOnSuccess ?? true;
    const created = await ensureGluarcExists(folder);
    if (!created) return { restartRequired: false };

    const fragment = await loadPluginFragment(plugin, options);
    if (Object.keys(fragment).length === 0) {
        void vscode.window.showErrorMessage(
            `GLuaLS: ${plugin.label} plugin bundle is unavailable. Please update annotations and try again.`,
        );
        return { restartRequired: false };
    }
    const entries = buildPluginPatchEntries(plugin.id, fragment);
    const summary = await applyGluarcPatch(folder, entries);

    const isCleanIdempotent = summary.added.length === 0 &&
        summary.skipped.length === 0 &&
        summary.conflicts.length === 0 &&
        summary.blocked.length === 0;

    if ((summary.modified || isCleanIdempotent) && summary.conflicts.length === 0 && summary.blocked.length === 0) {
        await markPresetApplied(context, folder, plugin.id);
    }

    if (summary.added.length > 0 && !summary.modified) {
        void vscode.window.showErrorMessage(
            `GLuaLS: ${plugin.label} plugin: failed to write changes to .gluarc.json. Check if the file is read-only.`,
        );
    } else if (summary.blocked.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${plugin.label} plugin: could not apply due to structural conflicts in .gluarc.json. Update manually if needed.`,
        );
    } else if (summary.conflicts.length > 0) {
        void vscode.window.showWarningMessage(
            `GLuaLS: ${plugin.label} plugin: some entries were not applied because they already exist with different content. Update manually if needed.`,
        );
    } else if (summary.modified) {
        void vscode.window.showInformationMessage(
            `GLuaLS: Applied ${plugin.label} plugin configuration.`,
        );
        if (restartServerOnSuccess) {
            await vscode.commands.executeCommand('gluals.restartServer');
        }
        return { restartRequired: true };
    } else if (isCleanIdempotent) {
        void vscode.window.showInformationMessage(
            `GLuaLS: ${plugin.label} plugin applied — .gluarc.json already up to date.`,
        );
    }
    return { restartRequired: false };
}

async function loadPluginFragment(
    plugin: GmodPluginDescriptor,
    options?: CatalogOptions,
): Promise<Record<string, unknown>> {
    const resolvePluginBundlePath = options?.resolvePluginBundlePath;
    if (!resolvePluginBundlePath) return {};

    const bundlePath = await resolvePluginBundlePath(plugin);
    if (!bundlePath) return {};

    const bundleDefinition = loadPluginBundleDefinition(bundlePath, plugin.artifact.manifest || 'plugin.json');
    if (!bundleDefinition) return {};
    return bundleDefinition.gluarcFragment;
}

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
