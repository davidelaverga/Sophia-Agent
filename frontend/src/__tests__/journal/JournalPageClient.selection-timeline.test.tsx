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

describe('JournalPageClient selection and timeline behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'))
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

  it('stays unselected until a memory is chosen and lets the detail panel close cleanly', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<JournalPageClient />)
    await flushAsyncWork()

    expect(screen.queryByRole('button', { name: 'Favorite' })).not.toBeInTheDocument()
    expect(screen.getByText('Click a memory to explore')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go home' })).toBeInTheDocument()
  })

  it('bounds the timeline to the real memory span', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<JournalPageClient />)
    await flushAsyncWork()

    expect(screen.getByRole('button', { name: 'Apr' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mar' })).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Journal timeline' })).toHaveAttribute('max', '0')
  })

  it('starts the timeline at today when journal data loads after mount', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()

      if (url === '/api/journal') {
        return new Response(JSON.stringify({
          entries: [
            {
              id: 'mem-old',
              content: 'February should not become the initial timeline position.',
              category: 'decision',
              metadata: { importance: 'structural' },
              created_at: '2026-02-15T10:00:00.000Z',
            },
          ],
          count: 1,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(<JournalPageClient />)
    await flushAsyncWork()

    const slider = screen.getByRole('slider', { name: 'Journal timeline' })
    expect(slider).toHaveAttribute('value', slider.getAttribute('max'))
    expect(container.querySelector('[class*="timelineDate"] span')?.textContent).toBe('Today')
  })

  it('hides newer memories when scrubbing back before them', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()

      if (url === '/api/journal') {
        return new Response(JSON.stringify({
          entries: [
            {
              id: 'mem-feb',
              content: 'I want to keep February decisions visible.',
              category: 'decision',
              metadata: { importance: 'structural' },
              created_at: '2026-02-15T10:00:00.000Z',
            },
            {
              id: 'mem-apr',
              content: 'April is lighter when I start slower.',
              category: 'feeling',
              metadata: { importance: 'potential' },
              created_at: '2026-04-12T10:00:00.000Z',
            },
          ],
          count: 2,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(<JournalPageClient />)
    await flushAsyncWork()

    const slider = screen.getByRole('slider', { name: 'Journal timeline' })
    fireEvent.change(slider, { target: { value: slider.getAttribute('max') ?? '0' } })
    await flushAsyncWork()

    expect(container.querySelector('[class*="filterMeta"]')?.textContent).toBe('2 memories')

    fireEvent.click(screen.getByRole('button', { name: 'Mar' }))
    await flushAsyncWork()

    expect(container.querySelector('[class*="filterMeta"]')?.textContent).toBe('1 memory')
    expect(screen.queryByText('anchored to nearest memories')).not.toBeInTheDocument()
  })

  it('keeps the journal shell visible when a filter leaves the pool empty', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<JournalPageClient />)
    await flushAsyncWork()

    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }))

    expect(screen.queryByText('No favorites in this view')).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Journal timeline' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument()
  })
})