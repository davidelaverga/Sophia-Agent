import { describe, expect, it } from "vitest"

import { parseUsageLimitFromError, parseUsageLimitPayload } from "../../app/lib/usage-limit-parser"

describe("usage-limit-parser", () => {
  it("parses structured backend usage payload", () => {
    const parsed = parseUsageLimitPayload({
      error: "USAGE_LIMIT_REACHED",
      reason: "voice",
      plan_tier: "FREE",
      limit: 600,
      used: 600,
      message: "Voice daily limit reached",
      remaining: 0,
      estimated_seconds: 120,
    }, 429)

    expect(parsed).not.toBeNull()
    expect(parsed?.info.reason).toBe("voice")
    expect(parsed?.info.limit).toBe(600)
    expect(parsed?.info.used).toBe(600)
    expect(parsed?.remaining).toBe(0)
    expect(parsed?.estimatedSeconds).toBe(120)
  })

  it("parses ai-sdk style error message with embedded json", () => {
    const error = {
      message: 'Request failed: {"error":"Rate limit exceeded","code":"RATE_LIMIT_EXCEEDED","backend_status":429}',
      status: 429,
    }

    const parsed = parseUsageLimitFromError(error)

    expect(parsed).not.toBeNull()
    expect(parsed?.info.reason).toBe("text")
    expect(parsed?.status).toBe(429)
  })
})
