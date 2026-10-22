import * as assert from 'assert';
import * as vscode from 'vscode';

import { EntitySummary } from '../../debugger/gmod_debugger/lrdb/Client';
import { EntityTreeItem, GmodEntityExplorerProvider } from '../../gmodEntityExplorerView';

const SERVER_PAGE_LIMIT = 200;

function entity(index: number, className: string): EntitySummary {
    return { index, class: className, model: '', valid: true, pos: [0, 0, 0], angles: [0, 0, 0] };
}

function fakeSession(entities: EntitySummary[], requestedOffsets: number[]): vscode.DebugSession {
    return {
        type: 'gluals_gmod',
        customRequest: async (_command: string, params: { offset: number; limit: number }) => {
            requestedOffsets.push(params.offset);
            const limit = Math.min(params.limit, SERVER_PAGE_LIMIT);
            return {
                entities: entities.slice(params.offset, params.offset + limit),
                total: entities.length,
                offset: params.offset,
                limit,
            };
        },
    } as unknown as vscode.DebugSession;
}

function classGroups(items: EntityTreeItem[]): Array<{ className: string; count: number }> {
    return items.flatMap((item) =>
        item.data.kind === 'classGroup' ? [{ className: item.data.className, count: item.data.entities.length }] : []
    );
}

suite('GMod Entity Explorer', () => {
    test('groups and filters every entity, not only the first page', async () => {
        const entities = [
            ...Array.from({ length: 45 }, (_, i) => entity(i + 1, 'info_player_start')),
            ...Array.from({ length: 400 }, (_, i) => entity(i + 46, 'prop_physics')),
            ...Array.from({ length: 3 }, (_, i) => entity(i + 446, 'gmod_balloon')),
        ];
        const requestedOffsets: number[] = [];
        const session = fakeSession(entities, requestedOffsets);
        const provider = new GmodEntityExplorerProvider(
            () => session,
            async () => [{ uri: 'file:///gmod_balloon.lua', classType: 'ENT', className: 'gmod_balloon' }],
        );

        try {
            assert.deepStrictEqual(classGroups(await provider.getChildren()), [
                { className: 'gmod_balloon', count: 3 },
                { className: 'info_player_start', count: 45 },
                { className: 'prop_physics', count: 400 },
            ]);
            assert.deepStrictEqual(requestedOffsets, [0, 200, 400]);

            provider.setClassGroupFilter('luaDefined');
            assert.deepStrictEqual(classGroups(await provider.getChildren()), [{ className: 'gmod_balloon', count: 3 }]);
        } finally {
            provider.dispose();
        }
    });
});
