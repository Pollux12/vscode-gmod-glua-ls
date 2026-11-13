# Changelog

---

## [1.4.1] [Pre-Release] - 2026-11-13
> Class Factory Annotations + Fixes

## Language Server

- Add the `adds_field` annotation for functions that add fields to a table you pass them, such as `RegisterMetaTable`.
- Add the `base_class` annotation, so a class factory can take the new class's parent by name or as an existing class.
- Add the `self_class_name` annotation for methods that return the class name of the object they are called on, such as `Entity:GetClass`.
- Fix fields set on one class showing up on other classes that share its base class.
- Fix checks made through a local copy of a table not applying to the original table, and the reverse.
- Fix false `undefined-field` warnings on tables filled by a register function, such as `List[name] = value`, when an entry is read by name.
- Fix entries read by name from those tables not getting the type the register function stores.
- Fix `include("folder/init.lua")` not finding the file, which gave the files it loads the wrong realm and caused false realm mismatch warnings, such as with ULib.
- Fix class name checks narrowing an entity through any method without arguments, such as `ent:GetOwnerClass() == "name"`, which hid real warnings. Only methods marked with `self_class_name` narrow it now.
- Improve the annotation documentation, with a page for every supported annotation and the ones meant for complex cases grouped separately.

## Annotations

- Add the `MetaID` and `MetaName` fields to tables registered with `RegisterMetaTable`.
- Add narrowing of an entity or weapon to its base class when `scripted_ents.IsBasedOn` or `weapons.IsBasedOn` returns `true`.
- Mark `Entity:GetClass` with `self_class_name`, so comparing its result with a class name narrows the entity.

---

## [1.4.0] [Pre-Release] - 2026-11-11
> MCP v2 + Workspace Selection + Fixes

## VS Code Extension

- Add a new MCP server that lets AI agents work with a running Garry's Mod server and your code. It is off by default and turned on with `gluals.mcp.enabled`.
- Add MCP tools to run Lua on the server and get its return values and output, read the server console and Lua errors, and read GLuaLS diagnostics and look up symbols, including GMod API functions.
- Add MCP tools to set breakpoints and logpoints, trace every call of a function without pausing, wait for hits, step, and inspect frames. Logpoints and traces can remove themselves after a number of hits or seconds.
- Add the `gluals.mcp.allowCodeExecution` setting, which is required for running Lua, breakpoint conditions, logpoints and traces.
- Add cleanup when an agent detaches or the MCP server is turned off, removing the agent's breakpoints and traces and resuming a paused server.
- Add automatic MCP discovery in Copilot and Cursor, and a setup command that configures Claude Code, Codex, Cursor and VS Code.
- Add an AI Agents (MCP) section to the settings panel to turn the MCP server on, set its port, see its status and set up agents.
- Add debugger logpoints, which print a message without pausing.
- Add support for opening a whole Garry's Mod folder. Its addons load, and you pick which gamemode loads.
- Add a gamemode picker that opens when a Garry's Mod folder loads, and a status bar item that shows the loaded gamemode and stays highlighted until one is picked.
- Add the `gluals.gmod.activeGamemode` and `gluals.gmod.loadEverything` settings to choose what a Garry's Mod folder loads, and save a pick to `.gluarc.json`.
- Add the folder's addons and gamemodes to the explorer.
- Fix the explorer's scripted classes not updating when the loaded gamemode changes.
- Fix a gamemode pick saved to `.gluarc.json` being overridden by inherited settings or the `loadEverything` default.
- Fix the gamemode prompt closing when focus moves away.
- Fix the language server attempting to start each time a file is opened. 

## Language Server

- Add support for loading of a whole Garry's Mod folder, with it being parsed into each addon/gamemode and selection for active gamemode. This means multi-root workspace is not required for having multiple folders open.
- Add layered `.gluarc.json` files: a config in an addon or gamemode builds on the configs in the folders above it and applies only to that addon or gamemode.
- Add loading of a gamemode as soon as one of its files is opened.
- Fix default ignores to skip only the folders GLuaTest loads tests from (`lua/tests` and `gamemode/tests`), so addons and gamemodes named `test` or `tests` load.
- Fix settings changes so a burst of changes reloads once.
- Fix a derived gamemode not seeing its base gamemode's `GM` methods, and base gamemodes such as `terrortown` not loading for gamemodes derived from them.
- Fix settings in a later workspace folder's `.gluarc.json` being ignored.
- Fix an open folder showing no diagnostics when another folder lists it in `workspace.library`.
- Fix `workspace.packageDirs` entries that share a parent folder being missed.
- Fix `glua_check` resolving a relative annotations path from the wrong folder.
- Fix panels registered with `vgui.Register` and no base not getting `Panel` methods.
- Fix `vgui.GetControlTable` and similar lookups being treated as possibly `nil` for a known class.
- Fix fields and methods added by a helper function not being recognised on the table passed to it.
- Fix false `need-check-nil` warnings on table literals indexed with a computed key, unless `strict.arrayIndex` is on.
- Fix generic names such as `T` showing up as the type returned by a call.
- Fix methods defined later in a file being treated as already defined in code that runs before them.
- Fix false net message warnings for reads and sends inside `and`/`or` expressions, nested calls, and `net.Start` wrapped in a branch.

## Annotations

- Fix failing CI for pre-release annotation branch, causing it to never be published.
- Add narrowing of an entity to `Weapon` when `IsWeapon` returns `true`.
- Improve Derma, spawn menu, skin and sandbox tool types to match what the engine passes.
- Fix false positives from shipped Lua that omits arguments or passes `nil`.
- Fix `undefined-field` warnings on a tool weapon's `Tool` table.

## Debugger

- Add replay of the last 2000 console lines and Lua errors from before the debugger connected, marked in the Debug Console.

---

