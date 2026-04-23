import { getJournalShaderMemoryLimit, type JournalShaderTier } from './journalPoolShaders'

export interface JournalParticleCounts {
  layer0: number
  layer1: number
  layer2: number
}

export interface JournalRenderProfile {
  maxConstellationEntries: number
  maxShaderMemories: number
  maxComets: number
  frameIntervalMs: number | null
  particleCounts: JournalParticleCounts
}

export function getJournalRenderProfile(tier: JournalShaderTier): JournalRenderProfile {
  if (tier === 1) {
    return {
      maxConstellationEntries: 10,
      maxShaderMemories: getJournalShaderMemoryLimit(1),
      maxComets: 0,
      frameIntervalMs: 83,
      particleCounts: {
        layer0: 0,
        layer1: 0,
        layer2: 0,
      },
    }
  }

  if (tier === 2) {
    return {
      maxConstellationEntries: 20,
      maxShaderMemories: getJournalShaderMemoryLimit(2),
      maxComets: 1,
      frameIntervalMs: 34,
      particleCounts: {
        layer0: 30,
        layer1: 48,
        layer2: 36,
      },
    }
  }

  return {
    maxConstellationEntries: 36,
    maxShaderMemories: getJournalShaderMemoryLimit(3),
    maxComets: 4,
    frameIntervalMs: null,
    particleCounts: {
      layer0: 110,
      layer1: 160,
      layer2: 130,
    },
  }
}