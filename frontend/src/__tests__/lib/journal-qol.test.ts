import { describe, expect, it } from 'vitest'

import {
  buildJournalFavoriteMetadata,
  isFavoriteJournalEntry,
  type JournalEntry,
} from '../../app/lib/journal'

function entry(metadata: JournalEntry['metadata']): JournalEntry {
  return {
    id: 'memory-1',
    content: 'A remembered detail.',
    category: 'fact',
    metadata,
    created_at: '2026-06-17T12:00:00.000Z',
  }
}

describe('journal quality-of-life helpers', () => {
  it('recognizes current and legacy favorite metadata shapes', () => {
    expect(isFavoriteJournalEntry(entry({ favorite: true }))).toBe(true)
    expect(isFavoriteJournalEntry(entry({ is_favorite: true }))).toBe(true)
    expect(isFavoriteJournalEntry(entry({ isFavorite: true }))).toBe(true)
    expect(isFavoriteJournalEntry(entry({ favorite: false }))).toBe(false)
    expect(isFavoriteJournalEntry(entry(null))).toBe(false)
  })

  it('builds favorite metadata without dropping existing memory metadata', () => {
    const nextMetadata = buildJournalFavoriteMetadata(
      entry({ status: 'approved', category: 'lesson' }),
      true,
    )

    expect(nextMetadata).toEqual({
      status: 'approved',
      category: 'lesson',
      favorite: true,
    })
  })
})
