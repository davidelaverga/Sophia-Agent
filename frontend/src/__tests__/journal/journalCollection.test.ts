import { describe, expect, it } from 'vitest'

import { buildConstellationEntries, isFavoriteMetadata } from '@/app/journal/journalCollection'
import { isJournalFavorite } from '@/app/lib/journal'

describe('journalCollection helpers', () => {
  it('detects favorite metadata consistently', () => {
    expect(isFavoriteMetadata({ favorite: true })).toBe(true)
    expect(isFavoriteMetadata({ favorite: false })).toBe(false)
    expect(isFavoriteMetadata(null)).toBe(false)
    expect(isJournalFavorite({ metadata: { favorite: true } })).toBe(true)
    expect(isJournalFavorite({ metadata: { favorite: 'yes' } })).toBe(false)
  })

  it('keeps selected, highlighted, and favorite memories in the constellation', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      id: `mem-${index}`,
      metadata: index === 0 || index === 4 ? { favorite: true } : null,
    }))

    const result = buildConstellationEntries(entries, {
      maxCount: 4,
      selectedId: 'mem-10',
      highlightIds: new Set(['mem-2']),
    })

    expect(result).toHaveLength(4)
    expect(result.map((entry) => entry.id)).toEqual(expect.arrayContaining(['mem-10', 'mem-2', 'mem-0']))
  })

  it('samples evenly across large collections once priority entries are placed', () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ id: `mem-${index}`, metadata: null }))

    const result = buildConstellationEntries(entries, { maxCount: 4 })

    expect(result.map((entry) => entry.id)).toEqual(['mem-0', 'mem-25', 'mem-50', 'mem-75'])
  })
})
