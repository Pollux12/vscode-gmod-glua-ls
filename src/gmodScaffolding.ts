import * as path from 'path';
import { execFile } from 'child_process';
import { promisify, TextEncoder } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
const CLASS_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export type ScriptedClassType = 'entities' | 'weapons' | 'effects' | 'stools' | 'plugins';
export type ScaffoldKind = 'entity' | 'swep' | 'effect' | 'stool' | 'plugin';

export interface ScaffoldingTreeItemData {
    type?: string;
    scType?: ScriptedClassType | string;
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

interface ScaffoldTypePick {
    readonly label: string;
    readonly description: string;
    readonly scaffoldKind: ScaffoldKind;
}

const TYPE_PICKS: readonly ScaffoldTypePick[] = [
    { label: 'Entity (ENT)', description: 'Creates shared/init/cl_init files', scaffoldKind: 'entity' },
    { label: 'Weapon (SWEP)', description: 'Creates a shared.lua file in a class folder', scaffoldKind: 'swep' },
    { label: 'Effect', description: 'Creates a single effect Lua file', scaffoldKind: 'effect' },
    { label: 'STool', description: 'Creates a single stool Lua file', scaffoldKind: 'stool' },
    { label: 'Plugin', description: 'Creates sh_plugin/sv_plugin/cl_plugin files', scaffoldKind: 'plugin' },
];

const TEMPLATE_NAMES: Record<ScaffoldKind, string[]> = {
    entity: ['ent_shared.lua', 'ent_init.lua', 'ent_cl_init.lua'],
    swep: ['swep_shared.lua'],
    effect: ['effect.lua'],
    stool: ['tool.lua'],
    plugin: ['plugin_sh.lua', 'plugin_sv.lua', 'plugin_cl.lua'],
};

const CLASS_GLOBAL_NAME: Record<ScaffoldKind, string> = {
    entity: 'ENT',
    swep: 'SWEP',
    effect: 'EFFECT',
    stool: 'TOOL',
    plugin: 'PLUGIN',
};

const DEFAULT_TYPE_DIR: Record<ScaffoldKind, string> = {
    entity: path.join('lua', 'entities'),
    swep: path.join('lua', 'weapons'),
    effect: path.join('lua', 'effects'),
    stool: path.join('lua', 'weapons', 'gmod_tool', 'stools'),
    plugin: 'plugins',
};

export function applyTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => vars[key] ?? '');
}

export async function loadTemplate(templateFile: string, context: vscode.ExtensionContext): Promise<string> {
    const templatePathSetting = vscode.workspace
        .getConfiguration('gluals.gmod')
        .get<string>('templatePath', '')
        .trim();

    if (templatePathSetting.length > 0) {
        const customRoot = resolveTemplateRoot(templatePathSetting);
        if (customRoot) {
            const customTemplateUri = vscode.Uri.joinPath(customRoot, templateFile);
            if (await pathExists(customTemplateUri)) {
                return readTextFile(customTemplateUri);
            }
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
    const offeredKinds = getOfferedKinds(treeItem);
    const selectedKind = await pickScaffoldKind(offeredKinds);
    if (!selectedKind) {
        return;
    }

    const className = await promptClassName(selectedKind);
    if (!className) {
        return;
    }

    const targetDirectory = await resolveTargetDirectory(treeItem, selectedKind);
    if (!targetDirectory) {
        return;
    }

    const existingAuthor = await getAuthorName(targetDirectory);
    const variables: Record<string, string> = {
        name: className,
        class: CLASS_GLOBAL_NAME[selectedKind],
        date: new Date().toISOString().split('T')[0],
        author: existingAuthor,
    };

    const scaffoldPlan = buildScaffoldPlan(selectedKind, className, targetDirectory);
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
            const templateContent = await loadTemplate(filePlan.templateFile, context);
            const output = applyTemplate(templateContent, variables);
            await vscode.workspace.fs.writeFile(filePlan.target, new TextEncoder().encode(output));
        }

        const document = await vscode.workspace.openTextDocument(scaffoldPlan.mainFile);
        await vscode.window.showTextDocument(document, { preview: false });

        vscode.window.showInformationMessage(`Created ${selectedKind} scaffold: ${className}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to scaffold ${selectedKind}: ${message}`);
    }
}

function resolveTemplateRoot(configPath: string): vscode.Uri | undefined {
    if (path.isAbsolute(configPath)) {
        return vscode.Uri.file(configPath);
    }

    const firstWorkspace = vscode.workspace.workspaceFolders?.[0];
    if (!firstWorkspace) {
        return undefined;
    }

    return vscode.Uri.joinPath(firstWorkspace.uri, configPath);
}

function getOfferedKinds(treeItem: unknown): ScaffoldKind[] {
    const scopedKind = getKindFromTreeContext(treeItem);
    if (scopedKind) {
        return [scopedKind];
    }

    return TYPE_PICKS.map((pick) => pick.scaffoldKind);
}

function getKindFromTreeContext(treeItem: unknown): ScaffoldKind | undefined {
    const data = getTreeItemData(treeItem);
    const contextValue = getContextValue(treeItem);

    if ((contextValue === 'scriptedClassType' || contextValue === 'scriptedClass') && data?.scType) {
        return mapScriptedClassTypeToKind(data.scType);
    }

    if (data?.type === 'scriptedClassType' || data?.type === 'scriptedClass') {
        return mapScriptedClassTypeToKind(data.scType);
    }

    if (typeof data?.scType === 'string') {
        return mapScriptedClassTypeToKind(data.scType);
    }

    return undefined;
}

