import * as vscode from 'vscode';
import { readGluarcConfig, writeGluarcConfig, getGluarcUri } from './gluarcConfig';

/**
 * A single patch operation: write `value` at `path` in .gluarc.json.
 */
export interface PatchEntry {
    /** JSON path segments (e.g. ['gmod', 'scriptedClassScopes', 'include']). */
    path: string[];
    /** Value to write at the target path. */
    value: unknown;
}

/**
 * Rule for merging arrays by item identity rather than replacing them.
 * When the target path resolves to an existing array, only items whose
 * identity is not already present are appended.
 *
 * - When `idKey` is set the array contains objects and identity is
 *   `item[idKey]`, compared case-insensitively (backend dedup semantics).
 * - When `idKey` is omitted the array contains primitive values (strings,
 *   numbers, …) and the value itself is the identity, compared
 *   case-sensitively.
 */
export interface ArrayIdentityRule {
    /** JSON path segments to the array. */
    path: string[];
    /**
     * Property key used as the identity for object-array items (e.g. 'id').
     * Omit for primitive-value arrays (strings, numbers) where the value
     * itself is the identity, matched case-sensitively.
     */
    idKey?: string;
}

export interface PatchOptions {
    /** Extra identity rules to add on top of the built-in defaults. */
    arrayIdentityRules?: ArrayIdentityRule[];
}

export interface PatchSummary {
    /** Paths (as dot-joined strings) that were successfully added. */
    added: string[];
    /**
     * Paths (as dot-joined strings) skipped because a value **already existed**
     * there (additive no-overwrite semantics).  These are safe no-ops — the
     * existing value is already correct or was set by the user intentionally.
     * Distinct from {@link blocked} which signals structural incompatibility.
     */
    skipped: string[];
    /**
     * Paths (as dot-joined strings) that could **not** be written because an
     * incompatible value (e.g. a scalar where an object is required, or a
     * non-array where an array merge is expected) blocks the write at an
     * intermediate or terminal position.  These indicate a structural conflict
     * in the existing config, not a simple "already present" no-op.
     */
    blocked: string[];
    /**
     * Array identity items where the incoming entry has the same id as an existing
     * entry but materially different content.  The id was already present so the
     * incoming entry was NOT written (additive semantics preserved), but the drift
     * is recorded here so callers can surface it to the user.
     * Format: `"path.to.array[id=<rawId>]"`.
     */
    conflicts: string[];
    /** Absolute filesystem path of the file that was written (or would be written). */
    filePath: string;
    /** Whether the file was actually modified (false when no changes were needed). */
    modified: boolean;
}

// ─── Built-in identity rules ─────────────────────────────────────────────────

/**
 * Default array identity rules applied to every patch.
 * - Object arrays use the `id` property as the uniqueness key (case-insensitive).
 * - `diagnostics.globals` is a primitive string array merged by value (case-sensitive).
 */
export const BUILTIN_ARRAY_IDENTITY_RULES: readonly ArrayIdentityRule[] = [
    { path: ['gmod', 'scriptedClassScopes', 'include'], idKey: 'id' },
    { path: ['gmod', 'plugins'] },
    { path: ['diagnostics', 'globals'] }, // primitive string array — idKey omitted, identity is the value itself
];

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes an item ID for case-insensitive duplicate detection.
 * String IDs are lower-cased; non-string IDs are returned as-is.
 * This matches the backend's case-insensitive id deduplication semantics.
 */
function normalizeItemId(id: unknown): unknown {
    return typeof id === 'string' ? id.toLowerCase() : id;
}

function pathKey(path: string[]): string {
    return path.join('.');
}

/**
 * Deep equality check used to detect content drift (same identity, different
 * non-id fields).
 *
 * Arrays whose items are all primitives (strings, numbers, booleans, null) are
 * compared **order-insensitively** by sorting both sides before comparison.
 * This prevents false drift/conflict reports when a user manually reorders a
 * semantically unordered list such as an `include` glob array.
 * Arrays that contain at least one object retain order-sensitive comparison
 * because object identity is tracked separately by the id-based merge logic.
 */
function isDeepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const aArr = a as unknown[];
        const bArr = b as unknown[];
        if (aArr.length !== bArr.length) return false;
        // Order-insensitive comparison for primitive-only arrays (e.g. 'include' glob
        // lists).  Arrays containing objects keep order-sensitive comparison since their
        // identity is already managed by the id-based merge layer.
        const allPrimitive = aArr.every((item) => typeof item !== 'object' || item === null);
        if (allPrimitive) {
            const aSorted = [...aArr].sort();
            const bSorted = [...bArr].sort();
            return aSorted.every((item, i) => item === bSorted[i]);
        }
        return aArr.every((item, i) => isDeepEqual(item, bArr[i]));
    }
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
        (k) => Object.prototype.hasOwnProperty.call(bObj, k) && isDeepEqual(aObj[k], bObj[k]),
    );
}

function findIdentityRule(path: string[], rules: ArrayIdentityRule[]): ArrayIdentityRule | undefined {
    return rules.find(
        (rule) =>
            rule.path.length === path.length &&
            rule.path.every((seg, idx) => seg === path[idx]),
    );
}

/**
 * Applies a single PatchEntry onto `obj` in-place.
 * Returns true if the object was actually modified.
 */
function applyEntry(
    obj: Record<string, unknown>,
    entry: PatchEntry,
    rules: ArrayIdentityRule[],
    added: string[],
    skipped: string[],
    blocked: string[],
    conflicts: string[],
): boolean {
    const { path, value } = entry;
    if (path.length === 0) {
        return false;
    }

    let current: Record<string, unknown> = obj;

    // Navigate / create intermediate objects
    for (let depth = 0; depth < path.length - 1; depth++) {
        const seg = path[depth];
        const next = current[seg];

        if (next === undefined) {
            const newObj: Record<string, unknown> = {};
            current[seg] = newObj;
            current = newObj;
        } else if (isObjectRecord(next)) {
            current = next;
        } else {
            // Existing scalar/array at intermediate position — structural conflict
            // (the existing config layout is incompatible with this write).
            blocked.push(pathKey(path.slice(0, depth + 1)));
            return false;
        }
    }

    const lastKey = path[path.length - 1];
    const existing = current[lastKey];
    const identityRule = findIdentityRule(path, rules);

    // ── Array merge by identity ───────────────────────────────────────────────
    if (Array.isArray(value) && identityRule) {
        const useObjectId = identityRule.idKey !== undefined;
        const idKey = identityRule.idKey;
        const id = idKey!;

        // Deduplicate within the incoming value array itself (keep first occurrence
        // of each identity so a single apply() call cannot append the same value twice).
        // For object arrays: IDs are compared case-insensitively (backend dedup semantics).
        // For primitive arrays: values are compared as-is (case-sensitive).
        const seenIncoming = new Set<unknown>();
        const incomingItems = (value as unknown[]).filter((item) => {
            const rawId = useObjectId
                ? (isObjectRecord(item) ? item[id] : undefined)
                : item;
            // Object-mode items without the idKey pass through unchanged
            if (rawId === undefined && useObjectId) return true;
            const normId = useObjectId ? normalizeItemId(rawId) : rawId;
            if (seenIncoming.has(normId)) return false;
            seenIncoming.add(normId);
            return true;
        });

        if (existing === undefined) {
            current[lastKey] = [...incomingItems];
            added.push(`${pathKey(path)}[+${incomingItems.length}]`);
            return true;
        }

        if (Array.isArray(existing)) {
            // Build set of existing identities for O(1) lookup
            const existingIds = new Set<unknown>();
            for (const item of existing) {
                if (useObjectId) {
                    if (isObjectRecord(item)) {
                        existingIds.add(normalizeItemId(item[id]));
                    }
                } else {
                    existingIds.add(item);
                }
            }

            const newItems: unknown[] = [];
            for (const item of incomingItems) {
                const rawId = useObjectId
                    ? (isObjectRecord(item) ? item[idKey!] : undefined)
                    : item;
                // Skip object-mode items that lack the idKey
                if (rawId === undefined && useObjectId) continue;
                const normId = useObjectId ? normalizeItemId(rawId) : rawId;
                if (!existingIds.has(normId)) {
                    newItems.push(item);
                } else if (useObjectId) {
                    // Same id already present — check for content drift.
                    // Primitives cannot drift (value IS the identity), so only
                    // check object arrays.
                    const existingItem = (existing as unknown[]).find(
                        (e) => isObjectRecord(e) && normalizeItemId(e[idKey!]) === normId,
                    );
                    if (existingItem !== undefined && !isDeepEqual(item, existingItem)) {
                        conflicts.push(`${pathKey(path)}[id=${rawId}]`);
                    }
                }
            }

            if (newItems.length > 0) {
                (current[lastKey] as unknown[]).push(...newItems);
                added.push(`${pathKey(path)}[+${newItems.length}]`);
                return true;
            }

            // Nothing new to add — idempotent no-op, not a conflict
            return false;
        }

        // Existing value is not an array — structural conflict
        // (the existing config has an incompatible type at this path).
        blocked.push(pathKey(path));
        return false;
    }

    // ── Scalar / non-array set ────────────────────────────────────────────────
    if (existing === undefined) {
        current[lastKey] = value;
        added.push(pathKey(path));
        return true;
    }

    // Key already exists — skip (additive / no-overwrite semantics).
    // This is a safe no-op: the value is already present.
    skipped.push(pathKey(path));
    return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Applies an additive patch to `.gluarc.json` in the given workspace folder.
 *
 * Rules:
 * - Creates missing parent objects as needed.
 * - Preserves all unrelated keys.
 * - Scalar keys that already exist are skipped (no-overwrite).
 * - Arrays at paths covered by an identity rule are merged by `idKey`;
 *   only entries with a new `id` are appended.
 * - Idempotent: repeated calls with the same patch produce identical output.
 *
 * @returns A summary of what was added, skipped, and whether the file changed.
 */
export async function applyGluarcPatch(
    workspaceFolder: vscode.WorkspaceFolder,
    entries: PatchEntry[],
    options?: PatchOptions,
): Promise<PatchSummary> {
    const rules: ArrayIdentityRule[] = [
        ...BUILTIN_ARRAY_IDENTITY_RULES,
        ...(options?.arrayIdentityRules ?? []),
    ];

    const config = await readGluarcConfig(workspaceFolder);
    const added: string[] = [];
    const skipped: string[] = [];
    const blocked: string[] = [];
    const conflicts: string[] = [];
    let anyModified = false;

    for (const entry of entries) {
        const modified = applyEntry(config, entry, rules, added, skipped, blocked, conflicts);
        if (modified) {
            anyModified = true;
        }
    }

    const filePath = getGluarcUri(workspaceFolder).fsPath;

    let written = false;
    if (anyModified) {
        written = await writeGluarcConfig(workspaceFolder, config);
    }

    return { added, skipped, blocked, conflicts, filePath, modified: written };
}

export function buildPresetPatchEntries(opts: {
    classScopes?: ReadonlyArray<{
        id: string;
        /** Required by backend — entries without classGlobal are silently dropped. */
        classGlobal: string;
        fixedClassName?: string;
        /** Required by backend — entries without include are silently dropped. */
        include: readonly string[];
        /** Required by backend — entries without label are silently dropped. */
        label: string;
        /** Required by backend — entries without path are silently dropped. */
        path: readonly string[];
        rootDir?: string;
        isGlobalSingleton?: boolean;
        stripFilePrefix?: boolean;
        hideFromOutline?: boolean;
    }>;
    diagnosticsGlobals?: readonly string[];
}): PatchEntry[] {
    const entries: PatchEntry[] = [];

    if (opts.classScopes && opts.classScopes.length > 0) {
        entries.push({
            path: ['gmod', 'scriptedClassScopes', 'include'],
            value: opts.classScopes,
        });
    }

    if (opts.diagnosticsGlobals && opts.diagnosticsGlobals.length > 0) {
        entries.push({
            path: ['diagnostics', 'globals'],
            value: opts.diagnosticsGlobals,
        });
    }

    return entries;
}

function flattenObjectToPatchEntries(
    value: unknown,
    currentPath: string[],
    entries: PatchEntry[],
): void {
    if (isObjectRecord(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            return;
        }
        for (const key of keys) {
            flattenObjectToPatchEntries(value[key], [...currentPath, key], entries);
        }
        return;
    }

    if (currentPath.length > 0) {
        entries.push({
            path: currentPath,
            value,
        });
    }
}

export function buildPluginPatchEntries(
    pluginId: string,
    pluginGluarcFragment: Record<string, unknown>,
): PatchEntry[] {
    const entries: PatchEntry[] = [
        { path: ['gmod', 'plugins'], value: [pluginId] },
    ];
    flattenObjectToPatchEntries(pluginGluarcFragment, [], entries);
    return entries;
}
