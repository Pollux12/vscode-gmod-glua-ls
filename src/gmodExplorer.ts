import * as path from 'path';
import * as vscode from 'vscode';
import { extensionContext } from './extension';
import {
    isExpectedLifecycleRequestError,
    sendRequestWithStartupRetry,
} from './languageServerRequests';

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
    definitionId?: string;
    classGlobal?: string;
    className?: string;
    startLine?: number;
    startCharacter?: number;
    hasScaffold?: boolean;
    icon?: string;
    rcType?: ResourceCategory;
    groupKey?: string;
    uri?: vscode.Uri;
}

interface LsPosition {
    line: number;
    character: number;
}

interface LsRange {
    start: LsPosition;
    end: LsPosition;
}

export interface LsScriptedClassScaffoldFile {
    path: string;
    template: string;
}

export interface LsScriptedClassScaffold {
    files: LsScriptedClassScaffoldFile[];
}

export interface LsScriptedClassDefinition {
    id: string;
    label: string;
    path: string[];
    include: string[];
    exclude: string[];
    classGlobal: string;
    parentId?: string;
    icon?: string;
    rootDir: string;
    scaffold?: LsScriptedClassScaffold;
}

export interface LsScriptedClassEntry {
    uri: string;
    classType: string;
    className: string;
    definitionId?: string;
    range?: LsRange | null;
}

export interface LsScriptedClassesResult {
    definitions: LsScriptedClassDefinition[];
    entries: LsScriptedClassEntry[];
}

const LEGACY_SCRIPTED_CLASS_DEFINITIONS: LsScriptedClassDefinition[] = [
    {
        id: 'entities',
        label: 'Entities',
        path: ['entities'],
        include: ['entities/**'],
        exclude: [],
        classGlobal: 'ENT',
        icon: 'folder-library',
        rootDir: 'lua/entities',
        scaffold: {
            files: [
                { path: '{{name}}/shared.lua', template: 'ent_shared.lua' },
                { path: '{{name}}/init.lua', template: 'ent_init.lua' },
                { path: '{{name}}/cl_init.lua', template: 'ent_cl_init.lua' },
            ],
        },
    },
    {
        id: 'weapons',
        label: 'SWEPs',
        path: ['weapons'],
        include: ['weapons/**'],
        exclude: ['weapons/gmod_tool/**'],
        classGlobal: 'SWEP',
        icon: 'folder-library',
        rootDir: 'lua/weapons',
        scaffold: {
            files: [{ path: '{{name}}/shared.lua', template: 'swep_shared.lua' }],
        },
    },
    {
        id: 'effects',
        label: 'Effects',
        path: ['effects'],
        include: ['effects/**'],
        exclude: [],
        classGlobal: 'EFFECT',
        icon: 'folder-library',
        rootDir: 'lua/effects',
        scaffold: {
            files: [{ path: '{{name}}.lua', template: 'effect.lua' }],
        },
    },
    {
        id: 'stools',
        label: 'STools',
        path: ['weapons', 'gmod_tool', 'stools'],
        include: ['weapons/gmod_tool/stools/**'],
        exclude: [],
        classGlobal: 'TOOL',
        parentId: 'weapons',
        icon: 'tools',
        rootDir: 'lua/weapons/gmod_tool/stools',
        scaffold: {
            files: [{ path: '{{name}}.lua', template: 'tool.lua' }],
        },
    },
    {
        id: 'plugins',
        label: 'Plugins',
        path: ['plugins'],
        include: ['plugins/**'],
        exclude: [],
        classGlobal: 'PLUGIN',
        icon: 'extensions',
        rootDir: 'plugins',
    },
];

const LEGACY_DEFINITION_ID_BY_CLASS_TYPE = new Map<string, string>(
    LEGACY_SCRIPTED_CLASS_DEFINITIONS.map((definition) => [definition.classGlobal, definition.id]),
);

interface ScriptedClassFileEntry {
    uri: vscode.Uri;
    startLine?: number;
    startCharacter?: number;
}

