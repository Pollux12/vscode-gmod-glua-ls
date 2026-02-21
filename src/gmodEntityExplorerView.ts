import * as vscode from 'vscode';
import {
    EntityDetail,
    EntitySummary,
    GetEntitiesResult,
    SetEntityPropertyParams,
    SetEntityPropertyValue,
    Vec3,
} from './debugger/gmod_debugger/lrdb/Client';

const ENTITY_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type EntityTreeItemData =
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
        severity: 'info' | 'warning' | 'error';
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

    constructor(private readonly getActiveSession: () => vscode.DebugSession | undefined) {}

    getTreeItem(element: EntityTreeItem): vscode.TreeItem {
        switch (element.data.kind) {
            case 'entity': {
                const { entity } = element.data;
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
                element.label = 'Load more...';
                element.iconPath = new vscode.ThemeIcon('ellipsis');
                element.contextValue = 'gmodEntityLoadMore';
                element.command = {
                    command: 'gmodEntityExplorer.loadMore',
                    title: 'Load More Entities',
                };
                return element;
            case 'info':
                element.label = element.data.message;
                element.contextValue = 'gmodEntityInfo';
                element.iconPath = new vscode.ThemeIcon(
                    element.data.severity === 'error'
                        ? 'error'
                        : element.data.severity === 'warning'
                            ? 'warning'
                            : 'info'
                );
                return element;
        }
    }

    async getChildren(element?: EntityTreeItem): Promise<EntityTreeItem[]> {
        if (!element) {
            return this.getRootItems();
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
            void this.loadEntities();
        }, SEARCH_DEBOUNCE_MS);
    }

    async loadEntities(): Promise<void> {
        await this.loadEntityPage(true);
    }

    async loadMore(): Promise<void> {
        await this.loadEntityPage(false);
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
        this.entities = [];
        this.entityDetails.clear();
        this.entityDetailErrors.clear();
        this.totalCount = 0;
        this.hasLoadedOnce = false;
        this.lastError = undefined;
        this.onDidChangeTreeDataEmitter.fire();
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    dispose(): void {
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = undefined;
        }
        this.onDidChangeTreeDataEmitter.dispose();
    }

    private async getRootItems(): Promise<EntityTreeItem[]> {
        if (!this.requireActiveSession()) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: 'Connect debugger to see entities.',
                    severity: 'info',
                }),
            ];
        }

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

        const items = this.entities.map((entity) => new EntityTreeItem({ kind: 'entity', entity }));

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
        const existingError = this.entityDetailErrors.get(entity.index);
        if (existingError) {
            return [
                new EntityTreeItem({
                    kind: 'info',
                    message: existingError,
                    severity: 'error',
                }),
            ];
        }

        if (!this.entityDetails.has(entity.index) && !this.loadingDetails.has(entity.index)) {
            this.loadingDetails.add(entity.index);
            try {
                const detail = await this.sendRequest<EntityDetail>('gmod.entity.getEntity', { index: entity.index });
                this.entityDetails.set(entity.index, detail);
                this.entityDetailErrors.delete(entity.index);
            } catch (error) {
                this.entityDetailErrors.set(entity.index, this.humanizeLoadError(this.extractErrorMessage(error)));
            } finally {
                this.loadingDetails.delete(entity.index);
            }
        }

        if (this.loadingDetails.has(entity.index)) {
            return [
                new EntityTreeItem({
                    kind: 'info',
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
                editable: detail.health <= 0,
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

    private async loadEntityPage(reset: boolean): Promise<void> {
        const session = this.requireActiveSession();
        if (!session) {
            this.clear();
            return;
        }

        if (this.loading) {
            return;
        }

        this.loading = true;
        if (reset) {
            this.entities = [];
            this.entityDetails.clear();
            this.entityDetailErrors.clear();
            this.totalCount = 0;
            this.lastError = undefined;
        }
        this.onDidChangeTreeDataEmitter.fire();

        try {
            const params = this.buildEntityQuery(reset ? 0 : this.entities.length);
            const result = await this.sendRequest<GetEntitiesResult>('gmod.entity.getEntities', params);
            if (reset) {
                this.entities = result.entities;
            } else {
                this.appendEntities(result.entities);
            }
            this.totalCount = result.total;
            this.hasLoadedOnce = true;
            this.lastError = undefined;
        } catch (error) {
            this.lastError = this.humanizeLoadError(this.extractErrorMessage(error));
            if (reset) {
                this.entities = [];
                this.totalCount = 0;
            }
            this.hasLoadedOnce = true;
        } finally {
            this.loading = false;
            this.onDidChangeTreeDataEmitter.fire();
        }
    }

    private appendEntities(items: EntitySummary[]): void {
        const seen = new Set(this.entities.map((entity) => entity.index));
        for (const entity of items) {
            if (!seen.has(entity.index)) {
                this.entities.push(entity);
                seen.add(entity.index);
            }
        }
    }

    private buildEntityQuery(offset: number): { offset: number; limit: number; filter_id: number; filter_class: string } {
        const trimmed = this.filterText.trim();
        const numericFilter = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
        const filterClass = numericFilter > 0 ? '' : trimmed;

        return {
            offset,
            limit: ENTITY_PAGE_SIZE,
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
