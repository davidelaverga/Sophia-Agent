import crypto from "crypto"

import { describe, expect, it } from "vitest"

import {
  isSafeSessionId,
  verifyTelegramAuth,
} from "../../app/api/auth/_lib/telegram-verify"

const FAKE_BOT_TOKEN = "1234567:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"

function signPayload(
  params: Record<string, string>,
  botToken: string,
): string {
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
    // Flip a single nibble.
    params.hash = goodHash.slice(0, -1) + (goodHash.endsWith("0") ? "1" : "0")

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid_hash")
    }
  })

  it("rejects a payload signed with a different bot token", () => {
    const now = Math.floor(Date.now() / 1000)
    const params: Record<string, string> = {
      id: "10000",
      auth_date: String(now),
    }
    params.hash = signPayload(params, "wrong-bot-token")

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_hash")
  })

  it("rejects when auth_date is older than 5 minutes", () => {
    const now = Math.floor(Date.now() / 1000)
    const stale = now - 301
    const params: Record<string, string> = {
      id: "10000",
      auth_date: String(stale),
    }
    params.hash = signPayload(params, FAKE_BOT_TOKEN)

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("expired")
  })

  it("rejects when missing required fields", () => {
    expect(verifyTelegramAuth({ id: "1", auth_date: "0" }, FAKE_BOT_TOKEN).ok).toBe(false)
    expect(verifyTelegramAuth({ hash: "x", auth_date: "0" }, FAKE_BOT_TOKEN).ok).toBe(false)
    expect(verifyTelegramAuth({ id: "1", hash: "x" }, FAKE_BOT_TOKEN).ok).toBe(false)
  })

  it("rejects when bot token is empty", () => {
    const result = verifyTelegramAuth({ id: "1", auth_date: "0", hash: "x" }, "")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("missing_bot_token")
  })

  it("rejects mismatched-length hashes without throwing", () => {
    const now = Math.floor(Date.now() / 1000)
    const result = verifyTelegramAuth(
      {
        id: "1",
        auth_date: String(now),
        hash: "deadbeef",
      },
      FAKE_BOT_TOKEN,
      now,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_hash")
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

    const result = verifyTelegramAuth(params, FAKE_BOT_TOKEN, now)
    expect(result.ok).toBe(true)
  })
})

describe("isSafeSessionId", () => {
  it("accepts UUID-shaped hex", () => {
    expect(isSafeSessionId("a1b2c3d4e5f60718a1b2c3d4e5f60718")).toBe(true)
    expect(isSafeSessionId("a1b2c3d4-e5f6-0718-a1b2-c3d4e5f60718")).toBe(true)
  })

  it("rejects values that are too short or too long", () => {
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
