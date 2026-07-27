import * as assert from 'assert';

import {
    GmodDebugControlService,
    GmodControlTransport,
} from '../../debugger/gmod_debugger/GmodDebugControlService';

suite('GMod Debug Control Service', () => {
    test('returns synchronous Lua evaluation results', async () => {
        const evaluation = {
            executedAt: '2026-07-27T14:20:00Z',
            serverExecuted: true,
            clientDispatched: false,
            returnsTruncated: false,
            returns: [{ index: 1, type: 'number', value: 42 }],
        };
        const transport: GmodControlTransport = {
            pauseSoft: () => undefined,
            pauseNow: () => undefined,
            resume: () => undefined,
            runLua: async () => evaluation,
            runFile: () => undefined,
            refreshFile: () => undefined,
            runCommand: () => undefined,
        };
        const service = new GmodDebugControlService(transport);

        const result = await service.execute('runLua', {
            lua: 'return 42',
            realm: 'server',
        });

        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.result, evaluation);
    });
});
