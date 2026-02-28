# EmmyLua for VSCode

![logo](/res/logo.png)

EmmyLua is a powerful Lua language support extension for Visual Studio Code, providing intelligent code completion, debugging, and analysis capabilities.

## 📋 Quick Links

- 📖 [Documentation](https://github.com/EmmyLuaLs/emmylua-analyzer-rust/blob/main/docs/config/emmyrc_json_EN.md)
- 📝 [Changelog (English)](CHANGELOG.md)
- 📝 [更新日志 (中文)](CHANGELOG_CN.md)
- 🔧 [Language Server (Rust)](https://github.com/Pollux12/gmod-glua-ls)
- 💬 QQ Group: `29850775`

[![Online EmmyLua Doc](https://img.shields.io/badge/emmy-doc-46BC99.svg?style=flat-square)](https://emmylua.github.io)
[![donate](https://img.shields.io/badge/donate-emmy-FF69B4.svg?style=flat-square)](https://emmylua.github.io/donate.html)
[![加入QQ群](https://img.shields.io/badge/chat-QQ群-46BC99.svg?style=flat-square)](//shang.qq.com/wpa/qunwpa?idkey=f1acce081c45fbb5670ed5f880f7578df7a8b84caa5d2acec230ac957f0c1716)

## 🚀 Features

- **Smart Code Completion**: Intelligent auto-completion with type inference
- **Real-time Diagnostics**: Error detection and warnings as you type
- **Advanced Debugging**: Support for attach, launch, and remote debugging
- **Cross-platform**: Works on Windows, macOS, and Linux
- **LSP-based**: Built on Language Server Protocol for reliability

## 📦 Related Extensions

Enhance your Lua development experience with these complementary extensions:

- [EmmyLuaCodeStyle](https://marketplace.visualstudio.com/items?itemName=CppCXY.emmylua-codestyle) - Code formatting and style enforcement
- [EmmyLuaUnity](https://marketplace.visualstudio.com/items?itemName=CppCXY.emmylua-unity) - Unity3D integration

## 🔧 Configuration

### Project Configuration

Create a `.emmyrc.json` file in your project root to customize behavior:

```json
{
  "diagnostics": {
    "undefined-global": false
  }
}
```

For detailed configuration options, see:

- [English Documentation](https://github.com/Pollux12/gmod-glua-ls/blob/main/docs/config/emmyrc_json_EN.md)
- [中文文档](https://github.com/Pollux12/gmod-glua-ls/blob/main/docs/config/emmyrc_json_CN.md)

## 🧪 Language Server Selection

The extension chooses the language server executable in this order:

1. `emmylua.ls.executablePath` (if set)
2. **Dev fallback** (Extension Development Host mode):
   - `EMMY_DEV_LS_PATH` (if set)
   - `../emmylua-analyzer-rust/target/debug/glua_ls(.exe)`
   - `../emmylua-analyzer-rust/target/release/glua_ls(.exe)`
3. Bundled `server/glua_ls(.exe)` from this extension package

### Enable dev fallback

- Start this extension using VS Code's **Run Extension** (`F5`).
- Build your local server first (for example in sibling repo `emmylua-analyzer-rust`):
  - `cargo build -p glua_ls`
- Optional: set `EMMY_DEV_LS_PATH` to point to a specific local binary.

No extra extension setting is required for dev fallback when running in extension development mode.

## 🛠 Build and Install This Extension

### Prerequisites

- Node.js 20+
- npm
- `@vscode/vsce` (or use `npx vsce`)

### Build extension sources

```bash
npm install
npm run compile
```

### Package a VSIX with bundled server

Simple one-command options (Windows x64):

```bash
npm run package:dev
npm run package:release
```

- `npm run package:dev`
  - builds your local `../emmylua-analyzer-rust/target/release/glua_ls.exe`
  - bundles it into `VSCode-EmmyLua-dev-win32-x64.vsix`
- `npm run package:release`
  - forces download from configured release source in `build/config.json`
  - bundles it into `VSCode-EmmyLua-win32-x64.vsix`

Manual packaging commands (same behavior):

```bash
node ./build/prepare.js glua_ls-win32-x64.zip
npx vsce package --target win32-x64
```

`prepare.js` now resolves the language server in this order:

- `--local-ls <path>`
- `EMMY_LOCAL_LS_PATH`
- `../emmylua-analyzer-rust/target/release/glua_ls(.exe)`
- `../emmylua-analyzer-rust/target/debug/glua_ls(.exe)`
- Download from `build/config.json` release URL

To skip local lookup and always use GitHub release, pass:

- `--remote-ls`

Use this command to force local binary usage (Windows example):

```bash
node ./build/prepare.js glua_ls-win32-x64.zip --local-ls ../emmylua-analyzer-rust/target/release/glua_ls.exe
```

Use this command to force remote release usage:

```bash
node ./build/prepare.js glua_ls-win32-x64.zip --remote-ls
```

Use a different asset name/target for other platforms:

- `glua_ls-win32-arm64.zip` → `--target win32-arm64`
- `glua_ls-linux-x64-glibc.2.17.tar.gz` → `--target linux-x64`
- `glua_ls-linux-aarch64-glibc.2.17.tar.gz` → `--target linux-arm64`
- `glua_ls-darwin-x64.tar.gz` → `--target darwin-x64`
- `glua_ls-darwin-arm64.tar.gz` → `--target darwin-arm64`

### Install VSIX locally

- Command line:
  - `code --install-extension emmylua-<version>.vsix`
- Or in VS Code:
  - Extensions panel → `...` menu → **Install from VSIX...**

When dev mode is disabled, the bundled server comes from local source first (if found), then falls back to this repository's configured GitHub release source (`build/config.json`).

## 🐛 Debugging

### Remote Debug Setup

1. **Insert Debugger Code**
   - Use command: `EmmyLua: Insert Emmy Debugger Code`
   - Or manually add:

   ```lua
   package.cpath = package.cpath .. ";path/to/emmy/debugger/?.dll"
   local dbg = require('emmy_core')
   dbg.tcpListen('localhost', 9966)
   dbg.waitIDE()
   ```

2. **Set Breakpoints**
   - Add `dbg.breakHere()` where you want to pause execution
   - Or use VSCode's built-in breakpoint system

3. **Start Debugging**
   - Run your Lua application
   - Launch "EmmyLua New Debug" configuration in VSCode
   - The debugger will connect automatically

### Debug Types

- **EmmyLua New Debug**: Modern debugging with better performance
- **EmmyLua Attach**: Attach to running processes (requires exported Lua symbols)
- **EmmyLua Launch**: Direct launch debugging
- **GMod Remote Debug**: gm_rdb-compatible attach/launch debugging with conditional and hit-count breakpoints
  - Includes control commands: `pauseSoft`, `pauseNow`, `resume`, `breakHere`, `waitIDE`, `runLua`, `runFile`, `runCommand`, `setRealm`
  - Console output is streamed with timestamps, source/channel tags, and correlation IDs for control/file execution flows
  - Includes a local authenticated MCP host with allow-listed tools: `run_lua`, `run_command`, `run_file`, `get_output`, `get_errors`, `get_debug_state`, `list_realms`
  - Includes a **GMod Toolkit** explorer surface (runtime targets, entity scripts, resources)
  - Includes **GMod: Run Setup Wizard** and **GMod: Run Diagnostics and Repair** for debugger/runtime mapping and MCP health checks

## ❓ Frequently Asked Questions

<details>
<summary><strong>Why doesn't attach debugging work?</strong></summary>

**English**: The debugger needs access to Lua symbols from the target process. Ensure your executable exports Lua symbols.

**中文**: 调试器需要获取进程中的 Lua 符号，因此需要进程导出 Lua 符号。
</details>

<details>
<summary><strong>Why do I see many "undefined variable" warnings?</strong></summary>

**English**: Create `.emmyrc.json` in your project root and disable the `undefined-global` diagnostic:

```json
{
  "diagnostics": {
    "disable" : [
      "undefined-global"
    ]
  }
}
```

**中文**: 在项目根目录创建 `.emmyrc.json` 文件并禁用 `undefined-global` 诊断。
</details>

<details>
<summary><strong>Can I use EmmyLua analysis in other editors?</strong></summary>

**English**: Yes! EmmyLua uses a standard Language Server Protocol implementation. Any LSP-compatible editor can use it.

**中文**: 可以！EmmyLua 基于标准的语言服务器协议，任何支持 LSP 的编辑器都可以使用。
</details>

<details>
<summary><strong>Why use .emmyrc.json instead of VSCode settings?</strong></summary>

**English**: Project-specific configuration files work across different editors and platforms without requiring IDE-specific setup.

**中文**: 项目配置文件可以跨平台和编辑器使用，无需在每个 IDE 中重复配置。
</details>

<details>
<summary><strong>Why was the language server rewritten in Rust?</strong></summary>

**English**: The Rust implementation provides better performance, memory safety, and cross-platform compatibility compared to the previous .NET and Java versions.

**中文**: Rust 实现提供了更好的性能、内存安全性和跨平台兼容性。（因为我想试试 rust 😄）
</details>

## 🤝 Contributing

We welcome contributions! Please feel free to:

- Report bugs and issues
- Suggest new features
- Submit pull requests
- Join our QQ group for discussions

## 📄 License

This project is licensed under the MIT License.
