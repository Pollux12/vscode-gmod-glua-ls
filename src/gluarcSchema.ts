export type FieldType = 'boolean' | 'string' | 'number' | 'integer' | 'array' | 'object' | 'enum' | 'any';

export interface FieldDescriptor {
    key: string;
    path: string[];
    label: string;
    description?: string;
    type: FieldType;
    default?: unknown;
    enumValues?: string[];
    properties?: FieldDescriptor[];
    items?: FieldDescriptor;
    nullable: boolean;
}

export interface Category {
    key: string;
    label: string;
    description?: string;
    fields: FieldDescriptor[];
}

type SchemaObject = Record<string, unknown>;

const META_CATEGORY_KEYS = new Set(['$schema', '$defs', 'definitions']);

function asObject(value: unknown): SchemaObject | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return value as SchemaObject;
}

function asSchemaArray(value: unknown): SchemaObject[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map(asObject).filter((entry): entry is SchemaObject => entry !== undefined);
}

function getString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function unescapeJsonPointerToken(token: string): string {
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function getSchemaTitle(key: string, schemaDef: SchemaObject): string {
    return getString(schemaDef['title']) ?? camelToLabel(key);
}

function shouldSkipCategoryKey(key: string): boolean {
    return key.startsWith('$') || META_CATEGORY_KEYS.has(key);
}

function isPureNullSchema(schemaDef: SchemaObject): boolean {
    if (schemaDef['const'] === null) {
        return true;
    }

    const type = schemaDef['type'];
    if (type === 'null') {
        return true;
    }

    if (Array.isArray(type)) {
        const nonNullTypes = type.filter((entry) => entry !== 'null');
        return nonNullTypes.length === 0;
    }

    const enumValues = schemaDef['enum'];
    if (Array.isArray(enumValues) && enumValues.length === 1 && enumValues[0] === null) {
        return true;
    }

    return false;
}

function directStringEnumInfo(schemaDef: SchemaObject): { values?: string[]; nullable: boolean } {
    const enumValues = schemaDef['enum'];
    if (!Array.isArray(enumValues)) {
        return { nullable: false };
    }

    let nullable = false;
    const values: string[] = [];

    for (const value of enumValues) {
        if (value === null) {
            nullable = true;
            continue;
        }

        if (typeof value !== 'string') {
            return { nullable };
        }

        values.push(value);
    }

    if (values.length === 0) {
        return { nullable };
    }

    return {
        values: [...new Set(values)],
        nullable,
    };
}

function collectStringEnumInfo(
    schemaDef: SchemaObject,
    rootSchema: SchemaObject,
    seenRefs: Set<string>,
): { values?: string[]; nullable: boolean } {
    const directInfo = directStringEnumInfo(schemaDef);
    if (directInfo.values) {
        return directInfo;
    }

    for (const key of ['oneOf', 'anyOf']) {
        const variants = asSchemaArray(schemaDef[key]);
        if (variants.length === 0) {
            continue;
        }

        let nullable = false;
        let validEnumPattern = true;
        const values: string[] = [];

        for (const variant of variants) {
            const resolvedVariant = resolveSchemaRefs(variant, rootSchema, new Set(seenRefs));

            if (isPureNullSchema(resolvedVariant)) {
                nullable = true;
                continue;
            }

            const constValue = resolvedVariant['const'];
            if (typeof constValue === 'string') {
                values.push(constValue);
                continue;
            }

            if (constValue === null) {
                nullable = true;
                continue;
            }

            const nestedDirectInfo = directStringEnumInfo(resolvedVariant);
            if (nestedDirectInfo.values) {
                values.push(...nestedDirectInfo.values);
                nullable = nullable || nestedDirectInfo.nullable;
                continue;
            }

            validEnumPattern = false;
            break;
        }

        if (validEnumPattern && values.length > 0) {
            return {
                values: [...new Set(values)],
                nullable,
            };
        }
    }

    return { nullable: false };
}

function getPrimaryType(schemaDef: SchemaObject): FieldType | undefined {
    const type = schemaDef['type'];

    if (typeof type === 'string') {
        if (type === 'boolean' || type === 'string' || type === 'number' || type === 'integer' || type === 'array' || type === 'object') {
            return type;
        }

        return undefined;
    }

    if (!Array.isArray(type)) {
        return undefined;
    }

    const nonNullTypes = type.filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
    if (nonNullTypes.length !== 1) {
        return undefined;
    }

    const [singleType] = nonNullTypes;
    if (singleType === 'boolean' || singleType === 'string' || singleType === 'number' || singleType === 'integer' || singleType === 'array' || singleType === 'object') {
        return singleType;
    }

    return undefined;
}

function resolveSchemaRefs(schemaDef: SchemaObject, rootSchema: SchemaObject, seenRefs: Set<string>): SchemaObject {
    let current: SchemaObject = schemaDef;

    while (true) {
        const ref = getString(current['$ref']);
        if (!ref) {
            return current;
        }

        const resolved = resolveRef(rootSchema, ref, seenRefs);
        const resolvedObject = asObject(resolved);
        if (!resolvedObject) {
            return current;
        }

        const merged: SchemaObject = {
            ...resolvedObject,
            ...current,
        };
        delete merged['$ref'];
        current = merged;
    }
}

function unwrapNullableSchema(
    schemaDef: SchemaObject,
    rootSchema: SchemaObject,
    seenRefs: Set<string>,
): { schemaDef: SchemaObject; nullable: boolean } {
    let nullable = false;
    let current = schemaDef;

    const type = current['type'];
    if (Array.isArray(type)) {
        const nonNullTypes = type.filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
        if (nonNullTypes.length !== type.length) {
            nullable = true;
            current = {
                ...current,
                type: nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes,
            };
        }
    }

    for (const key of ['anyOf', 'oneOf']) {
        const variants = asSchemaArray(current[key]);
        if (variants.length === 0) {
            continue;
        }

        const nonNullVariants = variants.filter((variant) => !isPureNullSchema(variant));
        if (nonNullVariants.length === variants.length) {
            continue;
        }

        nullable = true;
        if (nonNullVariants.length === 1) {
            const resolvedVariant = resolveSchemaRefs(nonNullVariants[0], rootSchema, new Set(seenRefs));
            const merged: SchemaObject = {
                ...resolvedVariant,
                ...current,
            };

            delete merged[key];
            current = merged;
        }
    }

    return { schemaDef: current, nullable };
}

function buildFieldDescriptorInternal(
    key: string,
    path: string[],
    schemaDef: object,
    rootSchema: object,
    seenRefs: Set<string>,
): FieldDescriptor {
    const rootObject = asObject(rootSchema) ?? {};
    const rawSchemaObject = asObject(schemaDef) ?? {};
    const normalizedSchema = resolveSchemaRefs(rawSchemaObject, rootObject, new Set(seenRefs));
    const unwrapped = unwrapNullableSchema(normalizedSchema, rootObject, new Set(seenRefs));

    const enumInfo = collectStringEnumInfo(unwrapped.schemaDef, rootObject, new Set(seenRefs));
    const descriptor: FieldDescriptor = {
        key,
        path,
        label: getSchemaTitle(key, unwrapped.schemaDef),
        description: getString(unwrapped.schemaDef['description']),
        type: 'any',
        nullable: unwrapped.nullable || enumInfo.nullable,
    };

    if ('default' in unwrapped.schemaDef) {
        descriptor.default = unwrapped.schemaDef['default'];
    }

    if (enumInfo.values) {
        descriptor.type = 'enum';
        descriptor.enumValues = enumInfo.values;
        return descriptor;
    }

    const type = getPrimaryType(unwrapped.schemaDef);
    if (type) {
        descriptor.type = type;
    }

    if (descriptor.type === 'any') {
        if (asObject(unwrapped.schemaDef['properties'])) {
            descriptor.type = 'object';
        } else if (unwrapped.schemaDef['items'] !== undefined) {
            descriptor.type = 'array';
        }
    }

    if (descriptor.type === 'object') {
        const properties = asObject(unwrapped.schemaDef['properties']);
        if (properties) {
            descriptor.properties = Object.entries(properties).map(([nestedKey, nestedSchema]) => {
                return buildFieldDescriptorInternal(
                    nestedKey,
                    [...path, nestedKey],
                    asObject(nestedSchema) ?? {},
                    rootObject,
                    new Set(seenRefs),
                );
            });
        }
    }

    if (descriptor.type === 'array') {
        const itemsSchema = asObject(unwrapped.schemaDef['items']);
        descriptor.items = itemsSchema
            ? buildFieldDescriptorInternal(
                'items',
                [...path, 'items'],
                itemsSchema,
                rootObject,
                new Set(seenRefs),
            )
            : {
                key: 'items',
                path: [...path, 'items'],
                label: 'Items',
                type: 'any',
                nullable: false,
            };
    }

    return descriptor;
}

function camelToLabel(key: string): string {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
        return key;
    }

    const exactSpecialCases: Record<string, string> = {
        gmod: 'GMod',
        glua: 'GLua',
        luajit: 'LuaJIT',
        lua: 'Lua',
    };

    const lowerKey = normalizedKey.toLowerCase();
    if (exactSpecialCases[lowerKey]) {
        return exactSpecialCases[lowerKey];
    }

    const spaced = normalizedKey
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();

    const wordSpecialCases: Record<string, string> = {
        gmod: 'GMod',
        glua: 'GLua',
        lua: 'Lua',
        luajit: 'LuaJIT',
        ide: 'IDE',
        mcp: 'MCP',
    };

    return spaced
        .split(' ')
        .map((word) => {
            const lowerWord = word.toLowerCase();
            if (wordSpecialCases[lowerWord]) {
                return wordSpecialCases[lowerWord];
            }

            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
}

/**
 * Resolve a JSON Schema `$ref` against the provided root schema.
 */
export function resolveRef(schema: object, ref: string, seen: Set<string> = new Set()): object | null {
    if (!ref.startsWith('#/')) {
        return null;
    }

    if (seen.has(ref)) {
        return null;
    }
    seen.add(ref);

    const pathTokens = ref
        .slice(2)
        .split('/')
        .map(unescapeJsonPointerToken);

    let current: unknown = schema;
    for (const token of pathTokens) {
        const currentObject = asObject(current);
        if (!currentObject) {
            return null;
        }

        current = currentObject[token];
    }

    return asObject(current) ?? null;
}

/**
 * Build top-level settings categories from an Emmyrc JSON schema.
 */
export function buildCategories(schema: object): Category[] {
    const rootSchema = asObject(schema);
    if (!rootSchema) {
        return [];
    }

    const topLevelProperties = asObject(rootSchema['properties']);
    if (!topLevelProperties) {
        return [];
    }

    const categories: Category[] = [];

    for (const [categoryKey, categorySchema] of Object.entries(topLevelProperties)) {
        if (shouldSkipCategoryKey(categoryKey)) {
            continue;
        }

        const categorySchemaObject = asObject(categorySchema) ?? {};
        const resolvedCategorySchema = resolveSchemaRefs(categorySchemaObject, rootSchema, new Set());
        const nestedProperties = asObject(resolvedCategorySchema['properties']);

        const fields = nestedProperties
            ? Object.entries(nestedProperties).map(([fieldKey, fieldSchema]) => {
                return buildFieldDescriptor(fieldKey, [categoryKey, fieldKey], asObject(fieldSchema) ?? {}, rootSchema);
            })
            : [buildFieldDescriptor(categoryKey, [categoryKey], categorySchemaObject, rootSchema)];

        categories.push({
            key: categoryKey,
            label: getString(categorySchemaObject['title']) ?? getSchemaTitle(categoryKey, resolvedCategorySchema),
            description: getString(categorySchemaObject['description']) ?? getString(resolvedCategorySchema['description']),
            fields,
        });
    }

    return categories;
}

/**
 * Convert a JSON Schema node into a recursive field descriptor.
 */
export function buildFieldDescriptor(
    key: string,
    path: string[],
    schemaDef: object,
    rootSchema: object,
): FieldDescriptor {
    return buildFieldDescriptorInternal(key, path, schemaDef, rootSchema, new Set());
}