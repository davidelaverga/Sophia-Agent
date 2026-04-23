import type {
  VoiceDeveloperMetrics,
  VoiceTelemetryBaselineEntry,
} from "./voice-runtime-metrics"

const STORAGE_KEY = "sophia.voice-telemetry-baseline.v1"
const STORAGE_VERSION = 1
const MAX_BASELINE_ENTRIES = 18

type PersistedVoiceTelemetryBaselineStore = {
  version: number
  entries: VoiceTelemetryBaselineEntry[]
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeBaselineEntry(value: unknown): VoiceTelemetryBaselineEntry | null {
  const entry = asRecord(value)
  const metrics = asRecord(entry?.metrics)
  const runKey = asString(entry?.runKey)
  const recordedAt = asString(entry?.recordedAt)

  if (!entry || !metrics || !runKey || !recordedAt) {
    return null
  }

  return {
    runKey,
    recordedAt,
    sessionId: asString(entry.sessionId),
    runId: asString(entry.runId),
    activeRunStartedAt: asString(entry.activeRunStartedAt),
    metrics: {
      sessionReadyMs: isFiniteNumber(metrics.sessionReadyMs) ? metrics.sessionReadyMs : null,
      joinLatencyMs: isFiniteNumber(metrics.joinLatencyMs) ? metrics.joinLatencyMs : null,
      requestStartToFirstTextMs: isFiniteNumber(metrics.requestStartToFirstTextMs) ? metrics.requestStartToFirstTextMs : null,
      bindToPlaybackStartMs: isFiniteNumber(metrics.bindToPlaybackStartMs) ? metrics.bindToPlaybackStartMs : null,
      subscriberRoundTripTimeMs: isFiniteNumber(metrics.subscriberRoundTripTimeMs) ? metrics.subscriberRoundTripTimeMs : null,
      subscriberJitterMs: isFiniteNumber(metrics.subscriberJitterMs) ? metrics.subscriberJitterMs : null,
      subscriberPacketLossPct: isFiniteNumber(metrics.subscriberPacketLossPct) ? metrics.subscriberPacketLossPct : null,
    },
  }
}

function readStore(): PersistedVoiceTelemetryBaselineStore {
  if (typeof window === "undefined") {
    return { version: STORAGE_VERSION, entries: [] }
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY)
    if (!rawValue) {
      return { version: STORAGE_VERSION, entries: [] }
    }

    const parsed = JSON.parse(rawValue) as unknown
    const record = asRecord(parsed)
    const entries = Array.isArray(record?.entries)
      ? record.entries
        .map((entry) => normalizeBaselineEntry(entry))
        .filter((entry): entry is VoiceTelemetryBaselineEntry => entry !== null)
      : []

    return {
      version: STORAGE_VERSION,
      entries,
    }
  } catch {
    return { version: STORAGE_VERSION, entries: [] }
  }
}

function writeStore(entries: VoiceTelemetryBaselineEntry[]): void {
  if (typeof window === "undefined") {
    return
  }

  const persistedEntries = [...entries]
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
    .slice(0, MAX_BASELINE_ENTRIES)

  const payload: PersistedVoiceTelemetryBaselineStore = {
    version: STORAGE_VERSION,
    entries: persistedEntries,
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

export function readVoiceTelemetryBaselineEntries(): VoiceTelemetryBaselineEntry[] {
  return readStore().entries
}

export function createVoiceTelemetryBaselineEntry(
  metrics: VoiceDeveloperMetrics,
): VoiceTelemetryBaselineEntry | null {
  const runKey = metrics.baseline.runKey
  if (!runKey) {
    return null
  }

  const hasMeaningfulMetric = [
    metrics.timings.sessionReadyMs,
    metrics.timings.joinLatencyMs,
    metrics.pipeline.requestStartToFirstTextMs,
    metrics.startup.bindToPlaybackStartMs,
    metrics.transport.webrtc.sampleCount > 0 ? 1 : null,
  ].some((value) => value !== null)

  if (!hasMeaningfulMetric) {
    return null
  }

  return {
    runKey,
    recordedAt: new Date().toISOString(),
    sessionId: metrics.sessionIds.sessionId,
    runId: metrics.sessionIds.runId,
    activeRunStartedAt: metrics.sessionIds.activeRunStartedAt,
    metrics: {
      sessionReadyMs: metrics.timings.sessionReadyMs,
      joinLatencyMs: metrics.timings.joinLatencyMs,
      requestStartToFirstTextMs: metrics.pipeline.requestStartToFirstTextMs,
      bindToPlaybackStartMs: metrics.startup.bindToPlaybackStartMs,
      subscriberRoundTripTimeMs: metrics.transport.webrtc.subscriber.averageRoundTripTimeMs
        ?? metrics.transport.webrtc.subscriber.lastRoundTripTimeMs,
      subscriberJitterMs: metrics.transport.webrtc.subscriber.averageJitterMs
        ?? metrics.transport.webrtc.subscriber.lastJitterMs,
      subscriberPacketLossPct: metrics.transport.webrtc.subscriber.averagePacketLossPct
        ?? metrics.transport.webrtc.subscriber.lastPacketLossPct,
    },
  }
}

export function upsertVoiceTelemetryBaselineEntry(
  entry: VoiceTelemetryBaselineEntry | null,
): void {
  if (!entry) {
    return
  }

  const existingEntries = readStore().entries
  const nextEntries = existingEntries.filter((candidate) => candidate.runKey !== entry.runKey)
  nextEntries.unshift(entry)
  writeStore(nextEntries)
}

export function clearVoiceTelemetryBaselineEntries(): void {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.removeItem(STORAGE_KEY)
}