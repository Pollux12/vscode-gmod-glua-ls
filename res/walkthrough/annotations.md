Garry's Mod API definitions are not bundled by default to reduce initial download size. Downloading these annotations enables type definitions, autocomplete, and parameter hints for globals, classes, and hooks.

### How they work

To deliver the most accurate definitions, an automated parser constantly tracks the official GMod Wiki.
When the annotations are downloaded, hundreds of standard engine APIs—from `net.Receive` to `Entity:SetPos`—gain fully typed `---@param` and `---@return` values out-of-the-box.

These syntax hints can also be used to document internal codebase functions. The extension implements custom tags specific to Garry's Mod concepts, enabling the definition of custom classes, instance-specific objects, and custom hook architectures.

[View the Annotation Documentation](https://gluals.arnux.net/annotations)

> **Note:** The annotations have an automatic update system - you will be prompted if an update is available.