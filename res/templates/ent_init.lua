--[[
    Class: {{class}}
    Generated on {{date}}
]]

-- Send shared and cl_init to the client
AddCSLuaFile("cl_init.lua")
AddCSLuaFile("shared.lua")

include("shared.lua") -- This runs shared.lua on the server

-- This code runs whenever the entity is created.
function {{class}}:Initialize()
    self:SetModel("models/props_c17/oildrum001.mdl")
    self:PhysicsInit(SOLID_VPHYSICS)
    self:SetMoveType(MOVETYPE_VPHYSICS)
    self:SetSolid(SOLID_VPHYSICS)

    local physicsObject = self:GetPhysicsObject()

    -- This will enable physics on the entity.
    if IsValid(physicsObject) then
        physicsObject:Wake()
    end
end

-- This is used to run code every tick or another interval. In this case, it runs every second.
function {{class}}:Think()
    self:NextThink(CurTime() + 1) -- This makes the next Think run 1 second later. Remove to run every tick instead.
    return true
end
