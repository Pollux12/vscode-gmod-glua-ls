import * as assert from 'assert';
import {
    deduplicateScopePaths,
    normalizeCustomScopePath,
    normalizeScopePath,
} from '../../gmodFrameworkWizard';

suite('Wizard', () => {
    test('deduplicateScopePaths keeps first and removes duplicates', () => {
        const result = deduplicateScopePaths([
            'schema/plugins',
            'Schema/Plugins',
            'schema\\plugins',
            'schema/items',
        ]);
        assert.deepStrictEqual(result, ['schema/plugins', 'schema/items']);
    });

    test('normalizeCustomScopePath rejects dangerous paths', () => {
        assert.strictEqual(normalizeCustomScopePath('../schema'), null);
        assert.strictEqual(normalizeCustomScopePath('/abs/path'), null);
        assert.strictEqual(normalizeCustomScopePath('schema/*'), null);
    });

    test('normalizeScopePath normalizes separators and case', () => {
        assert.strictEqual(normalizeScopePath('Gamemode\\Plugins/'), 'gamemode/plugins');
    });
});
