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
                            "2": { name: "keyword.control.lua" },
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
                            "2": { name: "keyword.control.lua" },
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
        "event",
        "parameter",
        "parameter.callable",
        "parameter.declaration",
        "parameter.declaration.callable",
        "parameter.modification",
        "variable",
        "variable.declaration",
        "variable.modification",
        "variable.local",
        "variable.local.declaration",
        "variable.local.modification",
        "variable.object",
        "variable.local.object",
        "variable.local.declaration.object",
        "variable.local.modification.object",
        "variable.global",
        "variable.global.modification",
        "variable.global.object",
        "variable.callable",
        "variable.local.callable",
        "variable.global.callable",
        "variable.readonly",
        "parameter.object",
        "parameter.declaration.object",
        "function",
        "function.callable",
        "function.declaration",
        "function.defaultLibrary",
        "field",
        "field.callable",
        "field.global",
        "field.global.callable",
        "field.declaration",
        "field.modification",
        "method",
        "method.callable",
        "method.declaration",
        "namespace",
        "namespace.defaultLibrary",
        "property",
        "property.declaration",
        "property.modification"
    ]) {
        assert.ok(semanticScopes[key], `expected semanticTokenScopes.${key}`);
    }

    assert.deepEqual(
        semanticScopes.parameter.slice(0, 2),
        ["variable.parameter", "variable.parameter.lua"],
        "expected parameter mapping to start from VS Code defaults"
    );
    assert.deepEqual(
        semanticScopes.variable.slice(0, 2),
        ["variable.other.readwrite", "entity.name.variable"],
        "expected variable mapping to start from VS Code defaults"
    );
    assert.deepEqual(
        semanticScopes["variable.readonly"].slice(0, 1),
        ["variable.other.constant"],
        "expected readonly variables to use the default constant scope"
    );
    assert.deepEqual(
        semanticScopes.property.slice(0, 1),
        ["variable.other.property"],
        "expected property mapping to start from the default property scope"
    );
    assert.deepEqual(
        semanticScopes.namespace.slice(0, 2),
        ["entity.name.namespace", "entity.name.type.module"],
        "expected namespace mapping to start from namespace/module scopes"
    );
    assert.deepEqual(
        semanticScopes["function.defaultLibrary"].slice(0, 2),
        ["support.function", "entity.name.function"],
        "expected default library functions to keep the default support.function scope first"
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
        "function ENT:Use(ply)",
        "    self.Owner = ply",
        "    hook.Add(\"Think\", \"id\", function() end) // injected comment",
        "    local text = [[hello]]",
        "    local _, legacyAddons = file.Find(\"garrysmod/addons/*\", \"BASE_PATH\")",
        "    if a != b && c || d then continue end",
        "    /* block comment */",
        "::continue::",
        "goto continue"
    ];
    const tokensByLine = tokenizeLines(grammar, lines);

    assertScope(lines, tokensByLine, 0, "@param", "storage.type.annotation.lua");
    assertScope(lines, tokensByLine, 0, "ply", "variable.parameter.function.lua");
    assertScope(lines, tokensByLine, 0, "Player", "support.type.lua");
    assertScope(lines, tokensByLine, 1, "function", "storage.type.function.lua");
    assertScope(lines, tokensByLine, 1, "Use", "entity.name.function.lua");
    assertScope(lines, tokensByLine, 1, "ply", "variable.parameter.function.lua");
    assertScope(lines, tokensByLine, 2, "self", "variable.language.self.lua");
    assertScope(lines, tokensByLine, 2, "Owner", "entity.other.attribute.lua");
    assertScope(lines, tokensByLine, 3, "hook", "support.function.library.lua");
    assertScope(lines, tokensByLine, 3, "Add", "support.function.any-method.lua");
    assertScope(lines, tokensByLine, 4, "hello", "string.quoted.other.multiline.lua");
    assertScope(lines, tokensByLine, 5, "garrysmod/addons/*", "string.quoted.double.lua");
    assertScope(lines, tokensByLine, 6, "!=", "keyword.operator.lua");
    assertScope(lines, tokensByLine, 6, "&&", "keyword.operator.lua");
    assertScope(lines, tokensByLine, 6, "||", "keyword.operator.lua");
    assertScope(lines, tokensByLine, 6, "continue", "keyword.control.lua");
    assertScope(lines, tokensByLine, 7, "block comment", "comment.block.lua");
    assertScope(lines, tokensByLine, 8, "continue", "entity.name.label.lua");
    assertScope(lines, tokensByLine, 9, "goto", "keyword.control.lua");
    assertScope(lines, tokensByLine, 9, "continue", "entity.name.label.lua");

    console.log("grammar and manifest checks passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
