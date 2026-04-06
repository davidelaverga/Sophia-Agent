'use client'

import { createContext, useContext, useMemo } from 'react'

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
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthHookResult>({
  user: null,
  loading: true,
  signOut: async () => {},
})

export function Providers({ children }: { children: React.ReactNode }) {
  return <AuthContext.Provider value={useAuthInternal()}>{children}</AuthContext.Provider>
}

function useAuthInternal(): AuthHookResult {
  const { data: session, isPending } = authBypassEnabled
    ? { data: null, isPending: false }
    : authClient.useSession()

  return useMemo(() => {
    if (authBypassEnabled) {
      return {
        user: { id: authBypassUserId, email: 'dev@localhost', name: 'Dev User' },
        loading: false,
        signOut: async () => {},
      }
    }

    return {
      user: session?.user
        ? { id: session.user.id, email: session.user.email ?? null, name: session.user.name ?? null }
        : null,
      loading: isPending,
      signOut: async () => { await authClient.signOut() },
    }
  }, [session, isPending])
}

/**
 * Primary auth hook.
 * Returns { user, loading, signOut }.
 */
export const useAuth = () => useContext(AuthContext)
