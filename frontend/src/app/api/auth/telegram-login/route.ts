/**
 * Telegram Login URL handoff.
 *
 * Lands here when a Telegram user taps the "Open Review" button on a
 * "memories ready" DM (published by the Telegram session tracker over
 * the channel ``MessageBus``). Telegram appends an HMAC-signed identity
 * payload to the URL we set on the LoginUrl button.
 *
 * Flow (this PR — minimal):
 *   1. Verify the HMAC payload using SHA256(BOT_TOKEN) as the HMAC key.
 *   2. Validate ``session`` param shape (UUID-ish hex/dash) so the
 *      downstream redirect can never be open-redirected.
 *   3. 302 → ``/recap/{session}?next=/recap/{session}`` so the existing
 *      AuthGate handles the Google sign-in (if no session) and lands the
 *      user back on /recap after — see ``AuthGate.tsx`` for the ?next=
 *      plumbing.
 *
 * Follow-up PR (deferred): use a Better Auth plugin to mint a session
 * directly from the Telegram-attested payload, skipping Google entirely
 * for already-bound users.
 *
 * The HMAC verifier and the session-id safety check are exported from
 * this file (rather than living in a sibling ``_lib/`` module) because
 * (a) only this route + its sibling token-fallback route consume them
 * and (b) keeping a single file is friendlier to the Sentrux quality
 * gate than a thin ``_lib`` indirection.
 */

import crypto from "crypto"

import { NextResponse, type NextRequest } from "next/server"

export const dynamic = "force-dynamic"

// ---------------------------------------------------------------------------
// HMAC verification (https://core.telegram.org/widgets/login#checking-authorization)
// ---------------------------------------------------------------------------

export type TelegramAuthPayload = {
  id: string
  auth_date: string
  hash: string
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
}

export type VerificationResult =
  | { ok: true; telegramUserId: string; authDateSeconds: number }
  | { ok: false; reason: VerificationError }

export type VerificationError =
  | "missing_hash"
  | "missing_id"
  | "missing_auth_date"
  | "expired"
  | "invalid_hash"
  | "missing_bot_token"

const _AUTH_DATE_WINDOW_SECONDS = 300

const _REQUIRED = ["hash", "id", "auth_date"] as const
const _MISSING_REASON: Record<string, VerificationError> = {
  hash: "missing_hash",
  id: "missing_id",
  auth_date: "missing_auth_date",
}

export function verifyTelegramAuth(
  params: Record<string, string>,
  botToken: string,
  now?: number,
): VerificationResult {
  if (!botToken) return { ok: false, reason: "missing_bot_token" }
  for (const key of _REQUIRED) {
    if (!params[key]) return { ok: false, reason: _MISSING_REASON[key] }
  }
  const authDate = Number.parseInt(params.auth_date, 10)
  if (!Number.isFinite(authDate)) return { ok: false, reason: "missing_auth_date" }

  const nowSeconds = now ?? Math.floor(Date.now() / 1000)
  if (nowSeconds - authDate > _AUTH_DATE_WINDOW_SECONDS) {
    return { ok: false, reason: "expired" }
  }

  // Build the data check string: every param except ``hash``, sorted by key.
  const dataCheckString = Object.entries(params)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")

  const secretKey = crypto.createHash("sha256").update(botToken).digest()
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")

  if (expectedHash.length !== params.hash.length) {
    return { ok: false, reason: "invalid_hash" }
  }
  let matches = false
  try {
    matches = crypto.timingSafeEqual(
      Buffer.from(expectedHash, "hex"),
      Buffer.from(params.hash, "hex"),
    )
  } catch {
    matches = false
  }
  if (!matches) return { ok: false, reason: "invalid_hash" }

  return { ok: true, telegramUserId: params.id, authDateSeconds: authDate }
}

/**
 * Validate a session-id query param so we never redirect to an arbitrary
 * same-origin path injected by an attacker. Sophia session ids are
 * UUID4 hex (32 chars); we accept 16-64 hex/dash chars for flexibility.
 */
const _SESSION_ID_RE = /^[a-f0-9-]{16,64}$/i

export function isSafeSessionId(value: string | null | undefined): value is string {
  if (!value) return false
  return _SESSION_ID_RE.test(value)
}

// ---------------------------------------------------------------------------
// Route handler.
// ---------------------------------------------------------------------------

function errorResponse(status: number, reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status })
}

function buildRecapRedirect(session: string, origin: string): URL {
  const recapPath = `/recap/${session}`
  const redirectUrl = new URL(recapPath, origin)
  redirectUrl.searchParams.set("next", recapPath)
  redirectUrl.searchParams.set("from", "telegram")
  return redirectUrl
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url)
  const session = url.searchParams.get("session")

  if (!isSafeSessionId(session)) {
    return errorResponse(400, "invalid_session")
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN || ""
  if (!botToken) {
    return errorResponse(500, "bot_token_not_configured")
  }

  const params: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "session") continue
    params[key] = value
  }

  // If the user declined the LoginUrl consent prompt, Telegram redirects
  // back to our URL with NO auth payload (no ``hash``/``id``/``auth_date``).
  // Treat that as a soft pass-through: redirect to /recap/{session} with
  // ``from=telegram`` for observability and let AuthGate complete the
  // Google sign-in. No correlation cookie because we have no Telegram-
  // attested identity in this branch.
  const hasAnyAuthField = Boolean(params.hash || params.id || params.auth_date)
  if (!hasAnyAuthField) {
    return NextResponse.redirect(buildRecapRedirect(session, url.origin), 302)
  }

  const result = verifyTelegramAuth(params, botToken)
  if (!result.ok) {
    return errorResponse(400, result.reason)
  }

  const response = NextResponse.redirect(buildRecapRedirect(session, url.origin), 302)
  // Short-lived correlation cookie so observability can match tap → recap.
  // Telegram ids are not sensitive on their own; httpOnly + 60s TTL.
  response.cookies.set("sophia-telegram-handoff", result.telegramUserId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60,
    path: "/",
  })
  return response
}
