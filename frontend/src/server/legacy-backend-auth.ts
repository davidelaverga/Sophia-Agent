import { createHmac, timingSafeEqual } from 'node:crypto'

export interface LegacyBackendUser {
  id: string
  email: string
  username: string | null
  discord_id: string | null
  is_active: boolean
}

interface LegacyBackendTokenPayload {
  iss: string
  sub: string
  email: string
  username: string | null
  discord_id: string | null
  is_active: boolean
  iat: number
  exp: number
}

const TOKEN_ISSUER = 'sophia-better-auth-bridge'
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30
const DEV_FALLBACK_SECRET = 'sophia-local-dev-secret-minimum-32-chars'

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function encodeBase64Url(value: string | Buffer): string {
  const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return buffer.toString('base64url')
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function resolveLegacyBackendSecret(): string {
  const explicitSecret = normalizeOptionalString(process.env.SOPHIA_BACKEND_TOKEN_SECRET)
  if (explicitSecret) {
    return explicitSecret
  }

  const betterAuthSecret = normalizeOptionalString(process.env.BETTER_AUTH_SECRET)
  if (betterAuthSecret) {
    return betterAuthSecret
  }

  if (process.env.NODE_ENV !== 'production') {
    return DEV_FALLBACK_SECRET
  }

  throw new Error('Missing SOPHIA_BACKEND_TOKEN_SECRET or BETTER_AUTH_SECRET for backend token bridge')
}

function signTokenInput(input: string): Buffer {
  return createHmac('sha256', resolveLegacyBackendSecret()).update(input).digest()
}

function parsePayload(payloadPart: string): LegacyBackendTokenPayload {
  try {
    return JSON.parse(decodeBase64Url(payloadPart).toString('utf8')) as LegacyBackendTokenPayload
  } catch {
    throw new Error('Invalid backend token payload')
  }
}

export function buildLegacyBackendUser(user: {
  id: string
  email: string
  username?: string | null
  discord_id?: string | null
  is_active?: boolean
}): LegacyBackendUser {
  const normalizedId = normalizeOptionalString(user.id)

  if (!normalizedId || normalizedId === 'anonymous') {
    throw new Error('Backend token bridge requires a canonical user id')
  }

  return {
    id: normalizedId,
    email: normalizeOptionalString(user.email) ?? '',
    username: normalizeOptionalString(user.username),
    discord_id: normalizeOptionalString(user.discord_id),
    is_active: user.is_active ?? true,
  }
}

export function issueLegacyBackendToken(
  user: LegacyBackendUser,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): string {
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000)
  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = encodeBase64Url(
    JSON.stringify({
      iss: TOKEN_ISSUER,
      sub: user.id,
      email: user.email,
      username: user.username,
      discord_id: user.discord_id,
      is_active: user.is_active,
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
    } satisfies LegacyBackendTokenPayload),
  )
  const input = `${header}.${payload}`
  const signature = encodeBase64Url(signTokenInput(input))
  return `${input}.${signature}`
}

export function verifyLegacyBackendToken(token: string): LegacyBackendUser {
  const [headerPart, payloadPart, signaturePart] = token.split('.')

  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error('Invalid backend token format')
  }

  const signedInput = `${headerPart}.${payloadPart}`
  const expectedSignature = new Uint8Array(signTokenInput(signedInput))
  const receivedSignature = new Uint8Array(decodeBase64Url(signaturePart))

  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new Error('Invalid backend token signature')
  }

  const payload = parsePayload(payloadPart)

  if (payload.iss !== TOKEN_ISSUER) {
    throw new Error('Invalid backend token issuer')
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    throw new Error('Backend token expired')
  }

  return buildLegacyBackendUser({
    id: payload.sub,
    email: payload.email,
    username: payload.username,
    discord_id: payload.discord_id,
    is_active: payload.is_active,
  })
}

export function buildLegacyBackendUserResponse(user: LegacyBackendUser, apiToken: string) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    discord_id: user.discord_id,
    is_active: user.is_active,
    api_token: apiToken,
  }
}

export function readBearerToken(authorizationHeader: string | null): string | null {
  const headerValue = normalizeOptionalString(authorizationHeader)
  if (!headerValue) {
    return null
  }

  const [scheme, token] = headerValue.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer') {
    return null
  }

  return normalizeOptionalString(token)
}