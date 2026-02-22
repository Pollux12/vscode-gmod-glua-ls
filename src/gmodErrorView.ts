import * as vscode from 'vscode';

export type GmodErrorSource = 'lua' | 'console';

export interface GmodErrorNotificationParams {
    message: string;
    fingerprint: string;
    count: number;
    source: GmodErrorSource;
    stackTrace?: string[];
}

export interface GmodError {
    message: string;
    fingerprint: string;
    count: number;
    source: GmodErrorSource;
    stackTrace?: string[];
    firstSeen: Date;
    lastSeen: Date;
}

export class GmodErrorStore implements vscode.Disposable {
    private readonly errors = new Map<string, GmodError>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();

    readonly onDidChange = this.changeEmitter.event;

    addError(params: GmodErrorNotificationParams): void {
        const now = new Date();
        const safeCount = Number.isFinite(params.count) ? Math.max(1, Math.floor(params.count)) : 1;
        const existing = this.errors.get(params.fingerprint);
        if (existing) {
            existing.message = params.message;
            existing.source = params.source;
            existing.count = Math.max(existing.count, safeCount);
            existing.lastSeen = now;
            this.changeEmitter.fire();
            return;
        }

        this.errors.set(params.fingerprint, {
            message: params.message,
            fingerprint: params.fingerprint,
            count: safeCount,
            source: params.source,
            stackTrace: params.stackTrace ?? [],
            firstSeen: now,
            lastSeen: now,
        });
        this.changeEmitter.fire();
    }

    clear(): void {
        if (this.errors.size === 0) {
            return;
        }
        this.errors.clear();
        this.changeEmitter.fire();
    }

    getAll(): GmodError[] {
        return [...this.errors.values()].sort((left, right) => right.lastSeen.getTime() - left.lastSeen.getTime());
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}

export class GmodErrorTreeItem extends vscode.TreeItem {
    constructor(public readonly error: GmodError) {
        super(
            `[${error.count}x] ${error.message}`,
            error.stackTrace && error.stackTrace.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        this.description = error.source;
        this.contextValue = 'gmodError';
        this.iconPath = new vscode.ThemeIcon('warning');
        this.tooltip = [
            error.message,
            `Source: ${error.source}`,
            `Fingerprint: ${error.fingerprint}`,
            `First seen: ${error.firstSeen.toLocaleString()}`,
            `Last seen: ${error.lastSeen.toLocaleString()}`,
        ].join('\n');
    }
}

export class GmodErrorFrameItem extends vscode.TreeItem {
    constructor(public readonly frame: string) {
        super(frame, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'gmodErrorFrame';
        this.iconPath = new vscode.ThemeIcon('list-tree');
        this.tooltip = frame;
    }
}

export class GmodErrorViewProvider implements vscode.TreeDataProvider<GmodErrorTreeItem | GmodErrorFrameItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GmodErrorTreeItem | GmodErrorFrameItem | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    private readonly storeSubscription: vscode.Disposable;

    constructor(private readonly store: GmodErrorStore) {
        this.storeSubscription = this.store.onDidChange(() => this.refresh());
    }

    getTreeItem(element: GmodErrorTreeItem | GmodErrorFrameItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: GmodErrorTreeItem | GmodErrorFrameItem): Array<GmodErrorTreeItem | GmodErrorFrameItem> {
        if (!element) {
            return this.store.getAll().map((error) => new GmodErrorTreeItem(error));
        }

        if (element instanceof GmodErrorTreeItem) {
            const stackTrace = element.error.stackTrace ?? [];
            if (stackTrace.length > 0) {
                return stackTrace.map((frame) => new GmodErrorFrameItem(frame));
            }
        }

        return [];
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    clear(): void {
        this.store.clear();
    }

    dispose(): void {
        this.storeSubscription.dispose();
        this.onDidChangeTreeDataEmitter.dispose();
    }
}

export function registerGmodErrorView(context: vscode.ExtensionContext): {
    store: GmodErrorStore;
    provider: GmodErrorViewProvider;
    treeView: vscode.TreeView<GmodErrorTreeItem | GmodErrorFrameItem>;
} {
    const store = new GmodErrorStore();
    const provider = new GmodErrorViewProvider(store);
    const treeView = vscode.window.createTreeView('gmodErrors', {
        treeDataProvider: provider,
        showCollapseAll: false,
    });

    context.subscriptions.push(store, provider, treeView);
    return { store, provider, treeView };
}
