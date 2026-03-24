import * as vscode from "vscode";
import { extensionContext } from "../extension";
import { InlineDebugAdapterFactory } from "./DebugFactory";
import { GmodDebuggerProvider } from "./gmod_debugger/GmodDebuggerProvider";
import { GmodClientDebuggerProvider } from "./gmod_debugger/GmodClientDebuggerProvider";


/**
 * Debugger configuration interface
 */
interface DebuggerConfig {
    readonly type: string;
    readonly provider: vscode.DebugConfigurationProvider;
}


export function registerDebuggers(): void {
    const context = extensionContext.vscodeContext;

    const debuggerConfigs: DebuggerConfig[] = [
        { type: "gluals_gmod", provider: new GmodDebuggerProvider("gluals_gmod", context) },
        { type: "gluals_gmod_client", provider: new GmodClientDebuggerProvider("gluals_gmod_client", context) },
    ];

    debuggerConfigs.forEach(({ type, provider }) => {
        context.subscriptions.push(
            vscode.debug.registerDebugConfigurationProvider(type, provider)
        );

        context.subscriptions.push(provider as vscode.Disposable);
    });

    if (extensionContext.debugMode) {
        const factory = new InlineDebugAdapterFactory();
        debuggerConfigs.forEach(({ type }) => {
            context.subscriptions.push(
                vscode.debug.registerDebugAdapterDescriptorFactory(type, factory)
            );
        });
    }
}
