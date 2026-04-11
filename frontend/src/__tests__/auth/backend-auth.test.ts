import { beforeEach, describe, expect, it, vi } from 'vitest'

const headersMock = vi.fn()

vi.mock('next/headers', () => ({
  headers: (...args: unknown[]) => headersMock(...args),
}))

import { getCurrentUser, providerLogin, refreshToken, validateToken } from '../../app/lib/auth/backend-auth'

describe('backend-auth bridge resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SOPHIA_AUTH_BACKEND_URL
    delete process.env.NEXT_PUBLIC_SOPHIA_AUTH_BACKEND_URL
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.BACKEND_API_URL
    delete process.env.NEXT_PUBLIC_API_URL

    headersMock.mockResolvedValue(new Headers({ host: 'localhost:3000' }))
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'user-1',
        email: 'user@example.com',
        username: 'User',
        discord_id: null,
        is_active: true,
        api_token: 'token-123',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch
  })

  it('uses the current request origin for provider login when no explicit auth bridge URL is configured', async () => {
    await providerLogin({
      provider: 'google',
      providerUserId: 'google-account-123',
      canonicalUserId: 'session-user-1',
      email: 'user@example.com',
    })

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/auth/discord/login',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('prefers an explicit Sophia auth backend URL override when configured', async () => {
    process.env.SOPHIA_AUTH_BACKEND_URL = 'http://127.0.0.1:3550'

    await validateToken('token-123')

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3550/api/v1/auth/validate',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('uses forwarded host and protocol when present', async () => {
    headersMock.mockResolvedValue(new Headers({
      'x-forwarded-host': 'sophia.example.com',
      'x-forwarded-proto': 'https',
    }))

    await getCurrentUser('token-123')

    expect(global.fetch).toHaveBeenCalledWith(
      'https://sophia.example.com/api/v1/auth/me',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('falls back to localhost:3000 when request headers are unavailable', async () => {
    headersMock.mockRejectedValue(new Error('outside request context'))

    await refreshToken('token-123')

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/auth/token/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})