import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import { EmmyNewDebugSession } from './new_debugger/EmmyNewDebugSession';
import { EmmyAttachDebugSession } from './attach/EmmyAttachDebugSession';
import { EmmyLaunchDebugSession } from './launch/EmmyLaunchDebugSession';
import { GmodDebugSession } from "./gmod_debugger/GmodDebugSession";

export class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

    createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
        switch (_session.type) {
            case 'emmylua_attach': {
                return new vscode.DebugAdapterInlineImplementation(new EmmyAttachDebugSession());
            }
            case 'emmylua_launch': {
                return new vscode.DebugAdapterInlineImplementation(new EmmyLaunchDebugSession());
            }
            case 'emmylua_new': {
                return new vscode.DebugAdapterInlineImplementation(new EmmyNewDebugSession());
            }
            case "emmylua_gmod": {
                return new vscode.DebugAdapterInlineImplementation(new GmodDebugSession());
            }
        }
        
    }
}