interface ScriptedClassCache {
    definitions: Map<string, LsScriptedClassDefinition>;
    childDefinitions: Map<string | undefined, LsScriptedClassDefinition[]>;
    classMaps: Map<string, Map<string, ScriptedClassFileEntry[]>>;
    vguiClassMap: Map<string, ScriptedClassFileEntry[]>;
}

const STARTUP_REFRESH_DELAY_MS = 1000;

let registeredGmodExplorerProvider: GmodExplorerProvider | undefined;
let pendingStartupRefresh: NodeJS.Timeout | undefined;

function scheduleStartupRefresh(): void {
    if (pendingStartupRefresh) {
        return;
    }

    pendingStartupRefresh = setTimeout(() => {
        pendingStartupRefresh = undefined;
        registeredGmodExplorerProvider?.refresh();
    }, STARTUP_REFRESH_DELAY_MS);
}

function parseLsUri(uri: string): vscode.Uri | undefined {
    try {
        return vscode.Uri.parse(uri);
    } catch {
        return undefined;
    }
}

export async function fetchLsScriptedClassesResult(): Promise<LsScriptedClassesResult> {
    const client = extensionContext?.client;
    if (!client) {
        return withWorkspaceFallback({ definitions: [...LEGACY_SCRIPTED_CLASS_DEFINITIONS], entries: [] });
    }

    try {
        const result = await sendRequestWithStartupRetry<unknown>(
            client,
            'gluals/gmodScriptedClassesV2',
            {},
        );
        return withWorkspaceFallback(normalizeLsScriptedClassesResult(result));
    } catch (v2Error) {
        if (isExpectedLifecycleRequestError(v2Error)) {
            scheduleStartupRefresh();
            return withWorkspaceFallback({ definitions: [...LEGACY_SCRIPTED_CLASS_DEFINITIONS], entries: [] });
        }

        try {
            const legacyResult = await sendRequestWithStartupRetry<unknown>(
                client,
                'gluals/gmodScriptedClasses',
                {},
            );
            return withWorkspaceFallback(normalizeLsScriptedClassesResult(legacyResult));
        } catch (legacyError) {
            if (!isExpectedLifecycleRequestError(legacyError)) {
                console.warn('Failed to fetch scripted classes from language server:', v2Error, legacyError);
            }

            return withWorkspaceFallback({ definitions: [...LEGACY_SCRIPTED_CLASS_DEFINITIONS], entries: [] });
        }
    }
}

export async function fetchLsScriptedClasses(): Promise<LsScriptedClassEntry[]> {
    const result = await fetchLsScriptedClassesResult();
    return result.entries;
}

export function hasScaffoldFiles(definition: LsScriptedClassDefinition): definition is LsScriptedClassDefinition & { scaffold: LsScriptedClassScaffold } {
    const scaffoldFiles = definition.scaffold?.files;
    return Array.isArray(scaffoldFiles) && scaffoldFiles.length > 0;
}

function normalizeLsScriptedClassesResult(result: unknown): LsScriptedClassesResult {
    if (Array.isArray(result)) {
        return createLegacyCompatibleResult(result);
    }

    if (!result || typeof result !== 'object') {
        return { definitions: [...LEGACY_SCRIPTED_CLASS_DEFINITIONS], entries: [] };
    }

    const candidate = result as Partial<LsScriptedClassesResult>;
    const entries = Array.isArray(candidate.entries) ? candidate.entries.map(normalizeLsScriptedClassEntry) : [];
    let definitions = Array.isArray(candidate.definitions) ? candidate.definitions : [];
    if (definitions.length === 0 && entries.some((entry) => !!entry.definitionId)) {
        definitions = [...LEGACY_SCRIPTED_CLASS_DEFINITIONS];
    }

    return { definitions, entries };
}

function createLegacyCompatibleResult(entries: unknown[]): LsScriptedClassesResult {
    const normalizedEntries = entries.map(normalizeLsScriptedClassEntry);
    return { definitions: [...LEGACY_SCRIPTED_CLASS_DEFINITIONS], entries: normalizedEntries };
}

