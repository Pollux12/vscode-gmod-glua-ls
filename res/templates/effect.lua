--[[
    Class: {{class}}
    Generated on {{date}}
]]

-- Material used by the fallback sprite render.
local MATERIAL = Material("effects/softglow")

-- Called once when the effect is spawned.
function {{class}}:Init(data)
    -- CEffectData is shared by the engine, so copy values you need now.
    self.Origin = data:GetOrigin()
    self.Angles = data:GetAngles()
    self.Normal = data:GetNormal()
    self.Scale = math.max(data:GetScale(), 1)
    self.Magnitude = math.max(data:GetMagnitude(), 8)

    -- Keep timing fields explicit so Think can stop the effect cleanly.
    self.LifeTime = 0.25
    self.DieTime = CurTime() + self.LifeTime
    self.NextParticle = 0

    -- Expand render bounds so particles/sprites are visible at the edges.
    local bounds = Vector(32, 32, 32)
    self:SetRenderBoundsWS(self.Origin - bounds, self.Origin + bounds)
end

-- Return true to keep rendering, false to remove the effect.
function {{class}}:Think()
    return CurTime() < self.DieTime
end

-- Draw particles and simple sprite fallback visuals.
function {{class}}:Render()
    local now = CurTime()
    -- Throttle particle emission to avoid spawning each frame.
    if now >= self.NextParticle then
        self.NextParticle = now + 0.03

        local emitter = ParticleEmitter(self.Origin, false)
        if emitter then
            local particle = emitter:Add("effects/softglow", self.Origin)
            if particle then
                particle:SetAngles(self.Angles)
                particle:SetVelocity(self.Normal * self.Magnitude)
                particle:SetLifeTime(0)
                particle:SetDieTime(0.2)
                particle:SetStartAlpha(255)
                particle:SetEndAlpha(0)
                particle:SetStartSize(self.Scale * 1.6)
                particle:SetStartLength(1)
                particle:SetEndSize(self.Scale * 1.2)
                particle:SetEndLength(4)
                particle:SetColor(255, 102, 0)
            end

            emitter:Finish()
        end
    end

    local timeLeft = math.max(self.DieTime - now, 0)
    local fraction = timeLeft / self.LifeTime
    local size = self.Scale * (8 + (16 * fraction))

    -- Draw a fading sprite so the effect is still visible without particles.
    render.SetMaterial(MATERIAL)
    render.DrawSprite(self.Origin, size, size, Color(255, 160, 96, 220 * fraction))
end
