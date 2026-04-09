/**
 * Server-side Auth Helpers
 * =========================
 * 
 * Utilities for getting the backend token in API routes.
 * These run on the server side and read from cookies.
 */

import { cookies } from 'next/headers'

import { getSession } from '@/server/better-auth'

import { debugWarn } from '../debug-logger'
import { logger } from '../error-logger'

import { authBypassEnabled, authBypassUserId } from './dev-bypass'

const COOKIE_NAME = 'sophia-backend-token'
const DEV_BYPASS_BACKEND_TOKEN = 'dev-bypass-token'

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

function getFallbackServerToken(): string {
  const fallback = process.env.BACKEND_API_KEY || ''

  if (!fallback) {
    logger.logError(new Error('No backend token available (cookie or BACKEND_API_KEY)'), {
      component: 'Server Auth',
      action: 'get_server_auth_token',
    })
    return ''
  }

  if (process.env.NODE_ENV !== 'production' && fallback === 'sk_dev_token') {
    debugWarn('Server Auth', 'BACKEND_API_KEY is sk_dev_token placeholder; waiting for route-level bootstrap')
    return ''
  }

  return fallback
}

export async function getAuthenticatedUserId(): Promise<string | null> {
  if (authBypassEnabled) {
    return normalizeUserId(authBypassUserId)
  }

  try {
    const session = await getSession()
    return normalizeUserId(session?.user?.id ?? null)
  } catch {
    return null
  }
}

export async function getUserScopedAuthToken(): Promise<string> {
  const userToken = await readUserTokenFromCookie()
  if (userToken) {
    return userToken
  }

  if (authBypassEnabled) {
    return getFallbackServerToken() || DEV_BYPASS_BACKEND_TOKEN
  }

  logger.logError(new Error('No user-scoped backend token available'), {
    component: 'Server Auth',
    action: 'get_user_scoped_auth_token',
  })
  return ''
}

export async function getUserScopedAuthHeader(): Promise<string> {
  const token = await getUserScopedAuthToken()
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
export async function getServerAuthToken(): Promise<string> {
  const userToken = await readUserTokenFromCookie()
  if (userToken) {
    return userToken
  }

  if (authBypassEnabled) {
    return getFallbackServerToken() || DEV_BYPASS_BACKEND_TOKEN
  }

  return getFallbackServerToken()
}

/**
 * Get authorization header for backend API calls.
 * 
 * @returns Authorization header value with Bearer prefix
 */
export async function getServerAuthHeader(): Promise<string> {
  const token = await getServerAuthToken()
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
