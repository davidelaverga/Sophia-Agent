import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { providerLogin } from '@/app/lib/auth/backend-auth'
import { authBypassEnabled } from '@/app/lib/auth/dev-bypass'
import { getSession } from '@/server/better-auth'

function isLegacyBridgeUnavailable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
    return true
  }

  return error instanceof Error && /\b404\b/.test(error.message)
}

/**
 * POST /api/auth/sync-backend
 *
 * After Better Auth establishes a session, call this to sync with the
 * Sophia backend. Reads the Google account ID from Better Auth,
 * sends it through the legacy backend auth bridge, and sets the
 * sophia-backend-token httpOnly cookie.
 */
export async function POST() {
  if (authBypassEnabled) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'Auth bypass enabled',
    })
  }

  const session = await getSession()

  if (!session?.user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    // Get linked accounts for the current user
    const requestHeaders = await headers()
    const { auth } = await import('@/server/better-auth/config')
    const accounts = await auth.api.listUserAccounts({ headers: requestHeaders })
    const googleAccount = (accounts as { accountId: string; providerId: string }[])?.find(
      (a) => a.providerId === 'google',
    )

    if (!googleAccount) {
      return NextResponse.json({ error: 'No Google account linked' }, { status: 400 })
    }

    const backendUser = await providerLogin({
      provider: 'google',
      canonicalUserId: session.user.id,
      providerUserId: googleAccount.accountId,
      email: session.user.email || '',
      forwardedCookieHeader: requestHeaders.get('cookie') || undefined,
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
        user: {
          id: backendUser.id,
          email: backendUser.email,
          username: backendUser.username ?? session.user.name ?? null,
        },
      })
    }

    return NextResponse.json({ error: 'No token returned from backend' }, { status: 502 })
  } catch (error) {
    if (isLegacyBridgeUnavailable(error)) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: 'Legacy backend auth bridge unavailable',
      })
    }

    const message = error instanceof Error ? error.message : 'Backend sync failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
