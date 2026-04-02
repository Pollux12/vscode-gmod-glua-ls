/**
 * Deterministic unit tests for ignoreDirDefaults pure logic.
 * No VSCode APIs or DOM required — runs inside the extension host test runner.
 */
import * as assert from 'assert';
import {
    normalizeIgnoreDirEntry,
    isLegacyReplaceMode,
    buildIgnoreDirPayload,
    parseIgnoreDirValue,
    getIgnoreDirDefaults,
    type IgnoreDirEntry,
    type IgnoreDirOverride,
} from '../../ignoreDirDefaultsLogic';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUILTIN_DEFAULTS: IgnoreDirEntry[] = [
    { id: 'tests', glob: '**/tests/**', label: 'Tests', disabled: false, wasObject: true },
    { id: 'vendor', glob: '**/vendor/**', label: 'Vendor', disabled: false, wasObject: true },
];

function builtinByIdMap(): Map<string, IgnoreDirEntry> {
    return new Map(BUILTIN_DEFAULTS.map((e) => [e.id, e]));
}

// ---------------------------------------------------------------------------
// normalizeIgnoreDirEntry
// ---------------------------------------------------------------------------
suite('ignoreDirDefaults -- normalizeIgnoreDirEntry', () => {
    test('returns null for empty string', () => {
        assert.strictEqual(normalizeIgnoreDirEntry(''), null);
        assert.strictEqual(normalizeIgnoreDirEntry('   '), null);
    });

    test('returns null for null/undefined/array', () => {
        assert.strictEqual(normalizeIgnoreDirEntry(null), null);
        assert.strictEqual(normalizeIgnoreDirEntry(undefined), null);
        assert.strictEqual(normalizeIgnoreDirEntry([]), null);
    });

    test('returns null for object without id', () => {
        assert.strictEqual(normalizeIgnoreDirEntry({ glob: '**/*.ts' }), null);
    });

    test('plain string -> legacy entry (wasObject=false)', () => {
        const result = normalizeIgnoreDirEntry('**/tests/**');
        assert.ok(result);
        assert.strictEqual(result.id, '**/tests/**');
        assert.strictEqual(result.glob, '**/tests/**');
        assert.strictEqual(result.label, null);
        assert.strictEqual(result.disabled, false);
        assert.strictEqual(result.wasObject, false);
    });

    test('object entry -> normalized (wasObject=true)', () => {
        const result = normalizeIgnoreDirEntry({ id: 'tests', glob: '**/tests/**', label: 'Tests', disabled: false });
        assert.ok(result);
        assert.strictEqual(result.id, 'tests');
        assert.strictEqual(result.glob, '**/tests/**');
        assert.strictEqual(result.label, 'Tests');
        assert.strictEqual(result.disabled, false);
        assert.strictEqual(result.wasObject, true);
    });

    test('object with disabled=true', () => {
        const result = normalizeIgnoreDirEntry({ id: 'tests', disabled: true });
        assert.ok(result);
        assert.strictEqual(result.disabled, true);
        assert.strictEqual(result.glob, null);
    });
});

// ---------------------------------------------------------------------------
// isLegacyReplaceMode
// ---------------------------------------------------------------------------
suite('ignoreDirDefaults -- isLegacyReplaceMode', () => {
    test('empty array is NOT legacy mode', () => {
        assert.strictEqual(isLegacyReplaceMode([]), false);
    });

    test('non-array is NOT legacy mode', () => {
        assert.strictEqual(isLegacyReplaceMode(null), false);
        assert.strictEqual(isLegacyReplaceMode(undefined), false);
        assert.strictEqual(isLegacyReplaceMode('string'), false);
    });

    test('all-string array IS legacy mode', () => {
        assert.strictEqual(isLegacyReplaceMode(['tests', 'custom-glob/**']), true);
    });

    test('mixed array with object is NOT legacy mode', () => {
        assert.strictEqual(isLegacyReplaceMode(['tests', { id: 'tests', disabled: true }]), false);
    });

    test('all-object array is NOT legacy mode', () => {
        assert.strictEqual(isLegacyReplaceMode([{ id: 'tests', disabled: true }]), false);
    });
});

