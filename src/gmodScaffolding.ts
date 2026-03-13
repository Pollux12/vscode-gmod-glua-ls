import * as path from 'path';
import { execFile } from 'child_process';
import { promisify, TextEncoder } from 'util';
import * as vscode from 'vscode';
import { readGluarcConfig } from './gluarcConfig';
import {
    fetchLsScriptedClassesResult,
    hasScaffoldFiles,
    LsScriptedClassDefinition,
    LsScriptedClassScaffold,
    LsScriptedClassScaffoldFile,
} from './gmodExplorer';

const execFileAsync = promisify(execFile);
const CLASS_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export interface ScaffoldingTreeItemData {
    type?: string;
    definitionId?: string;
    className?: string;
    uri?: vscode.Uri;
}

export interface ScaffoldingTreeItemLike {
    contextValue?: string;
    data?: ScaffoldingTreeItemData;
    uri?: vscode.Uri;
    resourceUri?: vscode.Uri;
}

interface ScaffoldFilePlan {
    readonly target: vscode.Uri;
    readonly templateFile: string;
}

interface ScaffoldPlan {
    readonly files: ScaffoldFilePlan[];
    readonly mainFile: vscode.Uri;
}

interface ScaffoldDefinition extends LsScriptedClassDefinition {
    scaffold: LsScriptedClassScaffold;
}

interface ScaffoldTypePick extends vscode.QuickPickItem {
    definition: ScaffoldDefinition;
}

export function applyTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => vars[key] ?? '');
}

export async function loadTemplate(
    templateFile: string,
    context: vscode.ExtensionContext,
    workspaceFolder?: vscode.WorkspaceFolder,
): Promise<string> {
    const templateRoot = await resolveTemplateRoot(workspaceFolder);
    if (templateRoot) {
        const customTemplateUri = vscode.Uri.joinPath(templateRoot, templateFile);
        if (await pathExists(customTemplateUri)) {
            return readTextFile(customTemplateUri);
        }
    }

    const bundledTemplate = vscode.Uri.file(
        path.join(context.extensionPath, 'res', 'templates', templateFile)
    );

    return readTextFile(bundledTemplate);
}

export async function scaffoldNewScriptedClass(
    treeItem: unknown,
    context: vscode.ExtensionContext
): Promise<void> {
    const definitions = await getOfferedDefinitions(treeItem);
    if (definitions.length === 0) {
        vscode.window.showWarningMessage('No scripted class templates are configured for scaffolding.');
        return;
    }

    const selectedDefinition = await pickScaffoldDefinition(definitions);
    if (!selectedDefinition) {
        return;
    }

    const className = await promptClassName(selectedDefinition.label);
    if (!className) {
        return;
    }

    const workspaceFolder = await resolveWorkspaceFolder(treeItem);
    const targetDirectory = await resolveTargetDirectory(treeItem, selectedDefinition, workspaceFolder);
    if (!targetDirectory) {
        return;
    }

    const existingAuthor = await getAuthorName(targetDirectory);
    const variables: Record<string, string> = {
        name: className,
        class: selectedDefinition.classGlobal,
        date: new Date().toISOString().split('T')[0],
        author: existingAuthor,
    };

    const scaffoldPlan = buildScaffoldPlan(selectedDefinition, className, targetDirectory);
    const fileConflicts = await getExistingFiles(scaffoldPlan.files);

    if (fileConflicts.length > 0) {
        const overwriteAction = await vscode.window.showWarningMessage(
            `Scaffold target already exists (${fileConflicts.length} file${fileConflicts.length === 1 ? '' : 's'}). Overwrite?`,
            { modal: true },
            'Overwrite'
        );

        if (overwriteAction !== 'Overwrite') {
            return;
        }
    }

    try {
        await ensureParentDirectories(scaffoldPlan.files);

        for (const filePlan of scaffoldPlan.files) {
            const templateContent = await loadTemplate(filePlan.templateFile, context, workspaceFolder);
            const output = applyTemplate(templateContent, variables);
            await vscode.workspace.fs.writeFile(filePlan.target, new TextEncoder().encode(output));
        }

        const document = await vscode.workspace.openTextDocument(scaffoldPlan.mainFile);
        await vscode.window.showTextDocument(document, { preview: false });

        vscode.window.showInformationMessage(`Created ${selectedDefinition.label} scaffold: ${className}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to scaffold ${selectedDefinition.label}: ${message}`);
    }
}

