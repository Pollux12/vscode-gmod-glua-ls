# Garry's Mod GLua Language Server

<p align="center">
  <img src="res/gmod-glua-ls.svg" width="128" alt="gmod-glua-ls Logo">
</p>

Visual Studio Code extension for **[gmod-glua-ls](https://github.com/Pollux12/gmod-glua-ls)** — a lightning-fast, highly accurate language server and debugger built specifically for Garry's Mod.

Built on a highly optimized Rust backend, this extension delivers contextual insight by natively understanding Garry's Mod structures, realms, hooks, and classes via a true Abstract Syntax Tree (AST).

---

## ⚡ Performance & Architecture
* **Rust-Powered Backend:** Delivers near-instant indexing and minimal memory footprint.
* **True AST Intelligence:** Full Abstract/Concrete Syntax Tree implementation for flawless scope resolution and syntax checking, even through Garry's Mod specific things like hooks.
* **Multi-Workspace Isolation:** Seamlessly scales across large environments with isolated, project-specific configurations, perfect for multi-root workspaces with a complex gamemode alongside many addons.

## 🧠 Native Garry's Mod Semantics
* **Deep Class Resolution:** First-class structural mapping for `ENT`, `SWEP`, `TOOL`, and `PLUGIN` metatables without manual annotations.
* **Project Class Explorer:** Dedicated side-panel to easily reference key classes (Entities, Weapons, VGUI, Plugins) and workspace resources (Materials, Sounds) alongside a one-click template creation system.
* **Strict Realm Awareness:** Analyzes file prefixes (`sv_`, `cl_`, `sh_`) and `include()` chains. Generates real-time diagnostics for cross-realm function calls (e.g. calling a clientside method on the server).
* **Cross-Realm Network Analysis:** Statically validates `net.Start` and `net.Receive` flows, catching mismatched payloads, read/write order errors, and missing networking counterparts before you ever run the game.
* **Smart Hook Integration:** Intelligent autocomplete and signature resolution for standard Engine hooks, `GM:` overrides, and custom `---@hook`, `---@realm`, and `---@accessorfunc` annotations.

## 🐞 Integrated Server (SRCDS) Debugger
* **Native Engine Targeting:** Bespoke runtime debugger that attaches directly to local Garry's Mod instances.
* **Live Execution:** Run Lua selections, entire files, or engine commands in the Server, Client, or Menu realms straight from the editor without tabbing into the game.
* **Live Error Tracking:** Automatically catch runtime Lua errors in a dedicated panel and instantly click through to the precise source code location.
* **Live Entity Explorer:** Browse active map entities, inspect runtime table values, and monitor NetworkVars in real-time through a dedicated side-panel.
* **Live Inspection:** Set visual breakpoints, pause engine threads, and instantly inspect local variables, global tables, upvalues, and call stacks live within VS Code.

## ✨ Advanced Code Intelligence

* **AI & Copilot Integration:** Ask GitHub Copilot Chat to search the GMod Wiki, query the workspace runtime state, or run GMod commands directly via built-in LM Tools and MCP integration.
* **Self-Updating Annotations:** Automated tracking of the official Garry's Mod Wiki guarantees accurate annotations, with options to override the defaulr system where required.
* **VGUI & Entity Assistance:** Dynamic CodeLens and inlay hints specifically for VGUI element creation and other entity classes - designed to prevent you from getting lost in massive derma files.
* **Workspace-Wide Refactoring:** Reliable symbol renaming, finding all references, and jumping straight to definitions. Find anything with ease with proper symbol mapping and outline view.
* **C-Style Syntax & Operators:** Natively parses non-standard GMod operators (`!=`, `&&`, `||`) and C-style comments (`//`, `/* */`) just like standard Lua.

## 🛠 Workspace Tooling & Configuration
* **Interactive Configuration UI:** Built-in settings panel to easily toggle diagnostics, formatters, and workspace parameters inside a local `.gluarc.json`.
* **Zero-Config File Resolution:** Automatically parses addon and gamemode structures out-of-the-box.
* **Guided Walkthrough:** Visual onboarding inside the VS Code Welcome View automatically initializes type definitions and configures debugger environments.

---

### Requires VS Code 1.95.0+