function normalizeLsScriptedClassEntry(entry: unknown): LsScriptedClassEntry {
    if (!entry || typeof entry !== 'object') {
        return { uri: '', classType: '', className: '' };
    }

    const typed = entry as Partial<LsScriptedClassEntry>;
    const classType = typeof typed.classType === 'string' ? typed.classType : '';
    const definitionId = typeof typed.definitionId === 'string'
        ? typed.definitionId
        : LEGACY_DEFINITION_ID_BY_CLASS_TYPE.get(classType);

    return {
        uri: typeof typed.uri === 'string' ? typed.uri : '',
        classType,
        className: typeof typed.className === 'string' ? typed.className : '',
        definitionId,
        range: typed.range ?? null,
    };
}

async function withWorkspaceFallback(result: LsScriptedClassesResult): Promise<LsScriptedClassesResult> {
    if (result.entries.length > 0 || result.definitions.length === 0) {
        return result;
    }

    const entries = await discoverScriptedClassEntriesFromWorkspace(result.definitions);
    return entries.length > 0 ? { definitions: result.definitions, entries } : result;
}

async function discoverScriptedClassEntriesFromWorkspace(
    definitions: readonly LsScriptedClassDefinition[],
): Promise<LsScriptedClassEntry[]> {
    const candidateUris = new Map<string, vscode.Uri>();

    for (const definition of definitions) {
        const includeGlob = toWorkspaceGlob(definition.include);
        if (!includeGlob) {
            continue;
        }

        const excludeGlob = toWorkspaceGlob(definition.exclude);
        const files = await vscode.workspace.findFiles(includeGlob, excludeGlob, 500);
        for (const file of files) {
            candidateUris.set(file.toString(), file);
        }
    }

    const entries: LsScriptedClassEntry[] = [];
    for (const uri of candidateUris.values()) {
        const match = detectScriptedClassForPath(uri.fsPath, definitions);
        if (!match) {
            continue;
        }

        entries.push({
            uri: uri.toString(),
            classType: match.definition.classGlobal,
            className: match.className,
            definitionId: match.definition.id,
            range: null,
        });
    }

    return entries;
}

function toWorkspaceGlob(patterns: readonly string[]): string | undefined {
    const normalized = patterns.filter((pattern) => typeof pattern === 'string' && pattern.trim().length > 0);
    if (normalized.length === 0) {
        return undefined;
    }

    return normalized.length === 1 ? normalized[0] : `{${normalized.join(',')}}`;
}

function detectScriptedClassForPath(
    filePath: string,
    definitions: readonly LsScriptedClassDefinition[],
): { definition: LsScriptedClassDefinition; className: string } | undefined {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const originalSegments = normalizedPath.split('/').filter(Boolean);
    const lowerSegments = originalSegments.map((segment) => segment.toLowerCase());
    let bestMatch: { definition: LsScriptedClassDefinition; endIdx: number; ruleLen: number } | undefined;

    for (const definition of definitions) {
        const ruleLen = definition.path.length;
        if (ruleLen === 0 || lowerSegments.length < ruleLen) {
            continue;
        }

        for (let startIdx = lowerSegments.length - ruleLen; startIdx >= 0; startIdx--) {
            let matched = true;
            for (let offset = 0; offset < ruleLen; offset++) {
                if (lowerSegments[startIdx + offset] !== definition.path[offset].toLowerCase()) {
                    matched = false;
                    break;
                }
            }

            if (!matched) {
                continue;
            }

            const endIdx = startIdx + ruleLen - 1;
            if (!bestMatch || endIdx > bestMatch.endIdx || (endIdx === bestMatch.endIdx && ruleLen > bestMatch.ruleLen)) {
                bestMatch = { definition, endIdx, ruleLen };
            }
            break;
        }
    }

    if (!bestMatch) {
        return undefined;
    }

    const classIdx = bestMatch.endIdx + 1;
    if (classIdx >= originalSegments.length) {
        return undefined;
    }

    const source = originalSegments[classIdx];
    const className = classIdx === originalSegments.length - 1
        ? source.replace(/\.lua$/i, '')
        : source;
    return className
        ? { definition: bestMatch.definition, className }
        : undefined;
}

