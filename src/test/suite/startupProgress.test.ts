import * as assert from 'assert';

import {
    STARTUP_DIAGNOSE_PROGRESS_TOKEN,
    STARTUP_LOAD_PROGRESS_TOKEN,
    applyServerStartupState,
    applyStartupProgressEvent,
    createStartupReadinessState,
    describeStartupProgressEvent,
    describeStartupServerState,
    formatStartupTimeoutMessage,
} from '../../startupProgress';

suite('Startup Progress', () => {
    test('treats workspace load completion as ready until diagnostics actually start', () => {
        const loaded = applyStartupProgressEvent(
            createStartupReadinessState(),
            {
                token: STARTUP_LOAD_PROGRESS_TOKEN,
                kind: 'end',
            }
        );

        assert.strictEqual(loaded.ready, true);
        assert.strictEqual(loaded.diagnosticsInProgress, false);

        const diagnosing = applyStartupProgressEvent(loaded, {
            token: STARTUP_DIAGNOSE_PROGRESS_TOKEN,
            kind: 'begin',
        });

        assert.strictEqual(diagnosing.ready, true);
        assert.strictEqual(diagnosing.diagnosticsInProgress, true);

        const diagnosed = applyStartupProgressEvent(diagnosing, {
            token: STARTUP_DIAGNOSE_PROGRESS_TOKEN,
            kind: 'end',
        });

        assert.strictEqual(diagnosed.ready, true);
        assert.strictEqual(diagnosed.diagnosticsInProgress, false);
    });

    test('accepts explicit server workspaceLoaded and startupComplete states', () => {
        const loaded = applyServerStartupState(
            createStartupReadinessState(),
            'workspaceLoaded'
        );

        assert.strictEqual(loaded.ready, true);
        assert.strictEqual(
            loaded.completedTasks.has(STARTUP_LOAD_PROGRESS_TOKEN),
            true
        );
        assert.strictEqual(loaded.diagnosticsInProgress, false);

        const complete = applyServerStartupState(loaded, 'startupComplete');

        assert.strictEqual(complete.ready, true);
        assert.strictEqual(complete.diagnosticsInProgress, false);
        assert.strictEqual(
            complete.completedTasks.has(STARTUP_DIAGNOSE_PROGRESS_TOKEN),
            true
        );
    });

    test('describes startup progress messages for timeout diagnostics', () => {
        assert.strictEqual(
            describeStartupProgressEvent({
                token: STARTUP_DIAGNOSE_PROGRESS_TOKEN,
                kind: 'report',
                message: 'Indexing addon files',
            }),
            'Indexing addon files'
        );

        assert.strictEqual(
            describeStartupProgressEvent({
                token: STARTUP_LOAD_PROGRESS_TOKEN,
                kind: 'begin',
            }),
            'workspace loading started'
        );

        assert.strictEqual(
            describeStartupServerState('startupComplete'),
            'startup complete'
        );
    });

    test('formats startup timeout errors with stable code and last phase', () => {
        assert.strictEqual(
            formatStartupTimeoutMessage(60_000, 'Indexing addon files'),
            'LS_STARTUP_TIMEOUT after 60s; last phase: Indexing addon files'
        );
    });
});