## [1.3.0] [Pre-Release] - 2026-11-01
> Incremental Analysis System + Fixes

## VS Code Extension

- Add a setting for outline verbosity.
- Improve startup responsiveness by no longer requesting symbols for every open file while the workspace loads.
- Improve responsiveness by only requesting local, parameter and global highlighting when it is shown.
- Improve the descriptions of the workspace recheck settings so they explain what the settings do.
- Improve the Entity Explorer to load every page so grouping and filtering include all entities.
- Improve debugger console output by joining fragments into whole lines without channel tags.
- Improve debugger error reporting by labelling Lua errors by their first line and keeping the stack in frames.
- Remove static Lua snippets that duplicate keyword completions.
- Remove the GitHub Copilot tools and the MCP host.
- Fix the colour swatch missing from completions for colours with an alpha value.
- Fix language server logs being lost from the Output panel after the server restarts.
- Fix the server trace setting having no effect. It is now `glua.trace.server`, and its messages show in the `GLua Language Server` output when that output's log level is set to `Trace`.
- Fix debugger "Run File" and "Refresh File" not using source mappings for gamemode and addon files.
- Fix debugger path matching failing on Windows when casing differs.

## Language Server

- Refactor analysis into an incremental system that re-analyses only what an edit affects, significantly improving edit performance in large codebases at the cost of initial run performance and memory usage.
- Add automatic updates to `include`, `AddCSLuaFile` and `require` paths when a file is renamed or moved.
- Add a `--gmod-annotations` option to `glua_doc_cli`, so documentation exports can use GMod annotations.
- Add hook documentation inherited from parent classes to hovers.
- Add enum values to type mismatch messages, and accept a literal where an enum with that value is expected.
- Add narrowing of `Entity` to `Player` when it is compared with `LocalPlayer()`.
- Improve typing responsiveness by sending only the changed text, and answering hovers, completions and other requests while re-analysis is still running.
- Improve diagnostic speed by sending diagnostics as soon as they are ready and only checking files whose results could have changed.
- Improve indexing speed on large workspaces by analysing files in parallel.
- Improve memory usage on large workspaces.
- Improve handling of files changed, created, deleted, or renamed outside the editor by re-analysing them in the background.
- Improve config reloads, so a change to `.gluarc.json` applies to every file and only re-analyses what the changed settings affect.
- Improve stability by recovering from internal errors instead of leaving analysis or diagnostics stuck.
- Improve inferred types for tables, globals and members built across several files, including guarded, conditional, looped and late writes.
- Improve scripted class and VGUI support, including inline-registered panels, `DEFINE_BASECLASS`, `scripted_ents.Register` bases, `AccessorFunc` getters and panels that inherit from other panels.
- Improve type narrowing for nil checks, truthiness, `IsValid` and other guard functions, unions, and code that cannot run in the current realm.
- Improve type inference for `pairs`, `ipairs`, multi-return values, generic calls, overloads, and optional or default parameters.
- Improve the warning for a field only ever used as one subclass, so it is reported once per use, shows the narrowed type, and no longer suggests anonymous panel classes.
- Improve realm mismatch diagnostics by showing the evidence for each side.
- Improve overload mismatch messages to report only surplus arguments when leading parameters match.
- Fix diagnostics and types changing after an edit to code they do not depend on, or differing from a fresh start.
- Fix diagnostics being missing, stale, or cleared after edits, cancellations, file changes, deletions and renames.
- Fix diagnostics from an older version of a file being shown on newer text.
- Fix hovers, completions, go to definition, references, code lenses, semantic highlighting and inlay hints returning stale, empty or duplicated results while the workspace is re-analysed.
- Fix positions being off on lines that contain non-ASCII characters.
- Fix a moved or renamed file keeping its diagnostics at the old path.
- Fix requests made while the workspace is loading failing instead of being retried.
- Fix the server not shutting down cleanly when the editor closes.
- Fix code style checks reporting nothing in files that use GLua-only syntax.
- Fix crashes on startup in some workspaces, and on deeply nested code.
- Fix rare analysis hangs caused by values that update themselves across files, such as `t.k = t.k + 1`, or tables that contain themselves.
- Fix `glua_check` hanging or succeeding with incomplete results when a worker fails.
- Fix `include` picking a file with the same name elsewhere instead of the one next to the including file.
- Fix dynamic field definitions and references resolving to the wrong table, member, file or position.
- Fix incorrect `undefined-field`, `undefined-method`, `missing-fields`, `need-check-nil`, `param-type-mismatch` and `assign-type-mismatch` diagnostics caused by incomplete or unstable inference.
- Fix realm and load-order resolution when globals, tables and classes are defined across several files or realms.
- Fix scripted class members leaking between realms and files, and one file's `PANEL` class appearing in other files.
- Fix `AccessorFunc` and `NetworkVar` calls in gamemode files adding members to `GM` instead of the table they target.
- Fix net message diagnostics becoming stale when related code changes, and net senders being picked in a different order on different platforms.
- Fix false `missing-fields` warnings when a function call or `...` at the end of a table fills the remaining fields.
- Fix false `duplicate-field` warnings for fields that are not declared with doc tags.
- Fix method overrides being reported as incompatible when they accept every form of the base method or keep its return type.
- Fix a table with an `__index` metatable not matching the class it implements.
- Fix calls on values typed `any` not returning `any`.
- Fix `IsValid` checks keeping `true` in a value's type instead of narrowing it to the valid value.
- Fix `~= nil` checks narrowing untyped fields to `never` instead of a non-nil value.
- Fix truthiness checks failing to remove `nil` from unknown fields.
- Fix `infer-unknown` being reported for arithmetic results with a known numeric type.
- Fix undefined-field diagnostics for namespaces built across files with `X = X or {}` and used through an alias.
- Fix multi-return values containing `unknown` not spreading correctly into function arguments.
- Fix fields assigned to container elements inside loops or conditional blocks being treated as required class fields.
- Fix empty table writes being rejected for declared callback fields shared by closures.
- Fix a doc comment applying to code after the function it documents.
- Fix user-defined type aliases being replaced when a library uses the same name.
- Fix type errors being reported inside unreachable code.
- Fix "type not found" errors staying after the type is defined.
- Fix `true` and `false` not being read as booleans in attribute arguments, and nullable attribute parameters being treated as required.
- Fix hovers on unresolved names showing `unknown` instead of the token name.
- Fix keyword completions showing after `.` and `:`.
- Fix hook and net message completions including the half-typed name.
- Fix string completions replacing the wrong range after an opening quote.
- Fix missing-parameter warnings when directly calling a hook without trailing engine arguments.
- Fix `tonumber` not reading binary literals (`0b...`), hexadecimal fractions or exponents.
- Fix `break` and `continue` flow and unreachable code detection in `repeat ... until` loops.
- Fix various false positives identified in common gamemodes and addons.

