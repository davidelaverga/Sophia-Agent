import type { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchSophiaApiMock = vi.fn()
const resolveSophiaUserIdMock = vi.fn()

vi.mock('../../app/api/_lib/sophia', () => ({
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
}))

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: vi.fn(),
  },
}))

import { GET } from '../../app/api/journal/route'

describe('/api/journal GET', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveSophiaUserIdMock.mockResolvedValue('user-123')
  })

  it('forwards journal pagination and quality-of-life filters to the Sophia gateway', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({
        entries: [
          {
            id: 'memory-1',
            content: 'Favorite memory',
            metadata: { status: 'approved', favorite: true },
            created_at: '2026-06-17T12:00:00.000Z',
          },
        ],
        count: 1,
        total_count: 12,
        limit: 50,
        offset: 50,
        next_offset: 100,
        has_more: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const request = {
      nextUrl: new URL('http://localhost:3000/api/journal?favorite=true&limit=50&offset=50&search=focus'),
    } as unknown as NextRequest

    const response = await GET(request)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/journal?search=focus&saved_only=true&favorite=true&limit=50&offset=50',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(payload).toMatchObject({
      count: 1,
      total_count: 12,
      totalCount: 12,
      next_offset: 100,
      nextOffset: 100,
      has_more: true,
      hasMore: true,
    })
  })

  it('keeps the empty state honest when favorite filtering removes all entries', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({
        entries: [
          {
            id: 'memory-1',
            content: 'Regular memory',
            metadata: { status: 'approved' },
          },
        ],
        count: 1,
        total_count: 1,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const request = {
      nextUrl: new URL('http://localhost:3000/api/journal?favorite=true'),
    } as unknown as NextRequest

    const response = await GET(request)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.entries).toEqual([])
    expect(payload.count).toBe(0)
  })
})
