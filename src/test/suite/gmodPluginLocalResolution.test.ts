import * as assert from 'assert';
import * as path from 'path';
import { getLocalPluginBundleCandidates } from '../../gmodAnnotationManager';

suite('GMod Plugin Local Resolution', () => {
    test('prefers explicit plugin bundle override before annotation override candidates', () => {
        const pluginBundleRoot = path.join('tmp', 'plugin-bundles');
        const annotationRoot = path.join('tmp', 'annotations-output');
        const candidates = getLocalPluginBundleCandidates({
            pluginId: 'darkrp',
            pluginBundlePathOverride: pluginBundleRoot,
            annotationPathOverride: annotationRoot,
        });

        assert.deepStrictEqual(candidates, [
            path.resolve(pluginBundleRoot, 'darkrp'),
            path.resolve(path.join('tmp', 'annotations-output-plugins'), 'darkrp'),
        ]);
    });

    test('infers sibling plugin bundle root from annotation override', () => {
        const annotationRoot = path.join('tmp', 'annotations-output');
        const candidates = getLocalPluginBundleCandidates({
            pluginId: 'helix',
            annotationPathOverride: annotationRoot,
        });

        assert.deepStrictEqual(candidates, [
            path.resolve(path.join('tmp', 'annotations-output-plugins'), 'helix'),
        ]);
    });

    test('infers sibling plugin bundle root when annotation override has trailing separator', () => {
        const annotationRoot = `${path.join('tmp', 'annotations-output')}${path.sep}`;
        const candidates = getLocalPluginBundleCandidates({
            pluginId: 'helix',
            annotationPathOverride: annotationRoot,
        });

        assert.deepStrictEqual(candidates, [
            path.resolve(path.join('tmp', 'annotations-output-plugins'), 'helix'),
        ]);
    });
});