// ---------------------------------------------------------------------------
// getIgnoreDirDefaults
// ---------------------------------------------------------------------------
suite('ignoreDirDefaults -- getIgnoreDirDefaults', () => {
    test('extracts defaults from schema field', () => {
        const field = {
            default: [
                { id: 'tests', glob: '**/tests/**', label: 'Tests' },
                { id: 'vendor', glob: '**/vendor/**', label: 'Vendor' },
            ],
        };
        const result = getIgnoreDirDefaults(field);
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0].id, 'tests');
        assert.strictEqual(result[1].id, 'vendor');
    });

    test('returns empty array when field.default is not an array', () => {
        assert.deepStrictEqual(getIgnoreDirDefaults({}), []);
        assert.deepStrictEqual(getIgnoreDirDefaults({ default: null }), []);
    });
});

// ---------------------------------------------------------------------------
// buildIgnoreDirPayload
// ---------------------------------------------------------------------------
suite('ignoreDirDefaults -- buildIgnoreDirPayload', () => {
    test('empty overrides -> empty payload', () => {
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, new Map());
        assert.deepStrictEqual(payload, []);
    });

    test('disable builtin -> label from builtin preserved in payload', () => {
        // The serializer always carries the builtin label through when disabling,
        // using effectiveLabel = override.label ?? builtin.label.
        const overrides = new Map<string, IgnoreDirOverride>([
            ['tests', { id: 'tests', glob: '**/tests/**', label: null, disabled: true, wasObject: true }],
        ]);
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, overrides);
        assert.strictEqual(payload.length, 1);
        assert.deepStrictEqual(payload[0], { id: 'tests', disabled: true, label: 'Tests' });
    });

    test('disable builtin with null glob -> label from builtin preserved in payload', () => {
        // Same serializer path, glob: null variant (e.g. override created without a glob).
        const overrides = new Map<string, IgnoreDirOverride>([
            ['tests', { id: 'tests', glob: null, label: null, disabled: true, wasObject: true }],
        ]);
        // BUILTIN_DEFAULTS[0] has label:'Tests'
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, overrides);
        assert.strictEqual(payload.length, 1);
        assert.deepStrictEqual(payload[0], { id: 'tests', disabled: true, label: 'Tests' });
    });

    test('restore disabled builtin (override matching default) -> not emitted', () => {
        // An override that matches the builtin defaults is not emitted
        const overrides = new Map<string, IgnoreDirOverride>([
            ['tests', { id: 'tests', glob: '**/tests/**', label: null, disabled: false, wasObject: true }],
        ]);
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, overrides);
        assert.deepStrictEqual(payload, []);
    });

    test('delta mode object-backed custom entry preserves id+label on edited glob', () => {
        const overrides = new Map<string, IgnoreDirOverride>([
            ['custom-entry', { id: 'custom-entry', glob: '**/vendor/foo/**', label: 'Vendor', disabled: false, wasObject: true }],
        ]);
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, overrides);
        assert.strictEqual(payload.length, 1);
        assert.deepStrictEqual(payload[0], { id: 'custom-entry', glob: '**/vendor/foo/**', label: 'Vendor' });
    });

    test('builtin with changed glob -> emits { id, glob } with label', () => {
        const overrides = new Map<string, IgnoreDirOverride>([
            ['tests', { id: 'tests', glob: '**/specs/**', label: null, disabled: false, wasObject: true }],
        ]);
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, overrides);
        assert.strictEqual(payload.length, 1);
        assert.deepStrictEqual(payload[0], { id: 'tests', glob: '**/specs/**', label: 'Tests' });
    });

    test('builtin glob unchanged -> not emitted', () => {
        const overrides = new Map<string, IgnoreDirOverride>([
            ['tests', { id: 'tests', glob: '**/tests/**', label: null, disabled: false, wasObject: true }],
        ]);
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, overrides);
        assert.deepStrictEqual(payload, []);
    });

    test('custom entry without glob -> not emitted', () => {
        const overrides = new Map<string, IgnoreDirOverride>([
            ['my-custom', { id: 'my-custom', glob: null, label: null, disabled: false, wasObject: true }],
        ]);
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, overrides);
        assert.deepStrictEqual(payload, []);
    });
});

