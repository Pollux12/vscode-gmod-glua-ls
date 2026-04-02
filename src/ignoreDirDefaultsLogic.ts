/**
 * Pure helper functions for ignoreDirDefaults serialization logic.
 *
 * This module is shared between the extension host (TypeScript tests) and
 * the webview (collectionEditors.js). Keeping the logic here lets us write
 * deterministic unit tests without a browser / JSDOM environment.
 *
 * IMPORTANT: keep this file free of any VSCode / DOM / Node-fs imports so it
 * can be imported in both environments.
 */

export interface IgnoreDirEntry {
    readonly id: string;
    readonly glob: string | null;
    readonly label: string | null;
    readonly disabled: boolean;
    readonly wasObject: boolean;
}

export type IgnoreDirOverride = {
    id: string;
    glob: string | null;
    label: string | null;
    disabled: boolean;
    wasObject: boolean;
};

/**
 * Normalise a raw ignoreDirDefaults entry (string or unknown object) to a
 * canonical { id, glob, label, disabled, wasObject } form.
 * Returns null for invalid/empty entries.
 *
 * `wasObject` is true when the source entry was an object (not a legacy string).
 */
export function normalizeIgnoreDirEntry(entry: unknown): IgnoreDirEntry | null {
    if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) {
            return null;
        }
        return { id: trimmed, glob: trimmed, label: null, disabled: false, wasObject: false };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
    }
    const obj = entry as Record<string, unknown>;
    const id = typeof obj['id'] === 'string' ? obj['id'].trim() : '';
    if (!id) {
        return null;
    }
    const glob = typeof obj['glob'] === 'string' ? obj['glob'].trim() : '';
    const label = typeof obj['label'] === 'string' ? obj['label'].trim() : '';
    const disabled = obj['disabled'] === true;
    return {
        id,
        glob: glob || null,
        label: label || null,
        disabled,
        wasObject: true,
    };
}

/**
 * Returns the normalized built-in default entries from a schema field descriptor.
 */
export function getIgnoreDirDefaults(field: { default?: unknown }): IgnoreDirEntry[] {
    if (!Array.isArray(field.default)) {
        return [];
    }
    return (field.default as unknown[])
        .map(normalizeIgnoreDirEntry)
        .filter((e): e is IgnoreDirEntry => e !== null);
}

/**
 * Detect whether a raw value array is in "legacy replace mode":
 * all entries are plain strings with no object overrides/disables.
 */
export function isLegacyReplaceMode(val: unknown): boolean {
    if (!Array.isArray(val) || val.length === 0) {
        return false;
    }
    return val.every((entry) => typeof entry === 'string');
}

/**
 * Build a serializable payload from the raw overrides map plus the built-in
 * defaults. Only emits entries that differ from the defaults.
 *
 * - Built-in overrides/disables are serialized as objects.
 * - Custom entries (delta-mode additions) are always serialized as `{ id, glob }`.
 * - Existing `label` metadata is preserved when present.
 *
 * The only code path that produces plain strings is the legacy-mode serializer
 * inside `commit()` in collectionEditors.js, which runs only while `legacyMode`
 * is still true.
 */
export function buildIgnoreDirPayload(
    builtinDefaults: readonly IgnoreDirEntry[],
    overrides: ReadonlyMap<string, IgnoreDirOverride>,
): Array<Record<string, unknown>> {
    const builtinById = new Map(builtinDefaults.map((e) => [e.id, e]));
    const entries: Array<Record<string, unknown>> = [];

    overrides.forEach((override, id) => {
        const builtin = builtinById.get(id);
        if (builtin) {
            if (override.disabled) {
                const obj: Record<string, unknown> = { id, disabled: true };
                const effectiveLabel = override.label ?? builtin.label ?? null;
                if (effectiveLabel) {
                    obj['label'] = effectiveLabel;
                }
                entries.push(obj);
                return;
            }
            if (override.glob !== null && override.glob !== builtin.glob) {
                const obj: Record<string, unknown> = { id, glob: override.glob };
                const effectiveLabel = override.label ?? builtin.label ?? null;
                if (effectiveLabel) {
                    obj['label'] = effectiveLabel;
                }
                entries.push(obj);
            }
            // Matches default — nothing to write
        } else {
            // Custom entry (not in built-ins) — always serialize as an object.
            if (!override.disabled && override.glob) {
                const obj: Record<string, unknown> = { id, glob: override.glob };
                if (override.label) {
                    obj['label'] = override.label;
                }
                entries.push(obj);
            }
        }
    });

    return entries;
}

/**
 * Parse a raw value array into an overrides Map for delta mode or legacy mode.
 *
 * In delta mode:
 *   - Object entries whose id matches a built-in are only stored if they
 *     actually differ from the built-in (disabled or glob changed).
 *   - Object entries with an unknown id are stored as custom entries.
 *   - String entries that match a built-in id are ignored (already the default).
 *
 * In legacy mode every entry is kept verbatim (the array replaces built-ins).
 */
export function parseIgnoreDirValue(
    val: unknown,
    builtinById: ReadonlyMap<string, IgnoreDirEntry>,
    isLegacy: boolean,
): Map<string, IgnoreDirOverride> {
    const map = new Map<string, IgnoreDirOverride>();
    if (!Array.isArray(val)) {
        return map;
    }
    for (const entry of val as unknown[]) {
        const normalized = normalizeIgnoreDirEntry(entry);
        if (!normalized) {
            continue;
        }
        if (isLegacy) {
            map.set(normalized.id, { ...normalized });
            continue;
        }
        const builtin = builtinById.get(normalized.id);
        if (builtin) {
            if (normalized.disabled) {
                map.set(normalized.id, { ...normalized });
                continue;
            }
            const globDiffers = normalized.glob !== null && normalized.glob !== builtin.glob;
            if (globDiffers) {
                map.set(normalized.id, { ...normalized });
            }
            // Matches default — no override needed
        } else {
            // Custom entry — always store
            map.set(normalized.id, { ...normalized });
        }
    }
    return map;
}
