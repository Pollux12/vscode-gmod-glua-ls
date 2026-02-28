This extension provides powerful language support and live debugging features tailored specifically for Garry's Mod.

### Core Features
- **Realm Detection:** Automatically tracks serverside vs clientside states across functions, identifying mismatch boundaries instantly.
- **Hook Recognition:** Smart autocomplete for standard Engine hooks, `GM:` method hooks, and custom APIs via `---@hook`.
- **Advanced Class Support:** First-class resolution for `ENT`, `SWEP`, `TOOL`, and dynamic object properties (like `NetworkVar` and `AccessorFunc`).
- **Dynamic Field Inference:** Autocomplete tracks fields assigned dynamically onto generic entities and players, minimizing the need for manual type casting.
- **Full LSP Suite:** Fast rename refactoring, go-to-definition, hover definitions, inlay hints, and customizable severity diagnostics.

This setup guide covers:
- Downloading API annotations for type-checking.
- Configuring the live debugger.
- Accessing workspace settings.

Run the diagnostic wizard using the button on the left to verify network paths, dependencies, and environment setup.