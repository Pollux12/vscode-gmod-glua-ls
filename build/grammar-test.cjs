const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscodeTextmate = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

const repoRoot = path.resolve(__dirname, "..");

async function loadGrammar() {
    const baseGrammar = {
        scopeName: "source.lua",
        patterns: [
            { include: "#comments" },
            { include: "#strings" },
            { include: "#labels" },
            { include: "#function-declaration-member" },
            { include: "#function-declaration-name" },
            { include: "#keywords" },
            { include: "#self" },
            { include: "#library-call" },
            { include: "#member-call" },
            { include: "#property-access" }
        ],
        repository: {
            comments: {
                patterns: [
                    {
                        begin: "--\\[(=*)\\[",
                        end: "\\]\\1\\]",
                        name: "comment.block.lua"
                    },
                    {
                        begin: "--(?!\\[=*\\[)",
                        end: "$",
                        name: "comment.line.double-dash.lua"
                    }
                ]
            },
            strings: {
                patterns: [
                    {
                        begin: "\\[(=*)\\[",
                        end: "\\]\\1\\]",
                        name: "string.quoted.other.multiline.lua"
                    },
                    {
                        begin: "\"",
                        end: "\"",
                        name: "string.quoted.double.lua"
                    },
                    {
                        begin: "'",
                        end: "'",
                        name: "string.quoted.single.lua"
                    }
                ]
            },
            labels: {
                patterns: [
                    {
                        match: "(::)([A-Za-z_][A-Za-z0-9_]*)(::)",
                        captures: {
                            "2": { name: "entity.name.label.lua" }
                        }
                    },
                    {
                        match: "\\b(goto)\\s+([A-Za-z_][A-Za-z0-9_]*)",
                        captures: {
                            "1": { name: "keyword.control.lua" },
                            "2": { name: "entity.name.label.lua" }
                        }
                    }
                ]
            },
            "function-declaration-member": {
                patterns: [
                    {
                        begin: "\\b(?:(local)\\s+)?(function)\\s+([A-Za-z_][A-Za-z0-9_]*)(:|\\.)([A-Za-z_][A-Za-z0-9_]*)\\s*\\(",
                        beginCaptures: {
                            "1": { name: "keyword.local.lua" },
                            "2": { name: "storage.type.function.lua" },
                            "3": { name: "support.class.lua" },
                            "5": { name: "entity.name.function.lua" }
                        },
                        end: "\\)",
                        name: "meta.function.lua",
                        patterns: [{ include: "#function-parameters" }]
                    }
                ]
            },
            "function-declaration-name": {
                patterns: [
                    {
                        begin: "\\b(?:(local)\\s+)?(function)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(",
                        beginCaptures: {
                            "1": { name: "keyword.local.lua" },
                            "2": { name: "storage.type.function.lua" },
                            "3": { name: "entity.name.function.lua" }
                        },
                        end: "\\)",
                        name: "meta.function.lua",
                        patterns: [{ include: "#function-parameters" }]
                    }
                ]
            },
            "function-parameters": {
                patterns: [
                    {
                        match: "\\bself\\b",
                        name: "variable.language.self.lua"
                    },
                    {
                        match: "[A-Za-z_][A-Za-z0-9_]*",
                        name: "variable.parameter.function.lua"
                    }
                ]
            },
            keywords: {
                patterns: [
                    {
                        match: "\\b(?:and|break|do|else|elseif|end|for|function|goto|if|in|local|not|or|repeat|return|then|until|while)\\b",
                        name: "keyword.control.lua"
                    }
                ]
            },
            self: {
                patterns: [
                    {
                        match: "\\bself\\b",
                        name: "variable.language.self.lua"
                    }
                ]
            },
            "library-call": {
                patterns: [
                    {
                        match: "\\b(hook)\\b(?=\\.[A-Za-z_][A-Za-z0-9_]*\\s*\\()",
                        name: "support.function.library.lua"
                    }
                ]
            },
            "member-call": {
                patterns: [
                    {
                        match: "(?<=[:.])([A-Za-z_][A-Za-z0-9_]*)(?=\\s*\\()",
                        name: "support.function.any-method.lua"
                    }
                ]
            },
            "property-access": {
                patterns: [
                    {
                        match: "(?<=\\.)[A-Za-z_][A-Za-z0-9_]*",
                        name: "entity.other.attribute.lua"
                    }
                ]
            }
        }
    };

    const onigWasmPath = path.join(
        repoRoot,
        "node_modules",
        "vscode-oniguruma",
        "release",
        "onig.wasm"
    );
    const wasmBin = fs.readFileSync(onigWasmPath).buffer;
    await oniguruma.loadWASM(wasmBin);

    const registry = new vscodeTextmate.Registry({
        onigLib: Promise.resolve({
            createOnigScanner(patterns) {
                return new oniguruma.OnigScanner(patterns);
            },
            createOnigString(text) {
                return new oniguruma.OnigString(text);
            }
        }),
        getInjections(scopeName) {
            if (scopeName === "source.lua") {
                return ["gluals.lua.injection"];
            }

            return [];
        },
        loadGrammar(scopeName) {
            if (scopeName === "source.lua") {
                return vscodeTextmate.parseRawGrammar(
                    JSON.stringify(baseGrammar),
                    "source.lua.json"
                );
            }

            if (scopeName === "gluals.lua.injection") {
                const grammarPath = path.join(repoRoot, "syntaxes", "glua.tmLanguage.json");
                const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
                return vscodeTextmate.parseRawGrammar(
                    JSON.stringify(grammar),
                    grammarPath
                );
            }

            return null;
        }
    });

    const grammar = await registry.loadGrammar("source.lua");
    assert.ok(grammar, "expected the GLua grammar to load");
    return grammar;
}