function getScriptedClassTypeContextValue(item: ItemData): string {
    return item.hasScaffold ? 'scriptedClassTypeScaffoldable' : 'scriptedClassType';
}

function getDefinitionIcon(item: ItemData, fallback: string): vscode.ThemeIcon {
    if (item.icon) {
        return new vscode.ThemeIcon(item.icon);
    }

    if (item.classGlobal === 'VGUI') {
        return new vscode.ThemeIcon('window');
    }

    return new vscode.ThemeIcon(fallback);
}

export class GmodExplorerItem extends vscode.TreeItem {
    constructor(public readonly data: ItemData) {
        super(data.label, data.collapsible);
        this.contextValue = data.type === 'scriptedClassType'
            ? getScriptedClassTypeContextValue(data)
            : data.type;
        this.configure();
    }

    private configure(): void {
        const d = this.data;
        switch (d.type) {
            case 'category':
                this.iconPath = new vscode.ThemeIcon('list-tree');
                break;
            case 'scriptedClassType':
                this.iconPath = getDefinitionIcon(d, d.hasScaffold ? 'folder-library' : 'folder');
                break;
            case 'scriptedClass':
                this.iconPath = getDefinitionIcon(d, 'symbol-class');
                if (
                    d.classGlobal === 'VGUI'
                    && d.uri
                    && typeof d.startLine === 'number'
                    && typeof d.startCharacter === 'number'
                ) {
                    this.command = {
                        command: 'vscode.open',
                        title: 'Open Panel Definition',
                        arguments: [
                            d.uri,
                            {
                                selection: new vscode.Range(
                                    d.startLine,
                                    d.startCharacter,
                                    d.startLine,
                                    d.startCharacter,
                                ),
                            },
                        ],
                    };
                }
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

    private scriptedClassCache?: ScriptedClassCache;
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
                new GmodExplorerItem({
                    type: 'scriptedClassType',
                    label: 'VGUI Panels',
                    collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                    definitionId: '__vgui__',
                    classGlobal: 'VGUI',
                    hasScaffold: false,
                    icon: 'window',
                }),
                new GmodExplorerItem({ type: 'category', label: 'Resources', collapsible: vscode.TreeItemCollapsibleState.Collapsed }),
            ];
        }

        const d = element.data;

        if (d.type === 'category') {
            switch (d.label) {
                case 'Scripted Classes':
                    return this.getScriptedClassTypeItems(undefined);
                case 'Resources':
                    return [
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Models', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'models' }),
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Materials', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'materials' }),
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Sounds', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'sounds' }),
                        new GmodExplorerItem({ type: 'resourceCategory', label: 'Other', collapsible: vscode.TreeItemCollapsibleState.Collapsed, rcType: 'other' }),
                    ];
            }
        }

        if (d.type === 'scriptedClassType') {
            if (d.classGlobal === 'VGUI') {
                return this.getScriptedClassItemsForVgui();
            }

            return this.getScriptedClassTypeChildren(d.definitionId);
        }

