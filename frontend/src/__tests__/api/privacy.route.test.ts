import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAuthenticatedUserIdMock = vi.fn()
const getUserScopedAuthTokenMock = vi.fn()

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: (...args: unknown[]) => getAuthenticatedUserIdMock(...args),
  getUserScopedAuthToken: (...args: unknown[]) => getUserScopedAuthTokenMock(...args),
}))

import { POST as postConsent } from '../../app/api/privacy/consent/route'
import { DELETE as deletePrivacy } from '../../app/api/privacy/delete/route'
import { GET as exportPrivacy } from '../../app/api/privacy/export/route'

describe('privacy routes auth hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BACKEND_API_URL = 'http://backend.test'
    getAuthenticatedUserIdMock.mockResolvedValue('user-123')
    getUserScopedAuthTokenMock.mockResolvedValue('token-123')
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
  })

  it('rejects export when the user is not authenticated', async () => {
    getAuthenticatedUserIdMock.mockResolvedValue(null)

    const response = await exportPrivacy(new Request('http://localhost:3000/api/privacy/export') as never)

    expect(response.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('uses the authenticated user and user-scoped token for export', async () => {
    await exportPrivacy(new Request('http://localhost:3000/api/privacy/export') as never)

    expect(global.fetch).toHaveBeenCalledWith(
      'http://backend.test/mem0/user-123/memories',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
      }),
    )
  })

  it('rejects delete when the user-scoped token is missing', async () => {
    getUserScopedAuthTokenMock.mockResolvedValue('')

    const response = await deletePrivacy(new Request('http://localhost:3000/api/privacy/delete', { method: 'DELETE' }) as never)

    expect(response.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('uses the user-scoped token for consent submission', async () => {
    await postConsent(new Request('http://localhost:3000/api/privacy/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    }) as never)

    expect(global.fetch).toHaveBeenCalledWith(
      'http://backend.test/api/privacy/consent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
      }),
    )
  })
})