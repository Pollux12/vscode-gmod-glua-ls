<p align="center">
  <img src="https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/res/gmod-glua-ls.png" width="128" alt="Garry's Mod Language Server icon">
</p>

<h1 align="center">Garry's Mod Language Server</h1>

<p align="center">
  Advanced Gmod GLua language server for Visual Studio Code.
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
  <a href="https://marketplace.visualstudio.com/items?itemName=Pollux.gmod-glua-ls">
    <img src="https://img.shields.io/visual-studio-marketplace/v/Pollux.gmod-glua-ls?style=flat-square&label=VSCode%20%5BStable%5D&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+VmlzdWFsIFN0dWRpbyBDb2RlPC90aXRsZT48cGF0aCBmaWxsPSd3aGl0ZScgZD0iTTIzLjE1IDIuNTg3TDE4LjIxLjIxYTEuNDk0IDEuNDk0IDAgMCAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAgMC0xLjI3Ni4wNTdMLjMyNyA3LjI2MUExIDEgMCAwIDAgLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMCAwIC4wMDEgMS40NzlMMS42NSAxNy45NGEuOTk5Ljk5OSAwIDAgMCAxLjI3Ni4wNTdsNC4xMi0zLjEyOCA5LjQ2IDguNjNhMS40OTIgMS40OTIgMCAwIDAgMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAgMCAyNCAyMC4wNlYzLjkzOWExLjUgMS41IDAgMCAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg==&color=007ACC" alt="VSCode Extension Stable">
  </a>
  <!-- Extension Pre-Release (Recommended) -->
  <a href="https://marketplace.visualstudio.com/items?itemName=Pollux.gmod-glua-ls">
    <img src="https://img.shields.io/visual-studio-marketplace/v/Pollux.gmod-glua-ls?style=flat-square&include_prereleases&label=VSCode%20%5BPre-Release%5D&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+VmlzdWFsIFN0dWRpbyBDb2RlPC90aXRsZT48cGF0aCBmaWxsPSd3aGl0ZScgZD0iTTIzLjE1IDIuNTg3TDE4LjIxLjIxYTEuNDk0IDEuNDk0IDAgMCAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAgMC0xLjI3Ni4wNTdMLjMyNyA3LjI2MUExIDEgMCAwIDAgLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMCAwIC4wMDEgMS40NzlMMS42NSAxNy45NGEuOTk5Ljk5OSAwIDAgMCAxLjI3Ni4wNTdsNC4xMi0zLjEyOCA5LjQ2IDguNjNhMS40OTIgMS40OTIgMCAwIDAgMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAgMCAyNCAyMC4wNlYzLjkzOWExLjUgMS41IDAgMCAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg==&color=F7B93E" alt="VSCode Extension Pre-Release">
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

* **Rust-Powered Backend:** Delivers full workspace indexing and diagnosis in seconds with a minimal memory footprint - over 10x quicker on large projects while delivering more features.
* **Full Language Server**: Includes everything you'd expect from a language server and more, such as syntax highlighting, diagnostics, symbol renaming, type resolution, goto, formatting and more.
* **Easy Setup:** Designed to "just work", the extension will take care of automatically downloading, installing and updating annotations and the debugger. A custom settings menu is also available for easy manual configuration.

## 🧠 Designed for Garry's Mod

* **Class Resolution:** Automatic mapping for classes such as `ENT`, `SWEP`, `TOOL`, `PLUGIN` and others. NetworkVars, AccessorFuncs and VGUI panels are all registered as well.
* **Realm Awareness:** Analyses file prefixes (`sv_`, `cl_`, `sh_`) and `include()` chains. Generates real-time diagnostics for cross-realm function calls (e.g. calling a clientside method on the server). Intellisense filters by realm to only deliver relevant suggestions.
* **Network Validation:** Parses and validates `net.Start`, `net.Receive` and other net library usages, catching mismatched payloads, read/write order errors, and delivering enhanced autocomplete.
* **Smart Hook Integration:** Intelligent autocomplete and signature resolution for all hooks, `GM:` overrides, and custom `---@hook` annotations. Automatically detects and registers new custom hooks in addition to those parsed from the wiki.
* **Class Explorer & Templates:** Dedicated side-panel to easily reference key classes (Entities, Weapons, VGUI, Plugins) and workspace resources (Materials, Sounds) alongside a configurable template system for easy creation.

## 🐞 Integrated Server (SRCDS) Debugger

