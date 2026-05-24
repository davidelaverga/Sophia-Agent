import type { BuilderTaskV1 } from "../types/builder-task"

import type {
  SophiaCaptureMicrophoneSummary,
  SophiaCaptureSnapshot,
} from "./session-capture"
import type { SessionRuntime, VoiceRuntimeTelemetry, VoiceStage } from "./voice-types"

export type VoiceCaptureEvent = {
  seq: number
  recordedAt: string
  category: string
  name: string
  payload?: unknown
}

export type VoiceMetricsHealthLevel = "good" | "warn" | "bad" | "neutral"

export type VoiceTransportSource = "sse" | "custom" | "pending"

export type VoiceArtifactCountSource = "public_event" | "runtime_ingest" | "rendered_state" | "none"

export type VoiceArtifactTelemetryCounts = {
  artifactCount: number
  artifactPublicEventCount: number
  artifactRuntimeIngestCount: number
  artifactRenderedCount: number
  artifactCountSource: VoiceArtifactCountSource
  artifactCountMismatch: boolean
}

export type VoiceMetricsTimelineItem = {
  id: string
  at: string
  sinceStartMs: number | null
  label: string
  detail: string
  tone: VoiceMetricsHealthLevel
}

export type VoiceMetricThreshold = {
  label: string
  valueMs: number | null
  warnAtMs: number
  badAtMs: number
  status: VoiceMetricsHealthLevel
}

export type VoiceRegressionMarker = {
  key: "microphone" | "public-continuity" | "turn-segmentation" | "backend-stall" | "commit-boundary" | "builder-stall"
  title: string
  detail: string
  level: "warn" | "bad"
}

export type VoiceStartupMetrics = {
  requestToCredentialsMs: number | null
  credentialsToJoinMs: number | null
  joinToReadyMs: number | null
  joinToRemoteAudioMs: number | null
  startToMicAudioMs: number | null
  startToFirstUserTranscriptMs: number | null
}

export type VoicePipelineMetrics = {
  micToUserTranscriptMs: number | null
  transcriptToUserEndedMs: number | null
  committedTurnCloseMs: number | null
  userEndedToRequestStartMs: number | null
  submissionStabilizationMs: number | null
  requestStartToFirstBackendEventMs: number | null
  firstBackendEventToFirstTextMs: number | null
  requestStartToFirstTextMs: number | null
  userEndedToAgentStartMs: number | null
  userEndedToFirstTextMs: number | null
  rawSpeechEndToFirstTextMs: number | null
  firstTextToBackendCompleteMs: number | null
  backendToFirstAudioMs: number | null
  textToFirstAudioMs: number | null
  rawSpeechEndToBackendCompleteMs: number | null
  rawSpeechEndToFirstAudioMs: number | null
}

export type VoiceEventCounters = {
  total: number
  voiceSse: number
  streamCustom: number
  voiceRuntime: number
  voiceSession: number
  harnessInput: number
  builder: number
  duplicateUserTranscriptIgnored: number
  sseErrors: number
  invalidPayloads: number
  staleConnectResponses: number
  startIgnored: number
  startupTimeouts: number
}

export type VoiceRecentTurnSummary = {
  turnId: string | null
  status: string | null
  reason: string | null
  committedTurnCloseMs: number | null
  committedTranscriptToAgentStartMs: number | null
  requestStartToFirstBackendEventMs: number | null
  firstTextMs: number | null
  backendCompleteMs: number | null
  firstAudioMs: number | null
  falseUserEndedCount: number | null
  duplicatePhaseTotal: number
  userTranscriptChars: number | null
  assistantTranscriptChars: number | null
}

export type VoiceBottleneckDiagnosis = {
  kind:
    | "idle"
    | "healthy"
    | "startup"
    | "microphone"
    | "turn-segmentation"
    | "commit-boundary"
    | "backend"
    | "tts"
    | "transport"
  level: VoiceMetricsHealthLevel
  title: string
  detail: string
  evidence: string[]
}

export type VoiceBottleneckKind = VoiceBottleneckDiagnosis["kind"]

export type VoiceTelemetrySummary = {
  runtime: SessionRuntime
  runtimeLabel: string
  stage: VoiceStage
  healthLevel: VoiceMetricsHealthLevel
  healthTitle: string
  bottleneckKind: VoiceBottleneckKind
  bottleneckLevel: VoiceMetricsHealthLevel
  transportSource: VoiceDeveloperMetrics["transport"]["activeSource"]
  regressionKeys: VoiceRegressionMarker["key"][]
  sessionReadyMs: number | null
  joinLatencyMs: number | null
  committedResponseMs: number | null
  committedResponseSource: "committed_user_transcript" | "public_turn_event" | null
  publicTurnCloseMs: number | null
  submissionStabilizationMs: number | null
  committedFirstTextMs: number | null
  rawFirstTextMs: number | null
  rawBackendCompleteMs: number | null
  rawFirstAudioMs: number | null
  responseWindowMs: number | null
  builderPhase: BuilderTaskV1["phase"] | null
  builderProgressPercent: number | null
  builderStuck: boolean
}

export type LegacySessionTelemetry = {
  runtime: "legacy_cascade"
  runtimeLabel: "Legacy Cascade"
  source: "default" | "voice-connect" | "capture"
  legacy: {
    sessionId: string | null
    threadId: string | null
    callId: string | null
    voiceAgentSessionId: string | null
    streamUrl: string | null
    streamOpen: boolean
    activeSource: VoiceTransportSource
    remoteParticipantCount: number | null
    sessionReadyMs: number | null
    joinLatencyMs: number | null
    sseOpenMs: number | null
  }
  gemini: null
}

export type GeminiSessionTelemetry = {
  runtime: "gemini_live"
  runtimeLabel: "Gemini Live"
  source: "default" | "voice-connect" | "capture"
  legacy: null
  gemini: {
    sessionId: string | null
    streamUrl: string | null
    websocketUrl: string | null
    relayUrl: string | null
    transport: string | null
    publicEventBoundary: string | null
    connectionState: string | null
    stage: string | null
    websocketState: string | null
    relayStatus: string | null
    publicSseState: string | null
    microphoneState: string | null
    remoteAudioState: string | null
    setupComplete: boolean
    providerEventCount: number
    lastProviderEventAt: string | null
    lastProviderEventType: string | null
    providerCategoryCounts: Record<string, { count: number; lastAt: string | null }>
    outputAudioEventCount: number
    lastOutputAudioAt: string | null
    staleAssistantAudioDroppedCount: number
    staleAssistantTranscriptDroppedCount: number
    staleAssistantOutputSuppressionCount: number
    playbackGeneration: number
    assistantUserOverlapMs: number
    maxAssistantUserOverlapMs: number
    userInputActiveAgeMs: number | null
    bargeInConfirmed: boolean
    bargeInCandidateFrameCount: number
    inputFrameOnlyNotBargeInCount: number
    staleSuppressionArmedAt: string | null
    assistantAudioDropReason: string | null
    interruptedResponseIds: string[]
    interruptionCount: number
    playbackFlushCount: number
    lastInterruptionAt: string | null
    lastPlaybackFlushAt: string | null
    relayDiagnosticCount: number
    lastRelayDiagnosticAt: string | null
    lastRelayEventType: string | null
    relayAttemptCount: number
    relaySuccessCount: number
    relayFailureCount: number
    relayTraceCount: number
    relayClassificationCounts: Record<string, { count: number; lastAt: string | null }>
    lastRelayTraceAt: string | null
    lastRelayCorrelationId: string | null
    lastRelayResponseKind: string | null
    lastRelayDurationMs: number | null
    maxRelayDurationMs: number | null
    lastCriticalRelayDurationMs: number | null
    lastTranscriptionRelayDurationMs: number | null
    lastToolCallRelayDurationMs: number | null
    orderedRelayQueueDepth: number
    oldestQueuedAgeMs: number | null
    transcriptPartialsCoalesced: number
    transcriptPartialsSent: number
    transcriptPartialsDropped: number
    transcriptCoalescingDisabledReason: string | null
    finalTranscriptEventsSent: number
    nonDroppableCriticalEventsSent: number
    lastTranscriptRelayLatencyMs: number | null
    maxTranscriptRelayLatencyMs: number | null
    p95TranscriptRelayLatencyMs: number | null
    coalescedBySegment: Record<string, number>
    consecutiveRelayFailures: number
    lastRelayErrorText: string | null
    websocketDiagnosticCount: number
    lastWebSocketDiagnosticAt: string | null
    lastWebSocketErrorText: string | null
    toolCallCount: number
    toolResponseCount: number
    toolRejectionCount: number
    toolCancellationCount: number
    artifactToolCallCount: number
    artifactToolCallUnknownCount: number
    builderToolCallCount: number
    unresolvedToolCallCount: number
    oldestUnresolvedToolCallAgeMs: number | null
    lastToolPhase: string | null
    lastToolName: string | null
    lastToolAt: string | null
    toolCallLedger: Array<Record<string, unknown>>
    publicTurnCount: number
    artifactCount: number
    artifactPublicEventCount: number
    artifactRuntimeIngestCount: number
    artifactRenderedCount: number
    artifactCountSource: VoiceArtifactCountSource
    artifactCountMismatch: boolean
    publicDiagnosticCount: number
    lastUserTranscriptAt: string | null
    lastAssistantTranscriptAt: string | null
    lastEventAgeMs: number | null
  }
}

export type VoiceSessionTelemetry = LegacySessionTelemetry | GeminiSessionTelemetry

export type VoiceDeveloperMetrics = {
  stage: VoiceStage
  sessionTelemetry: VoiceSessionTelemetry
  sessionIds: {
    sessionId: string | null
    threadId: string | null
    callId: string | null
    voiceAgentSessionId: string | null
    runId: string | null
  }
  transport: {
    activeSource: VoiceTransportSource
    remoteParticipantCount: number | null
    streamOpen: boolean
    lastEventAt: string | null
  }
  counts: {
    turns: number
    userTranscripts: number
    assistantTranscripts: number
    artifacts: number
    artifactPublicEventCount: number
    artifactRuntimeIngestCount: number
    artifactRenderedCount: number
    artifactCountSource: VoiceArtifactCountSource
    artifactCountMismatch: boolean
    diagnostics: number
    builderEvents: number
  }
  timings: {
    joinLatencyMs: number | null
    sessionReadyMs: number | null
    sseOpenMs: number | null
    currentThinkingMs: number | null
    lastEventAgeMs: number | null
  }
  lastTurn: {
    turnId: string | null
    status: string | null
    reason: string | null
    backendRequestStartMs: number | null
    backendFirstEventMs: number | null
    firstTextMs: number | null
    backendCompleteMs: number | null
    firstAudioMs: number | null
    agentStartLatencyMs: number | null
    responseDurationMs: number | null
    falseUserEndedCount: number | null
    duplicatePhaseCounts: Record<string, number>
    lastUserTranscript: string | null
    lastAssistantTranscript: string | null
    lastUserTranscriptAt: string | null
    lastAssistantTranscriptAt: string | null
  }
  microphone: {
    patchInstalled: boolean
    detectedAudio: boolean
    streamCount: number
    audioTrackCount: number
    firstAudioAt: string | null
    lastAudioAt: string | null
    maxRms: number | null
    maxAbsPeak: number | null
    totalSampleWindows: number
    errorCount: number
    lastError: string | null
  }
  builder: {
    phase: BuilderTaskV1["phase"] | null
    taskId: string | null
    label: string | null
    detail: string | null
    progressPercent: number | null
    progressSource: BuilderTaskV1["progressSource"] | null
    totalSteps: number | null
    completedSteps: number | null
    inProgressSteps: number | null
    pendingSteps: number | null
    activeStepTitle: string | null
    startedAt: string | null
    completedAt: string | null
    lastUpdateAt: string | null
    lastProgressAt: string | null
    heartbeatMs: number | null
    idleMs: number | null
    stuck: boolean
    stuckReason: string | null
  }
  health: {
    level: VoiceMetricsHealthLevel
    title: string
    detail: string
  }
  thresholds: {
    sessionReady: VoiceMetricThreshold
    joinLatency: VoiceMetricThreshold
    committedResponse: VoiceMetricThreshold
    firstText: VoiceMetricThreshold
    firstAudio: VoiceMetricThreshold
    backendComplete: VoiceMetricThreshold
    responseWindow: VoiceMetricThreshold
  }
  startup: VoiceStartupMetrics
  pipeline: VoicePipelineMetrics
  events: VoiceEventCounters
  recentTurns: VoiceRecentTurnSummary[]
  bottleneck: VoiceBottleneckDiagnosis
  regressions: VoiceRegressionMarker[]
  timeline: VoiceMetricsTimelineItem[]
}

type BuildVoiceDeveloperMetricsParams = {
  stage: VoiceStage
  events: VoiceCaptureEvent[]
  snapshot?: SophiaCaptureSnapshot | null
  nowMs?: number
  runtimeError?: string
  runtimeTelemetry?: VoiceRuntimeTelemetry | null
}

type BuildVoiceDeveloperMetricsFromCaptureParams = {
  capture: {
    events: VoiceCaptureEvent[]
    snapshot?: SophiaCaptureSnapshot | null
  }
  nowMs?: number
  runtimeError?: string
  stage?: VoiceStage
  runtimeTelemetry?: VoiceRuntimeTelemetry | null
}

type NormalizedVoiceCaptureEvent = VoiceCaptureEvent & {
  atMs: number | null
  payloadRecord: Record<string, unknown> | null
  dataRecord: Record<string, unknown> | null
}

const DEFAULT_MICROPHONE: VoiceDeveloperMetrics["microphone"] = {
  patchInstalled: false,
  detectedAudio: false,
  streamCount: 0,
  audioTrackCount: 0,
  firstAudioAt: null,
  lastAudioAt: null,
  maxRms: null,
  maxAbsPeak: null,
  totalSampleWindows: 0,
  errorCount: 0,
  lastError: null,
}

const GEMINI_EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
const GEMINI_BUILDER_TOOL_NAMES = new Set([
  "start_builder_task",
  "check_async_task",
  "update_async_task",
  "cancel_async_task",
  "list_async_tasks",
])

