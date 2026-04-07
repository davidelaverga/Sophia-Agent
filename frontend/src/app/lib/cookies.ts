/**
 * Cookie Utilities
 * =================
 * 
 * Centralized cookie management functions.
 * Replaces duplicated implementations across hooks and components.
 */

/**
 * Read a cookie value by name
 * @param name Cookie name
 * @returns Cookie value or null if not found
 */
export function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  
  const value = `; ${document.cookie}`
  const parts = value.split(`; ${name}=`)
  if (parts.length === 2) {
    return parts.pop()?.split(';').shift() || null
  }
  return null
}

/**
 * Set a cookie with optional configuration
 * @param name Cookie name
 * @param value Cookie value
 * @param options Cookie options
 */
export function setCookie(
  name: string, 
  value: string, 
  options: {
    maxAge?: number // seconds
    expires?: Date
    path?: string
    domain?: string
    secure?: boolean
    sameSite?: 'strict' | 'lax' | 'none'
  } = {}
): void {
  if (typeof document === 'undefined') return
  
  let cookieString = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
  
  if (options.maxAge !== undefined) {
    cookieString += `; max-age=${options.maxAge}`
  }
  
  if (options.expires) {
    cookieString += `; expires=${options.expires.toUTCString()}`
  }
  
  cookieString += `; path=${options.path || '/'}`
  
  if (options.domain) {
    cookieString += `; domain=${options.domain}`
  }
  
  if (options.secure) {
    cookieString += '; secure'
  }
  
  if (options.sameSite) {
    cookieString += `; samesite=${options.sameSite}`
  }
  
  document.cookie = cookieString
}

/**
 * Delete a cookie by name
 * @param name Cookie name
 * @param path Cookie path (defaults to '/')
 */
export function deleteCookie(name: string, path: string = '/'): void {
  if (typeof document === 'undefined') return
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path};`
}

/**
 * Check if a cookie exists
 * @param name Cookie name
 * @returns true if cookie exists
 */
export function hasCookie(name: string): boolean {
  return getCookie(name) !== null
}

// Common cookie names used across the app
export const COOKIE_NAMES = {
  BACKEND_TOKEN: 'sophia-backend-token',
  LOCALE: 'NEXT_LOCALE',
  LOCALE_MANUAL: 'LOCALE_MANUAL',
} as const
