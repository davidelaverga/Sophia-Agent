/**
 * Consolidated tests for the Telegram → web review handoff:
 *   1. ``verifyTelegramAuth`` HMAC verification + ``isSafeSessionId``
 *   2. ``GET /api/auth/telegram-login`` route handler
 *   3. ``isSafeReturnPath`` + ``resolveSafeCallbackURL`` (AuthGate helpers)
 *
 * Three concerns in one file because each is small and they ride the
 * same logical change set; one file = fewer module edges in the
 * Sentrux quality gate.
 */

import crypto from "crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  isSafeSessionId,
  isVerificationFailure,
  verifyTelegramAuth,
} from "../../app/api/auth/telegram-login/route"
import {
  isSafeReturnPath,
  resolveSafeCallbackURL,
} from "../../app/components/AuthGate"

const FAKE_BOT_TOKEN = "1234567:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
const ORIGINAL_ENV = { ...process.env }

function signPayload(
  params: Record<string, string>,
  botToken: string,
): string {
  const dataCheckString = Object.entries(params)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  // See route.ts for why ``Uint8Array.from`` is needed here (Buffer →
  // BinaryLike type mismatch under newer @types/node).
  const secretKey = Uint8Array.from(
    crypto.createHash("sha256").update(botToken).digest(),
  )
  return crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")
}

// ---------------------------------------------------------------------------
// HMAC verifier
// ---------------------------------------------------------------------------

describe("verifyTelegramAuth", () => {
  it("accepts a correctly signed payload within the auth_date window", () => {
    const now = Math.floor(Date.now() / 1000)
    const params: Record<string, string> = {
      id: "10000",
      auth_date: String(now),
      first_name: "Davide",
      username: "davide",
    }
    params.hash = signPayload(params, FAKE_BOT_TOKEN)

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.telegramUserId).toBe("10000")
      expect(result.authDateSeconds).toBe(now)
    }
  })

  it("rejects a tampered hash", () => {
    const now = Math.floor(Date.now() / 1000)
    const params: Record<string, string> = {
      id: "10000",
      auth_date: String(now),
      first_name: "Davide",
    }
    const goodHash = signPayload(params, FAKE_BOT_TOKEN)
    params.hash = goodHash.slice(0, -1) + (goodHash.endsWith("0") ? "1" : "0")

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(false)
    if (isVerificationFailure(result)) expect(result.reason).toBe("invalid_hash")
  })

  it("rejects a payload signed with a different bot token", () => {
    const now = Math.floor(Date.now() / 1000)
    const params: Record<string, string> = { id: "10000", auth_date: String(now) }
    params.hash = signPayload(params, "wrong-bot-token")

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(false)
    if (isVerificationFailure(result)) expect(result.reason).toBe("invalid_hash")
  })

  it("rejects when auth_date is older than 5 minutes", () => {
    const now = Math.floor(Date.now() / 1000)
    const stale = now - 301
    const params: Record<string, string> = { id: "10000", auth_date: String(stale) }
    params.hash = signPayload(params, FAKE_BOT_TOKEN)

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(false)
    if (isVerificationFailure(result)) expect(result.reason).toBe("expired")
  })

  it("rejects when missing required fields", () => {
    expect(verifyTelegramAuth({ id: "1", auth_date: "0" }, FAKE_BOT_TOKEN).ok).toBe(false)
    expect(verifyTelegramAuth({ hash: "x", auth_date: "0" }, FAKE_BOT_TOKEN).ok).toBe(false)
    expect(verifyTelegramAuth({ id: "1", hash: "x" }, FAKE_BOT_TOKEN).ok).toBe(false)
  })

  it("rejects when bot token is empty", () => {
    const result = verifyTelegramAuth(
      { id: "1", auth_date: "0", hash: "x" },
      "",
    )
    expect(result.ok).toBe(false)
    if (isVerificationFailure(result)) expect(result.reason).toBe("missing_bot_token")
  })

  it("rejects mismatched-length hashes without throwing", () => {
    const now = Math.floor(Date.now() / 1000)
    const result = verifyTelegramAuth(
      { id: "1", auth_date: String(now), hash: "deadbeef" },
      FAKE_BOT_TOKEN,
      now,
    )
    expect(result.ok).toBe(false)
    if (isVerificationFailure(result)) expect(result.reason).toBe("invalid_hash")
  })

  it("includes optional Telegram fields in the data check string", () => {
    const now = Math.floor(Date.now() / 1000)
    const params: Record<string, string> = {
      id: "42",
      auth_date: String(now),
      first_name: "Davide",
      last_name: "L",
      username: "davide",
      photo_url: "https://t.me/i/userpic/x.jpg",
    }
    params.hash = signPayload(params, FAKE_BOT_TOKEN)
    expect(verifyTelegramAuth(params, FAKE_BOT_TOKEN, now).ok).toBe(true)
  })
})