const NULL_LIKE_ARTIFACT_STRINGS = new Set(["null", "none", "undefined", "n/a"])
const FALLBACK_ARTIFACT_TAKEAWAYS = new Set([
  "session completed",
  "companion error - fallback response",
])
const FALLBACK_ARTIFACT_REFLECTIONS = new Set([
  "what mattered most in this conversation?",
  "general reflection prompt",
  "general reflection",
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return strings.length > 0 ? strings : []
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function asRealArtifactString(value: unknown): string | null {
  const text = asString(value)
  if (!text) return null
  return NULL_LIKE_ARTIFACT_STRINGS.has(text.toLowerCase()) ? null : text
}

function hasRealArtifactTakeaway(value: unknown): boolean {
  const text = asRealArtifactString(value)
  return Boolean(text && !FALLBACK_ARTIFACT_TAKEAWAYS.has(text.toLowerCase()))
}

function hasRealArtifactReflection(value: unknown): boolean {
  const text = asRealArtifactString(value)
  return Boolean(text && !FALLBACK_ARTIFACT_REFLECTIONS.has(text.toLowerCase()))
}

function artifactReflectionPrompt(value: unknown): unknown {
  const direct = asRealArtifactString(value)
  if (direct) return direct
  return asRecord(value)?.prompt
}

function hasArtifactContent(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return false

  if (hasRealArtifactTakeaway(record.takeaway) || hasRealArtifactTakeaway(record.session_takeaway)) {
    return true
  }

  if (hasRealArtifactReflection(artifactReflectionPrompt(record.reflection_candidate ?? record.reflection))) {
    return true
  }

  return Array.isArray(record.memory_candidates) && record.memory_candidates.length > 0
}

function hasArtifactsRuntimeIngestContent(event: NormalizedVoiceCaptureEvent): boolean {
  if (event.category !== "artifacts-runtime") return false
  if (event.name !== "ingest-artifacts" && event.name !== "apply-memory-candidates") return false

  const payload = event.payloadRecord
  return hasArtifactContent(payload?.merged) || hasArtifactContent(payload?.incoming)
}

function hasRenderedArtifactSnapshot(snapshot: SophiaCaptureSnapshot | null | undefined): boolean {
  if (!snapshot) return false
  if (hasArtifactContent(snapshot.artifacts.sessionArtifacts)) return true

  const dom = snapshot.artifacts.dom
  return Boolean(
    asRealArtifactString(dom.takeawayText)
      || asRealArtifactString(dom.reflectionText)
      || asRealArtifactString(dom.memoriesText),
  )
}

function resolveArtifactCountSource({
  artifactPublicEventCount,
  artifactRuntimeIngestCount,
  artifactRenderedCount,
}: {
  artifactPublicEventCount: number
  artifactRuntimeIngestCount: number
  artifactRenderedCount: number
}): VoiceArtifactCountSource {
  const maxCount = Math.max(artifactPublicEventCount, artifactRuntimeIngestCount, artifactRenderedCount)
  if (maxCount <= 0) return "none"
  if (artifactPublicEventCount === maxCount) return "public_event"
  if (artifactRuntimeIngestCount === maxCount) return "runtime_ingest"
  return "rendered_state"
}

function getBuilderDebugDetail(payload: Record<string, unknown> | null | undefined): string | null {
  const debug = asRecord(payload?.debug)
  if (!debug) {
    return null
  }

  const blockerDetail = asString(debug.suspected_blocker_detail)
  if (blockerDetail) {
    return blockerDetail
  }

  const lastShellCommand = asRecord(debug.last_shell_command)
  if (!lastShellCommand) {
    return null
  }

  const shellError = asString(lastShellCommand.error)
  if (shellError) {
    return shellError
  }

  const shellStatus = asString(lastShellCommand.status)
  if (!shellStatus || shellStatus === "ok" || shellStatus === "nonzero_exit") {
    return null
  }

  const command = asString(lastShellCommand.requested_command)
    ?? asString(lastShellCommand.command)
    ?? asString(lastShellCommand.resolved_command)

  return command ? `Last bash command ${shellStatus}: ${command}` : `Last bash command ${shellStatus}.`
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function diffMs(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null) return null
  const delta = endMs - startMs
  return Number.isFinite(delta) && delta >= 0 ? delta : null
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return index
    }
  }

  return -1
}

function findLast<T>(values: T[], predicate: (value: T) => boolean): T | null {
  const index = findLastIndex(values, predicate)
  return index >= 0 ? values[index] : null
}

function findFirst<T>(values: T[], predicate: (value: T) => boolean): T | null {
  for (const value of values) {
    if (predicate(value)) {
      return value
    }
  }

  return null
}

function countWhere<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0)
}

function normalizeEvent(event: VoiceCaptureEvent): NormalizedVoiceCaptureEvent {
  const payloadRecord = asRecord(event.payload)
  const dataRecord = asRecord(payloadRecord?.data)

  return {
    ...event,
    atMs: parseTimestampMs(event.recordedAt),
    payloadRecord,
    dataRecord,
  }
}

function buildArtifactTelemetryCountsFromEvents(
  activeEvents: NormalizedVoiceCaptureEvent[],
  snapshot: SophiaCaptureSnapshot | null | undefined,
): VoiceArtifactTelemetryCounts {
  const artifactPublicEventCount = countWhere(activeEvents, (event) => event.name === "sophia.artifact")
  const artifactRuntimeIngestCount = countWhere(activeEvents, hasArtifactsRuntimeIngestContent)
  const artifactRenderedCount = hasRenderedArtifactSnapshot(snapshot) ? 1 : 0
  const artifactCount = Math.max(artifactPublicEventCount, artifactRuntimeIngestCount, artifactRenderedCount)
  const artifactCountSource = resolveArtifactCountSource({
    artifactPublicEventCount,
    artifactRuntimeIngestCount,
    artifactRenderedCount,
  })

  return {
    artifactCount,
    artifactPublicEventCount,
    artifactRuntimeIngestCount,
    artifactRenderedCount,
    artifactCountSource,
    artifactCountMismatch: artifactCount !== artifactPublicEventCount,
  }
}

export function buildVoiceArtifactTelemetryCounts({
  events,
  snapshot,
}: {
  events: VoiceCaptureEvent[]
  snapshot?: SophiaCaptureSnapshot | null
}): VoiceArtifactTelemetryCounts {
  return buildArtifactTelemetryCountsFromEvents(events.map(normalizeEvent), snapshot ?? null)
}

function eventData(event: NormalizedVoiceCaptureEvent): Record<string, unknown> | null {
  return event.dataRecord ?? event.payloadRecord
}

function eventPhase(event: NormalizedVoiceCaptureEvent): string | null {
  const data = eventData(event)
  return asString(data?.phase) ?? asString(data?.status)
}

function geminiToolName(event: NormalizedVoiceCaptureEvent): string | null {
  const data = eventData(event)
  const diagnostic = asRecord(data?.diagnostic)
  const toolCall = asRecord(diagnostic?.toolCall)
  return asString(data?.toolName) ?? asString(toolCall?.name)
}

function asVoiceStage(value: string | null): VoiceStage | null {
  switch (value) {
    case "idle":
    case "connecting":
    case "listening":
    case "thinking":
    case "speaking":
    case "error":
      return value
    default:
      return null
  }
}

function latestValue(events: NormalizedVoiceCaptureEvent[], keys: string[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const data = eventData(event)

    for (const key of keys) {
      const value = asString(data?.[key]) ?? asString(event.payloadRecord?.[key])
      if (value) return value
    }
  }

  return null
}

function latestNumber(events: NormalizedVoiceCaptureEvent[], keys: string[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const data = eventData(event)

    for (const key of keys) {
      const value = asFiniteNumber(data?.[key]) ?? asFiniteNumber(event.payloadRecord?.[key])
      if (value !== null) return value
    }
  }

  return null
}

function asSessionRuntime(value: string | null): SessionRuntime | null {
  switch (value) {
    case "legacy_cascade":
    case "gemini_live":
      return value
    default:
      return null
  }
}

function latestPayloadForEvent(events: NormalizedVoiceCaptureEvent[], name: string): Record<string, unknown> | null {
  const event = findLast(events, (entry) => entry.name === name)
  return event ? eventData(event) : null
}

function latestNestedDiagnostic(events: NormalizedVoiceCaptureEvent[], name: string): Record<string, unknown> | null {
  const payload = latestPayloadForEvent(events, name)
  return asRecord(payload?.diagnostic)
}

function latestEventAt(events: NormalizedVoiceCaptureEvent[], name: string): string | null {
  return findLast(events, (event) => event.name === name)?.recordedAt ?? null
}

function latestGeminiToolCallLedger(events: NormalizedVoiceCaptureEvent[]): Array<Record<string, unknown>> {
  const entriesById = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    if (event.name !== "gemini-tool-call-ledger") {
      continue
    }
    const entry = asRecord(eventData(event)?.entry)
    const toolCallId = asString(entry?.toolCallId)
    if (!entry || !toolCallId) {
      continue
    }
    entriesById.set(toolCallId, entry)
  }
  return [...entriesById.values()].slice(-25)
}

function asGeminiCategoryCounts(value: unknown): Record<string, { count: number; lastAt: string | null }> {
  const record = asRecord(value)
  if (!record) {
    return {}
  }
  const counts: Record<string, { count: number; lastAt: string | null }> = {}
  for (const [category, counterValue] of Object.entries(record)) {
    const counter = asRecord(counterValue)
    if (!counter) {
      continue
    }
    counts[category] = {
      count: asFiniteNumber(counter.count) ?? 0,
      lastAt: asString(counter.lastAt),
    }
  }
  return counts
}

function asNumericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value)
  if (!record) {
    return {}
  }
  const numeric: Record<string, number> = {}
  for (const [key, entry] of Object.entries(record)) {
    const count = asFiniteNumber(entry)
    if (count !== null) {
      numeric[key] = count
    }
  }
  return numeric
}

function geminiProviderCategoryCount(
  events: NormalizedVoiceCaptureEvent[],
  runtimeTelemetry: VoiceRuntimeTelemetry | null | undefined,
  category: string,
): number {
  let count = runtimeTelemetry?.runtime === "gemini_live"
    ? runtimeTelemetry.providerCategoryCounts[category]?.count ?? 0
    : 0

  for (const event of events) {
    if (event.name !== "gemini-provider-event-correlation") {
      continue
    }
    const telemetry = asRecord(eventData(event)?.telemetry)
    const categoryCounts = asGeminiCategoryCounts(telemetry?.categoryCounts)
    count = Math.max(count, categoryCounts[category]?.count ?? 0)
  }

  return count
}

function maxFiniteFromRecords(records: Record<string, unknown>[], key: string): number | null {
  let maxValue: number | null = null
  for (const record of records) {
    const value = asFiniteNumber(record[key])
    if (value === null) {
      continue
    }
    maxValue = maxValue === null ? value : Math.max(maxValue, value)
  }
  return maxValue
}

function latestRelayDurationFor(
  records: Record<string, unknown>[],
  predicate: (record: Record<string, unknown>) => boolean,
): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (!predicate(record)) {
      continue
    }
    const value = asFiniteNumber(record.durationMs)
    if (value !== null) {
      return value
    }
  }
  return null
}

function latestRuntimeFromCapture(events: NormalizedVoiceCaptureEvent[]): SessionRuntime | null {
  return asSessionRuntime(latestValue(events, ["runtime", "voice_runtime"]))
    ?? (latestValue(events, ["callType"]) === "gemini_live" ? "gemini_live" : null)
}

function derivePublicSseState(events: NormalizedVoiceCaptureEvent[]): GeminiSessionTelemetry["gemini"]["publicSseState"] {
  const openIndex = findLastIndex(events, (event) => event.name === "stream-open")
  const errorIndex = findLastIndex(events, (event) => event.name === "stream-error")

  if (errorIndex > openIndex) {
    return "error"
  }

  return openIndex >= 0 ? "connected" : "disconnected"
}

function deriveGeminiWebSocketState(stage: string | null): GeminiSessionTelemetry["gemini"]["websocketState"] {
  switch (stage) {
    case "opening_websocket":
      return "connecting"
    case "sending_setup":
    case "waiting_setup_complete":
      return "setup_pending"
    case "connected":
    case "streaming_audio":
      return "connected"
    case "closed":
      return "closed"
    default:
      return null
  }
}