## Annotations

- Add engine weapon, vehicle and NPC classes.
- Add GM methods and fields from base and sandbox gamemode source code.
- Improve `Player:GetWeapon` to return the weapon class requested.
- Improve Derma panel inheritance so `DTextEntry`, `DCheckBoxLabel`, `DFileBrowser` and `DNumPad` derive from their real base controls.
- Improve Derma skin paint hooks by typing them for the controls they paint.
- Fix `Entity:SetCreator`, `SetNWEntity`, `SetGroundEntity` and `Player:SpectateEntity` rejecting `nil` and `NULL` to clear a value.
- Fix `table.Copy` losing the copied table's type.

## Debugger

- Update for latest Garry's Mod (both x64 and x32)

---

## [1.2.1] [Pre-Release] - 2026-08-23
> Performance Improvements + Regression Fixes

## VS Code Extension

- Add server logs to the editor's output panel, so problems can be reported without hunting for a log file.
- Keep waiting while a large workspace finishes indexing, instead of giving up and reporting a failed start.

## Language Server
- Add a warning when a field typed as a base class is only ever used as one particular subclass, suggesting a guard instead of reporting its methods as undefined.
- Add support for out parameters that are not fields.
- Improve indexing and analysis speed on large workspaces.
- Improve net message analysis speed on large workspaces.
- Improve editor responsiveness while a workspace is being analysed.
- Improve memory use by limiting how much lookup data is cached.
- Improve typing responsiveness by answering hovers, completions and go to definition before an edit has finished re-indexing.
- Improve completion speed in large files by filtering members without reading the file again.
- Fix all diagnostics in a file clearing on edit and staying blank until the next change.
- Fix hovers, go to definition, and completions occasionally returning nothing right after an edit.
- Fix diagnostics and types slowly becoming wrong as you edit, which previously needed a restart to clear.
- Fix diagnostics missing when the workspace first finishes loading.
- Fix the server hanging when a type could never be worked out.
- Fix the server using a whole CPU core if its update loop failed.
- Fix analysis pausing when the editor is slow to read the server's output.
- Fix undefined methods and fields being hidden by an unrelated nil check.
- Fix net message warnings missing messages that are sent through local helper functions.
- Fix `self` not being typed as the scripted class of the file it is used in.
- Fix fields missing from classes that inherit from more than one place.
- Fix fields being missed when a table key contains a dot, such as `T["a.b"]`.
- Fix parameter types sometimes staying wrong after an edit.
- Fix scripted class fields being declared in the wrong order.
- Fix a warning suggesting a type that cannot be written when several subclasses match.
- Fix rename being offered on `self` and then refused.
- Fix completions and diagnostics sometimes coming back in a different order between runs.
- Fix the loading status ending on an old step name after indexing finished.
- Fix server log lines being split up or dropped when the editor is slow to read them.
- Fix types changing depending on the order files happened to be analysed in, which made results differ between a fresh start and an edit.
- Fix reading a global that is never defined anywhere clearing the type of the variable it was assigned to.
- Fix `x = x or default` giving a different type depending on which file declared `default`.
- Fix a global's type being worked out from only some of the files that define it.
- Fix a table field's type being taken from whichever file wrote it first.
- Fix table fields being widened by writes that only run inside an `if`.
- Fix `pairs` loop variables typed from only the keys written so far.
- Fix a `_G` loop variable typed from a snapshot of the globals.
- Fix fields being attached to whichever table was indexed first when a global is built across several files.
- Fix a field lookup stopping at an entry that has no type yet.
- Fix a member being dropped when its first attempt to attach failed.
- Fix a local typed against a dynamic field that had not been indexed yet.
- Fix a function's return type being decided by the first expression the analysis reached.
- Fix a callback with no known return type overriding the function's own body.
- Fix a value assigned later in a file contributing nothing to the field's type.
- Fix a field losing its type when the value was worked out after the file was read.

---

## [1.2.0] [Pre-Release] - 2026-08-17
> Index & Analysis Refactor + Open VSX Releases

## VS Code Extension

- Add a new dedicated GLua file icon for Garry's Mod Lua files (`glua`).
- Add Open VSX releases, so the extension can be installed in editors that do not use the VS Code Marketplace.