        if (d.type === 'scriptedClass' && d.definitionId && d.className) {
            const cache = await this.getScriptedClassCache();
            const files = cache.classMaps.get(d.definitionId)?.get(d.className) ?? [];
            return files.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath)).map((file) =>
                new GmodExplorerItem({ type: 'file', label: path.basename(file.uri.fsPath), collapsible: vscode.TreeItemCollapsibleState.None, uri: file.uri })
            );
        }

        if (d.type === 'resourceCategory' && d.rcType) {
            const cache = await this.getResourceCache();
            const groupMap = cache.get(d.rcType) ?? new Map<string, vscode.Uri[]>();
            const items: GmodExplorerItem[] = [];
            const rootFiles = groupMap.get('') ?? [];
            for (const uri of rootFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
                items.push(new GmodExplorerItem({ type: 'file', label: path.basename(uri.fsPath), collapsible: vscode.TreeItemCollapsibleState.None, uri }));
            }
            for (const [groupKey, files] of [...groupMap.entries()].filter(([k]) => k !== '').sort((a, b) => a[0].localeCompare(b[0]))) {
                items.push(new GmodExplorerItem({
                    type: 'resourceGroup',
                    label: `${groupKey} (${files.length})`,
                    collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                    rcType: d.rcType,
                    groupKey,
                    uri: files[0],
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

    public async resolveItemUri(target: unknown, preferFolder: boolean = false): Promise<vscode.Uri | undefined> {
        const item = target instanceof GmodExplorerItem ? target : undefined;
        const data = item?.data;
        if (!data) {
            return undefined;
        }

        let uri = data.uri;
        if (!uri) {
            uri = await this.resolveRepresentativeUri(data);
        }
        if (!uri) {
            return undefined;
        }

        if (!preferFolder) {
            return uri;
        }

        return vscode.Uri.file(path.dirname(uri.fsPath));
    }

    private async getScriptedClassTypeItems(parentId: string | undefined): Promise<GmodExplorerItem[]> {
        const cache = await this.getScriptedClassCache();
        return (cache.childDefinitions.get(parentId) ?? []).map((definition) =>
            new GmodExplorerItem({
                type: 'scriptedClassType',
                label: definition.label,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                definitionId: definition.id,
                classGlobal: definition.classGlobal,
                hasScaffold: hasScaffoldFiles(definition),
                icon: definition.icon,
            })
        );
    }

    private async getScriptedClassTypeChildren(definitionId: string | undefined): Promise<GmodExplorerItem[]> {
        if (!definitionId) {
            return [];
        }

        const cache = await this.getScriptedClassCache();
        const definition = cache.definitions.get(definitionId);
        if (!definition) {
            return [];
        }

        const classMap = cache.classMaps.get(definitionId) ?? new Map<string, ScriptedClassFileEntry[]>();
        const classItems = [...classMap.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([className, files]) => {
                const firstFile = files[0];
                return new GmodExplorerItem({
                    type: 'scriptedClass',
                    label: className,
                    collapsible: files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    definitionId,
                    classGlobal: definition.classGlobal,
                    className,
                    icon: definition.icon,
                    uri: firstFile?.uri,
                    startLine: firstFile?.startLine,
                    startCharacter: firstFile?.startCharacter,
                });
            });

        const childTypes = await this.getScriptedClassTypeItems(definitionId);
        return [...classItems, ...childTypes];
    }

    private async getScriptedClassItemsForVgui(): Promise<GmodExplorerItem[]> {
        const cache = await this.getScriptedClassCache();
        return [...cache.vguiClassMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([className, files]) => {
            const firstFile = files[0];
            const isVguiDefinition = files.length === 1
                && typeof firstFile?.startLine === 'number'
                && typeof firstFile?.startCharacter === 'number';

            return new GmodExplorerItem({
                type: 'scriptedClass',
                label: className,
                collapsible: isVguiDefinition
                    ? vscode.TreeItemCollapsibleState.None
                    : files.length > 0
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.None,
                definitionId: '__vgui__',
                classGlobal: 'VGUI',
                className,
                icon: 'window',
                uri: firstFile?.uri,
                startLine: firstFile?.startLine,
                startCharacter: firstFile?.startCharacter,
            });
        });
    }

    private async resolveRepresentativeUri(data: ItemData): Promise<vscode.Uri | undefined> {
        if (data.type === 'scriptedClass' && data.definitionId && data.className) {
            const cache = await this.getScriptedClassCache();
            return cache.classMaps.get(data.definitionId)?.get(data.className)?.[0]?.uri;
        }

        if (data.type === 'scriptedClassType') {
            const cache = await this.getScriptedClassCache();
            if (data.classGlobal === 'VGUI') {
                for (const files of cache.vguiClassMap.values()) {
                    if (files.length > 0) {
                        return files[0].uri;
                    }
                }
                return undefined;
            }

            return this.findRepresentativeUriForDefinition(cache, data.definitionId);
        }

        if (data.type === 'resourceGroup' && data.rcType && data.groupKey !== undefined) {
            const cache = await this.getResourceCache();
            return cache.get(data.rcType)?.get(data.groupKey)?.[0];
        }

        if (data.type === 'resourceCategory' && data.rcType) {
            const cache = await this.getResourceCache();
            const groupMap = cache.get(data.rcType);
            if (!groupMap) {
                return undefined;
            }
            for (const files of groupMap.values()) {
                if (files.length > 0) {
                    return files[0];
                }
            }
        }

        return undefined;
    }

    private findRepresentativeUriForDefinition(cache: ScriptedClassCache, definitionId: string | undefined): vscode.Uri | undefined {
        if (!definitionId) {
            return undefined;
        }

        const classMap = cache.classMaps.get(definitionId);
        if (classMap) {
            for (const files of classMap.values()) {
                if (files.length > 0) {
                    return files[0].uri;
                }
            }
        }

        for (const childDefinition of cache.childDefinitions.get(definitionId) ?? []) {
            const childUri = this.findRepresentativeUriForDefinition(cache, childDefinition.id);
            if (childUri) {
                return childUri;
            }
        }

        return undefined;
    }

    private async getScriptedClassCache(): Promise<ScriptedClassCache> {
        if (this.scriptedClassCache) {
            return this.scriptedClassCache;
        }

        const result = await fetchLsScriptedClassesResult();
        const definitions = new Map<string, LsScriptedClassDefinition>();
        const childDefinitions = new Map<string | undefined, LsScriptedClassDefinition[]>();
        const classMaps = new Map<string, Map<string, ScriptedClassFileEntry[]>>();
        const vguiClassMap = new Map<string, ScriptedClassFileEntry[]>();

        for (const definition of result.definitions) {
            definitions.set(definition.id, definition);
            classMaps.set(definition.id, new Map<string, ScriptedClassFileEntry[]>());
        }

        for (const definition of result.definitions) {
            const parentId = definition.parentId && definitions.has(definition.parentId)
                ? definition.parentId
                : undefined;
            const siblings = childDefinitions.get(parentId) ?? [];
            siblings.push(definition);
            childDefinitions.set(parentId, siblings);
        }

        for (const entry of result.entries) {
            const uri = parseLsUri(entry.uri);
            if (!uri || !entry.className) {
                continue;
            }

            const startLine = entry.range?.start?.line;
            const startCharacter = entry.range?.start?.character;
            const fileEntry: ScriptedClassFileEntry = {
                uri,
                startLine: typeof startLine === 'number' ? startLine : undefined,
                startCharacter: typeof startCharacter === 'number' ? startCharacter : undefined,
            };

            if (entry.classType === 'VGUI' || entry.definitionId === undefined) {
                const files = vguiClassMap.get(entry.className) ?? [];
                files.push(fileEntry);
                vguiClassMap.set(entry.className, files);
                continue;
            }

            const classMap = classMaps.get(entry.definitionId);
            if (!classMap) {
                continue;
            }

            const files = classMap.get(entry.className) ?? [];
            files.push(fileEntry);
            classMap.set(entry.className, files);
        }

        for (const entries of classMaps.values()) {
            for (const [className, files] of entries) {
                files.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
                entries.set(className, files);
            }
        }

        for (const [className, files] of vguiClassMap) {
            files.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
            vguiClassMap.set(className, files);
        }

        for (const [parentId, children] of childDefinitions) {
            children.sort((a, b) => a.label.localeCompare(b.label));
            childDefinitions.set(parentId, children);
        }

        this.scriptedClassCache = {
            definitions,
            childDefinitions,
            classMaps,
            vguiClassMap,
        };
        return this.scriptedClassCache;
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
        if (registeredGmodExplorerProvider === this) {
            registeredGmodExplorerProvider = undefined;
        }
        if (pendingStartupRefresh) {
            clearTimeout(pendingStartupRefresh);
            pendingStartupRefresh = undefined;
        }
        this.onDidChangeTreeDataEmitter.dispose();
    }
}

export function registerGmodExplorer(context: vscode.ExtensionContext): GmodExplorerProvider {
    const provider = new GmodExplorerProvider();
    registeredGmodExplorerProvider = provider;
    const treeView = vscode.window.createTreeView('gluals.gmodExplorer', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    context.subscriptions.push(provider, treeView);
    return provider;
}