function tokenizeLines(grammar, lines) {
    let ruleStack = vscodeTextmate.INITIAL;
    return lines.map((line) => {
        const result = grammar.tokenizeLine(line, ruleStack);
        ruleStack = result.ruleStack;
        return result.tokens;
    });
}

function assertScope(lines, tokensByLine, lineIndex, text, expectedScope, occurrence = 0) {
    const line = lines[lineIndex];
    let searchStart = 0;
    let start = -1;
    for (let i = 0; i <= occurrence; i += 1) {
        start = line.indexOf(text, searchStart);
        assert.notEqual(
            start,
            -1,
            `expected to find "${text}" on line ${lineIndex + 1}`
        );
        searchStart = start + text.length;
    }

    const end = start + text.length;
    const matchingToken = tokensByLine[lineIndex].find(
        (token) =>
            token.startIndex < end &&
            token.endIndex > start &&
            token.scopes.includes(expectedScope)
    );

    assert.ok(
        matchingToken,
        `expected "${text}" on line ${lineIndex + 1} to include scope ${expectedScope}`
    );
}

function assertManifest(packageJson) {
    const grammarContribution = packageJson.contributes?.grammars?.find(
        (grammar) =>
            grammar.scopeName === "gluals.lua.injection" &&
            Array.isArray(grammar.injectTo) &&
            grammar.injectTo.includes("source.lua") &&
            grammar.path === "./syntaxes/glua.tmLanguage.json"
    );
    assert.ok(grammarContribution, "expected a lua injection grammar contribution");

    const semanticTokenTypes = packageJson.contributes?.semanticTokenTypes ?? [];
    assert.ok(
        semanticTokenTypes.some(
            (tokenType) => tokenType.id === "field" && tokenType.superType === "property"
        ),
        "expected the custom field semantic token type"
    );
    assert.ok(
        semanticTokenTypes.some(
            (tokenType) => tokenType.id === "delimiter" && tokenType.superType === "operator"
        ),
        "expected the custom delimiter semantic token type"
    );
    assert.ok(
        semanticTokenTypes.some(
            (tokenType) => tokenType.id === "label" && tokenType.superType === "variable"
        ),
        "expected the custom label semantic token type"
    );
    const semanticTokenModifiers = packageJson.contributes?.semanticTokenModifiers ?? [];
    assert.ok(
        semanticTokenModifiers.some((modifier) => modifier.id === "global"),
        "expected the custom global semantic token modifier"
    );
    assert.ok(
        semanticTokenModifiers.some((modifier) => modifier.id === "local"),
        "expected the custom local semantic token modifier"
    );
    assert.ok(
        semanticTokenModifiers.some((modifier) => modifier.id === "callable"),
        "expected the custom callable semantic token modifier"
    );
    assert.ok(
        semanticTokenModifiers.some((modifier) => modifier.id === "object"),
        "expected the custom object semantic token modifier"
    );
    const semanticScopes = packageJson.contributes?.semanticTokenScopes?.find(
        (entry) => entry.language === "lua"
    )?.scopes;
    assert.ok(semanticScopes, "expected lua semanticTokenScopes");

    for (const key of [
        "class",
        "class.declaration",
        "class.local",
        "class.readonly",
        "event.static",
        "parameter",
        "parameter.declaration",
        "parameter.declaration.documentation",
        "variable",
        "variable.local",
        "variable.local.callable",
        "variable.local.object",
        "variable.local.readonly",
        "variable.declaration.readonly",
        "variable.readonly.local",
        "variable.readonly",
        "variable.abstract",
        "variable.defaultLibrary",
        "variable.documentation",
        "variable.definition",
        "variable.global",
        "variable.declaration",
        "function",
        "function.declaration",
        "function.defaultLibrary",
        "function.static",
        "field",
        "field.declaration",
        "field.declaration.documentation",
        "field.modification",
        "field.declaration.callable",
        "field.declaration.readonly",
        "field.declaration.readonly.callable",
        "field.readonly.modification",
        "field.modification.callable",
        "field.readonly.modification.callable",
        "field.callable",
        "field.readonly",
        "method",
        "method.declaration",
        "namespace",
        "namespace.global",
        "namespace.local",
        "namespace.documentation",
        "namespace.declaration.documentation",
        "namespace.modification.documentation",
        "enumMember",
        "enumMember.declaration.documentation",
        "enumMember.readonly.defaultLibrary",
        "property",
        "property.declaration",
        "property.callable",
        "property.documentation",
        "property.readonly",
        "comment.documentation",
        "keyword",
        "keyword.async",
        "keyword.declaration",
        "keyword.documentation",
        "keyword.readonly",
        "label",
        "macro",
        "delimiter",
        "number",
        "number.static",
        "operator",
        "string",
        "string.deprecated",
        "string.modification",
        "regexp.documentation",
        "struct",
        "struct.declaration",
        "type",
        "type.modification",
        "type.readonly",
        "typeParameter"
    ]) {
        assert.ok(semanticScopes[key], `expected semanticTokenScopes.${key}`);
    }

    assert.deepEqual(
        semanticScopes.parameter.slice(0, 1),
        ["variable.parameter"],
        "expected parameter mapping"
    );
    assert.deepEqual(
        semanticScopes.variable.slice(0, 1),
        ["variable.other.readwrite"],
        "expected variable mapping"
    );
    assert.deepEqual(
        semanticScopes["variable.readonly"].slice(0, 1),
        ["variable.other.constant"],
        "expected readonly variable mapping"
    );
    assert.deepEqual(
        semanticScopes.property.slice(0, 1),
        ["variable.other.property"],
        "expected property mapping"
    );
    assert.deepEqual(
        semanticScopes.namespace.slice(0, 1),
        ["entity.name.namespace"],
        "expected namespace mapping"
    );
    assert.deepEqual(
        semanticScopes["function.defaultLibrary"].slice(0, 1),
        ["support.function"],
        "expected default library function mapping"
    );
    assert.deepEqual(
        semanticScopes.field.slice(0, 2),
        ["entity.other.attribute.lua", "variable.other.property"],
        "expected table fields to preserve the TextMate member color before generic property fallback"
    );
    assert.deepEqual(
        semanticScopes["variable.local.object"].slice(0, 2),
        ["support.variable", "variable.other.readwrite.local"],
        "expected object-like locals to have an expressive table/object fallback"
    );
    assert.deepEqual(
        semanticScopes["variable.local.callable"].slice(0, 3),
        [
            "entity.name.function",
            "support.function.any-method.lua",
            "variable.other.readwrite.local"
        ],
        "expected callable local variables to use function-first fallbacks"
    );
    assert.deepEqual(
        semanticScopes["namespace.local"].slice(0, 1),
        ["entity.name.namespace"],
        "expected local namespace aliases to keep namespace fallback"
    );
    assert.deepEqual(
        semanticScopes["class.local"].slice(0, 1),
        ["entity.name.type.class"],
        "expected local class aliases to keep class fallback"
    );
    assert.deepEqual(
        semanticScopes["field.modification"].slice(0, 2),
        ["entity.other.attribute.lua", "variable.other.property"],
        "expected modified fields to preserve table-member fallback"
    );
    assert.deepEqual(
        semanticScopes["field.callable"].slice(0, 2),
        ["entity.other.attribute.lua", "variable.other.property"],
        "expected callable fields to preserve table-member fallbacks before function fallbacks"
    );
    assert.deepEqual(
        semanticScopes.label.slice(0, 1),
        ["entity.name.label.lua"],
        "expected labels to preserve the TextMate label fallback"
    );
    assert.deepEqual(
        semanticScopes["field.declaration.callable"].slice(0, 2),
        ["entity.other.attribute.lua", "variable.other.property"],
        "expected declared callable fields to preserve table-member fallbacks"
    );
    assert.deepEqual(
        semanticScopes["field.modification.callable"].slice(0, 2),
        ["entity.other.attribute.lua", "variable.other.property"],
        "expected modified callable fields to preserve table-member fallbacks"
    );
    assert.deepEqual(
        semanticScopes["field.declaration.documentation"].slice(0, 2),
        ["entity.other.attribute.lua", "variable.other.property"],
        "expected documented field payloads to preserve field fallbacks"
    );
    assert.ok(
        semanticScopes["field.declaration.documentation"].includes("comment.line.documentation.lua"),
        "expected documented field payloads to retain documentation fallback"
    );
    assert.deepEqual(
        semanticScopes["parameter.declaration.documentation"].slice(0, 1),
        ["variable.parameter"],
        "expected documented parameters to preserve parameter fallback"
    );
    assert.ok(
        semanticScopes["parameter.declaration.documentation"].includes("comment.line.documentation.lua"),
        "expected documented parameters to retain documentation fallback"
    );
    assert.deepEqual(
        semanticScopes["namespace.documentation"].slice(0, 1),
        ["entity.name.namespace"],
        "expected documented namespace payloads to preserve namespace fallback"
    );
    assert.ok(
        semanticScopes["namespace.documentation"].includes("comment.line.documentation.lua"),
        "expected documented namespace payloads to retain documentation fallback"
    );
    assert.deepEqual(
        semanticScopes["enumMember.declaration.documentation"].slice(0, 2),
        ["variable.other.enummember", "entity.name.constant"],
        "expected documented enum-like payloads to preserve enum-member fallback"
    );
    assert.deepEqual(
        semanticScopes["variable.documentation"].slice(0, 1),
        ["variable.other.readwrite"],
        "expected documented return names to preserve variable fallback"
    );
    assert.deepEqual(
        semanticScopes["property.documentation"].slice(0, 1),
        ["variable.other.property"],
        "expected documented diagnostic actions to preserve property fallback"
    );
    assert.deepEqual(
        semanticScopes["regexp.documentation"].slice(0, 1),
        ["string.regexp"],
        "expected documented diagnostic codes to preserve regexp fallback"
    );
    assert.ok(
        semanticScopes["field.callable"].includes("meta.object.member"),
        "expected callable fields to retain object-member fallback"
    );
    assert.deepEqual(
        semanticScopes["variable.global"].slice(0, 2),
        ["variable.other.readwrite.global", "variable.other.readwrite"],
        "expected globals to use standard variable fallbacks"
    );
    assert.deepEqual(
        semanticScopes["enumMember.readonly.defaultLibrary"].slice(0, 2),
        ["variable.other.enummember", "support.constant"],
        "expected builtin constants to use enum-member/default-library fallbacks"
    );
    assert.deepEqual(
        semanticScopes["field.readonly"].slice(0, 3),
        [
            "entity.other.attribute.lua",
            "variable.other.property",
            "meta.property-name"
        ],
        "expected readonly table fields to preserve table-member fallback before constant fallback"
    );
    assert.ok(
        semanticScopes["field.readonly"].includes("meta.object.member"),
        "expected readonly table fields to retain object-member fallback"
    );
    assert.ok(
        semanticScopes["field.readonly"].includes("variable.other.constant.property"),
        "expected readonly table fields to retain constant fallback"
    );
    assert.deepEqual(
        semanticScopes["field.readonly.modification"].slice(0, 3),
        [
            "entity.other.attribute.lua",
            "variable.other.property",
            "meta.property-name"
        ],
        "expected readonly modified fields to preserve table-member fallback before constant fallback"
    );
    assert.ok(
        semanticScopes["field.readonly.modification"].includes("meta.object.member"),
        "expected readonly modified fields to retain object-member fallback"
    );
    assert.ok(
        semanticScopes["field.readonly.modification"].includes("variable.other.constant.property"),
        "expected readonly modified fields to retain constant fallback"
    );
    assert.deepEqual(
        semanticScopes["field.declaration.readonly"].slice(0, 3),
        [
            "entity.other.attribute.lua",
            "variable.other.property",
            "meta.property-name"
        ],
        "expected readonly declared fields to preserve table-member fallback before constant fallback"
    );
    assert.ok(
        semanticScopes["field.declaration.readonly"].includes("meta.object.member"),
        "expected readonly declared fields to retain object-member fallback"
    );
    assert.ok(
        semanticScopes["field.declaration.readonly"].includes("variable.other.constant.property"),
        "expected readonly declared fields to retain constant fallback"
    );
    assert.deepEqual(
        semanticScopes.delimiter.slice(0, 2),
        ["punctuation.section.group.lua", "punctuation.separator.lua"],
        "expected delimiter fallback scopes"
    );

    assert.equal(
        packageJson.contributes.configuration.find((section) => section.title === "Decorations")
            .properties["gluals.decorations.mutableLocalUnderline"].default,
        false,
        "expected decoration underlines to be opt-in by default"
    );
    for (const key of [
        "gluals.decorations.globalUnderline",
        "gluals.decorations.readonlyLocalUnderline",
        "gluals.decorations.mutableLocalUnderline",
        "gluals.decorations.readonlyParameterUnderline",
        "gluals.decorations.mutableParameterUnderline"
    ]) {
        assert.equal(
            packageJson.contributes.configuration.some(
                (section) => key in section.properties
            ),
            true,
            `expected ${key} to be contributed`
        );
    }
}

