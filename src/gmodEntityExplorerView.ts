import * as vscode from 'vscode';
import {
    EntityDetail,
    EntityTableEntry,
    GetEntityNetworkVarsResult,
    GetEntityTableResult,
    EntitySummary,
    GetEntitiesResult,
    SetEntityPropertyParams,
    SetEntityPropertyValue,
    Vec3,
} from './debugger/gmod_debugger/lrdb/Client';
import { extensionContext } from './extension';
import { fetchLsScriptedClasses } from './gmodExplorer';

const ENTITY_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const ENTITY_POLL_INTERVAL_MS = 1000;
const ENTITY_POLL_MAX_INTERVAL_MS = 30000;
const ENTITY_POLL_FAILURE_THRESHOLD = 4;
const ENTITY_DETAIL_MAX_CONCURRENCY = 3;

type EntityClassGroupKind = 'player' | 'luaDefined' | 'other';
export type EntityClassGroupFilter = 'all' | EntityClassGroupKind;

interface EntityClassGroup {
    className: string;
    groupKind: EntityClassGroupKind;
    entities: EntitySummary[];
}

type EntityTreeItemData =
    | {
        kind: 'classGroup';
        className: string;
        groupKind: EntityClassGroupKind;
        entities: EntitySummary[];
    }
    | {
        kind: 'entity';
        entity: EntitySummary;
    }
    | {
        kind: 'property';
        entityIndex: number;
        property: string;
        value: SetEntityPropertyValue;
        editable: boolean;
    }
    | {
        kind: 'tableProperty';
        entityIndex: number;
        property: string;
        displayValue: string;
        value?: SetEntityPropertyValue;
        editable: boolean;
    }
    | {
        kind: 'entityTableSection';
        entityIndex: number;
    }
    | {
        kind: 'networkVarSection';
        entityIndex: number;
    }
    | {
        kind: 'networkVarSearch';
        entityIndex: number;
    }
    | {
        kind: 'networkVarProperty';
        entityIndex: number;
        property: string;
        displayValue: string;
        value?: SetEntityPropertyValue;
        editable: boolean;
    }
    | {
        kind: 'entityTableSearch';
        entityIndex: number;
    }
    | {
        kind: 'loadMore';
    }
    | {
        kind: 'info';
        message: string;
        id?: string;
        severity: 'info' | 'warning' | 'error';
        command?: {
            id: string;
            title: string;
        };
    };

export class EntityTreeItem extends vscode.TreeItem {
    constructor(public readonly data: EntityTreeItemData) {
        super('', vscode.TreeItemCollapsibleState.None);
    }
}

