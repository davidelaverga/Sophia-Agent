import type { VisualTierLevel } from '../hooks/useVisualTier'

export interface EnhancedFieldBackgroundProfile {
  frameIntervalMs: number | null
  particleCount: number
  iridescenceMultiplier: number
  causticsMultiplier: number
  auroraMultiplier: number
}

export interface PresenceFieldProfile {
  frameIntervalMs: number | null
  nebulaOctaves: number
  ribbonCount: number
  ribbonSegments: number
  sparkCount: number
  speakingBurstCount: number
}

export interface CelestialCometProfile {
  frameIntervalMs: number | null
  lensFlareFrameIntervalMs: number | null
  renderScale: number
  quality: number
  showLensFlare: boolean
}

export interface AuthGateVisualProfile {
  animateSky: boolean
  skyFrameIntervalMs: number | null
  starsFrameIntervalMs: number | null
  shootingStarCount: number
  dustCount: number
  satelliteEnabled: boolean
  nightFlyerCount: number
}

export interface RitualThreadProfile {
  frameIntervalMs: number | null
}

export interface WaveformProfile {
  frameIntervalMs: number | null
  listeningBarCount: number
  thinkingParticleCount: number
  reflectingSpiralPoints: number
  speakingRippleCount: number
}

export interface RecapOrbitProfile {
  auroraFrameIntervalMs: number | null
  poolFrameIntervalMs: number | null
  fogFrameIntervalMs: number | null
  fogWispCount: number
  allowComets: boolean
  allowFog: boolean
}

export function shouldSkipTierFrame(
  now: number,
  lastFrameTime: number,
  frameIntervalMs: number | null,
): boolean {
  return frameIntervalMs != null && lastFrameTime !== 0 && now - lastFrameTime < frameIntervalMs
}

export function getEnhancedFieldBackgroundProfile(
  tier: VisualTierLevel,
): EnhancedFieldBackgroundProfile {
  if (tier === 1) {
    return {
      frameIntervalMs: 83,
      particleCount: 48,
      iridescenceMultiplier: 0,
      causticsMultiplier: 0,
      auroraMultiplier: 0,
    }
  }

  if (tier === 2) {
    return {
      frameIntervalMs: 34,
      particleCount: 84,
      iridescenceMultiplier: 0.35,
      causticsMultiplier: 0,
      auroraMultiplier: 0,
    }
  }

  return {
    frameIntervalMs: null,
    particleCount: 140,
    iridescenceMultiplier: 1,
    causticsMultiplier: 1,
    auroraMultiplier: 1,
  }
}

export function getPresenceFieldProfile(tier: VisualTierLevel): PresenceFieldProfile {
  if (tier === 1) {
    return {
      frameIntervalMs: 83,
      nebulaOctaves: 3,
      ribbonCount: 2,
      ribbonSegments: 28,
      sparkCount: 48,
      speakingBurstCount: 1,
    }
  }

  if (tier === 2) {
    return {
      frameIntervalMs: 34,
      nebulaOctaves: 4,
      ribbonCount: 3,
      ribbonSegments: 50,
      sparkCount: 96,
      speakingBurstCount: 2,
    }
  }

  return {
    frameIntervalMs: null,
    nebulaOctaves: 6,
    ribbonCount: 5,
    ribbonSegments: 80,
    sparkCount: 200,
    speakingBurstCount: 4,
  }
}

export function getCelestialCometProfile(tier: VisualTierLevel): CelestialCometProfile {
  if (tier === 1) {
    return {
      frameIntervalMs: 100,
      lensFlareFrameIntervalMs: 120,
      renderScale: 0.28,
      quality: 0.28,
      showLensFlare: false,
    }
  }

  if (tier === 2) {
    return {
      frameIntervalMs: 50,
      lensFlareFrameIntervalMs: 50,
      renderScale: 0.45,
      quality: 0.6,
      showLensFlare: true,
    }
  }

  return {
    frameIntervalMs: null,
    lensFlareFrameIntervalMs: null,
    renderScale: 0.75,
    quality: 1,
    showLensFlare: true,
  }
}

export function getAuthGateVisualProfile(tier: VisualTierLevel): AuthGateVisualProfile {
  if (tier === 1) {
    return {
      animateSky: false,
      skyFrameIntervalMs: null,
      starsFrameIntervalMs: 120,
      shootingStarCount: 1,
      dustCount: 8,
      satelliteEnabled: false,
      nightFlyerCount: 0,
    }
  }

  if (tier === 2) {
    return {
      animateSky: true,
      skyFrameIntervalMs: 50,
      starsFrameIntervalMs: 50,
      shootingStarCount: 3,
      dustCount: 24,
      satelliteEnabled: true,
      nightFlyerCount: 0,
    }
  }

  return {
    animateSky: true,
    skyFrameIntervalMs: null,
    starsFrameIntervalMs: null,
    shootingStarCount: 6,
    dustCount: 80,
    satelliteEnabled: true,
    nightFlyerCount: 2,
  }
}

export function getRitualThreadProfile(tier: VisualTierLevel): RitualThreadProfile {
  if (tier === 1) {
    return {
      frameIntervalMs: 83,
    }
  }

  if (tier === 2) {
    return {
      frameIntervalMs: 34,
    }
  }

  return {
    frameIntervalMs: null,
  }
}

export function getWaveformProfile(tier: VisualTierLevel): WaveformProfile {
  if (tier === 1) {
    return {
      frameIntervalMs: 50,
      listeningBarCount: 16,
      thinkingParticleCount: 2,
      reflectingSpiralPoints: 36,
      speakingRippleCount: 2,
    }
  }

  if (tier === 2) {
    return {
      frameIntervalMs: 34,
      listeningBarCount: 24,
      thinkingParticleCount: 3,
      reflectingSpiralPoints: 48,
      speakingRippleCount: 3,
    }
  }

  return {
    frameIntervalMs: null,
    listeningBarCount: 32,
    thinkingParticleCount: 4,
    reflectingSpiralPoints: 60,
    speakingRippleCount: 3,
  }
}

export function getRecapOrbitProfile(tier: VisualTierLevel): RecapOrbitProfile {
  if (tier === 1) {
    return {
      auroraFrameIntervalMs: 83,
      poolFrameIntervalMs: 83,
      fogFrameIntervalMs: null,
      fogWispCount: 0,
      allowComets: false,
      allowFog: false,
    }
  }

  if (tier === 2) {
    return {
      auroraFrameIntervalMs: 34,
      poolFrameIntervalMs: 34,
      fogFrameIntervalMs: 50,
      fogWispCount: 14,
      allowComets: true,
      allowFog: true,
    }
  }

  return {
    auroraFrameIntervalMs: null,
    poolFrameIntervalMs: null,
    fogFrameIntervalMs: null,
    fogWispCount: 40,
    allowComets: true,
    allowFog: true,
  }
}