## Language Server
- Refactor analysis and indexing systems to make diagnostics deterministic.
- Improve indexing performance and memory usage on large workspaces.
- Improve typing responsiveness by skipping re-indexing for edits that do not change any code, such as whitespace.
- Improve syntax highlighting so it stays correct while files are still being indexed.
- Improve net message analysis performance on large workspaces.
- Fix self incorrectly resolving to definition method rather than to the actual object in certain cases.
- Fix methods sometimes showing as unknown and having no valid return type.
- Fix common worktree or agent locations being parsed due to incomplete default ignore list.
- Fix diagnostics flickering and disappearing while typing.
- Fix diagnostics sometimes not coming back after being cancelled.
- Fix semantic highlighting changing colors or flashing during fast edits.
- Fix inlay hints disappearing while files are being re-indexed.
- Fix table fields being lost when the same table is built across multiple files using `X = X or {}`.
- Fix globals not being found inside functions when they are defined further down the file.
- Fix globals using the wrong definition when several files add to the same table.
- Fix fields declared with `function a.b.c()` not being found.
- Fix type alias names being lost when merged into a union.
- Fix the wrong overload being picked for some function calls.
- Fix scripted class fields (`ENT`, `SWEP`, `TOOL`, `GM`) showing up in unrelated files.
- Fix panel fields being missing while the workspace is still loading.
- Fix loop variables losing their type or showing as `nil` in `for ... in pairs` and `while` loops.
- Fix wrong types from `or` fallbacks such as `local x = y or {}`.
- Fix math on unknown values always being treated as a number.
- Fix false positive `missing-fields` when table fields are added further down.
- Fix false positive `need-check-nil` when the value cannot actually be nil.
- Fix false positive `undefined-field` on fields added dynamically.
- Fix false positive `redundant-parameter` when calling overloaded functions.
- Fix false warnings on tables when the field's source cannot be found.
- Fix old results being kept after a file is deleted.
- Fix workspace indexing when exclude patterns are left empty.

---

## [1.1.2] [Pre-Release] - 2026-07-30

## VS Code Extension

- Add a dedicated `glua` language mode so GLuaLS can run alongside standard Lua tooling without changing VS Code's built-in `lua` mode.
- Add automatic `glua` selection for common Garry's Mod directories, entrypoint filenames, and realm-prefixed scripts, including standalone projects.
- Add a warning and switch action when a likely Garry's Mod file opens in standard Lua mode.
- Add startup conflict detection for GLua Enhanced and prevent GLuaLS from starting while the conflicting extension is enabled.
- Fix extension initialization for debugger runtime updates and document symbols.
- Fix language server start, stop, and restart races during extension initialization.
- Fix documentation search when it starts the language server, including startup retries and original startup error reporting.

## Language Server

- Improve net message analysis for aliases and wrappers across diagnostics, completion, hover, code lens, symbols, and references.
- Add library conflict warnings and respect configured library load order.
- Add downloadable `glua_doc_cli` builds.
- Improve documentation exports by handling invalid settings, excluded folders, text encodings, and export errors.
- Fix explicitly annotated types being replaced by inferred types.
- Fix multi-return arguments being checked against the wrong parameter positions.
- Fix immutable type narrowing being lost inside closures.
- Fix declared types being lost when fields are initialized with empty tables.
- Fix declared `self` types being replaced by call-site inference.
- Fix `Partial<T>` annotations producing incorrect mismatch diagnostics.
- Improve contextual typing for table literals assigned to declared fields, including nested callbacks.
- Fix structural table checks for defaults, methods, callbacks, generics, intersections, and nested fields.
- Fix scripted child inference and inherited tool and member types across workspaces, realms, and base classes.

## Annotations

- Add net payload annotations for read and write operations, send direction, recipients, and receive callbacks.
- Add generic iterator types for `RandomPairs`, `SortedPairs`, `SortedPairsByValue`, and `SortedPairsByMemberValue`.
- Improve custom structure overrides for common Garry's Mod data types and mark fields built later in `TextData` and `TextureData` as optional.
- Improve `derma.DefineSkin` to accept partial skin definitions.
- Fix deprecated argument, callback, and return details being lost during annotation generation.
- Fix direct and aliased class overrides being dropped or duplicated.

---

## [1.1.1] [Pre-Release] - 2026-07-24

## VS Code Extension

- Improve startup timeout diagnostics by separating workspace-loading stalls from analysis stalls.
- Improve status bar to show the language server version after startup.
- Improve status bar to show the annotation library version after startup.
- Improve annotation version loading to prevent stale annotations.
- Improve startup cleanup by clearing stale local annotation metadata on restart.
- Improve details shown in the status panel and tooltip.

## Language Server

- Add diagnostics for `CompileFile` file-loading checks.
- Add `undefined-method` diagnostics.
- Add usage-based inference for unknown locals and child fields.
- Add warnings when usage-based inference is low-confidence.
- Add helper parameter inference from callbacks, generic calls, multi-return values, and dynamic call names.
- Add `gmod.detectRealmFromCalls` (enabled by default) for load-order realm inference from standard and annotated calls.
- Add `gmod.inferDynamicFields` (enabled by default) for runtime field inference on GMod objects.
- Add schema support and a workspace setting to disable automatic annotation loading.
- Add an `edit-latency` benchmark.
- Improve load-order handling for `include`, `AddCSLuaFile`, `IncludeCS`, `require`, `file.Find`, and wrappers with `FileDefine` scope.
- Improve realm checks for client/server/menu code using `BaseClass` inheritance and inherited member visibility.
- Improve VGUI and scripted-class behavior for panel creation, callbacks, inheritance, and method forwarding.
- Improve dynamic field and member tracking so runtime-added members stay after reassignments, local reuse, mixins, and loops.
- Improve flow narrowing for branches, guards, aliases, predicates, and `or` branches.
- Add type narrowing for `IsValid` and related checks.
- Add handling for multi-return tail values.
- Improve return, alias, and `setmetatable` inference so type narrowing stays stable across paths.
- Improve completion and navigation data for shared client/server/menu code.
- Improve table, union, assignment, callback, and factory-object inference and checks with annotation wrappers.
- Improve network diagnostics for nested reads/writes and message ordering.
- Improve convar-style API handling and `for`/`pairs` index and numeric range checks.
- Improve startup order by loading annotation settings before diagnostics.
- Improve workspace performance by replacing slow sequential phases with faster cache/index updates.
- Fix noisy `inferred-method` warnings and duplicate diagnostics in overloads, callbacks, and call sites.
- Fix diagnostics from file overwrites and shadowed declarations during load-order checks.
- Fix cross-file inference instability.
- Fix `self` binding on function assignments and method calls.
- Fix class/type annotation conflicts and class detail drops in VGUI and scripted-class flows.
- Fix VGUI/scripted-class fields and class data being dropped during reassignments, inheritance, and local reuse.
- Fix `IsValid` and entity checks that were not narrowing types.
- Fix `FileDefine` visibility leaking outside file scope.
- Fix first-run annotation loading and initial startup reliability.
- Fix unresolved VGUI parent lookups to raise warning-level `undefined-field` instead of `undefined-method`.
- Fix `assign-type-mismatch` default severity from warning to hint.
- Fix vararg unpack handling in flow and call inference.
- Fix return-type narrowing for function calls with overloads and nil returns.
- Fix false positives from base Lua checks.

