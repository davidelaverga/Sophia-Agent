import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import type { Session } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { discordLogin } from './backend-auth'
import { debugLog, debugWarn } from '../debug-logger'
import { logger } from '../error-logger'

type UsersUpsertClient = {
  from: (table: 'users') => {
    upsert: (
      values: {
        id: string;
        email: string;
        discord_id: string | null;
      },
      options: { onConflict: 'id' }
    ) => Promise<{ error: unknown }>
  }
}

export async function handleDiscordOAuthCallback(request: NextRequest): Promise<NextResponse> {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const error = requestUrl.searchParams.get('error')

  let session: Session
  let supabase: ReturnType<typeof createRouteHandlerClient>

  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  const origin = process.env.NODE_ENV === 'production'
    ? (configuredSiteUrl || requestUrl.origin)
    : requestUrl.origin

  if (process.env.NODE_ENV !== 'production') {
    debugLog('oauth-callback', 'Auth callback received', {
      code: !!code,
      error,
      origin,
      requestOrigin: requestUrl.origin,
    })
  }

  if (error) {
    logger.logError(new Error(`OAuth error from Discord: ${error}`), {
      component: 'oauth-callback',
      action: 'callback_error',
    })
    return NextResponse.redirect(`${origin}/?error=oauth_error`)
  }

  if (code) {
    const cookieStore = cookies()
    supabase = createRouteHandlerClient({ cookies: () => cookieStore })

    try {
      const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

      if (exchangeError) {
        logger.logError(exchangeError, { component: 'oauth-callback', action: 'exchange_code' })
        return NextResponse.redirect(`${origin}/?error=exchange_failed`)
      }

      session = data.session
    } catch (exchangeFailure) {
      logger.logError(exchangeFailure, { component: 'oauth-callback', action: 'exchange_failure' })
      return NextResponse.redirect(`${origin}/?error=auth_failed`)
    }
  } else {
    return NextResponse.redirect(`${origin}/?error=no_code`)
  }

  const user = session.user
  let backendToken: string | null = null

  if (user?.id) {
    try {
      const metadata = user.user_metadata || {}
      const discordId =
        metadata.provider_id ||
        metadata.sub ||
        metadata.provider_token ||
        metadata.user_id ||
        null

      const username = metadata.full_name || metadata.name || metadata.preferred_username || null

      const payload = {
        id: user.id,
        email: user.email || `${user.id}@placeholder.sophia`,
        discord_id: discordId ? String(discordId) : null,
      }

      const usersClient = supabase as unknown as UsersUpsertClient
      const { error: upsertError } = await usersClient
        .from('users')
        .upsert(payload, { onConflict: 'id' })

      if (upsertError) {
        logger.logError(upsertError, { component: 'oauth-callback', action: 'upsert_user' })
      }

      if (discordId) {
        try {
          const backendUser = await discordLogin({
            discord_id: String(discordId),
            email: user.email || `${user.id}@placeholder.sophia`,
            username: username || undefined,
          })

          if (backendUser && backendUser.api_token) {
            backendToken = backendUser.api_token

            const cookieStore = cookies()
            cookieStore.set('sophia-backend-token', backendToken, {
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
              maxAge: 60 * 60 * 24 * 30,
              path: '/',
            })
          }
        } catch (backendError) {
          debugWarn('oauth-callback', 'Backend auth failed', {
            error: backendError instanceof Error ? backendError.message : backendError,
          })
        }
      }
    } catch (userSyncError) {
      logger.logError(userSyncError, { component: 'oauth-callback', action: 'ensure_user_row' })
    }
  }

  return NextResponse.redirect(`${origin}/`)
}