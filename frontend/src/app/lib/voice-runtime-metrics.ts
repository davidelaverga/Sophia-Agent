import type { BuilderTaskV1 } from "../types/builder-task"

import type {
  SophiaCaptureMicrophoneSummary,
  SophiaCaptureSnapshot,
  SophiaCaptureWebRTCSummary,
} from "./session-capture"
import type { VoiceStage } from "./voice-types"

export type VoiceCaptureEvent = {
  seq: number
  recordedAt: string
  category: string
  name: string
  payload?: unknown
}

export type VoiceMetricsHealthLevel = "good" | "warn" | "bad" | "neutral"

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
  key: "microphone" | "turn-segmentation" | "backend-stall" | "commit-boundary" | "builder-stall" | "playback" | "reconnect"
  title: string
  detail: string
  level: "warn" | "bad"
}

export type VoiceCredentialsSource = "prefetched" | "fresh" | "pending"

export type VoiceWarmupStatus = "idle" | "pending" | "completed" | "failed"

export type VoiceStartupMetrics = {
  credentialsSource: VoiceCredentialsSource
  preconnectFetchMs: number | null
  preparedCredentialAgeMs: number | null
  preconnectError: string | null
  requestToCredentialsMs: number | null
  credentialsToJoinMs: number | null
  joinToReadyMs: number | null
  joinToRemoteAudioMs: number | null
  joinToPlaybackStartMs: number | null
  bindToPlaybackStartMs: number | null
  startToMicAudioMs: number | null
  startToFirstUserTranscriptMs: number | null
  backendWarmupStatus: VoiceWarmupStatus
  backendWarmupDurationMs: number | null
  backendWarmupError: string | null
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
  playbackBound: number
  playbackCanPlay: number
  playbackStarted: number
  playbackWaiting: number
  playbackStalled: number
  playbackErrors: number
  playbackTimeouts: number
  preconnectStarted: number
  preconnectReady: number
  preconnectReused: number
  preconnectFailed: number
  warmupStarted: number
  warmupCompleted: number
  warmupFailed: number
  reconnectStarted: number
  reconnectRecovered: number
  reconnectFailed: number
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
  /**
   * Raw count of `user_ended` events emitted for this turn. A clean turn
   * emits exactly one, so baseline value is `1`, NOT `0`. Values > 1
   * indicate genuine false-ends. Prefer {@link extraFalseUserEndedCount}
   * for alarming or rollup metrics — that one is already baseline-adjusted.
   */
  falseUserEndedCount: number | null
  /**
   * Baseline-adjusted false user-ended count: `max(falseUserEndedCount - 1, 0)`.
   * 0 = clean turn, >0 = genuine false-ends.
   */
  extraFalseUserEndedCount: number | null
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

export type VoiceLatencyArea = "startup" | "turn" | "backend" | "playback" | "transport"

export type VoiceLatencyHotspot = {
  key:
    | "preconnect-fetch"
    | "backend-warmup"
    | "request-to-credentials"
    | "credentials-to-join"
    | "join-to-ready"
    | "bind-to-playback"
    | "mic-to-transcript"
    | "committed-turn-close"
    | "user-ended-to-request"
    | "request-to-first-backend-event"
    | "first-backend-event-to-first-text"
    | "first-text-to-backend-complete"
    | "backend-to-first-audio"
    | "text-to-first-audio"
    | "playback-timeout"
    | "reconnect-downtime"
  area: VoiceLatencyArea
  label: string
  valueMs: number
  level: VoiceMetricsHealthLevel
}

export type VoiceLatencyBreakdown = {
  startup: {
    preconnectFetchMs: number | null
    backendWarmupDurationMs: number | null
    requestToCredentialsMs: number | null
    credentialsToJoinMs: number | null
    joinToReadyMs: number | null
    bindToPlaybackStartMs: number | null
  }
  turn: {
    micToUserTranscriptMs: number | null
    transcriptToUserEndedMs: number | null
    committedTurnCloseMs: number | null
    userEndedToRequestStartMs: number | null
    submissionStabilizationMs: number | null
  }
  backend: {
    requestStartToFirstBackendEventMs: number | null
    firstBackendEventToFirstTextMs: number | null
    firstTextToBackendCompleteMs: number | null
  }
  playback: {
    backendToFirstAudioMs: number | null
    textToFirstAudioMs: number | null
    bindToPlayingMs: number | null
    lastTimeoutDurationMs: number | null
  }
  transport: {
    sseOpenMs: number | null
    reconnectLastDowntimeMs: number | null
    reconnectTotalDowntimeMs: number | null
    reconnectActiveDowntimeMs: number | null
  }
}

export type VoiceBaselineMetricKey =
  | "session-ready"
  | "join-latency"
  | "backend-first-text"
  | "playback-start"
  | "transport-rtt"
  | "transport-jitter"
  | "transport-loss"

export type VoiceBaselineRegression = {
  key: VoiceBaselineMetricKey
  title: string
  detail: string
  level: "warn" | "bad"
  currentValue: number
  baselineValue: number
  deltaValue: number
  deltaPercent: number
}

export type VoiceTelemetryBaselineEntry = {
  runKey: string
  recordedAt: string
  sessionId: string | null
  runId: string | null
  activeRunStartedAt: string | null
  metrics: {
    sessionReadyMs: number | null
    joinLatencyMs: number | null
    requestStartToFirstTextMs: number | null
    bindToPlaybackStartMs: number | null
    subscriberRoundTripTimeMs: number | null
    subscriberJitterMs: number | null
    subscriberPacketLossPct: number | null
  }
}

export type VoiceBaselineComparison = {
  runKey: string | null
  sampleSize: number
  comparedAt: string | null
  medians: {
    sessionReadyMs: number | null
    joinLatencyMs: number | null
    requestStartToFirstTextMs: number | null
    bindToPlaybackStartMs: number | null
    subscriberRoundTripTimeMs: number | null
    subscriberJitterMs: number | null
    subscriberPacketLossPct: number | null
  }
  regressions: VoiceBaselineRegression[]
}

export type VoiceTelemetrySummary = {
  stage: VoiceStage
  healthLevel: VoiceMetricsHealthLevel
  healthTitle: string
  bottleneckKind: VoiceBottleneckKind
  bottleneckLevel: VoiceMetricsHealthLevel
  bottleneckHint: string
  transportSource: VoiceDeveloperMetrics["transport"]["activeSource"]
  regressionKeys: VoiceRegressionMarker["key"][]
  baselineSampleSize: number
  baselineRegressionKeys: VoiceBaselineMetricKey[]
  latencyBreakdownMs: VoiceLatencyBreakdown
  topHotspots: VoiceLatencyHotspot[]
  sessionReadyMs: number | null
  joinLatencyMs: number | null
  credentialsSource: VoiceCredentialsSource
  preconnectFetchMs: number | null
  preparedCredentialAgeMs: number | null
  joinToPlaybackStartMs: number | null
  bindToPlaybackStartMs: number | null
  backendWarmupStatus: VoiceWarmupStatus
  backendWarmupDurationMs: number | null
  committedResponseMs: number | null
  committedResponseSource: "committed_user_transcript" | "public_turn_event" | null
  publicTurnCloseMs: number | null
  submissionStabilizationMs: number | null
  committedFirstTextMs: number | null
  rawFirstTextMs: number | null
  rawBackendCompleteMs: number | null
  rawFirstAudioMs: number | null
  responseWindowMs: number | null
  networkOnline: boolean | null
  networkEffectiveType: string | null
  networkRttMs: number | null
  networkDownlinkMbps: number | null
  webrtcDatacenter: string | null
  webrtcSampleCount: number
  webrtcSubscriberRoundTripTimeMs: number | null
  webrtcSubscriberJitterMs: number | null
  webrtcSubscriberPacketLossPct: number | null
  playbackState: VoiceDeveloperMetrics["transport"]["playback"]["currentState"]
  reconnectCount: number
  reconnectTotalDowntimeMs: number | null
  reconnectActiveDowntimeMs: number | null
  builderPhase: BuilderTaskV1["phase"] | null
  builderProgressPercent: number | null
  builderStuck: boolean
}

export type VoiceDeveloperMetrics = {
  stage: VoiceStage
  sessionIds: {
    sessionId: string | null
    threadId: string | null
    callId: string | null
    voiceAgentSessionId: string | null
    runId: string | null
    activeRunStartedAt: string | null
  }
  transport: {
    activeSource: "sse" | "custom" | "pending"
    remoteParticipantCount: number | null
    streamOpen: boolean
    lastEventAt: string | null
    network: {
      online: boolean | null
      effectiveType: string | null
      rttMs: number | null
      downlinkMbps: number | null
      saveData: boolean | null
    }
    playback: {
      currentState: "pending" | "bound" | "canplay" | "playing" | "waiting" | "stalled" | "error" | "timed_out"
      participantSessionId: string | null
      canPlayAt: string | null
      playingAt: string | null
      bindToCanPlayMs: number | null
      bindToPlayingMs: number | null
      lastTimeoutDurationMs: number | null
      timeoutCount: number
      waitingCount: number
      stalledCount: number
      errorCount: number
      lastError: string | null
    }
    reconnect: {
      count: number
      recovered: number
      failed: number
      lastDowntimeMs: number | null
      totalDowntimeMs: number | null
      activeDowntimeMs: number | null
    }
    webrtc: {
      datacenter: string | null
      sampleCount: number
      firstSampleAt: string | null
      lastSampleAt: string | null
      publisher: {
        sampleCount: number
        codec: string | null
        lastRoundTripTimeMs: number | null
        averageRoundTripTimeMs: number | null
        maxRoundTripTimeMs: number | null
        lastJitterMs: number | null
        averageJitterMs: number | null
        maxJitterMs: number | null
        lastPacketLossPct: number | null
        averagePacketLossPct: number | null
        maxPacketLossPct: number | null
        totalBytesSent: number | null
        totalBytesReceived: number | null
      }
      subscriber: {
        sampleCount: number
        codec: string | null
        lastRoundTripTimeMs: number | null
        averageRoundTripTimeMs: number | null
        maxRoundTripTimeMs: number | null
        lastJitterMs: number | null
        averageJitterMs: number | null
        maxJitterMs: number | null
        lastPacketLossPct: number | null
        averagePacketLossPct: number | null
        maxPacketLossPct: number | null
        totalBytesSent: number | null
        totalBytesReceived: number | null
      }
    }
  }
  counts: {
    turns: number
    userTranscripts: number
    assistantTranscripts: number
    artifacts: number
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
    /**
     * Raw count of `user_ended` events for the latest turn. Baseline is 1
     * (clean turn emits exactly one user_ended). Use
     * {@link extraFalseUserEndedCount} for alarming.
     */
    falseUserEndedCount: number | null
    /** Baseline-adjusted: `max(falseUserEndedCount - 1, 0)`. */
    extraFalseUserEndedCount: number | null
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
  latencyBreakdown: VoiceLatencyBreakdown
  topHotspots: VoiceLatencyHotspot[]
  baseline: VoiceBaselineComparison
  regressions: VoiceRegressionMarker[]
  timeline: VoiceMetricsTimelineItem[]
}

type BuildVoiceDeveloperMetricsParams = {
  stage: VoiceStage
  events: VoiceCaptureEvent[]
  snapshot?: SophiaCaptureSnapshot | null
  baselineEntries?: VoiceTelemetryBaselineEntry[]
  nowMs?: number
  runtimeError?: string
}

type BuildVoiceDeveloperMetricsFromCaptureParams = {
  capture: {
    events: VoiceCaptureEvent[]
    snapshot?: SophiaCaptureSnapshot | null
  }
  baselineEntries?: VoiceTelemetryBaselineEntry[]
  nowMs?: number
  runtimeError?: string
  stage?: VoiceStage
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

const DEFAULT_NETWORK: VoiceDeveloperMetrics["transport"]["network"] = {
  online: null,
  effectiveType: null,
  rttMs: null,
  downlinkMbps: null,
  saveData: null,
}

const DEFAULT_PLAYBACK: VoiceDeveloperMetrics["transport"]["playback"] = {
  currentState: "pending",
  participantSessionId: null,
  canPlayAt: null,
  playingAt: null,
  bindToCanPlayMs: null,
  bindToPlayingMs: null,
  lastTimeoutDurationMs: null,
  timeoutCount: 0,
  waitingCount: 0,
  stalledCount: 0,
  errorCount: 0,
  lastError: null,
}

const DEFAULT_RECONNECT: VoiceDeveloperMetrics["transport"]["reconnect"] = {
  count: 0,
  recovered: 0,
  failed: 0,
  lastDowntimeMs: null,
  totalDowntimeMs: null,
  activeDowntimeMs: null,
}

const DEFAULT_WEBRTC_DIRECTION: VoiceDeveloperMetrics["transport"]["webrtc"]["subscriber"] = {
  sampleCount: 0,
  codec: null,
  lastRoundTripTimeMs: null,
  averageRoundTripTimeMs: null,
  maxRoundTripTimeMs: null,
  lastJitterMs: null,
  averageJitterMs: null,
  maxJitterMs: null,
  lastPacketLossPct: null,
  averagePacketLossPct: null,
  maxPacketLossPct: null,
  totalBytesSent: null,
  totalBytesReceived: null,
}

const DEFAULT_WEBRTC: VoiceDeveloperMetrics["transport"]["webrtc"] = {
  datacenter: null,
  sampleCount: 0,
  firstSampleAt: null,
  lastSampleAt: null,
  publisher: { ...DEFAULT_WEBRTC_DIRECTION },
  subscriber: { ...DEFAULT_WEBRTC_DIRECTION },
}

const DEFAULT_BASELINE_COMPARISON: VoiceBaselineComparison = {
  runKey: null,
  sampleSize: 0,
  comparedAt: null,
  medians: {
    sessionReadyMs: null,
    joinLatencyMs: null,
    requestStartToFirstTextMs: null,
    bindToPlaybackStartMs: null,
    subscriberRoundTripTimeMs: null,
    subscriberJitterMs: null,
    subscriberPacketLossPct: null,
  },
  regressions: [],
}

const PRE_START_PREPARATION_EVENT_NAMES = new Set([
  "preconnect-started",
  "preconnect-ready",
  "preconnect-failed",
  "backend-warmup-started",
  "backend-warmup-completed",
  "backend-warmup-failed",
])

// Upper bound on a realistic mic-onset -> transcript gap. Above this the gap
// almost certainly includes user idle/thinking time (e.g. a long pause between
// turns), not STT latency. We null the value in that case so the "mic ->
// transcript" hotspot does not flash red on quiet sessions.
const MIC_TO_TRANSCRIPT_SANITY_CEILING_MS = 5000

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

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
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

/**
 * Compute a per-latest-turn approximation of mic-onset -> user-transcript.
 *
 * The raw `firstMicAudioEvent -> firstUserTranscriptEvent` diff is session-wide
 * and grows unboundedly if the user idles before speaking (observed: 21.9 s on
 * a session where the user thought for ~22 s before the first utterance). That
 * drift made the "mic -> transcript" hotspot flash "bad" on healthy sessions.
 *
 * The anchor rules here:
 *   - Turn >=2: previous `agent_ended` event -> most recent user transcript.
 *     This captures mic-onset + STT for the latest user turn, not session idle
 *     time before turn 1.
 *   - Turn 1 (no prior agent_ended): `firstMicAudioEvent -> firstUserTranscript`
 *     as before, but capped at {@link MIC_TO_TRANSCRIPT_SANITY_CEILING_MS}.
 *     Values above the ceiling almost certainly include idle thinking time and
 *     are nulled out rather than reported as STT latency.
 */
function computeMicToUserTranscriptMs(params: {
  firstMicAudioAtMs: number | null
  firstUserTranscriptAtMs: number | null
  lastUserTranscriptAtMs: number | null
  lastAgentEndedAtMs: number | null
}): number | null {
  const {
    firstMicAudioAtMs,
    firstUserTranscriptAtMs,
    lastUserTranscriptAtMs,
    lastAgentEndedAtMs,
  } = params

  // Prefer per-turn anchor: previous agent turn ended -> latest user transcript.
  if (
    lastAgentEndedAtMs !== null
    && lastUserTranscriptAtMs !== null
    && lastUserTranscriptAtMs > lastAgentEndedAtMs
  ) {
    const perTurn = diffMs(lastAgentEndedAtMs, lastUserTranscriptAtMs)
    if (perTurn !== null && perTurn <= MIC_TO_TRANSCRIPT_SANITY_CEILING_MS) {
      return perTurn
    }
    // fall through — value exceeds sanity ceiling, treat as idle and null below.
    return null
  }

  // First-turn fallback: first mic audio -> first user transcript, capped.
  const firstTurn = diffMs(firstMicAudioAtMs, firstUserTranscriptAtMs)
  if (firstTurn === null) return null
  if (firstTurn > MIC_TO_TRANSCRIPT_SANITY_CEILING_MS) return null
  return firstTurn
}

function sumFiniteNumbers(values: Array<number | null>): number | null {
  let total = 0
  let hasValues = false

  for (const value of values) {
    if (value === null) {
      continue
    }

    total += value
    hasValues = true
  }

  return hasValues ? total : null
}

function maxFiniteNumber(values: Array<number | null>): number | null {
  let max: number | null = null

  for (const value of values) {
    if (value === null) {
      continue
    }

    max = max === null ? value : Math.max(max, value)
  }

  return max
}

function compactNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value))
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

function findLatestTimedEvent(
  values: Array<NormalizedVoiceCaptureEvent | null>,
): NormalizedVoiceCaptureEvent | null {
  let latest: NormalizedVoiceCaptureEvent | null = null

  for (const value of values) {
    if (!value) {
      continue
    }

    if (latest === null || (value.atMs ?? -Infinity) >= (latest.atMs ?? -Infinity)) {
      latest = value
    }
  }

  return latest
}

function countWhere<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0)
}

