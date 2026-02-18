--[[
    {{name}}
    Class: {{class}}
    Generated on {{date}}
]]

function {{class}}:Init(data)
    self.Position = data:GetOrigin()
    self.LifeTime = CurTime() + 1
end

function {{class}}:Think()
    return CurTime() < (self.LifeTime or 0)
end

function {{class}}:Render()
    -- Render effect visuals here.
end
