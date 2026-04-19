<p align="center">
  <img src="https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/res/gmod-glua-ls.png" width="128" alt="Garry's Mod Language Server icon">
</p>

<h1 align="center">Garry's Mod Language Server</h1>

<p align="center">
  GLua Language Server and Debugger for Visual Studio Code.
  <br>
  <strong><small>Using the latest pre-release version is recommended</small></strong>
</p>

<p align="center" style="margin:5px;">
  <a href="https://marketplace.visualstudio.com/items?itemName=Pollux.gmod-glua-ls">
    <img src="https://img.shields.io/badge/View%20on%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+VmlzdWFsIFN0dWRpbyBDb2RlPC90aXRsZT48cGF0aCBmaWxsPSd3aGl0ZScgZD0iTTIzLjE1IDIuNTg3TDE4LjIxLjIxYTEuNDk0IDEuNDk0IDAgMCAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAgMC0xLjI3Ni4wNTdMLjMyNyA3LjI2MUExIDEgMCAwIDAgLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMCAwIC4wMDEgMS40NzlMMS42NSAxNy45NGEuOTk5Ljk5OSAwIDAgMCAxLjI3Ni4wNTdsNC4xMi0zLjEyOCA5LjQ2IDguNjNhMS40OTIgMS40OTIgMCAwIDAgMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAgMCAyNCAyMC4wNlYzLjkzOWExLjUgMS41IDAgMCAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg==" alt="View on VS Code Marketplace">
  </a>
</p>

<p align="center" style="margin:0; padding:0;">
  <!-- Extension Stable -->
  <a href="https://github.com/Pollux12/vscode-gmod-glua-ls/releases">
    <img src="https://img.shields.io/github/v/release/Pollux12/vscode-gmod-glua-ls?style=flat-square&label=VSCode%20%5BStable%5D&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+VmlzdWFsIFN0dWRpbyBDb2RlPC90aXRsZT48cGF0aCBmaWxsPSd3aGl0ZScgZD0iTTIzLjE1IDIuNTg3TDE4LjIxLjIxYTEuNDk0IDEuNDk0IDAgMCAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAgMC0xLjI3Ni4wNTdMLjMyNyA3LjI2MUExIDEgMCAwIDAgLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMCAwIC4wMDEgMS40NzlMMS42NSAxNy45NGEuOTk5Ljk5OSAwIDAgMCAxLjI3Ni4wNTdsNC4xMi0zLjEyOCA5LjQ2IDguNjNhMS40OTIgMS40OTIgMCAwIDAgMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAgMCAyNCAyMC4wNlYzLjkzOWExLjUgMS41IDAgMCAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg==&color=007ACC" alt="VSCode Extension Stable">
  </a>
  <!-- Extension Pre-Release (Recommended) -->
  <a href="https://github.com/Pollux12/vscode-gmod-glua-ls/releases">
    <img src="https://img.shields.io/github/v/release/Pollux12/vscode-gmod-glua-ls?style=flat-square&include_prereleases&label=VSCode%20%5BPre-Release%5D&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+VmlzdWFsIFN0dWRpbyBDb2RlPC90aXRsZT48cGF0aCBmaWxsPSd3aGl0ZScgZD0iTTIzLjE1IDIuNTg3TDE4LjIxLjIxYTEuNDk0IDEuNDk0IDAgMCAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAgMC0xLjI3Ni4wNTdMLjMyNyA3LjI2MUExIDEgMCAwIDAgLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMCAwIC4wMDEgMS40NzlMMS42NSAxNy45NGEuOTk5Ljk5OSAwIDAgMCAxLjI3Ni4wNTdsNC4xMi0zLjEyOCA5LjQ2IDguNjNhMS40OTIgMS40OTIgMCAwIDAgMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAgMCAyNCAyMC4wNlYzLjkzOWExLjUgMS41IDAgMCAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg==&color=F7B93E" alt="VSCode Extension Pre-Release">
  </a>
  <!-- GLuaLS Version -->
  <a href="https://github.com/Pollux12/gmod-glua-ls/releases">
    <img src="https://img.shields.io/github/v/release/Pollux12/gmod-glua-ls?style=flat-square&include_prereleases&label=GLuaLS&logo=github&logoColor=white&color=181717" alt="GLuaLS Version">
  </a>
  <br>
  <!-- Documentation -->
  <a href="https://gluals.arnux.net/">
    <img src="https://img.shields.io/badge/Docs-gluals.arnux.net-007ACC?style=flat-square&logo=mintlify&logoColor=white" alt="Documentation">
  </a>
  <!-- Annotations -->
  <a href="https://github.com/Pollux12/annotations-gmod-glua-ls/tree/gluals-annotations">
    <img src="https://img.shields.io/github/last-commit/Pollux12/annotations-gmod-glua-ls/gluals-annotations?style=flat-square&label=Annotations&logo=github&logoColor=white&color=181717" alt="GMod Annotations">
  </a>
  <!-- Issues -->
  <a href="https://github.com/Pollux12/gmod-glua-ls/issues">
    <img src="https://img.shields.io/badge/Issues-GitHub-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub Issues">
  </a>
</p>

> [!IMPORTANT]
> This is an early release. There may be some minor bugs, please report any issues you run into! You should be able to resolve most issues via the config system (e.g. disabling diagnostics or changing folder paths).
> Report bugs or suggest features here: https://github.com/Pollux12/gmod-glua-ls/issues

