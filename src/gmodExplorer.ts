import * as path from 'path';
import * as vscode from 'vscode';
import { extensionContext } from './extension';

type ScriptedClassType = 'entities' | 'weapons' | 'effects' | 'stools' | 'plugins';
type ResourceCategory = 'models' | 'materials' | 'sounds' | 'other';
type GmodExplorerItemType =
    | 'category'
    | 'scriptedClassType'
    | 'scriptedClass'
    | 'resourceCategory'
    | 'resourceGroup'
    | 'file';

interface ItemData {
    type: GmodExplorerItemType;
    label: string;
    collapsible: vscode.TreeItemCollapsibleState;
    // scriptedClassType
    scType?: ScriptedClassType;
    // scriptedClass
    className?: string;
    // resourceCategory
    rcType?: ResourceCategory;
    // resourceGroup
    groupKey?: string;
    // file
    uri?: vscode.Uri;
}

interface LsScriptedClassEntry {
    uri: string;
    classType: string;
    className: string;
}

function mapLsClassTypeToScriptedClassType(classType: string): ScriptedClassType | undefined {
    switch (classType) {
        case 'ENT':
            return 'entities';
        case 'SWEP':
            return 'weapons';
        case 'EFFECT':
            return 'effects';
        case 'TOOL':
            return 'stools';
        case 'PLUGIN':
            return 'plugins';
        default:
            return undefined;
    }
}

function parseLsUri(uri: string): vscode.Uri | undefined {
    try {
        return vscode.Uri.parse(uri);
    } catch {
        return undefined;
    }
}

async function fetchLsScriptedClasses(): Promise<LsScriptedClassEntry[]> {
    const client = extensionContext?.client;
    if (!client) {
        return [];
    }

    try {
        const result = await client.sendRequest<LsScriptedClassEntry[] | null>('gluals/gmodScriptedClasses', {});
        return result ?? [];
    } catch (error) {
        console.warn('Failed to fetch scripted classes from language server:', error);
        return [];
    }
}

class GmodExplorerItem extends vscode.TreeItem {
    constructor(public readonly data: ItemData) {
        super(data.label, data.collapsible);
        this.contextValue = data.type;
        this.configure();
    }

    private configure(): void {
        const d = this.data;
        switch (d.type) {
            case 'category':
                this.iconPath = new vscode.ThemeIcon('list-tree');
                break;
            case 'scriptedClassType':
                this.iconPath = d.scType === 'plugins' ? new vscode.ThemeIcon('extensions') : new vscode.ThemeIcon('folder-library');
                break;
            case 'scriptedClass':
                this.iconPath = d.scType === 'plugins' ? new vscode.ThemeIcon('extensions') : new vscode.ThemeIcon('symbol-class');
                break;
            case 'resourceCategory':
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
            case 'resourceGroup':
                this.iconPath = new vscode.ThemeIcon('folder-opened');
                break;
            case 'file':
                if (d.uri) {
                    const ext = path.extname(d.uri.fsPath).toLowerCase();
                    const isCode = ['.lua', '.txt', '.cfg'].includes(ext);
                    this.iconPath = new vscode.ThemeIcon(isCode ? 'file-code' : 'file-binary');
                    this.resourceUri = d.uri;
                    const workspaceFolder = vscode.workspace.getWorkspaceFolder(d.uri);
                    if (workspaceFolder) {
                        this.description = path.relative(workspaceFolder.uri.fsPath, d.uri.fsPath);
                    }
                    this.command = { command: 'vscode.open', title: 'Open File', arguments: [d.uri] };
                }
                break;
        }
    }
}

// Extract class name for scripted class types.
// Handles both multi-file folders and single-file classes by finding the
// innermost matching type directory segment.
function extractClassName(uri: vscode.Uri, scType: ScriptedClassType): string | undefined {
    const parts = uri.fsPath.replace(/\\/g, '/').split('/');
    const idx = parts.lastIndexOf(scType);
    if (idx < 0 || idx + 1 >= parts.length) {
        return undefined;
    }

    const next = parts[idx + 1];
    if (!next) {
        return undefined;
    }

    // Extra safety so an unexpected gmod_tool file never appears as a SWEP class.
    if (scType === 'weapons' && next === 'gmod_tool') {
        return undefined;
    }

    if (next.toLowerCase().endsWith('.lua')) {
        const className = next.slice(0, -4);
        return className.length > 0 ? className : undefined;
    }

    return next;
}