## Annotations

- Add `Global.CompileFile`.
- Add `Global.setfenv`.
- Add `Global.assert`.
- Add `Global.pairs`.
- Add `Global.IsEntity`.
- Add `Global.FixInvalidPhysicsObject`.
- Add `Global.IsHostingGame`.
- Add `Global.Entity`.
- Add `Global.error`.
- Add `workshopfilebase.dupes`.
- Add `debug.sethook`.
- Add `debug.getlocal`.
- Add `class.base_anim`.
- Add `class.base_brush`.
- Add `class.base_entity`.
- Add `class.base_filter`.
- Add `class.base_nextbot`.
- Add `class.base_point`.
- Add `class.DCollapsibleCategory`.
- Add `class.DForm`.
- Add `class.DHorizontalScroller`.
- Add `class.GM`.
- Add `class.SANDBOX`.
- Add `class.Tool`.
- Add `class.Weapon`.
- Add `ContentHeader.GetParent`.
- Add `ContentIcon.GetParent`.
- Add `IconEditor.SetIcon`.
- Add `Entity.GetOwner`.
- Add `Entity.IsNPC`.
- Add `Entity.IsVehicle`.
- Add `GM.AddNotify`.
- Add `Panel.SetParent`.
- Add `Panel.SelectAllText`.
- Add `DForm.ComboBox`.
- Add `DForm.TextEntry`.
- Add `DHorizontalScroller.AddPanel`.
- Add `DPanelList.ScrollToChild`.
- Add `DPanelList.SortByMember`.
- Add `DTree.AddNode`.
- Add `DTree.OnNodeSelected`.
- Add `DTree_Node.AddNode`.
- Add `DTree_Node.OnNodeSelected`.
- Add `duplicator.EntityModifiers`.
- Add `Player.CheckLimit`.
- Add `Player.IsListenServerHost`.
- Add `Weapon.CheckLimit`.
- Add `Tool.GetSWEP`.
- Add `Tool.GetWeapon`.
- Add `vgui.CreateFromTable`.
- Fix annotation shape for `Global.assert`.
- Fix annotation shape for `Global.pairs`.
- Fix `DForm.ComboBox` annotations.
- Fix `Panel.SelectAllText` annotations.
- Fix `DTree.OnNodeSelected` signature.
- Fix `DTree_Node.OnNodeSelected` signature.
- Fix annotation generation by removing `self` reference output.
- Fix annotation schema, guard/load-wrapper metadata, overloads, optional fields, and nullability handling.

---

## [1.1.0] [Pre-Release] - 2026-06-20
> Annotation Refactor

## Language Server
- Add `call_arg` annotation attribute, moving hardcoded call argument logic (e.g. VGUI, color, hooks, net messages) to annotations for better customisation and extensibility.
- Add inferred default value system, showing default values in hover and autocomplete without inflating union types.
- Add `require()` now registers unknown modules using the passed string as the name.
- Add `call_arg` overload support.
- Fix alias to class not showing the original type name.
- Fix type guard narrowing persisting after its scope ends.
- Fix nil checks not preventing undefined global diagnostics in some cases.
- Fix error or nested halts not preventing nil propagation.
- Fix table shapes collapsing to `any` due to guarded statements.
- Fix tables incorrectly binding to unknown keys.
- Fix code lens becoming unstable after undo.
- Fix stable std lib by never using cache (always use built-in std lib).
- Fix inferred local assignment could be `unknown` at definition.
- Fix codelens and inlay hints not loading in files already open on language server load.
- Various performance improvements

## Annotations

- Add `call_arg` annotation metadata for `surface.*`, `vgui.*`, `net.*`, `notification.*`, `chat.*`, `timer.*`, `render.*`, `input.*`, `file.*`, `gui.*`, `game.*`, `util.*`, `string.*`, `hook.*`, `ents.*`, `cvars.*`, `PropertyAdd`, `scripted_ents.Register`, `vgui.RegisterTable`, `vgui.CreateFromTable`, `NetworkVarElement`, and hook callbacks.
- Add `error` annotation.
- Add `IsHostingGame` menu annotation.
- Fix `PropertyAdd` optional fields.
- Fix scripted entity registration table type.
- Fix `VideoData` optional `lockfps` field.
- Fix `debug.getmetatable` annotation.
- Fix annotation generation to load annotation files by default.

## Debugger

- Fix segfault on map change caused by dangling tier0 logging listener.
- Unify CI and local builds on pinned `danielga/garrysmod_common` master.
- Run CI on submodule changes.

---

## [1.0.27] [Stable] - 2026-06-12

- All changes from 1.0.15 -> 1.0.26

---

## [1.0.26] [Pre-Release] - 2026-06-06

