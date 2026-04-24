import { describe, expect, it } from 'vitest'

import {
  getAuthGateVisualProfile,
  getCelestialCometProfile,
  getEnhancedFieldBackgroundProfile,
  getPresenceFieldProfile,
  getRecapOrbitProfile,
  getRitualThreadProfile,
  getWaveformProfile,
  shouldSkipTierFrame,
} from '@/app/lib/visual-tier-profiles'

describe('visual tier render profiles', () => {
  it('aggressively trims balanced mode across global ambient scenes', () => {
    expect(getEnhancedFieldBackgroundProfile(2)).toEqual({
      frameIntervalMs: 34,
      particleCount: 84,
      iridescenceMultiplier: 0.35,
      causticsMultiplier: 0,
      auroraMultiplier: 0,
    })

    expect(getPresenceFieldProfile(2)).toEqual({
      frameIntervalMs: 34,
      nebulaOctaves: 4,
      ribbonCount: 3,
      ribbonSegments: 50,
      sparkCount: 96,
      speakingBurstCount: 2,
    })

    expect(getCelestialCometProfile(2)).toEqual({
      frameIntervalMs: 50,
      lensFlareFrameIntervalMs: 50,
      renderScale: 0.45,
      quality: 0.6,
      showLensFlare: true,
    })

    expect(getAuthGateVisualProfile(2)).toEqual({
      animateSky: true,
      skyFrameIntervalMs: 50,
      starsFrameIntervalMs: 50,
      shootingStarCount: 3,
      dustCount: 24,
      satelliteEnabled: true,
      nightFlyerCount: 0,
    })

    expect(getRecapOrbitProfile(2)).toEqual({
      auroraFrameIntervalMs: 34,
      poolFrameIntervalMs: 34,
      fogFrameIntervalMs: 50,
      fogWispCount: 14,
      allowComets: true,
      allowFog: true,
    })

    expect(getRitualThreadProfile(2)).toEqual({
      frameIntervalMs: 34,
    })

    expect(getWaveformProfile(2)).toEqual({
      frameIntervalMs: 34,
      listeningBarCount: 24,
      thinkingParticleCount: 3,
      reflectingSpiralPoints: 48,
      speakingRippleCount: 3,
    })
  })

  it('keeps low mode on the lightest app-wide profile', () => {
    expect(getEnhancedFieldBackgroundProfile(1)).toEqual({
      frameIntervalMs: 83,
      particleCount: 48,
      iridescenceMultiplier: 0,
      causticsMultiplier: 0,
      auroraMultiplier: 0,
    })

    expect(getPresenceFieldProfile(1)).toEqual({
      frameIntervalMs: 83,
      nebulaOctaves: 3,
      ribbonCount: 2,
      ribbonSegments: 28,
      sparkCount: 48,
      speakingBurstCount: 1,
    })

    expect(getCelestialCometProfile(1)).toEqual({
      frameIntervalMs: 100,
      lensFlareFrameIntervalMs: 120,
      renderScale: 0.28,
      quality: 0.28,
      showLensFlare: false,
    })

    expect(getAuthGateVisualProfile(1)).toEqual({
      animateSky: false,
      skyFrameIntervalMs: null,
      starsFrameIntervalMs: 120,
      shootingStarCount: 1,
      dustCount: 8,
      satelliteEnabled: false,
      nightFlyerCount: 0,
    })

    expect(getRecapOrbitProfile(1)).toEqual({
      auroraFrameIntervalMs: 83,
      poolFrameIntervalMs: 83,
      fogFrameIntervalMs: null,
      fogWispCount: 0,
      allowComets: false,
      allowFog: false,
    })

    expect(getRitualThreadProfile(1)).toEqual({
      frameIntervalMs: 83,
    })

    expect(getWaveformProfile(1)).toEqual({
      frameIntervalMs: 50,
      listeningBarCount: 16,
      thinkingParticleCount: 2,
      reflectingSpiralPoints: 36,
      speakingRippleCount: 2,
    })
  })

  it('only skips frames after the first render when a tier interval exists', () => {
    expect(shouldSkipTierFrame(10, 0, 34)).toBe(false)
    expect(shouldSkipTierFrame(20, 10, 34)).toBe(true)
    expect(shouldSkipTierFrame(50, 10, 34)).toBe(false)
    expect(shouldSkipTierFrame(20, 10, null)).toBe(false)
  })
})