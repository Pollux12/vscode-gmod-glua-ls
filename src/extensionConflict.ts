import * as vscode from 'vscode';

export const GLUA_ENHANCED_EXTENSION_ID = 'venner.vscode-glua-enhanced';
export const GLUA_ENHANCED_CONFLICT_MESSAGE =
    'Conflict detected: GLua Enhanced is enabled and conflicts with GLuaLS. ' +
    'It can break language-server features and make GLuaLS appear faulty. ' +
    'Disable GLua Enhanced before starting the GLua Language Server.';

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
