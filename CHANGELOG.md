# Changelog

All notable changes to the GLuaLS project (VS Code extension and language server) are documented in this file.

## [1.0.7] - Unreleased

### VS Code Extension
- Add 32/64-bit debugger binary auto-detection on Windows
- Add undefined-global "quickfix" option to add global to config
- Add annotation file path override setting for testing annotations
- Add default 1hr interval for annotation update checking
- Add interactive UI editor for `workspace.ignoreDirDefaults` — view, disable, override, or add to built-in ignore glob defaults per workspace
- Fix various issues with `ignoreDirDefaults` not loading correctly

### Language Server
- Add module support
- Fix various realm related issues
- Fix various undefined-global issues by improving infer system
- Fix validation not correctly narrowing type in some cases
- Fix types not correctly showing for some variables after narrowing
- Update documentation related to debugger

### Debugger
- Fix x64 windows crash

## [1.0.6] - 2026-03-29

### VS Code Extension
- Add option to configure debugger from "GLuaLS Status Bar" menu
- Update package and README
- Fix CI failure on non-tagged builds

### Language Server
- Fix linter issues

## [1.0.5] - 2026-03-28

### VS Code Extension
- Add VSIX files to releases
- Mark extension as preview
- Change sticky scroll to foldingProviderModel by default as workaround
- Remove workspace repair tool
- Fix CI publish workflow not correctly adding LS server

### Language Server
- Fix cross-file class annotation only using last indexed
- Fix narrowing not respecting alias types
- Fix various issues with class fields and inference

## [1.0.4] - 2026-03-28

### VS Code Extension
- Fix permission issue with CI
- Add manual workflow + prerelease debugger builds

### Language Server
- Update badges and documentation

## [1.0.3] - 2026-03-27

### Language Server
- Fix syntax errors showing on wrong line
- Fix valid checks not narrowing type
- Fix style issues
- Fix member inference only showing last definition

## [1.0.2] - 2026-03-26

### Language Server
- Fix failing tests
- Update network configuration documentation

## [1.0.1] - 2026-03-25

### Language Server
- Documentation update

## [1.0.0] - 2026-03-30

### VS Code Extension
- Garry's Mod GLua Language Server fork from EmmyLua Analyzer
- IntelliSense, auto-completion, and diagnostics for GLua
- Syntax highlighting for Garry's Mod Lua
- Go to definition and find references support
- GMod-specific API annotations support
- Realm detection (server/client/shared) based on file paths and content
- Class Explorer sidebar for scripted classes (ENT, SWEP, EFFECT)
- Debugger integration with remote debugging support for GMod (server, client, and shared realms)
- MCP (Model Context Protocol) host for GMod debug tool execution
- Language model tools integration (search docs, run Lua, run commands, get debug state)
- Configuration support via `.gluarc.json` with settings editor UI
- Error explorer panel for runtime error visualization
- Entity explorer panel for in-game entity inspection
- VGUI Panel code lens support
- Auto-annotation update system from gluals-annotations branch