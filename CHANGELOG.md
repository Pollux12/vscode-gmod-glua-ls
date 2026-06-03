# Changelog

---

## [1.0.25] [Pre-Release (RC6)] - 2026-06-03
>
> Release candidate for 1.1.0

## VS Code Extension

- Add context menu option to ignore directory (right click on explorer view on directory)
- Add context menu option to add global variable (right click on problems view on undefined-global diagnostic - relevant file must be open as well)

## Language Server

- Fix a bug where tables which were constantly overwritten would stop binding after first overwrite (issue seen mostly with panels, where multiple panels are defined in same file).
- Various performance and stability improvements.

---

## [1.0.24] [Pre-Release (RC5)] - 2026-06-02
>
> Release candidate for 1.1.0

## VS Code Extension

- Add support for rich color previews in autocomplete and hover.

## Language Server

- Add rich color previews in autocomplete and hover.
- Add better type information in autocomplete for many known types.
- Various performance and stability improvements.

---

## [1.0.23] [Pre-Release (RC4)] - 2026-06-01
>
> Release candidate for 1.1.0

## Language Server

- Speculative fixes for more potential table index nil false positives (refactored table indexing with new merge system).
- Various performance and stability improvements.

---

## [1.0.22] [Pre-Release (RC3)] - 2026-05-31
>
> Release candidate for 1.1.0

## Language Server

- Fix functions definition signature binding to local variables rather than actual definition.
- Fix "goto definition" going to variable definition rather than function definition.
- Fix usages count showing all references rather than just function usages.

---

## [1.0.21] [Pre-Release (RC2)] - 2026-05-31
>
> Release candidate for 1.1.0

## Language Server

- Improved performance and stability.
- Improve IsX checks and move to annotation level
- Fix shared diagnostics being lost on the currently open file.
- Fix realm mismatch false positive when there are multiple definitions on different realms.
- Fix param-type-mismatch when there's a union containing type `any`.
- Fix guarded tables overwriting previous definitions for that table.
- Fix self assigned to variable sometimes becoming a literal table rather than remaining as a class

## Annotations

- Add IsX annotations to replace hardcoded functions.
- Fix iterator not returning correct function.
- Fix IsPlayer not narrowing to player type.

---

## [1.0.20] [Pre-Release (RC1)] - 2026-05-26
>
> Release candidate for 1.1.0

## VS Code Extension

- Move to dedicated `annotations-gmod-glua-ls` repository for GMod annotation downloads.
- Add `gluals.gmod.annotationsRepository` setting.
- Add `gluals.gmod.annotationsBranch` setting.
- Improve annotation validation when annotations are from a different source.
- Fix language server status being shown as ready too early (before initial index + diagnostic run)
- Fix existing annotations using old source not being updated automatically.
- Fix extension startup stalling if the language server takes too long to respond.
- Fix annotation download URL not encoding branch names with special characters correctly.

## Language Server

