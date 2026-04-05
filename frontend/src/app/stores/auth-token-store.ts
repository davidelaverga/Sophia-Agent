/**
 * Backend Auth Token Store
 * =========================
 * 
 * Zustand store for managing the backend api_token.
 * The token is persisted in localStorage and used for all backend API calls.
 * 
 * Usage:
 * ```tsx
 * const token = useAuthTokenStore(state => state.token)
 * const setToken = useAuthTokenStore(state => state.setToken)
 * ```
 */

"use client"

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ============================================================================
// TYPES
// ============================================================================

interface BackendUser {
  id: string
  email: string
  username: string | null
  discord_id: string | null
}

interface AuthTokenState {
  // State
  token: string | null
  user: BackendUser | null
  isValidating: boolean
  lastValidated: number | null
  
  // Actions
  setToken: (token: string, user?: BackendUser) => void
  clearToken: () => void
  setValidating: (isValidating: boolean) => void
  setLastValidated: (timestamp: number) => void
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEY = 'sophia-backend-auth'
const TOKEN_VALIDATION_INTERVAL = 5 * 60 * 1000 // 5 minutes

// ============================================================================
// STORE
// ============================================================================

export const useAuthTokenStore = create<AuthTokenState>()(
  persist(
    (set) => ({
      // Initial state
      token: null,
      user: null,
      isValidating: false,
      lastValidated: null,
      
      // Actions
      setToken: (token, user) => set({
        token,
        user: user || null,
        lastValidated: Date.now(),
      }),
      
      clearToken: () => set({
        token: null,
        user: null,
        lastValidated: null,
      }),
      
      setValidating: (isValidating) => set({ isValidating }),
      
      setLastValidated: (timestamp) => set({ lastValidated: timestamp }),
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        // Only persist token and user, not transient state
        token: state.token,
        user: state.user,
        lastValidated: state.lastValidated,
      }),
    }
  )
)

// ============================================================================
// SELECTORS
// ============================================================================

/**
 * Check if token needs revalidation (older than 5 minutes)
 */
export function needsTokenValidation(state: AuthTokenState): boolean {
  if (!state.token) return false
  if (!state.lastValidated) return true
  return Date.now() - state.lastValidated > TOKEN_VALIDATION_INTERVAL
}

/**
 * Get authorization header value
 */
export function getAuthHeader(state: AuthTokenState): string | null {
  if (!state.token) return null
  return `Bearer ${state.token}`
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Get the current token synchronously (for non-React contexts).
 * Use sparingly - prefer the hook in React components.
 */
export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null
  
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    
    const parsed = JSON.parse(stored)
    return parsed.state?.token || null
  } catch {
    return null
  }
}

/**
 * Clear stored token (for sign out)
 */
export function clearStoredToken(): void {
  if (typeof window === 'undefined') return
  
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore errors
  }
}
