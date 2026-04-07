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
 * useBackendTokenSync()
 * ```
 */

"use client"

import { useEffect, useRef, useState } from 'react'

import { useAuth } from '../providers'
import { useAuthTokenStore } from '../stores/auth-token-store'

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
export function useBackendTokenSync(): BackendTokenSyncState {
  const { user, loading } = useAuth()
  const token = useAuthTokenStore(state => state.token)
  const setToken = useAuthTokenStore(state => state.setToken)

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncCompleted, setSyncCompleted] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  // Track if we've already attempted sync to avoid infinite loops
  const syncAttemptedRef = useRef(false)

  // Check if we need to sync: have Better Auth user but no backend token in store
  const needsSync = !!user && !token

  // Sync function that can be called manually or automatically
  const doSync = async (): Promise<boolean> => {
    if (!user) return false

    setIsSyncing(true)
    setSyncError(null)

    try {
      const res = await fetch('/api/auth/sync-backend', { method: 'POST' })

      if (res.ok) {
        const data = await res.json()
        // The server already set the httpOnly cookie.
        // Update Zustand store for UI awareness.
        setToken(data.user?.id ?? 'synced')
        setSyncCompleted(true)
        return true
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
  }

  // Auto-sync when conditions are met
  useEffect(() => {
    if (loading || !needsSync || syncAttemptedRef.current || isSyncing) return
    syncAttemptedRef.current = true
    void doSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, needsSync, isSyncing])

  // Reset sync attempt flag when user changes (new login)
  useEffect(() => {
    if (user?.id) {
      syncAttemptedRef.current = false
    }
  }, [user?.id])

  return {
    isSyncing,
    syncCompleted,
    syncError,
    forceSync: doSync,
  }
}