// Extract the first subdirectory relative to the resource category folder.
// Returns '' for files residing directly in the category folder.
function extractResourceGroup(uri: vscode.Uri, rcType: ResourceCategory): string {
    const folderName = rcType === 'sounds' ? 'sound' : rcType === 'other' ? 'resource' : rcType;
    const parts = uri.fsPath.replace(/\\/g, '/').split('/');
    const idx = parts.lastIndexOf(folderName);
    if (idx < 0 || idx + 2 > parts.length - 1) {
        return '';
    }
    return parts[idx + 1];
}

export class GmodExplorerProvider implements vscode.TreeDataProvider<GmodExplorerItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GmodExplorerItem | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    private scriptedClassCache?: Map<ScriptedClassType, Map<string, vscode.Uri[]>>;
    private resourceCache?: Map<ResourceCategory, Map<string, vscode.Uri[]>>;

    refresh(): void {
        this.scriptedClassCache = undefined;
        this.resourceCache = undefined;
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: GmodExplorerItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: GmodExplorerItem): Promise<GmodExplorerItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [];
        }

        if (!element) {
            return [
                new GmodExplorerItem({ type: 'category', label: 'Scripted Classes', collapsible: vscode.TreeItemCollapsibleState.Expanded }),
                new GmodExplorerItem({ type: 'category', label: 'Resources', collapsible: vscode.TreeItemCollapsibleState.Collapsed }),
            ];
        }

        const d = element.data;

        if (d.type === 'category') {
            switch (d.label) {
                case 'Scripted Classes':
                    return [
                        new GmodExplorerItem({ type: 'scriptedClassType', label: 'Entities', collapsible: vscode.TreeItemCollapsibleState.Collapsed, scType: 'entities' }),
                        new GmodExplorerItem({ type: 'scriptedClassType', label: 'SWEPs', collapsible: vscode.TreeItemCollapsibleState.Collapsed, scType: 'weapons' }),
                        new GmodExplorerItem({ type: 'scriptedClassType', label: 'Effects', collapsible: vscode.TreeItemCollapsibleState.Collapsed, scType: 'effects' }),
                        new GmodExplorerItem({ type: 'scriptedClassType', label: 'Plugins', collapsible: vscode.TreeItemCollapsibleState.Collapsed, scType: 'plugins' }),
                    ];
                case 'Resources':
                    return [
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Models', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'models' }),
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Materials', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'materials' }),
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Sounds', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'sounds' }),
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Other', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'other' }),
                    ];
            }
        }

        if (d.type === 'scriptedClassType' && d.scType) {
            const cache = await this.getScriptedClassCache();
            const classMap = cache.get(d.scType) ?? new Map<string, vscode.Uri[]>();
            const classItems = [...classMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([className]) =>
                new GmodExplorerItem({
                    type: 'scriptedClass',
                    label: className,
                    collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                    scType: d.scType,
                    className,
                })
            );

            if (d.scType === 'weapons') {
                classItems.push(new GmodExplorerItem({
                    type: 'scriptedClassType',
                    label: 'STools',
                    collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                    scType: 'stools',
                }));
            }

            return classItems;
        }

        if (d.type === 'scriptedClass' && d.scType && d.className) {
            const cache = await this.getScriptedClassCache();
            const files = cache.get(d.scType)?.get(d.className) ?? [];
            return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath)).map((uri) =>
                new GmodExplorerItem({ type: 'file', label: path.basename(uri.fsPath), collapsible: vscode.TreeItemCollapsibleState.None, uri })
            );
        }

        if (d.type === 'resourceCategory' && d.rcType) {
            const cache = await this.getResourceCache();
            const groupMap = cache.get(d.rcType) ?? new Map<string, vscode.Uri[]>();
            const items: GmodExplorerItem[] = [];
            // Files directly in category root (groupKey = '') shown as direct file children
            const rootFiles = groupMap.get('') ?? [];
            for (const uri of rootFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
                items.push(new GmodExplorerItem({ type: 'file', label: path.basename(uri.fsPath), collapsible: vscode.TreeItemCollapsibleState.None, uri }));
            }
            // Subdirectory groups
            for (const [groupKey, files] of [...groupMap.entries()].filter(([k]) => k !== '').sort((a, b) => a[0].localeCompare(b[0]))) {
                items.push(new GmodExplorerItem({
                    type: 'resourceGroup',
                    label: `${groupKey} (${files.length})`,
                    collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                    rcType: d.rcType,
                    groupKey,
                }));
            }
            return items;
        }

        if (d.type === 'resourceGroup' && d.rcType && d.groupKey !== undefined) {
            const cache = await this.getResourceCache();
            const files = cache.get(d.rcType)?.get(d.groupKey) ?? [];
            return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath)).map((uri) =>
                new GmodExplorerItem({ type: 'file', label: path.basename(uri.fsPath), collapsible: vscode.TreeItemCollapsibleState.None, uri })
            );
        }

        return [];
    }

    private async getScriptedClassCache(): Promise<Map<ScriptedClassType, Map<string, vscode.Uri[]>>> {
        if (this.scriptedClassCache) {
            return this.scriptedClassCache;
        }

        const cache = new Map<ScriptedClassType, Map<string, vscode.Uri[]>>();
        const LIMIT = 500;

        const scanType = async (scType: ScriptedClassType, pattern: string, exclude?: string) => {
            const files = await vscode.workspace.findFiles(pattern, exclude ?? '**/node_modules/**', LIMIT);
            const classMap = new Map<string, vscode.Uri[]>();
            for (const uri of files) {
                const className = extractClassName(uri, scType);
                if (className) {
                    const existing = classMap.get(className) ?? [];
                    existing.push(uri);
                    classMap.set(className, existing);
                }
            }
            cache.set(scType, classMap);
        };

        await Promise.all([
            scanType('entities', '{**/entities/*/*.lua,**/entities/*.lua}', '{**/node_modules/**,**/effects/**,**/weapons/**}'),
            scanType('weapons', '{**/weapons/*/*.lua,**/weapons/*.lua}', '{**/node_modules/**,**/gmod_tool/**}'),
            scanType('effects', '{**/effects/*/*.lua,**/effects/*.lua}', '**/node_modules/**'),
            scanType('stools', '{**/stools/*/*.lua,**/stools/*.lua}', '**/node_modules/**'),
            scanType('plugins', '{**/plugins/*/*.lua,**/plugins/*.lua}', '**/node_modules/**'),
        ]);

        // Glob scan remains authoritative; LS entries only fill in classes missed by globs.
        const lsEntries = await fetchLsScriptedClasses();
        for (const lsEntry of lsEntries) {
            const scriptedClassType = mapLsClassTypeToScriptedClassType(lsEntry.classType);
            if (!scriptedClassType || !lsEntry.className) {
                continue;
            }

            const classMap = cache.get(scriptedClassType) ?? new Map<string, vscode.Uri[]>();
            if (classMap.has(lsEntry.className)) {
                continue;
            }

            const uri = parseLsUri(lsEntry.uri);
            classMap.set(lsEntry.className, uri ? [uri] : []);
            cache.set(scriptedClassType, classMap);
        }

        this.scriptedClassCache = cache;
        return cache;
    }

    private async getResourceCache(): Promise<Map<ResourceCategory, Map<string, vscode.Uri[]>>> {
        if (this.resourceCache) {
            return this.resourceCache;
        }

        const cache = new Map<ResourceCategory, Map<string, vscode.Uri[]>>();
        const LIMIT = 500;

        const patterns: [ResourceCategory, string][] = [
            ['models', '**/models/**/*'],
            ['materials', '**/materials/**/*'],
            ['sounds', '**/sound/**/*'],
            ['other', '**/resource/**/*'],
        ];

        await Promise.all(patterns.map(async ([rcType, pattern]) => {
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', LIMIT);
            const groupMap = new Map<string, vscode.Uri[]>();
            for (const uri of files) {
                const groupKey = extractResourceGroup(uri, rcType);
                const existing = groupMap.get(groupKey) ?? [];
                existing.push(uri);
                groupMap.set(groupKey, existing);
            }
            cache.set(rcType, groupMap);
        }));

        this.resourceCache = cache;
        return cache;
    }

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }
}

export function registerGmodExplorer(context: vscode.ExtensionContext): GmodExplorerProvider {
    const provider = new GmodExplorerProvider();
    const treeView = vscode.window.createTreeView('gluals.gmodExplorer', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    context.subscriptions.push(provider, treeView);
    return provider;
}
