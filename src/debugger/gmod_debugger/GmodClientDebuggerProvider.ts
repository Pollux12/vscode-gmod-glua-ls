import * as vscode from "vscode";
import { DebugConfigurationBase } from "../base/DebugConfigurationBase";
import { DebuggerProvider } from "../base/DebuggerProvider";

export interface GmodClientDebugConfiguration extends DebugConfigurationBase {
    request: "attach";
    host?: string;
    port?: number;
    sourceRoot?: string;
    sourceFileMap?: Record<string, string>;
    stopOnEntry?: boolean;
    stopOnError?: boolean;
}

export class GmodClientDebuggerProvider extends DebuggerProvider {
    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, configuration: GmodClientDebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
        configuration.extensionPath = this.context.extensionPath;
        configuration.sourcePaths = this.getSourceRoots();
        configuration.ext = this.getExt();
        configuration.type = "gluals_gmod_client";
        configuration.request = "attach";

        const workspaceRoot = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        configuration.sourceRoot = configuration.sourceRoot || workspaceRoot;
        configuration.host = configuration.host || "127.0.0.1";
        configuration.port = configuration.port || 21112;
        configuration.stopOnEntry = configuration.stopOnEntry ?? true;

        return configuration;
    }
}
