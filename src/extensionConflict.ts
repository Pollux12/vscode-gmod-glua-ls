import * as vscode from 'vscode';

export const GLUA_ENHANCED_EXTENSION_ID = 'venner.vscode-glua-enhanced';
export const GLUA_ENHANCED_CONFLICT_MESSAGE =
    'The GLua Enhanced extension is enabled and conflicts with GLuaLS. ' +
    'Please disable GLua Enhanced in the Extensions tab and restart the GLua language server.';

export interface ExtensionConflictServices {
    getExtension(extensionId: string): unknown | undefined;
}

const defaultServices: ExtensionConflictServices = {
    getExtension: (extensionId) => vscode.extensions.getExtension(extensionId),
};

export function throwIfGluaEnhancedIsEnabled(
    services: ExtensionConflictServices = defaultServices
): void {
    if (services.getExtension(GLUA_ENHANCED_EXTENSION_ID)) {
        throw new Error(GLUA_ENHANCED_CONFLICT_MESSAGE);
    }
}