describe("isSafeSessionId", () => {
  it("accepts UUID-shaped hex", () => {
    expect(isSafeSessionId("a1b2c3d4e5f60718a1b2c3d4e5f60718")).toBe(true)
    expect(isSafeSessionId("a1b2c3d4-e5f6-0718-a1b2-c3d4e5f60718")).toBe(true)
  })

  it("rejects too-short or too-long values", () => {
    expect(isSafeSessionId("abc")).toBe(false)
    expect(isSafeSessionId("a".repeat(65))).toBe(false)
  })

  it("rejects path-traversal-shaped values", () => {
    expect(isSafeSessionId("../etc/passwd")).toBe(false)
    expect(isSafeSessionId("../../sess123")).toBe(false)
  })

  it("rejects values with non-hex characters", () => {
    expect(isSafeSessionId("g".repeat(20))).toBe(false)
    expect(isSafeSessionId("abc def 1234567890")).toBe(false)
  })

  it("rejects null/undefined/empty", () => {
    expect(isSafeSessionId(null)).toBe(false)
    expect(isSafeSessionId(undefined)).toBe(false)
    expect(isSafeSessionId("")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /api/auth/telegram-login route
// ---------------------------------------------------------------------------

async function loadRoute() {
  vi.resetModules()
  return import("../../app/api/auth/telegram-login/route")
}

function buildRequest(searchParams: Record<string, string>): Request {
  const url = new URL("https://app.example.com/api/auth/telegram-login")
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value)
  }
  return new Request(url.toString())
}

describe("/api/auth/telegram-login GET", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_BOT_TOKEN
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key]
    }
    Object.assign(process.env, ORIGINAL_ENV)
    vi.resetModules()
  })

  it("redirects to /recap/{session} when HMAC and session are valid", async () => {
    const { GET } = await loadRoute()
    const session = "a1b2c3d4e5f60718a1b2c3d4e5f60718"
    const now = Math.floor(Date.now() / 1000)
    const tgParams: Record<string, string> = {
      id: "10000",
      auth_date: String(now),
      first_name: "Davide",
    }
    tgParams.hash = signPayload(tgParams, FAKE_BOT_TOKEN)

    const response = await GET(
      buildRequest({ session, ...tgParams }) as never,
    )
    expect(response.status).toBe(302)
    const location = response.headers.get("location") ?? ""
    expect(location).toContain(`/recap/${session}`)
    expect(location).toContain(`next=%2Frecap%2F${session}`)
    expect(location).toContain("from=telegram")
    const setCookie = response.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("sophia-telegram-handoff")
  })

  it("rejects an invalid session id with 400", async () => {
    const { GET } = await loadRoute()
    const now = Math.floor(Date.now() / 1000)
    const tgParams: Record<string, string> = {
      id: "10000",
      auth_date: String(now),
    }
    tgParams.hash = signPayload(tgParams, FAKE_BOT_TOKEN)

    const response = await GET(
      buildRequest({ session: "../../etc", ...tgParams }) as never,
    )
    expect(response.status).toBe(400)
  })

  it("rejects a tampered HMAC with 400", async () => {
    const { GET } = await loadRoute()
    const session = "a1b2c3d4e5f60718a1b2c3d4e5f60718"
    const now = Math.floor(Date.now() / 1000)
    const tgParams: Record<string, string> = {
      id: "10000",
      auth_date: String(now),
    }
    const goodHash = signPayload(tgParams, FAKE_BOT_TOKEN)
    tgParams.hash = goodHash.slice(0, -1) + (goodHash.endsWith("0") ? "1" : "0")

    const response = await GET(
      buildRequest({ session, ...tgParams }) as never,
    )
    expect(response.status).toBe(400)
  })

  it("rejects an expired auth_date with 400", async () => {
    const { GET } = await loadRoute()
    const session = "a1b2c3d4e5f60718a1b2c3d4e5f60718"
    const now = Math.floor(Date.now() / 1000)
    const stale = now - 600
    const tgParams: Record<string, string> = {
      id: "10000",
      auth_date: String(stale),
    }
    tgParams.hash = signPayload(tgParams, FAKE_BOT_TOKEN)

    const response = await GET(
      buildRequest({ session, ...tgParams }) as never,
    )
    expect(response.status).toBe(400)
  })

  it("returns 500 when TELEGRAM_BOT_TOKEN is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    const { GET } = await loadRoute()
    const response = await GET(
      buildRequest({ session: "a1b2c3d4e5f60718a1b2c3d4e5f60718" }) as never,
    )
    expect(response.status).toBe(500)
  })


  it("rejects partial auth payloads with 400", async () => {
    const { GET } = await loadRoute()
    const session = "a1b2c3d4e5f60718a1b2c3d4e5f60718"

    const response = await GET(
      buildRequest({ session, id: "10000" }) as never,
    )
    expect(response.status).toBe(400)
  })
  it("redirects without cookie when user declined LoginUrl (no hash param)", async () => {
    // Telegram's LoginUrl button: when the user taps and then declines
    // the consent prompt, Telegram redirects to our URL with NO auth
    // params at all. We must NOT 400 — that dead-ends the handoff.
    // Instead redirect to /recap and let AuthGate handle Google sign-in.
    const { GET } = await loadRoute()
    const session = "a1b2c3d4e5f60718a1b2c3d4e5f60718"

    const response = await GET(buildRequest({ session }) as never)
    expect(response.status).toBe(302)
    const location = response.headers.get("location") ?? ""
    expect(location).toContain(`/recap/${session}`)
    expect(location).toContain(`next=%2Frecap%2F${session}`)
    expect(location).toContain("from=telegram")
    // No correlation cookie — we have no Telegram-attested identity.
    const setCookie = response.headers.get("set-cookie") ?? ""
    expect(setCookie).not.toContain("sophia-telegram-handoff")
  })
})