## VS Code Extension

- Add better startup diagnostic and error handling, with clear progress messages.
- Add escape string support to semantic highlighting.
- Add hover verbosity controls for shown tables, remove old verbosity setting.
- Refactor existing semantic highlighting to be more standardised for better theme compatibility.
- Move logging to VSCode logs folder when language server used by extension
- Fix "open logs" button

## Language Server

- Add better startup handling and logging.
- Add escape string support to semantic highlighting.
- Add better nested table hovers.
- Add support for custom logging directory.
- Add support for hover verbosity levels, remove old verbosity setting.
- Refactor literal / known table handling.
  - Support for literal table values in known complex tables rather than collapsing to generic type table.
  - Support for appending to known table with more values, rather than raising diagnostic.
  - Support tables being modified and changed dynamically, rather than assuming static.
- Fix for loops sometimes giving nil on attempted index

---

## [1.0.25] [Pre-Release] - 2026-06-03

## VS Code Extension

- Add context menu option to ignore directory (right click on explorer view on directory)
- Add context menu option to add global variable (right click on problems view on undefined-global diagnostic - relevant file must be open as well)

## Language Server

- Fix a bug where tables which were constantly overwritten would stop binding after first overwrite (issue seen mostly with panels, where multiple panels are defined in same file).
- Various performance and stability improvements.

---

## [1.0.24] [Pre-Release] - 2026-06-02

## VS Code Extension

- Add support for rich color previews in autocomplete and hover.

## Language Server

- Add rich color previews in autocomplete and hover.
- Add better type information in autocomplete for many known types.
- Various performance and stability improvements.

---

## [1.0.23] [Pre-Release] - 2026-06-01

## Language Server

- Speculative fixes for more potential table index nil false positives (refactored table indexing with new merge system).
- Various performance and stability improvements.

---

## [1.0.22] [Pre-Release] - 2026-05-31

## Language Server

- Fix functions definition signature binding to local variables rather than actual definition.
- Fix "goto definition" going to variable definition rather than function definition.
- Fix usages count showing all references rather than just function usages.

---

## [1.0.21] [Pre-Release] - 2026-05-31

## Language Server

- Improved performance and stability.
- Improve IsX checks and move to annotation level
- Fix shared diagnostics being lost on the currently open file.
- Fix realm mismatch false positive when there are multiple definitions on different realms.
- Fix param-type-mismatch when there's a union containing type `any`.
- Fix guarded tables overwriting previous definitions for that table.
- Fix self assigned to variable sometimes becoming a literal table rather than remaining as a class

## Annotations

- Add IsX annotations to replace hardcoded functions.
- Fix iterator not returning correct function.
- Fix IsPlayer not narrowing to player type.

---

## [1.0.20] [Pre-Release] - 2026-05-26

## VS Code Extension

- Move to dedicated `annotations-gmod-glua-ls` repository for GMod annotation downloads.
- Add `gluals.gmod.annotationsRepository` setting.
- Add `gluals.gmod.annotationsBranch` setting.
- Improve annotation validation when annotations are from a different source.
- Fix language server status being shown as ready too early (before initial index + diagnostic run)
- Fix existing annotations using old source not being updated automatically.
- Fix extension startup stalling if the language server takes too long to respond.
- Fix annotation download URL not encoding branch names with special characters correctly.

## Language Server

- Add `func` to `function` default parameter mapping.
- Add default GLua parameter type conversion.
- Add `strictTypeCoercion` mode.
- Add built-in `std.Split` support.
- Add `BaseClass` support for panel classes.
- Add `---@outparam` tag support.
- Add default value syntax support for optional parameters.
- Add `NULL` entity support.
- Add inference for fields set by helper functions.
- Improve dynamic fields for metatable-based objects.
- Improve dynamic field completion, hover and go-to-definition.
- Improve hover ordering and explicit realm display.
- Improve scripted class dynamic field resolution.
- Improve metatable inference.
- Improve references, definitions, hover and implementations.
- Improve performance for indexing and diagnostic phases.
- Improve documentation for annotations, configuration, language features, and debugger.
- Fix false positive undefined-field errors on numerically-indexed tables.
- Fix false positive type mismatch errors on inherited class method parameters.
- Fix false positives from nil checks and initialized table assignment chains.
- Fix type narrowing being cut short in large files.
- Fix whitespace breaking table indexing.
- Fix `pairs()` on exact tables losing key and value types.
- Fix workspace overrides hiding documented library return types.
- Fix globals not being resolved correctly in some cases.
- Fix TOOL files under `lua/weapons/gmod_tool/stools/**` being treated as SWEPs.
- Fix SWEP default tool file exclusion being too broad and excluding unrelated files.
- Fix scripted class file exclusions not being scoped correctly.
- Fix scripted class type identities leaking or conflicting across different scripted classes.
- Fix inferred table shapes and types being lost or not preserved across conditional branches.
- Fix generic table indexing incorrectly inferring return values as `nil`.
- Fix return types of metatables sometimes displaying as generic tables instead of their exact shape.
- Fix function overloads not resolving correctly when parameters are inferred as `nil`.
- Fix incorrect type narrowing for table unions and condition checks.
- Fix false positive parameter type mismatch diagnostics on numeric type aliases and nullable unions.
- Fix parameter count and type mismatch diagnostics incorrectly flagging split realm commands.
- Fix nil-check warning suppression to correctly validate prior `IsValid` guard conditions.
- Fix nil-check guard scope escaping to unrelated branches when using `elseif`.
- Fix `@outparam` side-effects not being tracked through locally-aliased variables.
- Fix false positive parameter types caused by inferring `Angle` from parameter names like `ang`.
- Fix `glua_check` temp workspaces conflicting under concurrent diagnostics.
- Fix unstable dynamic field inference after edits.
- Fix dynamic field inference and member lookups not being position-aware or scoped to the exact owner.
- Fix go-to-definition and references matching same-line writes or wildcard definitions for dynamic fields.
- Fix net message flow tracking not tracing reads/writes through class methods.
- Fix unstable cross-file type caches causing non-deterministic diagnostics.
- Fix `NetworkVar`s defined outside of `shared.lua` not being detected.
- Fix `NetworkVar`s not being detected in scripted classes.
- Fix file-scoped dynamic fields leaking across files when globals are disabled.
- Fix `scripted_ents.GetMember(...)` not carrying over `NetworkVar` accessors.
- Fix startup-complete status being sent before initial workspace diagnostics finish.
- Fix optional/default parameter type handling.
- Fix type handling for `self`, locals and default members.
- Fix floats in default parameter values being parsed as integers.
- Fix duplicate outparam tags not being merged correctly.
- Fix `NULL` not being removed after an `IsValid` check.
- Fix inconsistent diagnostics caused by unstable type ordering.
- Fix diagnostic flickering during analysis.
- Fix fields default values not being treated as optional.

