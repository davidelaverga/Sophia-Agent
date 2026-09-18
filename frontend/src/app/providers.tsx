'use client'

import { createContext, useContext, useMemo, useRef } from 'react'

import { useBackendTokenSync } from '@/app/hooks/useBackendTokenSync'
import { authBypassEnabled, authBypassUserId } from '@/app/lib/auth/dev-bypass'
import { authClient } from '@/server/better-auth/client'

// Shape exposed to consumers
type AuthUser = {
  id: string
  email: string | null
  name: string | null
}

type AuthHookResult = {
  user: AuthUser | null
  loading: boolean
  /** Opaque local authentication lifetime, never persisted or sent to APIs. */
  authScope?: object
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthHookResult>({
  user: null,
  loading: true,
  signOut: async () => {},
})

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthContext.Provider value={useAuthInternal()}>
      <BackendTokenSyncBootstrap />
      {children}
    </AuthContext.Provider>
  )
}

function BackendTokenSyncBootstrap() {
  const { user, loading } = useAuth()
  useBackendTokenSync({ user, loading })
  return null
}

function useAuthInternal(): AuthHookResult {
  const { data: session, isPending } = authBypassEnabled
    ? { data: null, isPending: false }
    : authClient.useSession()

  const sessionId = session?.session?.id
  const ownerId = session?.user?.id
  const observedScope = useRef({sessionId, ownerId, loading: isPending, scope: {}})
  if (observedScope.current.sessionId !== sessionId
      || observedScope.current.ownerId !== ownerId || observedScope.current.loading !== isPending) {
    observedScope.current = {sessionId, ownerId, loading: isPending, scope: {}}
  }
  const authScope = observedScope.current.scope
  return useMemo(() => {
    if (authBypassEnabled) {
      return {
        user: { id: authBypassUserId, email: 'dev@localhost', name: 'Dev User' },
        loading: false,
        authScope,
        signOut: async () => {},
      }
    }

    return {
      user: session?.user
        ? { id: session.user.id, email: session.user.email ?? null, name: session.user.name ?? null }
        : null,
      loading: isPending,
      authScope,
      signOut: async () => { await authClient.signOut() },
    }
  }, [session, isPending, authScope])
}

/**
 * Primary auth hook.
 * Returns { user, loading, signOut }.
 */
export const useAuth = () => useContext(AuthContext)