// ---------------------------------------------------------------------------
// parseIgnoreDirValue
// ---------------------------------------------------------------------------
suite('ignoreDirDefaults -- parseIgnoreDirValue (delta mode)', () => {
    test('empty array -> empty map', () => {
        const map = parseIgnoreDirValue([], builtinByIdMap(), false);
        assert.strictEqual(map.size, 0);
    });

    test('object entry matching builtin default exactly -> not stored (no override needed)', () => {
        const val = [{ id: 'tests', glob: '**/tests/**' }];
        const map = parseIgnoreDirValue(val, builtinByIdMap(), false);
        assert.strictEqual(map.size, 0);
    });

    test('disabled builtin entry -> stored in map', () => {
        const val = [{ id: 'tests', disabled: true }];
        const map = parseIgnoreDirValue(val, builtinByIdMap(), false);
        assert.strictEqual(map.size, 1);
        assert.strictEqual(map.get('tests')?.disabled, true);
    });

    test('custom object entry (not in builtins) -> always stored', () => {
        const val = [{ id: 'my-vendor', glob: '**/vendor/**', label: 'My Vendor' }];
        const map = parseIgnoreDirValue(val, builtinByIdMap(), false);
        assert.strictEqual(map.size, 1);
        const entry = map.get('my-vendor');
        assert.ok(entry);
        assert.strictEqual(entry.glob, '**/vendor/**');
        assert.strictEqual(entry.label, 'My Vendor');
    });
});

suite('ignoreDirDefaults -- parseIgnoreDirValue (legacy mode)', () => {
    test('all strings kept verbatim, even if id matches builtin', () => {
        const val = ['tests', 'custom-glob/**'];
        const map = parseIgnoreDirValue(val, builtinByIdMap(), true);
        // Both entries stored even though 'tests' matches a builtin
        assert.strictEqual(map.size, 2);
        assert.ok(map.has('tests'));
        assert.ok(map.has('custom-glob/**'));
    });
});

// ---------------------------------------------------------------------------
// Integration: legacy -> delta conversion scenario
// ---------------------------------------------------------------------------
suite('ignoreDirDefaults -- legacy->delta conversion', () => {
    /**
     * Scenario: user has legacy value ["tests", "my-vendor/**"]
     *
     * On "convert to delta":
     * - "tests" matches a builtin -> dropped (would be active by default)
     * - "my-vendor/**" is custom -> kept as { id: "my-vendor/**", glob: "my-vendor/**" }
     * - Resulting payload does NOT contain all-strings -> reloading won't be legacy mode
     */
    test('builtin string entries dropped, custom globs become objects', () => {
        const legacyValue = ['tests', 'my-vendor/**'];

        // 1) Parse in legacy mode to get current overrides
        const legacyOverrides = parseIgnoreDirValue(legacyValue, builtinByIdMap(), true);

        // 2) Build a new delta overrides map: drop builtin-id entries, keep only custom globs
        const deltaOverrides = new Map<string, IgnoreDirOverride>();
        legacyOverrides.forEach((override, id) => {
            if (!builtinByIdMap().has(id)) {
                // Custom — always an object entry in delta mode, even if wasObject=false
                deltaOverrides.set(id, { ...override, wasObject: true });
            }
            // builtin-matching strings are simply dropped (they'd be active by default)
        });

        // 3) Build payload
        const payload = buildIgnoreDirPayload(BUILTIN_DEFAULTS, deltaOverrides);

        // 'tests' should be absent (matches builtin default)
        assert.ok(!payload.some((e) => (e as { id?: string })['id'] === 'tests'), '"tests" should not appear in delta payload');

        // 'my-vendor/**' should be present as an object
        const customEntry = payload.find((e) => (e as { id?: string })['id'] === 'my-vendor/**');
        assert.ok(customEntry, 'custom glob should be present in delta payload');
        assert.strictEqual((customEntry as { glob?: string })['glob'], 'my-vendor/**');

        // Reloading the payload should NOT trigger legacy replace mode
        assert.strictEqual(isLegacyReplaceMode(payload), false, 'converted payload must not be legacy mode');
    });
});
