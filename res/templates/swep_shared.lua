--[[
    Class: {{class}}
    Generated on {{date}}
]]

-- Send this shared weapon file to clients.
AddCSLuaFile()

-- Basic weapon identity and spawn permissions.
{{class}}.Base = "weapon_base"
{{class}}.PrintName = "{{name}}"
{{class}}.Category = "GLuaLS"
{{class}}.Spawnable = true
{{class}}.AdminOnly = false

-- Primary fire configuration (left click).
{{class}}.Primary = {
    ClipSize = -1,
    DefaultClip = -1,
    Automatic = false,
    Ammo = "none",
    Delay = 0.2,
}

-- Secondary fire configuration (right click).
{{class}}.Secondary = {
    ClipSize = -1,
    DefaultClip = -1,
    Automatic = false,
    Ammo = "none",
    Delay = 0.5,
}

-- Runs when the player uses primary fire.
function {{class}}:PrimaryAttack()
    -- Set the next allowed fire time for this attack.
    self:SetNextPrimaryFire(CurTime() + self.Primary.Delay)

    -- Skip gameplay logic clientside unless you need prediction effects.
    if CLIENT then
        return
    end

    -- Server-side primary fire logic.
end

-- Runs when the player uses secondary fire.
function {{class}}:SecondaryAttack()
    -- Set the next allowed fire time for this attack.
    self:SetNextSecondaryFire(CurTime() + self.Secondary.Delay)

    -- Skip gameplay logic clientside unless you need prediction effects.
    if CLIENT then
        return
    end

    -- Server-side secondary fire logic.
end
