/**
 * Telegram Login URL handoff.
 *
 * Lands here when a Telegram user taps the "Open Review" button on a
 * "memories ready" DM (see ``backend/app/channels/telegram_review_notifier.py``).
 * Telegram appends an HMAC-signed identity payload to the URL we set on
 * the LoginUrl button.
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
 * for already-bound users. Tracked in the plan file at
 * ~/.claude/plans/users-davidelaverga-desktop-sophia-asyn-peppy-riddle.md
 * — see "Open TBDs" section.
 */

import { NextResponse, type NextRequest } from "next/server"

import { isSafeSessionId, verifyTelegramAuth } from "../_lib/telegram-verify"

export const dynamic = "force-dynamic"

function errorResponse(status: number, reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status })
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url)
  const session = url.searchParams.get("session")

  if (!isSafeSessionId(session)) {
    return errorResponse(400, "invalid_session")
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN || ""
  if (!botToken) {
    // Configuration error, not user-facing.
    return errorResponse(500, "bot_token_not_configured")
  }

  // Collect the Telegram-supplied params for the HMAC check. Telegram
  // sends id, first_name, last_name?, username?, photo_url?, auth_date,
  // and hash. We pull every search param except ``session`` (our own).
  const params: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "session") continue
    params[key] = value
  }

  const result = verifyTelegramAuth(params, botToken)
  if (!result.ok) {
    return errorResponse(400, result.reason)
  }

  // Redirect to the recap page; AuthGate handles the rest. ``next=`` is
  // a same-origin path-only value so the AuthGate's redirect-back
  // (Phase D) cannot be hijacked.
  const recapPath = `/recap/${session}`
  const redirectUrl = new URL(recapPath, url.origin)
  redirectUrl.searchParams.set("next", recapPath)
  redirectUrl.searchParams.set("from", "telegram")

  const response = NextResponse.redirect(redirectUrl, 302)
  // Tag the request so observability can correlate the tap → recap.
  // Telegram ids are not sensitive on their own (the user just shared
  // their tap with us), but keep the cookie httpOnly to prevent any JS
  // leakage and short-lived (60s).
  response.cookies.set("sophia-telegram-handoff", result.telegramUserId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60,
    path: "/",
  })
  return response
}
