/**
 * useBackendTokenSync Hook
 * =========================
 *
 * After Better Auth establishes a session, calls /api/auth/sync-backend
 * to obtain a sophia-backend-token from the Sophia backend.
 *
 * Usage:
 * Add to main app component:
 * ```tsx
 * useBackendTokenSync({ user, loading })
 * ```
 */

"use client"

import { useCallback, useEffect, useRef, useState } from 'react'

import { authBypassEnabled } from '../lib/auth/dev-bypass'
import { useAuthTokenStore } from '../stores/auth-token-store'

export interface BackendTokenSyncAuthState {
  user: { id: string } | null
  loading: boolean
}

export interface BackendTokenSyncState {
  /** Whether sync is in progress */
  isSyncing: boolean
  /** Whether sync has completed (success or failure) */
  syncCompleted: boolean
  /** Error message if sync failed */
  syncError: string | null
  /** Force a sync attempt */
  forceSync: () => Promise<boolean>
}

/**
 * Hook that automatically syncs backend token when needed.
 * Should be used at the app level to ensure token is available.
 */
export function useBackendTokenSync({ user, loading }: BackendTokenSyncAuthState): BackendTokenSyncState {
  const token = useAuthTokenStore(state => state.token)
  const setToken = useAuthTokenStore(state => state.setToken)

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncCompleted, setSyncCompleted] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  // Track the last user id we attempted to sync so failures do not loop forever.
  const attemptedUserIdRef = useRef<string | null>(null)
  const previousUserIdRef = useRef<string | null>(null)
  const currentUserId = user?.id ?? null

  // Check if we need to sync: have Better Auth user but no backend token in store
  const needsSync = !authBypassEnabled && !!user && !token

  // Sync function that can be called manually or automatically
  const doSync = useCallback(async (): Promise<boolean> => {
    if (!currentUserId) return false

    attemptedUserIdRef.current = currentUserId

    setIsSyncing(true)
    setSyncError(null)

    try {
      const res = await fetch('/api/auth/sync-backend', { method: 'POST' })

      if (res.ok) {
        const data = await res.json()

        if (data.skipped === true) {
          setSyncCompleted(true)
          return true
        }

        if (data.user?.id) {
          // The server already set the httpOnly cookie.
          // Store a marker token so UI auth checks stay accurate.
          setToken('httponly-session-active', {
            id: data.user.id,
            email: data.user.email ?? null,
            username: data.user.username ?? null,
            discord_id: null,
          })
          setSyncCompleted(true)
          return true
        }

        setSyncError('Sync completed without a backend session')
        setSyncCompleted(true)
        return false
      }

      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      setSyncError(err.error || 'Sync failed')
      setSyncCompleted(true)
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      setSyncError(message)
      setSyncCompleted(true)
      return false
    } finally {
      setIsSyncing(false)
    }
  }, [currentUserId, setToken])

  // Reset sync state only when the authenticated Better Auth user changes.
  useEffect(() => {
    if (previousUserIdRef.current === currentUserId) return

    previousUserIdRef.current = currentUserId
    attemptedUserIdRef.current = null
    setSyncCompleted(false)
    setSyncError(null)
  }, [currentUserId])

  // Auto-sync when conditions are met
  useEffect(() => {
    if (loading || !needsSync || isSyncing || !currentUserId) return
    if (attemptedUserIdRef.current === currentUserId) return

    void doSync()
  }, [currentUserId, doSync, loading, needsSync, isSyncing])

  return {
    isSyncing,
    syncCompleted,
    syncError,
    forceSync: doSync,
  }
}
