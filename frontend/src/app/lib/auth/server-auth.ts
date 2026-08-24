/**
 * Server-side Auth Helpers
 * =========================
 * 
 * Utilities for getting the backend token in API routes.
 * These run on the server side and read from cookies.
 */

import { cookies, headers } from 'next/headers'

import { getSession } from '@/server/better-auth'
import { buildLegacyBackendUser, issueLegacyBackendToken } from '@/server/legacy-backend-auth'
import {
  ordinaryProductAccessAllowed,
  type VoiceLabProductAccess,
} from '@/server/voice-lab/ordinary-route-isolation'

import { debugWarn } from '../debug-logger'
import { logger } from '../error-logger'

import { providerLogin } from './backend-auth'
import { authBypassEnabled, authBypassUserId } from './dev-bypass'

const COOKIE_NAME = 'sophia-backend-token'

async function currentErrorRequest(): Promise<Pick<Request, 'headers'> | undefined> {
  try {
    return { headers: await headers() }
  } catch {
    return undefined
  }
}

function normalizeUserId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed === 'anonymous') {
    return null
  }

  return trimmed
}

async function readUserTokenFromCookie(): Promise<string> {
  try {
    const cookieStore = await cookies()
    return cookieStore.get(COOKIE_NAME)?.value || ''
  } catch {
    return ''
  }
}

function getFallbackServerToken(request?: Pick<Request, 'headers'>): string {
  const fallback = process.env.BACKEND_API_KEY || ''

  if (!fallback) {
    logger.logError(new Error('No backend token available (cookie or BACKEND_API_KEY)'), {
      component: 'Server Auth',
      action: 'get_server_auth_token',
      request,
    })
    return ''
  }

  if (process.env.NODE_ENV !== 'production' && fallback === 'sk_dev_token') {
    debugWarn('Server Auth', 'BACKEND_API_KEY is sk_dev_token placeholder; waiting for route-level bootstrap')
    return ''
  }

  return fallback
}

async function resolveProviderUserId(canonicalUserId: string, requestHeaders: Headers): Promise<string> {
  try {
    const { auth } = await import('../../../server/better-auth/config')
    const accounts = await auth.api.listUserAccounts({ headers: requestHeaders }) as Array<{
      accountId: string
      providerId: string
    }>

    return accounts.find((account) => account.providerId === 'google')?.accountId ?? canonicalUserId
  } catch (error) {
    debugWarn('Server Auth', 'Falling back to canonical user id for backend token hydration', error)
    return canonicalUserId
  }
}

async function tryHydrateUserScopedAuthToken(): Promise<string> {
  try {
    const session = await getSession()
    const canonicalUserId = normalizeUserId(session?.user?.id ?? null)

    if (!canonicalUserId) {
      return ''
    }

    const requestHeaders = await headers()
    const providerUserId = await resolveProviderUserId(canonicalUserId, requestHeaders)

    const backendUser = await providerLogin({
      provider: 'google',
      canonicalUserId,
      providerUserId,
      email: session.user.email || '',
      forwardedCookieHeader: requestHeaders.get('cookie') || undefined,
      username: session.user.name || undefined,
    })

    if (!backendUser?.api_token) {
      logger.logError(new Error('No backend token returned during user-scoped auth hydration'), {
        component: 'Server Auth',
        action: 'hydrate_user_scoped_auth_token',
        request: { headers: requestHeaders },
      })
      return ''
    }

    const cookieStore = await cookies()
    cookieStore.set(COOKIE_NAME, backendUser.api_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    })

    return backendUser.api_token
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      debugWarn('Server Auth', 'Legacy backend auth bridge unavailable while hydrating user-scoped token')
      return ''
    }

    logger.logError(error instanceof Error ? error : new Error('Backend token hydration failed'), {
      component: 'Server Auth',
      action: 'hydrate_user_scoped_auth_token',
      request: await currentErrorRequest(),
    })
    return ''
  }
}

