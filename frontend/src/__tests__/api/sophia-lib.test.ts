import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAuthenticatedUserIdMock = vi.fn()
const getUserScopedAuthHeaderMock = vi.fn()

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: (...args: unknown[]) => getAuthenticatedUserIdMock(...args),
  getUserScopedAuthHeader: (...args: unknown[]) => getUserScopedAuthHeaderMock(...args),
}))

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => 'http://gateway.test',
}))

import { fetchSophiaApi, isSyntheticMemoryId, resolveSophiaUserId } from '../../app/api/_lib/sophia'

describe('Sophia API helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthenticatedUserIdMock.mockResolvedValue('user-123')
    getUserScopedAuthHeaderMock.mockResolvedValue('Bearer token-123')
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
  })

  it('resolves the Sophia user id from the authenticated context', async () => {
    await expect(resolveSophiaUserId()).resolves.toBe('user-123')
  })

  it('returns 401 when no user-scoped auth header is available', async () => {
    getUserScopedAuthHeaderMock.mockResolvedValue('')

    const response = await fetchSophiaApi('/api/sophia/user-123/journal', { method: 'GET' })
    const payload = await response.json()

    expect(response.status).toBe(401)
    expect(payload).toEqual({ error: 'Not authenticated' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('forwards authenticated requests to the Sophia gateway', async () => {
    const response = await fetchSophiaApi('/api/sophia/user-123/journal', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(global.fetch).toHaveBeenCalledWith(
      'http://gateway.test/api/sophia/user-123/journal',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    )
    expect(response.status).toBe(200)

    const headers = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-123')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('treats local review-overlay ids as synthetic memories', () => {
    expect(isSyntheticMemoryId('local:abc123')).toBe(true)
    expect(isSyntheticMemoryId('candidate-42')).toBe(true)
    expect(isSyntheticMemoryId('mem_7')).toBe(true)
    expect(isSyntheticMemoryId('16fafbf0-2726-49cd-947e-64b0ae01894d')).toBe(false)
  })
})