async function resolveTemplateRoot(workspaceFolder?: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
    const configPath = await readTemplatePathSetting(workspaceFolder);
    if (!configPath) {
        return undefined;
    }

    if (path.isAbsolute(configPath)) {
        return vscode.Uri.file(configPath);
    }

    const baseFolder = workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    if (!baseFolder) {
        return undefined;
    }

    return vscode.Uri.joinPath(baseFolder.uri, configPath);
}

async function readTemplatePathSetting(workspaceFolder?: vscode.WorkspaceFolder): Promise<string | undefined> {
    if (workspaceFolder) {
        try {
            const config = await readGluarcConfig(workspaceFolder);
            const gmod = config.gmod;
            if (gmod && typeof gmod === 'object' && 'templatePath' in gmod) {
                const templatePath = (gmod as { templatePath?: unknown }).templatePath;
                if (typeof templatePath === 'string' && templatePath.trim().length > 0) {
                    return templatePath.trim();
                }
            }
        } catch {
            // Error already surfaced by readGluarcConfig.
        }
    }

    const templatePathSetting = (vscode.workspace
        .getConfiguration('gluals.gmod', workspaceFolder?.uri)
        .get<string | null>('templatePath', null) ?? '')
        .trim();

    return templatePathSetting.length > 0 ? templatePathSetting : undefined;
}

async function getOfferedDefinitions(treeItem: unknown): Promise<ScaffoldDefinition[]> {
    const result = await fetchLsScriptedClassesResult();
    const definitions = result.definitions.filter(isScaffoldDefinition);
    const scopedDefinition = getDefinitionFromTreeContext(treeItem, definitions);
    if (scopedDefinition) {
        return [scopedDefinition];
    }

    return definitions;
}

function isScaffoldDefinition(definition: LsScriptedClassDefinition): definition is ScaffoldDefinition {
    return hasScaffoldFiles(definition);
}

function getDefinitionFromTreeContext(treeItem: unknown, definitions: ScaffoldDefinition[]): ScaffoldDefinition | undefined {
    const data = getTreeItemData(treeItem);
    const definitionId = typeof data?.definitionId === 'string' ? data.definitionId : undefined;
    if (!definitionId) {
        return undefined;
    }

    return definitions.find((definition) => definition.id === definitionId);
}

function getTreeItemData(treeItem: unknown): ScaffoldingTreeItemData | undefined {
    if (!treeItem || treeItem instanceof vscode.Uri) {
        return undefined;
    }

    if (typeof treeItem === 'object' && 'data' in treeItem) {
        return (treeItem as ScaffoldingTreeItemLike).data;
    }

    return undefined;
}

async function pickScaffoldDefinition(definitions: ScaffoldDefinition[]): Promise<ScaffoldDefinition | undefined> {
    if (definitions.length === 1) {
        return definitions[0];
    }

    const picks: ScaffoldTypePick[] = definitions.map((definition) => ({
        label: definition.classGlobal ? `${definition.label} (${definition.classGlobal})` : definition.label,
        description: definition.rootDir,
        detail: definition.scaffold.files.map((file) => file.path).join(', '),
        definition,
    }));

    const selected = await vscode.window.showQuickPick(picks, {
        title: 'New Scripted Class',
        placeHolder: 'Select what to scaffold',
        ignoreFocusOut: true,
    });

    return selected?.definition;
}

async function promptClassName(label: string): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: 'Class Name',
        prompt: `Enter the ${label} class name`,
        placeHolder: 'my_class_name',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Class name is required.';
            }

            if (!CLASS_NAME_PATTERN.test(value.trim())) {
                return 'Use only letters, numbers, and underscore (no spaces).';
            }

            return undefined;
        },
    });

    return input?.trim();
}

async function resolveTargetDirectory(
    treeItem: unknown,
    definition: ScaffoldDefinition,
    workspaceFolder?: vscode.WorkspaceFolder,
): Promise<vscode.Uri | undefined> {
    const contextUri = extractContextUri(treeItem);
    const defaultRoot = workspaceFolder
        ? vscode.Uri.joinPath(workspaceFolder.uri, ...definition.rootDir.split(/[\\/]+/).filter(Boolean))
        : undefined;

    if (contextUri) {
        const contextDirectory = await toDirectoryUri(contextUri);
        if (!defaultRoot || !workspaceFolder) {
            return contextDirectory;
        }

        if (isSameOrDescendant(contextDirectory, defaultRoot)) {
            return contextDirectory;
        }

        if (isSameOrDescendant(defaultRoot, contextDirectory)) {
            return defaultRoot;
        }

        if (isGenericWorkspaceScaffoldTarget(contextDirectory, workspaceFolder.uri)) {
            return defaultRoot;
        }

        return contextDirectory;
    }

    if (defaultRoot) {
        return defaultRoot;
    }

    const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select target folder for scaffold',
    });

    return selected?.[0];
}