Visual Studio Code extension for **[gmod-glua-ls](https://github.com/Pollux12/gmod-glua-ls)** - a lightning-fast, fully featured language server, debugger and toolkit for Garry's Mod GLua development.

---

## ⚡ Performance & Overview

* **Rust-Powered Backend:** Delivers full workspace indexing and diagnostics in seconds with a minimal memory footprint — significantly faster on large projects while delivering more features.
* **Full Language Server:** Syntax highlighting, diagnostics, completions, type resolution, go-to definition, renaming, formatting, and more — all powered by the Rust backend.

## 🧠 Designed for Garry's Mod

* **Class Resolution:** Automatic scripted-class resolution for common GMod scopes (`ENT`, `SWEP`, `TOOL`, `EFFECT`, and configurable extras). `NetworkVar`, `AccessorFunc`, and VGUI panel registrations are all tracked.
* **Realm Awareness:** Analyses file prefixes (`sv_`, `cl_`, `sh_`) and `include()` chains, and reports cross-realm diagnostics for incompatible calls and definitions.
* **Network Validation:** Parses `net.Start`/`net.Receive` flows and validates read/write order and type consistency, including diagnostics for missing counterparts and mismatched payloads.
* **Smart Hook Integration:** Hook-aware analysis covering hook-site detection, `GM:`/`PLUGIN:` method prefixes, and diagnostics for invalid hook names.
* **Class Explorer:** Dedicated side-panel for scripted classes and workspace resources (models, materials, sounds, and related GMod file groups).

## 🐞 Integrated Server (SRCDS) Debugger

* **Server & Client Debugger:** Runtime debugger for both GMod server and client sessions, backed by an auto-managed Lua autorun bootstrap.
* **Easier Debugging:** Everything you'd expect from a modern debugger. Set visual breakpoints, pause code execution, inspect local variables, global tables, upvalues, and call stacks live within VS Code.
* **Lua Execution:** Run selected code, entire files (including refresh), or execute engine commands straight from the editor.
* **Lua Error Tracking:** Catch and view runtime Lua errors in a dedicated panel and click through to the precise source code location, helping you easily identify and fix problems. Debugger pause on errors can be configured (default off) for better insight.
* **Live Entity Explorer:** Browse spawned entities, inspect table values and NetworkVars in real-time. Supported values can be edited while the debugger is paused.

## ✨ Advanced Code Intelligence

* **AI & Copilot Integration:** GitHub Copilot Chat gains dedicated language model tools — search GLua API docs, inspect console output, errors, and debug state, and run Lua or commands against an active GMod debug session.
* **VGUI & Entity Assistance:** VGUI-specific CodeLens, inlay hints, and explorer support for panel definitions and scripted-class hierarchies.
* **Refactoring & Navigation:** Go-to definition, find all references, rename, and workspace outline with GMod-aware symbol labeling.

## 🛠 Workspace Tooling & Configuration

* **Interactive Configuration UI:** Built-in settings panel for workspace-local `.gluarc.json` — easily adjust diagnostics, GMod options, and workspace parameters. Useful for silencing false-positive diagnostics without manual JSON editing (please report them too!).
* **Built-In Formatter:** Formatter configured with presets such as CFC, with advanced customisation options available.
* **Automatic Setup & Updates:** Detects addon and gamemode workspace structures, auto-downloads and keeps annotations and the debugger up to date, and handles initial setup — all with minimal configuration needed.
* **Multi-Root Workspace Support:** Designed to work in large codebases, especially with many different folders open within a workspace. Perfect for working on complex gamemodes alongside many addons — see the [multi-root workspace guide](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces) for setup.
* **Plugin Support:** Apply framework-specific annotations and config presets through a lightweight plugin system. A setup wizard and automatic detection handle onboarding, with support for local bundle overrides.
* **Configurable Templates:** Scaffold scripted classes from built-in starters (entities, SWEPs, EFFECTs, tools) or point to your own template path for custom patterns.
* **Detailed Documentation:** Everything you need to know, from annotations to features, is documented on the wiki: https://gluals.arnux.net/

---

## Troubleshooting

Make sure you don't have any other potentially conflicting extensions installed, such as EmmyLua, LuaLS, GLua Enhanced — this should be the only Lua Language Server or Lua Debugger you have installed. It is recommended you create a new VS Code profile for GLua/Garry's Mod development to avoid conflict, especially if other Lua extensions are required for non-GMod related projects.

The debugger is only designed to be used on local development servers; please do not install the binary module on production servers. `gm_rdb` only accepts localhost connections by default. If you need remote attach, start Garry's Mod or SRCDS with `-rdb_allow_remote`. `rdb.activate(...)` keeps the server running by default. If you want it to pause on the next hook event instead, add `-rdb_pause_on_activate`. This extension has only been tested with VSCode and may not work with forks. AI features have only been tested with GitHub Copilot Chat and may not work with other providers.

This extension is primarily designed and tested for addon and/or gamemode development setup within an SRCDS server. If you're doing something outside of this structure, some features may not work or may require manual configuration. The extension currently expects each added workspace folder root to be within either `garrysmod/addons` or `garrysmod/gamemodes`. If you need to edit multiple folders at the same time (such as gamemode alongside addons), I'd recommend adding each individual gamemode or addon as a folder within a [multi-root workspace,](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces) rather than opening the entire garrysmod folder within VSCode.

If you have any advanced configuration (e.g. not using standard Garry's Mod folder structure) that does not seem to work, please create an issue that details what your structure looks like, so that I can add support for it via the configuration system.

---



This is a hard fork of [EmmyLua Analyzer Rust](https://github.com/CppCXY/emmylua-analyzer-rust), maintained specifically for Garry's Mod GLua.
The original EmmyLua project does not support plugins, nor does it have plans to add any, making it difficult to fully adapt for Garry's Mod.
While LuaLS has plugin support, its performance was a bottleneck for large codebases. Many features here are based on my earlier LuaLS addon work, now maintained in [annotations-gmod-glua-ls](https://github.com/Pollux12/annotations-gmod-glua-ls).

