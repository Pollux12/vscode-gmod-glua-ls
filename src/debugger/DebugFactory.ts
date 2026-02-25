import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import { GmodDebugSession } from "./gmod_debugger/GmodDebugSession";

export class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

    createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
        if (_session.type === 'gluals_gmod') {
            return new vscode.DebugAdapterInlineImplementation(new GmodDebugSession());
        }
    }
}
