--[[
    Class: {{class}}
    Generated on {{date}}
]]

-- Toolgun category and display name shown in the spawn menu.
{{class}}.Category = "Construction"
{{class}}.Name = "#tool.{{name}}.name"

-- ClientConVar values are per-player settings that the tool reads from cvars.
{{class}}.ClientConVar = {
    mode = "default",
}

-- These keys map to tool.<mode>.left/right/reload language entries.
{{class}}.Information = {
    { name = "left" },
    { name = "right" },
    { name = "reload" },
}

-- Default language entries for the tool name, description, and help text.
if CLIENT then
    language.Add("tool.{{name}}.name", "{{name}}")
    language.Add("tool.{{name}}.desc", "Describe what your tool does.")
    language.Add("tool.{{name}}.left", "Primary action")
    language.Add("tool.{{name}}.right", "Secondary action")
    language.Add("tool.{{name}}.reload", "Tertiary action")
end

function {{class}}:LeftClick(trace)
    -- Return true on the client so predicted tool traces do not fail.
    if CLIENT then
        return true
    end

    -- Abort when aiming at sky/void or otherwise missing a valid trace.
    if not trace.Hit then
        return false
    end

    -- Server-side primary action.
    return true
end

function {{class}}:RightClick(trace)
    -- Return true on the client so predicted tool traces do not fail.
    if CLIENT then
        return true
    end

    -- Abort when aiming at sky/void or otherwise missing a valid trace.
    if not trace.Hit then
        return false
    end

    -- Server-side secondary action.
    return true
end

function {{class}}:Reload(trace)
    -- Return true on the client so predicted tool traces do not fail.
    if CLIENT then
        return true
    end

    -- Abort when aiming at sky/void or otherwise missing a valid trace.
    if not trace.Hit then
        return false
    end

    -- Server-side tertiary action.
    return true
end

-- BuildCPanel is called with a panel argument (not self).
function {{class}}.BuildCPanel(panel)
    panel:AddControl("Header", {
        Description = "#tool.{{name}}.desc",
    })
end
