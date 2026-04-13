import type {
  SophiaCaptureMicrophoneSummary,
  SophiaCaptureSnapshot,
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
  key: "microphone" | "turn-segmentation" | "backend-stall"
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
  userEndedToRequestStartMs: number | null
  requestStartToFirstBackendEventMs: number | null
  firstBackendEventToFirstTextMs: number | null
  requestStartToFirstTextMs: number | null
  userEndedToAgentStartMs: number | null
  userEndedToFirstTextMs: number | null
  firstTextToBackendCompleteMs: number | null
  backendToFirstAudioMs: number | null
  textToFirstAudioMs: number | null
}

export type VoiceEventCounters = {
  total: number
  voiceSse: number
  streamCustom: number
  voiceRuntime: number
  voiceSession: number
  harnessInput: number
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
  firstTextMs: number | null
  backendCompleteMs: number | null
  firstAudioMs: number | null
  falseUserEndedCount: number | null
  duplicatePhaseTotal: number
}

export type VoiceBottleneckDiagnosis = {
  kind:
    | "idle"
    | "healthy"
    | "startup"
    | "microphone"
    | "turn-segmentation"
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
  stage: VoiceStage
  healthLevel: VoiceMetricsHealthLevel
  healthTitle: string
  bottleneckKind: VoiceBottleneckKind
  bottleneckLevel: VoiceMetricsHealthLevel
  transportSource: VoiceDeveloperMetrics["transport"]["activeSource"]
  regressionKeys: VoiceRegressionMarker["key"][]
  sessionReadyMs: number | null
  joinLatencyMs: number | null
  firstTextMs: number | null
  backendCompleteMs: number | null
  firstAudioMs: number | null
  responseWindowMs: number | null
}