async function main() {
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
    );
    assertManifest(packageJson);

    const grammar = await loadGrammar();
    const lines = [
        "---@param ply Player",
        "---@field Owner Player",
        "---@readonly",
        "function ENT:Use(ply)",
        "    self.Owner = ply",
        "    hook.Add(\"Think\", \"id\", function() end) // injected comment",
        "    local text = [[hello]]",
        "    local _, legacyAddons = file.Find(\"garrysmod/addons/*\", \"BASE_PATH\")",
        "    if a != b && c || d then continue end",
        "    /* block comment */",
        "    if MENU_DLL then return CLIENT end",
        "::continue::",
        "goto continue"
    ];
    const tokensByLine = tokenizeLines(grammar, lines);

    assertScope(lines, tokensByLine, 0, "@param", "storage.type.annotation.lua");
    assertScope(lines, tokensByLine, 0, "ply", "variable.parameter.function.lua");
    assertScope(lines, tokensByLine, 0, "Player", "support.type.lua");
    assertScope(lines, tokensByLine, 1, "@field", "storage.type.annotation.lua");
    assertScope(lines, tokensByLine, 1, "Owner", "entity.other.attribute.lua");
    assertScope(lines, tokensByLine, 1, "Player", "support.type.lua");
    assertScope(lines, tokensByLine, 2, "@readonly", "storage.type.annotation.lua");
    assertScope(lines, tokensByLine, 3, "function", "storage.type.function.lua");
    assertScope(lines, tokensByLine, 3, "Use", "entity.name.function.lua");
    assertScope(lines, tokensByLine, 3, "ply", "variable.parameter.function.lua");
    assertScope(lines, tokensByLine, 4, "self", "variable.language.self.lua");
    assertScope(lines, tokensByLine, 4, "Owner", "entity.other.attribute.lua");
    assertScope(lines, tokensByLine, 5, "hook", "support.function.library.lua");
    assertScope(lines, tokensByLine, 5, "Add", "support.function.any-method.lua");
    assertScope(lines, tokensByLine, 6, "hello", "string.quoted.other.multiline.lua");
    assertScope(lines, tokensByLine, 7, "garrysmod/addons/*", "string.quoted.double.lua");
    assertScope(lines, tokensByLine, 8, "!=", "keyword.operator.lua");
    assertScope(lines, tokensByLine, 8, "&&", "keyword.operator.lua");
    assertScope(lines, tokensByLine, 8, "||", "keyword.operator.lua");
    assertScope(lines, tokensByLine, 8, "continue", "keyword.control.lua");
    assertScope(lines, tokensByLine, 9, "block comment", "comment.block.lua");
    assertScope(lines, tokensByLine, 10, "MENU_DLL", "constant.language.lua");
    assertScope(lines, tokensByLine, 10, "CLIENT", "constant.language.lua");
    assertScope(lines, tokensByLine, 11, "continue", "entity.name.label.lua");
    assertScope(lines, tokensByLine, 12, "goto", "keyword.control.lua");
    assertScope(lines, tokensByLine, 12, "continue", "entity.name.label.lua");

    console.log("grammar and manifest checks passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
