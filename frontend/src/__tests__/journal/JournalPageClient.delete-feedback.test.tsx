import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/journal',
  useSearchParams: () => new URLSearchParams('highlight=mem-1'),
  useParams: () => ({}),
}))

import { JournalPageClient } from '@/app/journal/JournalPageClient'

const originalGetContext = HTMLCanvasElement.prototype.getContext

const { showToastMock, hapticMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
  hapticMock: vi.fn(),
}))

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

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

describe('JournalPageClient delete feedback', () => {
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

  it('shows a success toast after deleting a memory from the pool view', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()

      if (url === '/api/journal') {
        return new Response(JSON.stringify({
          entries: [
            {
              id: 'mem-1',
              content: 'I feel calmer after the walk and want to keep that rhythm going.',
              category: 'feeling',
              metadata: { importance: 'potential' },
              created_at: '2026-04-20T10:00:00.000Z',
            },
          ],
          count: 1,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url === '/api/memories/mem-1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
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

    expect(screen.queryByText('Loading journal')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }))

    await flushAsyncWork()

    expect(fetchMock).toHaveBeenCalledWith('/api/memories/mem-1', {
      method: 'DELETE',
    })

    expect(showToastMock).toHaveBeenCalledWith({
      message: 'Deleted "I feel calmer after the walk and want to kee...".',
      variant: 'success',
      durationMs: 3200,
    })
    expect(hapticMock).toHaveBeenCalledWith('success')

    expect(screen.getByText('No saved memories yet')).toBeInTheDocument()
  })
})