function buildSessionTelemetry(params: {
  runtimeTelemetry?: VoiceRuntimeTelemetry | null
  activeEvents: NormalizedVoiceCaptureEvent[]
  sessionIds: VoiceDeveloperMetrics["sessionIds"]
  transport: VoiceDeveloperMetrics["transport"]
  timings: VoiceDeveloperMetrics["timings"]
  counts: VoiceDeveloperMetrics["counts"]
  lastTurn: VoiceDeveloperMetrics["lastTurn"]
  nowMs: number
}): VoiceSessionTelemetry {
  const { runtimeTelemetry, activeEvents, sessionIds, transport, timings, counts, lastTurn, nowMs } = params
  const captureRuntime = latestRuntimeFromCapture(activeEvents)
  const runtime = runtimeTelemetry?.runtime ?? captureRuntime ?? "legacy_cascade"
  const source = runtimeTelemetry?.runtime === runtime
    ? runtimeTelemetry.source
    : captureRuntime === runtime
      ? "capture"
      : "default"

  if (runtime === "gemini_live") {
    const hookTelemetry = runtimeTelemetry?.runtime === "gemini_live" ? runtimeTelemetry : null
    const stagePayload = latestPayloadForEvent(activeEvents, "gemini-stage-changed")
    const relayStatusPayload = latestPayloadForEvent(activeEvents, "gemini-relay-status")
    const relayDiagnostic = latestNestedDiagnostic(activeEvents, "gemini-relay-diagnostic")
    const relayTracePayload = latestPayloadForEvent(activeEvents, "gemini-relay-trace")
    const relayTrace = asRecord(relayTracePayload?.trace)
    const relayThroughput = asRecord(relayTrace?.throughput)
    const websocketDiagnostic = latestNestedDiagnostic(activeEvents, "gemini-websocket-diagnostic")
    const interruptionDiagnostic = latestNestedDiagnostic(activeEvents, "gemini-interruption")
    const staleSuppressionDiagnostics = activeEvents
      .filter((event) => event.name === "gemini-stale-output-suppressed")
      .map((event) => asRecord(asRecord(event.payload)?.diagnostic))
      .filter((diagnostic): diagnostic is Record<string, unknown> => diagnostic !== null)
    const inputAudioDiagnostics = activeEvents
      .filter((event) => event.name === "gemini-input-audio-activity")
      .map((event) => asRecord(asRecord(event.payload)?.diagnostic))
      .filter((diagnostic): diagnostic is Record<string, unknown> => diagnostic !== null)
    const toolDiagnostic = latestNestedDiagnostic(activeEvents, "gemini-tool-loop-diagnostic")
    const providerPayload = latestPayloadForEvent(activeEvents, "gemini-provider-event")
    const providerCorrelationPayload = latestPayloadForEvent(activeEvents, "gemini-provider-event-correlation")
    const providerTelemetry = asRecord(providerCorrelationPayload?.telemetry)
    const relayTraces = activeEvents
      .filter((event) => event.name === "gemini-relay-trace")
      .map((event) => asRecord(asRecord(event.payload)?.trace))
      .filter((trace): trace is Record<string, unknown> => trace !== null)
    const ledgerEntries = latestGeminiToolCallLedger(activeEvents)
    const unresolvedToolEntries = ledgerEntries.filter((entry) => asString(entry.finalState) === "unknown")
    const oldestUnresolvedToolCallAtMs = unresolvedToolEntries.reduce<number | null>((oldest, entry) => {
      const receivedAt = asString(entry.receivedAt)
      const parsed = receivedAt ? Date.parse(receivedAt) : Number.NaN
      if (!Number.isFinite(parsed)) return oldest
      return oldest === null ? parsed : Math.min(oldest, parsed)
    }, null)
    const staleSuppressionCount = Math.max(
      hookTelemetry?.staleAssistantOutputSuppressionCount ?? 0,
      staleSuppressionDiagnostics.length + countWhere(activeEvents, (event) => event.name === "stale-assistant-transcript-ignored"),
    )
    const staleAssistantAudioDroppedCount = Math.max(
      hookTelemetry?.staleAssistantAudioDroppedCount ?? 0,
      staleSuppressionDiagnostics.filter((diagnostic) => asString(diagnostic.outputType) === "audio").length,
    )
    const staleAssistantTranscriptDroppedCount = Math.max(
      hookTelemetry?.staleAssistantTranscriptDroppedCount ?? 0,
      staleSuppressionDiagnostics.filter((diagnostic) => asString(diagnostic.outputType) === "transcript").length,
      countWhere(activeEvents, (event) => event.name === "stale-assistant-transcript-ignored"),
    )
    const playbackGeneration = Math.max(
      hookTelemetry?.playbackGeneration ?? 0,
      asFiniteNumber(interruptionDiagnostic?.playbackGeneration) ?? 0,
      maxFiniteFromRecords(staleSuppressionDiagnostics, "playbackGeneration") ?? 0,
    )
    const assistantUserOverlapMs = Math.max(
      hookTelemetry?.assistantUserOverlapMs ?? 0,
      asFiniteNumber(interruptionDiagnostic?.assistantUserOverlapMs) ?? 0,
    )
    const latestInputAudioDiagnostic = inputAudioDiagnostics.at(-1)
    const latestSuppressedAudioDiagnostic = staleSuppressionDiagnostics
      .filter((diagnostic) => asString(diagnostic.outputType) === "audio")
      .at(-1)
    const inputFrameOnlyNotBargeInCount = Math.max(
      maxFiniteFromRecords(inputAudioDiagnostics, "inputFrameOnlyNotBargeInCount") ?? 0,
      maxFiniteFromRecords(staleSuppressionDiagnostics, "inputFrameOnlyNotBargeInCount") ?? 0,
      inputAudioDiagnostics.filter((diagnostic) => asString(diagnostic.suppressionDeferredReason) === "input_frame_only_not_barge_in").length,
    )
    const bargeInCandidateFrameCount = maxFiniteFromRecords(
      [...inputAudioDiagnostics, ...staleSuppressionDiagnostics],
      "bargeInCandidateFrameCount",
    ) ?? 0
    const bargeInConfirmed = staleSuppressionDiagnostics.some((diagnostic) => asBoolean(diagnostic.bargeInConfirmed) === true)
      || inputAudioDiagnostics.some((diagnostic) => asBoolean(diagnostic.bargeInConfirmed) === true)
    const userInputActiveAgeMs = maxFiniteFromRecords(
      [...inputAudioDiagnostics, ...staleSuppressionDiagnostics],
      "userInputActiveAgeMs",
    )
    const staleSuppressionArmedAt = asString(staleSuppressionDiagnostics.at(-1)?.staleSuppressionArmedAt)
      ?? asString(latestInputAudioDiagnostic?.staleSuppressionArmedAt)
    const assistantAudioDropReason = asString(latestSuppressedAudioDiagnostic?.assistantAudioDropReason)
      ?? asString(latestSuppressedAudioDiagnostic?.reason)
    const interruptedResponseIds = hookTelemetry?.interruptedResponseIds
      ?? asStringArray(interruptionDiagnostic?.interruptedResponseIds)
      ?? asStringArray(staleSuppressionDiagnostics.at(-1)?.interruptedResponseIds)
      ?? []
    const latestStage = hookTelemetry?.stage ?? asString(stagePayload?.stage)
    const providerEventCount = Math.max(
      hookTelemetry?.providerEventCount ?? 0,
      countWhere(activeEvents, (event) => event.name === "gemini-provider-event"),
    )
    const relayDiagnosticCount = Math.max(
      hookTelemetry?.relayDiagnosticCount ?? 0,
      countWhere(activeEvents, (event) => event.name === "gemini-relay-diagnostic"),
    )
    const websocketDiagnosticCount = Math.max(
      hookTelemetry?.websocketDiagnosticCount ?? 0,
      countWhere(activeEvents, (event) => event.name === "gemini-websocket-diagnostic"),
    )
    const outputAudioEventCount = Math.max(
      hookTelemetry?.outputAudioEventCount ?? 0,
      countWhere(activeEvents, (event) => event.name === "gemini-output-audio-started"),
    )
    const interruptionCount = Math.max(
      hookTelemetry?.interruptionCount ?? 0,
      countWhere(activeEvents, (event) => event.name === "gemini-interruption"),
    )
    const playbackFlushCount = Math.max(
      hookTelemetry?.playbackFlushCount ?? 0,
      countWhere(activeEvents, (event) => {
        if (event.name !== "gemini-interruption") return false
        const diagnostic = asRecord(eventData(event)?.diagnostic)
        return asBoolean(diagnostic?.playbackFlushed) === true
      }),
    )
    const toolCallCount = Math.max(
      hookTelemetry?.toolCallCount ?? 0,
      countWhere(activeEvents, (event) => event.name === "gemini-tool-loop-diagnostic" && asString(eventData(event)?.phase) === "tool_call_received"),
    )
    const toolResponseCount = Math.max(
      hookTelemetry?.toolResponseCount ?? 0,
      countWhere(activeEvents, (event) => event.name === "gemini-tool-loop-diagnostic" && asString(eventData(event)?.phase) === "tool_response_sent"),
    )
    const toolRejectionCount = Math.max(
      hookTelemetry?.toolRejectionCount ?? 0,
      countWhere(activeEvents, (event) => {
        if (event.name !== "gemini-tool-loop-diagnostic") return false
        const phase = asString(eventData(event)?.phase)
        return phase === "tool_execution_rejected"
      }),
    )
    const toolCancellationCount = Math.max(
      hookTelemetry?.toolCancellationCount ?? 0,
      countWhere(activeEvents, (event) => {
        if (event.name !== "gemini-tool-loop-diagnostic") return false
        const phase = asString(eventData(event)?.phase)
        return phase === "tool_call_cancelled"
      }),
    )
    const artifactToolCallCount = Math.max(
      hookTelemetry?.artifactToolCallCount ?? 0,
      countWhere(activeEvents, (event) => {
        if (event.name !== "gemini-tool-loop-diagnostic") return false
        return asString(eventData(event)?.phase) === "tool_call_received"
          && geminiToolName(event) === GEMINI_EMIT_ARTIFACT_TOOL_NAME
      }),
    )
    const artifactToolCallUnknownCount = Math.max(
      hookTelemetry?.artifactToolCallUnknownCount ?? 0,
      unresolvedToolEntries.filter((entry) => asString(entry.toolName) === GEMINI_EMIT_ARTIFACT_TOOL_NAME).length,
    )
    const builderToolCallCount = Math.max(
      hookTelemetry?.builderToolCallCount ?? 0,
      countWhere(activeEvents, (event) => {
        if (event.name !== "gemini-tool-loop-diagnostic") return false
        const toolName = geminiToolName(event)
        return asString(eventData(event)?.phase) === "tool_call_received"
          && toolName !== null
          && GEMINI_BUILDER_TOOL_NAMES.has(toolName)
      }),
    )
    const unresolvedToolCallCount = Math.max(
      hookTelemetry?.unresolvedToolCallCount ?? 0,
      unresolvedToolEntries.length,
    )
    const oldestUnresolvedToolCallAgeMs = Math.max(
      hookTelemetry?.oldestUnresolvedToolCallAgeMs ?? 0,
      oldestUnresolvedToolCallAtMs === null ? 0 : Math.max(0, nowMs - oldestUnresolvedToolCallAtMs),
    ) || null

    return {
      runtime: "gemini_live",
      runtimeLabel: "Gemini Live",
      source,
      legacy: null,
      gemini: {
        sessionId: hookTelemetry?.sessionId ?? sessionIds.voiceAgentSessionId,
        streamUrl: hookTelemetry?.streamUrl ?? latestValue(activeEvents, ["streamUrl"]),
        websocketUrl: hookTelemetry?.websocketUrl ?? latestValue(activeEvents, ["websocketUrl", "websocket_url"]),
        relayUrl: hookTelemetry?.relayUrl ?? latestValue(activeEvents, ["relayUrl", "relay_url"]),
        transport: hookTelemetry?.transport ?? latestValue(activeEvents, ["transport"]),
        publicEventBoundary: hookTelemetry?.publicEventBoundary ?? latestValue(activeEvents, ["publicEventBoundary", "public_event_boundary"]),
        connectionState: hookTelemetry?.connectionState ?? asString(stagePayload?.connectionState),
        stage: latestStage,
        websocketState: hookTelemetry?.websocketState
          ?? asString(websocketDiagnostic?.websocketState)
          ?? deriveGeminiWebSocketState(latestStage),
        relayStatus: hookTelemetry?.relayStatus ?? asString(relayStatusPayload?.relayStatus),
        publicSseState: hookTelemetry?.publicSseState ?? derivePublicSseState(activeEvents),
        microphoneState: hookTelemetry?.microphoneState ?? asString(stagePayload?.microphoneState),
        remoteAudioState: hookTelemetry?.remoteAudioState ?? (outputAudioEventCount > 0 ? "active" : "idle"),
        setupComplete: hookTelemetry?.setupComplete ?? asBoolean(providerPayload?.setupComplete) ?? false,
        providerEventCount,
        lastProviderEventAt: hookTelemetry?.lastProviderEventAt ?? latestEventAt(activeEvents, "gemini-provider-event"),
        lastProviderEventType: hookTelemetry?.lastProviderEventType ?? asString(providerPayload?.eventType),
        providerCategoryCounts: hookTelemetry?.providerCategoryCounts ?? asGeminiCategoryCounts(providerTelemetry?.categoryCounts),
        outputAudioEventCount,
        lastOutputAudioAt: hookTelemetry?.lastOutputAudioAt ?? latestEventAt(activeEvents, "gemini-output-audio-started"),
        staleAssistantAudioDroppedCount,
        staleAssistantTranscriptDroppedCount,
        staleAssistantOutputSuppressionCount: staleSuppressionCount,
        playbackGeneration,
        assistantUserOverlapMs,
        maxAssistantUserOverlapMs: assistantUserOverlapMs,
        userInputActiveAgeMs,
        bargeInConfirmed,
        bargeInCandidateFrameCount,
        inputFrameOnlyNotBargeInCount,
        staleSuppressionArmedAt,
        assistantAudioDropReason,
        interruptedResponseIds,
        interruptionCount,
        playbackFlushCount,
        lastInterruptionAt: hookTelemetry?.lastInterruptionAt ?? asString(interruptionDiagnostic?.timestamp),
        lastPlaybackFlushAt: hookTelemetry?.lastPlaybackFlushAt
          ?? (asBoolean(interruptionDiagnostic?.playbackFlushed) === true ? asString(interruptionDiagnostic?.timestamp) : null),
        relayDiagnosticCount,
        lastRelayDiagnosticAt: hookTelemetry?.lastRelayDiagnosticAt ?? asString(relayDiagnostic?.timestamp),
        lastRelayEventType: hookTelemetry?.lastRelayEventType ?? asString(relayDiagnostic?.eventType),
        relayAttemptCount: hookTelemetry?.relayAttemptCount ?? asFiniteNumber(relayTrace?.attemptCount) ?? 0,
        relaySuccessCount: hookTelemetry?.relaySuccessCount ?? asFiniteNumber(relayTrace?.successCount) ?? 0,
        relayFailureCount: hookTelemetry?.relayFailureCount ?? asFiniteNumber(relayTrace?.failureCount) ?? 0,
        relayTraceCount: hookTelemetry?.relayTraceCount ?? countWhere(activeEvents, (event) => event.name === "gemini-relay-trace"),
        relayClassificationCounts: hookTelemetry?.relayClassificationCounts
          ?? asGeminiCategoryCounts(asRecord(providerTelemetry?.relayClassificationCounts)),
        lastRelayTraceAt: hookTelemetry?.lastRelayTraceAt ?? asString(relayTrace?.timestamp),
        lastRelayCorrelationId: hookTelemetry?.lastRelayCorrelationId ?? asString(relayTrace?.correlationId),
        lastRelayResponseKind: hookTelemetry?.lastRelayResponseKind ?? asString(relayTrace?.responseKind),
        lastRelayDurationMs: hookTelemetry?.lastRelayDurationMs ?? asFiniteNumber(relayTrace?.durationMs),
        maxRelayDurationMs: hookTelemetry?.maxRelayDurationMs ?? maxFiniteFromRecords(relayTraces, "durationMs"),
        lastCriticalRelayDurationMs: hookTelemetry?.lastCriticalRelayDurationMs ?? latestRelayDurationFor(relayTraces, (trace) => asString(trace.relayClassification) === "critical"),
        lastTranscriptionRelayDurationMs: hookTelemetry?.lastTranscriptionRelayDurationMs ?? latestRelayDurationFor(relayTraces, (trace) => {
          const categories = Array.isArray(trace.categories) ? trace.categories : []
          return categories.includes("inputTranscription") || categories.includes("outputTranscription")
        }),
        lastToolCallRelayDurationMs: hookTelemetry?.lastToolCallRelayDurationMs ?? latestRelayDurationFor(relayTraces, (trace) => {
          const categories = Array.isArray(trace.categories) ? trace.categories : []
          return categories.includes("toolCall") || categories.includes("toolCallCancellation")
        }),
        orderedRelayQueueDepth: hookTelemetry?.orderedRelayQueueDepth ?? asFiniteNumber(relayThroughput?.orderedRelayQueueDepth) ?? 0,
        oldestQueuedAgeMs: hookTelemetry?.oldestQueuedAgeMs ?? asFiniteNumber(relayThroughput?.oldestQueuedAgeMs),
        transcriptPartialsCoalesced: hookTelemetry?.transcriptPartialsCoalesced ?? asFiniteNumber(relayThroughput?.transcriptPartialsCoalesced) ?? 0,
        transcriptPartialsSent: hookTelemetry?.transcriptPartialsSent ?? asFiniteNumber(relayThroughput?.transcriptPartialsSent) ?? 0,
        transcriptPartialsDropped: hookTelemetry?.transcriptPartialsDropped ?? asFiniteNumber(relayThroughput?.transcriptPartialsDropped) ?? 0,
        transcriptCoalescingDisabledReason: hookTelemetry?.transcriptCoalescingDisabledReason ?? asString(relayThroughput?.transcriptCoalescingDisabledReason),
        finalTranscriptEventsSent: hookTelemetry?.finalTranscriptEventsSent ?? asFiniteNumber(relayThroughput?.finalTranscriptEventsSent) ?? 0,
        nonDroppableCriticalEventsSent: hookTelemetry?.nonDroppableCriticalEventsSent ?? asFiniteNumber(relayThroughput?.nonDroppableCriticalEventsSent) ?? 0,
        lastTranscriptRelayLatencyMs: hookTelemetry?.lastTranscriptRelayLatencyMs ?? asFiniteNumber(relayThroughput?.lastTranscriptRelayLatencyMs),
        maxTranscriptRelayLatencyMs: hookTelemetry?.maxTranscriptRelayLatencyMs ?? asFiniteNumber(relayThroughput?.maxTranscriptRelayLatencyMs),
        p95TranscriptRelayLatencyMs: hookTelemetry?.p95TranscriptRelayLatencyMs ?? asFiniteNumber(relayThroughput?.p95TranscriptRelayLatencyMs),
        coalescedBySegment: hookTelemetry?.coalescedBySegment ?? asNumericRecord(relayThroughput?.coalescedBySegment),
        consecutiveRelayFailures: hookTelemetry?.consecutiveRelayFailures ?? asFiniteNumber(relayDiagnostic?.consecutiveFailures) ?? 0,
        lastRelayErrorText: hookTelemetry?.lastRelayErrorText ?? asString(relayDiagnostic?.errorText),
        websocketDiagnosticCount,
        lastWebSocketDiagnosticAt: hookTelemetry?.lastWebSocketDiagnosticAt ?? asString(websocketDiagnostic?.timestamp),
        lastWebSocketErrorText: hookTelemetry?.lastWebSocketErrorText ?? asString(websocketDiagnostic?.message),
        toolCallCount,
        toolResponseCount,
        toolRejectionCount,
        toolCancellationCount,
        artifactToolCallCount,
        artifactToolCallUnknownCount,
        builderToolCallCount,
        unresolvedToolCallCount,
        oldestUnresolvedToolCallAgeMs,
        lastToolPhase: hookTelemetry?.lastToolPhase ?? asString(toolDiagnostic?.phase),
        lastToolName: hookTelemetry?.lastToolName ?? asString(asRecord(toolDiagnostic?.toolCall)?.name),
        lastToolAt: hookTelemetry?.lastToolAt ?? asString(toolDiagnostic?.timestamp),
        toolCallLedger: hookTelemetry?.toolCallLedger ?? ledgerEntries,
        publicTurnCount: counts.turns,
        artifactCount: counts.artifacts,
        artifactPublicEventCount: counts.artifactPublicEventCount,
        artifactRuntimeIngestCount: counts.artifactRuntimeIngestCount,
        artifactRenderedCount: counts.artifactRenderedCount,
        artifactCountSource: counts.artifactCountSource,
        artifactCountMismatch: counts.artifactCountMismatch,
        publicDiagnosticCount: counts.diagnostics,
        lastUserTranscriptAt: lastTurn.lastUserTranscriptAt,
        lastAssistantTranscriptAt: lastTurn.lastAssistantTranscriptAt,
        lastEventAgeMs: timings.lastEventAgeMs,
      },
    }
  }

  const hookTelemetry = runtimeTelemetry?.runtime === "legacy_cascade" ? runtimeTelemetry : null
  return {
    runtime: "legacy_cascade",
    runtimeLabel: "Legacy Cascade",
    source,
    legacy: {
      sessionId: hookTelemetry?.sessionId ?? sessionIds.sessionId,
      threadId: hookTelemetry?.threadId ?? sessionIds.threadId,
      callId: hookTelemetry?.callId ?? sessionIds.callId,
      voiceAgentSessionId: hookTelemetry?.voiceAgentSessionId ?? sessionIds.voiceAgentSessionId,
      streamUrl: hookTelemetry?.streamUrl ?? latestValue(activeEvents, ["streamUrl"]),
      streamOpen: transport.streamOpen,
      activeSource: transport.activeSource,
      remoteParticipantCount: transport.remoteParticipantCount,
      sessionReadyMs: timings.sessionReadyMs,
      joinLatencyMs: timings.joinLatencyMs,
      sseOpenMs: timings.sseOpenMs,
    },
    gemini: null,
  }
}

