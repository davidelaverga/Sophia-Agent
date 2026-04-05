import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/server/better-auth'
import { discordLogin } from '@/app/lib/auth/backend-auth'

/**
 * POST /api/auth/sync-backend
 *
 * After Better Auth establishes a session, call this to sync with the
 * Sophia backend.  Reads the Discord account ID from the Better Auth DB,
 * calls the backend discordLogin endpoint, and sets the sophia-backend-token
 * httpOnly cookie.
 */
export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    // Get linked accounts for the current user
    const accounts = await auth.api.listUserAccounts({ headers: await headers() })
    const discordAccount = (accounts as { accountId: string; providerId: string }[])?.find(
      (a) => a.providerId === 'discord',
    )

    if (!discordAccount) {
      return NextResponse.json({ error: 'No Discord account linked' }, { status: 400 })
    }

    const backendUser = await discordLogin({
      discord_id: discordAccount.accountId,
      email: session.user.email || '',
      username: session.user.name || undefined,
    })

    if (backendUser?.api_token) {
      const cookieStore = await cookies()
      cookieStore.set('sophia-backend-token', backendUser.api_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: '/',
      })

      return NextResponse.json({
        ok: true,
        user: { id: backendUser.id, email: backendUser.email },
      })
    }

    return NextResponse.json({ error: 'No token returned from backend' }, { status: 502 })
  } catch {
    return NextResponse.json({ error: 'Backend sync failed' }, { status: 502 })
  }
}