export type VoiceDeveloperMetrics = {
  stage: VoiceStage
  sessionIds: {
    sessionId: string | null
    threadId: string | null
    callId: string | null
    voiceAgentSessionId: string | null
    runId: string | null
  }
  transport: {
    activeSource: "sse" | "custom" | "pending"
    remoteParticipantCount: number | null
    streamOpen: boolean
    lastEventAt: string | null
  }
  counts: {
    turns: number
    userTranscripts: number
    assistantTranscripts: number
    artifacts: number
    diagnostics: number
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
  health: {
    level: VoiceMetricsHealthLevel
    title: string
    detail: string
  }
  thresholds: {
    sessionReady: VoiceMetricThreshold
    joinLatency: VoiceMetricThreshold
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
}

type BuildVoiceDeveloperMetricsFromCaptureParams = {
  capture: {
    events: VoiceCaptureEvent[]
    snapshot?: SophiaCaptureSnapshot | null
  }
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
    firstText: createThreshold("First text", params.firstTextMs, 2500, 5000),
    firstAudio: createThreshold("First audio", params.firstAudioMs, 3000, 6000),
    backendComplete: createThreshold("Backend done", params.backendCompleteMs, 2800, 5500),
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
  userTranscriptCount: number
  falseUserEndedCount: number | null
  duplicatePhaseCounts: Record<string, number>
  latestReason: string | null
  currentThinkingMs: number | null
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): VoiceRegressionMarker[] {
  const {
    stage,
    microphone,
    userTranscriptCount,
    falseUserEndedCount,
    latestReason,
    currentThinkingMs,
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

  const visibleBackendThresholds = [thresholds.firstText, thresholds.firstAudio].filter(
    (threshold) => threshold.status === "warn" || threshold.status === "bad",
  )
  const backendCompletionSlow = thresholds.backendComplete.status === "warn" || thresholds.backendComplete.status === "bad"
  const backendLagDetected =
    latestReason === "backend_stall"
    || (currentThinkingMs !== null && currentThinkingMs >= thresholds.responseWindow.warnAtMs)
    || visibleBackendThresholds.length > 0
    || backendCompletionSlow

  if (backendLagDetected) {
    const level: VoiceRegressionMarker["level"] =
      latestReason === "backend_stall"
      || thresholds.responseWindow.status === "bad"
      || visibleBackendThresholds.some((threshold) => threshold.status === "bad")
      || (thresholds.firstAudio.valueMs === null && thresholds.backendComplete.status === "bad")
        ? "bad"
        : "warn"

    markers.push({
      key: "backend-stall",
      title: latestReason === "backend_stall" ? "Backend stall detected" : "Slow backend response",
      detail: getBackendLagDetail({ currentThinkingMs, thresholds }),
      level,
    })
  }

  return markers
}

function buildEventCounters(events: NormalizedVoiceCaptureEvent[]): VoiceEventCounters {
  return {
    total: events.length,
    voiceSse: countWhere(events, (event) => event.category === "voice-sse"),
    streamCustom: countWhere(events, (event) => event.category === "stream-custom"),
    voiceRuntime: countWhere(events, (event) => event.category === "voice-runtime"),
    voiceSession: countWhere(events, (event) => event.category === "voice-session"),
    harnessInput: countWhere(events, (event) => event.category === "harness-input"),
    duplicateUserTranscriptIgnored: countWhere(events, (event) => event.name === "duplicate-user-transcript-ignored"),
    sseErrors: countWhere(events, (event) => event.category === "voice-sse" && event.name === "stream-error"),
    invalidPayloads: countWhere(events, (event) => event.category === "voice-sse" && event.name === "invalid-event-payload"),
    staleConnectResponses: countWhere(events, (event) => event.name === "stale-connect-response"),
    startIgnored: countWhere(events, (event) => event.name === "start-talking-ignored"),
    startupTimeouts: countWhere(events, (event) => event.name === "startup-ready-timeout"),
  }
}

function buildRecentTurns(events: NormalizedVoiceCaptureEvent[]): VoiceRecentTurnSummary[] {
  return events
    .filter((event) => event.name === "sophia.turn_diagnostic")
    .slice(-4)
    .reverse()
    .map((event) => {
      const data = eventData(event)
      const duplicatePhaseCounts = normalizeDuplicatePhaseCounts(data?.duplicate_phase_counts)
      const duplicatePhaseTotal = Object.values(duplicatePhaseCounts).reduce<number>((total, value) => total + value, 0)

      return {
        turnId: asString(data?.turn_id),
        status: asString(data?.status),
        reason: asString(data?.reason),
        firstTextMs: asFiniteNumber(data?.first_text_ms),
        backendCompleteMs: asFiniteNumber(data?.backend_complete_ms),
        firstAudioMs: asFiniteNumber(data?.first_audio_ms),
        falseUserEndedCount: asFiniteNumber(data?.raw_false_end_count),
        duplicatePhaseTotal,
      }
    })
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

  const ttsIsSlow =
    pipeline.textToFirstAudioMs !== null
    && pipeline.textToFirstAudioMs >= 1500
    && (pipeline.userEndedToFirstTextMs === null || pipeline.userEndedToFirstTextMs < thresholds.firstText.warnAtMs)

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

  if (ttsIsSlow) {
    return {
      kind: "tts",
      level: pipeline.textToFirstAudioMs !== null && pipeline.textToFirstAudioMs >= 2500 ? "bad" : "warn",
      title: "Playback/TTS is the bottleneck",
      detail: "Sophia produced text in time, but the gap from text generation to audible playback is the slowest part.",
      evidence: compactStrings([
        formatEvidenceMs("user end -> first text", pipeline.userEndedToFirstTextMs),
        formatEvidenceMs("text -> first audio", pipeline.textToFirstAudioMs),
        formatEvidenceMs("backend -> first audio", pipeline.backendToFirstAudioMs),
      ]),
    }
  }

  if (
    latestReason === "backend_stall"
    || latestStatus === "failed"
    || thresholds.firstText.status === "warn"
    || thresholds.firstText.status === "bad"
    || thresholds.firstAudio.status === "warn"
    || thresholds.firstAudio.status === "bad"
    || thresholds.responseWindow.status === "warn"
    || thresholds.responseWindow.status === "bad"
    || (thresholds.firstAudio.valueMs === null
      && (thresholds.backendComplete.status === "warn" || thresholds.backendComplete.status === "bad"))
  ) {
    return {
      kind: "backend",
      level:
        latestReason === "backend_stall"
        || thresholds.firstText.status === "bad"
        || thresholds.firstAudio.status === "bad"
        || thresholds.responseWindow.status === "bad"
        || (thresholds.firstAudio.valueMs === null && thresholds.backendComplete.status === "bad")
          ? "bad"
          : "warn",
      title: "Backend response is the bottleneck",
      detail: "The slowest segment is between the committed user turn and the backend producing enough response progress.",
      evidence: compactStrings([
        formatEvidenceMs("user end -> agent start", pipeline.userEndedToAgentStartMs),
        formatEvidenceMs("user end -> first text", pipeline.userEndedToFirstTextMs),
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
      formatEvidenceMs("first text", thresholds.firstText.valueMs),
      formatEvidenceMs("first audio", thresholds.firstAudio.valueMs),
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
}: BuildVoiceDeveloperMetricsFromCaptureParams): VoiceDeveloperMetrics {
  return buildVoiceDeveloperMetrics({
    stage: stage ?? inferVoiceStageFromCapture({ events: capture.events, runtimeError }),
    events: capture.events,
    snapshot: capture.snapshot ?? null,
    nowMs,
    runtimeError,
  })
}

export function buildVoiceTelemetrySummary(metrics: VoiceDeveloperMetrics): VoiceTelemetrySummary {
  return {
    stage: metrics.stage,
    healthLevel: metrics.health.level,
    healthTitle: metrics.health.title,
    bottleneckKind: metrics.bottleneck.kind,
    bottleneckLevel: metrics.bottleneck.level,
    transportSource: metrics.transport.activeSource,
    regressionKeys: metrics.regressions.map((marker) => marker.key),
    sessionReadyMs: metrics.timings.sessionReadyMs,
    joinLatencyMs: metrics.timings.joinLatencyMs,
    firstTextMs: metrics.lastTurn.firstTextMs,
    backendCompleteMs: metrics.lastTurn.backendCompleteMs,
    firstAudioMs: metrics.lastTurn.firstAudioMs,
    responseWindowMs:
      metrics.stage === "thinking"
        ? metrics.timings.currentThinkingMs
        : metrics.lastTurn.responseDurationMs,
  }
}

function summarizeHealth(params: {
  stage: VoiceStage
  microphone: VoiceDeveloperMetrics["microphone"]
  runtimeError?: string
  transportSource: VoiceDeveloperMetrics["transport"]["activeSource"]
  currentThinkingMs: number | null
  latestDiagnostic: Record<string, unknown> | null
  userTranscriptCount: number
  assistantTranscriptCount: number
  turnCount: number
  thresholds: VoiceDeveloperMetrics["thresholds"]
}): VoiceDeveloperMetrics["health"] {
  const {
    stage,
    microphone,
    runtimeError,
    transportSource,
    currentThinkingMs,
    latestDiagnostic,
    userTranscriptCount,
    assistantTranscriptCount,
    turnCount,
    thresholds,
  } = params

  if (stage === "error") {
    return {
      level: "bad",
      title: "Voice runtime failed",
      detail: runtimeError ?? "The client entered an error state before the turn could finish.",
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

  if (
    latestReason === "backend_stall"
    || thresholds.firstText.status === "warn"
    || thresholds.firstText.status === "bad"
    || thresholds.firstAudio.status === "warn"
    || thresholds.firstAudio.status === "bad"
    || (thresholds.firstAudio.valueMs === null
      && (thresholds.backendComplete.status === "warn" || thresholds.backendComplete.status === "bad"))
  ) {
    return {
      level:
        latestReason === "backend_stall"
        || thresholds.firstText.status === "bad"
        || thresholds.firstAudio.status === "bad"
        || (thresholds.firstAudio.valueMs === null && thresholds.backendComplete.status === "bad")
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

function buildTimeline(events: NormalizedVoiceCaptureEvent[], startAtMs: number | null): VoiceMetricsTimelineItem[] {
  const items = events
    .map((event) => {
      const data = eventData(event)
      const textPreview = asString(data?.text)
      const phase = eventPhase(event)

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

  const userTranscriptCount = countWhere(activeEvents, (event) => event.name === "sophia.user_transcript")
  const assistantTranscriptCount = countWhere(
    activeEvents,
    (event) => event.name === "sophia.transcript" && (eventData(event)?.is_final === true || eventData(event)?.final === true),
  )
  const artifactCount = countWhere(activeEvents, (event) => event.name === "sophia.artifact")
  const diagnosticCount = countWhere(activeEvents, (event) => event.name === "sophia.turn_diagnostic")
  const turnCount = Math.max(
    diagnosticCount,
    countWhere(activeEvents, (event) => event.name === "sophia.turn" && eventPhase(event) === "agent_started"),
    userTranscriptCount,
  )

  const microphone = buildMicrophone(snapshot?.harness?.microphone)
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
  const responseDurationMs = diffMs(lastAgentStartedEvent?.atMs ?? null, lastAgentEndedEvent?.atMs ?? null)
  const falseUserEndedCount = asFiniteNumber(lastDiagnostic?.raw_false_end_count)
  const duplicatePhaseCounts = normalizeDuplicatePhaseCounts(lastDiagnostic?.duplicate_phase_counts)
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
    userEndedToRequestStartMs: backendRequestStartMs,
    requestStartToFirstBackendEventMs: diffMs(backendRequestStartMs, backendFirstEventMs),
    firstBackendEventToFirstTextMs: diffMs(backendFirstEventMs, firstTextMs),
    requestStartToFirstTextMs: diffMs(backendRequestStartMs, firstTextMs),
    userEndedToAgentStartMs: diffMs(lastUserEndedEvent?.atMs ?? null, lastAgentStartedEvent?.atMs ?? null),
    userEndedToFirstTextMs: firstTextMs,
    firstTextToBackendCompleteMs: diffMs(firstTextMs, backendCompleteMs),
    backendToFirstAudioMs: diffMs(backendCompleteMs, firstAudioMs),
    textToFirstAudioMs: diffMs(firstTextMs, firstAudioMs),
  }
  const thresholds = buildThresholds({
    stage,
    sessionReadyMs: diffMs(lastStartEvent?.atMs ?? null, readyEvent?.atMs ?? null),
    joinLatencyMs: diffMs(joinRequestedEvent?.atMs ?? credentialsReceivedEvent?.atMs ?? null, joinedEvent?.atMs ?? null),
    firstTextMs,
    firstAudioMs,
    backendCompleteMs,
    currentThinkingMs,
    responseDurationMs,
  })
  const regressions = buildRegressionMarkers({
    stage,
    microphone,
    userTranscriptCount,
    falseUserEndedCount,
    duplicatePhaseCounts,
    latestReason: asString(lastDiagnostic?.reason),
    currentThinkingMs,
    thresholds,
  })
  const eventsSummary = buildEventCounters(activeEvents)
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
    events: eventsSummary,
    startup,
    pipeline,
    thresholds,
  })

  const health = summarizeHealth({
    stage,
    microphone,
    runtimeError,
    transportSource,
    currentThinkingMs,
    latestDiagnostic: lastDiagnostic,
    userTranscriptCount,
    assistantTranscriptCount,
    turnCount,
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
    },
    transport: {
      activeSource: transportSource,
      remoteParticipantCount,
      streamOpen: Boolean(sseOpenEvent),
      lastEventAt: latestEvent?.recordedAt ?? null,
    },
    counts: {
      turns: turnCount,
      userTranscripts: userTranscriptCount,
      assistantTranscripts: assistantTranscriptCount,
      artifacts: artifactCount,
      diagnostics: diagnosticCount,
    },
    timings: {
      joinLatencyMs: thresholds.joinLatency.valueMs,
      sessionReadyMs: thresholds.sessionReady.valueMs,
      sseOpenMs: diffMs(credentialsReceivedEvent?.atMs ?? null, sseOpenEvent?.atMs ?? null),
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
      duplicatePhaseCounts,
      lastUserTranscript,
      lastAssistantTranscript,
      lastUserTranscriptAt: lastUserTranscriptEvent?.recordedAt ?? null,
      lastAssistantTranscriptAt: lastAssistantTranscriptEvent?.recordedAt ?? null,
    },
    microphone,
    health,
    thresholds,
    startup,
    pipeline,
    events: eventsSummary,
    recentTurns,
    bottleneck,
    regressions,
    timeline: buildTimeline(activeEvents, lastStartEvent?.atMs ?? activeEvents[0]?.atMs ?? null),
  }
}