function isSameOrDescendant(target: vscode.Uri, parent: vscode.Uri): boolean {
    const normalizedTarget = normalizeUriPath(target);
    const normalizedParent = normalizeUriPath(parent);
    return normalizedTarget === normalizedParent || normalizedTarget.startsWith(`${normalizedParent}/`);
}

function normalizeUriPath(uri: vscode.Uri): string {
    const pathValue = uri.scheme === 'file' ? uri.fsPath : uri.path;
    return pathValue.replace(/\\/g, '/').replace(/\/+$|^$/g, '').toLowerCase();
}

function isGenericWorkspaceScaffoldTarget(target: vscode.Uri, workspaceRoot: vscode.Uri): boolean {
    if (!isSameOrDescendant(target, workspaceRoot)) {
        return false;
    }

    const normalizedTarget = normalizeUriPath(target);
    const normalizedWorkspace = normalizeUriPath(workspaceRoot);
    if (normalizedTarget === normalizedWorkspace) {
        return true;
    }

    return normalizedTarget === `${normalizedWorkspace}/lua`;
}

function extractContextUri(treeItem: unknown): vscode.Uri | undefined {
    if (treeItem instanceof vscode.Uri) {
        return treeItem;
    }

    if (!treeItem || typeof treeItem !== 'object') {
        return undefined;
    }

    const typed = treeItem as ScaffoldingTreeItemLike;

    if (typed.data?.uri) {
        return typed.data.uri;
    }

    if (typed.uri) {
        return typed.uri;
    }

    if (typed.resourceUri) {
        return typed.resourceUri;
    }

    return undefined;
}

async function toDirectoryUri(uri: vscode.Uri): Promise<vscode.Uri> {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
        return uri;
    }

    if (uri.scheme === 'file') {
        return vscode.Uri.file(path.dirname(uri.fsPath));
    }

    return vscode.Uri.joinPath(uri, '..');
}

async function resolveWorkspaceFolder(treeItem: unknown): Promise<vscode.WorkspaceFolder | undefined> {
    const contextUri = extractContextUri(treeItem);
    if (contextUri) {
        const matching = vscode.workspace.getWorkspaceFolder(contextUri);
        if (matching) {
            return matching;
        }
    }

    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    if (activeEditorUri) {
        const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
        if (activeFolder) {
            return activeFolder;
        }
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) {
        return folders[0];
    }

    if (folders.length > 1) {
        return vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Select workspace folder for new scaffold',
            ignoreFocusOut: true,
        });
    }

    return undefined;
}

function buildScaffoldPlan(definition: ScaffoldDefinition, className: string, targetDirectory: vscode.Uri): ScaffoldPlan {
    const files = definition.scaffold.files.map((filePlan) => ({
        target: resolveScaffoldTarget(targetDirectory, className, filePlan),
        templateFile: filePlan.template,
    }));

    if (files.length === 0) {
        throw new Error(`No scaffold files configured for ${definition.label}`);
    }

    return {
        files,
        mainFile: files[0].target,
    };
}

function resolveScaffoldTarget(
    targetDirectory: vscode.Uri,
    className: string,
    filePlan: LsScriptedClassScaffoldFile,
): vscode.Uri {
    const normalizedPath = filePlan.path.replace(/{{\s*name\s*}}/g, className);
    const segments = normalizedPath.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0) {
        throw new Error(`Invalid scaffold output path: ${filePlan.path}`);
    }

    return vscode.Uri.joinPath(targetDirectory, ...segments);
}

async function getExistingFiles(files: readonly ScaffoldFilePlan[]): Promise<vscode.Uri[]> {
    const existing: vscode.Uri[] = [];

    for (const filePlan of files) {
        if (await pathExists(filePlan.target)) {
            existing.push(filePlan.target);
        }
    }

    return existing;
}

async function ensureParentDirectories(files: readonly ScaffoldFilePlan[]): Promise<void> {
    const parentPaths = new Set<string>();

    for (const filePlan of files) {
        const parent = vscode.Uri.joinPath(filePlan.target, '..');
        parentPaths.add(parent.toString());
    }

    for (const parentPath of parentPaths) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.parse(parentPath));
    }
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
}

async function getAuthorName(targetDirectory: vscode.Uri): Promise<string> {
    const cwd = targetDirectory.fsPath;

    try {
        const result = await execFileAsync('git', ['config', 'user.name'], {
            cwd,
            windowsHide: true,
        });

        return result.stdout.trim();
    } catch {
        return '';
    }
}
