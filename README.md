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
    <img src="https://img.shields.io/badge/View%20on-VS%20Code-007ACC?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+VmlzdWFsIFN0dWRpbyBDb2RlPC90aXRsZT48cGF0aCBmaWxsPSd3aGl0ZScgZD0iTTIzLjE1IDIuNTg3TDE4LjIxLjIxYTEuNDk0IDEuNDk0IDAgMCAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAgMC0xLjI3Ni4wNTdMLjMyNyA3LjI2MUExIDEgMCAwIDAgLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMCAwIC4wMDEgMS40NzlMMS42NSAxNy45NGEuOTk5Ljk5OSAwIDAgMCAxLjI3Ni4wNTdsNC4xMi0zLjEyOCA5LjQ2IDguNjNhMS40OTIgMS40OTIgMCAwIDAgMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAgMCAyNCAyMC4wNlYzLjkzOWExLjUgMS41IDAgMCAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg==" alt="View on VS Code Marketplace">
  </a>
  <a href="https://open-vsx.org/extension/Pollux/gmod-glua-ls">
    <img src="https://img.shields.io/badge/View%20on-Open%20VSX-C160EF?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAxMTAgMTMxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5PcGVuIFZTWDwvdGl0bGU+PHBhdGggZmlsbD0nd2hpdGUnIGQ9Ik0zMCA0NC4yTDUyLjYgNUg3LjN6TTQuNiA4OC41aDQ1LjNMMjcuMiA0OS40em01MSAwbDIyLjYgMzkuMiAyMi42LTM5LjJ6Ii8+PHBhdGggZmlsbD0nd2hpdGUnIGQ9Ik01Mi42IDVMMzAgNDQuMmg0NS4yek0yNy4yIDQ5LjRsMjIuNyAzOS4xIDIyLjYtMzkuMXptNTEgMEw1NS42IDg4LjVoNDUuMnoiLz48L3N2Zz4=" alt="View on Open VSX Registry">
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
> >
> Report bugs or suggest features here: https://github.com/Pollux12/gmod-glua-ls/issues
>
> macOS support is currently experimental, expect issues!

Visual Studio Code extension for **[gmod-glua-ls](https://github.com/Pollux12/gmod-glua-ls)**, a rust-based language server, debugger and toolkit for Garry's Mod GLua development.


<p align="center">
  <video src="https://github.com/user-attachments/assets/a60c55ed-2d9d-4536-8ecd-c12a62593b65" poster="https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/poster.png" controls muted width="100%">
    <a href="https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/hero.mp4">
      <img src="https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/poster.png" alt="Feature overview video" width="100%">
      <br>Click to view the video
    </a>
  </video>
</p>



---

## Core language server

Full documentation, signatures, realm, and other important information for all Garry's mod functions, including your own code (even if not annotated). Diagnostics flag any potential mistakes, helping catch errors sooner. Go to definition, find references, rename, formatting and inlay hints work the way you would expect from any language server.

![Completion and hover](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/completion-hover.gif)

![Completion with documentation](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/completion-docs.png)

## Realm awareness

The extension knows whether each file and function is server, client or shared, gives you relevant warnings when using the wrong realm, and only shows valid suggestions for your current realm.

![Realm awareness](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/realm-check.gif)

## Network validation

The code that sends a net message and the code that receives it usually live in different files. The extension links them, warns when the two sides disagree, and helps you easily write them via autocomplete.

![Net message validation](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/net-messages.gif)

![Net read completion](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/net-read-completion.png)

## Hooks

The language server detects hooks, including your own custom hooks, to provide full information such as callers, autocomplete, annotations and more. Includes support for plugin hooks such as those in Helix.

![Hook completion](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/hooks.gif)

![Hook documentation](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/hook-completion.png)

![Plugin hook completion](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/helix-plugin-completion.png)

## Scripted classes and references

Entities, weapons, tools, plugins (such as in Helix), VGUI panels and other scripted classes are recognised from your folder layout. What `NetworkVar` and `AccessorFunc` create gets completion and find references like any other member. The class explorer lists your classes, materials and sounds, and templates create new ones.

![Class explorer](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/scripted-classes.gif)

![NetworkVar references](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/networkvars-references.gif)

![Find references](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/find-references.png)

## Advanced Debugger

Debug a local SRCDS server (and/or gmod client) from VS Code instead of adding print statements. Set breakpoints, step through code and inspect variables, or run Lua and console commands on the server or client without leaving the editor.

![Debugger](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/debugger.gif)

The entity explorer lists every entity in the game with its values and NetworkVars, and lets you edit them live.

![Entity explorer](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/entity-explorer.gif)

Runtime Lua errors from the game are collected in one place, and each one links to its source.

![Runtime errors](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/runtime-errors.gif)

![Runtime error and matching diagnostic](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/runtime-errors.png)

## Configuration and formatting

A settings panel lets you adjust or turn off any diagnostic that doesn't suit your codebase, without editing JSON. The built-in formatter has presets such as CFC, with the individual options available.

![Settings panel](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/settings-panel.png)

![Settings panel formatter options](https://raw.githubusercontent.com/Pollux12/vscode-gmod-glua-ls/refs/heads/main/media/settings-formatter.gif)

## Workspace support

Setup is automatic for most codebases. Addon and gamemode layouts are detected, and annotations and the debugger are installed and kept up to date for you. It is built for large codebases and [multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces), such as a gamemode open alongside its addons.

Documentation is available at: https://gluals.arnux.net/

---

## Troubleshooting

This extension uses the dedicated `glua` language mode. Make sure this is set for any Garry's Mod Lua files in the bottom right of VSCode (language selection). The extension will offer to do this if it detects a Garry's Mod file open without it being set to `glua`.

The debugger is only designed to be used on local development servers, please do not install the binary module on production servers. `gm_rdb` only accepts localhost connections by default. If you need remote attach, start Garry's Mod or SRCDS with `-rdb_allow_remote`. `rdb.activate(...)` keeps the server running by default. If you want it to pause on the next hook event instead, add `-rdb_pause_on_activate`. This extension has only been tested with VSCode and may not work with forks.

This extension is primarily designed and tested for addon and/or gamemode development setup within an SRCDS server. If you're doing something outside of this structure, some features may not work or may require manual configuration. The extension currently expects each added workspace folder root to be within either `garrysmod/addons` or `garrysmod/gamemodes`. If you need to edit multiple folders at the same time (such as gamemode alongside addons), I'd recommend adding each individual gamemode or addon as a folder within a [multi-root workspace,](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces) rather than opening the entire garrysmod folder within VSCode.

If you have any advanced configuration (e.g. not using standard Garry's Mod folder structure) that seems to not work, please create an issue that details what your structure looks like, so that I can add support for it via the configuration system.

---


This project is based on [EmmyLua Analyzer Rust](https://github.com/CppCXY/emmylua-analyzer-rust) and my previous[LuaLS plugin](https://github.com/Pollux12/gmod-luals-addon).