- Add `func` to `function` default parameter mapping.
- Add default GLua parameter type conversion.
- Add `strictTypeCoercion` mode.
- Add built-in `std.Split` support.
- Add `BaseClass` support for panel classes.
- Add `---@outparam` tag support.
- Add default value syntax support for optional parameters.
- Add `NULL` entity support.
- Add inference for fields set by helper functions.
- Improve dynamic fields for metatable-based objects.
- Improve dynamic field completion, hover and go-to-definition.
- Improve hover ordering and explicit realm display.
- Improve scripted class dynamic field resolution.
- Improve metatable inference.
- Improve references, definitions, hover and implementations.
- Improve performance for indexing and diagnostic phases.
- Improve documentation for annotations, configuration, language features, and debugger.
- Fix false positive undefined-field errors on numerically-indexed tables.
- Fix false positive type mismatch errors on inherited class method parameters.
- Fix false positives from nil checks and initialized table assignment chains.
- Fix type narrowing being cut short in large files.
- Fix whitespace breaking table indexing.
- Fix `pairs()` on exact tables losing key and value types.
- Fix workspace overrides hiding documented library return types.
- Fix globals not being resolved correctly in some cases.
- Fix TOOL files under `lua/weapons/gmod_tool/stools/**` being treated as SWEPs.
- Fix SWEP default tool file exclusion being too broad and excluding unrelated files.
- Fix scripted class file exclusions not being scoped correctly.
- Fix scripted class type identities leaking or conflicting across different scripted classes.
- Fix inferred table shapes and types being lost or not preserved across conditional branches.
- Fix generic table indexing incorrectly inferring return values as `nil`.
- Fix return types of metatables sometimes displaying as generic tables instead of their exact shape.
- Fix function overloads not resolving correctly when parameters are inferred as `nil`.
- Fix incorrect type narrowing for table unions and condition checks.
- Fix false positive parameter type mismatch diagnostics on numeric type aliases and nullable unions.
- Fix parameter count and type mismatch diagnostics incorrectly flagging split realm commands.
- Fix nil-check warning suppression to correctly validate prior `IsValid` guard conditions.
- Fix nil-check guard scope escaping to unrelated branches when using `elseif`.
- Fix `@outparam` side-effects not being tracked through locally-aliased variables.
- Fix false positive parameter types caused by inferring `Angle` from parameter names like `ang`.
- Fix `glua_check` temp workspaces conflicting under concurrent diagnostics.
- Fix unstable dynamic field inference after edits.
- Fix dynamic field inference and member lookups not being position-aware or scoped to the exact owner.
- Fix go-to-definition and references matching same-line writes or wildcard definitions for dynamic fields.
- Fix net message flow tracking not tracing reads/writes through class methods.
- Fix unstable cross-file type caches causing non-deterministic diagnostics.
- Fix `NetworkVar`s defined outside of `shared.lua` not being detected.
- Fix `NetworkVar`s not being detected in scripted classes.
- Fix file-scoped dynamic fields leaking across files when globals are disabled.
- Fix `scripted_ents.GetMember(...)` not carrying over `NetworkVar` accessors.
- Fix startup-complete status being sent before initial workspace diagnostics finish.
- Fix optional/default parameter type handling.
- Fix type handling for `self`, locals and default members.
- Fix floats in default parameter values being parsed as integers.
- Fix duplicate outparam tags not being merged correctly.
- Fix `NULL` not being removed after an `IsValid` check.
- Fix inconsistent diagnostics caused by unstable type ordering.
- Fix diagnostic flickering during analysis.
- Fix fields default values not being treated as optional.

## Annotations

- Move to dedicated `annotations-gmod-glua-ls` repository.
- Add `NULL` entity support.
- Add `string.Explode` override.
- Add `HTTPRequest` type override.
- Add `collectgarbage` override.
- Add `WEAPON:Holster` hook override.
- Add `net.ReadTable` override.
- Add `SKIN` class override.
- Add `Label:SetFont` and `Label:SetTextColor` methods.
- Add `scripted_ents.GetMember` override.
- Add overrides for `LeftClick` and `RightClick` hooks.
- Add `Panel.BaseClass` field.
- Add outparam annotations to trace functions (`util.TraceEntity`, `util.TraceEntityHull`, `util.TraceHull`, `util.TraceLine`).
- Add type overrides for networked variable getters (`GetNW*` and `GetNetworked*`).
- Add generic `table.Copy` override.
- Add support for generating parameter default values from the wiki.
- Add missing built-in entity classes (`env_fire`, `prop_dynamic_override`, `prop_ragdoll`, `prop_vehicle_prisoner_pod`).
- Add duplicator and `EntityCopyData` overrides.
- Improve `string.Split` typing.
- Improve global `Entity` typing.
- Improve `ipairs` iterator return typing.
- Improve struct class annotations using `@field`.
- Fix `os.date` `*t` overloads to return `DateData`.
- Fix `debug.getinfo` incorrect parameters and return type.
- Fix `FindMetaTable` incorrectly returning `nil`.
- Fix `Entity.BaseClass` typed as `Entity?`.
- Fix `string.gsub` incorrect parameters.
- Fix numerical enum annotations.
- Fix `file.Read` and `file.Write` annotations being missing in built outputs.
- Fix `os.date` format parameter was not optional.
- Fix `EntityCopyData` transform fields was not optional.
- Fix `NULL` entity did not inherit from `Entity` type.

---

## [1.0.19] [Pre-Release] - 2026-04-29

## Language Server

