import type { PlanTier, UsageLimitError, UsageLimitInfo, UsageLimitReason } from "../types/rate-limits"

export type ParsedUsageLimit = {
  info: UsageLimitInfo
  message: string
  remaining?: number
  estimatedSeconds?: number
  status?: number
  body?: string
}

const RATE_LIMIT_CODES = new Set(["RATE_LIMIT", "RATE_LIMIT_EXCEEDED", "USAGE_LIMIT_REACHED", "4429", "429"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "")

const inferReason = (value: unknown): UsageLimitReason => {
  const normalized = asText(value).toLowerCase()
  if (normalized.includes("voice")) return "voice"
  if (normalized.includes("reflect")) return "reflections"
  return "text"
}

const inferPlanTier = (value: unknown): PlanTier => {
  const normalized = asText(value).toUpperCase()
  return normalized === "FOUNDING_SUPPORTER" ? "FOUNDING_SUPPORTER" : "FREE"
}

const parseJsonLike = (value: string): unknown | null => {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    const firstBrace = trimmed.indexOf("{")
    const lastBrace = trimmed.lastIndexOf("}")
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

const looksLikeRateLimitText = (value: string): boolean => {
  const normalized = value.toLowerCase()
  return (
    normalized.includes("rate limit") ||
    normalized.includes("usage limit") ||
    normalized.includes("too many") ||
    normalized.includes("limit exceeded") ||
    normalized.includes("429")
  )
}

export function parseUsageLimitPayload(payload: unknown, status?: number): ParsedUsageLimit | null {
  if (!isRecord(payload)) return null

  const errorValue = asText(payload.error)
  const codeValue = payload.code
  const codeText = typeof codeValue === "string" ? codeValue.toUpperCase() : String(codeValue ?? "")
  const detailValue = asText(payload.detail)
  const messageValue = asText(payload.message)
  const statusValue = asNumber(payload.status) ?? asNumber(payload.backend_status) ?? status
  const combinedText = `${errorValue} ${detailValue} ${messageValue} ${codeText}`.trim()

  const isRateByCode = RATE_LIMIT_CODES.has(codeText)
  const isRateByError = errorValue.toUpperCase() === "USAGE_LIMIT_REACHED"
  const isRateByStatus = statusValue === 429 || statusValue === 403
  const isRateByText = looksLikeRateLimitText(combinedText)

  if (!isRateByCode && !isRateByError && !isRateByStatus && !isRateByText) {
    return null
  }

  const reason = inferReason(payload.reason ?? combinedText)
  const planTier = inferPlanTier(payload.plan_tier)
  const limit = asNumber(payload.limit) ?? 0
  const remaining = asNumber(payload.remaining)
  const used = asNumber(payload.used) ?? (typeof remaining === "number" && limit > 0 ? Math.max(0, limit - remaining) : limit)
  const estimatedSeconds =
    asNumber(payload.estimated_seconds) ??
    asNumber(payload.retry_after_seconds) ??
    asNumber(payload.retry_after)

  return {
    info: {
      reason,
      plan_tier: planTier,
      limit,
      used,
    },
    message: messageValue || detailValue || errorValue || "Usage limit reached",
    remaining,
    estimatedSeconds,
    status: statusValue,
    body: JSON.stringify(payload),
  }
}

export function parseUsageLimitFromError(error: unknown): ParsedUsageLimit | null {
  const candidates: Array<{ payload: unknown; status?: number }> = []

  if (isRecord(error)) {
    const status = asNumber(error.status)
    candidates.push({ payload: error, status })

    const nestedKeys = ["cause", "data", "body", "response", "error"] as const
    for (const key of nestedKeys) {
      const nested = error[key]
      if (isRecord(nested)) {
        candidates.push({ payload: nested, status })
      } else if (typeof nested === "string") {
        const parsed = parseJsonLike(nested)
        if (parsed) {
          candidates.push({ payload: parsed, status })
        }
      }
    }

    const message = asText(error.message)
    if (message) {
      const parsed = parseJsonLike(message)
      if (parsed) {
        candidates.push({ payload: parsed, status })
      }
    }
  }

  if (typeof error === "string") {
    const parsed = parseJsonLike(error)
    if (parsed) {
      candidates.push({ payload: parsed })
    }
  }

  for (const candidate of candidates) {
    const parsed = parseUsageLimitPayload(candidate.payload, candidate.status)
    if (parsed) return parsed
  }

  const fallbackText =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : isRecord(error)
          ? `${asText(error.error)} ${asText(error.detail)} ${asText(error.message)}`.trim()
          : ""

  if (!looksLikeRateLimitText(fallbackText)) return null

  return {
    info: {
      reason: inferReason(fallbackText),
      plan_tier: "FREE",
      limit: 0,
      used: 0,
    },
    message: fallbackText || "Usage limit reached",
  }
}

export function toUsageLimitError(parsed: ParsedUsageLimit): UsageLimitError {
  return {
    error: "USAGE_LIMIT_REACHED",
    reason: parsed.info.reason,
    plan_tier: parsed.info.plan_tier,
    limit: parsed.info.limit,
    used: parsed.info.used,
    message: parsed.message,
    body: parsed.body,
  }
}