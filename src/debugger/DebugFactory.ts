import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import { GmodDebugSession } from "./gmod_debugger/GmodDebugSession";
import { GmodClientDebugSession } from "./gmod_debugger/GmodClientDebugSession";

export class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

    createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
        if (_session.type === 'gluals_gmod') {
            return new vscode.DebugAdapterInlineImplementation(new GmodDebugSession());
        } else if (_session.type === 'gluals_gmod_client') {
            return new vscode.DebugAdapterInlineImplementation(new GmodClientDebugSession());
        }
    }
}