export class GmodEntityExplorerProvider implements vscode.TreeDataProvider<EntityTreeItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<EntityTreeItem | undefined | void>();

    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    private entities: EntitySummary[] = [];
    private entityDetails = new Map<number, EntityDetail>();
    private entityDetailErrors = new Map<number, string>();
    private filterText = '';
    private totalCount = 0;
    private loading = false;
    private hasLoadedOnce = false;
    private readonly loadingDetails = new Set<number>();
    private lastError: string | undefined;
    private searchDebounce: NodeJS.Timeout | undefined;
    private pollTimeout: NodeJS.Timeout | undefined;
    private viewVisible = true;
    private pollingInProgress = false;
    private consecutiveFailures = 0;
    private pollingHalted = false;
    private inFlightEntityDetailRequests = 0;
    private readonly entityDetailRequestQueue: Array<() => void> = [];
    private classGroupFilter: EntityClassGroupFilter = 'all';
    private luaDefinedClassNames?: Set<string>;
    private readonly entityTableEntries = new Map<number, EntityTableEntry[]>();
    private readonly loadingEntityTables = new Set<number>();
    private readonly entityTableFilters = new Map<number, string>();
    private readonly entityNetworkVars = new Map<number, EntityTableEntry[]>();
    private readonly loadingEntityNetworkVars = new Set<number>();
    private readonly entityNetworkVarFilters = new Map<number, string>();

    constructor(private readonly getActiveSession: () => vscode.DebugSession | undefined) {
        this.startPolling();
    }

    getTreeItem(element: EntityTreeItem): vscode.TreeItem {
        switch (element.data.kind) {
            case 'classGroup': {
                element.id = `entityClass:${element.data.className}`;
                element.label = `${element.data.className} (${element.data.entities.length})`;
                element.tooltip = `Class: ${element.data.className}`;
                element.iconPath = new vscode.ThemeIcon(
                    element.data.groupKind === 'player'
                        ? 'account'
                        : element.data.groupKind === 'luaDefined'
                            ? 'symbol-interface'
                            : 'symbol-class'
                );
                element.description = element.data.groupKind === 'player'
                    ? 'Player'
                    : element.data.groupKind === 'luaDefined'
                        ? 'Lua Defined'
                        : undefined;
                element.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                element.contextValue = 'gmodEntityClassGroup';
                return element;
            }
            case 'entity': {
                const { entity } = element.data;
                element.id = `entity:${entity.index}`;
                element.label = `[${entity.index}] ${entity.class}`;
                element.description = this.shortenModelPath(entity.model);
                element.tooltip = [
                    `Class: ${entity.class}`,
                    `Model: ${entity.model || '(none)'}`,
                    `Valid: ${entity.valid ? 'yes' : 'no'}`,
                    `Position: ${this.formatVec3(entity.pos)}`,
                    `Angles: ${this.formatVec3(entity.angles)}`,
                ].join('\n');
                element.iconPath = new vscode.ThemeIcon('symbol-object');
                element.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                element.contextValue = 'gmodEntity';
                return element;
            }
            case 'property': {
                const { property, value, editable } = element.data;
                element.id = `entity:${element.data.entityIndex}:property:${property}`;
                element.label = `${property}: ${this.formatValue(value)}`;
                element.tooltip = `${property}: ${this.formatValue(value)}`;
                element.iconPath = editable
                    ? new vscode.ThemeIcon('edit')
                    : new vscode.ThemeIcon('lock');
                element.contextValue = editable
                    ? 'gmodEntityPropertyEditable'
                    : 'gmodEntityPropertyReadonly';
                if (editable) {
                    element.command = {
                        command: 'gmodEntityExplorer.editProperty',
                        title: 'Edit Entity Property',
                        arguments: [element],
                    };
                }
                return element;
            }
            case 'tableProperty': {
                const { property, displayValue, editable, value } = element.data;
                element.id = `entity:${element.data.entityIndex}:tableProperty:${property}`;
                element.label = `${property}: ${displayValue}`;
                element.tooltip = `${property}: ${displayValue}`;
                element.iconPath = editable
                    ? new vscode.ThemeIcon('edit')
                    : new vscode.ThemeIcon('lock');
                element.contextValue = editable
                    ? 'gmodEntityPropertyEditable'
                    : 'gmodEntityPropertyReadonly';
                if (editable && value !== undefined) {
                    element.command = {
                        command: 'gmodEntityExplorer.editProperty',
                        title: 'Edit Entity Property',
                        arguments: [element],
                    };
                }
                return element;
            }
            case 'entityTableSection': {
                const filter = this.entityTableFilters.get(element.data.entityIndex) ?? '';
                element.id = `entity:${element.data.entityIndex}:tableSection`;
                element.label = 'EntityTable';
                element.tooltip = filter.length > 0
                    ? `Expand to inspect Entity:GetTable() values (filter: ${filter}). Collapsing clears cached values.`
                    : 'Expand to inspect Entity:GetTable() values. Collapsing clears cached values.';
                element.iconPath = new vscode.ThemeIcon('list-tree');
                element.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                element.contextValue = 'gmodEntityTableSection';
                return element;
            }
            case 'networkVarSection': {
                const filter = this.entityNetworkVarFilters.get(element.data.entityIndex) ?? '';
                element.id = `entity:${element.data.entityIndex}:networkVarSection`;
                element.label = 'NetworkVars';
                element.tooltip = filter.length > 0
                    ? `Expand to inspect NetworkVars (filter: ${filter}).`
                    : 'Expand to inspect NetworkVars declared via Entity:NetworkVar.';
                element.iconPath = new vscode.ThemeIcon('broadcast');
                element.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                element.contextValue = 'gmodEntityNetworkVarSection';
                return element;
            }
            case 'networkVarSearch': {
                const filter = this.entityNetworkVarFilters.get(element.data.entityIndex) ?? '';
                element.id = `entity:${element.data.entityIndex}:networkVarSearch`;
                element.label = filter.length > 0
                    ? `Search vars... (current: ${filter})`
                    : 'Search vars...';
                element.tooltip = 'Filter NetworkVars by name or value text.';
                element.iconPath = new vscode.ThemeIcon('search');
                element.contextValue = 'gmodEntityNetworkVarSearch';
                element.command = {
                    command: 'gmodEntityExplorer.searchNetworkVars',
                    title: 'Search NetworkVars',
                    arguments: [element],
                };
                return element;
            }
            case 'entityTableSearch': {
                const filter = this.entityTableFilters.get(element.data.entityIndex) ?? '';
                element.id = `entity:${element.data.entityIndex}:tableSearch`;
                element.label = filter.length > 0
                    ? `Search values... (current: ${filter})`
                    : 'Search values...';
                element.tooltip = 'Filter Entity:GetTable() entries by key or display text.';
                element.iconPath = new vscode.ThemeIcon('search');
                element.contextValue = 'gmodEntityTableSearch';
                element.command = {
                    command: 'gmodEntityExplorer.searchTable',
                    title: 'Search Entity Table Values',
                    arguments: [element],
                };
                return element;
            }
            case 'networkVarProperty': {
                element.id = `entity:${element.data.entityIndex}:networkVar:${element.data.property}`;
                element.label = `${element.data.property}: ${element.data.displayValue}`;
                element.tooltip = `${element.data.property}: ${element.data.displayValue}`;
                element.iconPath = element.data.editable
                    ? new vscode.ThemeIcon('edit')
                    : new vscode.ThemeIcon('lock');
                element.contextValue = element.data.editable
                    ? 'gmodEntityPropertyEditable'
                    : 'gmodEntityPropertyReadonly';
                if (element.data.editable && element.data.value !== undefined) {
                    element.command = {
                        command: 'gmodEntityExplorer.editProperty',
                        title: 'Edit NetworkVar Value',
                        arguments: [element],
                    };
                }
                return element;
            }
            case 'loadMore':
                element.id = 'entities:loadMore';
                element.label = 'Load more...';
                element.iconPath = new vscode.ThemeIcon('ellipsis');
                element.contextValue = 'gmodEntityLoadMore';
                element.command = {
                    command: 'gmodEntityExplorer.loadMore',
                    title: 'Load More Entities',
                };
                return element;
            case 'info':
                element.id = element.data.id ?? `entities:info:${element.data.severity}:${element.data.message}`;
                element.label = element.data.message;
                element.contextValue = 'gmodEntityInfo';
                element.iconPath = new vscode.ThemeIcon(
                    element.data.severity === 'error'
                        ? 'error'
                        : element.data.severity === 'warning'
                            ? 'warning'
                            : 'info'
                );
                if (element.data.command) {
                    element.command = {
                        command: element.data.command.id,
                        title: element.data.command.title,
                    };
                }
                return element;
        }
    }

    async getChildren(element?: EntityTreeItem): Promise<EntityTreeItem[]> {
        if (!element) {
            return this.getRootItems();
        }

        if (element.data.kind === 'classGroup') {
            return element.data.entities.map((entity) => new EntityTreeItem({ kind: 'entity', entity }));
        }

        if (element.data.kind === 'entityTableSection') {
            return this.getEntityTableItems(element.data.entityIndex);
        }

        if (element.data.kind === 'networkVarSection') {
            return this.getEntityNetworkVarItems(element.data.entityIndex);
        }

        if (element.data.kind !== 'entity') {
            return [];
        }

        return this.getEntityDetailItems(element.data.entity);
    }

    setFilter(text: string): void {
        this.filterText = text.trim();
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
        }

        this.searchDebounce = setTimeout(() => {
            this.resumePollingAfterRetry();
            void this.loadEntities();
        }, SEARCH_DEBOUNCE_MS);
    }

    getClassGroupFilter(): EntityClassGroupFilter {
        return this.classGroupFilter;
    }

    setClassGroupFilter(filter: EntityClassGroupFilter): void {
        if (this.classGroupFilter === filter) {
            return;
        }

        this.classGroupFilter = filter;
        this.onDidChangeTreeDataEmitter.fire();
    }

    onEntityTableSectionCollapsed(entityIndex: number): void {
        this.loadingEntityTables.delete(entityIndex);
        this.entityTableEntries.delete(entityIndex);
        this.entityTableFilters.delete(entityIndex);
        this.onDidChangeTreeDataEmitter.fire();
    }

    onEntityNetworkVarSectionCollapsed(entityIndex: number): void {
        this.loadingEntityNetworkVars.delete(entityIndex);
        this.entityNetworkVars.delete(entityIndex);
        this.entityNetworkVarFilters.delete(entityIndex);
        this.onDidChangeTreeDataEmitter.fire();
    }

    async searchEntityTable(entityIndex: number): Promise<void> {
        const currentFilter = this.entityTableFilters.get(entityIndex) ?? '';
        const nextFilter = await vscode.window.showInputBox({
            title: 'Search Entity:GetTable() values',
            prompt: 'Filter table entries by key or value text',
            placeHolder: 'Example: weapon, health, active',
            value: currentFilter,
            ignoreFocusOut: true,
        });

        if (nextFilter === undefined) {
            return;
        }

        this.entityTableFilters.set(entityIndex, nextFilter.trim());
        this.entityTableEntries.delete(entityIndex);
        this.onDidChangeTreeDataEmitter.fire();
    }

    async searchEntityNetworkVars(entityIndex: number): Promise<void> {
        const currentFilter = this.entityNetworkVarFilters.get(entityIndex) ?? '';
        const nextFilter = await vscode.window.showInputBox({
            title: 'Search NetworkVars',
            prompt: 'Filter NetworkVars by key or value text',
            placeHolder: 'Example: speed, owner, true',
            value: currentFilter,
            ignoreFocusOut: true,
        });

        if (nextFilter === undefined) {
            return;
        }

        this.entityNetworkVarFilters.set(entityIndex, nextFilter.trim());
        this.entityNetworkVars.delete(entityIndex);
        this.onDidChangeTreeDataEmitter.fire();
    }

    async loadEntities(): Promise<void> {
        this.resumePollingAfterRetry();
        await this.loadEntityPage(true, false);
    }

    async loadMore(): Promise<void> {
        this.resumePollingAfterRetry();
        await this.loadEntityPage(false, false);
    }

    async editProperty(entityIndex: number, property: string, currentValue: unknown): Promise<void> {
        const session = this.requireActiveSession();
        if (!session) {
            vscode.window.showErrorMessage('Cannot edit: no active GMod debug session.');
            return;
        }

        const nextValue = await this.promptEditedValue(property, currentValue);
        if (nextValue === undefined) {
            return;
        }

        const params: SetEntityPropertyParams = {
            index: entityIndex,
            property,
            value: nextValue,
        };

        try {
            await this.sendRequest<{ ok: boolean; index: number; property: string }>('gmod.entity.setProperty', params);
            this.applyLocalEdit(entityIndex, property, nextValue);
            this.onDidChangeTreeDataEmitter.fire();
            vscode.window.showInformationMessage(`Updated entity ${entityIndex} property \"${property}\".`);
        } catch (error) {
            if (this.extractErrorCode(error) === -32001) {
                vscode.window.showErrorMessage('Cannot edit: debugger must be paused');
                return;
            }
            vscode.window.showErrorMessage(`Failed to edit entity property: ${this.extractErrorMessage(error)}`);
        }
    }

    async editNetworkVar(entityIndex: number, name: string, currentValue: unknown): Promise<void> {
        const session = this.requireActiveSession();
        if (!session) {
            vscode.window.showErrorMessage('Cannot edit: no active GMod debug session.');
            return;
        }

        const nextValue = await this.promptEditedValue(name, currentValue);
        if (nextValue === undefined) {
            return;
        }

        try {
            await this.sendRequest<{ ok: boolean; index: number; name: string }>('gmod.entity.setNetworkVar', {
                index: entityIndex,
                name,
                value: nextValue,
            });

            const vars = this.entityNetworkVars.get(entityIndex);
            if (vars) {
                const updated = vars.map((entry) =>
                    entry.key === name
                        ? {
                            ...entry,
                            display: this.formatValue(nextValue),
                            value: nextValue,
                        }
                        : entry
                );
                this.entityNetworkVars.set(entityIndex, updated);
            }

            this.onDidChangeTreeDataEmitter.fire();
            vscode.window.showInformationMessage(`Updated entity ${entityIndex} NetworkVar "${name}".`);
        } catch (error) {
            if (this.extractErrorCode(error) === -32001) {
                vscode.window.showErrorMessage('Cannot edit NetworkVars: debugger must be paused');
                return;
            }
            vscode.window.showErrorMessage(`Failed to edit NetworkVar: ${this.extractErrorMessage(error)}`);
        }
    }

    async editTableValue(entityIndex: number, property: string, currentValue: unknown): Promise<void> {
        const session = this.requireActiveSession();
        if (!session) {
            vscode.window.showErrorMessage('Cannot edit: no active GMod debug session.');
            return;
        }

        const nextValue = await this.promptEditedValue(property, currentValue);
        if (nextValue === undefined) {
            return;
        }

        try {
            await this.sendRequest<{ ok: boolean; index: number; property: string }>('gmod.entity.setTableValue', {
                index: entityIndex,
                property,
                value: nextValue,
            });

            const entries = this.entityTableEntries.get(entityIndex);
            if (entries) {
                const updated = entries.map((entry) =>
                    entry.key === property
                        ? {
                            ...entry,
                            display: this.formatValue(nextValue),
                            value: nextValue,
                        }
                        : entry
                );
                this.entityTableEntries.set(entityIndex, updated);
            }

            this.onDidChangeTreeDataEmitter.fire();
            vscode.window.showInformationMessage(`Updated entity ${entityIndex} EntityTable value "${property}".`);
        } catch (error) {
            if (this.extractErrorCode(error) === -32001) {
                vscode.window.showErrorMessage('Cannot edit EntityTable values: debugger must be paused');
                return;
            }
            vscode.window.showErrorMessage(`Failed to edit EntityTable value: ${this.extractErrorMessage(error)}`);
        }
    }

    clear(): void {
        this.stopPolling();
        this.resetPollingFailures();

        const previousState = this.getRootStateKey();
        this.entities = [];
        this.entityDetails.clear();
        this.entityDetailErrors.clear();
        this.entityTableEntries.clear();
        this.loadingEntityTables.clear();
        this.entityTableFilters.clear();
        this.entityNetworkVars.clear();
        this.loadingEntityNetworkVars.clear();
        this.entityNetworkVarFilters.clear();
        this.totalCount = 0;
        this.hasLoadedOnce = false;
        this.lastError = undefined;
        if (previousState !== this.getRootStateKey()) {
            this.onDidChangeTreeDataEmitter.fire();
        }

        if (this.viewVisible && this.requireActiveSession()) {
            this.startPolling();
        }
    }

    refresh(): void {
        this.resumePollingAfterRetry();
        this.luaDefinedClassNames = undefined;
        void this.loadEntities();
    }

    setViewVisible(visible: boolean): void {
        this.viewVisible = visible;
        if (!visible) {
            this.stopPolling();
            return;
        }

        if (this.requireActiveSession()) {
            this.startPolling();
            void this.loadEntities();
        }
    }

    dispose(): void {
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = undefined;
        }
        this.stopPolling();
        this.onDidChangeTreeDataEmitter.dispose();
    }

    private startPolling(): void {
        if (this.pollingHalted || this.pollTimeout || this.pollingInProgress) {
            return;
        }

        if (!this.viewVisible || !this.requireActiveSession()) {
            return;
        }

        this.scheduleNextPoll(ENTITY_POLL_INTERVAL_MS);
    }

    private stopPolling(): void {
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = undefined;
        }

        if (!this.pollTimeout) {
            return;
        }

        clearTimeout(this.pollTimeout);
        this.pollTimeout = undefined;
    }

    private scheduleNextPoll(delayMs: number): void {
        if (this.pollingHalted || this.pollTimeout || !this.viewVisible || !this.requireActiveSession()) {
            return;
        }

        this.pollTimeout = setTimeout(() => {
            this.pollTimeout = undefined;
            void this.pollEntities();
        }, delayMs);
    }

    private async pollEntities(): Promise<void> {
        if (this.pollingInProgress) {
            return;
        }

        if (!this.viewVisible || !this.requireActiveSession()) {
            this.stopPolling();
            this.resetPollingFailures();
            return;
        }

        this.pollingInProgress = true;
        let nextDelay = ENTITY_POLL_INTERVAL_MS;

        try {
            const loadResult = await this.loadEntityPage(true, true);
            if (loadResult === 'failure') {
                this.consecutiveFailures += 1;
                if (this.consecutiveFailures >= ENTITY_POLL_FAILURE_THRESHOLD) {
                    this.haltPollingAfterFailures();
                    return;
                }

                // Apply exponential backoff on repeated refresh failures.
                const backoffMultiplier = 2 ** (this.consecutiveFailures - 1);
                nextDelay = Math.min(ENTITY_POLL_INTERVAL_MS * backoffMultiplier, ENTITY_POLL_MAX_INTERVAL_MS);
            } else if (loadResult === 'success') {
                this.resetPollingFailures();
            }
        } finally {
            this.pollingInProgress = false;
        }

        if (!this.pollingHalted) {
            this.scheduleNextPoll(nextDelay);
        }
    }

    private haltPollingAfterFailures(): void {
        this.pollingHalted = true;
        this.stopPolling();
        this.lastError = 'Connection lost - click to retry.';
        this.onDidChangeTreeDataEmitter.fire();
    }

    private resetPollingFailures(): void {
        this.consecutiveFailures = 0;
        this.pollingHalted = false;
    }

    private resumePollingAfterRetry(): void {
        if (!this.pollingHalted) {
            return;
        }

        this.resetPollingFailures();
        this.lastError = undefined;

        if (this.viewVisible && this.requireActiveSession()) {
            this.startPolling();
        }
    }

    private async getRootItems(): Promise<EntityTreeItem[]> {
        if (!this.requireActiveSession()) {
            this.stopPolling();
            this.resetPollingFailures();
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: 'Connect debugger to see entities.',
                    severity: 'info',
                }),
            ];
        }

        if (this.pollingHalted) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: 'Connection lost - click to retry.',
                    severity: 'error',
                    command: {
                        id: 'gmodEntityExplorer.refresh',
                        title: 'Retry Entity Polling',
                    },
                }),
            ];
        }

        this.startPolling();

        if (!this.hasLoadedOnce && !this.loading && this.entities.length === 0 && !this.lastError) {
            await this.loadEntities();
        }

        if (this.loading && this.entities.length === 0) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: 'Loading entities...',
                    severity: 'info',
                }),
            ];
        }

        if (this.lastError && this.entities.length === 0) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: this.lastError,
                    severity: 'error',
                }),
            ];
        }

        if (this.entities.length === 0) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: 'No entities found.',
                    severity: 'info',
                }),
            ];
        }

        const groupedEntities = await this.groupEntitiesByClass(this.entities);
        const filteredGroups = this.applyClassGroupFilter(groupedEntities);

        if (filteredGroups.length === 0) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: 'No entities match the selected category filter.',
                    severity: 'info',
                }),
            ];
        }

        const items = filteredGroups.map((group) =>
            new EntityTreeItem({
                kind: 'classGroup',
                className: group.className,
                groupKind: group.groupKind,
                entities: group.entities,
            })
        );

        if (this.entities.length < this.totalCount) {
            items.push(new EntityTreeItem({ kind: 'loadMore' }));
        }

        if (this.lastError) {
            items.push(
                new EntityTreeItem({
                    kind: 'info',
                    message: this.lastError,
                    severity: 'warning',
                })
            );
        }

        return items;
    }

    private async getEntityDetailItems(entity: EntitySummary): Promise<EntityTreeItem[]> {
        // Retry stale detail errors on next expand instead of permanently pinning
        // the node in an error state after a transient backend failure.
        if (this.entityDetailErrors.has(entity.index) && !this.loadingDetails.has(entity.index)) {
            this.entityDetailErrors.delete(entity.index);
        }

        if (!this.entityDetails.has(entity.index) && !this.loadingDetails.has(entity.index)) {
            this.loadingDetails.add(entity.index);
            try {
                const detail = await this.withEntityDetailRequestSlot(async () =>
                    this.sendRequest<EntityDetail>('gmod.entity.getEntity', { index: entity.index })
                );
                this.entityDetails.set(entity.index, detail);
                this.entityDetailErrors.delete(entity.index);
            } catch (error) {
                this.entityDetailErrors.set(entity.index, this.humanizeEntityDetailError(this.extractErrorMessage(error)));
            } finally {
                this.loadingDetails.delete(entity.index);
            }
        }

        if (this.loadingDetails.has(entity.index)) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    id: `entity:${entity.index}:loading`,
                    message: 'Loading entity details...',
                    severity: 'info',
                }),
            ];
        }

        const detailError = this.entityDetailErrors.get(entity.index);
        if (detailError) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    id: `entity:${entity.index}:error`,
                    message: detailError,
                    severity: 'error',
                }),
            ];
        }

        const detail = this.entityDetails.get(entity.index);
        if (!detail) {
            return [];
        }

        const items: EntityTreeItem[] = [
            new EntityTreeItem({ kind: 'property', entityIndex: detail.index, property: 'pos', value: detail.pos, editable: true }),
            new EntityTreeItem({ kind: 'property', entityIndex: detail.index, property: 'angles', value: detail.angles, editable: true }),
        ];

        items.push(
            new EntityTreeItem({
                kind: 'property',
                entityIndex: detail.index,
                property: 'health',
                value: detail.health,
                editable: true,
            }),
            new EntityTreeItem({ kind: 'property', entityIndex: detail.index, property: 'valid', value: detail.valid, editable: false }),
            new EntityTreeItem({ kind: 'property', entityIndex: detail.index, property: 'class', value: detail.class, editable: false }),
            new EntityTreeItem({ kind: 'property', entityIndex: detail.index, property: 'model', value: detail.model, editable: false }),
        );

        if (detail.parent_index !== null) {
            items.push(
                new EntityTreeItem({
                    kind: 'property',
                    entityIndex: detail.index,
                    property: 'parent_index',
                    value: detail.parent_index,
                    editable: false,
                })
            );
        }

        items.push(new EntityTreeItem({ kind: 'entityTableSection', entityIndex: detail.index }));

        const luaDefinedClassNames = await this.getLuaDefinedClassNames();
        if (luaDefinedClassNames.has(detail.class.trim().toLowerCase())) {
            items.push(new EntityTreeItem({ kind: 'networkVarSection', entityIndex: detail.index }));
        }

        return items;
    }

    private async getEntityTableItems(entityIndex: number): Promise<EntityTreeItem[]> {
        const resultItems: EntityTreeItem[] = [
            new EntityTreeItem({ kind: 'entityTableSearch', entityIndex }),
        ];

        if (this.loadingEntityTables.has(entityIndex)) {
            resultItems.push(
                new EntityTreeItem({
                    kind: 'info',
                    id: `entity:${entityIndex}:tableLoading`,
                    message: 'Loading Entity:GetTable() values...',
                    severity: 'info',
                })
            );
            return resultItems;
        }

        if (!this.entityTableEntries.has(entityIndex)) {
            this.loadingEntityTables.add(entityIndex);
            try {
                const filter = this.entityTableFilters.get(entityIndex) ?? '';
                const response = await this.sendRequest<GetEntityTableResult>('gmod.entity.getEntityTable', {
                    index: entityIndex,
                    filter,
                });
                this.entityTableEntries.set(entityIndex, this.sanitizeEntityEntries(response.entries));
            } catch (error) {
                const message = `Failed to load Entity:GetTable(): ${this.extractErrorMessage(error)}`;
                resultItems.push(
                    new EntityTreeItem({
                        kind: 'info',
                        id: `entity:${entityIndex}:tableError`,
                        message,
                        severity: 'error',
                    })
                );
                this.loadingEntityTables.delete(entityIndex);
                return resultItems;
            } finally {
                this.loadingEntityTables.delete(entityIndex);
            }
        }

        const entries = [...(this.entityTableEntries.get(entityIndex) ?? [])]
            .sort((left, right) => left.key.localeCompare(right.key));
        if (entries.length === 0) {
            resultItems.push(
                new EntityTreeItem({
                    kind: 'info',
                    id: `entity:${entityIndex}:tableEmpty`,
                    message: 'No Entity:GetTable() entries matched the current filter.',
                    severity: 'info',
                })
            );
            return resultItems;
        }

        for (const entry of entries) {
            resultItems.push(
                new EntityTreeItem({
                    kind: 'tableProperty',
                    entityIndex,
                    property: entry.key,
                    displayValue: entry.display,
                    value: entry.value,
                    editable: entry.editable,
                })
            );
        }

        return resultItems;
    }

    private async getEntityNetworkVarItems(entityIndex: number): Promise<EntityTreeItem[]> {
        const resultItems: EntityTreeItem[] = [
            new EntityTreeItem({ kind: 'networkVarSearch', entityIndex }),
        ];

        if (this.loadingEntityNetworkVars.has(entityIndex)) {
            resultItems.push(
                new EntityTreeItem({
                    kind: 'info',
                    id: `entity:${entityIndex}:networkVarsLoading`,
                    message: 'Loading NetworkVars...',
                    severity: 'info',
                }),
            );
            return resultItems;
        }

        if (!this.entityNetworkVars.has(entityIndex)) {
            this.loadingEntityNetworkVars.add(entityIndex);
            try {
                const response = await this.sendRequest<GetEntityNetworkVarsResult>('gmod.entity.getEntityNetworkVars', {
                    index: entityIndex,
                });
                this.entityNetworkVars.set(entityIndex, this.sanitizeEntityEntries(response.entries));
            } catch (error) {
                this.loadingEntityNetworkVars.delete(entityIndex);
                resultItems.push(
                    new EntityTreeItem({
                        kind: 'info',
                        id: `entity:${entityIndex}:networkVarsError`,
                        message: `Failed to load NetworkVars: ${this.extractErrorMessage(error)}`,
                        severity: 'error',
                    }),
                );
                return resultItems;
            } finally {
                this.loadingEntityNetworkVars.delete(entityIndex);
            }
        }

        const filter = this.entityNetworkVarFilters.get(entityIndex) ?? '';
        const entries = [...(this.entityNetworkVars.get(entityIndex) ?? [])]
            .filter((entry) =>
                filter.length === 0
                    || entry.key.toLowerCase().includes(filter.toLowerCase())
                    || entry.display.toLowerCase().includes(filter.toLowerCase())
            )
            .sort((left, right) => left.key.localeCompare(right.key));

        if (entries.length === 0) {
            resultItems.push(
                new EntityTreeItem({
                    kind: 'info',
                    id: `entity:${entityIndex}:networkVarsEmpty`,
                    message: filter.length > 0
                        ? 'No NetworkVars matched the current filter.'
                        : 'No NetworkVars found on this entity.',
                    severity: 'info',
                }),
            );
            return resultItems;
        }

        for (const entry of entries) {
            resultItems.push(new EntityTreeItem({
                kind: 'networkVarProperty',
                entityIndex,
                property: entry.key,
                displayValue: entry.display,
                value: entry.value,
                editable: entry.editable,
            }));
        }

        return resultItems;
    }

    private async withEntityDetailRequestSlot<T>(request: () => Promise<T>): Promise<T> {
        await this.acquireEntityDetailRequestSlot();
        try {
            return await request();
        } finally {
            this.releaseEntityDetailRequestSlot();
        }
    }

    private static readonly ENTITY_DETAIL_QUEUE_TIMEOUT_MS = 30_000;

    private async acquireEntityDetailRequestSlot(): Promise<void> {
        if (this.inFlightEntityDetailRequests < ENTITY_DETAIL_MAX_CONCURRENCY) {
            this.inFlightEntityDetailRequests += 1;
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const callback = () => {
                clearTimeout(timer);
                resolve();
            };

            const timer = setTimeout(() => {
                const idx = this.entityDetailRequestQueue.indexOf(callback);
                if (idx >= 0) {
                    this.entityDetailRequestQueue.splice(idx, 1);
                }
                reject(new Error('Entity detail request timed out waiting for a slot.'));
            }, GmodEntityExplorerProvider.ENTITY_DETAIL_QUEUE_TIMEOUT_MS);

            this.entityDetailRequestQueue.push(callback);
        });
        this.inFlightEntityDetailRequests += 1;
    }

    private releaseEntityDetailRequestSlot(): void {
        this.inFlightEntityDetailRequests = Math.max(0, this.inFlightEntityDetailRequests - 1);
        const next = this.entityDetailRequestQueue.shift();
        if (next) {
            next();
        }
    }

    private sanitizeEntityEntries(entries: unknown): EntityTableEntry[] {
        if (!Array.isArray(entries)) {
            return [];
        }

        return entries
            .filter((entry): entry is EntityTableEntry => typeof entry === 'object' && entry !== null)
            .map((entry) => {
                const key = typeof entry.key === 'string' ? entry.key : String(entry.key ?? '');
                const display = typeof entry.display === 'string' ? entry.display : this.formatUnknownDisplay(entry.display);
                const editable = entry.editable === true;
                const value = editable ? entry.value : undefined;
                return { key, display, editable, value };
            })
            .filter((entry) => entry.key.trim().length > 0);
    }

    private formatUnknownDisplay(value: unknown): string {
        if (value === null || value === undefined) {
            return 'nil';
        }

        if (typeof value === 'string') {
            return value;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }

        return '<value>';
    }

    private async loadEntityPage(
        reset: boolean,
        backgroundRefresh: boolean,
    ): Promise<'success' | 'failure' | 'skipped'> {
        const session = this.requireActiveSession();
        if (!session) {
            this.clear();
            return 'failure';
        }

        if (this.loading) {
            return 'skipped';
        }

        const previousState = this.getRootStateKey();
        const shouldShowInitialLoading =
            !backgroundRefresh && reset && this.entities.length === 0 && !this.hasLoadedOnce;

        this.loading = true;
        if (shouldShowInitialLoading) {
            this.onDidChangeTreeDataEmitter.fire();
        }

        try {
            const requestedLimit = reset
                ? Math.max(ENTITY_PAGE_SIZE, this.entities.length || ENTITY_PAGE_SIZE)
                : ENTITY_PAGE_SIZE;
            const params = this.buildEntityQuery(reset ? 0 : this.entities.length, requestedLimit);
            const result = await this.sendRequest<GetEntitiesResult>('gmod.entity.getEntities', params);
            if (reset) {
                this.replaceEntities(result.entities, result.total);
            } else {
                this.appendEntities(result.entities);
                this.totalCount = result.total;
            }
            this.hasLoadedOnce = true;
            this.lastError = undefined;
            return 'success';
        } catch (error) {
            this.lastError = this.humanizeLoadError(this.extractErrorMessage(error));
            this.hasLoadedOnce = true;
            return 'failure';
        } finally {
            this.loading = false;
            if (shouldShowInitialLoading || previousState !== this.getRootStateKey()) {
                this.onDidChangeTreeDataEmitter.fire();
            }
        }
    }

    private replaceEntities(items: EntitySummary[], total: number): void {
        const previousByIndex = new Map<number, EntitySummary>(
            this.entities.map((entity) => [entity.index, entity])
        );

        this.entities = items.filter((entity) => this.isDisplayableEntity(entity));
        this.totalCount = total;

        for (const entity of this.entities) {
            const previous = previousByIndex.get(entity.index);
            if (!previous) {
                continue;
            }

            const signatureChanged = previous.class !== entity.class
                || previous.model !== entity.model
                || previous.valid !== entity.valid;
            if (signatureChanged) {
                this.clearEntityCaches(entity.index);
            }
        }

        const activeIndices = new Set(this.entities.map((entity) => entity.index));
        for (const index of [...this.entityDetails.keys()]) {
            if (!activeIndices.has(index)) {
                this.clearEntityCaches(index);
            }
        }

        for (const entity of this.entities) {
            this.syncDetailFromSummary(entity);
        }
    }

    private clearEntityCaches(index: number): void {
        this.entityDetails.delete(index);
        this.entityDetailErrors.delete(index);
        this.loadingDetails.delete(index);
        this.entityTableEntries.delete(index);
        this.loadingEntityTables.delete(index);
        this.entityTableFilters.delete(index);
        this.entityNetworkVars.delete(index);
        this.loadingEntityNetworkVars.delete(index);
        this.entityNetworkVarFilters.delete(index);
    }

    private appendEntities(items: EntitySummary[]): void {
        const indexByEntityId = new Map<number, number>();
        this.entities.forEach((entity, index) => {
            indexByEntityId.set(entity.index, index);
        });

        for (const entity of items) {
            if (!this.isDisplayableEntity(entity)) {
                continue;
            }

            const existingIndex = indexByEntityId.get(entity.index);
            if (existingIndex === undefined) {
                this.entities.push(entity);
                indexByEntityId.set(entity.index, this.entities.length - 1);
            } else {
                this.entities[existingIndex] = entity;
            }
            this.syncDetailFromSummary(entity);
        }
    }

    private async groupEntitiesByClass(entities: EntitySummary[]): Promise<EntityClassGroup[]> {
        const grouped = new Map<string, EntitySummary[]>();
        const luaDefinedClassNames = await this.getLuaDefinedClassNames();

        for (const entity of entities) {
            const className = entity.class;
            const bucket = grouped.get(className) ?? [];
            bucket.push(entity);
            grouped.set(className, bucket);
        }

        return [...grouped.entries()]
            .map(([className, groupedEntities]) => {
                const sortedEntities = [...groupedEntities].sort((left, right) => left.index - right.index);
                return {
                    className,
                    groupKind: this.getEntityClassGroupKind(className, luaDefinedClassNames),
                    entities: sortedEntities,
                };
            })
            .sort((left, right) => {
                const leftRank = this.getClassGroupRank(left.groupKind);
                const rightRank = this.getClassGroupRank(right.groupKind);
                if (leftRank !== rightRank) {
                    return leftRank - rightRank;
                }
                return left.className.localeCompare(right.className);
            });
    }

    private applyClassGroupFilter(groups: EntityClassGroup[]): EntityClassGroup[] {
        if (this.classGroupFilter === 'all') {
            return groups;
        }

        return groups.filter((group) => group.groupKind === this.classGroupFilter);
    }

    private getClassGroupRank(groupKind: EntityClassGroupKind): number {
        switch (groupKind) {
            case 'player':
                return 0;
            case 'luaDefined':
                return 1;
            case 'other':
            default:
                return 2;
        }
    }

    private getEntityClassGroupKind(className: string, luaDefinedClassNames: Set<string>): EntityClassGroupKind {
        const normalizedClass = className.trim().toLowerCase();
        if (normalizedClass === 'player') {
            return 'player';
        }

        if (luaDefinedClassNames.has(normalizedClass)) {
            return 'luaDefined';
        }

        return 'other';
    }

    private async getLuaDefinedClassNames(): Promise<Set<string>> {
        if (this.luaDefinedClassNames) {
            return this.luaDefinedClassNames;
        }

        if (!extensionContext?.client) {
            this.luaDefinedClassNames = new Set<string>();
            return this.luaDefinedClassNames;
        }

        try {
            const entries = await fetchLsScriptedClasses();
            this.luaDefinedClassNames = new Set(
                entries
                    .map((entry) => entry.className?.trim().toLowerCase())
                    .filter((className): className is string => typeof className === 'string' && className.length > 0)
            );
        } catch (error) {
            console.warn('Failed to fetch scripted classes for entity sorting:', error);
            this.luaDefinedClassNames = new Set<string>();
        }

        return this.luaDefinedClassNames;
    }

    private isDisplayableEntity(entity: EntitySummary): boolean {
        return entity.valid && entity.class.trim().length > 0;
    }

    private syncDetailFromSummary(entity: EntitySummary): void {
        const detail = this.entityDetails.get(entity.index);
        if (!detail) {
            return;
        }

        detail.class = entity.class;
        detail.model = entity.model;
        detail.valid = entity.valid;
        detail.pos = [...entity.pos] as Vec3;
        detail.angles = [...entity.angles] as Vec3;
    }

    private getRootStateKey(): string {
        return JSON.stringify({
            entities: this.entities.map((entity) => [
                entity.index,
                entity.class,
                entity.model,
                entity.valid,
                entity.pos[0],
                entity.pos[1],
                entity.pos[2],
                entity.angles[0],
                entity.angles[1],
                entity.angles[2],
            ]),
            totalCount: this.totalCount,
            lastError: this.lastError ?? '',
            hasLoadedOnce: this.hasLoadedOnce,
        });
    }

    private buildEntityQuery(offset: number, limit: number): { offset: number; limit: number; filter_id: number; filter_class: string } {
        const trimmed = this.filterText.trim();
        const numericFilter = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
        const filterClass = numericFilter > 0 ? '' : trimmed;

        return {
            offset,
            limit,
            filter_id: numericFilter,
            filter_class: filterClass,
        };
    }

    private async promptEditedValue(property: string, currentValue: unknown): Promise<SetEntityPropertyValue | undefined> {
        if (property === 'pos') {
            const raw = await vscode.window.showInputBox({
                title: 'Set entity position',
                prompt: 'Enter position values as x, y, z',
                placeHolder: 'x, y, z',
                value: this.formatVectorInputValue(currentValue),
                ignoreFocusOut: true,
            });

            if (raw === undefined) {
                return undefined;
            }

            const vector = this.parseVectorInput(raw);
            if (!vector) {
                vscode.window.showErrorMessage('Invalid position format. Expected: x, y, z');
                return undefined;
            }
            return vector;
        }

        if (property === 'angles') {
            const raw = await vscode.window.showInputBox({
                title: 'Set entity angles',
                prompt: 'Enter angle values as pitch, yaw, roll',
                placeHolder: 'pitch, yaw, roll',
                value: this.formatVectorInputValue(currentValue),
                ignoreFocusOut: true,
            });

            if (raw === undefined) {
                return undefined;
            }

            const vector = this.parseVectorInput(raw);
            if (!vector) {
                vscode.window.showErrorMessage('Invalid angles format. Expected: pitch, yaw, roll');
                return undefined;
            }
            return vector;
        }

        if (typeof currentValue === 'boolean') {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: 'true', value: true },
                    { label: 'false', value: false },
                ],
                {
                    title: `Set ${property}`,
                    placeHolder: 'Select boolean value',
                    ignoreFocusOut: true,
                }
            );
            return pick?.value;
        }

        if (typeof currentValue === 'number') {
            const input = await vscode.window.showInputBox({
                title: `Set ${property}`,
                prompt: 'Enter numeric value',
                value: String(currentValue),
                ignoreFocusOut: true,
            });
            if (input === undefined) {
                return undefined;
            }

            const nextNumber = Number(input);
            if (!Number.isFinite(nextNumber)) {
                vscode.window.showErrorMessage('Invalid number value.');
                return undefined;
            }

            return nextNumber;
        }

        const input = await vscode.window.showInputBox({
            title: `Set ${property}`,
            prompt: 'Enter string value',
            value: typeof currentValue === 'string' ? currentValue : '',
            ignoreFocusOut: true,
        });
        return input;
    }

    private parseVectorInput(value: string): Vec3 | undefined {
        const parts = value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0);

        if (parts.length !== 3) {
            return undefined;
        }

        const numbers = parts.map((part) => Number(part));
        if (!numbers.every((part) => Number.isFinite(part))) {
            return undefined;
        }

        return [numbers[0], numbers[1], numbers[2]];
    }

    private formatVectorInputValue(value: unknown): string {
        if (Array.isArray(value) && value.length === 3) {
            return value.map((part) => Number(part)).join(', ');
        }
        return '0, 0, 0';
    }

    private applyLocalEdit(entityIndex: number, property: string, value: SetEntityPropertyValue): void {
        const summary = this.entities.find((entity) => entity.index === entityIndex);
        const detail = this.entityDetails.get(entityIndex);

        if (summary && property === 'pos' && this.isVec3(value)) {
            summary.pos = value;
        }
        if (summary && property === 'angles' && this.isVec3(value)) {
            summary.angles = value;
        }

        if (!detail) {
            return;
        }

        if (property === 'pos' && this.isVec3(value)) {
            detail.pos = value;
            return;
        }

        if (property === 'angles' && this.isVec3(value)) {
            detail.angles = value;
            return;
        }

        if (property === 'health' && typeof value === 'number') {
            detail.health = value;
            return;
        }

        if (property === 'parent_index' && typeof value === 'number') {
            detail.parent_index = value;
            return;
        }

        if (property === 'model' && typeof value === 'string') {
            detail.model = value;
            if (summary) {
                summary.model = value;
            }
            return;
        }

        if (property === 'class' && typeof value === 'string') {
            detail.class = value;
            if (summary) {
                summary.class = value;
            }
            return;
        }

        if (property === 'valid' && typeof value === 'boolean') {
            detail.valid = value;
            if (summary) {
                summary.valid = value;
            }
            return;
        }

        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            detail.properties[property] = value;
        }
    }

    private isVec3(value: SetEntityPropertyValue): value is Vec3 {
        return Array.isArray(value)
            && value.length === 3
            && value.every((part) => typeof part === 'number' && Number.isFinite(part));
    }

    private requireActiveSession(): vscode.DebugSession | undefined {
        const session = this.getActiveSession();
        if (session?.type === 'gluals_gmod') {
            return session;
        }
        return undefined;
    }

    private async sendRequest<T>(command: string, params: unknown): Promise<T> {
        const session = this.requireActiveSession();
        if (!session) {
            throw new Error('No active GMod debug session.');
        }
        const result = await session.customRequest(command, params);
        return result as T;
    }

    private extractErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            if (error.message.trim().length > 0) {
                return error.message;
            }
        }
        return String(error);
    }

    private extractErrorCode(error: unknown): number | undefined {
        const message = this.extractErrorMessage(error);

        try {
            const parsed = JSON.parse(message) as { code?: unknown };
            if (typeof parsed.code === 'number') {
                return parsed.code;
            }
        } catch {
            // ignore parse errors, we fall back to regex matching below
        }

        const codeMatch = message.match(/"code"\s*:\s*(-?\d+)/);
        if (codeMatch) {
            return Number(codeMatch[1]);
        }

        if (message.includes('-32001')) {
            return -32001;
        }

        return undefined;
    }

    private humanizeLoadError(message: string): string {
        if (message.includes('-32001')) {
            return 'Cannot inspect entities: debugger must be paused.';
        }

        return `Failed to load entities: ${message}`;
    }

    private humanizeEntityDetailError(message: string): string {
        if (message.includes('-32001')) {
            return 'Cannot inspect entity details: debugger must be paused.';
        }

        return `Failed to load entity details: ${message}`;
    }

    private shortenModelPath(model: string): string {
        if (!model || model.trim().length === 0) {
            return '(no model)';
        }

        const segments = model.split(/[\\/]+/).filter((segment) => segment.length > 0);
        if (segments.length <= 2) {
            return segments.join('/');
        }

        return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }

    private formatVec3(value: Vec3): string {
        return `[${value[0].toFixed(2)}, ${value[1].toFixed(2)}, ${value[2].toFixed(2)}]`;
    }

    private formatValue(value: SetEntityPropertyValue): string {
        if (this.isVec3(value)) {
            return this.formatVec3(value);
        }

        if (typeof value === 'string') {
            return value;
        }

        if (typeof value === 'number') {
            return Number.isFinite(value) ? String(value) : 'NaN';
        }

        return value ? 'true' : 'false';
    }
}
