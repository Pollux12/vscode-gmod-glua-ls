<p align="center">
  <img src="res/gmod-glua-ls.png" width="128" alt="gmod-glua-ls icon">
</p>

# Garry's Mod Language Server (GLua)

Visual Studio Code extension for **[gmod-glua-ls](https://github.com/Pollux12/gmod-glua-ls)** - a lightning-fast, fully featured language server and debugger built specifically for Garry's Mod (GLua), with the goal of delivering the ultimate Garry's Mod development experience.

> [!IMPORTANT]
> This is an early release. There may be some minor bugs, such as false-positive diagostics - I've made it easy to toggle these off in the config editor. Please report any issues you run into!

[Annotation Documentation](https://github.com/Pollux12/gmod-glua-ls/blob/main/docs/annotations/README.md)

---

## ⚡ Performance & Architecture

* **Rust-Powered Backend:** Delivers near-instant indexing and minimal memory footprint - over 10x quicker than others on large projects while delivering significantly more features.
* **Advanced Codebase Analysis:** Full AST-based parsing with accurate scope resolution for Lua and Garry's Mod patterns (hooks, realms, entity definitions), including an inference and narrowing system to drastically reduce the need for manual annotations in your codebase.
* **Multi-Root Workspace Isolation:** Designed to work in large codebases, including those with isolated, project-specific configurations. Perfect for complex gamemodes alongside many addons.

## 🧠 Garry's Mod Specific Features

* **Deep Class Resolution:** Automatic mapping for classes such as `ENT`, `SWEP`, `TOOL`, `PLUGIN` and others. Advanced inferred class and variable system drastically reduces the amount of manual annotations required.
* **Realm Awareness:** Analyses file prefixes (`sv_`, `cl_`, `sh_`) and `include()` chains. Generates real-time diagnostics for cross-realm function calls (e.g. calling a clientside method on the server). Delivers realm-aware suggestions by filtering autocomplete based on realm.
* **Network Analysis:** Parses and validates `net.Start`, `net.Receive` and other net library usages, catching mismatched payloads, read/write order errors, and delivering enhanced autocomplete.
* **Smart Hook Integration:** Intelligent autocomplete and signature resolution for all hooks, `GM:` overrides, and custom `---@hook` annotations. Automatically detects and registers new custom hooks in addition to those parsed from the wiki.
* **Class Explorer & Templates:** Dedicated side-panel to easily reference key classes (Entities, Weapons, VGUI, Plugins) and workspace resources (Materials, Sounds) alongside a one-click template creation system.

## 🐞 Integrated Server (SRCDS) Debugger

* **Binary Module:** Runtime debugger (currently SRCDS server only) to give you a deep insight into exactly what is going on.
* **Easier Debugging:** Set visual breakpoints, pause engine threads, and inspect local variables, global tables, upvalues, and call stacks live within VS Code - no more print statements everywhere!
* **Lua Execution:** Run selected code, entire files (including refresh), or engine commands in the Server, Client, or Shared realms straight from the editor - no more awkward copy-pasting into luapad or similar in-game editors.
* **Lua Error Tracking:** Catch and view runtime Lua errors in a dedicated panel and click through to the precise source code location, helping you easily identify and fix problems. Option to pause on errors to allow for deeper inspection.
* **Live Entity Explorer:** Browse all active entities, inspect runtime table values, and monitor NetworkVars in real-time through the debugger panel. You can even edit these values with the debugger paused, allowing for easier testing.
* **Automatic Setup:** The extension will take care of installing and updating the debugger for you, all you have to do is give it your SRCDS path, or open a project within a standard Garry's Mod directory for automatic detection.

## ✨ Advanced Code Intelligence

* **AI & Copilot Integration:** Supercharge GitHub Copilot Chat with LM tools and MCP integration - allowing it to search documentation, get the console output, recent errors and even run lua directly on the server.
* **Self-Updating Wiki Annotations:** The latest annotations generated from the Garry's Mod wiki will be automatically downloaded and setup for you. Includes options to disable and override if required.
* **VGUI & Entity Assistance:** Dynamic CodeLens and inlay hints specifically for VGUI elements - designed to prevent you from getting lost in massive derma files.
* **Workspace-Wide Refactoring:** Reliable symbol renaming, finding all references, and jumping straight to definitions. Find anything with ease with proper symbol mapping and outline view.

## 🛠 Workspace Tooling & Configuration

* **Interactive Configuration UI:** Built-in settings panel to easily toggle diagnostics, formatters, and workspace parameters saved to a workspace local `.gluarc.json`. Useful for if a specific diagnostic is giving too many false-positives in your codebase (please let me know if this happens!).
* **Automatic File Resolution:** Automatically detects and parses addon and gamemode structures, enabling you to get started with all features and diagnostics without a ton of configuration.
* **Automatic Setup & Updates:** Designed to work with minimal setup, the extension can handle updates for annotations and the debugger, alongside setting it all up for you on initial load.
* **AI & Copilot Integration:** Integrates with GitHub Copilot and other tools with a custom MCP server - enables AI agents to interact directly with the game server and get accurate documentation for your codebase.

---

The debugger is only designed to be used on local development servers - please do not install the binary module on production servers. Remote debugger access has not been actively tested but should work. This extension has only been tested with VSCode and may not work with forks. AI features have only been tested with GitHub Copilot Chat and may not work with other providers.

This extension is primarily designed for addon and gamemode development setup within an SRCDS server. If you're doing something outside of this structure, some features may no longer work. The extension expects for each opened workspace/folder to be within either `garrysmod/addons` or `garrysmod/gamemodes`. Rather than opening up your entire Garry's Mod folder as a workspace, I'd recommend instead adding each individual gamemode / addon as a folder.

---

This project started as a fork of [emmylua-analyzer-rust](https://github.com/EmmyLuaLs/emmylua-analyzer-rust) due to LuaLS taking many minutes to diagnose and process my codebase. While originally intended to be a quick day-long project to add a few basic features to EmmyLua, it quickly grew into something much bigger (we love scope creep). Some of the code is a bit slop due to this, especially since this is the first time I've ever used Rust. I do intend to improve this over time with new features and fixes - let me know if you have any cool ideas or run into any issues!