function getTreeItemData(treeItem: unknown): ScaffoldingTreeItemData | undefined {
    if (!treeItem || treeItem instanceof vscode.Uri) {
        return undefined;
    }

    if (typeof treeItem === 'object' && 'data' in treeItem) {
        const data = (treeItem as ScaffoldingTreeItemLike).data;
        return data;
    }

    return undefined;
}

function getContextValue(treeItem: unknown): string | undefined {
    if (!treeItem || treeItem instanceof vscode.Uri) {
        return undefined;
    }

    if (typeof treeItem === 'object' && 'contextValue' in treeItem) {
        const contextValue = (treeItem as ScaffoldingTreeItemLike).contextValue;
        return typeof contextValue === 'string' ? contextValue : undefined;
    }

    return undefined;
}

function mapScriptedClassTypeToKind(scriptedClassType: string | undefined): ScaffoldKind | undefined {
    switch (scriptedClassType) {
        case 'entities':
        case 'entity':
            return 'entity';
        case 'weapons':
        case 'weapon':
        case 'swep':
            return 'swep';
        case 'effects':
        case 'effect':
            return 'effect';
        case 'stools':
        case 'stool':
        case 'tool':
            return 'stool';
        case 'plugins':
        case 'plugin':
            return 'plugin';
        default:
            return undefined;
    }
}

async function pickScaffoldKind(offeredKinds: ScaffoldKind[]): Promise<ScaffoldKind | undefined> {
    if (offeredKinds.length === 1) {
        return offeredKinds[0];
    }

    const offeredSet = new Set(offeredKinds);
    const picks = TYPE_PICKS.filter((pick) => offeredSet.has(pick.scaffoldKind));
    const selected = await vscode.window.showQuickPick(picks, {
        title: 'New Scripted Class',
        placeHolder: 'Select what to scaffold',
        ignoreFocusOut: true,
    });

    return selected?.scaffoldKind;
}

async function promptClassName(kind: ScaffoldKind): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: 'Class Name',
        prompt: `Enter the ${kind} class name`,
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

    if (!input) {
        return undefined;
    }

    return input.trim();
}

async function resolveTargetDirectory(
    treeItem: unknown,
    kind: ScaffoldKind
): Promise<vscode.Uri | undefined> {
    const contextUri = extractContextUri(treeItem);
    if (contextUri) {
        return toDirectoryUri(contextUri);
    }

    const workspaceFolder = await resolveWorkspaceFolder(treeItem);
    if (workspaceFolder) {
        return vscode.Uri.joinPath(workspaceFolder.uri, DEFAULT_TYPE_DIR[kind]);
    }

    const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select target folder for scaffold',
    });

    return selected?.[0];
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

function buildScaffoldPlan(kind: ScaffoldKind, className: string, targetDirectory: vscode.Uri): ScaffoldPlan {
    switch (kind) {
        case 'entity': {
            const classFolder = vscode.Uri.joinPath(targetDirectory, className);
            const shared = vscode.Uri.joinPath(classFolder, 'shared.lua');
            const init = vscode.Uri.joinPath(classFolder, 'init.lua');
            const clInit = vscode.Uri.joinPath(classFolder, 'cl_init.lua');
            return {
                files: [
                    { target: shared, templateFile: TEMPLATE_NAMES.entity[0] },
                    { target: init, templateFile: TEMPLATE_NAMES.entity[1] },
                    { target: clInit, templateFile: TEMPLATE_NAMES.entity[2] },
                ],
                mainFile: shared,
            };
        }
        case 'swep': {
            const classFolder = vscode.Uri.joinPath(targetDirectory, className);
            const shared = vscode.Uri.joinPath(classFolder, 'shared.lua');
            return {
                files: [{ target: shared, templateFile: TEMPLATE_NAMES.swep[0] }],
                mainFile: shared,
            };
        }
        case 'effect': {
            const file = vscode.Uri.joinPath(targetDirectory, `${className}.lua`);
            return {
                files: [{ target: file, templateFile: TEMPLATE_NAMES.effect[0] }],
                mainFile: file,
            };
        }
        case 'stool': {
            const file = vscode.Uri.joinPath(targetDirectory, `${className}.lua`);
            return {
                files: [{ target: file, templateFile: TEMPLATE_NAMES.stool[0] }],
                mainFile: file,
            };
        }
        case 'plugin': {
            const classFolder = vscode.Uri.joinPath(targetDirectory, className);
            const shPlugin = vscode.Uri.joinPath(classFolder, 'sh_plugin.lua');
            const svPlugin = vscode.Uri.joinPath(classFolder, 'sv_plugin.lua');
            const clPlugin = vscode.Uri.joinPath(classFolder, 'cl_plugin.lua');
            return {
                files: [
                    { target: shPlugin, templateFile: TEMPLATE_NAMES.plugin[0] },
                    { target: svPlugin, templateFile: TEMPLATE_NAMES.plugin[1] },
                    { target: clPlugin, templateFile: TEMPLATE_NAMES.plugin[2] },
                ],
                mainFile: shPlugin,
            };
        }
        default: {
            const exhaustiveCheck: never = kind;
            throw new Error(`Unsupported scaffold type: ${String(exhaustiveCheck)}`);
        }
    }
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
    } catch (error) {
        if (error instanceof vscode.FileSystemError) {
            return false;
        }
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

        const name = result.stdout.trim();
        return name;
    } catch {
        return '';
    }
}
