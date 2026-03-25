Garry's Mod API definitions are not bundled by default to reduce initial download size. Downloading these annotations enables type definitions, autocomplete, and parameter hints for globals, classes, and hooks.

### How they work

To deliver the most accurate definitions, an automated parser constantly tracks the official GMod Wiki.
When the annotations are downloaded, hundreds of standard engine APIs—from `net.Receive` to `Entity:SetPos`—gain fully typed `---@param` and `---@return` values out-of-the-box.

These syntax hints can also be used to document internal codebase functions. The extension implements custom tags specific to Garry's Mod concepts, enabling the definition of custom classes, instance-specific objects, and custom hook architectures.

[View the Annotation Documentation](https://gluals.arnux.net/annotations)

## How to use annotations

Once downloaded, the annotation files are automatically loaded by the language server to provide advanced language features. Annotations are primarily used to define types, but can also help identify hooks, realms and more.

### Examples

```lua
---@type Entity # Entity returns type `entity?` anyway, so the type annotation is not required here. This is just to give an example.
local ent = Entity(1)

if IsValid(ent) then
    -- The extension now knows :SetPos takes Vector and returns void, since it knows that ent is a valid Entity
    ent:SetPos(Vector(0, 0, 0))

    -- If you pass wrong type, you get a warning right away
    -- ent:SetPos('wrong') -- diagnostic: expected Vector, got string
end
```

```lua
---@class MyWeapon
---@field ClipSize integer

--- This makes the player take damage from ths weapon.
---@realm shared
---@param ply Player
---@param dmg number
---@return boolean
function MyWeapon:TakeDamage(ply, dmg)
    -- ...
end
```

> **Note:** The annotations have an automatic update system - you will be prompted if an update is available.