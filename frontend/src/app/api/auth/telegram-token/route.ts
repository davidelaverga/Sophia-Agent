/**
 * Plain-token fallback for the Telegram review handoff.
 *
 * Used when the Login URL button isn't viable (e.g. ``/setdomain`` not
 * yet configured for the bot). The backend mints a single-use 10-min
 * token via ``telegram_link_store.issue_link_token`` and embeds it in
 * the URL the bot sends. This route validates the token by calling
 * the backend's redeem endpoint and then 302s to /recap with ?next=
 * plumbing, mirroring the LoginUrl route.
 *
 * The token is bound to a canonical user_id, but for this minimal PR we
 * only USE the token for link-integrity (anti-phishing). Authentication
 * still flows through Google via AuthGate. The follow-up Better Auth
 * plugin will use the token's user_id to mint a session directly.
 */

import { NextResponse, type NextRequest } from "next/server"

import { isSafeSessionId } from "../_lib/telegram-verify"

export const dynamic = "force-dynamic"

const _TOKEN_RE = /^[A-Za-z0-9_\-]{16,96}$/

function errorResponse(status: number, reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status })
}

async function resolveBackendUrl(): Promise<string> {
  const candidates = [
    process.env.SOPHIA_GATEWAY_URL,
    process.env.NEXT_PUBLIC_GATEWAY_URL,
  ].filter((value): value is string => Boolean(value && value.trim()))
  const raw = candidates[0]?.trim() ?? "http://localhost:8001"
  return raw.replace(/\/+$/, "")
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url)
  const session = url.searchParams.get("session")
  const token = url.searchParams.get("token")

  if (!isSafeSessionId(session)) {
    return errorResponse(400, "invalid_session")
  }
  if (!token || !_TOKEN_RE.test(token)) {
    return errorResponse(400, "invalid_token")
  }

  // Validate the token via the gateway's redeem endpoint. The token is
  // single-use and 10-min TTL; redemption returns the canonical
  // user_id. We don't need the user_id for the minimal-redirect path,
  // but proving the token is real is what gates this route — it lets
  // us know the bot sent the link (anti-phishing).
  const backendUrl = await resolveBackendUrl()
  let valid = false
  try {
    const response = await fetch(
      `${backendUrl}/api/sophia/internal/redeem-telegram-review-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sophia-Internal-Token": process.env.SOPHIA_INTERNAL_TOKEN || "",
        },
        body: JSON.stringify({ token }),
      },
    )
    valid = response.ok
  } catch {
    return errorResponse(502, "backend_unavailable")
  }

  if (!valid) {
    return errorResponse(400, "token_invalid_or_expired")
  }

  const recapPath = `/recap/${session}`
  const redirectUrl = new URL(recapPath, url.origin)
  redirectUrl.searchParams.set("next", recapPath)
  redirectUrl.searchParams.set("from", "telegram")
  return NextResponse.redirect(redirectUrl, 302)
}