- Add support for metatable registration complex types and methods.
- Fix table keys being nil in for loops.
- Fix unknown field access not being potentially nil.
- Fix no warning diagnostic on attempt to access a field for a potentially nil variable.
- Fix guarded table assignments not being registered correctly.
- Fix over-eager narrowing to any and restored unknown for no type found.
- Fix some diagnostics being unstable / non-deterministic due to race conditions.
- Fix narrowing for globals after valid checks.
- Fix language server dropping narrowed types too early.
- Fix table access for sequential tables being inferred as nil.
- Fix field index not strictly looking for exact matches.
- Various other minor fixes and improvements.

---

## [1.0.18] [Pre-Release] - 2026-04-26

### VS Code Extension

- Add experimental macOS support.

### Language Server

- Add experimental macOS support.

### Debugger

- Add experimental macOS support.

---

## [1.0.17] [Pre-Release] - 2026-04-23

### VS Code Extension

- Improve language server start, stop and restart handling.
- Add experimental macOS VSIX packaging for darwin-x64 and darwin-arm64. macOS language server builds and debugger support are experimental.

### Language Server

- Add advanced base gamemode detection + automatic library load attempt.
- Add undefined-global-argument diagnostic (warning) to split undefined-global diagnostic (error) into severe and non-severe cases.
- Add code lens and rich hover info for net messages.
- Add hover link to open the Garry's Mod wiki for API functions.
- Improve net message diagnostics to track dynamic read/write patterns.
- Improve realm-aware narrowing and fix some realm mismatch issues.
- Improve workspace loading performance.
- Improve performance with additional indexing optimizations.
- Fix various unknown member, undefined global and infer issues.
- Fix string union field assignment false positives.
- Fix invalid unused diagnostics for scripted classes.
- Fix table field inference false positives and hover displaying nil incorrectly.
- Fix incorrect narrowing from child class field definitions.
- Fix multi-return local variable handling. (thanks @apyrr)

### Annotations

- Annotations are being moved to a new repo, and won't be updated until next pre-release.

---

## [1.0.16] [Pre-Release] - 2026-04-13

- Version bump (same as 1.0.15)

---

## [1.0.15] [Stable] - 2026-04-13

- All changes from 1.0.6 -> 1.0.14
- Fix potential crash on startup

---

## [1.0.14] [Pre-Release (RC4)] - 2026-04-13

### Language Server

- Fix various string issues
- Fix various module issues

### Annotations

- Fix file class missing methods
- Fix string.gsub missing parameters
- Fix debug.getinfo incorrect parameters
- Fix integer enums not allowing raw integer values

---

## [1.0.13] [Pre-Release (RC3)] - 2026-04-12

### Language Server

- Fixed a bug where module used with redefined `package.seeall` resulted in corruption of language server output.

---

## [1.0.12] [Pre-Release (RC2)] - 2026-04-12

### VS Code Extension

- Update docs and UI for multi-root isolation configuration

### Language Server

- Add workspace isolation toggle
- Add config merge system for when workspace isolation is disabled
- Disable workspace isolation by default
- Fix regression causing inlay hint flicker on type
- Fix regression causing edits to class definition not updating global index

---

## [1.0.11] [Pre-Release (RC1)] - 2026-04-11

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

---

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

---

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

---

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

---

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

---

## [1.0.6] [Pre-Release] - 2026-03-29

### VS Code Extension

- Add option to configure debugger from "GLuaLS Status Bar" menu
- Update package and README
- Fix CI failure on non-tagged builds

### Language Server

- Fix linter issues

---

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

---

## [1.0.4] [Pre-Release] - 2026-03-28

### VS Code Extension

- Fix permission issue with CI
- Add manual workflow + prerelease debugger builds

### Language Server

- Update badges and documentation

---

## [1.0.3] [Pre-Release] - 2026-03-27

### Language Server

- Fix syntax errors showing on wrong line
- Fix valid checks not narrowing type
- Fix style issues
- Fix member inference only showing last definition

---

## [1.0.2] [Pre-Release] - 2026-03-26

### Language Server

- Fix failing tests
- Update network configuration documentation

---

## [1.0.1] [Pre-Release] - 2026-03-25

### Language Server

- Documentation update

---

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