function issueBypassBackendToken(request?: Pick<Request, 'headers'>): string {
  const bypassUserId = normalizeUserId(authBypassUserId)

  if (!bypassUserId) {
    logger.logError(new Error('Auth bypass enabled without a valid bypass user id'), {
      component: 'Server Auth',
      action: 'issue_bypass_backend_token',
      request,
    })
    return ''
  }

  try {
    return issueLegacyBackendToken(
      buildLegacyBackendUser({
        id: bypassUserId,
        email: '',
        username: bypassUserId,
      }),
    )
  } catch (error) {
    logger.logError(error instanceof Error ? error : new Error('Failed to issue bypass backend token'), {
      component: 'Server Auth',
      action: 'issue_bypass_backend_token',
      request,
    })
    return ''
  }
}

export async function getAuthenticatedUserId(options?: VoiceLabProductAccess): Promise<string | null> {
  if (authBypassEnabled) {
    const userId = normalizeUserId(authBypassUserId)
    return await ordinaryProductAccessAllowed(options, userId) ? userId : null
  }

  try {
    const session = await getSession()
    const userId = normalizeUserId(session?.user?.id ?? null)
    return await ordinaryProductAccessAllowed(options, userId) ? userId : null
  } catch {
    return null
  }
}

export async function getUserScopedAuthToken(options?: VoiceLabProductAccess): Promise<string> {
  if (!(await ordinaryProductAccessAllowed(options))) {
    return ''
  }
  const userToken = await readUserTokenFromCookie()
  if (userToken) {
    return userToken
  }

  if (authBypassEnabled) {
    const request = await currentErrorRequest()
    return getFallbackServerToken(request) || issueBypassBackendToken(request)
  }

  const hydratedToken = await tryHydrateUserScopedAuthToken()
  if (hydratedToken) {
    return hydratedToken
  }

  logger.logError(new Error('No user-scoped backend token available'), {
    component: 'Server Auth',
    action: 'get_user_scoped_auth_token',
    request: await currentErrorRequest(),
  })
  return ''
}

export async function refreshUserScopedAuthToken(options?: VoiceLabProductAccess): Promise<string> {
  if (!(await ordinaryProductAccessAllowed(options))) {
    return ''
  }
  if (authBypassEnabled) {
    const request = await currentErrorRequest()
    return getFallbackServerToken(request) || issueBypassBackendToken(request)
  }

  return tryHydrateUserScopedAuthToken()
}

export async function getUserScopedAuthHeader(options?: VoiceLabProductAccess): Promise<string> {
  const token = await getUserScopedAuthToken(options)
  return token ? `Bearer ${token}` : ''
}

export async function refreshUserScopedAuthHeader(options?: VoiceLabProductAccess): Promise<string> {
  const token = await refreshUserScopedAuthToken(options)
  return token ? `Bearer ${token}` : ''
}

/**
 * Get the backend API token for server-side API calls.
 * Priority:
 * 1. User's token from cookie (if authenticated)
 * 2. Server-side BACKEND_API_KEY environment variable
 * 3. Fallback to 'dev-key' for development
 * 
 * @returns The API token to use for backend calls
 */
export async function getServerAuthToken(options?: VoiceLabProductAccess): Promise<string> {
  if (!(await ordinaryProductAccessAllowed(options))) {
    return ''
  }
  const userToken = await readUserTokenFromCookie()
  if (userToken) {
    return userToken
  }

  if (authBypassEnabled) {
    const request = await currentErrorRequest()
    return getFallbackServerToken(request) || issueBypassBackendToken(request)
  }

  return getFallbackServerToken(await currentErrorRequest())
}

/**
 * Get authorization header for backend API calls.
 * 
 * @returns Authorization header value with Bearer prefix
 */
export async function getServerAuthHeader(options?: VoiceLabProductAccess): Promise<string> {
  const token = await getServerAuthToken(options)
  return token ? `Bearer ${token}` : ''
}

/**
 * Check if user has a valid backend token.
 * 
 * @returns true if user has a backend token in cookies
 */
export async function hasUserToken(): Promise<boolean> {
  return !!(await readUserTokenFromCookie())
}
