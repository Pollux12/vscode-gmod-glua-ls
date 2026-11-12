import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    claudeCodeCommand,
    claudeCodeEntry,
    codexTomlBlock,
    CodexTomlUnsupportedError,
    cursorEntry,
    genericJsonSnippet,
    MCP_SERVER_NAME,
    mcpUrl,
    mergeCodexToml,
    mergeJsonServerConfig,
    vscodeEntry,
} from './clientSetup';
import { DiagnosticsWatcher } from './codeTools';
import { GmodDebugBridge } from './debugBridge';
import { McpHttpServer } from './mcpHttpServer';
import { McpToolSettings, releaseAgentState } from './runtimeTools';
import { buildMcpTools, MCP_INSTRUCTIONS } from './tools';

export const MCP_SETTINGS_SECTION = 'gluals.mcp';
export const DEFAULT_MCP_PORT = 21120;
const PROVIDER_ID = 'gluals.mcp';
const SERVER_LABEL = 'GLuaLS (GMod server)';

export const MCP_SETTING_KEYS = ['enabled', 'port', 'allowCodeExecution', 'autoAttach'] as const;
export type McpSettingKey = (typeof MCP_SETTING_KEYS)[number];

export type McpHostStatus =
    | { kind: 'disabled' }
    | { kind: 'untrusted' }
    | { kind: 'running'; port: number }
    | { kind: 'error'; port: number; message: string };

/** Pieces of the VS Code and Cursor MCP APIs that are newer than this extension's @types/vscode. */
interface McpDefinitionApi {
    registerMcpServerDefinitionProvider?(id: string, provider: unknown): vscode.Disposable;
}
interface CursorMcpApi {
    registerServer(config: { name: string; server: { url: string; headers?: Record<string, string> } }): void;
    unregisterServer(name: string): void;
}

function readSettings(): { enabled: boolean; port: number } & McpToolSettings {
    const config = vscode.workspace.getConfiguration(MCP_SETTINGS_SECTION);
    const port = config.get<number>('port', DEFAULT_MCP_PORT);
    return {
        enabled: config.get<boolean>('enabled', false),
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_MCP_PORT,
        allowCodeExecution: config.get<boolean>('allowCodeExecution', true),
        autoAttach: config.get<boolean>('autoAttach', true),
    };
}

let activeHost: GmodMcpHost | undefined;

/** The running host, for UI such as the GLuaLS settings panel. */
export function getMcpHost(): GmodMcpHost | undefined {
    return activeHost;
}

/** A one-line description of the host's state for UI. */
export function describeMcpStatus(status: McpHostStatus): string {
    switch (status.kind) {
        case 'disabled':
            return 'Off';
        case 'untrusted':
            return 'Waiting for workspace trust';
        case 'running':
            return `Running at ${mcpUrl(status.port)}`;
        case 'error':
            return status.message;
    }
}

/**
 * Hosts the GLuaLS MCP server while `gluals.mcp.enabled` is on in a trusted workspace,
 * and tells VS Code (Copilot) and Cursor about it so they need no manual setup.
 */
export class GmodMcpHost implements vscode.Disposable {
    private server?: McpHttpServer;
    private bridge?: GmodDebugBridge;
    private watcher?: DiagnosticsWatcher;
    private status: McpHostStatus = { kind: 'disabled' };
    private readonly statusBar: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly definitionsChanged = new vscode.EventEmitter<void>();
    private readonly statusChanged = new vscode.EventEmitter<McpHostStatus>();
    private cursorRegistered = false;
    private applying: Promise<void> = Promise.resolve();

    readonly onDidChangeStatus = this.statusChanged.event;

    constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
        this.statusBar = vscode.window.createStatusBarItem('gluals.mcp.status', vscode.StatusBarAlignment.Right, 90);
        this.statusBar.name = 'GLuaLS MCP';
        this.statusBar.command = 'gluals.mcp.setup';
        this.disposables.push(
            this.statusBar,
            this.definitionsChanged,
            this.statusChanged,
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(MCP_SETTINGS_SECTION)) {
                    this.apply();
                }
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.apply()),
            vscode.commands.registerCommand('gluals.mcp.setup', () => this.showSetupMenu()),
            vscode.commands.registerCommand('gluals.mcp.copyUrl', () => this.copy(mcpUrl(this.port), 'MCP server URL')),
        );
        this.registerVsCodeProvider();
        activeHost = this;
        this.apply();
    }

    /** Turns the server on or off in this workspace's settings. */
    async setEnabled(enabled: boolean): Promise<void> {
        await this.updateSetting('enabled', enabled);
    }

    /** Writes one gluals.mcp setting for this workspace; `undefined` removes it (back to the default). */
    async updateSetting(key: McpSettingKey, value: boolean | number | undefined): Promise<void> {
        const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration(MCP_SETTINGS_SECTION).update(key, value, target);
        await this.apply();
    }

    get settings(): { enabled: boolean; port: number; allowCodeExecution: boolean; autoAttach: boolean } {
        return readSettings();
    }

    get port(): number {
        return this.status.kind === 'running' || this.status.kind === 'error' ? this.status.port : readSettings().port;
    }

    get currentStatus(): McpHostStatus {
        return this.status;
    }

    dispose(): void {
        if (activeHost === this) {
            activeHost = undefined;
        }
        void this.stop();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
    }

    /** Starts, restarts or stops the server to match the settings. Calls are serialised. */
    apply(): Promise<void> {
        this.applying = this.applying.then(() => this.applyNow()).catch((error) => {
            this.output.appendLine(`[MCP] ${error instanceof Error ? error.message : String(error)}`);
        });
        return this.applying;
    }

    private async applyNow(): Promise<void> {
        const settings = readSettings();
        if (!settings.enabled) {
            await this.stop();
            this.setStatus({ kind: 'disabled' });
            return;
        }
        if (!vscode.workspace.isTrusted) {
            await this.stop();
            this.setStatus({ kind: 'untrusted' });
            return;
        }
        if (this.server && this.status.kind === 'running' && this.status.port === settings.port) {
            return;
        }
        // A port change restarts only the HTTP server. The bridge keeps the console and error log and
        // remembers which breakpoints the agent set, so its clear and detach still find them.
        await this.stopServer();

        this.bridge ??= new GmodDebugBridge((message) => this.output.appendLine(`[MCP] ${message}`));
        this.watcher ??= new DiagnosticsWatcher();
        const bridge = this.bridge;
        const tools = buildMcpTools({ bridge, settings: () => readSettings() }, this.watcher);
        const server = new McpHttpServer({
            info: { name: MCP_SERVER_NAME, title: SERVER_LABEL, version: String(this.context.extension.packageJSON.version ?? '0.0.0') },
            instructions: MCP_INSTRUCTIONS,
            tools: () => tools,
            log: (message) => this.output.appendLine(`[MCP] ${message}`),
        });
        try {
            await server.start(settings.port);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const message = code === 'EADDRINUSE'
                ? `Port ${settings.port} is already in use. Choose another in gluals.mcp.port.`
                : `Could not start the MCP server on port ${settings.port}: ${error instanceof Error ? error.message : String(error)}`;
            this.output.appendLine(`[MCP] ${message}`);
            this.setStatus({ kind: 'error', port: settings.port, message });
            void vscode.window.showWarningMessage(`GLuaLS MCP: ${message}`);
            return;
        }
        this.server = server;
        this.output.appendLine(`[MCP] Listening on ${mcpUrl(settings.port)}`);
        this.registerCursor(settings.port);
        this.setStatus({ kind: 'running', port: settings.port });
    }

    /** Stops the HTTP server only. */
    private async stopServer(): Promise<void> {
        this.unregisterCursor();
        const server = this.server;
        this.server = undefined;
        if (server) {
            await server.stop();
            this.output.appendLine('[MCP] Stopped.');
        }
    }

    /** Stops everything: the server, the debug bridge and the diagnostics watcher. */
    private async stop(): Promise<void> {
        await this.stopServer();
        const bridge = this.bridge;
        this.bridge = undefined;
        if (bridge) {
            // The ownership records go with the bridge, so remove the agent's breakpoints, traces and
            // debug session now; afterwards nothing could tell them apart from the user's.
            await releaseAgentState({ bridge, settings: () => readSettings() }, false).catch((error) => {
                this.output.appendLine(`[MCP] Cleanup: ${error instanceof Error ? error.message : String(error)}`);
            });
            bridge.dispose();
        }
        this.watcher?.dispose();
        this.watcher = undefined;
    }

    private setStatus(status: McpHostStatus): void {
        this.status = status;
        this.definitionsChanged.fire();
        this.statusChanged.fire(status);
        switch (status.kind) {
            case 'disabled':
                this.statusBar.hide();
                return;
            case 'untrusted':
                this.statusBar.text = '$(shield) GLuaLS MCP';
                this.statusBar.tooltip = 'The GLuaLS MCP server needs a trusted workspace.';
                break;
            case 'running':
                this.statusBar.text = '$(plug) GLuaLS MCP';
                this.statusBar.tooltip = `GLuaLS MCP server running at ${mcpUrl(status.port)}\nClick to connect an AI agent.`;
                break;
            case 'error':
                this.statusBar.text = '$(warning) GLuaLS MCP';
                this.statusBar.tooltip = status.message;
                break;
        }
        this.statusBar.show();
    }

    /** Copilot and other VS Code chat clients pick the server up from here, with no config file. */
    private registerVsCodeProvider(): void {
        const lm = (vscode as unknown as { lm?: McpDefinitionApi }).lm;
        const Definition = (vscode as unknown as { McpHttpServerDefinition?: new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => unknown }).McpHttpServerDefinition;
        if (!lm?.registerMcpServerDefinitionProvider || !Definition) {
            return;
        }
        try {
            this.disposables.push(lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
                onDidChangeMcpServerDefinitions: this.definitionsChanged.event,
                provideMcpServerDefinitions: () => this.status.kind === 'running'
                    ? [new Definition(SERVER_LABEL, vscode.Uri.parse(mcpUrl(this.status.port)), {}, String(this.context.extension.packageJSON.version ?? '0'))]
                    : [],
            }));
        } catch (error) {
            this.output.appendLine(`[MCP] Could not register with VS Code's MCP support: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private cursorApi(): CursorMcpApi | undefined {
        return (vscode as unknown as { cursor?: { mcp?: CursorMcpApi } }).cursor?.mcp;
    }

    private registerCursor(port: number): void {
        const api = this.cursorApi();
        if (!api) {
            return;
        }
        try {
            api.registerServer({ name: MCP_SERVER_NAME, server: { url: mcpUrl(port) } });
            this.cursorRegistered = true;
        } catch (error) {
            this.output.appendLine(`[MCP] Could not register with Cursor: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private unregisterCursor(): void {
        if (!this.cursorRegistered) {
            return;
        }
        this.cursorRegistered = false;
        try {
            this.cursorApi()?.unregisterServer(MCP_SERVER_NAME);
        } catch {
            // nothing to undo
        }
    }

    private async copy(text: string, what: string): Promise<void> {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage(`Copied the ${what} to the clipboard.`);
    }

    private async enable(): Promise<boolean> {
        if (!readSettings().enabled) {
            await this.setEnabled(true);
        }
        return this.status.kind === 'running';
    }

    async showSetupMenu(): Promise<void> {
        type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
        const settings = readSettings();
        const port = settings.port;
        const folder = vscode.workspace.workspaceFolders?.[0];
        const inCursor = this.cursorApi() !== undefined;
        const items: Item[] = [];

        const connectsAutomatically = (client: string, detail: string): Item => settings.enabled
            ? { label: `$(check) ${client}: connected automatically`, detail }
            : {
                label: `$(sparkle) ${client}: available once enabled`,
                detail: `Enables the server. ${detail}`,
                run: async () => {
                    if (this.status.kind === 'running') {
                        void vscode.window.showInformationMessage(`GLuaLS MCP server enabled; ${client} connects to it automatically.`);
                    }
                },
            };

        if (!settings.enabled) {
            items.push({
                label: '$(play) Enable the GLuaLS MCP server',
                detail: 'Lets AI agents run Lua on your GMod server, read its console and errors, and debug it.',
                run: async () => {
                    if (await this.enable()) {
                        void vscode.window.showInformationMessage(`GLuaLS MCP server running at ${mcpUrl(this.port)}.`);
                        await this.showSetupMenu();
                    }
                },
            });
        } else {
            const state = this.status.kind === 'running' ? `Running at ${mcpUrl(this.status.port)}` : this.status.kind === 'error' ? this.status.message : 'Waiting for workspace trust';
            items.push({ label: '$(info) Status', detail: state, run: async () => this.output.show(true) });
        }

        items.push({ label: 'Connect an agent', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(sparkle) Claude Code: add to this project',
            detail: 'Adds it to .mcp.json. Claude Code asks you to approve it once.',
            run: async () => this.writeJsonConfig(folder, '.mcp.json', 'mcpServers', claudeCodeEntry(port), 'Claude Code'),
        });
        items.push({
            label: '$(terminal) Claude Code: copy the "claude mcp add" command',
            detail: claudeCodeCommand(port),
            run: async () => this.copy(claudeCodeCommand(port), 'Claude Code command'),
        });
        items.push({
            label: '$(sparkle) Codex: add to your Codex config',
            detail: '~/.codex/config.toml',
            run: async () => this.writeCodexConfig(port),
        });
        items.push(inCursor
            ? connectsAutomatically('Cursor', 'Nothing to set up.')
            : {
                label: '$(sparkle) Cursor: add to this project',
                detail: 'Adds it to .cursor/mcp.json.',
                run: async () => this.writeJsonConfig(folder, path.join('.cursor', 'mcp.json'), 'mcpServers', cursorEntry(port), 'Cursor'),
            });
        const hasProvider = typeof (vscode as unknown as { lm?: McpDefinitionApi }).lm?.registerMcpServerDefinitionProvider === 'function';
        items.push(hasProvider
            ? connectsAutomatically('GitHub Copilot', `Listed as "${SERVER_LABEL}" in VS Code's MCP servers.`)
            : {
                label: '$(sparkle) GitHub Copilot: add to this project',
                detail: 'Adds it to .vscode/mcp.json.',
                run: async () => this.writeJsonConfig(folder, path.join('.vscode', 'mcp.json'), 'servers', vscodeEntry(port), 'VS Code'),
            });
        items.push({
            label: '$(clippy) Other client: copy JSON config',
            detail: mcpUrl(port),
            run: async () => this.copy(genericJsonSnippet(port), 'MCP JSON config'),
        });
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: '$(gear) Open MCP settings', run: async () => { await vscode.commands.executeCommand('workbench.action.openSettings', MCP_SETTINGS_SECTION); } });

        const picked = await vscode.window.showQuickPick(items, { title: 'GLuaLS: Set Up AI Agent (MCP)', placeHolder: 'Choose your AI agent' });
        if (!picked?.run) {
            return;
        }
        if (!readSettings().enabled && !picked.label.includes('Enable') && !picked.label.includes('settings')) {
            await this.enable();
        }
        await picked.run();
    }

    private async writeJsonConfig(folder: vscode.WorkspaceFolder | undefined, relative: string, key: 'mcpServers' | 'servers', entry: Record<string, unknown>, client: string): Promise<void> {
        if (!folder) {
            void vscode.window.showWarningMessage('Open a workspace folder first.');
            return;
        }
        const file = path.join(folder.uri.fsPath, relative);
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
        let merged: string;
        try {
            merged = mergeJsonServerConfig(existing, key, MCP_SERVER_NAME, entry);
        } catch {
            await this.copy(JSON.stringify({ [key]: { [MCP_SERVER_NAME]: entry } }, null, 2), `${client} config (${relative} could not be parsed, so add it by hand)`);
            return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, merged, 'utf8');
        const open = await vscode.window.showInformationMessage(`Added to ${relative}. Restart ${client} to connect.`, 'Open File');
        if (open) {
            await vscode.window.showTextDocument(vscode.Uri.file(file));
        }
    }

    private async writeCodexConfig(port: number): Promise<void> {
        const home = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0 ? process.env.CODEX_HOME : path.join(os.homedir(), '.codex');
        const file = path.join(home, 'config.toml');
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
        let merged: string;
        try {
            merged = mergeCodexToml(existing, port);
        } catch (error) {
            if (!(error instanceof CodexTomlUnsupportedError)) {
                throw error;
            }
            await this.copy(codexTomlBlock(port), `Codex config (${file} already has a ${MCP_SERVER_NAME} entry setup cannot edit, so update it by hand)`);
            return;
        }
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(file, merged, 'utf8');
        const open = await vscode.window.showInformationMessage(`Added to ${file}. Restart Codex to connect.`, 'Open File');
        if (open) {
            await vscode.window.showTextDocument(vscode.Uri.file(file));
        }
    }
}
