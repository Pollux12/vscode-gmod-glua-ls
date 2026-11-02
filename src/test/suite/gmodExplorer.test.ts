import * as assert from 'assert';
import * as vscode from 'vscode';

import { GmodExplorerProvider } from '../../gmodExplorer';

suite('GMod Explorer', () => {
    test('reloads the scripted classes when the loaded addons and gamemodes change', () => {
        const changed = new vscode.EventEmitter<void>();
        const provider = new GmodExplorerProvider({ roots: [], onDidChange: changed.event });
        let refreshes = 0;
        provider.refresh = () => {
            refreshes += 1;
        };
        try {
            changed.fire();
        } finally {
            provider.dispose();
            changed.dispose();
        }

        assert.strictEqual(refreshes, 1);
    });
});
