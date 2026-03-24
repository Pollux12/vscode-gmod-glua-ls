--[[
    Class: {{class}}
    Generated on {{date}}
]]

include("shared.lua") -- This runs shared.lua on the client

-- Draws the entity. This isn't required anymore (does this by default), but is here as an example.
function {{class}}:Draw()
    self:DrawModel()
end
