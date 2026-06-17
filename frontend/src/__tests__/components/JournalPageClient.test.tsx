import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { JournalPageClient } from '../../app/journal/JournalPageClient'
import type { JournalEntry } from '../../app/lib/journal'

function makeEntries(count: number): JournalEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory-${index + 1}`,
    content: `Saved Sophia memory ${index + 1}`,
    category: index % 2 === 0 ? 'fact' : 'lesson',
    metadata: {
      status: 'approved',
      ...(index === 0 ? { favorite: true } : {}),
    },
    created_at: new Date(Date.UTC(2026, 5, 17, 12, 0, 0) - index * 60_000).toISOString(),
  }))
}

describe('JournalPageClient quality-of-life controls', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const entries = makeEntries(55)
    vi.mocked(fetch).mockImplementation((input) => {
      const url = new URL(String(input), 'http://localhost:3000')
      const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10)
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10)
      const search = url.searchParams.get('search')?.toLowerCase() || ''
      const filteredEntries = search
        ? entries.filter((entry) => entry.content.toLowerCase().includes(search))
        : entries
      const page = filteredEntries.slice(offset, offset + limit)
      const nextOffset = offset + page.length

      return Promise.resolve(
        new Response(JSON.stringify({
          entries: page,
          count: page.length,
          total_count: filteredEntries.length,
          limit,
          offset,
          next_offset: nextOffset < filteredEntries.length ? nextOffset : null,
          has_more: nextOffset < filteredEntries.length,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
  })

  it('shows explicit navigation, favorites, and progressive loading controls', async () => {
    render(<JournalPageClient />)

    expect(await screen.findByRole('button', { name: 'Back to previous page' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go home' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Favorites (1)' })).toBeInTheDocument()
    expect(screen.getByText('50 memories of 55')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more memories' }))

    await waitFor(() => {
      expect(screen.getByText('55 memories')).toBeInTheDocument()
    })
    expect(fetch).toHaveBeenCalledWith('/api/journal?limit=50&offset=50', expect.objectContaining({ method: 'GET' }))
    expect(screen.queryByRole('button', { name: 'Load more memories' })).not.toBeInTheDocument()
  })

  it('separates filtered-empty state from the empty journal state', async () => {
    render(<JournalPageClient />)

    fireEvent.change(await screen.findByPlaceholderText('Search memories...'), {
      target: { value: 'no matching memory text' },
    })

    expect(await screen.findByText('No memories match this view')).toBeInTheDocument()
    expect(screen.queryByText('No saved memories yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument()
  })
})
