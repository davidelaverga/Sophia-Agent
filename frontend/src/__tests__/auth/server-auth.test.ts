import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookiesMock = vi.fn()
const getSessionMock = vi.fn()
const logErrorMock = vi.fn()
const debugWarnMock = vi.fn()

let authBypassEnabledMock = false
let authBypassUserIdMock = 'dev-user'

vi.mock('next/headers', () => ({
  cookies: (...args: unknown[]) => cookiesMock(...args),
}))

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  get authBypassEnabled() {
    return authBypassEnabledMock
  },
  get authBypassUserId() {
    return authBypassUserIdMock
  },
}))

vi.mock('../../server/better-auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}))

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: (...args: unknown[]) => logErrorMock(...args),
  },
}))

vi.mock('../../app/lib/debug-logger', () => ({
  debugWarn: (...args: unknown[]) => debugWarnMock(...args),
}))

import {
  getAuthenticatedUserId,
  getServerAuthToken,
  getUserScopedAuthToken,
  hasUserToken,
} from '../../app/lib/auth/server-auth'

describe('server-auth helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authBypassEnabledMock = false
    authBypassUserIdMock = 'dev-user'
    cookiesMock.mockResolvedValue({
      get: vi.fn(() => undefined),
    })
    getSessionMock.mockResolvedValue({
      user: {
        id: 'session-user-123',
      },
    })
    process.env.BACKEND_API_KEY = 'server-fallback-token'
  })

  it('resolves the authenticated user from the Better Auth session when bypass is disabled', async () => {
    await expect(getAuthenticatedUserId()).resolves.toBe('session-user-123')
  })

  it('uses the bypass user id when auth bypass is enabled', async () => {
    authBypassEnabledMock = true
    authBypassUserIdMock = 'bypass-user-9'

    await expect(getAuthenticatedUserId()).resolves.toBe('bypass-user-9')
    expect(getSessionMock).not.toHaveBeenCalled()
  })

  it('does not fall back to BACKEND_API_KEY for user-scoped auth when bypass is disabled', async () => {
    await expect(getUserScopedAuthToken()).resolves.toBe('')
    expect(logErrorMock).toHaveBeenCalled()
  })

  it('allows the backend fallback token for user-scoped auth only in bypass mode', async () => {
    authBypassEnabledMock = true

    await expect(getUserScopedAuthToken()).resolves.toBe('server-fallback-token')
  })

  it('uses a synthetic dev token in bypass mode when no backend fallback token is configured', async () => {
    authBypassEnabledMock = true
    process.env.BACKEND_API_KEY = ''

    await expect(getUserScopedAuthToken()).resolves.toBe('dev-bypass-token')
    await expect(getServerAuthToken()).resolves.toBe('dev-bypass-token')
  })

  it('prefers the cookie token for general server auth', async () => {
    cookiesMock.mockResolvedValue({
      get: vi.fn((name: string) => (name === 'sophia-backend-token' ? { value: 'cookie-token-123' } : undefined)),
    })

    await expect(getServerAuthToken()).resolves.toBe('cookie-token-123')
    await expect(hasUserToken()).resolves.toBe(true)
  })
})