## Annotations

- Move to dedicated `annotations-gmod-glua-ls` repository.
- Add `NULL` entity support.
- Add `string.Explode` override.
- Add `HTTPRequest` type override.
- Add `collectgarbage` override.
- Add `WEAPON:Holster` hook override.
- Add `net.ReadTable` override.
- Add `SKIN` class override.
- Add `Label:SetFont` and `Label:SetTextColor` methods.
- Add `scripted_ents.GetMember` override.
- Add overrides for `LeftClick` and `RightClick` hooks.
- Add `Panel.BaseClass` field.
- Add outparam annotations to trace functions (`util.TraceEntity`, `util.TraceEntityHull`, `util.TraceHull`, `util.TraceLine`).
- Add type overrides for networked variable getters (`GetNW*` and `GetNetworked*`).
- Add generic `table.Copy` override.
- Add support for generating parameter default values from the wiki.
- Add missing built-in entity classes (`env_fire`, `prop_dynamic_override`, `prop_ragdoll`, `prop_vehicle_prisoner_pod`).
- Add duplicator and `EntityCopyData` overrides.
- Improve `string.Split` typing.
- Improve global `Entity` typing.
- Improve `ipairs` iterator return typing.
- Improve struct class annotations using `@field`.
- Fix `os.date` `*t` overloads to return `DateData`.
- Fix `debug.getinfo` incorrect parameters and return type.
- Fix `FindMetaTable` incorrectly returning `nil`.
- Fix `Entity.BaseClass` typed as `Entity?`.
- Fix `string.gsub` incorrect parameters.
- Fix numerical enum annotations.
- Fix `file.Read` and `file.Write` annotations being missing in built outputs.
- Fix `os.date` format parameter was not optional.
- Fix `EntityCopyData` transform fields was not optional.
- Fix `NULL` entity did not inherit from `Entity` type.

---

## [1.0.19] [Pre-Release] - 2026-04-29

## Language Server

- Add support for metatable registration complex types and methods.
- Fix table keys being nil in for loops.
- Fix unknown field access not being potentially nil.
- Fix no warning diagnostic on attempt to access a field for a potentially nil variable.
- Fix guarded table assignments not being registered correctly.
- Fix over-eager narrowing to any and restored unknown for no type found.
- Fix some diagnostics being unstable / non-deterministic due to race conditions.
- Fix narrowing for globals after valid checks.
- Fix language server dropping narrowed types too early.
- Fix table access for sequential tables being inferred as nil.
- Fix field index not strictly looking for exact matches.
- Various other minor fixes and improvements.

---

## [1.0.18] [Pre-Release] - 2026-04-26

### VS Code Extension

- Add experimental macOS support.

### Language Server

- Add experimental macOS support.

### Debugger

- Add experimental macOS support.

---

## [1.0.17] [Pre-Release] - 2026-04-23

### VS Code Extension

- Improve language server start, stop and restart handling.
- Add experimental macOS VSIX packaging for darwin-x64 and darwin-arm64. macOS language server builds and debugger support are experimental.

### Language Server

- Add advanced base gamemode detection + automatic library load attempt.
- Add undefined-global-argument diagnostic (warning) to split undefined-global diagnostic (error) into severe and non-severe cases.
- Add code lens and rich hover info for net messages.
- Add hover link to open the Garry's Mod wiki for API functions.
- Improve net message diagnostics to track dynamic read/write patterns.
- Improve realm-aware narrowing and fix some realm mismatch issues.
- Improve workspace loading performance.
- Improve performance with additional indexing optimizations.
- Fix various unknown member, undefined global and infer issues.
- Fix string union field assignment false positives.
- Fix invalid unused diagnostics for scripted classes.
- Fix table field inference false positives and hover displaying nil incorrectly.
- Fix incorrect narrowing from child class field definitions.
- Fix multi-return local variable handling. (thanks @apyrr)

### Annotations

- Annotations are being moved to a new repo, and won't be updated until next pre-release.

---

## [1.0.16] [Pre-Release] - 2026-04-13

- Version bump (same as 1.0.15)

---

## [1.0.15] [Stable] - 2026-04-13

- All changes from 1.0.6 -> 1.0.14
- Fix potential crash on startup

---

## [1.0.14] [Pre-Release (RC4)] - 2026-04-13

### Language Server

- Fix various string issues
- Fix various module issues

### Annotations

- Fix file class missing methods
- Fix string.gsub missing parameters
- Fix debug.getinfo incorrect parameters
- Fix integer enums not allowing raw integer values

---

## [1.0.13] [Pre-Release (RC3)] - 2026-04-12

### Language Server

- Fixed a bug where module used with redefined `package.seeall` resulted in corruption of language server output.

---

