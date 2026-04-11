import { NextResponse } from 'next/server'

import { authBypassEnabled, authBypassUserId } from '@/app/lib/auth/dev-bypass'
import { getSession } from '@/server/better-auth'
import {
  buildLegacyBackendUser,
  buildLegacyBackendUserResponse,
  issueLegacyBackendToken,
  readBearerToken,
  verifyLegacyBackendToken,
  type LegacyBackendUser,
} from '@/server/legacy-backend-auth'

export interface LegacyBridgeLoginBody {
  email?: string
  username?: string
  discord_id?: string
  provider_user_id?: string
  canonical_user_id?: string
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeCanonicalUserId(value: unknown): string | null {
  const normalized = normalizeOptionalString(value)
  if (!normalized || normalized === 'anonymous') {
    return null
  }

  return normalized
}

export async function resolveLegacyBridgeUser(
  body: LegacyBridgeLoginBody,
): Promise<{ user?: LegacyBackendUser; response?: NextResponse }> {
  const requestedCanonicalUserId = normalizeCanonicalUserId(body.canonical_user_id)

  if (authBypassEnabled) {
    const bypassUserId = normalizeCanonicalUserId(authBypassUserId)
    if (!bypassUserId) {
      return {
        response: NextResponse.json({ detail: 'Auth bypass user is not configured' }, { status: 500 }),
      }
    }

    if (requestedCanonicalUserId && requestedCanonicalUserId !== bypassUserId) {
      return {
        response: NextResponse.json(
          { detail: 'canonical_user_id does not match the active bypass user' },
          { status: 403 },
        ),
      }
    }

    return {
      user: buildLegacyBackendUser({
        id: bypassUserId,
        email: normalizeOptionalString(body.email) ?? '',
        username: normalizeOptionalString(body.username),
        discord_id: normalizeOptionalString(body.discord_id ?? body.provider_user_id),
      }),
    }
  }

  const session = await getSession()

  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ detail: 'Not authenticated' }, { status: 401 }),
    }
  }

  if (requestedCanonicalUserId && requestedCanonicalUserId !== session.user.id) {
    return {
      response: NextResponse.json(
        { detail: 'canonical_user_id does not match the Better Auth session user' },
        { status: 403 },
      ),
    }
  }

  return {
    user: buildLegacyBackendUser({
      id: session.user.id,
      email: normalizeOptionalString(session.user.email) ?? normalizeOptionalString(body.email) ?? '',
      username: normalizeOptionalString(session.user.name) ?? normalizeOptionalString(body.username),
      discord_id: normalizeOptionalString(body.discord_id ?? body.provider_user_id),
    }),
  }
}

export function createLegacyBridgeUserResponse(user: LegacyBackendUser): NextResponse {
  const apiToken = issueLegacyBackendToken(user)
  return NextResponse.json(buildLegacyBackendUserResponse(user, apiToken))
}

export function getLegacyBridgeUserFromRequest(
  request: Request,
): { user?: LegacyBackendUser; token?: string; response?: NextResponse } {
  const token = readBearerToken(request.headers.get('authorization'))
  if (!token) {
    return {
      response: NextResponse.json({ detail: 'Missing bearer token' }, { status: 401 }),
    }
  }

  try {
    return {
      user: verifyLegacyBackendToken(token),
      token,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid backend token'
    return {
      response: NextResponse.json({ detail: message, valid: false }, { status: 401 }),
    }
  }
}