* **Binary Module:** Runtime debugger for (currently SRCDS server only), works alongside auto generated lua file for advanced debugging features.
* **Easier Debugging:** Everything you'd expect from a modern debugger. Set visual breakpoints, pause code execution, inspect local variables, global tables, upvalues, and call stacks live within VS Code.
* **Lua Execution:** Run selected code, entire files (including refresh), or execute engine commands straight from the editor.
* **Lua Error Tracking:** Catch and view runtime Lua errors in a dedicated panel and click through to the precise source code location, helping you easily identify and fix problems. Debugger pause on errors can be configured (default off) for better insight.
* **Live Entity Explorer:** Browse all spawned entities, inspect runtime table values, and monitor NetworkVars in real-time through the debugger panel. You can even edit these values with the debugger paused, allowing for easier testing.

## ✨ Advanced Code Intelligence

* **AI & Copilot Integration:** Supercharge GitHub Copilot Chat with LM tools and MCP integration - allowing it to search documentation, get console output, recent errors and even execute lua to validate its work.
* **Self-Updating Wiki Annotations:** The latest annotations, generated from the Garry's Mod wiki, will be automatically downloaded and setup for you.
* **VGUI & Entity Assistance:** Dynamic CodeLens and inlay hints specifically for VGUI elements - designed to prevent you from getting lost in massive derma files.
* **Workspace-Wide Refactoring:** Reliable symbol renaming, finding all references, and jumping straight to definitions. Find anything with ease with proper symbol mapping and outline view.

## 🛠 Workspace Tooling & Configuration

* **Interactive Configuration UI:** Built-in settings panel to easily toggle diagnostics, formatters, and workspace parameters saved to a workspace local `.gluarc.json`. Useful for if a specific diagnostic is giving too many false-positives in your codebase (please let me know if this happens!).
* **Built-In Formatter:** Formatter configured with presets such as CFC, advanced customisation options available.
* **Automatic File Resolution:** Automatically detects and parses addon and gamemode structures, enabling you to get started with all features and diagnostics without a ton of configuration.
* **Automatic Setup & Updates:** Designed to work with minimal setup, the extension can handle updates for annotations and the debugger, alongside setting it all up for you on initial load.
* **Multi-Root Workspace Support:** Designed to work in large codebases, especially with many different folders open within a workspace.  Perfect for working on complex gamemodes alongside many addons, such as within a [multi-root workspace.](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
* **Configurable Templates:** Ability to create and easily use custom templates to scaffold classes via the class explorer, helping reduce boilerplate. Templates for entities and other common classes included, with options to easily add more such as for plugin systems.
* **Detailed Documentation:** Everything you need to know, from annotations to features, is documented on the wiki: https://gluals.arnux.net/

---

## Troubleshooting

Make sure you don't have any other potentially conflicting extensions installed, such as EmmyLua, LuaLS, GLua Enhanced - this should be the only Lua Language Server or Lua Debugger you have installed. It is recommended you create a new VSCode profile for GLua/Garry's Mod development to avoid conflict, especially if other Lua extensions are required for non-gmod related projects.

The debugger is only designed to be used on local development servers - please do not install the binary module on production servers. `gm_rdb` only accepts localhost connections by default. If you need remote attach, start Garry's Mod or SRCDS with `-rdb_allow_remote`. `rdb.activate(...)` keeps the server running by default. If you want it to pause on the next hook event instead, add `-rdb_pause_on_activate`. This extension has only been tested with VSCode and may not work with forks. AI features have only been tested with GitHub Copilot Chat and may not work with other providers.

This extension is primarily designed and tested for addon and/or gamemode development setup within an SRCDS server. If you're doing something outside of this structure, some features may not work or may require manual configuration. The extension currently expects each added workspace folder root to be within either `garrysmod/addons` or `garrysmod/gamemodes`. If you need to edit multiple folders at the same time (such as gamemode alongside addons), I'd recommend adding each individual gamemode or addon as a folder within a [multi-root workspace,](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces) rather than opening the entire garrysmod folder within VSCode.

If you have any advanced configuration (e.g. not using standard Garry's Mod folder structure) that seems to not work, please create an issue that details what your structure looks like, so that I can add support for it via the configuration system.

---



This is a hard fork of [EmmyLua Analyzer Rust](https://github.com/CppCXY/emmylua-analyzer-rust), maintained specifically for Garry's Mod GLua.
The original EmmyLua project does not support plugins, nor does it have any plan for any, making it difficult to fully adapt for Garry's Mod.
While LuaLS has plugin support, it was annoyingly slow to use. Many features here are based on my earlier LuaLS addon work, now maintained in [annotations-gmod-glua-ls](https://github.com/Pollux12/annotations-gmod-glua-ls).

