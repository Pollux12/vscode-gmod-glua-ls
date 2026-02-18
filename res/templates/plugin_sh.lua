--[[
    {{name}}
    Class: {{class}}
    Author: {{author}}
    Generated on {{date}}
]]

---@type PLUGIN
local {{class}} = PLUGIN ---@diagnostic disable-line: undefined-global

{{class}}.name = "{{name}}"
{{class}}.description = "TODO: describe {{name}}"
{{class}}.author = "{{author}}"

function {{class}}:OnLoaded()
    if self.Logger then
        self:Logger():Info(("Loaded plugin '%s'"):format(self.name or "{{name}}"))
    end
end
