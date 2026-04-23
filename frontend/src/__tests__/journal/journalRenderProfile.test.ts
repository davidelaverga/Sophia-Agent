import { describe, expect, it } from 'vitest'

import { getJournalPoolFragmentShaderSource, getJournalShaderMemoryLimit } from '@/app/journal/journalPoolShaders'
import { getJournalRenderProfile } from '@/app/journal/journalRenderProfile'

describe('journal render profiles', () => {
  it('aggressively trims balanced mode without collapsing the scene', () => {
    expect(getJournalRenderProfile(2)).toEqual({
      maxConstellationEntries: 20,
      maxShaderMemories: 10,
      maxComets: 1,
      frameIntervalMs: 34,
      particleCounts: {
        layer0: 30,
        layer1: 48,
        layer2: 36,
      },
    })
  })

  it('keeps low mode on the lightest journal profile', () => {
    expect(getJournalRenderProfile(1)).toEqual({
      maxConstellationEntries: 10,
      maxShaderMemories: 6,
      maxComets: 0,
      frameIntervalMs: 83,
      particleCounts: {
        layer0: 0,
        layer1: 0,
        layer2: 0,
      },
    })
  })

  it('builds reduced shader variants for balanced and low tiers', () => {
    expect(getJournalShaderMemoryLimit(1)).toBe(6)
    expect(getJournalShaderMemoryLimit(2)).toBe(10)
    expect(getJournalShaderMemoryLimit(3)).toBe(16)

    const lowSource = getJournalPoolFragmentShaderSource(1)
    const balancedSource = getJournalPoolFragmentShaderSource(2)
    const fullSource = getJournalPoolFragmentShaderSource(3)

    expect(lowSource).toContain('#define SHADER_MEMORY_COUNT 6')
    expect(lowSource).toContain('#define ENABLE_AURORA 0')
    expect(balancedSource).toContain('#define SHADER_MEMORY_COUNT 10')
    expect(balancedSource).toContain('#define ENABLE_AURORA 0')
    expect(fullSource).toContain('#define SHADER_MEMORY_COUNT 16')
    expect(fullSource).toContain('#define ENABLE_AURORA 1')
  })
})