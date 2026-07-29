import * as assert from 'assert';

import {
    ExtensionConflictServices,
    GLUA_ENHANCED_CONFLICT_MESSAGE,
    GLUA_ENHANCED_EXTENSION_ID,
    throwIfGluaEnhancedIsEnabled,
} from '../../extensionConflict';

suite('Extension Conflict', () => {
    test('allows language-server startup when GLua Enhanced is unavailable', () => {
        const services: ExtensionConflictServices = {
            getExtension: () => undefined,
        };

        assert.doesNotThrow(() => throwIfGluaEnhancedIsEnabled(services));
    });

    test('blocks language-server startup when GLua Enhanced is enabled', () => {
        let detectionCount = 0;
        const services: ExtensionConflictServices = {
            getExtension: (extensionId) => {
                assert.strictEqual(extensionId, GLUA_ENHANCED_EXTENSION_ID);
                detectionCount += 1;
                return {};
            },
        };

        for (let attempt = 0; attempt < 2; attempt += 1) {
            assert.throws(
                () => throwIfGluaEnhancedIsEnabled(services),
                (error: Error) => error.message === GLUA_ENHANCED_CONFLICT_MESSAGE
            );
        }
        assert.strictEqual(detectionCount, 2, 'Every server-start attempt must check the conflict.');
        assert.match(GLUA_ENHANCED_CONFLICT_MESSAGE, /^Conflict detected:/);
        assert.match(GLUA_ENHANCED_CONFLICT_MESSAGE, /Disable GLua Enhanced/);
        assert.doesNotMatch(GLUA_ENHANCED_CONFLICT_MESSAGE, /Manage GLua Enhanced/);
    });
});
