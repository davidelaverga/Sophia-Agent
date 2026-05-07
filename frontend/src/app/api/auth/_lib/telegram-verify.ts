/**
 * Telegram Login URL / Login Widget HMAC verification.
 *
 * Telegram appends six query params (id, first_name, username, photo_url,
 * auth_date, hash) to the URL that the bot's LoginUrl button or Login
 * Widget points at. The hash is HMAC-SHA-256 of a sorted, newline-joined
 * data check string, keyed by the SHA-256 hash of the bot token.
 *
 * Reference: https://core.telegram.org/widgets/login#checking-authorization
 *
 * This module verifies a parsed param map and returns the trusted
 * Telegram user identity on success, or an error reason on failure.
 */

import crypto from "crypto"

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

/**
 * Verify a Telegram-attested payload.
 *
 * @param params The parsed search params from the redirect URL
 * @param botToken The bot token whose chat the link was sent from
 * @param now Optional override for testing (seconds since epoch)
 */
export function verifyTelegramAuth(
  params: Record<string, string>,
  botToken: string,
  now?: number,
): VerificationResult {
  if (!botToken) {
    return { ok: false, reason: "missing_bot_token" }
  }

  const hash = params.hash
  if (!hash) {
    return { ok: false, reason: "missing_hash" }
  }
  if (!params.id) {
    return { ok: false, reason: "missing_id" }
  }
  if (!params.auth_date) {
    return { ok: false, reason: "missing_auth_date" }
  }

  const authDate = Number.parseInt(params.auth_date, 10)
  if (!Number.isFinite(authDate)) {
    return { ok: false, reason: "missing_auth_date" }
  }

  const nowSeconds = now ?? Math.floor(Date.now() / 1000)
  if (nowSeconds - authDate > _AUTH_DATE_WINDOW_SECONDS) {
    return { ok: false, reason: "expired" }
  }

  // Build the data check string: every param except `hash`, sorted
  // alphabetically by key, joined by `\n` as `key=value`.
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

  // Constant-time compare (Buffer.from with hex throws on odd lengths,
  // so guard length first to keep the failure mode generic).
  if (expectedHash.length !== hash.length) {
    return { ok: false, reason: "invalid_hash" }
  }
  let mismatch = false
  try {
    mismatch = !crypto.timingSafeEqual(
      Buffer.from(expectedHash, "hex"),
      Buffer.from(hash, "hex"),
    )
  } catch {
    return { ok: false, reason: "invalid_hash" }
  }
  if (mismatch) {
    return { ok: false, reason: "invalid_hash" }
  }

  return {
    ok: true,
    telegramUserId: params.id,
    authDateSeconds: authDate,
  }
}

/**
 * Validate a session id query param so we never redirect to an
 * arbitrary same-origin path injected by an attacker.
 *
 * Sophia session ids are UUID4 hex (32 chars) per
 * ``telegram_session_tracker._new_session_id``. We accept any string of
 * 16-64 hex chars to give some flexibility, plus the canonical UUID
 * dash form.
 */
const _SESSION_ID_RE = /^[a-f0-9-]{16,64}$/i

export function isSafeSessionId(value: string | null | undefined): value is string {
  if (!value) {
    return false
  }
  return _SESSION_ID_RE.test(value)
}
