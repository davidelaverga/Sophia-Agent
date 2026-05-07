import crypto from "crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ORIGINAL_ENV = { ...process.env }
const FAKE_BOT_TOKEN = "1234567:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"

function signPayload(params: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.entries(params)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const secretKey = crypto.createHash("sha256").update(botToken).digest()
  return crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")
}

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
    // Short-lived correlation cookie was set.
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
})
