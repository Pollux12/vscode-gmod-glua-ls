# Project Guidelines

## Product Shape
- This repository is the VS Code extension and editor tooling layer for GLuaLS. The core language server, parser, diagnostics, and indexing logic live in the sibling `../gmod-glua-ls` repository.
- Prefer changing `../gmod-glua-ls` for language-server semantics instead of reimplementing them in TypeScript here.
- Optimize for Garry's Mod and GLua workflows first. This extension is intentionally GMod-specific, not generic Lua tooling. It integrates our custom GLuaLS language server into VSCode and provides additional GMod-specific features.

## Where To Look
- `package.json` is the source of truth for extension contributions such as commands, settings, language model tools, debuggers, views, snippets, and grammars.
- `src/extension.ts` owns activation, command registration, feature startup, language model tool registration, realm persistence, and MCP host lifecycle.
- `src/debugger/gmod_debugger/` owns debugger providers, control flow, setup wizard logic, and `gm_rdb` / `rdb_client` install and update flows.
- `src/gluarcSettingsPanel.ts`, `src/gluarcConfig.ts`, and `src/gluarcSchema.ts` own the `.gluarc.json` settings editor and schema-driven UI behavior.
- `src/gmodExplorer.ts`, `src/gmodEntityExplorerView.ts`, and `src/gmodErrorView.ts` own the main GMod-specific tree views and runtime views.
- `src/gmodAnnotationManager.ts` owns annotation download and update behavior.
- `src/gmodMcpHost.ts` and `src/tools/` own the MCP host and tool-facing runtime integrations.
- `build/` plus the `package.json` scripts own packaging, release preparation, schema/settings sync, and language-server bundling.
- `syntaxes/`, `language-configuration.json`, and `src/languageConfiguration.ts` own syntax and editor language configuration behavior.

## Non-Obvious Conventions
- This repository uses a custom version scheme: `1.0.x` means pre-release, while `1.x.0` means stable. Do not assume patch versions are stable here.
- Release-channel logic depends on that rule. Check `src/debugger/gmod_debugger/GmodDebugSetupWizard.ts` and `build/prepare.js` before changing updater, release selection, or packaging behavior.
- Development packaging expects to bundle or locate the Rust language server from the sibling `../gmod-glua-ls` repository. Validate any path or packaging change against that cross-repo assumption.
- The debugger is split by runtime target: server debugging uses `gm_rdb`, while client debugging uses `rdb_client`. Do not collapse that into a single generic debugger path.

## Change Guidance
- If a change affects settings or `.gluarc.json` editing, update the VS Code setting contribution metadata in `package.json`, the schema/UI helpers in `src/gluarcSchema.ts` and `src/gluarcSettingsPanel.ts`, and any related validation or sync scripts under `build/` or `scripts/`.
- If a change affects commands, tools, views, or startup wiring, start in `src/extension.ts` and follow the feature module from there.
- If a change affects analysis, diagnostics, completion, hover, or indexing behavior, the owning code is usually in `../gmod-glua-ls`, not this repository.
- Prefer the smallest validation that matches the change. Start with `npm run compile` for TypeScript changes, then use targeted tests such as `npm run test:schema`, `npm run test:grammar`, `npm run test:parity`, or `npm run test:extension` before broader packaging runs.