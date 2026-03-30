The extension automatically parses and resolves gamemode and addon folders. The built-in Settings Panel provides an interface to create and edit a `.gluarc.json` file to manage language server rules.

### Available Options
- **Diagnostics:** Adjust type-checking strictness and warning thresholds (e.g. global assignments, shadowing).
- **Formatting:** Configure code style formatting rules like indentation, spacing, and alignment.
- **Environment:** Toggle code lenses, background parsing, and network capture limits.

To open the GLuaLS Settings Menu:
- Command Palette (Ctrl+Shift+P) -> GLuaLS: Open GLuaLS Settings
- Click the GLuaLS status bar item, then choose Open GLuaLS Settings
- Right-click any .gluarc.json file in the Explorer -> Open GLuaLS Settings

If a `.gluarc.json` file does not yet exist, you can create one by right clicking on the workspace root and selecting


### Recommended Configuration

It is recommended that you configure the global variable overrides and formatter for your workspace.

You may encounter errors for `undefined-global`, which is often caused by referencing addons that exist outside of your own workspace. To fix this, you can either add conditional checks, or add that global as a known value in the config if you know it'll always be available.

**Click the action button to open the workspace settings UI.**
