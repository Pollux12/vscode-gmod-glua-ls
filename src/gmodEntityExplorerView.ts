import * as vscode from 'vscode';
import {
    EntityDetail,
    EntitySummary,
    GetEntitiesResult,
    SetEntityPropertyParams,
    SetEntityPropertyValue,
    Vec3,
} from './debugger/gmod_debugger/lrdb/Client';
import { extensionContext } from './extension';

const ENTITY_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const ENTITY_POLL_INTERVAL_MS = 1500;
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

interface LsScriptedClassEntry {
    uri: string;
    classType: string;
    className: string;
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

    clear(): void {
        this.stopPolling();
        this.resetPollingFailures();

        const previousState = this.getRootStateKey();
        this.entities = [];
        this.entityDetails.clear();
        this.entityDetailErrors.clear();
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
        ];

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

        const propertyEntries = Object.entries(detail.properties)
            .sort(([left], [right]) => left.localeCompare(right));

        for (const [name, value] of propertyEntries) {
            items.push(
                new EntityTreeItem({
                    kind: 'property',
                    entityIndex: detail.index,
                    property: name,
                    value,
                    editable: true,
                })
            );
        }

        return items;
    }

    private async withEntityDetailRequestSlot<T>(request: () => Promise<T>): Promise<T> {
        await this.acquireEntityDetailRequestSlot();
        try {
            return await request();
        } finally {
            this.releaseEntityDetailRequestSlot();
        }
    }

    private async acquireEntityDetailRequestSlot(): Promise<void> {
        if (this.inFlightEntityDetailRequests < ENTITY_DETAIL_MAX_CONCURRENCY) {
            this.inFlightEntityDetailRequests += 1;
            return;
        }

        await new Promise<void>((resolve) => {
            this.entityDetailRequestQueue.push(resolve);
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
        this.entities = items.filter((entity) => this.isDisplayableEntity(entity));
        this.totalCount = total;

        const activeIndices = new Set(this.entities.map((entity) => entity.index));
        for (const index of [...this.entityDetails.keys()]) {
            if (!activeIndices.has(index)) {
                this.entityDetails.delete(index);
                this.entityDetailErrors.delete(index);
                this.loadingDetails.delete(index);
            }
        }

        for (const entity of this.entities) {
            this.syncDetailFromSummary(entity);
        }
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

        const client = extensionContext?.client;
        if (!client) {
            this.luaDefinedClassNames = new Set<string>();
            return this.luaDefinedClassNames;
        }

        try {
            const entries = await client.sendRequest<LsScriptedClassEntry[] | null>('gluals/gmodScriptedClasses', {});
            this.luaDefinedClassNames = new Set(
                (entries ?? [])
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
