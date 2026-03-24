const LUA_FUNCTION_BLOCK_START_SOURCES = [
    String.raw`\s*function\b.*\(.*\)\s*`,
    String.raw`\s*local\s+\w+\s*=\s*function\s*\(.*\)\s*`,
    String.raw`\s*.*\s*=\s*function\s*\(.*\)\s*`,
    String.raw`\s*local\s+function\b.*\(.*\)\s*`,
];

export const LUA_FUNCTION_BLOCK_START_PATTERNS: readonly RegExp[] = LUA_FUNCTION_BLOCK_START_SOURCES.map(
    (source) => new RegExp(`^${source}$`)
);

export const LUA_BLOCK_START_PATTERNS: readonly RegExp[] = [
    /^\s*if\b.+\bthen\s*$/,
    /^\s*elseif\b.+\bthen\s*$/,
    /^\s*else\s*$/,
    /^\s*for\b.+\bdo\s*$/,
    /^\s*while\b.+\bdo\s*$/,
    /^\s*do\s*$/,
    ...LUA_FUNCTION_BLOCK_START_PATTERNS,
];

export const LUA_EXISTING_CLOSER_PATTERN = /^\s*(end|else|elseif|until)\b/;
