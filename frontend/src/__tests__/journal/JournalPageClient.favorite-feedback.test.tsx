import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JournalPageClient } from '@/app/journal/JournalPageClient'

const originalGetContext = HTMLCanvasElement.prototype.getContext

const { showToastMock, hapticMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
  hapticMock: vi.fn(),
}))

vi.mock('@/app/stores/ui-store', () => ({
  useUiStore: (selector: (state: { showToast: typeof showToastMock }) => unknown) => selector({ showToast: showToastMock }),
}))

vi.mock('@/app/hooks/useHaptics', () => ({
  haptic: hapticMock,
}))

vi.mock('@/app/hooks/useVisualTier', () => ({
  useVisualTier: () => ({
    tier: 1,
    autoDegraded: false,
    preference: 'low',
    reducedFidelity: true,
    reducedMotion: true,
    dprCap: 1,
    setPreference: vi.fn(),
  }),
}))

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('JournalPageClient favorite feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    showToastMock.mockReset()
    hapticMock.mockReset()
    window.sessionStorage.clear()
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.skip('persists a favorite toggle and confirms it to the user', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()

      if (url === '/api/journal') {
        return new Response(JSON.stringify({
          entries: [
            {
              id: 'mem-1',
              content: 'I focus better when the next step is said out loud first.',
              category: 'preference',
              metadata: { importance: 'structural' },
              created_at: '2026-04-20T10:00:00.000Z',
            },
          ],
          count: 1,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url === '/api/memories/mem-1' && init?.method === 'PUT') {
        return new Response(JSON.stringify({
          id: 'mem-1',
          metadata: { importance: 'structural', favorite: true },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<JournalPageClient />)

    expect(fetchMock).toHaveBeenCalledWith('/api/journal', expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
    }))

    await flushAsyncWork()

    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    fireEvent.click(screen.getByRole('button', { name: /I focus better when the next step is said out loud first\./i }))
    fireEvent.click(screen.getByRole('button', { name: 'Pool view' }))

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }))

    await flushAsyncWork()

    expect(fetchMock).toHaveBeenCalledWith('/api/memories/mem-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          importance: 'structural',
          favorite: true,
        },
      }),
    })

    expect(showToastMock).toHaveBeenCalledWith({
      message: 'Added to favorites.',
      variant: 'success',
      durationMs: 2400,
    })
    expect(hapticMock).toHaveBeenCalledWith('success')
    expect(screen.getAllByText('Favorite').length).toBeGreaterThan(0)
  })
})