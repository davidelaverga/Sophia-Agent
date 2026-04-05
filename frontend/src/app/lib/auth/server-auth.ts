/**
 * Server-side Auth Helpers
 * =========================
 * 
 * Utilities for getting the backend token in API routes.
 * These run on the server side and read from cookies.
 */

import { cookies } from 'next/headers'
import { debugWarn } from '../debug-logger'
import { logger } from '../error-logger'

const COOKIE_NAME = 'sophia-backend-token'

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
  // Try to get user token from cookie
  try {
    const cookieStore = await cookies()
    const userToken = cookieStore.get(COOKIE_NAME)?.value
    
    if (userToken) {
      return userToken
    }
  } catch {
    // cookies() might fail outside of request context
  }
  
  // Fallback to server API key (never use NEXT_PUBLIC_ for server auth — it's in the client bundle)
  const fallback = process.env.BACKEND_API_KEY || ''
  // 🔒 SECURITY: Do not log tokens, even partially
  if (!fallback) {
    logger.logError(new Error('No backend token available (cookie or BACKEND_API_KEY)'), {
      component: 'Server Auth',
      action: 'get_server_auth_token',
    })
    return ''
  }

  // Development placeholder must NOT be sent to backend endpoints that require real tokens.
  // Dev routes (e.g. /api/chat) handle bootstrap to a real token when needed.
  if (process.env.NODE_ENV !== 'production' && fallback === 'sk_dev_token') {
    debugWarn('Server Auth', 'BACKEND_API_KEY is sk_dev_token placeholder; waiting for route-level bootstrap')
    return ''
  }
  return fallback
}

/**
 * Get authorization header for backend API calls.
 * 
 * @returns Authorization header value with Bearer prefix
 */
export async function getServerAuthHeader(): Promise<string> {
  return `Bearer ${await getServerAuthToken()}`
}

/**
 * Check if user has a valid backend token.
 * 
 * @returns true if user has a backend token in cookies
 */
export async function hasUserToken(): Promise<boolean> {
  try {
    const cookieStore = await cookies()
    return !!cookieStore.get(COOKIE_NAME)?.value
  } catch {
    return false
  }
}