function buildMicrophone(metrics: SophiaCaptureMicrophoneSummary | undefined): VoiceDeveloperMetrics["microphone"] {
  if (!metrics) return DEFAULT_MICROPHONE

  return {
    patchInstalled: metrics.patchInstalled,
    detectedAudio: metrics.detectedAudio,
    streamCount: metrics.streamCount,
    audioTrackCount: metrics.audioTrackCount,
    firstAudioAt: metrics.firstAudioAt,
    lastAudioAt: metrics.lastAudioAt,
    maxRms: metrics.maxRms,
    maxAbsPeak: metrics.maxAbsPeak,
    totalSampleWindows: metrics.totalSampleWindows,
    errorCount: metrics.errors.length,
    lastError: metrics.errors.at(-1) ?? null,
  }
}

function normalizeDuplicatePhaseCounts(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(asRecord(value) ?? {}).flatMap(([key, entryValue]) => {
      const count = asFiniteNumber(entryValue)
      return count !== null && count > 0 ? [[key, count]] : []
    }),
  )
}

function countDuplicatePhases(duplicatePhaseCounts: Record<string, number>): number {
  return Object.values(duplicatePhaseCounts).reduce<number>((total, value) => total + value, 0)
}

function adjustedFalseUserEndedCount(value: number | null): number | null {
  if (value === null) return null
  return Math.max(value - 1, 0)
}

function hasMeaningfulTurnSegmentation(params: {
  falseUserEndedCount: number | null
  latestReason: string | null
  latestStatus: string | null
}): boolean {
  const { falseUserEndedCount, latestReason, latestStatus } = params
  const adjustedFalseEnds = adjustedFalseUserEndedCount(falseUserEndedCount)

  return (adjustedFalseEnds ?? 0) > 0 || (latestReason === "silence_timing" && latestStatus === "failed")
}

