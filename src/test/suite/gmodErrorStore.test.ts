import * as assert from 'assert';

import { GmodErrorNotificationParams, GmodErrorStore } from '../../gmodErrorView';

function report(fingerprint: string, count: number): GmodErrorNotificationParams {
    return { message: `boom ${fingerprint}`, fingerprint, count, source: 'lua' };
}

suite('GMod Error Store', () => {
    test('counts only occurrences since the last clear', () => {
        const store = new GmodErrorStore();
        store.addError(report('a', 1));
        store.addError(report('a', 2));
        assert.strictEqual(store.getAll()[0].count, 2);

        store.clear();
        store.addError(report('a', 3));

        assert.strictEqual(store.getAll()[0].count, 1);
        store.addError(report('a', 4));
        assert.strictEqual(store.getAll()[0].count, 2);
        store.dispose();
    });

    test('keeps the full total for fingerprints first seen after a clear', () => {
        const store = new GmodErrorStore();
        store.addError(report('a', 2));
        store.clear();
        store.addError(report('b', 1));

        assert.strictEqual(store.getAll()[0].count, 1);
        store.dispose();
    });

    test('starts over when the server restarts and its totals drop below the baseline', () => {
        const store = new GmodErrorStore();
        store.addError(report('a', 5));
        store.clear();
        store.addError(report('a', 1));

        assert.strictEqual(store.getAll()[0].count, 1);
        store.dispose();
    });
});
