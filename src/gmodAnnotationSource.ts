import type { ExtensionChannel } from './extensionChannel';

export type AnnotationChannel = 'auto' | ExtensionChannel;

export interface AnnotationSourceConfig {
    readonly repository: string;
    readonly buildChannel: ExtensionChannel;
    readonly channel: AnnotationChannel;
    readonly hasExplicitBranch: boolean;
    readonly branch: string;
    readonly commit: string;
}

export interface AnnotationSource {
    readonly repository: string;
    readonly sourceId: string;
    readonly zipUrl: string;
    readonly metadataUrl: string;
    readonly autoUpdates: boolean;
    readonly mode: 'branch' | 'commit';
    readonly branch?: string;
    readonly commit?: string;
    readonly effectiveChannel?: ExtensionChannel;
}

const STABLE_BRANCH = 'gluals-annotations';
const PRERELEASE_BRANCH = 'gluals-annotations-prerelease';
const PLUGIN_ARTIFACT_BRANCH_PREFIXES = [
    'gluals-annotations-plugin-',
    'gluals-annotations-prerelease-plugin-',
] as const;

function encodeGitHubRefPath(ref: string): string {
    return ref.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
}

function resolveEffectiveChannel(channel: AnnotationChannel, buildChannel: ExtensionChannel): ExtensionChannel {
    return channel === 'auto' ? buildChannel : channel;
}

export function normalizeGitHubRepository(configuredRepository: string, fallbackRepository: string): string {
    const normalizedConfiguredRepository = normalizeNonEmptyString(configuredRepository);
    if (!normalizedConfiguredRepository) {
        return fallbackRepository;
    }

    let repository = normalizedConfiguredRepository
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/^github\.com\//i, '')
        .replace(/^git@github\.com:/i, '')
        .replace(/\/tree\/.*$/i, '')
        .replace(/\/+$/g, '')
        .replace(/\.git$/i, '');

    const parts = repository.split('/').filter(Boolean);
    if (parts.length >= 2) {
        repository = `${parts[0]}/${parts[1]}`;
    }

    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
        ? repository
        : fallbackRepository;
}

export function isPluginArtifactBranch(branch: string): boolean {
    const normalizedBranch = branch.toLowerCase();
    return PLUGIN_ARTIFACT_BRANCH_PREFIXES.some((prefix) => normalizedBranch.startsWith(prefix));
}

export function normalizeBranch(configuredBranch: string, fallbackBranch: string): string {
    const normalizedConfiguredBranch = normalizeNonEmptyString(configuredBranch);
    if (!normalizedConfiguredBranch) {
        return fallbackBranch;
    }

    const branch = normalizedConfiguredBranch.replace(/^refs\/heads\//i, '').replace(/^\/+|\/+$/g, '');
    if (!branch || /\s|\\/.test(branch) || isPluginArtifactBranch(branch)) {
        return fallbackBranch;
    }

    return branch;
}

export function normalizeAnnotationChannel(configuredChannel: string | undefined): AnnotationChannel {
    return configuredChannel === 'stable' || configuredChannel === 'prerelease' || configuredChannel === 'auto'
        ? configuredChannel
        : 'auto';
}

export function normalizeCommit(configuredCommit: string | undefined): string {
    const commit = normalizeNonEmptyString(configuredCommit);
    return commit && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : '';
}

export function getChannelBranch(channel: ExtensionChannel): string {
    return channel === 'stable' ? STABLE_BRANCH : PRERELEASE_BRANCH;
}

export function resolveAnnotationSource(config: AnnotationSourceConfig): AnnotationSource {
    const repository = config.repository;
    const commit = normalizeCommit(config.commit);
    if (commit) {
        return {
            repository,
            mode: 'commit',
            commit,
            sourceId: `${repository}@${commit}`,
            zipUrl: `https://github.com/${repository}/archive/${commit}.zip`,
            metadataUrl: `https://raw.githubusercontent.com/${repository}/${commit}/__metadata.json`,
            autoUpdates: false,
        };
    }

    const branch = config.hasExplicitBranch
        ? normalizeBranch(config.branch, STABLE_BRANCH)
        : getChannelBranch(resolveEffectiveChannel(config.channel, config.buildChannel));
    const encodedBranchPath = encodeGitHubRefPath(branch);

    return {
        repository,
        mode: 'branch',
        branch,
        effectiveChannel: branch === STABLE_BRANCH ? 'stable' : branch === PRERELEASE_BRANCH ? 'prerelease' : undefined,
        sourceId: `${repository}:${branch}`,
        zipUrl: `https://github.com/${repository}/archive/refs/heads/${encodedBranchPath}.zip`,
        metadataUrl: `https://raw.githubusercontent.com/${repository}/${encodedBranchPath}/__metadata.json`,
        autoUpdates: true,
    };
}

export function describeAnnotationSource(source: AnnotationSource): string {
    return source.mode === 'commit'
        ? `${source.repository}@${source.commit}`
        : `${source.repository}:${source.branch}`;
}

export function buildAnnotationSourceWarning(config: AnnotationSourceConfig, source: AnnotationSource): string | undefined {
    const commit = normalizeCommit(config.commit);
    if (commit) {
        return `Using pinned GMod annotations commit (${describeAnnotationSource(source)}) from settings ("gluals.gmod.annotationsCommit"). Automatic updates are turned off and annotations may not match your GLuaLS version.`;
    }

    if (config.hasExplicitBranch) {
        return `Using custom GMod annotations branch (${describeAnnotationSource(source)}) from settings ("gluals.gmod.annotationsBranch"). This overrides automatic updates and may not match your GLuaLS version.`;
    }

    const channel = normalizeAnnotationChannel(config.channel);
    if (channel !== 'auto' && channel !== config.buildChannel) {
        return `Using '${channel}' annotations on the '${config.buildChannel}' extension build ("gluals.gmod.annotationsChannel"). Annotations may not match your GLuaLS version.`;
    }

    return undefined;
}