## [1.0.12] [Pre-Release (RC2)] - 2026-04-12

### VS Code Extension

- Update docs and UI for multi-root isolation configuration

### Language Server

- Add workspace isolation toggle
- Add config merge system for when workspace isolation is disabled
- Disable workspace isolation by default
- Fix regression causing inlay hint flicker on type
- Fix regression causing edits to class definition not updating global index

---

## [1.0.11] [Pre-Release (RC1)] - 2026-04-11

### VS Code Extension

- Add gamemode base detection + automatic library load attempt for non sandbox/base gamemodes.
- Fix color picker showing outside of brackets for `Color()`

### Language Server

- Add gamemode base detection + automatic library load attempt for non sandbox/base gamemodes.
- Fix goto-def not respecting realms (was not fully realm aware)
- Fix regression with race condition resulting in field assignments being unstable
- Fix undefined `i` in `for i` loops
- Fix color picker not being recognised for many valid Color objects
- Fix narrowing sometimes leading to undefined issues with globals
- Fix infer sometimes leading to incorrect assumptions when infering classes

---

## [1.0.10] [Pre-Release] - 2026-04-09

### VS Code Extension

- Improved syntax/semantic highlighting
- Fix auto-update failing for debugger on old builds
- Merge debugger update into one command rather than two, improve flow
- Debugger setup overwrites existing binary files if detected

### Language Server

- Merge many commits from upstream
  - Better performance
  - Various bug fixes
- Add better semantic highlighting features
- Fix highlighting not updating if file was already open

### Debugger

- Add fallback version

---

## [1.0.9] [Pre-Release] - 2026-04-07

### VS Code Extension

- Fix errors and entity panel being shared for all debugger instances
- Add clientside debugger support
- Add optional clientside debugger setup step to debug wizard
- Add client gmod install autodetection
- Update auto-update system for debugger and annotations
- Update srcds install autodetection
- Update documentation

### Language Server

- Fix net read/write mismatch with if statements
- Fix param mismatch not skipping for union checks
- Add entity type narrowing for more accurate entity types
- Update documentation

### Debugger

- Add full clientside debugger support
- Add CLI flags / launch options for pause on activate and allow remote connection (SRCDS + Client)
  - `-rdb_allow_remote` (off by default)
  - `-rdb_pause_on_activate [seconds]` (off by default, time default = 60s, 0 = inf)
- Update CI workflow for better build speed
- Various fixes and improvements

---

## [1.0.8] [Pre-Release] - 2026-04-04

### VS Code Extension

- Add and improve various tests
- Update documentation
- Update readme

### Language Server

- Fix remaining known realm related issues
- Add and improve various tests
- Update documentation

### Debugger

- Fix x64 win debugger crash with entity explorer
- Add better CI workflow

---

## [1.0.7] [Pre-Release] - 2026-04-02

### VS Code Extension

- Add 32/64-bit debugger binary auto-detection on Windows
- Add undefined-global "quickfix" option to add global to config
- Add annotation file path override setting for testing annotations
- Add default 1hr interval for annotation update checking
- Add interactive UI editor for `workspace.ignoreDirDefaults` — view, disable, override, or add to built-in ignore glob defaults per workspace
- Fix various issues with `ignoreDirDefaults` not loading correctly

### Language Server

- Add module support
- Fix various realm related issues
- Fix various undefined-global issues by improving infer system
- Fix validation not correctly narrowing type in some cases
- Fix types not correctly showing for some variables after narrowing
- Update documentation related to debugger

### Debugger

- Fix x64 windows crash

---

## [1.0.6] [Pre-Release] - 2026-03-29

### VS Code Extension

- Add option to configure debugger from "GLuaLS Status Bar" menu
- Update package and README
- Fix CI failure on non-tagged builds

### Language Server

- Fix linter issues

---

## [1.0.5] [Pre-Release] - 2026-03-28

### VS Code Extension

- Add VSIX files to releases
- Mark extension as preview
- Change sticky scroll to foldingProviderModel by default as workaround
- Remove workspace repair tool
- Fix CI publish workflow not correctly adding LS server

### Language Server

- Fix cross-file class annotation only using last indexed
- Fix narrowing not respecting alias types
- Fix various issues with class fields and inference

---

## [1.0.4] [Pre-Release] - 2026-03-28

### VS Code Extension

- Fix permission issue with CI
- Add manual workflow + prerelease debugger builds

### Language Server

- Update badges and documentation

---

## [1.0.3] [Pre-Release] - 2026-03-27

### Language Server

- Fix syntax errors showing on wrong line
- Fix valid checks not narrowing type
- Fix style issues
- Fix member inference only showing last definition

---

## [1.0.2] [Pre-Release] - 2026-03-26

### Language Server

- Fix failing tests
- Update network configuration documentation

---

## [1.0.1] [Pre-Release] - 2026-03-25

### Language Server

- Documentation update

---

## [1.0.0] [Stable] - 2026-03-30

### VS Code Extension

- Garry's Mod GLua Language Server fork from EmmyLua Analyzer
- IntelliSense, auto-completion, and diagnostics for GLua
- Syntax highlighting for Garry's Mod Lua
- Go to definition and find references support
- GMod-specific API annotations support
- Realm detection (server/client/shared) based on file paths and content
- Class Explorer sidebar for scripted classes (ENT, SWEP, EFFECT)
- Debugger integration with remote debugging support for GMod (server, client, and shared realms)
- MCP (Model Context Protocol) host for GMod debug tool execution
- Language model tools integration (search docs, run Lua, run commands, get debug state)
- Configuration support via `.gluarc.json` with settings editor UI
- Error explorer panel for runtime error visualization
- Entity explorer panel for in-game entity inspection
- VGUI Panel code lens support
- Auto-annotation update system from gluals-annotations branch