// ---------------------------------------------------------------------------
// AuthGate same-origin redirect helpers
// ---------------------------------------------------------------------------

describe("isSafeReturnPath", () => {
  it("accepts simple absolute paths", () => {
    expect(isSafeReturnPath("/")).toBe(true)
    expect(isSafeReturnPath("/recap/abc")).toBe(true)
    expect(isSafeReturnPath("/path?q=1&r=2")).toBe(true)
  })

  it("rejects protocol-relative URLs", () => {
    expect(isSafeReturnPath("//evil.com")).toBe(false)
    expect(isSafeReturnPath("/\\evil.com")).toBe(false)
  })

  it("rejects backslash injection", () => {
    expect(isSafeReturnPath("/foo\\..\\bar")).toBe(false)
    expect(isSafeReturnPath("/\\\\evil.com")).toBe(false)
  })

  it("rejects scheme-prefixed URLs", () => {
    expect(isSafeReturnPath("https://evil.com")).toBe(false)
    expect(isSafeReturnPath("javascript:alert(1)")).toBe(false)
  })

  it("rejects empty / null / non-string", () => {
    expect(isSafeReturnPath("")).toBe(false)
    expect(isSafeReturnPath(null)).toBe(false)
    expect(isSafeReturnPath(undefined)).toBe(false)
  })

  it("rejects values longer than 256 chars", () => {
    expect(isSafeReturnPath("/" + "a".repeat(256))).toBe(false)
    expect(isSafeReturnPath("/" + "a".repeat(254))).toBe(true)
  })
})

describe("resolveSafeCallbackURL", () => {
  const ORIGINAL_LOCATION = window.location

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: ORIGINAL_LOCATION,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: ORIGINAL_LOCATION,
    })
  })

  function setLocation(href: string, pathname: string, search: string) {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href, pathname, search } as Location,
    })
  }

  it("uses ?next= when same-origin path-only", () => {
    setLocation(
      "https://app.example.com/recap/abc?next=%2Frecap%2Fabc",
      "/recap/abc",
      "?next=%2Frecap%2Fabc",
    )
    expect(resolveSafeCallbackURL()).toBe("/recap/abc")
  })

  it("falls back to current pathname (without query) when no ?next", () => {
    setLocation(
      "https://app.example.com/recap/xyz?other=1",
      "/recap/xyz",
      "?other=1",
    )
    expect(resolveSafeCallbackURL()).toBe("/recap/xyz")
  })

  it("falls back to / when on the root", () => {
    setLocation("https://app.example.com/", "/", "")
    expect(resolveSafeCallbackURL()).toBe("/")
  })

  it("drops unsafe ?next values", () => {
    setLocation(
      "https://app.example.com/?next=https%3A%2F%2Fevil.com",
      "/",
      "?next=https%3A%2F%2Fevil.com",
    )
    expect(resolveSafeCallbackURL()).toBe("/")
  })

  it("drops protocol-relative ?next values", () => {
    setLocation(
      "https://app.example.com/?next=%2F%2Fevil.com",
      "/",
      "?next=%2F%2Fevil.com",
    )
    expect(resolveSafeCallbackURL()).toBe("/")
  })
})
