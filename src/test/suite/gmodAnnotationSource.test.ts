import * as assert from 'assert';

import { getExtensionChannel } from '../../extensionChannel';
import {
    buildAnnotationSourceWarning,
    normalizeBranch,
    normalizeCommit,
    resolveAnnotationSource,
} from '../../gmodAnnotationSource';

suite('GMod Annotation Source', () => {
    test('extension channel defaults to a valid generated value', () => {
        assert.ok(getExtensionChannel() === 'stable' || getExtensionChannel() === 'prerelease');
    });

    test('auto channel follows build channel', () => {
        const source = resolveAnnotationSource({
            repository: 'Pollux12/annotations-gmod-glua-ls',
            buildChannel: 'prerelease',
            channel: 'auto',
            hasExplicitBranch: false,
            branch: 'gluals-annotations',
            commit: '',
        });

        assert.strictEqual(source.mode, 'branch');
        assert.strictEqual(source.branch, 'gluals-annotations-prerelease');
        assert.strictEqual(source.sourceId, 'Pollux12/annotations-gmod-glua-ls:gluals-annotations-prerelease');
    });

    test('commit pin takes precedence over branch and channel', () => {
        const source = resolveAnnotationSource({
            repository: 'Pollux12/annotations-gmod-glua-ls',
            buildChannel: 'stable',
            channel: 'prerelease',
            hasExplicitBranch: true,
            branch: 'feature/custom',
            commit: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12',
        });

        assert.strictEqual(source.mode, 'commit');
        assert.strictEqual(source.commit, 'abcdef1234567890abcdef1234567890abcdef12');
        assert.strictEqual(source.autoUpdates, false);
        assert.strictEqual(source.zipUrl, 'https://github.com/Pollux12/annotations-gmod-glua-ls/archive/abcdef1234567890abcdef1234567890abcdef12.zip');
    });

    test('rejects plugin artifact branches as branch overrides', () => {
        assert.strictEqual(normalizeBranch('gluals-annotations-plugin-foo', 'fallback-branch'), 'fallback-branch');
        assert.strictEqual(normalizeBranch('gluals-annotations-prerelease-plugin-foo', 'fallback-branch'), 'fallback-branch');
    });

    test('validates full commit sha pins', () => {
        assert.strictEqual(normalizeCommit('abc123'), '');
        assert.strictEqual(normalizeCommit('ABCDEF1234567890ABCDEF1234567890ABCDEF12'), 'abcdef1234567890abcdef1234567890abcdef12');
    });

    test('warns when commit pin is active', () => {
        const config = {
            repository: 'Pollux12/annotations-gmod-glua-ls',
            buildChannel: 'stable' as const,
            channel: 'auto' as const,
            hasExplicitBranch: false,
            branch: 'gluals-annotations',
            commit: 'abcdef1234567890abcdef1234567890abcdef12',
        };
        const warning = buildAnnotationSourceWarning(config, resolveAnnotationSource(config));

        assert.ok(warning?.includes('disable automatic annotation updates'));
    });
});
