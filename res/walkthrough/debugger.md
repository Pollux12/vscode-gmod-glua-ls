The integrated debugger allows runtime inspection of Garry's Mod directly from within VS Code.

### Features
- **Breakpoints:** Pause execution at specific lines.
- **Variable Inspection:** View local, global, and upvalue variables in the sidebar.
- **Step Commands:** Step over, inside, and continue execution threads.
- **Entity Explorer:** View all entities and edit variables

Clicking the action button will extract the required `gm_rdb` module into the local Garry's Mod `lua/bin/` folder and setup a bootstrap script in `lua/autorun/`.