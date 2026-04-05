'use client'

import { createContext, useContext, useMemo } from 'react'
import { authClient } from '@/server/better-auth/client'

// Dev bypass: skip auth entirely (no OAuth, no session)
const devBypass = process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === 'true'

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
  const { data: session, isPending } = devBypass
    ? { data: null, isPending: false }
    : authClient.useSession()

  return useMemo(() => {
    if (devBypass) {
      const devUserId = process.env.NEXT_PUBLIC_SOPHIA_USER_ID || 'dev-user'
      return {
        user: { id: devUserId, email: 'dev@localhost', name: 'Dev User' },
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

/**
 * Legacy alias — migrate call-sites to useAuth().
 * @deprecated Use useAuth() instead.
 */
export const useSupabase = (): {
  supabase: null
  user: AuthUser | null
  loading: boolean
  accessToken: string | null
} => {
  const { user, loading } = useAuth()
  return { supabase: null, user, loading, accessToken: null }
}