function isPreStartPreparationEvent(event: NormalizedVoiceCaptureEvent): boolean {
  return PRE_START_PREPARATION_EVENT_NAMES.has(event.name)
}

function findActiveRunStartIndex(
  events: NormalizedVoiceCaptureEvent[],
  lastStartIndex: number,
): number {
  if (lastStartIndex < 0) {
    return Math.max(0, events.length - 120)
  }

  let startIndex = lastStartIndex

  for (let index = lastStartIndex - 1; index >= 0; index -= 1) {
    if (!isPreStartPreparationEvent(events[index])) {
      break
    }

    startIndex = index
  }

  return startIndex
}

export function sliceVoiceCaptureEventsToActiveRun(events: VoiceCaptureEvent[]): VoiceCaptureEvent[] {
  if (events.length === 0) {
    return []
  }

  const normalizedEvents = events.map(normalizeEvent)
  const lastStartIndex = findLastIndex(
    normalizedEvents,
    (event) => event.category === "voice-session" && event.name === "start-talking-requested",
  )
  const activeRunStartIndex = findActiveRunStartIndex(normalizedEvents, lastStartIndex)
  const activeRunEvents = events.slice(activeRunStartIndex)

  return activeRunEvents.length > 0 ? activeRunEvents : events
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

function eventData(event: NormalizedVoiceCaptureEvent): Record<string, unknown> | null {
  return event.dataRecord ?? event.payloadRecord
}

function eventPhase(event: NormalizedVoiceCaptureEvent): string | null {
  const data = eventData(event)
  return asString(data?.phase) ?? asString(data?.status)
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

function buildNetwork(snapshot: SophiaCaptureSnapshot | null | undefined): VoiceDeveloperMetrics["transport"]["network"] {
  const network = snapshot?.network
  if (!network) {
    return DEFAULT_NETWORK
  }

  return {
    online: typeof network.online === "boolean" ? network.online : null,
    effectiveType: asString(network.effectiveType),
    rttMs: asFiniteNumber(network.rttMs),
    downlinkMbps: asFiniteNumber(network.downlinkMbps),
    saveData: typeof network.saveData === "boolean" ? network.saveData : null,
  }
}

function buildWebRTCDirectionMetrics(
  direction: SophiaCaptureWebRTCSummary["publisher"] | null | undefined,
): VoiceDeveloperMetrics["transport"]["webrtc"]["subscriber"] {
  if (!direction) {
    return DEFAULT_WEBRTC_DIRECTION
  }

  return {
    sampleCount: typeof direction.sampleCount === "number" ? direction.sampleCount : 0,
    codec: asString(direction.codec),
    lastRoundTripTimeMs: asFiniteNumber(direction.lastRoundTripTimeMs),
    averageRoundTripTimeMs: asFiniteNumber(direction.averageRoundTripTimeMs),
    maxRoundTripTimeMs: asFiniteNumber(direction.maxRoundTripTimeMs),
    lastJitterMs: asFiniteNumber(direction.lastJitterMs),
    averageJitterMs: asFiniteNumber(direction.averageJitterMs),
    maxJitterMs: asFiniteNumber(direction.maxJitterMs),
    lastPacketLossPct: asFiniteNumber(direction.lastPacketLossPct),
    averagePacketLossPct: asFiniteNumber(direction.averagePacketLossPct),
    maxPacketLossPct: asFiniteNumber(direction.maxPacketLossPct),
    totalBytesSent: asFiniteNumber(direction.totalBytesSent),
    totalBytesReceived: asFiniteNumber(direction.totalBytesReceived),
  }
}

function buildWebRTC(snapshot: SophiaCaptureSnapshot | null | undefined): VoiceDeveloperMetrics["transport"]["webrtc"] {
  const webrtc = snapshot?.harness?.webrtc
  if (!webrtc) {
    return DEFAULT_WEBRTC
  }

  return {
    datacenter: asString(webrtc.datacenter),
    sampleCount: typeof webrtc.sampleCount === "number" ? webrtc.sampleCount : (Array.isArray(webrtc.recentSamples) ? webrtc.recentSamples.length : 0),
    firstSampleAt: asString(webrtc.firstSampleAt),
    lastSampleAt: asString(webrtc.lastSampleAt),
    publisher: buildWebRTCDirectionMetrics(webrtc.publisher),
    subscriber: buildWebRTCDirectionMetrics(webrtc.subscriber),
  }
}

function buildBaselineRunKey(params: {
  sessionId: string | null
  runId: string | null
  activeRunStartedAt: string | null
}): string | null {
  const { sessionId, runId, activeRunStartedAt } = params
  if (!sessionId && !runId && !activeRunStartedAt) {
    return null
  }

  return [sessionId ?? "session", runId ?? "run", activeRunStartedAt ?? "active-run"].join("::")
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middleIndex = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[middleIndex] ?? null
  }

  const lower = sorted[middleIndex - 1]
  const upper = sorted[middleIndex]
  if (lower === undefined || upper === undefined) {
    return null
  }

  return (lower + upper) / 2
}

function formatBaselineDelta(deltaPercent: number): string {
  const rounded = Math.round(deltaPercent)
  return `${rounded > 0 ? "+" : ""}${rounded}%`
}

function createBaselineRegression(params: {
  key: VoiceBaselineMetricKey
  title: string
  currentValue: number | null
  baselineValue: number | null
  warnRatio: number
  badRatio: number
  warnDelta: number
  badDelta: number
  fallbackWarnValue?: number
  fallbackBadValue?: number
  formatter?: (value: number) => string
}): VoiceBaselineRegression | null {
  const {
    key,
    title,
    currentValue,
    baselineValue,
    warnRatio,
    badRatio,
    warnDelta,
    badDelta,
    fallbackWarnValue,
    fallbackBadValue,
    formatter = (value) => `${Math.round(value)}`,
  } = params

  if (currentValue === null || baselineValue === null) {
    return null
  }

  const deltaValue = currentValue - baselineValue
  if (!Number.isFinite(deltaValue) || deltaValue <= 0) {
    return null
  }

  const deltaPercent = baselineValue > 0
    ? (deltaValue / baselineValue) * 100
    : 100

  const warnTriggered = baselineValue > 0
    ? currentValue >= baselineValue * warnRatio && deltaValue >= warnDelta
    : fallbackWarnValue !== undefined && currentValue >= fallbackWarnValue
  const badTriggered = baselineValue > 0
    ? currentValue >= baselineValue * badRatio && deltaValue >= badDelta
    : fallbackBadValue !== undefined && currentValue >= fallbackBadValue

  if (!warnTriggered && !badTriggered) {
    return null
  }

  return {
    key,
    title,
    detail: `${title}: current ${formatter(currentValue)} vs median ${formatter(baselineValue)} (${formatBaselineDelta(deltaPercent)}).`,
    level: badTriggered ? "bad" : "warn",
    currentValue,
    baselineValue,
    deltaValue,
    deltaPercent,
  }
}

function buildBaselineComparison(params: {
  baselineEntries: VoiceTelemetryBaselineEntry[] | undefined
  sessionId: string | null
  runId: string | null
  activeRunStartedAt: string | null
  sessionReadyMs: number | null
  joinLatencyMs: number | null
  requestStartToFirstTextMs: number | null
  bindToPlaybackStartMs: number | null
  subscriberRoundTripTimeMs: number | null
  subscriberJitterMs: number | null
  subscriberPacketLossPct: number | null
  nowMs: number
}): VoiceBaselineComparison {
  const {
    baselineEntries,
    sessionId,
    runId,
    activeRunStartedAt,
    sessionReadyMs,
    joinLatencyMs,
    requestStartToFirstTextMs,
    bindToPlaybackStartMs,
    subscriberRoundTripTimeMs,
    subscriberJitterMs,
    subscriberPacketLossPct,
    nowMs,
  } = params

  const runKey = buildBaselineRunKey({ sessionId, runId, activeRunStartedAt })
  const previousEntries = (baselineEntries ?? []).filter((entry) => entry.runKey !== runKey)
  if (previousEntries.length < 3) {
    return {
      ...DEFAULT_BASELINE_COMPARISON,
      runKey,
    }
  }

  const medians = {
    sessionReadyMs: median(compactNumbers(previousEntries.map((entry) => entry.metrics.sessionReadyMs))),
    joinLatencyMs: median(compactNumbers(previousEntries.map((entry) => entry.metrics.joinLatencyMs))),
    requestStartToFirstTextMs: median(compactNumbers(previousEntries.map((entry) => entry.metrics.requestStartToFirstTextMs))),
    bindToPlaybackStartMs: median(compactNumbers(previousEntries.map((entry) => entry.metrics.bindToPlaybackStartMs))),
    subscriberRoundTripTimeMs: median(compactNumbers(previousEntries.map((entry) => entry.metrics.subscriberRoundTripTimeMs))),
    subscriberJitterMs: median(compactNumbers(previousEntries.map((entry) => entry.metrics.subscriberJitterMs))),
    subscriberPacketLossPct: median(compactNumbers(previousEntries.map((entry) => entry.metrics.subscriberPacketLossPct))),
  }

  return {
    runKey,
    sampleSize: previousEntries.length,
    comparedAt: new Date(nowMs).toISOString(),
    medians,
    regressions: [
      createBaselineRegression({
        key: "session-ready",
        title: "Session ready is slower than recent runs",
        currentValue: sessionReadyMs,
        baselineValue: medians.sessionReadyMs,
        warnRatio: 1.35,
        badRatio: 1.75,
        warnDelta: 250,
        badDelta: 600,
        formatter: (value) => `${Math.round(value)}ms`,
      }),
      createBaselineRegression({
        key: "join-latency",
        title: "Call join is slower than recent runs",
        currentValue: joinLatencyMs,
        baselineValue: medians.joinLatencyMs,
        warnRatio: 1.3,
        badRatio: 1.65,
        warnDelta: 120,
        badDelta: 250,
        formatter: (value) => `${Math.round(value)}ms`,
      }),
      createBaselineRegression({
        key: "backend-first-text",
        title: "Backend first-text is slower than recent runs",
        currentValue: requestStartToFirstTextMs,
        baselineValue: medians.requestStartToFirstTextMs,
        warnRatio: 1.3,
        badRatio: 1.65,
        warnDelta: 150,
        badDelta: 300,
        formatter: (value) => `${Math.round(value)}ms`,
      }),
      createBaselineRegression({
        key: "playback-start",
        title: "Playback start is slower than recent runs",
        currentValue: bindToPlaybackStartMs,
        baselineValue: medians.bindToPlaybackStartMs,
        warnRatio: 1.4,
        badRatio: 1.8,
        warnDelta: 200,
        badDelta: 500,
        formatter: (value) => `${Math.round(value)}ms`,
      }),
      createBaselineRegression({
        key: "transport-rtt",
        title: "WebRTC RTT is above the recent baseline",
        currentValue: subscriberRoundTripTimeMs,
        baselineValue: medians.subscriberRoundTripTimeMs,
        warnRatio: 1.35,
        badRatio: 1.75,
        warnDelta: 35,
        badDelta: 80,
        fallbackWarnValue: 180,
        fallbackBadValue: 280,
        formatter: (value) => `${Math.round(value)}ms`,
      }),
      createBaselineRegression({
        key: "transport-jitter",
        title: "WebRTC jitter is above the recent baseline",
        currentValue: subscriberJitterMs,
        baselineValue: medians.subscriberJitterMs,
        warnRatio: 1.5,
        badRatio: 2.25,
        warnDelta: 8,
        badDelta: 18,
        fallbackWarnValue: 25,
        fallbackBadValue: 45,
        formatter: (value) => `${Math.round(value)}ms`,
      }),
      createBaselineRegression({
        key: "transport-loss",
        title: "WebRTC packet loss is above the recent baseline",
        currentValue: subscriberPacketLossPct,
        baselineValue: medians.subscriberPacketLossPct,
        warnRatio: 1.75,
        badRatio: 2.75,
        warnDelta: 1,
        badDelta: 2.5,
        fallbackWarnValue: 2.5,
        fallbackBadValue: 5,
        formatter: (value) => `${value.toFixed(1)}%`,
      }),
    ].filter((regression): regression is VoiceBaselineRegression => regression !== null)
      .sort((left, right) => {
        if (left.level !== right.level) {
          return left.level === "bad" ? -1 : 1
        }

        return right.deltaPercent - left.deltaPercent
      }),
  }
}

function playbackStateFromEventName(
  eventName: string | null | undefined,
): VoiceDeveloperMetrics["transport"]["playback"]["currentState"] {
  switch (eventName) {
    case "remote-participant-audio-bound":
    case "remote-audio-bound":
      return "bound"
    case "remote-audio-canplay":
      return "canplay"
    case "remote-audio-playing":
      return "playing"
    case "remote-audio-waiting":
      return "waiting"
    case "remote-audio-stalled":
      return "stalled"
    case "remote-audio-error":
    case "remote-audio-bind-failed":
      return "error"
    case "remote-audio-playback-timeout":
      return "timed_out"
    default:
      return "pending"
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

function levelFromLatencyValue(valueMs: number, warnAtMs: number, badAtMs: number): VoiceMetricsHealthLevel {
  if (valueMs >= badAtMs) {
    return "bad"
  }

  if (valueMs >= warnAtMs) {
    return "warn"
  }

  return "good"
}

function buildLatencyBreakdown(params: {
  startup: VoiceStartupMetrics
  pipeline: VoicePipelineMetrics
  playback: VoiceDeveloperMetrics["transport"]["playback"]
  reconnect: VoiceDeveloperMetrics["transport"]["reconnect"]
  sseOpenMs: number | null
}): VoiceLatencyBreakdown {
  const { startup, pipeline, playback, reconnect, sseOpenMs } = params

  return {
    startup: {
      preconnectFetchMs: startup.preconnectFetchMs,
      backendWarmupDurationMs: startup.backendWarmupDurationMs,
      requestToCredentialsMs: startup.requestToCredentialsMs,
      credentialsToJoinMs: startup.credentialsToJoinMs,
      joinToReadyMs: startup.joinToReadyMs,
      bindToPlaybackStartMs: startup.bindToPlaybackStartMs,
    },
    turn: {
      micToUserTranscriptMs: pipeline.micToUserTranscriptMs,
      transcriptToUserEndedMs: pipeline.transcriptToUserEndedMs,
      committedTurnCloseMs: pipeline.committedTurnCloseMs,
      userEndedToRequestStartMs: pipeline.userEndedToRequestStartMs,
      submissionStabilizationMs: pipeline.submissionStabilizationMs,
    },
    backend: {
      requestStartToFirstBackendEventMs: pipeline.requestStartToFirstBackendEventMs,
      firstBackendEventToFirstTextMs: pipeline.firstBackendEventToFirstTextMs,
      firstTextToBackendCompleteMs: pipeline.firstTextToBackendCompleteMs,
    },
    playback: {
      backendToFirstAudioMs: pipeline.backendToFirstAudioMs,
      textToFirstAudioMs: pipeline.textToFirstAudioMs,
      bindToPlayingMs: playback.bindToPlayingMs,
      lastTimeoutDurationMs: playback.lastTimeoutDurationMs,
    },
    transport: {
      sseOpenMs,
      reconnectLastDowntimeMs: reconnect.lastDowntimeMs,
      reconnectTotalDowntimeMs: reconnect.totalDowntimeMs,
      reconnectActiveDowntimeMs: reconnect.activeDowntimeMs,
    },
  }
}

function buildLatencyHotspots(params: {
  startup: VoiceStartupMetrics
  pipeline: VoicePipelineMetrics
  playback: VoiceDeveloperMetrics["transport"]["playback"]
  reconnect: VoiceDeveloperMetrics["transport"]["reconnect"]
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): VoiceLatencyHotspot[] {
  const { startup, pipeline, playback, reconnect, thresholds } = params
  const reconnectImpactMs = maxFiniteNumber([
    reconnect.activeDowntimeMs,
    reconnect.lastDowntimeMs,
    reconnect.totalDowntimeMs,
  ])

  const candidates: Array<{
    key: VoiceLatencyHotspot["key"]
    area: VoiceLatencyArea
    label: string
    valueMs: number | null
    warnAtMs: number
    badAtMs: number
  }> = [
    {
      key: "preconnect-fetch",
      area: "startup",
      label: "preconnect fetch",
      valueMs: startup.preconnectFetchMs,
      warnAtMs: 600,
      badAtMs: 1500,
    },
    {
      key: "backend-warmup",
      area: "startup",
      label: "backend warmup",
      valueMs: startup.backendWarmupDurationMs,
      warnAtMs: 800,
      badAtMs: 2000,
    },
    {
      key: "request-to-credentials",
      area: "startup",
      label: "request -> credentials",
      valueMs: startup.requestToCredentialsMs,
      warnAtMs: 1200,
      badAtMs: 2400,
    },
    {
      key: "credentials-to-join",
      area: "startup",
      label: "credentials -> join",
      valueMs: startup.credentialsToJoinMs,
      warnAtMs: 400,
      badAtMs: 1200,
    },
    {
      key: "join-to-ready",
      area: "startup",
      label: "join -> ready",
      valueMs: startup.joinToReadyMs,
      warnAtMs: 600,
      badAtMs: 1500,
    },
    {
      key: "bind-to-playback",
      area: "playback",
      label: "bind -> playback",
      valueMs: startup.bindToPlaybackStartMs ?? playback.bindToPlayingMs,
      warnAtMs: 1500,
      badAtMs: 3000,
    },
    {
      key: "mic-to-transcript",
      area: "turn",
      label: "mic -> transcript",
      valueMs: pipeline.micToUserTranscriptMs,
      warnAtMs: 1500,
      badAtMs: 4000,
    },
    {
      key: "committed-turn-close",
      area: "turn",
      label: "committed transcript -> agent start",
      valueMs: pipeline.committedTurnCloseMs,
      warnAtMs: thresholds.committedResponse.warnAtMs,
      badAtMs: thresholds.committedResponse.badAtMs,
    },
    {
      key: "user-ended-to-request",
      area: "turn",
      label: "user end -> request",
      valueMs: pipeline.userEndedToRequestStartMs,
      warnAtMs: 500,
      badAtMs: 1500,
    },
    {
      key: "request-to-first-backend-event",
      area: "backend",
      label: "request -> first backend event",
      valueMs: pipeline.requestStartToFirstBackendEventMs,
      warnAtMs: 500,
      badAtMs: 1500,
    },
    {
      key: "first-backend-event-to-first-text",
      area: "backend",
      label: "first backend event -> first text",
      valueMs: pipeline.firstBackendEventToFirstTextMs,
      warnAtMs: 700,
      badAtMs: 2000,
    },
    {
      key: "first-text-to-backend-complete",
      area: "backend",
      label: "first text -> backend done",
      valueMs: pipeline.firstTextToBackendCompleteMs,
      warnAtMs: 1200,
      badAtMs: 3000,
    },
    {
      key: "backend-to-first-audio",
      area: "playback",
      label: "backend done -> first audio",
      valueMs: pipeline.backendToFirstAudioMs,
      warnAtMs: 800,
      badAtMs: 2000,
    },
    {
      key: "text-to-first-audio",
      area: "playback",
      label: "first text -> first audio",
      valueMs: pipeline.textToFirstAudioMs,
      warnAtMs: 1500,
      badAtMs: 2500,
    },
    {
      key: "playback-timeout",
      area: "playback",
      label: "playback timeout",
      valueMs: playback.lastTimeoutDurationMs,
      warnAtMs: 1500,
      badAtMs: 2500,
    },
    {
      key: "reconnect-downtime",
      area: "transport",
      label: "reconnect downtime",
      valueMs: reconnectImpactMs,
      warnAtMs: 1500,
      badAtMs: 4000,
    },
  ]

  return candidates
    .flatMap((candidate) => {
      if (candidate.valueMs === null || candidate.valueMs <= 0) {
        return []
      }

      return [{
        key: candidate.key,
        area: candidate.area,
        label: candidate.label,
        valueMs: candidate.valueMs,
        level: levelFromLatencyValue(candidate.valueMs, candidate.warnAtMs, candidate.badAtMs),
      }]
    })
    .sort((left, right) => right.valueMs - left.valueMs)
    .slice(0, 3)
}

function formatLatencyHintValue(valueMs: number): string {
  if (valueMs >= 10_000) {
    return `${Math.round(valueMs / 1000)}s`
  }

  if (valueMs >= 1000) {
    return `${(valueMs / 1000).toFixed(1)}s`
  }

  return `${Math.round(valueMs)}ms`
}

function buildBottleneckHint(params: {
  bottleneck: VoiceBottleneckDiagnosis
  topHotspots: VoiceLatencyHotspot[]
}): string {
  const { bottleneck, topHotspots } = params
  const primaryHotspot = topHotspots[0]

  if (!primaryHotspot || bottleneck.kind === "transport") {
    return bottleneck.detail
  }

  return `${bottleneck.title}. Slowest measured segment: ${primaryHotspot.label} (${formatLatencyHintValue(primaryHotspot.valueMs)}).`
}

function selectWebRTCMetricValue(
  metrics: VoiceDeveloperMetrics["transport"]["webrtc"]["subscriber"],
  key: "roundTripTimeMs" | "jitterMs" | "packetLossPct",
): number | null {
  switch (key) {
    case "roundTripTimeMs":
      return metrics.averageRoundTripTimeMs ?? metrics.lastRoundTripTimeMs
    case "jitterMs":
      return metrics.averageJitterMs ?? metrics.lastJitterMs
    case "packetLossPct":
      return metrics.averagePacketLossPct ?? metrics.lastPacketLossPct
    default:
      return null
  }
}

function getWebRTCTransportLevel(
  webrtc: VoiceDeveloperMetrics["transport"]["webrtc"],
): VoiceMetricsHealthLevel {
  if (webrtc.sampleCount === 0) {
    return "neutral"
  }

  const roundTripTimeMs = selectWebRTCMetricValue(webrtc.subscriber, "roundTripTimeMs")
  const jitterMs = selectWebRTCMetricValue(webrtc.subscriber, "jitterMs")
  const packetLossPct = selectWebRTCMetricValue(webrtc.subscriber, "packetLossPct")

  if (
    (roundTripTimeMs !== null && roundTripTimeMs >= 280)
    || (jitterMs !== null && jitterMs >= 45)
    || (packetLossPct !== null && packetLossPct >= 5)
  ) {
    return "bad"
  }

  if (
    (roundTripTimeMs !== null && roundTripTimeMs >= 180)
    || (jitterMs !== null && jitterMs >= 25)
    || (packetLossPct !== null && packetLossPct >= 2.5)
  ) {
    return "warn"
  }

  return "good"
}

function buildWebRTCTransportEvidence(
  webrtc: VoiceDeveloperMetrics["transport"]["webrtc"],
): string[] {
  return compactStrings([
    webrtc.datacenter ? `datacenter: ${webrtc.datacenter}` : null,
    formatEvidenceMs("subscriber RTT", selectWebRTCMetricValue(webrtc.subscriber, "roundTripTimeMs")),
    formatEvidenceMs("subscriber jitter", selectWebRTCMetricValue(webrtc.subscriber, "jitterMs")),
    (() => {
      const packetLossPct = selectWebRTCMetricValue(webrtc.subscriber, "packetLossPct")
      return packetLossPct === null ? null : `subscriber loss: ${packetLossPct.toFixed(1)}%`
    })(),
  ])
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
  transportPlayback: VoiceDeveloperMetrics["transport"]["playback"]
  transportReconnect: VoiceDeveloperMetrics["transport"]["reconnect"]
  userTranscriptCount: number
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
    transportPlayback,
    transportReconnect,
    userTranscriptCount,
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

  const playbackIsDelayed = transportPlayback.bindToPlayingMs !== null && transportPlayback.bindToPlayingMs >= 1500
  if (transportPlayback.timeoutCount > 0 || transportPlayback.errorCount > 0 || playbackIsDelayed) {
    markers.push({
      key: "playback",
      title:
        transportPlayback.timeoutCount > 0 || transportPlayback.errorCount > 0
          ? "Remote audio did not start cleanly"
          : "Remote audio started late",
      detail:
        compactStrings([
          transportPlayback.timeoutCount > 0 ? `timeouts: ${transportPlayback.timeoutCount}` : null,
          transportPlayback.errorCount > 0 ? `errors: ${transportPlayback.errorCount}` : null,
          formatEvidenceMs("bind -> playing", transportPlayback.bindToPlayingMs),
          transportPlayback.lastError,
        ]).join(" | ") || "Remote audio playback lagged after the media element was bound.",
      level:
        transportPlayback.timeoutCount > 0
        || transportPlayback.errorCount > 0
        || (transportPlayback.bindToPlayingMs !== null && transportPlayback.bindToPlayingMs >= 3000)
          ? "bad"
          : "warn",
    })
  }

  const reconnectIsDegraded = transportReconnect.failed > 0
    || transportReconnect.activeDowntimeMs !== null
    || ((transportReconnect.totalDowntimeMs ?? 0) >= 3000 && transportReconnect.count > 0)
  if (reconnectIsDegraded) {
    markers.push({
      key: "reconnect",
      title: transportReconnect.activeDowntimeMs !== null ? "Reconnect still in progress" : "Reconnects disrupted the session",
      detail:
        compactStrings([
          `reconnects: ${transportReconnect.count}`,
          formatEvidenceMs("last downtime", transportReconnect.lastDowntimeMs),
          formatEvidenceMs("active downtime", transportReconnect.activeDowntimeMs),
          formatEvidenceMs("total downtime", transportReconnect.totalDowntimeMs),
        ]).join(" | ") || "Reconnect attempts added noticeable transport downtime.",
      level:
        transportReconnect.failed > 0 || ((transportReconnect.activeDowntimeMs ?? 0) >= 4000)
          ? "bad"
          : "warn",
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
    playbackBound: countWhere(events, (event) => event.name === "remote-participant-audio-bound"),
    playbackCanPlay: countWhere(events, (event) => event.name === "remote-audio-canplay"),
    playbackStarted: countWhere(events, (event) => event.name === "remote-audio-playing"),
    playbackWaiting: countWhere(events, (event) => event.name === "remote-audio-waiting"),
    playbackStalled: countWhere(events, (event) => event.name === "remote-audio-stalled"),
    playbackErrors: countWhere(events, (event) => event.name === "remote-audio-error" || event.name === "remote-audio-bind-failed"),
    playbackTimeouts: countWhere(events, (event) => event.name === "remote-audio-playback-timeout"),
    preconnectStarted: countWhere(events, (event) => event.name === "preconnect-started"),
    preconnectReady: countWhere(events, (event) => event.name === "preconnect-ready"),
    preconnectReused: countWhere(events, (event) => event.name === "preconnect-reused"),
    preconnectFailed: countWhere(events, (event) => event.name === "preconnect-failed"),
    warmupStarted: countWhere(events, (event) => event.name === "backend-warmup-started"),
    warmupCompleted: countWhere(events, (event) => event.name === "backend-warmup-completed"),
    warmupFailed: countWhere(events, (event) => event.name === "backend-warmup-failed"),
    reconnectStarted: countWhere(events, (event) => event.name === "reconnect-started"),
    reconnectRecovered: countWhere(events, (event) => event.name === "reconnect-recovered"),
    reconnectFailed: countWhere(events, (event) => event.name === "reconnect-failed"),
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
      extraFalseUserEndedCount: adjustedFalseUserEndedCount(
        asFiniteNumber(data?.raw_false_end_count),
      ),
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
  assistantTranscriptCount: number
  falseUserEndedCount: number | null
  duplicatePhaseCounts: Record<string, number>
  latestReason: string | null
  latestStatus: string | null
  transportSource: VoiceDeveloperMetrics["transport"]["activeSource"]
  transportPlayback: VoiceDeveloperMetrics["transport"]["playback"]
  transportReconnect: VoiceDeveloperMetrics["transport"]["reconnect"]
  transportWebRTC: VoiceDeveloperMetrics["transport"]["webrtc"]
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
    assistantTranscriptCount,
    falseUserEndedCount,
    duplicatePhaseCounts,
    latestReason,
    latestStatus,
    transportSource,
    transportPlayback,
    transportReconnect,
    transportWebRTC,
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
    (pipeline.textToFirstAudioMs !== null
      && pipeline.textToFirstAudioMs >= 1500
      && (committedResponse.valueMs === null || committedResponse.valueMs < thresholds.committedResponse.warnAtMs))
    || transportPlayback.timeoutCount > 0
    || transportPlayback.errorCount > 0
    || (transportPlayback.bindToPlayingMs !== null
      && transportPlayback.bindToPlayingMs >= 1500
      && (committedResponse.valueMs === null || committedResponse.valueMs < thresholds.committedResponse.warnAtMs))

  const reconnectIsDisruptive = transportReconnect.failed > 0
    || transportReconnect.activeDowntimeMs !== null
    || ((transportReconnect.totalDowntimeMs ?? 0) >= 3000 && transportReconnect.count > 0)
  const webrtcTransportLevel = getWebRTCTransportLevel(transportWebRTC)
  const webrtcTransportIsDegraded = webrtcTransportLevel === "warn" || webrtcTransportLevel === "bad"

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
      level:
        transportPlayback.timeoutCount > 0
        || transportPlayback.errorCount > 0
        || (transportPlayback.bindToPlayingMs !== null && transportPlayback.bindToPlayingMs >= 3000)
        || (pipeline.textToFirstAudioMs !== null && pipeline.textToFirstAudioMs >= 2500)
          ? "bad"
          : "warn",
      title: "Playback/TTS is the bottleneck",
      detail:
        transportPlayback.timeoutCount > 0 || transportPlayback.errorCount > 0
          ? "Sophia produced or streamed a response, but the browser media element never reached clean playback."
          : "Sophia produced text in time, but the gap from text generation to audible playback is the slowest part.",
      evidence: compactStrings([
        formatEvidenceMs("committed response", committedResponse.valueMs),
        formatEvidenceMs("bind -> playing", transportPlayback.bindToPlayingMs),
        formatEvidenceMs("text -> first audio", pipeline.textToFirstAudioMs),
        formatEvidenceMs("backend -> first audio", pipeline.backendToFirstAudioMs),
        transportPlayback.lastError,
      ]),
    }
  }

  if (reconnectIsDisruptive) {
    return {
      kind: "transport",
      level: transportReconnect.failed > 0 || ((transportReconnect.activeDowntimeMs ?? 0) >= 4000) ? "bad" : "warn",
      title: "Reconnect path is the bottleneck",
      detail:
        transportReconnect.activeDowntimeMs !== null
          ? `The Stream call has been reconnecting for ${Math.round(transportReconnect.activeDowntimeMs)}ms.`
          : "Recovered reconnects are adding noticeable transport downtime to the session.",
      evidence: compactStrings([
        `reconnects: ${transportReconnect.count}`,
        formatEvidenceMs("last downtime", transportReconnect.lastDowntimeMs),
        formatEvidenceMs("total downtime", transportReconnect.totalDowntimeMs),
      ]),
    }
  }

  if (webrtcTransportIsDegraded) {
    return {
      kind: "transport",
      level: webrtcTransportLevel,
      title: "WebRTC transport is unstable",
      detail: "The live audio path is showing elevated RTT, jitter, or packet loss even before reconnect logic trips.",
      evidence: buildWebRTCTransportEvidence(transportWebRTC),
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
  baselineEntries,
  nowMs,
  runtimeError,
  stage,
}: BuildVoiceDeveloperMetricsFromCaptureParams): VoiceDeveloperMetrics {
  return buildVoiceDeveloperMetrics({
    stage: stage ?? inferVoiceStageFromCapture({ events: capture.events, runtimeError }),
    events: capture.events,
    snapshot: capture.snapshot ?? null,
    baselineEntries,
    nowMs,
    runtimeError,
  })
}

export function buildVoiceTelemetrySummary(metrics: VoiceDeveloperMetrics): VoiceTelemetrySummary {
  const committedResponse = selectCommittedResponse({
    committedTurnCloseMs: metrics.pipeline.committedTurnCloseMs,
    userEndedToFirstTextMs: metrics.pipeline.userEndedToFirstTextMs,
    userEndedToAgentStartMs: metrics.pipeline.userEndedToAgentStartMs,
  })
  const bottleneckHint = buildBottleneckHint({
    bottleneck: metrics.bottleneck,
    topHotspots: metrics.topHotspots,
  })

  return {
    stage: metrics.stage,
    healthLevel: metrics.health.level,
    healthTitle: metrics.health.title,
    bottleneckKind: metrics.bottleneck.kind,
    bottleneckLevel: metrics.bottleneck.level,
    bottleneckHint,
    transportSource: metrics.transport.activeSource,
    regressionKeys: metrics.regressions.map((marker) => marker.key),
    baselineSampleSize: metrics.baseline.sampleSize,
    baselineRegressionKeys: metrics.baseline.regressions.map((regression) => regression.key),
    latencyBreakdownMs: metrics.latencyBreakdown,
    topHotspots: metrics.topHotspots,
    sessionReadyMs: metrics.timings.sessionReadyMs,
    joinLatencyMs: metrics.timings.joinLatencyMs,
    credentialsSource: metrics.startup.credentialsSource,
    preconnectFetchMs: metrics.startup.preconnectFetchMs,
    preparedCredentialAgeMs: metrics.startup.preparedCredentialAgeMs,
    joinToPlaybackStartMs: metrics.startup.joinToPlaybackStartMs,
    bindToPlaybackStartMs: metrics.startup.bindToPlaybackStartMs,
    backendWarmupStatus: metrics.startup.backendWarmupStatus,
    backendWarmupDurationMs: metrics.startup.backendWarmupDurationMs,
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
    networkOnline: metrics.transport.network.online,
    networkEffectiveType: metrics.transport.network.effectiveType,
    networkRttMs: metrics.transport.network.rttMs,
    networkDownlinkMbps: metrics.transport.network.downlinkMbps,
    webrtcDatacenter: metrics.transport.webrtc.datacenter,
    webrtcSampleCount: metrics.transport.webrtc.sampleCount,
    webrtcSubscriberRoundTripTimeMs: selectWebRTCMetricValue(metrics.transport.webrtc.subscriber, "roundTripTimeMs"),
    webrtcSubscriberJitterMs: selectWebRTCMetricValue(metrics.transport.webrtc.subscriber, "jitterMs"),
    webrtcSubscriberPacketLossPct: selectWebRTCMetricValue(metrics.transport.webrtc.subscriber, "packetLossPct"),
    playbackState: metrics.transport.playback.currentState,
    reconnectCount: metrics.transport.reconnect.count,
    reconnectTotalDowntimeMs: metrics.transport.reconnect.totalDowntimeMs,
    reconnectActiveDowntimeMs: metrics.transport.reconnect.activeDowntimeMs,
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
  transportPlayback: VoiceDeveloperMetrics["transport"]["playback"]
  transportReconnect: VoiceDeveloperMetrics["transport"]["reconnect"]
  transportWebRTC: VoiceDeveloperMetrics["transport"]["webrtc"]
  currentThinkingMs: number | null
  latestDiagnostic: Record<string, unknown> | null
  userTranscriptCount: number
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
    transportPlayback,
    transportReconnect,
    transportWebRTC,
    currentThinkingMs,
    latestDiagnostic,
    userTranscriptCount,
    assistantTranscriptCount,
    turnCount,
    pipeline,
    thresholds,
  } = params
  const webrtcTransportLevel = getWebRTCTransportLevel(transportWebRTC)

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

  if (microphone.detectedAudio && userTranscriptCount === 0 && stage !== "idle" && stage !== "connecting") {
    return {
      level: "warn",
      title: "Audio detected, transcript missing",
      detail: "Local microphone audio exists, but Sophia has not emitted a user transcript yet.",
    }
  }

  if (transportReconnect.activeDowntimeMs !== null) {
    return {
      level: transportReconnect.activeDowntimeMs >= 4000 ? "bad" : "warn",
      title: "Reconnect in progress",
      detail: `The Stream call has been reconnecting for ${Math.round(transportReconnect.activeDowntimeMs)}ms.`,
    }
  }

  if (transportReconnect.failed > 0 || ((transportReconnect.totalDowntimeMs ?? 0) >= 3000 && transportReconnect.count > 0)) {
    return {
      level: transportReconnect.failed > 0 ? "bad" : "warn",
      title: "Reconnects disrupted voice",
      detail:
        compactStrings([
          `reconnects: ${transportReconnect.count}`,
          formatEvidenceMs("last downtime", transportReconnect.lastDowntimeMs),
          formatEvidenceMs("total downtime", transportReconnect.totalDowntimeMs),
        ]).join(" | ") || "Recovered reconnects added transport downtime to the session.",
    }
  }

  if (transportPlayback.timeoutCount > 0 || transportPlayback.errorCount > 0) {
    return {
      level: "bad",
      title: "Remote audio did not start cleanly",
      detail:
        compactStrings([
          transportPlayback.timeoutCount > 0 ? `timeouts: ${transportPlayback.timeoutCount}` : null,
          transportPlayback.lastError,
        ]).join(" | ") || "The browser bound a remote audio element, but playback never started cleanly.",
    }
  }

  if (transportPlayback.bindToPlayingMs !== null && transportPlayback.bindToPlayingMs >= 1500) {
    return {
      level: transportPlayback.bindToPlayingMs >= 3000 ? "bad" : "warn",
      title: "Remote audio started late",
      detail: `Playback needed ${Math.round(transportPlayback.bindToPlayingMs)}ms after bind before audio actually started.`,
    }
  }

  if (webrtcTransportLevel === "bad" || webrtcTransportLevel === "warn") {
    return {
      level: webrtcTransportLevel,
      title: "WebRTC transport looks unstable",
      detail: buildWebRTCTransportEvidence(transportWebRTC).join(" | ") || "The live transport path shows elevated RTT, jitter, or packet loss.",
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
        case "start-talking-ignored":
          return {
            label: "Duplicate start ignored",
            detail: asString(event.payloadRecord?.reason) ?? "A connect request was already in flight",
            tone: "warn" as const,
          }
        case "preconnect-started":
          return {
            label: "Preconnect started",
            detail: "Preparing voice credentials ahead of the first turn",
            tone: "neutral" as const,
          }
        case "reconnect-started":
          return {
            label: "Reconnect started",
            detail: "The Stream call entered reconnecting state.",
            tone: "warn" as const,
          }
        case "reconnect-recovered": {
          const durationMs = asFiniteNumber(event.payloadRecord?.durationMs)

          return {
            label: "Reconnect recovered",
            detail: durationMs !== null
              ? `Recovered in ${Math.round(durationMs)}ms`
              : "The Stream call recovered from reconnecting state.",
            tone: "good" as const,
          }
        }
        case "reconnect-failed":
          return {
            label: "Reconnect failed",
            detail: asString(event.payloadRecord?.error)
              ?? asString(event.payloadRecord?.nextCallingState)
              ?? "Reconnect attempt ended without recovery.",
            tone: "bad" as const,
          }
        case "preconnect-ready": {
          const durationMs = asFiniteNumber(event.payloadRecord?.durationMs)

          return {
            label: "Preconnect ready",
            detail: durationMs !== null
              ? `Credentials prefetched in ${Math.round(durationMs)}ms`
              : asString(event.payloadRecord?.callId) ?? "Voice credentials prefetched",
            tone: "good" as const,
          }
        }
        case "preconnect-reused": {
          const preparedCredentialAgeMs = asFiniteNumber(event.payloadRecord?.preparedCredentialAgeMs)

          return {
            label: "Preconnect reused",
            detail: preparedCredentialAgeMs !== null
              ? `Prepared ${Math.round(preparedCredentialAgeMs)}ms before start`
              : "Prefetched credentials reused",
            tone: "good" as const,
          }
        }
        case "preconnect-failed":
          return {
            label: "Preconnect failed",
            detail: asString(event.payloadRecord?.error) ?? "Voice session prefetch failed",
            tone: "warn" as const,
          }
        case "credentials-received":
          {
            const source = asString(event.payloadRecord?.source)

            return {
              label: "Credentials ready",
              detail:
                source === "prefetched"
                  ? "Prefetched credentials reused"
                  : asString(event.payloadRecord?.callId) ?? "Gateway responded",
              tone: source === "prefetched" ? "good" as const : "neutral" as const,
            }
          }
        case "backend-warmup-started":
          return {
            label: "Backend warmup",
            detail: "Priming the gateway and voice pipeline",
            tone: "neutral" as const,
          }
        case "backend-warmup-completed": {
          const durationMs = asFiniteNumber(event.payloadRecord?.durationMs)

          return {
            label: "Warmup complete",
            detail: durationMs !== null
              ? `Warmup completed in ${Math.round(durationMs)}ms`
              : "Gateway warmup completed",
            tone: "good" as const,
          }
        }
        case "backend-warmup-failed":
          return {
            label: "Warmup failed",
            detail: asString(event.payloadRecord?.error) ?? "Gateway warmup failed",
            tone: "warn" as const,
          }
        case "remote-participant-audio-bound":
          return {
            label: "Remote audio bound",
            detail: asString(event.payloadRecord?.participantSessionId) ?? "Bound remote participant audio element",
            tone: "neutral" as const,
          }
        case "remote-audio-canplay": {
          const durationMs = asFiniteNumber(event.payloadRecord?.durationMs)

          return {
            label: "Audio can play",
            detail: durationMs !== null
              ? `Media element became playable in ${Math.round(durationMs)}ms`
              : "Remote audio buffer is ready for playback",
            tone: "neutral" as const,
          }
        }
        case "remote-audio-playing": {
          const durationMs = asFiniteNumber(event.payloadRecord?.durationMs)

          return {
            label: "Audio playing",
            detail: durationMs !== null
              ? `Playback started ${Math.round(durationMs)}ms after bind`
              : "Remote audio playback started",
            tone: "good" as const,
          }
        }
        case "remote-audio-waiting":
          return {
            label: "Audio waiting",
            detail: "Remote audio is buffering and waiting for more data.",
            tone: "warn" as const,
          }
        case "remote-audio-stalled":
          return {
            label: "Audio stalled",
            detail: "Remote audio playback stalled after bind.",
            tone: "warn" as const,
          }
        case "remote-audio-error":
        case "remote-audio-bind-failed":
          return {
            label: event.name === "remote-audio-bind-failed" ? "Audio bind failed" : "Audio error",
            detail: asString(event.payloadRecord?.error) ?? "Browser media playback reported an error.",
            tone: "bad" as const,
          }
        case "remote-audio-playback-timeout": {
          const durationMs = asFiniteNumber(event.payloadRecord?.durationMs)

          return {
            label: "Playback timeout",
            detail: durationMs !== null
              ? `No playback started within ${Math.round(durationMs)}ms after bind`
              : "No playback started after the remote audio element was bound.",
            tone: "bad" as const,
          }
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
        case "webrtc-stats-started":
          return {
            label: "WebRTC stats live",
            detail: asString(event.payloadRecord?.datacenter) ?? "Transport stats are now sampling",
            tone: "good" as const,
          }
        case "webrtc-stats-error":
          return {
            label: "WebRTC stats error",
            detail: asString(event.payloadRecord?.error) ?? "Transport stats subscription failed",
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
        case "stale-connect-response":
          return {
            label: "Stale connect dropped",
            detail: "A late credentials response was discarded",
            tone: "warn" as const,
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
    .slice(-18)

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
  baselineEntries,
  nowMs = Date.now(),
  runtimeError,
}: BuildVoiceDeveloperMetricsParams): VoiceDeveloperMetrics {
  const activeRunEvents = sliceVoiceCaptureEventsToActiveRun(events)
  const activeEvents = activeRunEvents.map(normalizeEvent)

  const latestEvent = activeEvents.at(-1) ?? null
  const lastStartEvent = findLast(activeEvents, (event) => event.name === "start-talking-requested")
  const preconnectStartedEvent = findLast(activeEvents, (event) => event.name === "preconnect-started")
  const preconnectReadyEvent = findLast(activeEvents, (event) => event.name === "preconnect-ready")
  const preconnectReusedEvent = findLast(activeEvents, (event) => event.name === "preconnect-reused")
  const preconnectFailedEvent = findLast(activeEvents, (event) => event.name === "preconnect-failed")
  const credentialsReceivedEvent = findLast(activeEvents, (event) => event.name === "credentials-received")
  const backendWarmupStartedEvent = findLast(activeEvents, (event) => event.name === "backend-warmup-started")
  const backendWarmupCompletedEvent = findLast(activeEvents, (event) => event.name === "backend-warmup-completed")
  const backendWarmupFailedEvent = findLast(activeEvents, (event) => event.name === "backend-warmup-failed")
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
  const remoteAudioInstallBoundEvent = findLast(activeEvents, (event) => event.name === "remote-audio-bound")
  const remoteParticipantAudioBoundEvent = findLast(activeEvents, (event) => event.name === "remote-participant-audio-bound")
  const remoteAudioCanPlayEvent = findLast(activeEvents, (event) => event.name === "remote-audio-canplay")
  const remoteAudioPlayingEvent = findLast(activeEvents, (event) => event.name === "remote-audio-playing")
  const remoteAudioWaitingEvent = findLast(activeEvents, (event) => event.name === "remote-audio-waiting")
  const remoteAudioStalledEvent = findLast(activeEvents, (event) => event.name === "remote-audio-stalled")
  const remoteAudioErrorEvent = findLast(activeEvents, (event) => event.name === "remote-audio-error" || event.name === "remote-audio-bind-failed")
  const remoteAudioPlaybackTimeoutEvent = findLast(activeEvents, (event) => event.name === "remote-audio-playback-timeout")
  const reconnectStartedEvents = activeEvents.filter((event) => event.name === "reconnect-started")
  const reconnectRecoveredEvents = activeEvents.filter((event) => event.name === "reconnect-recovered")
  const reconnectFailedEvents = activeEvents.filter((event) => event.name === "reconnect-failed")
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
  const artifactCount = countWhere(activeEvents, (event) => event.name === "sophia.artifact")
  const diagnosticCount = countWhere(activeEvents, (event) => event.name === "sophia.turn_diagnostic")
  const builderEvents = countWhere(activeEvents, (event) => event.category === "builder" || event.name === "sophia.builder_task")
  const turnCount = Math.max(
    diagnosticCount,
    countWhere(activeEvents, (event) => event.name === "sophia.turn" && eventPhase(event) === "agent_started"),
    userTranscriptCount,
  )

  const microphone = buildMicrophone(snapshot?.harness?.microphone)
  const network = buildNetwork(snapshot)
  const webrtc = buildWebRTC(snapshot)
  const builder = buildBuilderMetrics(activeEvents, nowMs)
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
  const activeRunStartedAt = activeRunEvents[0]?.recordedAt ?? null
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
  const latestPlaybackEvent = findLatestTimedEvent([
    remoteAudioErrorEvent,
    remoteAudioPlaybackTimeoutEvent,
    remoteAudioStalledEvent,
    remoteAudioWaitingEvent,
    remoteAudioPlayingEvent,
    remoteAudioCanPlayEvent,
    remoteParticipantAudioBoundEvent,
    remoteAudioInstallBoundEvent,
  ])
  const latestReconnectOutcomeEvent = findLatestTimedEvent([
    reconnectRecoveredEvents.at(-1) ?? null,
    reconnectFailedEvents.at(-1) ?? null,
  ])
  const latestWarmupEvent = findLatestTimedEvent([
    backendWarmupStartedEvent,
    backendWarmupCompletedEvent,
    backendWarmupFailedEvent,
  ])
  const credentialsSourceValue = asString(credentialsReceivedEvent?.payloadRecord?.source)
  const credentialsSource: VoiceCredentialsSource =
    credentialsSourceValue === "prefetched" || credentialsSourceValue === "fresh"
      ? credentialsSourceValue
      : preconnectReusedEvent
        ? "prefetched"
        : credentialsReceivedEvent
          ? "fresh"
          : "pending"
  const backendWarmupStatus: VoiceWarmupStatus =
    latestWarmupEvent?.name === "backend-warmup-completed"
      ? "completed"
      : latestWarmupEvent?.name === "backend-warmup-failed"
        ? "failed"
        : latestWarmupEvent?.name === "backend-warmup-started"
          ? "pending"
          : "idle"
  const reconnectActiveDowntimeMs =
    reconnectStartedEvents.length > 0
    && (
      latestReconnectOutcomeEvent === null
      || (reconnectStartedEvents.at(-1)?.atMs ?? -Infinity) > (latestReconnectOutcomeEvent.atMs ?? -Infinity)
    )
      ? diffMs(reconnectStartedEvents.at(-1)?.atMs ?? null, nowMs)
      : null
  const reconnectTotalDowntimeMs = sumFiniteNumbers([
    ...reconnectRecoveredEvents.map((event) => asFiniteNumber(event.payloadRecord?.durationMs)),
    ...reconnectFailedEvents.map((event) => asFiniteNumber(event.payloadRecord?.durationMs)),
  ])
  const reconnectLastDowntimeMs =
    reconnectActiveDowntimeMs
    ?? asFiniteNumber(latestReconnectOutcomeEvent?.payloadRecord?.durationMs)
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
    credentialsSource,
    preconnectFetchMs:
      asFiniteNumber(preconnectReadyEvent?.payloadRecord?.durationMs)
      ?? diffMs(preconnectStartedEvent?.atMs ?? null, preconnectReadyEvent?.atMs ?? null),
    preparedCredentialAgeMs:
      asFiniteNumber(preconnectReusedEvent?.payloadRecord?.preparedCredentialAgeMs)
      ?? diffMs(preconnectReadyEvent?.atMs ?? null, preconnectReusedEvent?.atMs ?? null),
    preconnectError: asString(preconnectFailedEvent?.payloadRecord?.error),
    requestToCredentialsMs: diffMs(lastStartEvent?.atMs ?? null, credentialsReceivedEvent?.atMs ?? null),
    credentialsToJoinMs: diffMs(credentialsReceivedEvent?.atMs ?? null, joinRequestedEvent?.atMs ?? null),
    joinToReadyMs: diffMs(joinedEvent?.atMs ?? null, readyEvent?.atMs ?? null),
    joinToRemoteAudioMs: diffMs(joinedEvent?.atMs ?? null, (remoteParticipantAudioBoundEvent ?? remoteAudioInstallBoundEvent)?.atMs ?? null),
    joinToPlaybackStartMs: diffMs(joinedEvent?.atMs ?? null, remoteAudioPlayingEvent?.atMs ?? null),
    bindToPlaybackStartMs:
      asFiniteNumber(remoteAudioPlayingEvent?.payloadRecord?.durationMs)
      ?? diffMs((remoteParticipantAudioBoundEvent ?? remoteAudioInstallBoundEvent)?.atMs ?? null, remoteAudioPlayingEvent?.atMs ?? null),
    startToMicAudioMs: diffMs(lastStartEvent?.atMs ?? null, firstMicAudioEvent?.atMs ?? null),
    startToFirstUserTranscriptMs: diffMs(lastStartEvent?.atMs ?? null, firstUserTranscriptEvent?.atMs ?? null),
    backendWarmupStatus,
    backendWarmupDurationMs:
      asFiniteNumber(backendWarmupCompletedEvent?.payloadRecord?.durationMs)
      ?? asFiniteNumber(backendWarmupFailedEvent?.payloadRecord?.durationMs)
      ?? diffMs(
        backendWarmupStartedEvent?.atMs ?? null,
        backendWarmupCompletedEvent?.atMs ?? backendWarmupFailedEvent?.atMs ?? null,
      ),
    backendWarmupError: asString(backendWarmupFailedEvent?.payloadRecord?.error),
  }
  const pipeline: VoicePipelineMetrics = {
    micToUserTranscriptMs: computeMicToUserTranscriptMs({
      firstMicAudioAtMs: firstMicAudioEvent?.atMs ?? null,
      firstUserTranscriptAtMs: firstUserTranscriptEvent?.atMs ?? null,
      lastUserTranscriptAtMs: lastUserTranscriptEvent?.atMs ?? null,
      lastAgentEndedAtMs: lastAgentEndedEvent?.atMs ?? null,
    }),
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
  const eventsSummary = buildEventCounters(activeEvents)
  const playback: VoiceDeveloperMetrics["transport"]["playback"] = {
    ...DEFAULT_PLAYBACK,
    currentState: playbackStateFromEventName(latestPlaybackEvent?.name),
    participantSessionId: asString(latestPlaybackEvent?.payloadRecord?.participantSessionId),
    canPlayAt: remoteAudioCanPlayEvent?.recordedAt ?? null,
    playingAt: remoteAudioPlayingEvent?.recordedAt ?? null,
    bindToCanPlayMs:
      asFiniteNumber(remoteAudioCanPlayEvent?.payloadRecord?.durationMs)
      ?? diffMs((remoteParticipantAudioBoundEvent ?? remoteAudioInstallBoundEvent)?.atMs ?? null, remoteAudioCanPlayEvent?.atMs ?? null),
    bindToPlayingMs:
      asFiniteNumber(remoteAudioPlayingEvent?.payloadRecord?.durationMs)
      ?? diffMs((remoteParticipantAudioBoundEvent ?? remoteAudioInstallBoundEvent)?.atMs ?? null, remoteAudioPlayingEvent?.atMs ?? null),
    lastTimeoutDurationMs: asFiniteNumber(remoteAudioPlaybackTimeoutEvent?.payloadRecord?.durationMs),
    timeoutCount: eventsSummary.playbackTimeouts,
    waitingCount: eventsSummary.playbackWaiting,
    stalledCount: eventsSummary.playbackStalled,
    errorCount: eventsSummary.playbackErrors,
    lastError: asString(remoteAudioErrorEvent?.payloadRecord?.error),
  }
  const reconnect: VoiceDeveloperMetrics["transport"]["reconnect"] = {
    ...DEFAULT_RECONNECT,
    count: eventsSummary.reconnectStarted,
    recovered: eventsSummary.reconnectRecovered,
    failed: eventsSummary.reconnectFailed,
    lastDowntimeMs: reconnectLastDowntimeMs,
    totalDowntimeMs: reconnectTotalDowntimeMs,
    activeDowntimeMs: reconnectActiveDowntimeMs,
  }
  const sseOpenMs = diffMs(credentialsReceivedEvent?.atMs ?? null, sseOpenEvent?.atMs ?? null)
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
  const baseline = buildBaselineComparison({
    baselineEntries,
    sessionId,
    runId,
    activeRunStartedAt,
    sessionReadyMs: thresholds.sessionReady.valueMs,
    joinLatencyMs: thresholds.joinLatency.valueMs,
    requestStartToFirstTextMs: pipeline.requestStartToFirstTextMs,
    bindToPlaybackStartMs: startup.bindToPlaybackStartMs,
    subscriberRoundTripTimeMs: selectWebRTCMetricValue(webrtc.subscriber, "roundTripTimeMs"),
    subscriberJitterMs: selectWebRTCMetricValue(webrtc.subscriber, "jitterMs"),
    subscriberPacketLossPct: selectWebRTCMetricValue(webrtc.subscriber, "packetLossPct"),
    nowMs,
  })
  const latencyBreakdown = buildLatencyBreakdown({
    startup,
    pipeline,
    playback,
    reconnect,
    sseOpenMs,
  })
  const topHotspots = buildLatencyHotspots({
    startup,
    pipeline,
    playback,
    reconnect,
    thresholds,
  })
  const regressions = buildRegressionMarkers({
    stage,
    microphone,
    builder,
    transportPlayback: playback,
    transportReconnect: reconnect,
    userTranscriptCount,
    falseUserEndedCount,
    duplicatePhaseCounts,
    latestReason: asString(lastDiagnostic?.reason),
    currentThinkingMs,
    pipeline,
    thresholds,
  })
  const recentTurns = buildRecentTurns(activeEvents)
  const bottleneck = buildBottleneckDiagnosis({
    stage,
    turnCount,
    microphone,
    userTranscriptCount,
    assistantTranscriptCount,
    falseUserEndedCount,
    duplicatePhaseCounts,
    latestReason: asString(lastDiagnostic?.reason),
    latestStatus: asString(lastDiagnostic?.status),
    transportSource,
    transportPlayback: playback,
    transportReconnect: reconnect,
    transportWebRTC: webrtc,
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
    transportPlayback: playback,
    transportReconnect: reconnect,
    transportWebRTC: webrtc,
    currentThinkingMs,
    latestDiagnostic: lastDiagnostic,
    userTranscriptCount,
    assistantTranscriptCount,
    turnCount,
    pipeline,
    thresholds,
  })

  return {
    stage,
    sessionIds: {
      sessionId,
      threadId,
      callId,
      voiceAgentSessionId,
      runId,
      activeRunStartedAt,
    },
    transport: {
      activeSource: transportSource,
      remoteParticipantCount,
      streamOpen: Boolean(sseOpenEvent),
      lastEventAt: latestEvent?.recordedAt ?? null,
      network,
      playback,
      reconnect,
      webrtc,
    },
    counts: {
      turns: turnCount,
      userTranscripts: userTranscriptCount,
      assistantTranscripts: assistantTranscriptCount,
      artifacts: artifactCount,
      diagnostics: diagnosticCount,
      builderEvents,
    },
    timings: {
      joinLatencyMs: thresholds.joinLatency.valueMs,
      sessionReadyMs: thresholds.sessionReady.valueMs,
      sseOpenMs,
      currentThinkingMs,
      lastEventAgeMs,
    },
    lastTurn: {
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
      extraFalseUserEndedCount: adjustedFalseUserEndedCount(falseUserEndedCount),
      duplicatePhaseCounts,
      lastUserTranscript,
      lastAssistantTranscript,
      lastUserTranscriptAt: lastUserTranscriptEvent?.recordedAt ?? null,
      lastAssistantTranscriptAt: lastAssistantTranscriptEvent?.recordedAt ?? null,
    },
    microphone,
    builder,
    health,
    thresholds,
    startup,
    pipeline,
    events: eventsSummary,
    recentTurns,
    bottleneck,
    latencyBreakdown,
    topHotspots,
    baseline,
    regressions,
    timeline: buildTimeline(
      activeEvents,
      activeEvents[0]?.atMs ?? lastStartEvent?.atMs ?? null,
      builder,
      nowMs,
    ),
  }
}