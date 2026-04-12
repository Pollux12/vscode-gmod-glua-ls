# Changelog

## [1.0.12] [Pre-Release (RC2)] - 2026-04-12

### VS Code Extension
- Update docs and UI for multi-root isolation configuration

### Language Server
- Add workspace isolation toggle
- Add config merge system for when workspace isolation is disabled
- Disable workspace isolation by default
- Fix regression causing inlay hint flicker on type
- Fix regression causing edits to class definition not updating global index

## [1.0.11] [Pre-Release (RC)] - 2026-04-11

### VS Code Extension
- Add gamemode base detection + automatic library load attempt for non sandbox/base gamemodes.
- Fix color picker showing outside of brackets for `Color()`

### Language Server
- Add gamemode base detection + automatic library load attempt for non sandbox/base gamemodes.
- Fix goto-def not respecting realms (was not fully realm aware)
- Fix regression with race condition resulting in field assignments being unstable
- Fix undefined `i` in `for i` loops
- Fix color picker not being recognised for many valid Color objects
- Fix narrowing sometimes leading to undefined issues with globals
- Fix infer sometimes leading to incorrect assumptions when infering classes

## [1.0.10] [Pre-Release] - 2026-04-09

### VS Code Extension
- Improved syntax/semantic highlighting
- Fix auto-update failing for debugger on old builds
- Merge debugger update into one command rather than two, improve flow
- Debugger setup overwrites existing binary files if detected

### Language Server
- Merge many commits from upstream
  - Better performance
  - Various bug fixes
- Add better semantic highlighting features
- Fix highlighting not updating if file was already open

### Debugger
- Add fallback version


## [1.0.9] [Pre-Release] - 2026-04-07

### VS Code Extension
- Fix errors and entity panel being shared for all debugger instances
- Add clientside debugger support
- Add optional clientside debugger setup step to debug wizard
- Add client gmod install autodetection
- Update auto-update system for debugger and annotations
- Update srcds install autodetection
- Update documentation

### Language Server
- Fix net read/write mismatch with if statements
- Fix param mismatch not skipping for union checks
- Add entity type narrowing for more accurate entity types
- Update documentation

### Debugger
- Add full clientside debugger support
- Add CLI flags / launch options for pause on activate and allow remote connection (SRCDS + Client)
  - `-rdb_allow_remote` (off by default)
  - `-rdb_pause_on_activate [seconds]` (off by default, time default = 60s, 0 = inf)
- Update CI workflow for better build speed
- Various fixes and improvements


## [1.0.8] [Pre-Release] - 2026-04-04

### VS Code Extension
- Add and improve various tests
- Update documentation
- Update readme

### Language Server
- Fix remaining known realm related issues
- Add and improve various tests
- Update documentation

### Debugger
- Fix x64 win debugger crash with entity explorer
- Add better CI workflow


## [1.0.7] [Pre-Release] - 2026-04-02

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


## [1.0.6] [Pre-Release] - 2026-03-29

### VS Code Extension
- Add option to configure debugger from "GLuaLS Status Bar" menu
- Update package and README
- Fix CI failure on non-tagged builds

### Language Server
- Fix linter issues


## [1.0.5] [Pre-Release] - 2026-03-28

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


## [1.0.4] [Pre-Release] - 2026-03-28

### VS Code Extension
- Fix permission issue with CI
- Add manual workflow + prerelease debugger builds

### Language Server
- Update badges and documentation


## [1.0.3] [Pre-Release] - 2026-03-27

### Language Server
- Fix syntax errors showing on wrong line
- Fix valid checks not narrowing type
- Fix style issues
- Fix member inference only showing last definition


## [1.0.2] [Pre-Release] - 2026-03-26

### Language Server
- Fix failing tests
- Update network configuration documentation


## [1.0.1] [Pre-Release] - 2026-03-25

### Language Server
- Documentation update


## [1.0.0] [Stable] - 2026-03-30

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
