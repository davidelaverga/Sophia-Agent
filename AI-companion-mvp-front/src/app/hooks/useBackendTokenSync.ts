/**
 * useBackendTokenSync Hook
 * =========================
 * 
 * Automatically syncs the backend token when user has Supabase session
 * but no backend token. This handles the case where:
 * 1. User logged in with Discord
 * 2. Backend was down during callback
 * 3. User has Supabase session but no backend token
 * 
 * Usage:
 * Add to main app component:
 * ```tsx
 * useBackendTokenSync()
 * ```
 */

"use client"

import { useEffect, useRef, useState } from 'react'
import { useSupabase } from '../providers'
import { useAuthTokenStore } from '../stores/auth-token-store'
import { syncBackendToken } from '../lib/auth/backend-auth'

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
  const { user, loading: supabaseLoading } = useSupabase()
  const token = useAuthTokenStore(state => state.token)
  const setToken = useAuthTokenStore(state => state.setToken)
  
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncCompleted, setSyncCompleted] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  
  // Track if we've already attempted sync to avoid infinite loops
  const syncAttemptedRef = useRef(false)
  
  // Check if we need to sync: have Supabase user but no backend token in store
  const needsSync = !!user && !token
  
  // Sync function that can be called manually or automatically
  const doSync = async (): Promise<boolean> => {
    if (!user) {
      return false
    }
    
    setIsSyncing(true)
    setSyncError(null)
    
    try {
      
      const backendUser = await syncBackendToken({
        id: user.id,
        email: user.email,
        user_metadata: user.user_metadata,
      })
      
      if (backendUser?.api_token) {
        // Set httpOnly cookie via server route
        await fetch('/api/auth/set-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: backendUser.api_token }),
        }).catch(() => {})
        // Update store for UI state
        setToken(backendUser.api_token)
        setSyncCompleted(true)
        return true
      } else {
        setSyncError('Backend returned no token')
        setSyncCompleted(true)
        return false
      }
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
    // Don't sync if:
    // - Supabase is still loading
    // - We already have a token
    // - We've already attempted sync
    // - Currently syncing
    if (supabaseLoading || !needsSync || syncAttemptedRef.current || isSyncing) {
      return
    }
    
    // Mark that we've attempted sync
    syncAttemptedRef.current = true
    
    // Attempt sync
    doSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabaseLoading, needsSync, isSyncing])
  
  // Reset sync attempt flag when user changes (new login)
  useEffect(() => {
    if (user?.id) {
      // Reset on user change to allow re-sync for new user
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
