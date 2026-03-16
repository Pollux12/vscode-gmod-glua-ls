<p align="center">
  <img src="res/gmod-glua-ls.png" width="128" alt="gmod-glua-ls icon">
</p>

# Garry's Mod Language Server (GLua)

Visual Studio Code extension for **[gmod-glua-ls](https://github.com/Pollux12/gmod-glua-ls)** - a lightning-fast, fully featured language server and debugger built specifically for Garry's Mod (GLua), with the goal of delivering the ultimate Garry's Mod development experience.

> [!IMPORTANT]
> This is an early release. There may be some minor bugs, such as false-positive diagostics or unsupported configurations. Please report any issues you run into! You may be able to resolve some issues via the config editor (e.g. disabling diagnostics or changing folder paths).

[Annotation Documentation](https://github.com/Pollux12/gmod-glua-ls/blob/main/docs/annotations/README.md)

---

## ⚡ Performance & Architecture

* **Rust-Powered Backend:** Delivers near-instant indexing and minimal memory footprint - over 10x quicker than others on large projects while delivering more functionality.
* **Advanced Language Server**: Includes everything you'd expect from a language server, such as syntax highligting, diagnostics, symbol renaming, type resolution, and more, alongside Garry's Mod specific features. This is the only thing you need for Garry's Mod development.
* **Easy Setup:** Designed to be as easy to setup and use as possible. The extension will take care of setting everything up for you, including automatically downloading and updating annotations and setting up the debugger. Advanced scope resolution drastically reduces the amount of manual annotations required. A custom settings menu is available for any manual configuration or tuning required.

## 🧠 Garry's Mod Specific Features

* **Class Resolution:** Automatic mapping for classes such as `ENT`, `SWEP`, `TOOL`, `PLUGIN` and others. Advanced inferred class and variable system drastically reduces the amount of manual annotations required.
* **Realm Awareness:** Analyses file prefixes (`sv_`, `cl_`, `sh_`) and `include()` chains. Generates real-time diagnostics for cross-realm function calls (e.g. calling a clientside method on the server). Delivers realm-aware suggestions by filtering autocomplete based on realm.
* **Network Analysis:** Parses and validates `net.Start`, `net.Receive` and other net library usages, catching mismatched payloads, read/write order errors, and delivering enhanced autocomplete.
* **Smart Hook Integration:** Intelligent autocomplete and signature resolution for all hooks, `GM:` overrides, and custom `---@hook` annotations. Automatically detects and registers new custom hooks in addition to those parsed from the wiki.
* **Class Explorer & Templates:** Dedicated side-panel to easily reference key classes (Entities, Weapons, VGUI, Plugins) and workspace resources (Materials, Sounds) alongside a one-click template creation system.

## 🐞 Integrated Server (SRCDS) Debugger

* **Binary Module:** Runtime debugger for (currently SRCDS server only), works alongside auto generated lua file for advanced debugging features.
* **Easier Debugging:** Everything you'd expect from a modern debugger. Set visual breakpoints, pause code execution, inspect local variables, global tables, upvalues, and call stacks live within VS Code.
* **Lua Execution:** Run selected code, entire files (including refresh), or execute engine commands straight from the editor.
* **Lua Error Tracking:** Catch and view runtime Lua errors in a dedicated panel and click through to the precise source code location, helping you easily identify and fix problems. Debugger pause on errors can be configured (default off) for better insight.
* **Live Entity Explorer:** Browse all spawned entities, inspect runtime table values, and monitor NetworkVars in real-time through the debugger panel. You can even edit these values with the debugger paused, allowing for easier testing.

## ✨ Advanced Code Intelligence

* **AI & Copilot Integration:** Supercharge GitHub Copilot Chat with LM tools and MCP integration - allowing it to search documentation, get the console output, recent errors and even run lua directly on the server.
* **Self-Updating Wiki Annotations:** The latest annotations generated from the Garry's Mod wiki will be automatically downloaded and setup for you. Includes options to disable and override if required.
* **VGUI & Entity Assistance:** Dynamic CodeLens and inlay hints specifically for VGUI elements - designed to prevent you from getting lost in massive derma files.
* **Workspace-Wide Refactoring:** Reliable symbol renaming, finding all references, and jumping straight to definitions. Find anything with ease with proper symbol mapping and outline view.

## 🛠 Workspace Tooling & Configuration

* **Interactive Configuration UI:** Built-in settings panel to easily toggle diagnostics, formatters, and workspace parameters saved to a workspace local `.gluarc.json`. Useful for if a specific diagnostic is giving too many false-positives in your codebase (please let me know if this happens!).
* **Automatic File Resolution:** Automatically detects and parses addon and gamemode structures, enabling you to get started with all features and diagnostics without a ton of configuration.
* **Automatic Setup & Updates:** Designed to work with minimal setup, the extension can handle updates for annotations and the debugger, alongside setting it all up for you on initial load.
* **Multi-Root Workspace Support:** Designed to work in large codebases, especially with many different folders open within a workspace.  Perfect for working on complex gamemodes alongside many addons, such as within a [multi-root workspace.](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
* **AI & Copilot Integration:** Integrates with GitHub Copilot and other tools with a custom MCP server - enables AI agents to interact directly with the game server and get accurate documentation for your codebase.

---

## Troubleshooting

Make sure you don't have any other potentially conflicting extensions installed, such as EmmyLua, LuaLS, GLua Enhanced - this should be the only Lua Language Server or Lua Debugger you have installed. It is recommended you create a new VSCode profile for GLua/Garry's Mod development to avoid conflict, especially if other Lua extensions are required for non-gmod related projects.

The debugger is only designed to be used on local development servers - please do not install the binary module on production servers. Remote debugger access has not been actively tested but should work. This extension has only been tested with VSCode and may not work with forks. AI features have only been tested with GitHub Copilot Chat and may not work with other providers.

This extension is primarily designed and tested for addon and/or gamemode development setup within an SRCDS server. If you're doing something outside of this structure, some features may not work or may require manual configuration. The extension currently expects each added workspace folder root to be within either `garrysmod/addons` or `garrysmod/gamemodes`. If you need to edit multiple folders at the same time (such as gamemode alongside addons), I'd recommend adding each individual gamemode or addon as a folder within a [multi-root workspace,](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces) rather than opening the entire garrysmod folder within VSCode.

If you have any advanced configuration (e.g. not using standard Garry's Mod folder structure) that seems to not work, please create an issue that details what your structure looks like, so that I can add support for it via the configuration system.

---

This project started as a fork of [emmylua-analyzer-rust](https://github.com/EmmyLuaLs/emmylua-analyzer-rust) due to LuaLS taking many minutes to diagnose and process my codebase. While originally intended to be a quick day-long project to add a few basic features to EmmyLua, it quickly grew into something much bigger (we love scope creep). Some of the code is a bit slop due to this, especially since this is the first time I've ever used Rust. I do intend to improve this over time with new features and fixes - let me know if you have any cool ideas or run into any issues!
