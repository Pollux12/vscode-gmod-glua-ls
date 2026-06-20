import { GENERATED_EXTENSION_CHANNEL } from './generated/extensionChannel';

export type ExtensionChannel = 'stable' | 'prerelease';

export function getExtensionChannel(): ExtensionChannel {
    const channel: string = GENERATED_EXTENSION_CHANNEL;
    return channel === 'stable' ? 'stable' : 'prerelease';
}
