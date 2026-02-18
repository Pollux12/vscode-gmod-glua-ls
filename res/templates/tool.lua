{{class}}.Category = "GLuaLS"
{{class}}.Name = "#tool.{{name}}.name"

{{class}}.ClientConVar["mode"] = "default"

function {{class}}:LeftClick(trace)
    if CLIENT then
        return true
    end

    -- Left-click behavior.
    return IsValid(trace.Entity)
end

function {{class}}:RightClick(trace)
    if CLIENT then
        return true
    end

    -- Right-click behavior.
    return IsValid(trace.Entity)
end

function {{class}}:BuildCPanel(panel)
    panel:AddControl("Header", { Description = "#tool.{{name}}.desc" })
end
