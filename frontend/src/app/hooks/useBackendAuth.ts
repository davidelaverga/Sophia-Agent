/**
 * useBackendAuth Hook
 * ====================
 * 
 * React hook to manage backend authentication.
 * Syncs the backend token from cookie to Zustand store
 * and provides token validation.
 * 
 * Usage:
 * ```tsx
 * const { token, isReady, isAuthenticated } = useBackendAuth()
 * ```
 */

"use client"

import { useEffect, useCallback } from 'react'
import { useAuthTokenStore, needsTokenValidation } from '../stores/auth-token-store'

/**
 * Note: With httpOnly cookies, the cookie is no longer readable from JS.
 * The Zustand store is seeded during auth callback and persisted in localStorage.
 * For actual API calls, all proxy routes read the httpOnly cookie server-side.
 * The store token is used only for UI state (isAuthenticated checks).
 */

export interface BackendAuthState {
  /** The current API token, or null if not authenticated */
  token: string | null
  /** Whether the auth state has been initialized */
  isReady: boolean
  /** Whether the user is authenticated with the backend */
  isAuthenticated: boolean
  /** Whether token validation is in progress */
  isValidating: boolean
  /** Force token validation */
  validateNow: () => Promise<boolean>
  /** Clear authentication (sign out) */
  clearAuth: () => void
}

/**
 * Hook to manage backend authentication state.
 * 
 * On mount:
 * 1. Checks for token in cookie (set by auth callback)
 * 2. Syncs cookie token to Zustand store
 * 3. Validates token with backend if needed
 * 
 * @returns BackendAuthState object
 */
export function useBackendAuth(): BackendAuthState {
  const token = useAuthTokenStore(state => state.token)
  const _user = useAuthTokenStore(state => state.user)
  const isValidating = useAuthTokenStore(state => state.isValidating)
  const setToken = useAuthTokenStore(state => state.setToken)
  const clearToken = useAuthTokenStore(state => state.clearToken)
  const setValidating = useAuthTokenStore(state => state.setValidating)
  const setLastValidated = useAuthTokenStore(state => state.setLastValidated)
  
  // Check if we need to validate
  const needsValidation = useAuthTokenStore(needsTokenValidation)
  
  // Seed auth status from server when store is empty
  // (httpOnly cookie can't be read from JS, so we ask the server)
  useEffect(() => {
    if (token) return; // Already have token in store
    
    const checkServerAuth = async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated && data.user) {
            // Store a marker token so isAuthenticated is true
            // The actual token is in the httpOnly cookie, read only by server
            setToken('httponly-session-active', data.user);
          }
        }
      } catch {
        // Network error — don't clear existing state
      }
    };
    
    checkServerAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run on mount
  
  // Validate token via /api/auth/me when needed
  useEffect(() => {
    if (!token || isValidating || !needsValidation) return
    
    const validate = async () => {
      setValidating(true)
      try {
        const res = await fetch('/api/auth/me')
        if (res.ok) {
          const data = await res.json()
          if (data.authenticated) {
            setLastValidated(Date.now())
          } else {
            clearToken()
          }
        } else {
          clearToken()
        }
      } catch {
        // Don't clear on network errors - might be temporary
      } finally {
        setValidating(false)
      }
    }
    
    validate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, needsValidation, isValidating])
  
  // Manual validation
  const validateNow = useCallback(async (): Promise<boolean> => {
    if (!token) return false
    
    setValidating(true)
    try {
      const res = await fetch('/api/auth/me')
      if (res.ok) {
        const data = await res.json()
        if (data.authenticated) {
          setLastValidated(Date.now())
          return true
        }
      }
      clearToken()
      return false
    } catch {
      return false
    } finally {
      setValidating(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  
  // Clear auth
  const clearAuth = useCallback(() => {
    clearToken()
    // Clear httpOnly cookie via server endpoint
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  
  return {
    token,
    isReady: true, // Store is always ready with persist middleware
    isAuthenticated: !!token,
    isValidating,
    validateNow,
    clearAuth,
  }
}

/**
 * Get the backend auth header for API calls.
 * 
 * With httpOnly cookies, all proxy routes read the cookie server-side.
 * This function is kept for backward-compat but returns empty in production
 * since client-side calls go through local proxies that handle auth.
 * 
 * @returns Authorization header value (empty string in production)
 */
export function getBackendAuthHeader(): string {
  // In dev mode, try the store token for backward compat
  if (process.env.NODE_ENV !== 'production') {
    const storeToken = useAuthTokenStore.getState().token
    if (storeToken && storeToken !== 'httponly-session-active') {
      return `Bearer ${storeToken}`
    }
    const apiKey = process.env.NEXT_PUBLIC_API_KEY || 'dev-key'
    return `Bearer ${apiKey}`
  }
  
  // 🔒 SECURITY: In production, return empty — API routes use server-side cookie
  return ''
}

/**
 * Get the raw token value (without Bearer prefix).
 * 
 * With httpOnly cookies, the raw token is NOT available client-side.
 * This returns null in production. Use /api/ws-ticket for WS auth.
 * 
 * @returns null (httpOnly migration)
 */
export function getBackendToken(): string | null {
  const storeToken = useAuthTokenStore.getState().token
  if (storeToken && storeToken !== 'httponly-session-active') return storeToken
  
  return null
}
