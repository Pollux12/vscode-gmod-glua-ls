AddCSLuaFile()

{{class}}.Base = "weapon_base"
{{class}}.PrintName = "{{name}}"
{{class}}.Category = "GLuaLS"
{{class}}.Spawnable = true
{{class}}.AdminOnly = false

{{class}}.Primary = {
    ClipSize = -1,
    DefaultClip = -1,
    Automatic = false,
    Ammo = "none",
    Delay = 0.2,
}

{{class}}.Secondary = {
    ClipSize = -1,
    DefaultClip = -1,
    Automatic = false,
    Ammo = "none",
    Delay = 0.5,
}

function {{class}}:PrimaryAttack()
    self:SetNextPrimaryFire(CurTime() + self.Primary.Delay)

    if CLIENT then
        return
    end

    -- Server-side primary fire logic.
end

function {{class}}:SecondaryAttack()
    self:SetNextSecondaryFire(CurTime() + self.Secondary.Delay)

    if CLIENT then
        return
    end

    -- Server-side secondary fire logic.
end
