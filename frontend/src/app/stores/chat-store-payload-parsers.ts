import { asRecord, readString } from "../lib/record-parsers"
import type { UsageLimitReason } from "../types/rate-limits"

import type { BackendUsageData } from "./usage-limit-store"

export type FeedbackGateMeta = {
  turnId: string
  allowed: boolean
  emotionalWeight: number | null
}

export type PresenceMeta = {
  status: string
  detail?: string
}

type DonePayloadParsed = {
  message?: string
  audioUrl?: string
  conversationId?: string
  turnId: string
  usage?: BackendUsageData
}

function readStringAlias(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key)
    if (value) return value
  }
  return undefined
}

function hasNumber(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "number"
}

function isBackendUsageData(value: unknown): value is BackendUsageData {
  const record = asRecord(value)
  if (!record) return false

  const today = asRecord(record.today)
  const limits = asRecord(record.limits)
  const remaining = asRecord(record.remaining)

  if (!today || !limits || !remaining) return false

  return (
    hasNumber(today, "text_messages") &&
    hasNumber(today, "text_tokens") &&
    hasNumber(today, "voice_seconds") &&
    hasNumber(limits, "daily_text_messages") &&
    hasNumber(limits, "daily_text_tokens") &&
    hasNumber(limits, "daily_voice_seconds") &&
    hasNumber(remaining, "text_messages") &&
    hasNumber(remaining, "text_tokens") &&
    hasNumber(remaining, "voice_seconds")
  )
}

export function parsePresenceMeta(meta: Record<string, unknown>): PresenceMeta | null {
  const rawPresence = meta.presence

  if (typeof rawPresence === "string") {
    return { status: rawPresence }
  }

  const presenceRecord = asRecord(rawPresence)
  if (presenceRecord) {
    const status = readString(presenceRecord, "status")
    if (!status) return null

    const detail = readString(presenceRecord, "detail")
    return { status, detail }
  }

  const status = readString(meta, "status")
  if (!status) return null

  const detail = readString(meta, "detail")
  return { status, detail }
}

export function parseFeedbackGateMeta(
  meta: Record<string, unknown>,
  fallbackTurnId: string,
): FeedbackGateMeta | null {
  const feedbackAllowed = meta.feedback_allowed
  if (typeof feedbackAllowed !== "boolean") return null

  return {
    turnId: readString(meta, "turn_id") ?? fallbackTurnId,
    allowed: feedbackAllowed,
    emotionalWeight: typeof meta.emotional_weight === "number" ? meta.emotional_weight : null,
  }
}

export function parseUsageLimitInfoMeta(meta: Record<string, unknown>): {
  reason: UsageLimitReason
  plan_tier: "FOUNDING_SUPPORTER" | "FREE"
  limit: number
  used: number
} | null {
  const usageInfo = asRecord(meta.usage_info)
  if (!usageInfo) return null

  const used = typeof usageInfo.used === "number" ? usageInfo.used : 0
  const limit = typeof usageInfo.limit === "number" ? usageInfo.limit : 0

  const reason: UsageLimitReason =
    usageInfo.reason === "voice" || usageInfo.reason === "reflections" ? usageInfo.reason : "text"
  const plan_tier = usageInfo.plan_tier === "FOUNDING_SUPPORTER" ? "FOUNDING_SUPPORTER" : "FREE"

  return {
    reason,
    plan_tier,
    limit,
    used,
  }
}

export function parseDonePayload(payload: unknown, fallbackTurnId: string): DonePayloadParsed {
  const payloadRecord = asRecord(payload)
  if (!payloadRecord) {
    return { turnId: fallbackTurnId }
  }

  return {
    message: readString(payloadRecord, "message"),
    audioUrl: readStringAlias(payloadRecord, ["audioUrl", "audio_url"]),
    conversationId: readStringAlias(payloadRecord, ["conversationId", "conversation_id"]),
    turnId: readString(payloadRecord, "turn_id") ?? fallbackTurnId,
    usage: isBackendUsageData(payloadRecord.usage) ? payloadRecord.usage : undefined,
  }
}