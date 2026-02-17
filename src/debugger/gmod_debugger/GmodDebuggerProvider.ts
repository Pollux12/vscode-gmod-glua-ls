import * as path from "path";
import * as vscode from "vscode";
import { DebugConfigurationBase } from "../base/DebugConfigurationBase";
import { DebuggerProvider } from "../base/DebuggerProvider";
import { GmodRealm, normalizeGmodRealm } from "./GmodDebugControlService";

export interface GmodDebugConfiguration extends DebugConfigurationBase {
    request: "attach" | "launch";
    host?: string;
    port?: number;
    sourceRoot?: string;
    sourceFileMap?: Record<string, string>;
    stopOnEntry?: boolean;
    realm?: GmodRealm;
    program?: string;
    cwd?: string;
    args?: string[];
}

export class GmodDebuggerProvider extends DebuggerProvider {
    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, configuration: GmodDebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
        configuration.extensionPath = this.context.extensionPath;
        configuration.sourcePaths = this.getSourceRoots();
        configuration.ext = this.getExt();
        configuration.type = "gluals_gmod";

        const workspaceRoot = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        configuration.sourceRoot = configuration.sourceRoot || workspaceRoot;
        configuration.host = configuration.host || "127.0.0.1";
        configuration.port = configuration.port || 21111;
        configuration.stopOnEntry = configuration.stopOnEntry ?? true;
        const configuredRealm = vscode.workspace
            .getConfiguration("gluals.gmod", folder)
            .get<string>("debugRealm");
        configuration.realm = normalizeGmodRealm(configuration.realm ?? configuredRealm);

        if (configuration.request === "launch") {
            configuration.cwd = configuration.cwd || (configuration.program ? path.dirname(configuration.program) : workspaceRoot);
            configuration.args = configuration.args || [];
        } else {
            configuration.request = "attach";
        }

        return configuration;
    }
}