function getBackendLagDetail(params: {
  currentThinkingMs: number | null
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): string {
  const { currentThinkingMs, thresholds } = params

  if (currentThinkingMs !== null && currentThinkingMs >= thresholds.responseWindow.warnAtMs) {
    return `Sophia has been thinking for ${Math.round(currentThinkingMs)}ms since the last user-end event.`
  }

  return [thresholds.firstText, thresholds.firstAudio, thresholds.backendComplete]
    .filter((threshold) => threshold.status === "warn" || threshold.status === "bad")
    .map((threshold) => `${threshold.label}: ${Math.round(threshold.valueMs ?? 0)}ms`)
    .join(" | ")
}

function selectCommittedResponse(params: {
  committedTurnCloseMs: number | null
  userEndedToFirstTextMs: number | null
  userEndedToAgentStartMs: number | null
}): {
  valueMs: number | null
  source: "committed_user_transcript" | "public_turn_event" | null
} {
  const { committedTurnCloseMs, userEndedToFirstTextMs, userEndedToAgentStartMs } = params

  if (committedTurnCloseMs !== null) {
    return {
      valueMs: committedTurnCloseMs,
      source: "committed_user_transcript",
    }
  }

  if (userEndedToAgentStartMs !== null) {
    return {
      valueMs: userEndedToAgentStartMs,
      source: "public_turn_event",
    }
  }

  if (userEndedToFirstTextMs !== null) {
    return {
      valueMs: userEndedToFirstTextMs,
      source: "public_turn_event",
    }
  }

  return {
    valueMs: null,
    source: null,
  }
}

function hasCommitBoundaryDrift(params: {
  committedResponseMs: number | null
  rawFirstTextMs: number | null
  rawFirstAudioMs: number | null
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): boolean {
  const { committedResponseMs, rawFirstTextMs, rawFirstAudioMs, thresholds } = params

  if (committedResponseMs === null) {
    return false
  }

  const rawLagDetected =
    (rawFirstTextMs !== null && rawFirstTextMs >= thresholds.firstText.warnAtMs)
    || (rawFirstAudioMs !== null && rawFirstAudioMs >= thresholds.firstAudio.warnAtMs)

  if (!rawLagDetected || committedResponseMs >= thresholds.committedResponse.warnAtMs) {
    return false
  }

  const largestGapMs = Math.max(
    rawFirstTextMs !== null ? rawFirstTextMs - committedResponseMs : 0,
    rawFirstAudioMs !== null ? rawFirstAudioMs - committedResponseMs : 0,
  )

  return largestGapMs >= 2000
}

function getCommitBoundaryDetail(params: {
  committedResponseMs: number | null
  publicTurnCloseMs: number | null
  rawFirstTextMs: number | null
  rawFirstAudioMs: number | null
}): string {
  const parts = compactStrings([
    formatEvidenceMs("committed response", params.committedResponseMs),
    formatEvidenceMs("public user end -> agent start", params.publicTurnCloseMs),
    formatEvidenceMs("raw first text", params.rawFirstTextMs),
    formatEvidenceMs("raw first audio", params.rawFirstAudioMs),
  ])

  return parts.join(" | ")
}

function compactStrings(values: Array<string | null>): string[] {
  return values.filter((value): value is string => Boolean(value))
}

function formatEvidenceMs(label: string, valueMs: number | null): string | null {
  return valueMs === null ? null : `${label}: ${Math.round(valueMs)}ms`
}

function createThreshold(
  label: string,
  valueMs: number | null,
  warnAtMs: number,
  badAtMs: number,
): VoiceMetricThreshold {
  if (valueMs === null) {
    return {
      label,
      valueMs,
      warnAtMs,
      badAtMs,
      status: "neutral",
    }
  }

  return {
    label,
    valueMs,
    warnAtMs,
    badAtMs,
    status: valueMs >= badAtMs ? "bad" : valueMs >= warnAtMs ? "warn" : "good",
  }
}

function buildThresholds(params: {
  stage: VoiceStage
  sessionReadyMs: number | null
  joinLatencyMs: number | null
  committedResponseMs: number | null
  firstTextMs: number | null
  firstAudioMs: number | null
  backendCompleteMs: number | null
  currentThinkingMs: number | null
  responseDurationMs: number | null
}): VoiceDeveloperMetrics["thresholds"] {
  const responseLabel = params.stage === "thinking" ? "Current wait" : "Response window"
  const responseValue = params.stage === "thinking" ? params.currentThinkingMs : params.responseDurationMs

  return {
    sessionReady: createThreshold("Session ready", params.sessionReadyMs, 2500, 5000),
    joinLatency: createThreshold("Join latency", params.joinLatencyMs, 2000, 3500),
    committedResponse: createThreshold("Committed response", params.committedResponseMs, 3000, 6000),
    firstText: createThreshold("Raw first text", params.firstTextMs, 2500, 5000),
    firstAudio: createThreshold("Raw first audio", params.firstAudioMs, 3000, 6000),
    backendComplete: createThreshold("Raw backend done", params.backendCompleteMs, 2800, 5500),
    responseWindow: createThreshold(
      responseLabel,
      responseValue,
      params.stage === "thinking" ? 4000 : 10000,
      params.stage === "thinking" ? 8000 : 16000,
    ),
  }
}

function buildRegressionMarkers(params: {
  stage: VoiceStage
  microphone: VoiceDeveloperMetrics["microphone"]
  builder: VoiceDeveloperMetrics["builder"]
  userTranscriptCount: number
  providerInputTranscriptionCount: number
  falseUserEndedCount: number | null
  duplicatePhaseCounts: Record<string, number>
  latestReason: string | null
  currentThinkingMs: number | null
  pipeline: VoicePipelineMetrics
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): VoiceRegressionMarker[] {
  const {
    stage,
    microphone,
    builder,
    userTranscriptCount,
    providerInputTranscriptionCount,
    falseUserEndedCount,
    latestReason,
    currentThinkingMs,
    pipeline,
    thresholds,
  } = params

  const markers: VoiceRegressionMarker[] = []
  const adjustedFalseEnds = adjustedFalseUserEndedCount(falseUserEndedCount)
  const hasMeaningfulSegmentationIssue = hasMeaningfulTurnSegmentation({
    falseUserEndedCount,
    latestReason,
    latestStatus: null,
  })

  if (microphone.errorCount > 0) {
    markers.push({
      key: "microphone",
      title: "Microphone failure",
      detail: microphone.lastError ?? "The browser reported microphone acquisition or probe failures.",
      level: "bad",
    })
  } else if (microphone.streamCount > 0 && !microphone.detectedAudio && stage !== "idle" && stage !== "connecting") {
    markers.push({
      key: "microphone",
      title: "Mic stream without signal",
      detail: "The browser created a stream, but the microphone probe never observed non-silent audio.",
      level: "bad",
    })
  } else if (providerInputTranscriptionCount > 0 && userTranscriptCount === 0 && stage !== "idle" && stage !== "connecting") {
    markers.push({
      key: "public-continuity",
      title: "Provider transcript not surfaced",
      detail: "Gemini emitted input transcription, but no normalized sophia.user_transcript reached Session.",
      level: "warn",
    })
  } else if (microphone.detectedAudio && userTranscriptCount === 0 && stage !== "idle" && stage !== "connecting") {
    markers.push({
      key: "microphone",
      title: "Transcript gap after mic audio",
      detail: "Local microphone audio exists, but no finalized user transcript was emitted yet.",
      level: "warn",
    })
  }

  if (hasMeaningfulSegmentationIssue) {
    markers.push({
      key: "turn-segmentation",
      title: "Turn segmentation drift",
      detail:
        latestReason === "silence_timing" && (adjustedFalseEnds ?? 0) === 0
          ? "The turn ended due to silence timing rather than a clean committed boundary."
          : `Extra false user-end detections observed: ${adjustedFalseEnds ?? 0}`,
      level: (adjustedFalseEnds ?? 0) > 2 ? "bad" : "warn",
    })
  }

  const committedResponse = selectCommittedResponse({
    committedTurnCloseMs: pipeline.committedTurnCloseMs,
    userEndedToFirstTextMs: pipeline.userEndedToFirstTextMs,
    userEndedToAgentStartMs: pipeline.userEndedToAgentStartMs,
  })
  const commitBoundaryDrift = hasCommitBoundaryDrift({
    committedResponseMs: committedResponse.valueMs,
    rawFirstTextMs: pipeline.rawSpeechEndToFirstTextMs,
    rawFirstAudioMs: pipeline.rawSpeechEndToFirstAudioMs,
    thresholds,
  })

  if (commitBoundaryDrift) {
    markers.push({
      key: "commit-boundary",
      title: "Raw and committed timing diverged",
      detail: getCommitBoundaryDetail({
        committedResponseMs: committedResponse.valueMs,
        publicTurnCloseMs: pipeline.userEndedToAgentStartMs,
        rawFirstTextMs: pipeline.rawSpeechEndToFirstTextMs,
        rawFirstAudioMs: pipeline.rawSpeechEndToFirstAudioMs,
      }),
      level: "warn",
    })
  }

  const visibleBackendThresholds = [thresholds.firstText, thresholds.firstAudio].filter(
    (threshold) => threshold.status === "warn" || threshold.status === "bad",
  )
  const backendCompletionSlow = thresholds.backendComplete.status === "warn" || thresholds.backendComplete.status === "bad"
  const backendLagDetected =
    !commitBoundaryDrift && (
      latestReason === "backend_stall"
      || (currentThinkingMs !== null && currentThinkingMs >= thresholds.responseWindow.warnAtMs)
      || thresholds.committedResponse.status === "warn"
      || thresholds.committedResponse.status === "bad"
      || (committedResponse.valueMs === null && visibleBackendThresholds.length > 0)
      || (committedResponse.valueMs === null && backendCompletionSlow)
      || (thresholds.firstAudio.valueMs === null && backendCompletionSlow)
    )

  if (backendLagDetected) {
    const level: VoiceRegressionMarker["level"] =
      latestReason === "backend_stall"
      || thresholds.responseWindow.status === "bad"
      || thresholds.committedResponse.status === "bad"
      || (committedResponse.valueMs === null && visibleBackendThresholds.some((threshold) => threshold.status === "bad"))
      || (committedResponse.valueMs === null && thresholds.firstAudio.valueMs === null && thresholds.backendComplete.status === "bad")
        ? "bad"
        : "warn"

    markers.push({
      key: "backend-stall",
      title: latestReason === "backend_stall" ? "Backend stall detected" : "Slow backend response",
      detail: getBackendLagDetail({ currentThinkingMs, thresholds }),
      level,
    })
  }

  if (builder.phase === "failed" || builder.phase === "timed_out") {
    markers.push({
      key: "builder-stall",
      title: builder.phase === "timed_out" ? "Builder timed out" : "Builder failed",
      detail: builder.detail ?? builder.stuckReason ?? "Builder stopped before producing the deliverable.",
      level: "bad",
    })
  } else if (builder.phase === "running" && builder.stuck) {
    markers.push({
      key: "builder-stall",
      title: "Builder progress stalled",
      detail: builder.stuckReason ?? "No visible builder progress has been observed recently.",
      level: (builder.idleMs ?? 0) >= 240000 ? "bad" : "warn",
    })
  }

  return markers
}

function buildEventCounters(events: NormalizedVoiceCaptureEvent[]): VoiceEventCounters {
  const isBuilderSignalEvent = (event: NormalizedVoiceCaptureEvent) => event.category === "builder" || event.name === "sophia.builder_task"

  return {
    total: events.length,
    voiceSse: countWhere(events, (event) => event.category === "voice-sse"),
    streamCustom: countWhere(events, (event) => event.category === "stream-custom"),
    voiceRuntime: countWhere(events, (event) => event.category === "voice-runtime"),
    voiceSession: countWhere(events, (event) => event.category === "voice-session"),
    harnessInput: countWhere(events, (event) => event.category === "harness-input"),
    builder: countWhere(events, isBuilderSignalEvent),
    duplicateUserTranscriptIgnored: countWhere(events, (event) => event.name === "duplicate-user-transcript-ignored"),
    sseErrors: countWhere(events, (event) => event.category === "voice-sse" && event.name === "stream-error"),
    invalidPayloads: countWhere(events, (event) => event.category === "voice-sse" && event.name === "invalid-event-payload"),
    staleConnectResponses: countWhere(events, (event) => event.name === "stale-connect-response"),
    startIgnored: countWhere(events, (event) => event.name === "start-talking-ignored"),
    startupTimeouts: countWhere(events, (event) => event.name === "startup-ready-timeout"),
  }
}

function buildBuilderMetrics(events: NormalizedVoiceCaptureEvent[], nowMs: number): VoiceDeveloperMetrics["builder"] {
  const isBuilderSignalEvent = (event: NormalizedVoiceCaptureEvent) => event.category === "builder" || event.name === "sophia.builder_task"
  const latestBuilderEvent = findLast(events, isBuilderSignalEvent)
  const payload = latestBuilderEvent
    ? latestBuilderEvent.category === "builder"
      ? latestBuilderEvent.payloadRecord
      : eventData(latestBuilderEvent)
    : null
  const phaseValue = asString(payload?.phase) ?? asString(payload?.type)?.replace(/^task_/, "")
  const phase = phaseValue === "running"
    || phaseValue === "completed"
    || phaseValue === "failed"
    || phaseValue === "timed_out"
    || phaseValue === "cancelled"
      ? phaseValue
      : null

  const progressSourceValue = asString(payload?.progressSource) ?? asString(payload?.progress_source)
  const progressSource = progressSourceValue === "todos" || progressSourceValue === "messages" || progressSourceValue === "iterations" || progressSourceValue === "none"
    ? progressSourceValue
    : null

  const lastUpdateAt = asString(payload?.lastUpdateAt) ?? asString(payload?.last_update_at)
  const lastProgressAt = asString(payload?.lastProgressAt) ?? asString(payload?.last_progress_at)
  const eventAgeMs = diffMs(latestBuilderEvent?.atMs ?? null, nowMs)
  const inferredHeartbeatMs = diffMs(parseTimestampMs(lastUpdateAt) ?? latestBuilderEvent?.atMs ?? null, nowMs)
  const inferredIdleMs = diffMs(parseTimestampMs(lastProgressAt) ?? latestBuilderEvent?.atMs ?? null, nowMs)
  const payloadHeartbeatMs = asFiniteNumber(payload?.heartbeatMs) ?? asFiniteNumber(payload?.heartbeat_ms)
  const payloadIdleMs = asFiniteNumber(payload?.idleMs) ?? asFiniteNumber(payload?.idle_ms)
  const heartbeatMs = payloadHeartbeatMs !== null || inferredHeartbeatMs !== null
    ? Math.max(
      payloadHeartbeatMs !== null ? payloadHeartbeatMs + (eventAgeMs ?? 0) : 0,
      inferredHeartbeatMs ?? 0,
    )
    : null
  const idleMs = payloadIdleMs !== null || inferredIdleMs !== null
    ? Math.max(
      payloadIdleMs !== null ? payloadIdleMs + (eventAgeMs ?? 0) : 0,
      inferredIdleMs ?? 0,
    )
    : null
  const stuck = phase === "running" && ((asBoolean(payload?.stuck) ?? asBoolean(payload?.is_stuck) ?? false) || ((idleMs ?? 0) >= 150000))
  const stuckReason = asString(payload?.stuckReason)
    ?? asString(payload?.stuck_reason)
    ?? (stuck
      ? `No visible builder progress for ${Math.max(Math.round((idleMs ?? 0) / 1000), 1)}s. It may be blocked on a tool or looping without advancing the deliverable.`
      : null)

  return {
    phase,
    taskId: asString(payload?.taskId) ?? asString(payload?.task_id),
    label: asString(payload?.label),
    detail: asString(payload?.detail) ?? getBuilderDebugDetail(payload),
    progressPercent: asFiniteNumber(payload?.progressPercent) ?? asFiniteNumber(payload?.progress_percent),
    progressSource,
    totalSteps: asFiniteNumber(payload?.totalSteps) ?? asFiniteNumber(payload?.total_steps),
    completedSteps: asFiniteNumber(payload?.completedSteps) ?? asFiniteNumber(payload?.completed_steps),
    inProgressSteps: asFiniteNumber(payload?.inProgressSteps) ?? asFiniteNumber(payload?.in_progress_steps),
    pendingSteps: asFiniteNumber(payload?.pendingSteps) ?? asFiniteNumber(payload?.pending_steps),
    activeStepTitle: asString(payload?.activeStepTitle) ?? asString(payload?.active_step_title),
    startedAt: asString(payload?.startedAt) ?? asString(payload?.started_at),
    completedAt: asString(payload?.completedAt) ?? asString(payload?.completed_at),
    lastUpdateAt,
    lastProgressAt,
    heartbeatMs,
    idleMs,
    stuck,
    stuckReason,
  }
}

function buildRecentTurns(events: NormalizedVoiceCaptureEvent[]): VoiceRecentTurnSummary[] {
  const completedTurns: VoiceRecentTurnSummary[] = []
  let lastUserTranscriptAtMs: number | null = null
  let lastUserTranscriptChars: number | null = null
  let lastUserEndedAtMs: number | null = null
  let firstAgentStartedAtMs: number | null = null
  let lastAssistantTranscriptChars: number | null = null

  for (const event of events) {
    if (event.name === "sophia.user_transcript") {
      lastUserTranscriptAtMs = event.atMs
      const text = asString(eventData(event)?.text)
      lastUserTranscriptChars = text !== null ? text.length : null
      continue
    }

    if (event.name === "sophia.transcript") {
      const data = eventData(event)
      const isFinal = data?.is_final === true || data?.final === true
      const text = asString(data?.text)
      // Keep a running assistant-transcript length; the final frame wins when
      // we emit the turn diagnostic below.
      if (text !== null) {
        lastAssistantTranscriptChars = text.length
      }
      if (isFinal) {
        // Final frame is the authoritative length for this turn.
        if (text !== null) {
          lastAssistantTranscriptChars = text.length
        }
      }
      continue
    }

    if (event.name === "sophia.turn") {
      const phase = eventPhase(event)
      if (phase === "user_ended") {
        lastUserEndedAtMs = event.atMs
        firstAgentStartedAtMs = null
      } else if (phase === "agent_started" && firstAgentStartedAtMs === null) {
        firstAgentStartedAtMs = event.atMs
      }
      continue
    }

    if (event.name !== "sophia.turn_diagnostic") {
      continue
    }

    const data = eventData(event)
    const duplicatePhaseCounts = normalizeDuplicatePhaseCounts(data?.duplicate_phase_counts)
    const duplicatePhaseTotal = Object.values(duplicatePhaseCounts).reduce<number>((total, value) => total + value, 0)
    const backendRequestStartMs = asFiniteNumber(data?.backend_request_start_ms)
    const backendFirstEventMs = asFiniteNumber(data?.backend_first_event_ms)

    completedTurns.push({
      turnId: asString(data?.turn_id),
      status: asString(data?.status),
      reason: asString(data?.reason),
      committedTurnCloseMs: diffMs(lastUserTranscriptAtMs, lastUserEndedAtMs),
      committedTranscriptToAgentStartMs: diffMs(lastUserTranscriptAtMs, firstAgentStartedAtMs),
      requestStartToFirstBackendEventMs: diffMs(backendRequestStartMs, backendFirstEventMs),
      firstTextMs: asFiniteNumber(data?.first_text_ms),
      backendCompleteMs: asFiniteNumber(data?.backend_complete_ms),
      firstAudioMs: asFiniteNumber(data?.first_audio_ms),
      falseUserEndedCount: asFiniteNumber(data?.raw_false_end_count),
      duplicatePhaseTotal,
      userTranscriptChars: lastUserTranscriptChars,
      assistantTranscriptChars: lastAssistantTranscriptChars,
    })

    lastUserTranscriptAtMs = null
    lastUserTranscriptChars = null
    lastUserEndedAtMs = null
    firstAgentStartedAtMs = null
    lastAssistantTranscriptChars = null
  }

  // Keep up to 12 turns so a full conversation (typical: 8–12 turns) is
  // visible in the exported telemetry report.
  return completedTurns.slice(-12).reverse()
}

function levelFromThresholdState(
  status: VoiceMetricThreshold["status"],
): VoiceMetricsHealthLevel {
  if (status === "bad" || status === "warn") {
    return status
  }

  return "good"
}

function buildBottleneckDiagnosis(params: {
  stage: VoiceStage
  turnCount: number
  microphone: VoiceDeveloperMetrics["microphone"]
  userTranscriptCount: number
  providerInputTranscriptionCount: number
  assistantTranscriptCount: number
  falseUserEndedCount: number | null
  duplicatePhaseCounts: Record<string, number>
  latestReason: string | null
  latestStatus: string | null
  transportSource: VoiceDeveloperMetrics["transport"]["activeSource"]
  events: VoiceEventCounters
  startup: VoiceStartupMetrics
  pipeline: VoicePipelineMetrics
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): VoiceBottleneckDiagnosis {
  const {
    stage,
    turnCount,
    microphone,
    userTranscriptCount,
    providerInputTranscriptionCount,
    assistantTranscriptCount,
    falseUserEndedCount,
    duplicatePhaseCounts,
    latestReason,
    latestStatus,
    transportSource,
    events,
    startup,
    pipeline,
    thresholds,
  } = params

  const duplicatePhaseTotal = countDuplicatePhases(duplicatePhaseCounts)
  const adjustedFalseEnds = adjustedFalseUserEndedCount(falseUserEndedCount)
  const hasMeaningfulSegmentationIssue = hasMeaningfulTurnSegmentation({
    falseUserEndedCount,
    latestReason,
    latestStatus,
  })
  const startupIsSlow =
    (startup.requestToCredentialsMs !== null && startup.requestToCredentialsMs >= 1200)
    || thresholds.joinLatency.status === "warn"
    || thresholds.joinLatency.status === "bad"
    || thresholds.sessionReady.status === "warn"
    || thresholds.sessionReady.status === "bad"

  const committedResponse = selectCommittedResponse({
    committedTurnCloseMs: pipeline.committedTurnCloseMs,
    userEndedToFirstTextMs: pipeline.userEndedToFirstTextMs,
    userEndedToAgentStartMs: pipeline.userEndedToAgentStartMs,
  })
  const commitBoundaryDrift = hasCommitBoundaryDrift({
    committedResponseMs: committedResponse.valueMs,
    rawFirstTextMs: pipeline.rawSpeechEndToFirstTextMs,
    rawFirstAudioMs: pipeline.rawSpeechEndToFirstAudioMs,
    thresholds,
  })

  const ttsIsSlow =
    pipeline.textToFirstAudioMs !== null
    && pipeline.textToFirstAudioMs >= 1500
    && (committedResponse.valueMs === null || committedResponse.valueMs < thresholds.committedResponse.warnAtMs)

  if (stage === "idle" && turnCount === 0 && !startupIsSlow) {
    return {
      kind: "idle",
      level: "neutral",
      title: "Waiting for a voice turn",
      detail: "Start a turn and the panel will break down startup, transcription, backend, and playback latency.",
      evidence: [],
    }
  }

  if (turnCount === 0 && startupIsSlow) {
    return {
      kind: "startup",
      level: levelFromThresholdState(
        thresholds.sessionReady.status === "bad" || thresholds.joinLatency.status === "bad"
          ? "bad"
          : "warn",
      ),
      title: "Startup path is the bottleneck",
      detail: "The expensive part is getting from voice-start to a ready Sophia session before any turn can begin.",
      evidence: compactStrings([
        formatEvidenceMs("request -> credentials", startup.requestToCredentialsMs),
        formatEvidenceMs("credentials -> join", startup.credentialsToJoinMs),
        formatEvidenceMs("join -> ready", startup.joinToReadyMs),
      ]),
    }
  }

  if (providerInputTranscriptionCount > 0 && userTranscriptCount === 0 && stage !== "idle" && stage !== "connecting") {
    return {
      kind: "transport",
      level: "warn",
      title: "Provider transcript is not surfaced",
      detail: "Gemini input transcription is present, but the public Session stream has no sophia.user_transcript event.",
      evidence: compactStrings([
        `provider input transcripts: ${providerInputTranscriptionCount}`,
        `public user transcripts: ${userTranscriptCount}`,
        formatEvidenceMs("mic audio -> transcript", pipeline.micToUserTranscriptMs),
      ]),
    }
  }

  if (
    microphone.errorCount > 0
    || (microphone.streamCount > 0 && !microphone.detectedAudio && stage !== "idle" && stage !== "connecting")
    || (microphone.detectedAudio && userTranscriptCount === 0 && stage !== "idle" && stage !== "connecting")
  ) {
    return {
      kind: "microphone",
      level: microphone.errorCount > 0 || !microphone.detectedAudio ? "bad" : "warn",
      title: "Input capture is the bottleneck",
      detail: "The browser microphone path is not producing stable input for Sophia to transcribe.",
      evidence: compactStrings([
        formatEvidenceMs("start -> mic audio", startup.startToMicAudioMs),
        formatEvidenceMs("mic audio -> transcript", pipeline.micToUserTranscriptMs),
        microphone.lastError,
      ]),
    }
  }

  if (hasMeaningfulSegmentationIssue) {
    return {
      kind: "turn-segmentation",
      level: (adjustedFalseEnds ?? 0) > 2 ? "bad" : "warn",
      title: "Turn segmentation is the bottleneck",
      detail: "The system is struggling to decide when the user actually finished speaking, which delays or destabilizes the reply path.",
      evidence: compactStrings([
        adjustedFalseEnds !== null ? `extra false user ends: ${adjustedFalseEnds}` : null,
        duplicatePhaseTotal > 0 ? `lifecycle repeats: ${duplicatePhaseTotal}` : null,
        latestReason ? `reason: ${latestReason}` : null,
      ]),
    }
  }

  if (commitBoundaryDrift) {
    return {
      kind: "commit-boundary",
      level: "warn",
      title: "Raw and committed latency diverge",
      detail: "The visible reply committed quickly, but the raw diagnostic clock stayed open much longer before the turn fully closed.",
      evidence: compactStrings([
        formatEvidenceMs("committed response", committedResponse.valueMs),
        formatEvidenceMs("public user end -> agent start", pipeline.userEndedToAgentStartMs),
        formatEvidenceMs("raw first text", pipeline.rawSpeechEndToFirstTextMs),
        formatEvidenceMs("raw first audio", pipeline.rawSpeechEndToFirstAudioMs),
      ]),
    }
  }

  if (ttsIsSlow) {
    return {
      kind: "tts",
      level: pipeline.textToFirstAudioMs !== null && pipeline.textToFirstAudioMs >= 2500 ? "bad" : "warn",
      title: "Playback/TTS is the bottleneck",
      detail: "Sophia produced text in time, but the gap from text generation to audible playback is the slowest part.",
      evidence: compactStrings([
        formatEvidenceMs("committed response", committedResponse.valueMs),
        formatEvidenceMs("text -> first audio", pipeline.textToFirstAudioMs),
        formatEvidenceMs("backend -> first audio", pipeline.backendToFirstAudioMs),
      ]),
    }
  }

  if (
    latestReason === "backend_stall"
    || latestStatus === "failed"
    || thresholds.committedResponse.status === "warn"
    || thresholds.committedResponse.status === "bad"
    || thresholds.responseWindow.status === "warn"
    || thresholds.responseWindow.status === "bad"
    || (committedResponse.valueMs === null && thresholds.firstText.status === "warn")
    || (committedResponse.valueMs === null && thresholds.firstText.status === "bad")
    || (committedResponse.valueMs === null && thresholds.firstAudio.status === "warn")
    || (committedResponse.valueMs === null && thresholds.firstAudio.status === "bad")
    || (thresholds.firstAudio.valueMs === null
      && (thresholds.backendComplete.status === "warn" || thresholds.backendComplete.status === "bad"))
  ) {
    return {
      kind: "backend",
      level:
        latestReason === "backend_stall"
        || thresholds.committedResponse.status === "bad"
        || thresholds.responseWindow.status === "bad"
        || (committedResponse.valueMs === null && thresholds.firstText.status === "bad")
        || (committedResponse.valueMs === null && thresholds.firstAudio.status === "bad")
        || (committedResponse.valueMs === null && thresholds.firstAudio.valueMs === null && thresholds.backendComplete.status === "bad")
          ? "bad"
          : "warn",
      title: "Backend response is the bottleneck",
      detail: "The slowest segment is between the committed user turn and the backend producing enough response progress.",
      evidence: compactStrings([
        formatEvidenceMs("committed response", committedResponse.valueMs),
        formatEvidenceMs("user end -> agent start", pipeline.userEndedToAgentStartMs),
        formatEvidenceMs("raw first text", pipeline.rawSpeechEndToFirstTextMs),
        formatEvidenceMs("first text -> backend done", pipeline.firstTextToBackendCompleteMs),
        latestReason ? `reason: ${latestReason}` : null,
      ]),
    }
  }

  if (
    events.sseErrors > 0
    || events.invalidPayloads > 0
    || (transportSource === "custom" && assistantTranscriptCount === 0)
  ) {
    return {
      kind: "transport",
      level: events.sseErrors > 0 || events.invalidPayloads > 0 ? "bad" : "warn",
      title: "Event transport is the bottleneck",
      detail: "The voice event bridge is degraded or falling back, so updates are arriving late or unreliably.",
      evidence: compactStrings([
        `transport: ${transportSource}`,
        events.sseErrors > 0 ? `sse errors: ${events.sseErrors}` : null,
        events.invalidPayloads > 0 ? `invalid payloads: ${events.invalidPayloads}` : null,
      ]),
    }
  }

  if (startupIsSlow) {
    return {
      kind: "startup",
      level: thresholds.sessionReady.status === "bad" || thresholds.joinLatency.status === "bad" ? "bad" : "warn",
      title: "Startup path is slower than the turn itself",
      detail: "The first response feels slow mainly because call setup and readiness still take too long.",
      evidence: compactStrings([
        formatEvidenceMs("request -> credentials", startup.requestToCredentialsMs),
        formatEvidenceMs("join latency", thresholds.joinLatency.valueMs),
        formatEvidenceMs("session ready", thresholds.sessionReady.valueMs),
      ]),
    }
  }

  return {
    kind: "healthy",
    level: "good",
    title: "No single dominant bottleneck",
    detail: "The visible latency is currently spread across startup and response phases without one clear failing segment.",
    evidence: compactStrings([
      formatEvidenceMs("join latency", thresholds.joinLatency.valueMs),
      formatEvidenceMs("committed response", thresholds.committedResponse.valueMs),
      formatEvidenceMs("raw first text", thresholds.firstText.valueMs),
      formatEvidenceMs("raw first audio", thresholds.firstAudio.valueMs),
    ]),
  }
}

export function inferVoiceStageFromCapture({
  events,
  runtimeError,
}: {
  events: VoiceCaptureEvent[]
  runtimeError?: string
}): VoiceStage {
  if (runtimeError) {
    return "error"
  }

  const activeEvents = events.map(normalizeEvent)
  const latestCallingStateEvent = findLast(activeEvents, (event) => event.name === "calling-state-changed")
  const mappedStage = asVoiceStage(asString(eventData(latestCallingStateEvent)?.mappedStage))

  if (mappedStage) {
    return mappedStage
  }

  const latestTerminalErrorEvent = findLast(activeEvents, (event) => [
    "stream-error",
    "start-talking-failed",
    "startup-ready-timeout",
    "call-join-failed",
    "missing-session-id",
  ].includes(event.name))

  if (latestTerminalErrorEvent) {
    return "error"
  }

  const latestTurnEvent = findLast(activeEvents, (event) => event.name === "sophia.turn")
  switch (eventPhase(latestTurnEvent)) {
    case "agent_started":
      return "speaking"
    case "agent_ended":
      return "listening"
    case "user_ended":
      return "thinking"
    default:
      break
  }

  if (findLast(activeEvents, (event) => event.name === "sophia-ready" || event.name === "call-joined")) {
    return "listening"
  }

  if (findLast(activeEvents, (event) => event.name === "start-talking-requested" || event.name === "credentials-received" || event.name === "call-join-requested")) {
    return "connecting"
  }

  return "idle"
}

export function buildVoiceDeveloperMetricsFromCapture({
  capture,
  nowMs,
  runtimeError,
  stage,
  runtimeTelemetry,
}: BuildVoiceDeveloperMetricsFromCaptureParams): VoiceDeveloperMetrics {
  return buildVoiceDeveloperMetrics({
    stage: stage ?? inferVoiceStageFromCapture({ events: capture.events, runtimeError }),
    events: capture.events,
    snapshot: capture.snapshot ?? null,
    nowMs,
    runtimeError,
    runtimeTelemetry,
  })
}

export function buildVoiceTelemetrySummary(metrics: VoiceDeveloperMetrics): VoiceTelemetrySummary {
  const committedResponse = selectCommittedResponse({
    committedTurnCloseMs: metrics.pipeline.committedTurnCloseMs,
    userEndedToFirstTextMs: metrics.pipeline.userEndedToFirstTextMs,
    userEndedToAgentStartMs: metrics.pipeline.userEndedToAgentStartMs,
  })

  return {
    runtime: metrics.sessionTelemetry.runtime,
    runtimeLabel: metrics.sessionTelemetry.runtimeLabel,
    stage: metrics.stage,
    healthLevel: metrics.health.level,
    healthTitle: metrics.health.title,
    bottleneckKind: metrics.bottleneck.kind,
    bottleneckLevel: metrics.bottleneck.level,
    transportSource: metrics.transport.activeSource,
    regressionKeys: metrics.regressions.map((marker) => marker.key),
    sessionReadyMs: metrics.timings.sessionReadyMs,
    joinLatencyMs: metrics.timings.joinLatencyMs,
    committedResponseMs: committedResponse.valueMs,
    committedResponseSource: committedResponse.source,
    publicTurnCloseMs: metrics.pipeline.userEndedToAgentStartMs,
    submissionStabilizationMs: metrics.pipeline.submissionStabilizationMs,
    committedFirstTextMs: metrics.pipeline.userEndedToFirstTextMs,
    rawFirstTextMs: metrics.lastTurn.firstTextMs,
    rawBackendCompleteMs: metrics.lastTurn.backendCompleteMs,
    rawFirstAudioMs: metrics.lastTurn.firstAudioMs,
    responseWindowMs:
      metrics.stage === "thinking"
        ? metrics.timings.currentThinkingMs
        : metrics.lastTurn.responseDurationMs,
    builderPhase: metrics.builder.phase,
    builderProgressPercent: metrics.builder.progressPercent,
    builderStuck: metrics.builder.stuck,
  }
}

function summarizeHealth(params: {
  stage: VoiceStage
  microphone: VoiceDeveloperMetrics["microphone"]
  builder: VoiceDeveloperMetrics["builder"]
  runtimeError?: string
  transportSource: VoiceDeveloperMetrics["transport"]["activeSource"]
  currentThinkingMs: number | null
  latestDiagnostic: Record<string, unknown> | null
  userTranscriptCount: number
  providerInputTranscriptionCount: number
  assistantTranscriptCount: number
  turnCount: number
  pipeline: VoicePipelineMetrics
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): VoiceDeveloperMetrics["health"] {
  const {
    stage,
    microphone,
    builder,
    runtimeError,
    transportSource,
    currentThinkingMs,
    latestDiagnostic,
    userTranscriptCount,
    providerInputTranscriptionCount,
    assistantTranscriptCount,
    turnCount,
    pipeline,
    thresholds,
  } = params

  if (stage === "error") {
    return {
      level: "bad",
      title: "Voice runtime failed",
      detail: runtimeError ?? "The client entered an error state before the turn could finish.",
    }
  }

  if (builder.phase === "failed" || builder.phase === "timed_out") {
    return {
      level: "bad",
      title: builder.phase === "timed_out" ? "Builder timed out" : "Builder failed",
      detail: builder.detail ?? builder.stuckReason ?? "Builder stopped before producing the deliverable.",
    }
  }

  if (builder.phase === "running" && builder.stuck) {
    return {
      level: "warn",
      title: "Builder appears stalled",
      detail: builder.stuckReason ?? "No visible builder progress has been observed recently.",
    }
  }

  if (microphone.errorCount > 0) {
    return {
      level: "bad",
      title: "Microphone pipeline failed",
      detail: microphone.lastError ?? "The browser reported microphone acquisition or probe failures.",
    }
  }

  if (microphone.streamCount > 0 && !microphone.detectedAudio && stage !== "idle" && stage !== "connecting") {
    return {
      level: "bad",
      title: "Mic stream without signal",
      detail: "The browser created a microphone stream, but no non-silent audio window was observed.",
    }
  }

  if (providerInputTranscriptionCount > 0 && userTranscriptCount === 0 && stage !== "idle" && stage !== "connecting") {
    return {
      level: "warn",
      title: "Provider transcript not surfaced",
      detail: "Gemini input transcription exists, but Session has not received a normalized user transcript yet.",
    }
  }

  if (microphone.detectedAudio && userTranscriptCount === 0 && stage !== "idle" && stage !== "connecting") {
    return {
      level: "warn",
      title: "Audio detected, transcript missing",
      detail: "Local microphone audio exists, but Sophia has not emitted a user transcript yet.",
    }
  }

  if (currentThinkingMs !== null && currentThinkingMs > 6000) {
    return {
      level: "warn",
      title: "Backend feels slow",
      detail: `Sophia has been thinking for ${Math.round(currentThinkingMs)}ms since the last user-end event.`,
    }
  }

  const latestReason = asString(latestDiagnostic?.reason)
  const latestStatus = asString(latestDiagnostic?.status)
  const falseUserEndedCount = asFiniteNumber(latestDiagnostic?.raw_false_end_count)
  const adjustedFalseEnds = adjustedFalseUserEndedCount(falseUserEndedCount)
  const committedResponse = selectCommittedResponse({
    committedTurnCloseMs: pipeline.committedTurnCloseMs,
    userEndedToFirstTextMs: pipeline.userEndedToFirstTextMs,
    userEndedToAgentStartMs: pipeline.userEndedToAgentStartMs,
  })
  const commitBoundaryDrift = hasCommitBoundaryDrift({
    committedResponseMs: committedResponse.valueMs,
    rawFirstTextMs: pipeline.rawSpeechEndToFirstTextMs,
    rawFirstAudioMs: pipeline.rawSpeechEndToFirstAudioMs,
    thresholds,
  })

  if (latestStatus === "failed") {
    return {
      level: "bad",
      title: "Turn diagnostic failed",
      detail: latestReason ? `The latest turn ended with ${latestReason}.` : "The latest turn did not complete cleanly.",
    }
  }

  if (hasMeaningfulTurnSegmentation({ falseUserEndedCount, latestReason, latestStatus })) {
    return {
      level: "warn",
      title: "Turn segmentation is noisy",
      detail:
        latestReason === "silence_timing" && (adjustedFalseEnds ?? 0) === 0
          ? "The latest turn relied on silence timing instead of a clearly committed boundary."
          : `Extra false user-end detections were observed in the latest turn: ${adjustedFalseEnds ?? 0}.`,
    }
  }

  if (commitBoundaryDrift) {
    return {
      level: "warn",
      title: "Committed response was fast",
      detail: getCommitBoundaryDetail({
        committedResponseMs: committedResponse.valueMs,
        publicTurnCloseMs: pipeline.userEndedToAgentStartMs,
        rawFirstTextMs: pipeline.rawSpeechEndToFirstTextMs,
        rawFirstAudioMs: pipeline.rawSpeechEndToFirstAudioMs,
      }),
    }
  }

  if (
    latestReason === "backend_stall"
    || thresholds.committedResponse.status === "warn"
    || thresholds.committedResponse.status === "bad"
    || (committedResponse.valueMs === null && thresholds.firstText.status === "warn")
    || (committedResponse.valueMs === null && thresholds.firstText.status === "bad")
    || (committedResponse.valueMs === null && thresholds.firstAudio.status === "warn")
    || (committedResponse.valueMs === null && thresholds.firstAudio.status === "bad")
    || (thresholds.firstAudio.valueMs === null
      && (thresholds.backendComplete.status === "warn" || thresholds.backendComplete.status === "bad"))
  ) {
    return {
      level:
        latestReason === "backend_stall"
        || thresholds.committedResponse.status === "bad"
        || (committedResponse.valueMs === null && thresholds.firstText.status === "bad")
        || (committedResponse.valueMs === null && thresholds.firstAudio.status === "bad")
        || (committedResponse.valueMs === null && thresholds.firstAudio.valueMs === null && thresholds.backendComplete.status === "bad")
          ? "bad"
          : "warn",
      title: "Backend felt slow",
      detail: getBackendLagDetail({ currentThinkingMs, thresholds }),
    }
  }

  if (transportSource === "custom" && assistantTranscriptCount === 0) {
    return {
      level: "warn",
      title: "SSE bridge not active",
      detail: "The session is relying on Stream custom events instead of the browser SSE bridge.",
    }
  }

  if (stage === "idle" && turnCount === 0) {
    return {
      level: "neutral",
      title: "Waiting for the next turn",
      detail: "Start a voice turn to populate live latency and turn telemetry.",
    }
  }

  return {
    level: "good",
    title: "Voice pipeline looks healthy",
    detail: "Mic signal, transcript flow, and turn diagnostics are aligned for the latest turn.",
  }
}

function buildTimeline(
  events: NormalizedVoiceCaptureEvent[],
  startAtMs: number | null,
  builder: VoiceDeveloperMetrics["builder"],
  nowMs: number,
): VoiceMetricsTimelineItem[] {
  const items = events
    .map((event) => {
      const data = eventData(event)
      const textPreview = asString(data?.text)
      const phase = eventPhase(event)

      if (event.category === "builder" || event.name === "sophia.builder_task") {
        const builderPayload = event.category === "builder" ? event.payloadRecord : data
        const builderPhase = asString(builderPayload?.phase) ?? asString(builderPayload?.type)?.replace(/^task_/, "")
        const progressPercent = asFiniteNumber(builderPayload?.progressPercent)
          ?? asFiniteNumber(builderPayload?.progress_percent)
        const activeStepTitle = asString(builderPayload?.activeStepTitle)
          ?? asString(builderPayload?.active_step_title)
        const stuck = asBoolean(builderPayload?.stuck)
          ?? asBoolean(builderPayload?.is_stuck)
          ?? false
        const detail = asString(builderPayload?.stuckReason)
          ?? asString(builderPayload?.stuck_reason)
          ?? asString(builderPayload?.detail)
          ?? getBuilderDebugDetail(builderPayload)
          ?? (activeStepTitle ? `Active step: ${activeStepTitle}` : null)
          ?? "Builder status updated"

        return {
          label:
            builderPhase === "completed"
              ? "Builder completed"
              : builderPhase === "failed"
                ? "Builder failed"
                : builderPhase === "timed_out"
                  ? "Builder timed out"
                  : stuck
                    ? "Builder stalled"
                    : "Builder update",
          detail: progressPercent !== null ? `${detail} (${progressPercent}% complete)` : detail,
          tone:
            builderPhase === "failed" || builderPhase === "timed_out"
              ? "bad"
              : stuck
                ? "warn"
                : builderPhase === "completed"
                  ? "good"
                  : "neutral",
        }
      }

      switch (event.name) {
        case "start-talking-requested":
          return {
            label: "Voice start",
            detail: asString(event.payloadRecord?.platform) ?? "Session requested",
            tone: "neutral" as const,
          }
        case "credentials-received":
          return {
            label: "Credentials ready",
            detail: asString(event.payloadRecord?.callId) ?? "Gateway responded",
            tone: "neutral" as const,
          }
        case "call-join-requested":
          return {
            label: "Joining call",
            detail: asString(event.payloadRecord?.callId) ?? "Stream join started",
            tone: "neutral" as const,
          }
        case "call-joined":
          return {
            label: "Call joined",
            detail: asString(event.payloadRecord?.callingState) ?? "Stream joined",
            tone: "good" as const,
          }
        case "remote-audio-bound":
          return {
            label: "Remote audio bound",
            detail: "Playback attached",
            tone: "good" as const,
          }
        case "microphone-enabled":
          return {
            label: "Microphone enabled",
            detail: "Capture requested",
            tone: "good" as const,
          }
        case "microphone-enable-failed":
          return {
            label: "Mic enable failed",
            detail: asString(event.payloadRecord?.error) ?? "Browser blocked capture",
            tone: "bad" as const,
          }
        case "stream-open":
          return {
            label: "SSE bridge open",
            detail: "Browser stream attached",
            tone: "good" as const,
          }
        case "stream-error":
          return {
            label: "SSE bridge error",
            detail: asString(event.payloadRecord?.readyState) ?? "Event stream degraded",
            tone: "warn" as const,
          }
        case "sophia-ready":
          return {
            label: "Sophia ready",
            detail: asString(event.payloadRecord?.reason) ?? "Remote participant ready",
            tone: "good" as const,
          }
        case "microphone-audio-detected":
          return {
            label: "Mic audio detected",
            detail: asFiniteNumber(event.payloadRecord?.rms) !== null
              ? `rms ${asFiniteNumber(event.payloadRecord?.rms)?.toFixed(3)}`
              : "Local audio window observed",
            tone: "good" as const,
          }
        case "sophia.user_transcript":
          return {
            label: "User transcript",
            detail: textPreview ?? "Transcription received",
            tone: "good" as const,
          }
        case "sophia.transcript":
          if (data?.is_final !== true && data?.final !== true) {
            return null
          }

          return {
            label: "Sophia transcript",
            detail: textPreview ?? "Final assistant text",
            tone: "good" as const,
          }
        case "sophia.turn":
          if (phase === "user_ended") {
            return {
              label: "User ended turn",
              detail: "Turn closed for backend",
              tone: "neutral" as const,
            }
          }

          if (phase === "agent_started") {
            return {
              label: "Sophia started",
              detail: "Assistant response began",
              tone: "good" as const,
            }
          }

          if (phase === "agent_ended") {
            return {
              label: "Sophia finished",
              detail: "Assistant playback ended",
              tone: "good" as const,
            }
          }

          return null
        case "sophia.artifact":
          return {
            label: "Artifact received",
            detail: asString(data?.takeaway) ?? "Turn artifact delivered",
            tone: "good" as const,
          }
        case "sophia.turn_diagnostic":
          return {
            label: "Turn diagnostic",
            detail: asString(data?.reason) ?? asString(data?.status) ?? "Turn telemetry emitted",
            tone: asString(data?.status) === "failed" ? "bad" : "neutral",
          }
        case "startup-ready-timeout":
          return {
            label: "Startup timeout",
            detail: "Sophia never became ready",
            tone: "bad" as const,
          }
        case "start-talking-failed":
          return {
            label: "Voice start failed",
            detail: asString(event.payloadRecord?.error) ?? "Connect request failed",
            tone: "bad" as const,
          }
        default:
          return null
      }
    })
    .map((item, index) => {
      if (!item) return null

      return {
        event: events[index],
        item,
      }
    })
    .filter((item): item is {
      event: NormalizedVoiceCaptureEvent
      item: { label: string; detail: string; tone: VoiceMetricsHealthLevel }
    } => Boolean(item))
    .slice(-10)

  const hasExplicitBuilderStall = items.some(({ item }) => item.label === "Builder stalled")
  if (builder.phase === "running" && builder.stuck && !hasExplicitBuilderStall) {
    items.push({
      event: {
        seq: null,
        recordedAt: new Date(nowMs).toISOString(),
        category: "builder",
        name: "task-running",
        payload: {},
        atMs: nowMs,
        payloadRecord: {},
        dataRecord: null,
      },
      item: {
        label: "Builder stalled",
        detail: builder.stuckReason ?? "No visible builder progress detected.",
        tone: "warn",
      },
    })
  }

  return items.map(({ event, item }, index) => ({
    id: `${event.seq ?? index}`,
    at: event.recordedAt,
    sinceStartMs: diffMs(startAtMs, event.atMs),
    label: item.label,
    detail: item.detail,
    tone: item.tone,
  }))
}
export function buildVoiceDeveloperMetrics({
  stage,
  events,
  snapshot,
  nowMs = Date.now(),
  runtimeError,
  runtimeTelemetry,
}: BuildVoiceDeveloperMetricsParams): VoiceDeveloperMetrics {
  const normalizedEvents = events.map(normalizeEvent)
  const lastStartIndex = findLastIndex(
    normalizedEvents,
    (event) => event.category === "voice-session" && event.name === "start-talking-requested",
  )
  const runEvents = lastStartIndex >= 0 ? normalizedEvents.slice(lastStartIndex) : normalizedEvents.slice(-120)
  const activeEvents = runEvents.length > 0 ? runEvents : normalizedEvents

  const latestEvent = activeEvents.at(-1) ?? null
  const lastStartEvent = findLast(activeEvents, (event) => event.name === "start-talking-requested")
  const credentialsReceivedEvent = findLast(activeEvents, (event) => event.name === "credentials-received")
  const joinRequestedEvent = findLast(activeEvents, (event) => event.name === "call-join-requested")
  const joinedEvent = findLast(activeEvents, (event) => event.name === "call-joined")
    ?? findLast(
      activeEvents,
      (event) => event.name === "calling-state-changed" && asString(event.payloadRecord?.callingState) === "joined",
    )
  const readyEvent = findLast(activeEvents, (event) => event.name === "sophia-ready")
  const sseOpenEvent = findLast(activeEvents, (event) => event.name === "stream-open")
  const lastUserEndedIndex = findLastIndex(
    activeEvents,
    (event) => event.name === "sophia.turn" && eventPhase(event) === "user_ended",
  )
  const lastAgentStartedIndex = findLastIndex(
    activeEvents,
    (event) => event.name === "sophia.turn" && eventPhase(event) === "agent_started",
  )
  const lastUserTranscriptEvent = findLast(activeEvents, (event) => event.name === "sophia.user_transcript")
  const lastAssistantTranscriptEvent = findLast(
    activeEvents,
    (event) => event.name === "sophia.transcript" && (eventData(event)?.is_final === true || eventData(event)?.final === true),
  )
    ?? findLast(activeEvents, (event) => event.name === "sophia.transcript")
  const lastUserEndedEvent = findLast(
    activeEvents,
    (event) => event.name === "sophia.turn" && eventPhase(event) === "user_ended",
  )
  const lastAgentStartedEvent = findLast(
    activeEvents,
    (event) => event.name === "sophia.turn" && eventPhase(event) === "agent_started",
  )
  const lastAgentEndedEvent = findLast(
    activeEvents,
    (event) => event.name === "sophia.turn" && eventPhase(event) === "agent_ended",
  )
  const lastDiagnosticEvent = findLast(activeEvents, (event) => event.name === "sophia.turn_diagnostic")
  const lastDiagnostic = lastDiagnosticEvent ? eventData(lastDiagnosticEvent) : null
  const firstMicAudioEvent = findFirst(activeEvents, (event) => event.name === "microphone-audio-detected")
  const firstUserTranscriptEvent = findFirst(activeEvents, (event) => event.name === "sophia.user_transcript")
  const remoteAudioBoundEvent = findLast(activeEvents, (event) => event.name === "remote-audio-bound")
  const firstAssistantTextAfterLastUserEnded = lastUserEndedIndex >= 0
    ? findFirst(
      activeEvents.slice(lastUserEndedIndex + 1),
      (event) => event.name === "sophia.transcript",
    )
    : null

  const userTranscriptCount = countWhere(activeEvents, (event) => event.name === "sophia.user_transcript")
  const assistantTranscriptCount = countWhere(
    activeEvents,
    (event) => event.name === "sophia.transcript" && (eventData(event)?.is_final === true || eventData(event)?.final === true),
  )
  const artifactMetrics = buildArtifactTelemetryCountsFromEvents(activeEvents, snapshot)
  const diagnosticCount = countWhere(activeEvents, (event) => event.name === "sophia.turn_diagnostic")
  const builderEvents = countWhere(activeEvents, (event) => event.category === "builder" || event.name === "sophia.builder_task")
  const turnCount = Math.max(
    diagnosticCount,
    countWhere(activeEvents, (event) => event.name === "sophia.turn" && eventPhase(event) === "agent_started"),
    userTranscriptCount,
  )

  const microphone = buildMicrophone(snapshot?.harness?.microphone)
  const builder = buildBuilderMetrics(activeEvents, nowMs)
  const providerInputTranscriptionCount = geminiProviderCategoryCount(
    activeEvents,
    runtimeTelemetry,
    "inputTranscription",
  )
  const lastEventAgeMs = diffMs(latestEvent?.atMs ?? null, nowMs)
  const currentThinkingMs = stage === "thinking" ? diffMs(lastUserEndedEvent?.atMs ?? null, nowMs) : null
  const transportSource: VoiceDeveloperMetrics["transport"]["activeSource"] =
    activeEvents.some((event) => event.category === "voice-sse" && event.name.startsWith("sophia."))
      ? "sse"
      : activeEvents.some((event) => event.category === "stream-custom" && event.name.startsWith("sophia."))
        ? "custom"
        : sseOpenEvent
          ? "sse"
          : "pending"

  const sessionId = snapshot?.session?.sessionId
    ?? snapshot?.metadata?.currentSessionId
    ?? latestValue(activeEvents, ["sessionId"])
  const threadId = snapshot?.session?.threadId
    ?? snapshot?.metadata?.currentThreadId
    ?? latestValue(activeEvents, ["threadId"])
  const callId = latestValue(activeEvents, ["callId"])
  const voiceAgentSessionId = latestValue(activeEvents, ["voiceAgentSessionId"])
  const runId = snapshot?.metadata?.currentRunId ?? null
  const remoteParticipantCount = latestNumber(activeEvents, ["remoteParticipantCount"])
  const lastUserTranscript = lastUserTranscriptEvent ? asString(eventData(lastUserTranscriptEvent)?.text) : null
  const lastAssistantTranscript = lastAssistantTranscriptEvent
    ? asString(eventData(lastAssistantTranscriptEvent)?.text)
    : null
  const backendRequestStartMs = asFiniteNumber(lastDiagnostic?.backend_request_start_ms)
  const backendFirstEventMs = asFiniteNumber(lastDiagnostic?.backend_first_event_ms)
  const firstTextMs = asFiniteNumber(lastDiagnostic?.first_text_ms)
  const backendCompleteMs = asFiniteNumber(lastDiagnostic?.backend_complete_ms)
  const firstAudioMs = asFiniteNumber(lastDiagnostic?.first_audio_ms)
  const submissionStabilizationMs = asFiniteNumber(lastDiagnostic?.submission_stabilization_ms)
  const responseDurationMs = diffMs(lastAgentStartedEvent?.atMs ?? null, lastAgentEndedEvent?.atMs ?? null)
  const falseUserEndedCount = asFiniteNumber(lastDiagnostic?.raw_false_end_count)
  const duplicatePhaseCounts = normalizeDuplicatePhaseCounts(lastDiagnostic?.duplicate_phase_counts)
  const lastCommittedUserTranscriptEvent = lastAgentStartedIndex >= 0
    ? findLast(
      activeEvents.slice(0, lastAgentStartedIndex + 1),
      (event) => event.name === "sophia.user_transcript",
    )
    : null
  const committedTurnCloseMs = diffMs(lastCommittedUserTranscriptEvent?.atMs ?? null, lastAgentStartedEvent?.atMs ?? null)
  const committedFirstTextMs = diffMs(lastUserEndedEvent?.atMs ?? null, firstAssistantTextAfterLastUserEnded?.atMs ?? null)
  const committedResponse = selectCommittedResponse({
    committedTurnCloseMs,
    userEndedToFirstTextMs: committedFirstTextMs,
    userEndedToAgentStartMs: diffMs(lastUserEndedEvent?.atMs ?? null, lastAgentStartedEvent?.atMs ?? null),
  })
  const startup: VoiceStartupMetrics = {
    requestToCredentialsMs: diffMs(lastStartEvent?.atMs ?? null, credentialsReceivedEvent?.atMs ?? null),
    credentialsToJoinMs: diffMs(credentialsReceivedEvent?.atMs ?? null, joinRequestedEvent?.atMs ?? null),
    joinToReadyMs: diffMs(joinedEvent?.atMs ?? null, readyEvent?.atMs ?? null),
    joinToRemoteAudioMs: diffMs(joinedEvent?.atMs ?? null, remoteAudioBoundEvent?.atMs ?? null),
    startToMicAudioMs: diffMs(lastStartEvent?.atMs ?? null, firstMicAudioEvent?.atMs ?? null),
    startToFirstUserTranscriptMs: diffMs(lastStartEvent?.atMs ?? null, firstUserTranscriptEvent?.atMs ?? null),
  }
  const pipeline: VoicePipelineMetrics = {
    micToUserTranscriptMs: diffMs(firstMicAudioEvent?.atMs ?? null, firstUserTranscriptEvent?.atMs ?? null),
    transcriptToUserEndedMs: diffMs(lastUserTranscriptEvent?.atMs ?? null, lastUserEndedEvent?.atMs ?? null),
    committedTurnCloseMs,
    userEndedToRequestStartMs: backendRequestStartMs,
    submissionStabilizationMs,
    requestStartToFirstBackendEventMs: diffMs(backendRequestStartMs, backendFirstEventMs),
    firstBackendEventToFirstTextMs: diffMs(backendFirstEventMs, firstTextMs),
    requestStartToFirstTextMs: diffMs(backendRequestStartMs, firstTextMs),
    userEndedToAgentStartMs: diffMs(lastUserEndedEvent?.atMs ?? null, lastAgentStartedEvent?.atMs ?? null),
    userEndedToFirstTextMs: committedFirstTextMs,
    rawSpeechEndToFirstTextMs: firstTextMs,
    firstTextToBackendCompleteMs: diffMs(firstTextMs, backendCompleteMs),
    backendToFirstAudioMs: diffMs(backendCompleteMs, firstAudioMs),
    textToFirstAudioMs: diffMs(firstTextMs, firstAudioMs),
    rawSpeechEndToBackendCompleteMs: backendCompleteMs,
    rawSpeechEndToFirstAudioMs: firstAudioMs,
  }
  const thresholds = buildThresholds({
    stage,
    sessionReadyMs: diffMs(lastStartEvent?.atMs ?? null, readyEvent?.atMs ?? null),
    joinLatencyMs: diffMs(joinRequestedEvent?.atMs ?? credentialsReceivedEvent?.atMs ?? null, joinedEvent?.atMs ?? null),
    committedResponseMs: committedResponse.valueMs,
    firstTextMs,
    firstAudioMs,
    backendCompleteMs,
    currentThinkingMs,
    responseDurationMs,
  })
  const regressions = buildRegressionMarkers({
    stage,
    microphone,
    builder,
    userTranscriptCount,
    providerInputTranscriptionCount,
    falseUserEndedCount,
    duplicatePhaseCounts,
    latestReason: asString(lastDiagnostic?.reason),
    currentThinkingMs,
    pipeline,
    thresholds,
  })
  const eventsSummary = buildEventCounters(activeEvents)
  const recentTurns = buildRecentTurns(activeEvents)
  const bottleneck = buildBottleneckDiagnosis({
    stage,
    turnCount,
    microphone,
    userTranscriptCount,
    providerInputTranscriptionCount,
    assistantTranscriptCount,
    falseUserEndedCount,
    duplicatePhaseCounts,
    latestReason: asString(lastDiagnostic?.reason),
    latestStatus: asString(lastDiagnostic?.status),
    transportSource,
    events: eventsSummary,
    startup,
    pipeline,
    thresholds,
  })

  const health = summarizeHealth({
    stage,
    microphone,
    builder,
    runtimeError,
    transportSource,
    currentThinkingMs,
    latestDiagnostic: lastDiagnostic,
    userTranscriptCount,
    providerInputTranscriptionCount,
    assistantTranscriptCount,
    turnCount,
    pipeline,
    thresholds,
  })

  const sessionIds = {
    sessionId,
    threadId,
    callId,
    voiceAgentSessionId,
    runId,
  }
  const transport = {
    activeSource: transportSource,
    remoteParticipantCount,
    streamOpen: Boolean(sseOpenEvent),
    lastEventAt: latestEvent?.recordedAt ?? null,
  }
  const counts = {
    turns: turnCount,
    userTranscripts: userTranscriptCount,
    assistantTranscripts: assistantTranscriptCount,
    artifacts: artifactMetrics.artifactCount,
    artifactPublicEventCount: artifactMetrics.artifactPublicEventCount,
    artifactRuntimeIngestCount: artifactMetrics.artifactRuntimeIngestCount,
    artifactRenderedCount: artifactMetrics.artifactRenderedCount,
    artifactCountSource: artifactMetrics.artifactCountSource,
    artifactCountMismatch: artifactMetrics.artifactCountMismatch,
    diagnostics: diagnosticCount,
    builderEvents,
  }
  const timings = {
    joinLatencyMs: thresholds.joinLatency.valueMs,
    sessionReadyMs: thresholds.sessionReady.valueMs,
    sseOpenMs: diffMs(credentialsReceivedEvent?.atMs ?? null, sseOpenEvent?.atMs ?? null),
    currentThinkingMs,
    lastEventAgeMs,
  }
  const lastTurn = {
    turnId: asString(lastDiagnostic?.turn_id),
    status: asString(lastDiagnostic?.status),
    reason: asString(lastDiagnostic?.reason),
    backendRequestStartMs,
    backendFirstEventMs,
    firstTextMs,
    backendCompleteMs,
    firstAudioMs,
    agentStartLatencyMs: diffMs(lastUserEndedEvent?.atMs ?? null, lastAgentStartedEvent?.atMs ?? null),
    responseDurationMs,
    falseUserEndedCount,
    duplicatePhaseCounts,
    lastUserTranscript,
    lastAssistantTranscript,
    lastUserTranscriptAt: lastUserTranscriptEvent?.recordedAt ?? null,
    lastAssistantTranscriptAt: lastAssistantTranscriptEvent?.recordedAt ?? null,
  }
  const sessionTelemetry = buildSessionTelemetry({
    runtimeTelemetry,
    activeEvents,
    sessionIds,
    transport,
    timings,
    counts,
    lastTurn,
    nowMs,
  })

  return {
    stage,
    sessionTelemetry,
    sessionIds,
    transport,
    counts,
    timings,
    lastTurn,
    microphone,
    builder,
    health,
    thresholds,
    startup,
    pipeline,
    events: eventsSummary,
    recentTurns,
    bottleneck,
    regressions,
    timeline: buildTimeline(
      activeEvents,
      lastStartEvent?.atMs ?? activeEvents[0]?.atMs ?? null,
      builder,
      nowMs,
    ),
  }
}