import * as vscode from 'vscode';
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
    PluginDetectionResult,
} from './gmodPluginDetection';
import {
    markPresetApplied,
    updateLastDetection,
} from './gmodPresetState';
import { applyGluarcPatch, buildPluginPatchEntries } from './gluarcPatch';
import { ensureGluarcExists, readGluarcConfig } from './gluarcConfig';
import { runFrameworkSetupWizard } from './gmodFrameworkWizard';

let lastDetectionPromptFingerprint: string | undefined;

interface CatalogOptions {
    annotationsPath?: string;
    catalog?: GmodPluginCatalog;
    resolvePluginBundlePath?: (plugin: GmodPluginDescriptor) => Promise<string | undefined>;
}

function resolveCatalog(options?: CatalogOptions): GmodPluginCatalog {
    if (options?.catalog) {
        return options.catalog;
    }
    return loadGmodPluginCatalog(options?.annotationsPath);
}

function normalizePluginId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
}

async function readEnabledPluginIdSet(folder: vscode.WorkspaceFolder): Promise<Set<string>> {
    try {
        const config = await readGluarcConfig(folder);
        const rawPlugins = (config as any)?.gmod?.plugins;
        if (!Array.isArray(rawPlugins)) {
            return new Set();
        }

        const enabledIds = rawPlugins
            .map((entry) => normalizePluginId(entry))
            .filter((entry): entry is string => entry !== undefined);
        return new Set(enabledIds);
    } catch {
        // keep detection resilient when config is malformed/unreadable
        return new Set();
    }
}

export async function runFrameworkPresetCheck(
    context: vscode.ExtensionContext,
    { force = false, annotationsPath, catalog }: {
        force?: boolean;
        annotationsPath?: string;
        catalog?: GmodPluginCatalog;
    } = {},
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const activeCatalog = resolveCatalog({ annotationsPath, catalog });

    const folderResults: Array<{ folder: vscode.WorkspaceFolder; result: PluginDetectionResult }> = (
        await Promise.all(
            folders.map(async (folder) => {
                try {
                    const result = await detectGmodPlugin(folder, activeCatalog);
                    return { folder, result } as const;
                } catch {
                    return {
                        folder,
                        result: {
                            detected: [],
                            evidence: {},
                        },
                    } as const;
                }
            }),
        )
    );

    for (const { folder, result } of folderResults) {
        await updateLastDetection(
            context,
            folder,
            result.detected[0]?.id,
            undefined,
            buildPluginDetectionFingerprint(result),
            result.detected.map((plugin) => plugin.id),
        );
    }

    const detectedFolders = (
        await Promise.all(folderResults.map(async ({ folder, result }) => {
            if (result.detected.length === 0) {
                return { folder, result };
            }

            const enabledPluginIds = await readEnabledPluginIdSet(folder);
            const detectedNotEnabled = result.detected.filter((plugin) => !enabledPluginIds.has(plugin.id));
            return {
                folder,
                result: {
                    ...result,
                    detected: detectedNotEnabled,
                },
            };
        }))
    ).filter(({ result }) => result.detected.length > 0);

    if (detectedFolders.length === 0) {
        lastDetectionPromptFingerprint = undefined;
        return;
    }

    await promptForPluginManager(detectedFolders, { force });
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

function buildWorkspaceDetectionFingerprint(
    folderResults: ReadonlyArray<{ folder: vscode.WorkspaceFolder; result: PluginDetectionResult }>,
): string {
    const segments = folderResults
        .map(({ folder, result }) => {
            const ids = result.detected.map((plugin) => plugin.id).sort().join(',');
            return `${folder.uri.toString()}:${ids}`;
        })
        .sort((a, b) => a.localeCompare(b));
    return segments.join('|');
}

function summarizePlugin(plugin: GmodPluginDescriptor): string {
    return plugin.kind === 'framework' ? plugin.label : `${plugin.label} (${plugin.kind})`;
}

async function promptForPluginManager(
    folderResults: ReadonlyArray<{ folder: vscode.WorkspaceFolder; result: PluginDetectionResult }>,
    { force = false }: { force?: boolean } = {},
): Promise<void> {
    const fingerprint = buildWorkspaceDetectionFingerprint(folderResults);
    if (!force && lastDetectionPromptFingerprint === fingerprint) {
        return;
    }

    const pluginById = new Map<string, GmodPluginDescriptor>();
    for (const { result } of folderResults) {
        for (const plugin of result.detected) {
            if (!pluginById.has(plugin.id)) {
                pluginById.set(plugin.id, plugin);
            }
        }
    }

    const pluginSummary = [...pluginById.values()]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((plugin) => summarizePlugin(plugin))
        .join(', ');

    const action = await vscode.window.showInformationMessage(
        `GLuaLS detected plugin(s) in this workspace: ${pluginSummary}. Configure them in GLua Settings → Plugins.`,
        { modal: false },
        'Open Plugin Settings',
        'Later',
    );

    if (action === 'Later') {
        lastDetectionPromptFingerprint = fingerprint;
        return;
    }

    if (action !== 'Open Plugin Settings') {
        return;
    }

    const targetFolder = await pickDetectedWorkspaceFolder(folderResults);
    if (!targetFolder) {
        return;
    }

    await vscode.commands.executeCommand('gluals.gmod.openSettings', targetFolder.uri);
    lastDetectionPromptFingerprint = fingerprint;
}

async function pickDetectedWorkspaceFolder(
    folderResults: ReadonlyArray<{ folder: vscode.WorkspaceFolder; result: PluginDetectionResult }>,
): Promise<vscode.WorkspaceFolder | undefined> {
    if (folderResults.length === 1) {
        return folderResults[0].folder;
    }

    const picked = await vscode.window.showQuickPick(
        folderResults.map(({ folder, result }) => ({
            label: folder.name,
            description: result.detected.map((plugin) => plugin.label).sort().join(', '),
            folder,
        })),
        {
            title: 'Select workspace folder to configure plugins',
            placeHolder: 'Choose folder for GLua plugin settings',
            ignoreFocusOut: true,
        },
    );
    return picked?.folder;
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
