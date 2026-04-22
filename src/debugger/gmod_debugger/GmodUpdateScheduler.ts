import * as path from 'path';
import * as vscode from 'vscode';
import { GmodAnnotationManager } from '../../gmodAnnotationManager';
import { loadGmodPluginCatalog } from '../../gmodPluginCatalog';
import { GmodRdbUpdater } from './GmodRdbUpdater';
import { GmodClientRdbUpdater } from './GmodClientRdbUpdater';
import {
    getAutoDetectedClientGarrysmodPath,
    getAutoDetectedWorkspaceGarrysmodPath,
    getStoredClientGarrysmodPath,
    getStoredGarrysmodPath
} from './GmodDebugSetupWizard';

/**
 * Unified boot-time and periodic update scheduler.
 *
 * Runs once at activation and then on the annotation-update interval,
 * performing annotation, server-debugger, and client-debugger update checks
 * in sequence to avoid simultaneous notification spam.
 */
export class GmodUpdateScheduler implements vscode.Disposable {
    private static readonly MIN_INTERVAL_MINUTES = 5;
    private static readonly MAX_INTERVAL_MINUTES = 1440;

    private interval: NodeJS.Timeout | undefined;
    private checksInProgress = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly annotationManager: GmodAnnotationManager,
        private readonly rdbUpdater: GmodRdbUpdater,
        private readonly clientRdbUpdater: GmodClientRdbUpdater,
    ) {}

    /**
     * Start the scheduler: runs all checks immediately and sets up the periodic interval.
     * Call once from extension activation after all managers are initialized.
     */
    public start(): void {
        this.context.subscriptions.push(this);

        if (!this.isAutoCheckEnabled() || this.interval) {
            return;
        }

        void this.runAllChecks();
        this.scheduleInterval();
    }

    private isAutoCheckEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('gluals.gmod')
            .get<boolean>('autoCheckAnnotationUpdates', true);
    }

    private addPath(target: Map<string, string>, value: string | undefined): void {
        if (!value || value.trim().length === 0) {
            return;
        }

        let resolved = path.resolve(value.trim());
        if (resolved.endsWith(path.sep) && resolved.length > path.sep.length) {
            resolved = resolved.slice(0, -path.sep.length);
        }
        const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (!target.has(normalized)) {
            target.set(normalized, resolved);
        }
    }

    private scheduleInterval(): void {
        if (!this.isAutoCheckEnabled()) {
            return;
        }

        const config = vscode.workspace.getConfiguration('gluals.gmod');
        const configuredMinutes = config.get<number>('annotationUpdateCheckIntervalMinutes', 60);
        const minutes = Number.isFinite(configuredMinutes)
            ? Math.min(
                GmodUpdateScheduler.MAX_INTERVAL_MINUTES,
                Math.max(GmodUpdateScheduler.MIN_INTERVAL_MINUTES, Math.floor(configuredMinutes))
            )
            : 60;

        this.interval = setInterval(() => void this.runAllChecks(), minutes * 60 * 1000);
    }

    private async runAllChecks(): Promise<void> {
        if (this.checksInProgress) {
            return;
        }

        if (!this.isAutoCheckEnabled()) {
            return;
        }

        this.checksInProgress = true;
        try {
            const serverPaths = new Map<string, string>();
            const clientPaths = new Map<string, string>();

            this.addPath(serverPaths, getStoredGarrysmodPath(this.context));
            this.addPath(clientPaths, getStoredClientGarrysmodPath(this.context));

            for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
                this.addPath(serverPaths, getAutoDetectedWorkspaceGarrysmodPath(workspaceFolder));
            }

            this.addPath(clientPaths, getAutoDetectedClientGarrysmodPath());

            try {
                await this.annotationManager.checkForUpdates();
            } catch (error) {
                console.error('[GLuaLS] Annotation update check failed:', error);
            }

            try {
                await this.checkPluginUpdates();
            } catch (error) {
                console.error('[GLuaLS] Plugin update check failed:', error);
            }

            for (const serverPath of serverPaths.values()) {
                try {
                    await this.rdbUpdater.runBootTimeCheck(serverPath);
                } catch (error) {
                    console.error('[GLuaLS] Server RDB boot-time check failed:', error);
                }
            }

            for (const clientPath of clientPaths.values()) {
                try {
                    await this.clientRdbUpdater.runBootTimeCheck(clientPath);
                } catch (error) {
                    console.error('[GLuaLS] Client RDB boot-time check failed:', error);
                }
            }
        } finally {
            this.checksInProgress = false;
        }
    }

    public dispose(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    /**
     * Best-effort check for plugin annotation updates. CI stamps every plugin
     * entry in the local plugin index with a build timestamp on each release;
     * after the main annotations bundle is refreshed, locally-installed plugin
     * versions become stale relative to the new index. This surfaces a single
     * non-modal notification offering to open the settings panel where the
     * user can review and update individual plugins. No network calls.
     */
    private async checkPluginUpdates(): Promise<void> {
        const annotationPathOverride = vscode.workspace
            .getConfiguration('gluals')
            .get<string>('ls.annotationPath');
        const resolvedAnnotationPath = annotationPathOverride?.trim()
            ? annotationPathOverride.trim()
            : path.join(this.context.globalStorageUri.fsPath, 'gmod-annotations');

        const catalog = loadGmodPluginCatalog(resolvedAnnotationPath);
        const allIds = catalog.plugins.map((p) => p.id);
        if (allIds.length === 0) {
            return;
        }

        const updates = this.annotationManager.checkPluginUpdates(allIds, catalog);
        if (updates.length === 0) {
            return;
        }

        const labels = updates
            .map((id) => catalog.byId.get(id)?.label ?? id)
            .join(', ');
        const message = updates.length === 1
            ? `GLuaLS: Plugin annotation update available for ${labels}.`
            : `GLuaLS: Plugin annotation updates available for ${labels}.`;
        const action = await vscode.window.showInformationMessage(message, 'Open Settings', 'Later');
        if (action === 'Open Settings') {
            await vscode.commands.executeCommand('gluals.gmod.openSettings');
        }
    }
}
