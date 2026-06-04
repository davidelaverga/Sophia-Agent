"use client"

/**
 * useStreamVoiceSession — Replaces useVoiceLoop for Stream WebRTC transport.
 *
 * Maps Stream SDK call state + browser-facing Sophia events to the VoiceStage interface
  userMicMutedRef.current = false
 * that all UI components depend on. Handles:
 * - Token fetching from backend (Unit 1 endpoint)
 * - Call lifecycle via useStreamVoice (Unit 2)
 * - VoiceStage transitions from CallingState + participant events
 * - Transcript and artifact forwarding via SSE, with Stream custom events as fallback
 */

import { CallingState } from "@stream-io/video-react-sdk"
import { useCallback, useEffect, useRef, useState } from "react"

import { coreviewFlagDiagnostics } from "../lib/co-review-flags"
import { logger } from "../lib/error-logger"
import {
  connectGeminiBrowserLiveFromBootstrap,
  readGeminiConfiguredToolNames,
  type GeminiBrowserLiveDogfoodConnection,
  type GeminiBargeInTranscriptHandoffDiagnostic,
  type GeminiArtifactFramePayload,
  type GeminiArtifactFrameSendContext,
  type GeminiArtifactFrameSendResult,
  type GeminiArtifactFrameTransportStatusSnapshot,
  type GeminiBrowserLiveSessionBootstrap,
} from "../lib/gemini-browser-live-websocket-dogfood"
import { recordSophiaCaptureEvent } from "../lib/session-capture"
import type { ContextMode, PresetType } from "../lib/session-types"
import { reconcileVoiceTranscript } from "../lib/voice-transcript-reconciliation"
import type {
  GeminiRuntimeConnectionState,
  GeminiRuntimeMicrophoneState,
  GeminiRuntimeRelayStatus,
  GeminiRuntimeRemoteAudioState,
  GeminiRuntimeWebSocketState,
  SessionRuntime,
  VoiceRuntimeTelemetry,
  VoiceStage,
} from "../lib/voice-types"
import { usePresenceStore } from "../stores/presence-store"
import { useSessionStore } from "../stores/session-store"
import { useVoiceStore } from "../stores/voice-store"

import { usePlatformSignal } from "./usePlatformSignal"
import {
  useStreamVoice,
  type StreamVoiceCredentials,
} from "./useStreamVoice"
import {
  applyAssistantTranscriptUpdate,
  applyPacedAssistantTranscriptUpdate,
  createAssistantTranscriptStaleGuardState,
  createAssistantTranscriptPacingState,
  markActiveAssistantTranscriptInterrupted,
  markAssistantTranscriptGenerationStarted,
  markAssistantTranscriptUserInputStarted,
  parseAssistantTranscriptUpdate,
  resetAssistantTranscriptStaleGuardState,
  resetAssistantTranscriptPacingState,
  shouldApplyAssistantTranscriptUpdate,
} from "./voice-session-event-ingestion"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UseStreamVoiceSessionOptions = {
  sessionId?: string
  threadId?: string
  preconnectEnabled?: boolean
  onUserTranscript?: (text: string) => void
  onAssistantResponse?: (text: string) => void
  onArtifacts?: (artifacts: Record<string, unknown>) => void
  onBuilderTask?: (task: Record<string, unknown>) => void
}

type SophiaVoiceEventSource = "custom" | "sse"

type GeminiProductionVoiceCredentials = GeminiBrowserLiveSessionBootstrap & {
  runtime: "gemini_live"
  voice_runtime: "gemini_live"
  production_route: true
  session_id: string
  stream_url: string
  preconnect?: boolean
  preconnect_ttl_ms?: number | null
  preconnect_expires_at?: string | null
}

type VoiceConnectCredentials = StreamVoiceCredentials | GeminiProductionVoiceCredentials

type VoicePreconnectSkippedReason =
  | "already_active"
  | "voice_mode_false"
  | "runtime_mismatch"
  | "expired"
  | "failed"

class VoicePreconnectSkippedError extends Error {
  reason: VoicePreconnectSkippedReason
  activeVoiceSessionExists: boolean
  runtime: SessionRuntime | null
  voiceAgentSessionId: string | null

  constructor(params: {
    reason: VoicePreconnectSkippedReason
    activeVoiceSessionExists?: boolean
    runtime?: SessionRuntime | null
    voiceAgentSessionId?: string | null
    message?: string
  }) {
    super(params.message ?? `Voice preconnect skipped: ${params.reason}`)
    this.name = "VoicePreconnectSkippedError"
    this.reason = params.reason
    this.activeVoiceSessionExists = params.activeVoiceSessionExists ?? false
    this.runtime = params.runtime ?? null
    this.voiceAgentSessionId = params.voiceAgentSessionId ?? null
  }
}

export type StreamVoiceSessionReturn = {
  stage: VoiceStage
  runtime: SessionRuntime
  runtimeTelemetry: VoiceRuntimeTelemetry
  partialReply: string
  finalReply: string
  error: string | undefined
  startTalking: () => Promise<void>
  stopTalking: () => Promise<void>
  /** Cleanup-only transport stop. Does not finalize the Sophia session or queue recap/offline work. */
  stopVoiceTransport: () => Promise<void>
  /** Mute the microphone while keeping the call + agent alive. Cheap toggle (~0ms).
   *  Use instead of stopTalking when the user is still in-session and only wants to pause mic. */
  muteMic: () => Promise<void>
  /** Unmute the microphone. If no live call exists, falls back to startTalking (full connect). */
  unmuteMic: () => Promise<void>
  /** True when the mic is currently muted via muteMic. */
  isMuted: boolean
  /** True when the WebRTC call is JOINED (agent session alive on server). */
  hasLiveCall: boolean
  bargeIn: () => void
  /** Clears speaking UI state without tearing down transport (SSE/call/credentials stay alive). */
  softBargeIn: () => void
  resetVoiceState: () => void
  /** Always false — Stream handles retries server-side */
  hasRetryableVoiceTurn: () => boolean
  /** Always resolves false — Stream handles retries server-side */
  retryLastVoiceTurn: () => Promise<boolean>
  /** Not applicable for Stream — always false */
  isReflectionTtsActive: boolean
  /** Not applicable for Stream — always false */
  needsUnlock: boolean
  /** Not applicable for Stream — no WebSocket path routing */
  path: undefined
  /** Not applicable for Stream — SDK manages MediaStream internally */
  stream: null
  /** No-op — Stream handles audio unlock natively */
  unlockAudio: () => void
  /** No-op — reflection TTS goes through Stream agent. Returns false (not spoken). */
  speakText: (text: string, traceId?: string) => Promise<boolean>
  sendArtifactFrame: (
    frame: GeminiArtifactFramePayload,
    context?: GeminiArtifactFrameSendContext,
  ) => Promise<GeminiArtifactFrameSendResult> | GeminiArtifactFrameSendResult
  getArtifactFrameTransportStatus: () => GeminiArtifactFrameTransportStatusSnapshot
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THINKING_TIMEOUT_MS = 15_000
const STARTUP_READY_TIMEOUT_MS = 10_000
const STARTUP_READY_TIMEOUT_MESSAGE = "Sophia voice is unavailable right now. Try again."
const TOKEN_ENDPOINT = "/api/sophia"
const RECENT_UTTERANCE_IDS_LIMIT = 20
const RECENT_BARGE_IN_TRANSCRIPT_FINGERPRINTS_LIMIT = 10
const AUTO_PRECONNECT_DELAY_MS = 250
const PREPARED_VOICE_CONNECT_TTL_MS = 30_000
const GEMINI_EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
const GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME = "read_artifact_text"
const GEMINI_COREVIEW_GET_CURRENT_VIEW_TOOL_NAME = "coreview_get_current_view"
const GEMINI_COREVIEW_ADD_ANNOTATION_TOOL_NAME = "coreview_add_annotation"
const GEMINI_COREVIEW_FOCUS_ANCHOR_TOOL_NAME = "coreview_focus_anchor"
const GEMINI_REVIEW_TOOL_NAMES = new Set([
  GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
  "coreview_set_view",
  "coreview_refresh_view",
  GEMINI_COREVIEW_GET_CURRENT_VIEW_TOOL_NAME,
  GEMINI_COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  GEMINI_COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
])
const GEMINI_TRANSCRIPT_COALESCING_DISABLED_REASON = "provider_output_transcription_is_delta_like"
const GEMINI_BUILDER_TOOL_NAMES = new Set([
  "start_builder_task",
  "check_async_task",
  "update_async_task",
  "cancel_async_task",
  "list_async_tasks",
])

function createLegacyRuntimeTelemetry(params: Partial<Extract<VoiceRuntimeTelemetry, { runtime: "legacy_cascade" }>> = {}): Extract<VoiceRuntimeTelemetry, { runtime: "legacy_cascade" }> {
  return {
    runtime: "legacy_cascade",
    source: params.source ?? "default",
    sessionId: params.sessionId ?? null,
    threadId: params.threadId ?? null,
    callId: params.callId ?? null,
    voiceAgentSessionId: params.voiceAgentSessionId ?? null,
    streamUrl: params.streamUrl ?? null,
  }
}

function createGeminiRuntimeTelemetry(params: Partial<Extract<VoiceRuntimeTelemetry, { runtime: "gemini_live" }>> = {}): Extract<VoiceRuntimeTelemetry, { runtime: "gemini_live" }> {
  return {
    runtime: "gemini_live",
    source: params.source ?? "voice-connect",
    sessionId: params.sessionId ?? null,
    streamUrl: params.streamUrl ?? null,
    websocketUrl: params.websocketUrl ?? null,
    relayUrl: params.relayUrl ?? null,
    transport: params.transport ?? null,
    publicEventBoundary: params.publicEventBoundary ?? null,
    connectionState: params.connectionState ?? "connecting",
    stage: params.stage ?? null,
    websocketState: params.websocketState ?? "idle",
    relayStatus: params.relayStatus ?? "disconnected",
    publicSseState: params.publicSseState ?? "disconnected",
    microphoneState: params.microphoneState ?? "idle",
    remoteAudioState: params.remoteAudioState ?? "idle",
    setupComplete: params.setupComplete ?? false,
    providerEventCount: params.providerEventCount ?? 0,
    lastProviderEventAt: params.lastProviderEventAt ?? null,
    lastProviderEventType: params.lastProviderEventType ?? null,
    providerCategoryCounts: params.providerCategoryCounts ?? {},
    reviewVoiceReady: params.reviewVoiceReady ?? false,
    reviewMicAudioDetected: params.reviewMicAudioDetected ?? false,
    reviewUserSpeechDetected: params.reviewUserSpeechDetected ?? false,
    reviewProviderTranscriptObserved: params.reviewProviderTranscriptObserved ?? false,
    reviewPublicTranscriptObserved: params.reviewPublicTranscriptObserved ?? false,
    reviewTranscriptPromotionBlockedReason: params.reviewTranscriptPromotionBlockedReason ?? null,
    providerInputTranscriptCount: params.providerInputTranscriptCount ?? 0,
    publicUserTranscriptCount: params.publicUserTranscriptCount ?? 0,
    providerToPublicTranscriptGap: params.providerToPublicTranscriptGap ?? 0,
    firstProviderTranscriptAt: params.firstProviderTranscriptAt ?? null,
    firstPublicUserTranscriptAt: params.firstPublicUserTranscriptAt ?? null,
    transcriptPromotionLatencyMs: params.transcriptPromotionLatencyMs ?? null,
    outputAudioEventCount: params.outputAudioEventCount ?? 0,
    lastOutputAudioAt: params.lastOutputAudioAt ?? null,
    assistantTranscriptSource: params.assistantTranscriptSource ?? null,
    assistantTranscriptFinalSeen: params.assistantTranscriptFinalSeen ?? false,
    assistantTranscriptApproximate: params.assistantTranscriptApproximate ?? null,
    assistantTranscriptSessionId: params.assistantTranscriptSessionId ?? null,
    staleAssistantAudioDroppedCount: params.staleAssistantAudioDroppedCount ?? 0,
    staleAssistantTranscriptDroppedCount: params.staleAssistantTranscriptDroppedCount ?? 0,
    staleAssistantOutputSuppressionCount: params.staleAssistantOutputSuppressionCount ?? 0,
    playbackGeneration: params.playbackGeneration ?? 0,
    assistantUserOverlapMs: params.assistantUserOverlapMs ?? 0,
    bargeInTranscriptCapturedCount: params.bargeInTranscriptCapturedCount ?? 0,
    bargeInTranscriptPromotedCount: params.bargeInTranscriptPromotedCount ?? 0,
    bargeInTranscriptPromotionLatencyMs: params.bargeInTranscriptPromotionLatencyMs ?? null,
    bargeInTranscriptIgnoredCount: params.bargeInTranscriptIgnoredCount ?? 0,
    bargeInTranscriptDuplicateSuppressedCount: params.bargeInTranscriptDuplicateSuppressedCount ?? 0,
    lastBargeInTranscriptPreview: params.lastBargeInTranscriptPreview ?? null,
    bargeInNewTurnDispatchCount: params.bargeInNewTurnDispatchCount ?? 0,
    bargeInNewTurnDispatchBlockedReason: params.bargeInNewTurnDispatchBlockedReason ?? "none",
    interruptedResponseIds: params.interruptedResponseIds ?? [],
    interruptionCount: params.interruptionCount ?? 0,
    playbackFlushCount: params.playbackFlushCount ?? 0,
    lastInterruptionAt: params.lastInterruptionAt ?? null,
    lastPlaybackFlushAt: params.lastPlaybackFlushAt ?? null,
    relayDiagnosticCount: params.relayDiagnosticCount ?? 0,
    lastRelayDiagnosticAt: params.lastRelayDiagnosticAt ?? null,
    lastRelayEventType: params.lastRelayEventType ?? null,
    relayAttemptCount: params.relayAttemptCount ?? 0,
    relaySuccessCount: params.relaySuccessCount ?? 0,
    relayFailureCount: params.relayFailureCount ?? 0,
    relayTraceCount: params.relayTraceCount ?? 0,
    relayClassificationCounts: params.relayClassificationCounts ?? {
      critical: { count: 0, lastAt: null },
      summary: { count: 0, lastAt: null },
      skip: { count: 0, lastAt: null },
    },
    lastRelayTraceAt: params.lastRelayTraceAt ?? null,
    lastRelayCorrelationId: params.lastRelayCorrelationId ?? null,
    lastRelayResponseKind: params.lastRelayResponseKind ?? null,
    lastRelayDurationMs: params.lastRelayDurationMs ?? null,
    maxRelayDurationMs: params.maxRelayDurationMs ?? null,
    lastCriticalRelayDurationMs: params.lastCriticalRelayDurationMs ?? null,
    lastTranscriptionRelayDurationMs: params.lastTranscriptionRelayDurationMs ?? null,
    lastToolCallRelayDurationMs: params.lastToolCallRelayDurationMs ?? null,
    orderedRelayQueueDepth: params.orderedRelayQueueDepth ?? 0,
    oldestQueuedAgeMs: params.oldestQueuedAgeMs ?? null,
    transcriptPartialsCoalesced: params.transcriptPartialsCoalesced ?? 0,
    transcriptPartialsSent: params.transcriptPartialsSent ?? 0,
    transcriptPartialsDropped: params.transcriptPartialsDropped ?? 0,
    transcriptCoalescingDisabledReason: params.transcriptCoalescingDisabledReason ?? GEMINI_TRANSCRIPT_COALESCING_DISABLED_REASON,
    finalTranscriptEventsSent: params.finalTranscriptEventsSent ?? 0,
    nonDroppableCriticalEventsSent: params.nonDroppableCriticalEventsSent ?? 0,
    lastTranscriptRelayLatencyMs: params.lastTranscriptRelayLatencyMs ?? null,
    maxTranscriptRelayLatencyMs: params.maxTranscriptRelayLatencyMs ?? null,
    p95TranscriptRelayLatencyMs: params.p95TranscriptRelayLatencyMs ?? null,
    coalescedBySegment: params.coalescedBySegment ?? {},
    consecutiveRelayFailures: params.consecutiveRelayFailures ?? 0,
    lastRelayErrorText: params.lastRelayErrorText ?? null,
    websocketDiagnosticCount: params.websocketDiagnosticCount ?? 0,
    lastWebSocketDiagnosticAt: params.lastWebSocketDiagnosticAt ?? null,
    lastWebSocketErrorText: params.lastWebSocketErrorText ?? null,
    lastWebSocketCloseCode: params.lastWebSocketCloseCode ?? null,
    lastWebSocketCloseReasonSafe: params.lastWebSocketCloseReasonSafe ?? null,
    lastWebSocketCloseWasClean: params.lastWebSocketCloseWasClean ?? null,
    toolCallCount: params.toolCallCount ?? 0,
    toolResponseCount: params.toolResponseCount ?? 0,
    toolRejectionCount: params.toolRejectionCount ?? 0,
    toolCancellationCount: params.toolCancellationCount ?? 0,
    artifactToolCallCount: params.artifactToolCallCount ?? 0,
    artifactToolCallUnknownCount: params.artifactToolCallUnknownCount ?? 0,
    builderToolCallCount: params.builderToolCallCount ?? 0,
    reviewToolsExposed: params.reviewToolsExposed ?? [],
    emitArtifactExposedDuringReview: params.emitArtifactExposedDuringReview ?? false,
    reviewToolTimedOut: params.reviewToolTimedOut ?? false,
    reviewToolTimeoutName: params.reviewToolTimeoutName ?? null,
    reviewToolTimeoutResultSent: params.reviewToolTimeoutResultSent ?? false,
    coreviewGetCurrentViewCount: params.coreviewGetCurrentViewCount ?? 0,
    coreviewGetCurrentViewResult: params.coreviewGetCurrentViewResult ?? null,
    readArtifactTextResolvedCount: params.readArtifactTextResolvedCount ?? 0,
    readArtifactTextUnresolvedCount: params.readArtifactTextUnresolvedCount ?? 0,
    readArtifactTextTimeoutCount: params.readArtifactTextTimeoutCount ?? 0,
    readArtifactTextLastStatus: params.readArtifactTextLastStatus ?? null,
    readArtifactTextPdfExtractionStatus: params.readArtifactTextPdfExtractionStatus ?? null,
    exactTextRegistrySource: params.exactTextRegistrySource ?? null,
    annotationOverlayCaptured: params.annotationOverlayCaptured ?? null,
    annotationCount: params.annotationCount ?? 0,
    highlightCount: params.highlightCount ?? 0,
    commentCount: params.commentCount ?? 0,
    annotationActionSource: params.annotationActionSource ?? null,
    coreviewAnnotationToolCount: params.coreviewAnnotationToolCount ?? 0,
    coreviewAnnotationToolResult: params.coreviewAnnotationToolResult ?? null,
    coreviewAnnotationKind: params.coreviewAnnotationKind ?? null,
    coreviewAnnotationAnchorType: params.coreviewAnnotationAnchorType ?? null,
    coreviewAnnotationColor: params.coreviewAnnotationColor ?? null,
    coreviewAnnotationPageIndex: params.coreviewAnnotationPageIndex ?? null,
    coreviewAnnotationBlockedReason: params.coreviewAnnotationBlockedReason ?? null,
    coreviewFocusAnchorCount: params.coreviewFocusAnchorCount ?? 0,
    coreviewFocusAnchorResult: params.coreviewFocusAnchorResult ?? null,
    coreviewFocusAnchorType: params.coreviewFocusAnchorType ?? null,
    unresolvedToolCallCount: params.unresolvedToolCallCount ?? 0,
    oldestUnresolvedToolCallAgeMs: params.oldestUnresolvedToolCallAgeMs ?? null,
    lastToolPhase: params.lastToolPhase ?? null,
    lastToolName: params.lastToolName ?? null,
    lastToolAt: params.lastToolAt ?? null,
    toolCallLedger: params.toolCallLedger ?? [],
  }
}

function applyGeminiTranscriptReadiness(
  current: Extract<VoiceRuntimeTelemetry, { runtime: "gemini_live" }>,
  patch: Partial<Extract<VoiceRuntimeTelemetry, { runtime: "gemini_live" }>>,
): Extract<VoiceRuntimeTelemetry, { runtime: "gemini_live" }> {
  const next = { ...current, ...patch }
  const providerInputTranscriptCount = next.providerInputTranscriptCount ?? 0
  const publicUserTranscriptCount = next.publicUserTranscriptCount ?? 0
  const providerToPublicTranscriptGap = Math.max(providerInputTranscriptCount - publicUserTranscriptCount, 0)
  const reviewProviderTranscriptObserved = next.reviewProviderTranscriptObserved === true || providerInputTranscriptCount > 0
  const reviewPublicTranscriptObserved = next.reviewPublicTranscriptObserved === true || publicUserTranscriptCount > 0
  const reviewUserSpeechDetected = next.reviewUserSpeechDetected === true
  const reviewMicAudioDetected = next.reviewMicAudioDetected === true
  let reviewTranscriptPromotionBlockedReason: string | null = null

  if (reviewProviderTranscriptObserved && !reviewPublicTranscriptObserved && providerToPublicTranscriptGap > 0) {
    reviewTranscriptPromotionBlockedReason = "provider_transcript_not_surfaced"
  } else if (reviewUserSpeechDetected && !reviewProviderTranscriptObserved && !reviewPublicTranscriptObserved) {
    reviewTranscriptPromotionBlockedReason = "voice_input_detected_waiting_for_transcript"
  } else if (patch.reviewTranscriptPromotionBlockedReason !== undefined) {
    reviewTranscriptPromotionBlockedReason = patch.reviewTranscriptPromotionBlockedReason
  }

  return {
    ...next,
    reviewVoiceReady: reviewTranscriptPromotionBlockedReason === null,
    reviewMicAudioDetected,
    reviewUserSpeechDetected,
    reviewProviderTranscriptObserved,
    reviewPublicTranscriptObserved,
    reviewTranscriptPromotionBlockedReason,
    providerInputTranscriptCount,
    publicUserTranscriptCount,
    providerToPublicTranscriptGap,
    transcriptPromotionLatencyMs: transcriptLatencyMs(next.firstProviderTranscriptAt, next.firstPublicUserTranscriptAt),
  }
}

function transcriptLatencyMs(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
  if (!startIso || !endIso) return null
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return end - start
}

function geminiStageTelemetry(stage: string): {
  connectionState?: GeminiRuntimeConnectionState
  websocketState?: GeminiRuntimeWebSocketState
  microphoneState?: GeminiRuntimeMicrophoneState
  remoteAudioState?: GeminiRuntimeRemoteAudioState
} {
  switch (stage) {
    case "starting_backend_session":
      return { connectionState: "connecting", websocketState: "idle", microphoneState: "idle", remoteAudioState: "idle" }
    case "requesting_microphone":
      return { connectionState: "connecting", microphoneState: "waiting" }
    case "opening_websocket":
      return { connectionState: "connecting", websocketState: "connecting", microphoneState: "granted" }
    case "sending_setup":
    case "waiting_setup_complete":
      return { connectionState: "connecting", websocketState: "setup_pending", microphoneState: "granted" }
    case "connected":
      return { connectionState: "connected", websocketState: "connected", microphoneState: "connected", remoteAudioState: "expected" }
    case "streaming_audio":
      return { connectionState: "connected", websocketState: "connected", microphoneState: "connected", remoteAudioState: "expected" }
    case "closing":
      return { connectionState: "closing" }
    case "closed":
      return { connectionState: "closed", websocketState: "closed", microphoneState: "idle", remoteAudioState: "idle" }
    default:
      return {}
  }
}

function describeProviderEventType(event: unknown): string {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return "unknown"
  }

  const record = event as Record<string, unknown>
  const serverContent = record.serverContent ?? record.server_content
  if (
    serverContent
    && typeof serverContent === "object"
    && !Array.isArray(serverContent)
    && (serverContent as Record<string, unknown>).interrupted === true
  ) {
    return "serverContent.interrupted"
  }

  return [
    "setupComplete",
    "setup_complete",
    "serverContent",
    "server_content",
    "toolCall",
    "tool_call",
    "toolCallCancellation",
    "tool_call_cancellation",
    "goAway",
    "go_away",
    "sessionResumptionUpdate",
    "session_resumption_update",
    "usageMetadata",
    "usage_metadata",
    "error",
  ].find((key) => key in record) ?? "unknown"
}

function userTranscriptFingerprint(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function publicBargeInUtteranceId(diagnostic: GeminiBargeInTranscriptHandoffDiagnostic): string {
  if (diagnostic.relayCorrelationId) {
    return `gemini-barge-in:${diagnostic.relayCorrelationId}`
  }
  if (diagnostic.providerReceiveSequence !== null) {
    return `gemini-barge-in:${diagnostic.providerReceiveSequence}`
  }
  return `gemini-barge-in:${diagnostic.timestamp}`
}

function publicBargeInTranscriptData(diagnostic: GeminiBargeInTranscriptHandoffDiagnostic): Record<string, unknown> | null {
  if (!diagnostic.text) return null
  const data: Record<string, unknown> = {
    text: diagnostic.text,
    utterance_id: publicBargeInUtteranceId(diagnostic),
    handoff_source: "gemini_barge_in_transcript",
  }
  if (diagnostic.providerReceiveSequence !== null) {
    data.source_sequence = diagnostic.providerReceiveSequence
  }
  if (diagnostic.providerReceivedAt) {
    data.provider_received_at = diagnostic.providerReceivedAt
  }
  if (diagnostic.relayCorrelationId) {
    data.relay_correlation_id = diagnostic.relayCorrelationId
  }
  return data
}

function sanitizedBargeInTranscriptDiagnostic(
  diagnostic: GeminiBargeInTranscriptHandoffDiagnostic,
): Omit<GeminiBargeInTranscriptHandoffDiagnostic, "text"> {
  const safeDiagnostic: Partial<GeminiBargeInTranscriptHandoffDiagnostic> = { ...diagnostic }
  delete safeDiagnostic.text
  return safeDiagnostic as Omit<GeminiBargeInTranscriptHandoffDiagnostic, "text">
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callingStateToVoiceStage(
  cs: CallingState,
  isSophiaReady: boolean,
  hasActiveCredentials: boolean,
): VoiceStage {
  switch (cs) {
    case CallingState.JOINING:
    case CallingState.RECONNECTING:
      return "connecting"
    case CallingState.JOINED:
      if (!hasActiveCredentials) return "idle"
      return isSophiaReady ? "listening" : "connecting"
    case CallingState.LEFT:
    case CallingState.IDLE:
      return "idle"
    default:
      return "idle"
  }
}

function buildVoiceConnectKey(
  userId: string,
  platform: string,
  contextMode: ContextMode,
  ritual: string | null,
  sessionId?: string,
  threadId?: string,
): string {
  return JSON.stringify({
    userId,
    platform,
    contextMode,
    ritual,
    sessionId: sessionId ?? null,
    threadId: threadId ?? null,
  })
}

function isGeminiProductionCredentials(credentials: VoiceConnectCredentials | null): credentials is GeminiProductionVoiceCredentials {
  return Boolean(credentials && "runtime" in credentials && credentials.runtime === "gemini_live")
}

function voiceCredentialsRuntime(credentials: VoiceConnectCredentials): SessionRuntime {
  return isGeminiProductionCredentials(credentials) ? "gemini_live" : "legacy_cascade"
}

function voiceCredentialsCallId(credentials: VoiceConnectCredentials): string {
  return isGeminiProductionCredentials(credentials) ? credentials.session_id : credentials.callId
}

function voiceCredentialsSessionId(credentials: VoiceConnectCredentials): string | null {
  return isGeminiProductionCredentials(credentials) ? credentials.session_id : credentials.sessionId ?? null
}

function voiceCredentialsPreparedTtlMs(credentials: VoiceConnectCredentials): number {
  if (!isGeminiProductionCredentials(credentials)) {
    return PREPARED_VOICE_CONNECT_TTL_MS
  }

  const serverTtlMs = credentials.preconnect_ttl_ms
  if (typeof serverTtlMs === "number" && Number.isFinite(serverTtlMs) && serverTtlMs > 0) {
    return Math.min(serverTtlMs, PREPARED_VOICE_CONNECT_TTL_MS)
  }

  return PREPARED_VOICE_CONNECT_TTL_MS
}

function isVoicePreconnectSkippedError(error: unknown): error is VoicePreconnectSkippedError {
  return error instanceof VoicePreconnectSkippedError
}

function readVoicePreconnectSkippedReason(value: unknown): VoicePreconnectSkippedReason {
  switch (value) {
    case "already_active":
    case "voice_mode_false":
    case "runtime_mismatch":
    case "expired":
    case "failed":
      return value
    default:
      return "failed"
  }
}

function isActiveSessionPreconnectConflict(status: number, body: string): boolean {
  return status === 409 && /active voice session already exists/i.test(body)
}

function assistantTranscriptFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

async function fetchStreamCredentials(
  userId: string,
  platform: string,
  contextMode: ContextMode,
  ritual: string | null,
  sessionId?: string,
  threadId?: string,
  signal?: AbortSignal,
  preconnect = false,
): Promise<VoiceConnectCredentials> {
  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      platform,
      context_mode: contextMode,
      ritual,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
      ...(preconnect ? { preconnect: true } : {}),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    if (preconnect && isActiveSessionPreconnectConflict(res.status, body)) {
      throw new VoicePreconnectSkippedError({
        reason: "already_active",
        activeVoiceSessionExists: true,
        runtime: "gemini_live",
        message: "Voice preconnect skipped because an active voice session already exists.",
      })
    }
    throw new Error(`Voice connect failed (${res.status}): ${body}`)
  }
  const data = await res.json()

  if (preconnect && data?.preconnect_skipped === true) {
    throw new VoicePreconnectSkippedError({
      reason: readVoicePreconnectSkippedReason(data.preconnect_skipped_reason),
      activeVoiceSessionExists: data.active_voice_session_exists === true,
      runtime: data.runtime === "gemini_live" || data.voice_runtime === "gemini_live"
        ? "gemini_live"
        : data.runtime === "legacy_cascade" || data.voice_runtime === "legacy_cascade"
          ? "legacy_cascade"
          : null,
      voiceAgentSessionId: typeof data.session_id === "string" ? data.session_id : null,
    })
  }

  if (data?.runtime === "gemini_live" || data?.voice_runtime === "gemini_live") {
    return data as GeminiProductionVoiceCredentials
  }

  return {
    runtime: data.runtime === "legacy_cascade" ? "legacy_cascade" : undefined,
    voiceRuntime: data.voice_runtime === "legacy_cascade" ? "legacy_cascade" : undefined,
    apiKey: data.api_key,
    token: data.token,
    callType: data.call_type,
    callId: data.call_id,
    sessionId: typeof data.session_id === "string" ? data.session_id : null,
    threadId: typeof data.thread_id === "string" ? data.thread_id : null,
    streamUrl: typeof data.stream_url === "string" ? data.stream_url : null,
  }
}

async function prewarmStreamVoiceConnect(
  _userId: string,
  _signal?: AbortSignal,
): Promise<void> {
  // Frontend auth prewarm is intentionally a no-op. The real warmup happens once
  // we have prepared voice credentials and can call /voice/warmup with session data.
}

async function requestVoiceDisconnect(
  userId: string,
  credentials: StreamVoiceCredentials,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  if (!credentials.sessionId) return

  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call_id: credentials.callId,
      session_id: credentials.sessionId,
      ...(credentials.threadId ? { thread_id: credentials.threadId } : {}),
    }),
    keepalive: options.keepalive,
  })

  if (res.ok) {
    return
  }

  const body = await res.text().catch(() => "")
  throw new Error(`Voice disconnect failed (${res.status}): ${body}`)
}

async function requestGeminiBootstrapDisconnect(
  credentials: GeminiProductionVoiceCredentials,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const disconnectUrl = typeof credentials.disconnect_url === "string"
    ? credentials.disconnect_url
    : "/api/sophia/voice/gemini/disconnect"

  await fetch(disconnectUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: credentials.session_id }),
    keepalive: options.keepalive,
  }).catch(() => undefined)
}

async function requestVoiceWarmup(
  userId: string,
  credentials: StreamVoiceCredentials,
  signal?: AbortSignal,
): Promise<void> {
  if (!credentials.sessionId) {
    return
  }

  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/warmup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      call_id: credentials.callId,
      session_id: credentials.sessionId,
    }),
  })

  if (res.ok) {
    return
  }

  const body = await res.text().catch(() => "")
  throw new Error(`Voice warmup failed (${res.status}): ${body}`)
}

function resolveVoiceRitual(presetType: PresetType | null): string | null {
  switch (presetType) {
    case "prepare":
    case "debrief":
    case "reset":
    case "vent":
      return presetType
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStreamVoiceSession(
  userId?: string,
  options: UseStreamVoiceSessionOptions = {},
): StreamVoiceSessionReturn {
  const {
    sessionId,
    threadId,
    preconnectEnabled = true,
    onUserTranscript,
    onAssistantResponse,
    onArtifacts,
    onBuilderTask,
  } = options

  // --- State ---------------------------------------------------------------
  const [stage, setStage] = useState<VoiceStage>("idle")
  const [partialReply, setPartialReply] = useState("")
  const [finalReply, setFinalReply] = useState("")
  const [error, setError] = useState<string | undefined>(undefined)
  const [credentials, setCredentials] = useState<StreamVoiceCredentials | null>(null)
  const [geminiConnection, setGeminiConnection] = useState<GeminiBrowserLiveDogfoodConnection | null>(null)
  const [runtimeTelemetry, setRuntimeTelemetry] = useState<VoiceRuntimeTelemetry>(() =>
    createLegacyRuntimeTelemetry({ sessionId: sessionId ?? null, threadId: threadId ?? null }),
  )
  const [isSophiaReady, setIsSophiaReady] = useState(false)
  const [isMuted, setIsMuted] = useState(false)

  // --- Refs (mutable, non-render-triggering) -------------------------------
  const prevCallingStateRef = useRef<CallingState>(CallingState.IDLE)
  const prevSophiaReadyRef = useRef(false)
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startupReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recentUserTranscriptIdsRef = useRef<string[]>([])
  const recentBargeInTranscriptFingerprintsRef = useRef<string[]>([])
  const currentTurnUserTranscriptRef = useRef<string | null>(null)
  const softBargeInActiveRef = useRef(false)
  const userMicMutedRef = useRef(false)
  const destroyedRef = useRef(false)
  const errorStageLockRef = useRef(false)
  const isSophiaReadyRef = useRef(false)
  const credentialsRef = useRef<StreamVoiceCredentials | null>(null)
  const geminiConnectionRef = useRef<GeminiBrowserLiveDogfoodConnection | null>(null)
  const assistantTranscriptPacingRef = useRef(createAssistantTranscriptPacingState())
  const assistantTranscriptStaleGuardRef = useRef(createAssistantTranscriptStaleGuardState())
  const disconnectRequestKeyRef = useRef<string | null>(null)
  const onArtifactsRef = useRef(onArtifacts)
  const onBuilderTaskRef = useRef(onBuilderTask)
  const onUserTranscriptRef = useRef(onUserTranscript)
  const onAssistantResponseRef = useRef(onAssistantResponse)
  const sessionIdRef = useRef(sessionId)
  const pendingStartControllerRef = useRef<AbortController | null>(null)
  const startRequestVersionRef = useRef(0)
  const startInFlightRef = useRef(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const preferSseEventsRef = useRef(false)
  const connectPrewarmPromiseRef = useRef<Promise<void> | null>(null)
  const connectPrewarmControllerRef = useRef<AbortController | null>(null)
  const connectPrewarmAttemptedUserIdRef = useRef<string | null>(null)
  const autoPreconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preparedVoiceConnectKeyRef = useRef<string | null>(null)
  const preparedVoiceConnectPromiseRef = useRef<Promise<VoiceConnectCredentials | null> | null>(null)
  const preparedVoiceConnectControllerRef = useRef<AbortController | null>(null)
  const preparedVoiceCredentialsRef = useRef<VoiceConnectCredentials | null>(null)
  const preparedVoiceCredentialsAtRef = useRef<number>(0)
  const backendWarmupKeyRef = useRef<string | null>(null)
  const backendWarmupControllerRef = useRef<AbortController | null>(null)
  const autoPreconnectEnabledRef = useRef(true)
  const geminiOpeningGreetingLatchRef = useRef<{
    sessionId: string | null
    userTranscriptSeen: boolean
    emitted: boolean
    fingerprint: string | null
  }>({
    sessionId: null,
    userTranscriptSeen: false,
    emitted: false,
    fingerprint: null,
  })

  // Keep refs current without re-binding effects
  useEffect(() => { credentialsRef.current = credentials }, [credentials])
  useEffect(() => { geminiConnectionRef.current = geminiConnection }, [geminiConnection])
  useEffect(() => { onArtifactsRef.current = onArtifacts }, [onArtifacts])
  useEffect(() => { onBuilderTaskRef.current = onBuilderTask }, [onBuilderTask])
  useEffect(() => { onUserTranscriptRef.current = onUserTranscript }, [onUserTranscript])
  useEffect(() => { onAssistantResponseRef.current = onAssistantResponse }, [onAssistantResponse])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { isSophiaReadyRef.current = isSophiaReady }, [isSophiaReady])
  useEffect(() => {
    autoPreconnectEnabledRef.current = true
  }, [sessionId, threadId, userId])
  useEffect(() => {
    if (credentials?.callId && credentials?.sessionId) {
      disconnectRequestKeyRef.current = null
    }
  }, [credentials?.callId, credentials?.sessionId])
  useEffect(() => {
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    backendWarmupKeyRef.current = null
  }, [sessionId, threadId, userId])

  // --- Platform signal ------------------------------------------------------
  const platform = usePlatformSignal()
  const contextMode = useSessionStore((state) => state.session?.contextMode ?? "life")
  const presetType = useSessionStore((state) => state.session?.presetType ?? null)
  const voiceRitual = resolveVoiceRitual(presetType)

  // --- Stores --------------------------------------------------------------
  const addVoiceMessage = useVoiceStore((s) => s.addMessage)
  const setVoiceFailed = useVoiceStore((s) => s.setVoiceFailed)
  const setListeningPresence = usePresenceStore((s) => s.setListening)
  const setSpeakingPresence = usePresenceStore((s) => s.setSpeaking)
  const setMetaPresence = usePresenceStore((s) => s.setMetaStage)
  const settlePresence = usePresenceStore((s) => s.settleToRestingSoon)
  const resetPresence = usePresenceStore((s) => s.reset)

  // --- Stream Voice (Unit 2) -----------------------------------------------
  const {
    call,
    callingState,
    error: streamError,
    remoteParticipantSessionIds,
    join,
    leave,
  } = useStreamVoice({
    userId: userId ?? "anonymous",
    credentials,
  })

  // --- Thinking timeout helper ---------------------------------------------
  const clearThinking = useCallback(() => {
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current)
      thinkingTimeoutRef.current = null
    }
  }, [])

  const startThinkingTimeout = useCallback(() => {
    clearThinking()
    thinkingTimeoutRef.current = setTimeout(() => {
      if (!destroyedRef.current) {
        setStage("error")
        setError("Agent response timed out")
      }
    }, THINKING_TIMEOUT_MS)
  }, [clearThinking])

  const clearStartupReadyTimeout = useCallback(() => {
    if (startupReadyTimeoutRef.current) {
      clearTimeout(startupReadyTimeoutRef.current)
      startupReadyTimeoutRef.current = null
    }
  }, [])

  const hasSeenUserTranscriptId = useCallback((utteranceId: string) => {
    return recentUserTranscriptIdsRef.current.includes(utteranceId)
  }, [])

  const rememberUserTranscriptId = useCallback((utteranceId: string) => {
    recentUserTranscriptIdsRef.current = [
      ...recentUserTranscriptIdsRef.current.filter((existingId) => existingId !== utteranceId),
      utteranceId,
    ].slice(-RECENT_UTTERANCE_IDS_LIMIT)
  }, [])

  const hasSeenBargeInTranscriptFingerprint = useCallback((fingerprint: string) => {
    return fingerprint.length > 0 && recentBargeInTranscriptFingerprintsRef.current.includes(fingerprint)
  }, [])

  const rememberBargeInTranscriptFingerprint = useCallback((fingerprint: string) => {
    if (!fingerprint) return
    recentBargeInTranscriptFingerprintsRef.current = [
      ...recentBargeInTranscriptFingerprintsRef.current.filter((existing) => existing !== fingerprint),
      fingerprint,
    ].slice(-RECENT_BARGE_IN_TRANSCRIPT_FINGERPRINTS_LIMIT)
  }, [])

  const forgetBargeInTranscriptFingerprint = useCallback((fingerprint: string) => {
    if (!fingerprint) return
    recentBargeInTranscriptFingerprintsRef.current = recentBargeInTranscriptFingerprintsRef.current.filter(
      (existing) => existing !== fingerprint,
    )
  }, [])

  const clearCurrentTurnUserTranscript = useCallback(() => {
    currentTurnUserTranscriptRef.current = null
  }, [])

  const resetGeminiOpeningGreetingLatch = useCallback((voiceAgentSessionId: string | null = null) => {
    geminiOpeningGreetingLatchRef.current = {
      sessionId: voiceAgentSessionId,
      userTranscriptSeen: false,
      emitted: false,
      fingerprint: null,
    }
  }, [])

  const recordPreconnectSkipped = useCallback((
    reason: VoicePreconnectSkippedReason,
    metadata: Record<string, unknown> = {},
  ) => {
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "preconnect-skipped",
      payload: {
        preconnectStatus: "skipped",
        preconnectSkippedReason: reason,
        activeVoiceSessionExists: Boolean(
          metadata.activeVoiceSessionExists
          ?? geminiConnectionRef.current
          ?? credentialsRef.current,
        ),
        platform,
        sessionId: sessionIdRef.current ?? null,
        threadId: threadId ?? null,
        ...metadata,
      },
    })
  }, [platform, threadId])

  const shouldApplyGeminiOpeningGreetingUpdate = useCallback((update: { text: string; isFinal: boolean }) => {
    const activeSessionId = geminiConnectionRef.current?.sessionId ?? null
    if (!activeSessionId) return true

    const latch = geminiOpeningGreetingLatchRef.current
    if (latch.sessionId !== activeSessionId) {
      resetGeminiOpeningGreetingLatch(activeSessionId)
    }
    const currentLatch = geminiOpeningGreetingLatchRef.current
    if (currentLatch.userTranscriptSeen) {
      return true
    }

    if (currentLatch.emitted) {
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "opening-greeting-duplicate-suppressed",
        payload: {
          runtime: "gemini_live",
          openingGreetingDuplicateSuppressed: true,
          openingGreetingSource: "gemini_live_assistant_transcript",
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: activeSessionId,
        },
      })
      return false
    }

    if (update.isFinal) {
      currentLatch.emitted = true
      currentLatch.fingerprint = assistantTranscriptFingerprint(update.text)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "opening-greeting-emitted",
        payload: {
          runtime: "gemini_live",
          openingGreetingEmitted: true,
          openingGreetingSource: "gemini_live_assistant_transcript",
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: activeSessionId,
        },
      })
    }

    return true
  }, [resetGeminiOpeningGreetingLatch])

  const applyUserTranscriptData = useCallback((
    data: Record<string, unknown> | undefined,
    source: "public_user_transcript" | "barge_in_transcript_handoff",
  ): boolean => {
    const text = typeof data?.text === "string" ? data.text : ""
    if (!text) return false

    const fingerprint = userTranscriptFingerprint(text)
    const utteranceId = typeof data?.utterance_id === "string" ? data.utterance_id : null
    if (source === "public_user_transcript" && hasSeenBargeInTranscriptFingerprint(fingerprint)) {
      if (utteranceId) rememberUserTranscriptId(utteranceId)
      forgetBargeInTranscriptFingerprint(fingerprint)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "duplicate-barge-in-user-transcript-ignored",
        payload: {
          utteranceId,
          source,
          sessionId: sessionIdRef.current ?? null,
        },
      })
      return false
    }

    const interruptedKeys = markAssistantTranscriptUserInputStarted(assistantTranscriptStaleGuardRef.current)
    if (interruptedKeys.length > 0) {
      resetAssistantTranscriptPacingState(assistantTranscriptPacingRef.current)
      setPartialReply("")
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "assistant-transcript-interrupted-by-user",
        payload: {
          interruptedKeys,
          source,
          sessionId: sessionIdRef.current ?? null,
        },
      })
    }

    if (utteranceId) {
      if (hasSeenUserTranscriptId(utteranceId)) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "duplicate-user-transcript-ignored",
          payload: {
            utteranceId,
            source,
            sessionId: sessionIdRef.current ?? null,
          },
        })
        return false
      }

      rememberUserTranscriptId(utteranceId)
    }

    const reconciledTranscript = reconcileVoiceTranscript(currentTurnUserTranscriptRef.current, text)
    if (!reconciledTranscript.changed && currentTurnUserTranscriptRef.current) {
      if (source === "barge_in_transcript_handoff") {
        rememberBargeInTranscriptFingerprint(fingerprint)
      }
      return false
    }

    currentTurnUserTranscriptRef.current = reconciledTranscript.text
    geminiOpeningGreetingLatchRef.current.userTranscriptSeen = true
    if (source === "barge_in_transcript_handoff") {
      rememberBargeInTranscriptFingerprint(userTranscriptFingerprint(reconciledTranscript.text))
    }
    onUserTranscriptRef.current?.(reconciledTranscript.text)
    return true
  }, [forgetBargeInTranscriptFingerprint, hasSeenBargeInTranscriptFingerprint, hasSeenUserTranscriptId, rememberBargeInTranscriptFingerprint, rememberUserTranscriptId])

  const cancelPendingStartRequest = useCallback(() => {
    startRequestVersionRef.current += 1
    startInFlightRef.current = false
    pendingStartControllerRef.current?.abort()
    pendingStartControllerRef.current = null
  }, [])

  const closeEventSource = useCallback(() => {
    preferSseEventsRef.current = false
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    setRuntimeTelemetry((current) => current.runtime === "gemini_live"
      ? { ...current, publicSseState: "disconnected" }
      : current)
  }, [])

  const clearAutoPreconnectTimer = useCallback(() => {
    if (autoPreconnectTimerRef.current) {
      clearTimeout(autoPreconnectTimerRef.current)
      autoPreconnectTimerRef.current = null
    }
  }, [])

  const clearPreparedVoiceConnectRefs = useCallback(() => {
    preparedVoiceConnectControllerRef.current?.abort()
    preparedVoiceConnectControllerRef.current = null
    preparedVoiceConnectPromiseRef.current = null
    preparedVoiceConnectKeyRef.current = null
    preparedVoiceCredentialsRef.current = null
    preparedVoiceCredentialsAtRef.current = 0
  }, [])

  const scheduleBackendWarmup = useCallback((nextCredentials: StreamVoiceCredentials | null) => {
    if (!userId || !nextCredentials?.sessionId) {
      return
    }

    const warmupKey = `${userId}:${nextCredentials.callId}:${nextCredentials.sessionId}`
    if (backendWarmupKeyRef.current === warmupKey) {
      return
    }

    backendWarmupControllerRef.current?.abort()
    backendWarmupKeyRef.current = warmupKey

    const controller = new AbortController()
    backendWarmupControllerRef.current = controller

    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "backend-warmup-started",
      payload: {
        callId: nextCredentials.callId,
        sessionId: sessionIdRef.current ?? null,
        voiceAgentSessionId: nextCredentials.sessionId,
      },
    })

    void requestVoiceWarmup(userId, nextCredentials, controller.signal)
      .then(() => {
        if (controller.signal.aborted) {
          return
        }

        if (backendWarmupControllerRef.current === controller) {
          backendWarmupControllerRef.current = null
        }

        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "backend-warmup-completed",
          payload: {
            callId: nextCredentials.callId,
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: nextCredentials.sessionId,
          },
        })
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          return
        }

        if (backendWarmupControllerRef.current === controller) {
          backendWarmupControllerRef.current = null
        }
        if (backendWarmupKeyRef.current === warmupKey) {
          backendWarmupKeyRef.current = null
        }

        logger.debug("StreamVoiceSession", "Voice backend warmup failed", {
          userId,
          callId: nextCredentials.callId,
          voiceAgentSessionId: nextCredentials.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "backend-warmup-failed",
          payload: {
            callId: nextCredentials.callId,
            error: err instanceof Error ? err.message : String(err),
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: nextCredentials.sessionId,
          },
        })
      })
  }, [userId])

  const releasePreparedVoiceConnect = useCallback(async (options: { keepalive?: boolean } = {}) => {
    const preparedCredentials = preparedVoiceCredentialsRef.current
    const activeCredentials = credentialsRef.current
    const activeGeminiSessionId = geminiConnectionRef.current?.sessionId ?? null

    clearPreparedVoiceConnectRefs()

    if (!userId || !preparedCredentials) {
      return
    }

    if (isGeminiProductionCredentials(preparedCredentials)) {
      if (activeGeminiSessionId === preparedCredentials.session_id) {
        return
      }

      await requestGeminiBootstrapDisconnect(preparedCredentials, options)
      return
    }

    if (!preparedCredentials.sessionId) {
      return
    }

    if (
      activeCredentials?.callId === preparedCredentials.callId
      && activeCredentials?.sessionId === preparedCredentials.sessionId
    ) {
      return
    }

    try {
      await requestVoiceDisconnect(userId, preparedCredentials, options)
    } catch {
      // Best-effort cleanup for unused preconnected sessions.
    }
  }, [clearPreparedVoiceConnectRefs, userId])

  const getArtifactFrameTransportStatus = useCallback((): GeminiArtifactFrameTransportStatusSnapshot => {
    const activeGeminiConnection = geminiConnectionRef.current
    if (activeGeminiConnection) {
      return activeGeminiConnection.getArtifactFrameTransportStatus()
    }

    return {
      websocketReadyState: null,
      websocketState: "closed",
      websocketOpen: false,
      websocketCloseCode: null,
      websocketCloseReasonSafe: null,
      websocketCloseWasClean: null,
      websocketCloseAt: null,
      error: "gemini_live_websocket_not_open",
    }
  }, [])

  const recordArtifactFrameSendResult = useCallback((result: GeminiArtifactFrameSendResult) => {
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "gemini-artifact-frame-send",
      payload: {
        runtime: "gemini_live",
        sessionId: sessionIdRef.current ?? null,
        voiceAgentSessionId: geminiConnectionRef.current?.sessionId ?? null,
        result,
      },
    })
  }, [])

  const sendArtifactFrame = useCallback((
    frame: GeminiArtifactFramePayload,
    context?: GeminiArtifactFrameSendContext,
  ): Promise<GeminiArtifactFrameSendResult> | GeminiArtifactFrameSendResult => {
    const activeGeminiConnection = geminiConnectionRef.current
    if (activeGeminiConnection) {
      return activeGeminiConnection.sendArtifactFrame(frame, context).then((result) => {
        recordArtifactFrameSendResult(result)
        return result
      })
    }

    const now = new Date().toISOString()
    const result: GeminiArtifactFrameSendResult = {
      coreviewSendStage: context?.coreviewSendStage ?? null,
      artifactId: frame.artifactId ?? null,
      ok: false,
      supported: true,
      providerAcceptedFrame: false,
      websocketSendAccepted: false,
      websocketReadyStateBefore: null,
      websocketReadyStateAfter: null,
      websocketOpenBeforeSend: false,
      websocketOpenAfterSend: false,
      framePayloadSchemaVersion: "realtimeInput.video.v1",
      frameBytes: frame.byteLength,
      frameDimensions: frame.dimensions,
      visualSourceKind: frame.visualSourceKind ?? null,
      mimeType: frame.mimeType,
      frameSendLatencyMs: 0,
      sendStartedAt: now,
      sendCompletedAt: now,
      sendDurationMs: 0,
      sendExceptionName: null,
      sendExceptionSafeMessage: null,
      providerEventCountBefore: null,
      providerEventCountAfter: null,
      lastProviderEventTypeBefore: null,
      lastProviderEventTypeAfter: null,
      websocketCloseCode: null,
      websocketCloseReasonSafe: null,
      websocketCloseWasClean: null,
      websocketCloseAt: null,
      websocketClosedAfterFrameSend: false,
      timeFromFrameSendToCloseMs: null,
      usageMetadataAfterFrame: null,
      imageCountAfterFrame: null,
      videoDurationSecondsAfterFrame: null,
      audioDurationSecondsAfterFrame: null,
      visualResponseObserved: false,
      estimatedVisualCost: null,
      error: "gemini_live_websocket_not_open",
      rawFrameExcluded: true,
    }
    recordArtifactFrameSendResult(result)
    return result
  }, [recordArtifactFrameSendResult])

  const prewarmVoiceConnect = useCallback(() => {
    if (!userId) {
      return null
    }

    if (
      connectPrewarmAttemptedUserIdRef.current === userId
      || connectPrewarmPromiseRef.current !== null
    ) {
      return connectPrewarmPromiseRef.current
    }

    connectPrewarmAttemptedUserIdRef.current = userId
    const controller = new AbortController()
    connectPrewarmControllerRef.current = controller

    const promise = prewarmStreamVoiceConnect(userId, controller.signal)
      .catch((err) => {
        if (controller.signal.aborted) {
          return
        }

        logger.debug("StreamVoiceSession", "Voice connect prewarm failed", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        if (connectPrewarmControllerRef.current === controller) {
          connectPrewarmControllerRef.current = null
        }
        if (connectPrewarmPromiseRef.current === promise) {
          connectPrewarmPromiseRef.current = null
        }
      })

    connectPrewarmPromiseRef.current = promise
    return promise
  }, [userId])

  const preconnectVoiceSession = useCallback(() => {
    if (!userId || !autoPreconnectEnabledRef.current) {
      return null
    }

    if (!preconnectEnabled || platform === "text") {
      autoPreconnectEnabledRef.current = false
      recordPreconnectSkipped("voice_mode_false", {
        activeVoiceSessionExists: false,
      })
      return Promise.resolve(null)
    }

    if (credentialsRef.current || geminiConnectionRef.current || startInFlightRef.current || callingState !== CallingState.IDLE) {
      autoPreconnectEnabledRef.current = false
      recordPreconnectSkipped("already_active", {
        activeVoiceSessionExists: true,
      })
      return Promise.resolve(null)
    }

    const connectKey = buildVoiceConnectKey(
      userId,
      platform,
      contextMode,
      voiceRitual,
      sessionId,
      threadId,
    )

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedVoiceCredentialsRef.current
      && Date.now() - preparedVoiceCredentialsAtRef.current < voiceCredentialsPreparedTtlMs(preparedVoiceCredentialsRef.current)
    ) {
      return Promise.resolve(preparedVoiceCredentialsRef.current)
    }

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedVoiceConnectPromiseRef.current !== null
    ) {
      return preparedVoiceConnectPromiseRef.current
    }

    void releasePreparedVoiceConnect()

    const controller = new AbortController()
    preparedVoiceConnectControllerRef.current = controller
    preparedVoiceConnectKeyRef.current = connectKey
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "preconnect-started",
      payload: {
        userId,
        platform,
        sessionId: sessionIdRef.current ?? null,
        threadId: threadId ?? null,
      },
    })

    const promise = (async () => {
      if (connectPrewarmPromiseRef.current !== null) {
        await connectPrewarmPromiseRef.current
      }

      const creds = await fetchStreamCredentials(
        userId,
        platform,
        contextMode,
        voiceRitual,
        sessionId,
        threadId,
        controller.signal,
        true,
      )

      if (
        controller.signal.aborted
        || destroyedRef.current
        || preparedVoiceConnectControllerRef.current !== controller
        || preparedVoiceConnectKeyRef.current !== connectKey
      ) {
        if (isGeminiProductionCredentials(creds)) {
          await requestGeminiBootstrapDisconnect(creds)
        } else if (creds.sessionId) {
          try {
            await requestVoiceDisconnect(userId, creds)
          } catch {
            // Best-effort cleanup for stale prefetched credentials.
          }
        }
        return null
      }

      preparedVoiceCredentialsRef.current = creds
      preparedVoiceCredentialsAtRef.current = Date.now()
      if (!isGeminiProductionCredentials(creds)) {
        scheduleBackendWarmup(creds)
      }
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "preconnect-ready",
        payload: {
          callId: voiceCredentialsCallId(creds),
          preconnectTtlMs: voiceCredentialsPreparedTtlMs(creds),
          runtime: voiceCredentialsRuntime(creds),
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: voiceCredentialsSessionId(creds),
        },
      })
      return creds
    })()
      .catch((err) => {
        if (!controller.signal.aborted) {
          if (isVoicePreconnectSkippedError(err)) {
            autoPreconnectEnabledRef.current = false
            logger.debug("StreamVoiceSession", "Voice session preconnect skipped", {
              userId,
              reason: err.reason,
            })
            recordPreconnectSkipped(err.reason, {
              activeVoiceSessionExists: err.activeVoiceSessionExists,
              runtime: err.runtime,
              voiceAgentSessionId: err.voiceAgentSessionId,
            })
            return null
          }
          logger.debug("StreamVoiceSession", "Voice session preconnect failed", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
          recordSophiaCaptureEvent({
            category: "voice-session",
            name: "preconnect-failed",
            payload: {
              error: err instanceof Error ? err.message : String(err),
              preconnectStatus: "failed",
              sessionId: sessionIdRef.current ?? null,
            },
          })
        }
        return null
      })
      .finally(() => {
        if (preparedVoiceConnectPromiseRef.current === promise) {
          preparedVoiceConnectPromiseRef.current = null
        }
        if (preparedVoiceConnectControllerRef.current === controller) {
          preparedVoiceConnectControllerRef.current = null
        }
      })

    preparedVoiceConnectPromiseRef.current = promise
    return promise
  }, [
    callingState,
    connectPrewarmPromiseRef,
    contextMode,
    platform,
    preconnectEnabled,
    recordPreconnectSkipped,
    releasePreparedVoiceConnect,
    scheduleBackendWarmup,
    sessionId,
    threadId,
    userId,
    voiceRitual,
  ])

  const consumePreparedVoiceConnect = useCallback(async () => {
    if (!userId) {
      return null
    }

    const connectKey = buildVoiceConnectKey(
      userId,
      platform,
      contextMode,
      voiceRitual,
      sessionId,
      threadId,
    )

    const preparedCredentials = preparedVoiceCredentialsRef.current
    const preparedAgeMs = preparedCredentials
      ? Date.now() - preparedVoiceCredentialsAtRef.current
      : null
    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedCredentials
      && preparedAgeMs !== null
      && preparedAgeMs < voiceCredentialsPreparedTtlMs(preparedCredentials)
    ) {
      clearPreparedVoiceConnectRefs()
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "preconnect-reused",
        payload: {
          callId: voiceCredentialsCallId(preparedCredentials),
          preconnectAgeMs: preparedAgeMs,
          preconnectStatus: "hit",
          runtime: voiceCredentialsRuntime(preparedCredentials),
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: voiceCredentialsSessionId(preparedCredentials),
        },
      })
      return preparedCredentials
    }

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedVoiceConnectPromiseRef.current !== null
    ) {
      const prefetchedCredentials = await preparedVoiceConnectPromiseRef.current
      if (!prefetchedCredentials) {
        return null
      }

      const prefetchedAgeMs = Date.now() - preparedVoiceCredentialsAtRef.current
      if (
        preparedVoiceConnectKeyRef.current === connectKey
        && voiceCredentialsCallId(preparedVoiceCredentialsRef.current ?? prefetchedCredentials) === voiceCredentialsCallId(prefetchedCredentials)
        && voiceCredentialsSessionId(preparedVoiceCredentialsRef.current ?? prefetchedCredentials) === voiceCredentialsSessionId(prefetchedCredentials)
        && prefetchedAgeMs < voiceCredentialsPreparedTtlMs(prefetchedCredentials)
      ) {
        clearPreparedVoiceConnectRefs()
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "preconnect-reused",
          payload: {
            callId: voiceCredentialsCallId(prefetchedCredentials),
            preconnectAgeMs: prefetchedAgeMs,
            preconnectStatus: "hit",
            runtime: voiceCredentialsRuntime(prefetchedCredentials),
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: voiceCredentialsSessionId(prefetchedCredentials),
          },
        })
        return prefetchedCredentials
      }

      await releasePreparedVoiceConnect()
      return null
    }

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedCredentials
    ) {
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "preconnect-expired",
        payload: {
          callId: voiceCredentialsCallId(preparedCredentials),
          preconnectAgeMs: preparedAgeMs,
          preconnectStatus: "expired",
          runtime: voiceCredentialsRuntime(preparedCredentials),
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: voiceCredentialsSessionId(preparedCredentials),
        },
      })
      await releasePreparedVoiceConnect()
    }

    return null
  }, [
    clearPreparedVoiceConnectRefs,
    contextMode,
    platform,
    releasePreparedVoiceConnect,
    sessionId,
    threadId,
    userId,
    voiceRitual,
  ])

  const markSophiaReady = useCallback(
    (
      reason: "remote-participant" | "custom-event" | "gemini-live-setup-complete",
      metadata?: Record<string, unknown>,
    ) => {
      if (isSophiaReadyRef.current) return

      clearStartupReadyTimeout()
      isSophiaReadyRef.current = true
      setIsSophiaReady(true)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "sophia-ready",
        payload: {
          reason,
          voiceAgentSessionId: credentials?.sessionId ?? null,
          sessionId: sessionIdRef.current ?? null,
          ...metadata,
        },
      })
    },
    [clearStartupReadyTimeout, credentials?.sessionId],
  )

  const failVoiceStartup = useCallback(
    (name: string, payload: Record<string, unknown> = {}) => {
      errorStageLockRef.current = true
      clearThinking()
      clearStartupReadyTimeout()
      isSophiaReadyRef.current = false
      setIsSophiaReady(false)
      setError(STARTUP_READY_TIMEOUT_MESSAGE)
      setStage("error")
      setVoiceFailed(STARTUP_READY_TIMEOUT_MESSAGE)
      setListeningPresence(false)
      setSpeakingPresence(false)
      settlePresence()
      recordSophiaCaptureEvent({
        category: "voice-session",
        name,
        payload: {
          voiceAgentSessionId: credentials?.sessionId ?? null,
          sessionId: sessionIdRef.current ?? null,
          ...payload,
        },
      })
      setCredentials(null)
    },
    [
      clearStartupReadyTimeout,
      clearThinking,
      credentials?.sessionId,
      setListeningPresence,
      setSpeakingPresence,
      settlePresence,
      setVoiceFailed,
    ],
  )

  const requestCurrentVoiceDisconnect = useCallback(
    async (options: { keepalive?: boolean } = {}) => {
      const activeGeminiConnection = geminiConnectionRef.current
      if (activeGeminiConnection) {
        geminiConnectionRef.current = null
        setGeminiConnection(null)
        await activeGeminiConnection.close().catch((err) => {
          logger.warn("Gemini voice disconnect failed", {
            component: "StreamVoiceSession",
            action: "requestGeminiVoiceDisconnect",
            metadata: {
              sessionId: activeGeminiConnection.sessionId,
              keepalive: options.keepalive ?? false,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        })
      }

      const activeCredentials = credentialsRef.current
      if (!userId || !activeCredentials?.sessionId) {
        return
      }

      const requestKey = `${activeCredentials.callId}:${activeCredentials.sessionId}`
      if (disconnectRequestKeyRef.current === requestKey) {
        return
      }

      disconnectRequestKeyRef.current = requestKey

      try {
        await requestVoiceDisconnect(userId, activeCredentials, options)
      } catch (err) {
        disconnectRequestKeyRef.current = null
        logger.warn("Voice disconnect failed", {
          component: "StreamVoiceSession",
          action: "requestVoiceDisconnect",
          metadata: {
            callId: activeCredentials.callId,
            voiceAgentSessionId: activeCredentials.sessionId,
            keepalive: options.keepalive ?? false,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    },
    [userId],
  )

  const handleSophiaEvent = useCallback((
    type: string,
    data: Record<string, unknown> | undefined,
    source: SophiaVoiceEventSource,
  ) => {
    if (source === "custom" && preferSseEventsRef.current && type.startsWith("sophia.")) {
      return
    }

    if (type.startsWith("sophia.")) {
      recordSophiaCaptureEvent({
        category: source === "sse" ? "voice-sse" : "stream-custom",
        name: type,
        payload: {
          data,
          sessionId: sessionIdRef.current ?? null,
        },
      })
    }

    if (type === "sophia.transcript") {
      // When a voice command was intercepted via softBargeIn, suppress the
      // backend's response text/partial that was triggered by the command.
      if (softBargeInActiveRef.current) return

      const update = parseAssistantTranscriptUpdate(data)
      if (!update) return
      if (!shouldApplyAssistantTranscriptUpdate(update, assistantTranscriptStaleGuardRef.current)) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "stale-assistant-transcript-ignored",
          payload: {
            sourceSequence: update.sourceSequence,
            responseId: update.responseId,
            segmentId: update.segmentId,
            providerReceivedAt: update.providerReceivedAt,
            reason: "interrupted_or_pre_barge_in_assistant_transcript",
            sessionId: sessionIdRef.current ?? null,
          },
        })
        return
      }

      if (geminiConnectionRef.current) {
        setRuntimeTelemetry((current) => current.runtime === "gemini_live"
          ? {
              ...current,
              assistantTranscriptSource: update.assistantTranscriptSource ?? current.assistantTranscriptSource ?? null,
              assistantTranscriptFinalSeen: current.assistantTranscriptFinalSeen === true || update.isFinal,
              assistantTranscriptApproximate: update.assistantTranscriptApproximate ?? current.assistantTranscriptApproximate ?? null,
              assistantTranscriptSessionId: sessionIdRef.current ?? current.assistantTranscriptSessionId ?? null,
            }
          : current)
        if (!shouldApplyGeminiOpeningGreetingUpdate(update)) {
          setPartialReply("")
          return
        }
      }

      const handlers = {
        setFinalReply,
        setPartialReply,
        addVoiceMessage,
        onAssistantResponse: onAssistantResponseRef.current,
      }

      if (geminiConnectionRef.current) {
        applyPacedAssistantTranscriptUpdate(update, handlers, assistantTranscriptPacingRef.current, {
          minInitialCharacters: 16,
          minCharacterDelta: 16,
          minIntervalMs: 120,
          maxIntervalMs: 360,
        })
      } else {
        applyAssistantTranscriptUpdate(update, handlers)
      }
    }

    if (type === "sophia.user_transcript") {
      const timestamp = new Date().toISOString()
      if (geminiConnectionRef.current) {
        setRuntimeTelemetry((current) => current.runtime === "gemini_live"
          ? applyGeminiTranscriptReadiness(current, {
              publicUserTranscriptCount: (current.publicUserTranscriptCount ?? 0) + 1,
              firstPublicUserTranscriptAt: current.firstPublicUserTranscriptAt ?? timestamp,
              reviewPublicTranscriptObserved: true,
            })
          : current)
      }
      applyUserTranscriptData(data, "public_user_transcript")
    }

    if (type === "sophia.artifact" && data) {
      onArtifactsRef.current?.(data)
    }

    if (type === "sophia.builder_task" && data) {
      onBuilderTaskRef.current?.(data)
    }

    if (type === "sophia.turn") {
      const phase = typeof data?.phase === "string"
        ? data.phase
        : data?.status === "started"
          ? "agent_started"
          : data?.status === "completed"
            ? "agent_ended"
            : null

      if (phase === "agent_started") {
        if (softBargeInActiveRef.current) {
          // Voice command intercepted this turn — don't transition to speaking.
          return
        }
        markAssistantTranscriptGenerationStarted(assistantTranscriptStaleGuardRef.current)
        clearThinking()
        setStage("speaking")
        setListeningPresence(false)
        setSpeakingPresence(true)
        setMetaPresence("speaking")
      } else if (phase === "agent_ended") {
        softBargeInActiveRef.current = false
        clearCurrentTurnUserTranscript()
        setStage("listening")
        setSpeakingPresence(false)
        setListeningPresence(true)
        setMetaPresence("listening")
      } else if (phase === "user_ended") {
        softBargeInActiveRef.current = false
        setStage("thinking")
        setListeningPresence(false)
        setSpeakingPresence(false)
        setMetaPresence("thinking")
        startThinkingTimeout()
      }
    }
  }, [addVoiceMessage, applyUserTranscriptData, clearCurrentTurnUserTranscript, clearThinking, shouldApplyGeminiOpeningGreetingUpdate, startThinkingTimeout, setListeningPresence, setSpeakingPresence, setMetaPresence])

  // --- Map CallingState → VoiceStage (only on actual changes) -------------
  useEffect(() => {
    if (geminiConnection) return

    if (
      callingState === prevCallingStateRef.current
      && isSophiaReady === prevSophiaReadyRef.current
    ) return

    prevCallingStateRef.current = callingState
    prevSophiaReadyRef.current = isSophiaReady

    const mapped = callingStateToVoiceStage(
      callingState,
      isSophiaReady,
      Boolean(credentials),
    )
    setStage((currentStage) => {
      if (errorStageLockRef.current && currentStage === "error") {
        return currentStage
      }

      if (
        callingState === CallingState.JOINED
        && isSophiaReady
        && (currentStage === "speaking" || currentStage === "thinking")
      ) {
        return currentStage
      }

      return mapped
    })
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "calling-state-changed",
      payload: {
        callingState,
        mappedStage: mapped,
        isSophiaReady,
        sessionId: sessionIdRef.current ?? null,
      },
    })

    if (errorStageLockRef.current) return

    // Update presence to match
    if (mapped === "listening") {
      setListeningPresence(true)
      setSpeakingPresence(false)
      setMetaPresence("listening")
    } else if (mapped === "connecting") {
      setListeningPresence(false)
      setSpeakingPresence(false)
      setMetaPresence("connecting")
    } else if (mapped === "idle") {
      setListeningPresence(false)
      setSpeakingPresence(false)
      settlePresence()
    }
  }, [
    callingState,
    credentials,
    geminiConnection,
    isSophiaReady,
    setListeningPresence,
    setMetaPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  // --- Startup readiness detection ----------------------------------------
  useEffect(() => {
    if (callingState !== CallingState.JOINED) return

    const voiceAgentSessionId = credentials?.sessionId
    const hasRemoteParticipant = remoteParticipantSessionIds.length > 0
    if (!hasRemoteParticipant) return

    markSophiaReady("remote-participant", {
      matchedExpectedSession: voiceAgentSessionId
        ? remoteParticipantSessionIds.includes(voiceAgentSessionId)
        : false,
      remoteParticipantCount: remoteParticipantSessionIds.length,
    })
  }, [
    callingState,
    credentials?.sessionId,
    markSophiaReady,
    remoteParticipantSessionIds,
  ])

  useEffect(() => {
    if (!credentials?.sessionId || isSophiaReady) {
      clearStartupReadyTimeout()
      return
    }

    if (callingState === CallingState.IDLE || callingState === CallingState.LEFT) {
      clearStartupReadyTimeout()
      return
    }

    if (startupReadyTimeoutRef.current) return

    startupReadyTimeoutRef.current = setTimeout(() => {
      if (destroyedRef.current || isSophiaReadyRef.current) return

      logger.warn("Voice startup timed out waiting for Sophia readiness", {
        component: "StreamVoiceSession",
        action: "startTalking",
        metadata: {
          callId: credentials.callId,
          voiceAgentSessionId: credentials.sessionId,
        },
      })
      failVoiceStartup("startup-ready-timeout", {
        callId: credentials.callId,
        callType: credentials.callType,
      })
    }, STARTUP_READY_TIMEOUT_MS)

    return clearStartupReadyTimeout
  }, [
    callingState,
    clearStartupReadyTimeout,
    credentials?.callId,
    credentials?.callType,
    credentials?.sessionId,
    failVoiceStartup,
    isSophiaReady,
  ])

  // --- Stream error forwarding ---------------------------------------------
  useEffect(() => {
    if (streamError) {
      clearStartupReadyTimeout()
      setStage("error")
      setError(streamError)
      setVoiceFailed(streamError)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "stream-error",
        payload: {
          error: streamError,
          sessionId: sessionIdRef.current ?? null,
        },
      })
    }
  }, [clearStartupReadyTimeout, setVoiceFailed, streamError])

  // --- Stream custom event fallback ---------------------------------------
  useEffect(() => {
    if (!call || callingState !== CallingState.JOINED) return
    if (credentials?.streamUrl && typeof EventSource === "function") return

    const handleCustomEvent = (event: { type: string; custom: Record<string, unknown> }) => {
      const eventType = typeof event.custom?.type === "string" ? event.custom.type : null
      if (!eventType) return

      handleSophiaEvent(
        eventType,
        event.custom.data as Record<string, unknown> | undefined,
        "custom",
      )
    }

    const unsubscribe = call.on("custom", handleCustomEvent as Parameters<typeof call.on>[1])

    return () => {
      unsubscribe()
    }
  }, [call, callingState, credentials?.streamUrl, handleSophiaEvent])

  const activeEventStreamUrl = credentials?.streamUrl ?? geminiConnection?.streamUrl ?? null
  const activeEventStreamSessionId = credentials?.sessionId ?? geminiConnection?.sessionId ?? null
  const activeEventStreamRuntime: SessionRuntime = geminiConnection?.sessionId === activeEventStreamSessionId
    ? "gemini_live"
    : "legacy_cascade"

  useEffect(() => {
    if (!activeEventStreamUrl || !activeEventStreamSessionId) {
      closeEventSource()
      return
    }

    if (typeof EventSource !== "function") {
      return
    }

    const eventSource = new EventSource(activeEventStreamUrl)
    eventSourceRef.current = eventSource
    if (activeEventStreamRuntime === "gemini_live") {
      setRuntimeTelemetry((current) => current.runtime === "gemini_live"
        ? { ...current, publicSseState: "connecting" }
        : current)
    }

    const handleOpen = () => {
      if (eventSourceRef.current !== eventSource) return

      preferSseEventsRef.current = true
      if (activeEventStreamRuntime === "gemini_live") {
        setRuntimeTelemetry((current) => current.runtime === "gemini_live"
          ? { ...current, publicSseState: "connected" }
          : current)
      }
      recordSophiaCaptureEvent({
        category: "voice-sse",
        name: "stream-open",
        payload: {
          runtime: activeEventStreamRuntime,
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: activeEventStreamSessionId,
          streamUrl: activeEventStreamUrl,
        },
      })
    }
    const handleError = () => {
      if (eventSourceRef.current !== eventSource) return

      if (activeEventStreamRuntime === "gemini_live") {
        setRuntimeTelemetry((current) => current.runtime === "gemini_live"
          ? { ...current, publicSseState: "error" }
          : current)
      }
      recordSophiaCaptureEvent({
        category: "voice-sse",
        name: "stream-error",
        payload: {
          runtime: activeEventStreamRuntime,
          readyState: eventSource.readyState,
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: activeEventStreamSessionId,
        },
      })

      if (eventSource.readyState === EventSource.CLOSED) {
        preferSseEventsRef.current = false
        eventSource.close()
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null
        }
      }
    }

    const eventTypes = [
      "sophia.transcript",
      "sophia.user_transcript",
      "sophia.artifact",
      "sophia.builder_task",
      "sophia.turn",
      "sophia.turn_diagnostic",
    ] as const

    const eventListeners = eventTypes.map((eventType) => {
      const listener = (event: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(event.data) as {
            type?: string
            data?: Record<string, unknown>
          }
          if (typeof parsed.type !== "string") return

          handleSophiaEvent(parsed.type, parsed.data, "sse")
        } catch {
          recordSophiaCaptureEvent({
            category: "voice-sse",
            name: "invalid-event-payload",
            payload: {
              eventType,
              sessionId: sessionIdRef.current ?? null,
            },
          })
        }
      }

      eventSource.addEventListener(eventType, listener as EventListener)
      return { eventType, listener }
    })

    eventSource.addEventListener("open", handleOpen)
    eventSource.addEventListener("error", handleError)

    return () => {
      for (const { eventType, listener } of eventListeners) {
        eventSource.removeEventListener(eventType, listener as EventListener)
      }
      eventSource.removeEventListener("open", handleOpen)
      eventSource.removeEventListener("error", handleError)

      if (eventSourceRef.current === eventSource) {
        preferSseEventsRef.current = false
        eventSourceRef.current = null
      }

      eventSource.close()
    }
  }, [activeEventStreamRuntime, activeEventStreamSessionId, activeEventStreamUrl, closeEventSource, handleSophiaEvent])

  useEffect(() => {
    if (!userId) {
      autoPreconnectEnabledRef.current = true
      clearAutoPreconnectTimer()
      connectPrewarmAttemptedUserIdRef.current = null
      connectPrewarmPromiseRef.current = null
      connectPrewarmControllerRef.current?.abort()
      connectPrewarmControllerRef.current = null
      clearPreparedVoiceConnectRefs()
      return
    }

    void prewarmVoiceConnect()
  }, [clearAutoPreconnectTimer, clearPreparedVoiceConnectRefs, prewarmVoiceConnect, userId])

  const activeCallId = credentials?.callId ?? null
  const activeVoiceAgentSessionId = credentials?.sessionId ?? null

  useEffect(() => {
    if (!credentials || !call || callingState !== CallingState.IDLE) {
      return
    }

    logger.debug("StreamVoiceSession", "Auto-joining Stream voice call", {
      callId: credentials.callId,
      voiceAgentSessionId: credentials.sessionId ?? null,
    })
    void join()
  }, [call, callingState, credentials, join])

  useEffect(() => {
    if (!activeCallId || !activeVoiceAgentSessionId) {
      return
    }

    scheduleBackendWarmup(credentials)
  }, [activeCallId, activeVoiceAgentSessionId, credentials, scheduleBackendWarmup])

  useEffect(() => {
    if (
      !userId
      || !autoPreconnectEnabledRef.current
      || Boolean(credentials)
      || callingState !== CallingState.IDLE
      || startInFlightRef.current
    ) {
      return
    }

    clearAutoPreconnectTimer()
    autoPreconnectTimerRef.current = setTimeout(() => {
      autoPreconnectTimerRef.current = null

      if (
        !autoPreconnectEnabledRef.current
        || destroyedRef.current
        || credentialsRef.current
        || startInFlightRef.current
      ) {
        return
      }

      void preconnectVoiceSession()
    }, AUTO_PRECONNECT_DELAY_MS)

    return () => {
      clearAutoPreconnectTimer()
    }
  }, [callingState, clearAutoPreconnectTimer, credentials, platform, preconnectEnabled, preconnectVoiceSession, userId])

  // --- Actions -------------------------------------------------------------

  const startTalking = useCallback(async () => {
    if (!userId) {
      setError("No user ID")
      setStage("error")
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "start-talking-rejected",
        payload: {
          reason: "missing-user-id",
          sessionId: sessionIdRef.current ?? null,
        },
      })
      return
    }

    if (startInFlightRef.current || callingState === CallingState.JOINING || geminiConnectionRef.current) {
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "start-talking-ignored",
        payload: {
          reason: "duplicate-connect",
          sessionId: sessionIdRef.current ?? null,
        },
      })
      return
    }

    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()

    const requestVersion = startRequestVersionRef.current + 1
    const controller = new AbortController()

    startRequestVersionRef.current = requestVersion
    pendingStartControllerRef.current = controller
    startInFlightRef.current = true

    errorStageLockRef.current = false
    closeEventSource()
    clearStartupReadyTimeout()
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    recentBargeInTranscriptFingerprintsRef.current = []
    currentTurnUserTranscriptRef.current = null
    userMicMutedRef.current = false
    setIsSophiaReady(false)
    setStage("connecting")
    setError(undefined)
    setIsMuted(false)
    setPartialReply("")
    setFinalReply("")
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "start-talking-requested",
      payload: {
        userId,
        platform,
        sessionId: sessionIdRef.current ?? null,
      },
    })

    try {
      let creds: VoiceConnectCredentials | null = await consumePreparedVoiceConnect()

      if (connectPrewarmPromiseRef.current !== null) {
        await connectPrewarmPromiseRef.current
      }

      if (!creds) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "preconnect-miss",
          payload: {
            preconnectStatus: "miss",
            sessionId: sessionIdRef.current ?? null,
          },
        })
        logger.debug("StreamVoiceSession", "Fetching credentials", {
          userId,
          platform,
          contextMode,
          ritual: voiceRitual,
        })
        creds = await fetchStreamCredentials(
          userId,
          platform,
          contextMode,
          voiceRitual,
          sessionId,
          threadId,
          controller.signal,
        )
      } else {
        logger.debug("StreamVoiceSession", "Using prefetched voice credentials", {
          userId,
          callId: voiceCredentialsCallId(creds),
          voiceAgentSessionId: voiceCredentialsSessionId(creds),
        })
      }

      const voiceRuntimeSessionId = isGeminiProductionCredentials(creds)
        ? creds.session_id
        : creds.sessionId ?? null
      const voiceRuntimeCallId = isGeminiProductionCredentials(creds)
        ? creds.session_id
        : creds.callId
      const voiceRuntimeCallType = isGeminiProductionCredentials(creds)
        ? "gemini_live"
        : creds.callType

      if (destroyedRef.current || startRequestVersionRef.current !== requestVersion) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "stale-connect-response",
          payload: {
            destroyed: destroyedRef.current,
            requestVersion,
            currentRequestVersion: startRequestVersionRef.current,
            callId: voiceRuntimeCallId,
            callType: voiceRuntimeCallType,
            voiceAgentSessionId: voiceRuntimeSessionId,
            sessionId: sessionIdRef.current ?? null,
          },
        })
        if (isGeminiProductionCredentials(creds)) {
          await requestGeminiBootstrapDisconnect(creds)
        } else if (creds.sessionId) {
          try {
            await requestVoiceDisconnect(userId, creds)
          } catch {
            // Best-effort cleanup for stale connect responses.
          }
        }
        return
      }

      if (isGeminiProductionCredentials(creds)) {
        logger.debug("StreamVoiceSession", "Starting Gemini production voice runtime", {
          userId,
          voiceAgentSessionId: creds.session_id,
        })
        resetAssistantTranscriptPacingState(assistantTranscriptPacingRef.current)
        resetAssistantTranscriptStaleGuardState(assistantTranscriptStaleGuardRef.current)
        resetGeminiOpeningGreetingLatch(creds.session_id)

        setRuntimeTelemetry(createGeminiRuntimeTelemetry({
          source: "voice-connect",
          sessionId: creds.session_id,
          streamUrl: creds.stream_url,
          relayUrl:
            typeof creds.provider_event_relay_url === "string"
              ? creds.provider_event_relay_url
              : null,
          publicSseState: "connecting",
        }))
        const coreviewDiagnostics = coreviewFlagDiagnostics()
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "credentials-received",
          payload: {
            callId: creds.session_id,
            callType: "gemini_live",
            runtime: "gemini_live",
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: creds.session_id,
            ...coreviewDiagnostics,
            backendCoreviewFlagParsed: typeof creds.backendCoreviewFlagParsed === "boolean" ? creds.backendCoreviewFlagParsed : null,
            backendStillFrameFlagParsed: typeof creds.backendStillFrameFlagParsed === "boolean" ? creds.backendStillFrameFlagParsed : null,
          },
        })
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "coreview-flag-diagnostics",
          payload: {
            runtime: "gemini_live",
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: creds.session_id,
            ...coreviewDiagnostics,
            backendCoreviewFlagParsed: typeof creds.backendCoreviewFlagParsed === "boolean" ? creds.backendCoreviewFlagParsed : null,
            backendStillFrameFlagParsed: typeof creds.backendStillFrameFlagParsed === "boolean" ? creds.backendStillFrameFlagParsed : null,
          },
        })

        const connection = await connectGeminiBrowserLiveFromBootstrap({
          userId,
          sessionId: creds.session_id,
          threadId: threadId ?? null,
          bootstrap: creds,
          onStage: (geminiStage) => {
            const stageTelemetry = geminiStageTelemetry(geminiStage)
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? { ...current, stage: geminiStage, ...stageTelemetry }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-stage-changed",
              payload: {
                runtime: "gemini_live",
                stage: geminiStage,
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                ...stageTelemetry,
              },
            })
            if (geminiStage === "requesting_microphone" || geminiStage === "opening_websocket") {
              setStage("connecting")
            }
            if (geminiStage === "connected" || geminiStage === "streaming_audio") {
              setStage(userMicMutedRef.current ? "idle" : "listening")
            }
          },
          onOutputAudio: () => {
            const timestamp = new Date().toISOString()
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  remoteAudioState: "active",
                  outputAudioEventCount: current.outputAudioEventCount + 1,
                  lastOutputAudioAt: timestamp,
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-output-audio-started",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                timestamp,
              },
            })
            if (!softBargeInActiveRef.current) {
              setStage("speaking")
              setListeningPresence(false)
              setSpeakingPresence(true)
              setMetaPresence("speaking")
            }
          },
          onOutputAudioChunk: (diagnostic) => {
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-output-audio-chunk",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onInputAudioActivity: (diagnostic) => {
            if (diagnostic.eventType === "input_audio_frame_sent" && diagnostic.bargeInConfirmed === true) {
              const interruptedKeys = markAssistantTranscriptUserInputStarted(assistantTranscriptStaleGuardRef.current)
              if (interruptedKeys.length > 0) {
                resetAssistantTranscriptPacingState(assistantTranscriptPacingRef.current)
                setPartialReply("")
              }
            }
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? applyGeminiTranscriptReadiness(current, {
                  userInputActiveAgeMs: diagnostic.userInputActiveAgeMs ?? current.userInputActiveAgeMs ?? null,
                  bargeInConfirmed: current.bargeInConfirmed === true || diagnostic.bargeInConfirmed === true,
                  bargeInConfirmationSource: diagnostic.bargeInConfirmationSource ?? current.bargeInConfirmationSource ?? "none",
                  bargeInConfirmationReason: diagnostic.bargeInConfirmationReason ?? current.bargeInConfirmationReason ?? null,
                  bargeInCandidateFrameCount: Math.max(current.bargeInCandidateFrameCount ?? 0, diagnostic.bargeInCandidateFrameCount ?? 0),
                  inputFrameOnlyNotBargeInCount: Math.max(current.inputFrameOnlyNotBargeInCount ?? 0, diagnostic.inputFrameOnlyNotBargeInCount ?? 0),
                  candidateFramesDidNotConfirmCount: Math.max(current.candidateFramesDidNotConfirmCount ?? 0, diagnostic.candidateFramesDidNotConfirmCount ?? 0),
                  candidateExpiredCount: Math.max(current.candidateExpiredCount ?? 0, diagnostic.candidateExpiredCount ?? 0),
                  suppressionBlockedBecauseNoIntentCount: Math.max(current.suppressionBlockedBecauseNoIntentCount ?? 0, diagnostic.suppressionBlockedBecauseNoIntentCount ?? 0),
                  staleSuppressionArmedAt: diagnostic.staleSuppressionArmedAt ?? current.staleSuppressionArmedAt ?? null,
                  rawAssistantUserOverlapMs: Math.max(current.rawAssistantUserOverlapMs ?? current.assistantUserOverlapMs ?? 0, diagnostic.rawAssistantUserOverlapMs ?? 0),
                  maxRawAssistantUserOverlapMs: Math.max(current.maxRawAssistantUserOverlapMs ?? current.rawAssistantUserOverlapMs ?? current.assistantUserOverlapMs ?? 0, diagnostic.rawAssistantUserOverlapMs ?? 0),
                  confirmedAssistantUserOverlapMs: Math.max(current.confirmedAssistantUserOverlapMs ?? 0, diagnostic.confirmedAssistantUserOverlapMs ?? 0),
                  maxConfirmedAssistantUserOverlapMs: Math.max(current.maxConfirmedAssistantUserOverlapMs ?? current.confirmedAssistantUserOverlapMs ?? 0, diagnostic.confirmedAssistantUserOverlapMs ?? 0),
                  reviewMicAudioDetected: current.reviewMicAudioDetected === true || diagnostic.eventType === "input_audio_frame_sent",
                  reviewUserSpeechDetected: current.reviewUserSpeechDetected === true || diagnostic.eventType === "input_audio_frame_sent",
                })
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-input-audio-activity",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onBargeInTranscriptHandoff: (diagnostic) => {
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  bargeInTranscriptCapturedCount: Math.max(current.bargeInTranscriptCapturedCount ?? 0, diagnostic.bargeInTranscriptCapturedCount),
                  bargeInTranscriptPromotedCount: Math.max(current.bargeInTranscriptPromotedCount ?? 0, diagnostic.bargeInTranscriptPromotedCount),
                  bargeInTranscriptPromotionLatencyMs: diagnostic.bargeInTranscriptPromotionLatencyMs ?? current.bargeInTranscriptPromotionLatencyMs ?? null,
                  bargeInTranscriptIgnoredCount: Math.max(current.bargeInTranscriptIgnoredCount ?? 0, diagnostic.bargeInTranscriptIgnoredCount),
                  bargeInTranscriptDuplicateSuppressedCount: Math.max(current.bargeInTranscriptDuplicateSuppressedCount ?? 0, diagnostic.bargeInTranscriptDuplicateSuppressedCount),
                  lastBargeInTranscriptPreview: diagnostic.lastBargeInTranscriptPreview ?? current.lastBargeInTranscriptPreview ?? null,
                  bargeInNewTurnDispatchCount: Math.max(current.bargeInNewTurnDispatchCount ?? 0, diagnostic.bargeInNewTurnDispatchCount),
                  bargeInNewTurnDispatchBlockedReason: diagnostic.bargeInNewTurnDispatchBlockedReason ?? current.bargeInNewTurnDispatchBlockedReason ?? "none",
                  bargeInConfirmed: current.bargeInConfirmed === true || diagnostic.captured,
                  bargeInConfirmationSource: diagnostic.bargeInConfirmationSource ?? current.bargeInConfirmationSource ?? "none",
                  bargeInConfirmationReason: diagnostic.bargeInConfirmationReason ?? current.bargeInConfirmationReason ?? null,
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-barge-in-transcript-handoff",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic: sanitizedBargeInTranscriptDiagnostic(diagnostic),
              },
            })

            if (!diagnostic.promoted || !diagnostic.text) {
              return
            }

            const userTranscriptData = publicBargeInTranscriptData(diagnostic)
            if (!userTranscriptData) return
            const applied = applyUserTranscriptData(userTranscriptData, "barge_in_transcript_handoff")
            if (!applied) return
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? applyGeminiTranscriptReadiness(current, {
                  publicUserTranscriptCount: (current.publicUserTranscriptCount ?? 0) + 1,
                  firstPublicUserTranscriptAt: current.firstPublicUserTranscriptAt ?? diagnostic.timestamp,
                  reviewPublicTranscriptObserved: true,
                })
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "sophia.user_transcript",
              payload: {
                data: userTranscriptData,
                source: "barge_in_transcript_handoff",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
              },
            })
          },
          onInterruption: (diagnostic) => {
            resetAssistantTranscriptPacingState(assistantTranscriptPacingRef.current)
            markActiveAssistantTranscriptInterrupted(assistantTranscriptStaleGuardRef.current, { atMs: Date.parse(diagnostic.timestamp) })
            setPartialReply("")
            setStage(userMicMutedRef.current ? "idle" : "listening")
            setSpeakingPresence(false)
            setListeningPresence(!userMicMutedRef.current)
            setMetaPresence(userMicMutedRef.current ? "resting" : "listening")
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  remoteAudioState: "idle",
                  interruptionCount: current.interruptionCount + 1,
                  playbackFlushCount: current.playbackFlushCount + (diagnostic.playbackFlushed ? 1 : 0),
                  lastInterruptionAt: diagnostic.timestamp,
                  lastPlaybackFlushAt: diagnostic.playbackFlushed ? diagnostic.timestamp : current.lastPlaybackFlushAt,
                  playbackGeneration: diagnostic.playbackStateAfter.playbackGeneration,
                  interruptedResponseIds: diagnostic.interruptedResponseIds,
                  assistantUserOverlapMs: Math.max(current.assistantUserOverlapMs, diagnostic.assistantUserOverlapMs),
                  rawAssistantUserOverlapMs: Math.max(current.rawAssistantUserOverlapMs ?? current.assistantUserOverlapMs, diagnostic.rawAssistantUserOverlapMs),
                  maxRawAssistantUserOverlapMs: Math.max(current.maxRawAssistantUserOverlapMs ?? current.rawAssistantUserOverlapMs ?? current.assistantUserOverlapMs, diagnostic.rawAssistantUserOverlapMs),
                  confirmedAssistantUserOverlapMs: Math.max(current.confirmedAssistantUserOverlapMs ?? 0, diagnostic.confirmedAssistantUserOverlapMs),
                  maxConfirmedAssistantUserOverlapMs: Math.max(current.maxConfirmedAssistantUserOverlapMs ?? current.confirmedAssistantUserOverlapMs ?? 0, diagnostic.confirmedAssistantUserOverlapMs),
                  bargeInConfirmed: true,
                  bargeInConfirmationSource: diagnostic.bargeInConfirmationSource,
                  bargeInConfirmationReason: diagnostic.bargeInConfirmationReason,
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-interruption",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onStaleOutputSuppression: (diagnostic) => {
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  staleAssistantAudioDroppedCount: diagnostic.outputType === "audio"
                    ? current.staleAssistantAudioDroppedCount + 1
                    : current.staleAssistantAudioDroppedCount,
                  staleAssistantTranscriptDroppedCount: diagnostic.outputType === "transcript"
                    ? current.staleAssistantTranscriptDroppedCount + 1
                    : current.staleAssistantTranscriptDroppedCount,
                  staleAssistantOutputSuppressionCount: current.staleAssistantOutputSuppressionCount + 1,
                  playbackGeneration: diagnostic.playbackGeneration ?? current.playbackGeneration,
                  interruptedResponseIds: diagnostic.interruptedResponseIds,
                  userInputActiveAgeMs: diagnostic.userInputActiveAgeMs ?? current.userInputActiveAgeMs ?? null,
                  bargeInConfirmed: current.bargeInConfirmed === true || diagnostic.bargeInConfirmed === true,
                  bargeInConfirmationSource: diagnostic.bargeInConfirmationSource ?? current.bargeInConfirmationSource ?? "none",
                  bargeInConfirmationReason: diagnostic.bargeInConfirmationReason ?? current.bargeInConfirmationReason ?? null,
                  bargeInCandidateFrameCount: Math.max(current.bargeInCandidateFrameCount ?? 0, diagnostic.bargeInCandidateFrameCount ?? 0),
                  inputFrameOnlyNotBargeInCount: Math.max(current.inputFrameOnlyNotBargeInCount ?? 0, diagnostic.inputFrameOnlyNotBargeInCount ?? 0),
                  candidateFramesDidNotConfirmCount: Math.max(current.candidateFramesDidNotConfirmCount ?? 0, diagnostic.candidateFramesDidNotConfirmCount ?? 0),
                  candidateExpiredCount: Math.max(current.candidateExpiredCount ?? 0, diagnostic.candidateExpiredCount ?? 0),
                  suppressionBlockedBecauseNoIntentCount: Math.max(current.suppressionBlockedBecauseNoIntentCount ?? 0, diagnostic.suppressionBlockedBecauseNoIntentCount ?? 0),
                  staleSuppressionArmedAt: diagnostic.staleSuppressionArmedAt ?? current.staleSuppressionArmedAt ?? null,
                  staleSuppressionArmedBy: diagnostic.staleSuppressionArmedBy ?? current.staleSuppressionArmedBy ?? null,
                  assistantAudioDropReason: diagnostic.assistantAudioDropReason ?? current.assistantAudioDropReason ?? null,
                  rawAssistantUserOverlapMs: Math.max(current.rawAssistantUserOverlapMs ?? current.assistantUserOverlapMs ?? 0, diagnostic.rawAssistantUserOverlapMs),
                  maxRawAssistantUserOverlapMs: Math.max(current.maxRawAssistantUserOverlapMs ?? current.rawAssistantUserOverlapMs ?? current.assistantUserOverlapMs ?? 0, diagnostic.rawAssistantUserOverlapMs),
                  confirmedAssistantUserOverlapMs: Math.max(current.confirmedAssistantUserOverlapMs ?? 0, diagnostic.confirmedAssistantUserOverlapMs),
                  maxConfirmedAssistantUserOverlapMs: Math.max(current.maxConfirmedAssistantUserOverlapMs ?? current.confirmedAssistantUserOverlapMs ?? 0, diagnostic.confirmedAssistantUserOverlapMs),
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-stale-output-suppressed",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onRelayStatus: (relayStatus) => {
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? { ...current, relayStatus: relayStatus as GeminiRuntimeRelayStatus }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-relay-status",
              payload: {
                runtime: "gemini_live",
                relayStatus,
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
              },
            })
          },
          onProviderEvent: (event) => {
            const timestamp = new Date().toISOString()
            const eventType = describeProviderEventType(event)
            const setupComplete = eventType === "setupComplete" || eventType === "setup_complete"
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  providerEventCount: current.providerEventCount + 1,
                  lastProviderEventAt: timestamp,
                  lastProviderEventType: eventType,
                  setupComplete: current.setupComplete || setupComplete,
                  websocketState: setupComplete ? "setup_complete" : current.websocketState,
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-provider-event",
              payload: {
                runtime: "gemini_live",
                eventType,
                setupComplete,
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                timestamp,
              },
            })
          },
          onProviderEventTelemetry: (telemetry) => {
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? applyGeminiTranscriptReadiness(current, {
                  providerCategoryCounts: telemetry.categoryCounts,
                  relayClassificationCounts: telemetry.relayClassificationCounts,
                  providerInputTranscriptCount: telemetry.categoryCounts.inputTranscription?.count ?? current.providerInputTranscriptCount ?? 0,
                  firstProviderTranscriptAt: (
                    telemetry.hasInputTranscriptionText
                      ? current.firstProviderTranscriptAt ?? telemetry.timestamp
                      : current.firstProviderTranscriptAt ?? null
                  ),
                  reviewProviderTranscriptObserved: current.reviewProviderTranscriptObserved === true || telemetry.hasInputTranscriptionText,
                })
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-provider-event-correlation",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                telemetry,
              },
            })
          },
          onRelayTrace: (trace) => {
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? (() => {
                  const isTranscription = trace.categories.includes("inputTranscription") || trace.categories.includes("outputTranscription")
                  const isTool = trace.categories.includes("toolCall") || trace.categories.includes("toolCallCancellation")
                  return {
                    ...current,
                    relayAttemptCount: trace.attemptCount,
                    relaySuccessCount: trace.successCount,
                    relayFailureCount: trace.failureCount,
                    relayTraceCount: current.relayTraceCount + 1,
                    lastRelayTraceAt: trace.timestamp,
                    lastRelayCorrelationId: trace.correlationId,
                    lastRelayResponseKind: trace.responseKind,
                    lastRelayDurationMs: trace.durationMs,
                    maxRelayDurationMs: Math.max(current.maxRelayDurationMs ?? 0, trace.durationMs),
                    lastCriticalRelayDurationMs: trace.relayClassification === "critical" ? trace.durationMs : current.lastCriticalRelayDurationMs,
                    lastTranscriptionRelayDurationMs: isTranscription ? trace.durationMs : current.lastTranscriptionRelayDurationMs,
                    lastToolCallRelayDurationMs: isTool ? trace.durationMs : current.lastToolCallRelayDurationMs,
                    orderedRelayQueueDepth: trace.throughput.orderedRelayQueueDepth,
                    oldestQueuedAgeMs: trace.throughput.oldestQueuedAgeMs,
                    transcriptPartialsCoalesced: trace.throughput.transcriptPartialsCoalesced,
                    transcriptPartialsSent: trace.throughput.transcriptPartialsSent,
                    transcriptPartialsDropped: trace.throughput.transcriptPartialsDropped,
                    transcriptCoalescingDisabledReason: trace.throughput.transcriptCoalescingDisabledReason,
                    finalTranscriptEventsSent: trace.throughput.finalTranscriptEventsSent,
                    nonDroppableCriticalEventsSent: trace.throughput.nonDroppableCriticalEventsSent,
                    lastTranscriptRelayLatencyMs: trace.throughput.lastTranscriptRelayLatencyMs,
                    maxTranscriptRelayLatencyMs: trace.throughput.maxTranscriptRelayLatencyMs,
                    p95TranscriptRelayLatencyMs: trace.throughput.p95TranscriptRelayLatencyMs,
                    coalescedBySegment: trace.throughput.coalescedBySegment,
                    lastRelayEventType: String(trace.eventCategory),
                    lastRelayErrorText: trace.errorText ?? current.lastRelayErrorText,
                  }
                })()
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-relay-trace",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                trace,
              },
            })
          },
          onRelayCoalescingDiagnostic: (diagnostic) => {
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  orderedRelayQueueDepth: diagnostic.metrics.orderedRelayQueueDepth,
                  oldestQueuedAgeMs: diagnostic.metrics.oldestQueuedAgeMs,
                  transcriptPartialsCoalesced: diagnostic.metrics.transcriptPartialsCoalesced,
                  transcriptPartialsDropped: diagnostic.metrics.transcriptPartialsDropped,
                  transcriptCoalescingDisabledReason: diagnostic.metrics.transcriptCoalescingDisabledReason,
                  coalescedBySegment: diagnostic.metrics.coalescedBySegment,
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-transcript-partial-coalesced",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onToolCallLedgerUpdate: (entry) => {
            setRuntimeTelemetry((current) => {
              if (current.runtime !== "gemini_live") {
                return current
              }
              const withoutCurrent = current.toolCallLedger.filter((candidate) => candidate.toolCallId !== entry.toolCallId)
              return {
                ...current,
                toolCallLedger: [...withoutCurrent, entry].slice(-25),
              }
            })
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-tool-call-ledger",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                entry,
              },
            })
          },
          onRelayDiagnostic: (diagnostic) => {
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  relayDiagnosticCount: current.relayDiagnosticCount + 1,
                  lastRelayDiagnosticAt: diagnostic.timestamp,
                  lastRelayEventType: diagnostic.eventType,
                  consecutiveRelayFailures: diagnostic.consecutiveFailures,
                  lastRelayErrorText: diagnostic.errorText,
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-relay-diagnostic",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onWebSocketDiagnostic: (diagnostic) => {
            const websocketState = diagnostic.kind === "error" ? "error" : "closed"
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? {
                  ...current,
                  websocketDiagnosticCount: current.websocketDiagnosticCount + 1,
                  lastWebSocketDiagnosticAt: diagnostic.timestamp,
                  lastWebSocketErrorText: diagnostic.message,
                  lastWebSocketCloseCode: diagnostic.kind === "close" ? diagnostic.closeCode : current.lastWebSocketCloseCode,
                  lastWebSocketCloseReasonSafe: diagnostic.kind === "close" ? diagnostic.closeReason : current.lastWebSocketCloseReasonSafe,
                  lastWebSocketCloseWasClean: diagnostic.kind === "close" ? diagnostic.wasClean : current.lastWebSocketCloseWasClean,
                  websocketState: websocketState as GeminiRuntimeWebSocketState,
                }
              : current)
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-websocket-diagnostic",
              payload: {
                runtime: "gemini_live",
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onToolLoopDiagnostic: (diagnostic) => {
            setRuntimeTelemetry((current) => {
              if (current.runtime !== "gemini_live") {
                return current
              }

              const toolName = diagnostic.toolCall.name
              const isToolCallReceived = diagnostic.phase === "tool_call_received"
              const backendStatus = typeof diagnostic.backendResponse?.status === "string"
                ? diagnostic.backendResponse.status
                : diagnostic.success === true
                  ? "success"
                  : null
              const reviewToolTimedOut = diagnostic.reviewToolTimedOut === true
                || diagnostic.backendResponse?.review_tool_timed_out === true
              const reviewToolTimeoutResultSent = diagnostic.reviewToolTimeoutResultSent === true
                || diagnostic.backendResponse?.review_tool_timeout_result_sent === true
              const readArtifactTextResolved = toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME
                && (
                  diagnostic.phase === "tool_response_sent"
                  || diagnostic.phase === "tool_execution_rejected"
                  || diagnostic.phase === "tool_response_send_suppressed"
                )
              const coreviewGetCurrentViewResponse = toolName === GEMINI_COREVIEW_GET_CURRENT_VIEW_TOOL_NAME
                && diagnostic.phase === "tool_response_sent"
                ? (
                    typeof diagnostic.backendResponse?.current_view_summary === "string"
                      ? diagnostic.backendResponse.current_view_summary
                      : typeof diagnostic.resultSummary === "string"
                        ? diagnostic.resultSummary
                        : null
                  )
                : null
              const coreviewAnnotationResolved = toolName === GEMINI_COREVIEW_ADD_ANNOTATION_TOOL_NAME
                && diagnostic.phase === "tool_response_sent"
              const coreviewFocusResolved = toolName === GEMINI_COREVIEW_FOCUS_ANCHOR_TOOL_NAME
                && diagnostic.phase === "tool_response_sent"
              const backendString = (key: string) => (
                typeof diagnostic.backendResponse?.[key] === "string"
                  ? diagnostic.backendResponse[key]
                  : null
              )
              const backendNumber = (key: string) => (
                typeof diagnostic.backendResponse?.[key] === "number" && Number.isFinite(diagnostic.backendResponse[key])
                  ? diagnostic.backendResponse[key]
                  : null
              )
              const backendBoolean = (key: string) => (
                typeof diagnostic.backendResponse?.[key] === "boolean"
                  ? diagnostic.backendResponse[key]
                  : null
              )

              return {
                ...current,
                toolCallCount: isToolCallReceived ? current.toolCallCount + 1 : current.toolCallCount,
                toolResponseCount: diagnostic.phase === "tool_response_sent" ? current.toolResponseCount + 1 : current.toolResponseCount,
                toolRejectionCount: diagnostic.phase === "tool_execution_rejected"
                  ? current.toolRejectionCount + 1
                  : current.toolRejectionCount,
                toolCancellationCount: diagnostic.phase === "tool_call_cancelled"
                  ? current.toolCancellationCount + 1
                  : current.toolCancellationCount,
                artifactToolCallCount: isToolCallReceived && toolName === GEMINI_EMIT_ARTIFACT_TOOL_NAME
                  ? current.artifactToolCallCount + 1
                  : current.artifactToolCallCount,
                builderToolCallCount: isToolCallReceived && toolName !== null && GEMINI_BUILDER_TOOL_NAMES.has(toolName)
                  ? current.builderToolCallCount + 1
                  : current.builderToolCallCount,
                readArtifactTextResolvedCount: readArtifactTextResolved
                  ? (current.readArtifactTextResolvedCount ?? 0) + 1
                  : current.readArtifactTextResolvedCount,
                readArtifactTextTimeoutCount: toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME && reviewToolTimedOut
                  ? (current.readArtifactTextTimeoutCount ?? 0) + 1
                  : current.readArtifactTextTimeoutCount,
                readArtifactTextLastStatus: toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME
                  ? backendStatus ?? current.readArtifactTextLastStatus ?? null
                  : current.readArtifactTextLastStatus,
                readArtifactTextPdfExtractionStatus: toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME
                  && (
                    diagnostic.backendResponse?.source === "pdf_text_extraction"
                    || backendStatus === "extraction_pending"
                    || backendStatus === "extraction_unavailable"
                    || backendStatus === "extraction_failed"
                  )
                  ? backendStatus
                  : current.readArtifactTextPdfExtractionStatus,
                exactTextRegistrySource: toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME
                  && typeof diagnostic.backendResponse?.source === "string"
                  ? diagnostic.backendResponse.source
                  : current.exactTextRegistrySource,
                reviewToolTimedOut: current.reviewToolTimedOut === true || reviewToolTimedOut,
                reviewToolTimeoutName: reviewToolTimedOut
                  ? diagnostic.reviewToolTimeoutName
                    ?? (typeof diagnostic.backendResponse?.review_tool_timeout_name === "string"
                      ? diagnostic.backendResponse.review_tool_timeout_name
                      : toolName)
                  : current.reviewToolTimeoutName,
                reviewToolTimeoutResultSent: current.reviewToolTimeoutResultSent === true || reviewToolTimeoutResultSent,
                coreviewGetCurrentViewCount: toolName === GEMINI_COREVIEW_GET_CURRENT_VIEW_TOOL_NAME && diagnostic.phase === "tool_response_sent"
                  ? (current.coreviewGetCurrentViewCount ?? 0) + 1
                  : current.coreviewGetCurrentViewCount,
                coreviewGetCurrentViewResult: coreviewGetCurrentViewResponse ?? current.coreviewGetCurrentViewResult ?? null,
                annotationOverlayCaptured: backendBoolean("annotation_overlay_captured") ?? current.annotationOverlayCaptured ?? null,
                annotationCount: backendNumber("annotation_count") ?? current.annotationCount,
                highlightCount: backendNumber("highlight_count") ?? current.highlightCount,
                commentCount: backendNumber("comment_count") ?? current.commentCount,
                annotationActionSource: backendString("annotation_action_source") ?? current.annotationActionSource ?? null,
                coreviewAnnotationToolCount: coreviewAnnotationResolved
                  ? (current.coreviewAnnotationToolCount ?? 0) + 1
                  : current.coreviewAnnotationToolCount,
                coreviewAnnotationToolResult: coreviewAnnotationResolved
                  ? diagnostic.backendResponse?.ok === true ? "success" : "blocked"
                  : current.coreviewAnnotationToolResult ?? null,
                coreviewAnnotationKind: coreviewAnnotationResolved
                  ? backendString("annotation_kind")
                  : current.coreviewAnnotationKind ?? null,
                coreviewAnnotationAnchorType: coreviewAnnotationResolved
                  ? backendString("annotation_anchor_type")
                  : current.coreviewAnnotationAnchorType ?? null,
                coreviewAnnotationColor: coreviewAnnotationResolved
                  ? backendString("annotation_color")
                  : current.coreviewAnnotationColor ?? null,
                coreviewAnnotationPageIndex: coreviewAnnotationResolved
                  ? backendNumber("annotation_page_index")
                  : current.coreviewAnnotationPageIndex ?? null,
                coreviewAnnotationBlockedReason: coreviewAnnotationResolved
                  ? backendString("blocked_reason")
                  : current.coreviewAnnotationBlockedReason ?? null,
                coreviewFocusAnchorCount: coreviewFocusResolved
                  ? (current.coreviewFocusAnchorCount ?? 0) + 1
                  : current.coreviewFocusAnchorCount,
                coreviewFocusAnchorResult: coreviewFocusResolved
                  ? diagnostic.backendResponse?.ok === true ? "success" : "blocked"
                  : current.coreviewFocusAnchorResult ?? null,
                coreviewFocusAnchorType: coreviewFocusResolved
                  ? backendString("focus_anchor_type")
                  : current.coreviewFocusAnchorType ?? null,
                lastToolPhase: diagnostic.phase,
                lastToolName: toolName,
                lastToolAt: diagnostic.timestamp,
              }
            })
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "gemini-tool-loop-diagnostic",
              payload: {
                runtime: "gemini_live",
                phase: diagnostic.phase,
                toolName: diagnostic.toolCall.name,
                success: diagnostic.success,
                sessionId: sessionIdRef.current ?? null,
                voiceAgentSessionId: creds.session_id,
                diagnostic,
              },
            })
          },
          onRelayError: (relayError) => {
            const errorText = relayError instanceof Error ? relayError.message : String(relayError)
            setRuntimeTelemetry((current) => current.runtime === "gemini_live"
              ? { ...current, relayStatus: "degraded", lastRelayErrorText: errorText }
              : current)
            logger.warn("Gemini voice relay degraded", {
              component: "StreamVoiceSession",
              action: "geminiRelay",
              metadata: {
                voiceAgentSessionId: creds.session_id,
                error: errorText,
              },
            })
          },
        })

        if (destroyedRef.current || startRequestVersionRef.current !== requestVersion) {
          await connection.close()
          setRuntimeTelemetry(
            createLegacyRuntimeTelemetry({
              sessionId: sessionIdRef.current ?? null,
              threadId: threadId ?? null,
            }),
          )
          return
        }

        setGeminiConnection(connection)
        setCredentials(null)
        clearStartupReadyTimeout()
        const configuredToolNames = readGeminiConfiguredToolNames(connection.setup)
        const reviewToolsExposed = configuredToolNames.filter((name) => (
          GEMINI_REVIEW_TOOL_NAMES.has(name) || name === GEMINI_EMIT_ARTIFACT_TOOL_NAME
        ))
        const emitArtifactExposedDuringReview = reviewToolsExposed.includes(GEMINI_EMIT_ARTIFACT_TOOL_NAME)
        setRuntimeTelemetry((current) => current.runtime === "gemini_live"
          ? {
              ...current,
              connectionState: "connected",
              stage: "connected",
              websocketState: connection.setupComplete ? "setup_complete" : "connected",
              setupComplete: connection.setupComplete,
              microphoneState: "connected",
              remoteAudioState: "expected",
              publicSseState: "connecting",
              sessionId: connection.sessionId,
              streamUrl: connection.streamUrl,
              websocketUrl: connection.websocketUrl,
              relayUrl: connection.relayUrl,
              transport: connection.transport,
              publicEventBoundary: connection.publicEventBoundary,
              reviewToolsExposed,
              emitArtifactExposedDuringReview,
            }
          : current)
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "gemini-setup-tools",
          payload: {
            runtime: "gemini_live",
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: creds.session_id,
            reviewToolsExposed,
            emitArtifactExposedDuringReview,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
          },
        })
        markSophiaReady("gemini-live-setup-complete", {
          runtime: "gemini_live",
          callId: creds.session_id,
          voiceAgentSessionId: creds.session_id,
        })
        setStage(userMicMutedRef.current ? "idle" : "listening")
        setListeningPresence(!userMicMutedRef.current)
        setSpeakingPresence(false)
        setMetaPresence(userMicMutedRef.current ? "resting" : "listening")
        return
      }

      if (!creds.sessionId) {
        logger.warn("Voice connect returned without session_id", {
          component: "StreamVoiceSession",
          action: "startTalking",
          metadata: { callId: creds.callId },
        })
        failVoiceStartup("missing-session-id", {
          callId: creds.callId,
          callType: creds.callType,
        })
        return
      }
      logger.debug("StreamVoiceSession", "Credentials received", {
        callId: creds.callId,
      })
      scheduleBackendWarmup(creds)
      setRuntimeTelemetry(createLegacyRuntimeTelemetry({
        source: "voice-connect",
        sessionId: sessionIdRef.current ?? null,
        threadId: threadId ?? null,
        callId: creds.callId,
        voiceAgentSessionId: creds.sessionId,
        streamUrl: creds.streamUrl,
      }))
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "credentials-received",
        payload: {
          callId: creds.callId,
          callType: creds.callType,
          runtime: "legacy_cascade",
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: creds.sessionId,
        },
      })
      setCredentials(creds)
    } catch (err) {
      if (controller.signal.aborted) {
        return
      }

      const message = err instanceof Error ? err.message : "Failed to connect"
      setError(message)
      setStage("error")
      setVoiceFailed(message)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "start-talking-failed",
        payload: {
          error: message,
          sessionId: sessionIdRef.current ?? null,
        },
      })
    } finally {
      if (startRequestVersionRef.current === requestVersion) {
        startInFlightRef.current = false
        pendingStartControllerRef.current = null
      }
    }
  }, [
    applyUserTranscriptData,
    cancelPendingStartRequest,
    callingState,
    clearAutoPreconnectTimer,
    closeEventSource,
    clearStartupReadyTimeout,
    consumePreparedVoiceConnect,
    contextMode,
    failVoiceStartup,
    markSophiaReady,
    platform,
    resetGeminiOpeningGreetingLatch,
    scheduleBackendWarmup,
    sessionId,
    setListeningPresence,
    setMetaPresence,
    setSpeakingPresence,
    setVoiceFailed,
    threadId,
    userId,
    voiceRitual,
  ])

  const stopTalking = useCallback(async () => {
    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()
    closeEventSource()
    clearThinking()
    clearStartupReadyTimeout()
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "stop-talking-requested",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    await requestCurrentVoiceDisconnect()
    await releasePreparedVoiceConnect()
    try {
      await leave()
    } catch {
      // Best-effort
    }
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    recentBargeInTranscriptFingerprintsRef.current = []
    currentTurnUserTranscriptRef.current = null
    resetGeminiOpeningGreetingLatch()
    setIsSophiaReady(false)
    setCredentials(null)
    setRuntimeTelemetry(createLegacyRuntimeTelemetry({ sessionId: sessionIdRef.current ?? null, threadId: threadId ?? null }))
    setStage("idle")
    setIsMuted(false)
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [
    cancelPendingStartRequest,
    clearAutoPreconnectTimer,
    closeEventSource,
    clearStartupReadyTimeout,
    leave,
    clearThinking,
    requestCurrentVoiceDisconnect,
    resetGeminiOpeningGreetingLatch,
    releasePreparedVoiceConnect,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
    threadId,
  ])

  /**
   * Soft barge-in: clears speaking/thinking UI state but keeps the transport
   * alive (SSE, call, credentials).  The Voice Agent handles native speech
   * interruption when it detects user audio, so we only need to update the
   * visual stage.  Use this for voice-command interceptions (download,
   * reflection, interrupt) that should NOT tear down the session.
   */
  const softBargeIn = useCallback(() => {
    softBargeInActiveRef.current = true
    clearThinking()
    resetAssistantTranscriptPacingState(assistantTranscriptPacingRef.current)
    markAssistantTranscriptUserInputStarted(assistantTranscriptStaleGuardRef.current)
    const playbackState = geminiConnectionRef.current?.flushOutputAudio()
    currentTurnUserTranscriptRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "soft-barge-in",
      payload: {
        sessionId: sessionIdRef.current ?? null,
        playbackState,
      },
    })
    setStage(userMicMutedRef.current ? "idle" : "listening")
    setSpeakingPresence(false)
    setListeningPresence(!userMicMutedRef.current)
    settlePresence()
  }, [
    clearThinking,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  const bargeIn = useCallback(() => {
    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()
    closeEventSource()
    clearThinking()
    clearStartupReadyTimeout()
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "barge-in",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    void releasePreparedVoiceConnect()
    void requestCurrentVoiceDisconnect()
    // Leave the call — Voice Agent detects disconnect as barge-in
    leave().catch(() => {})
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    recentBargeInTranscriptFingerprintsRef.current = []
    currentTurnUserTranscriptRef.current = null
    userMicMutedRef.current = false
    resetGeminiOpeningGreetingLatch()
    resetAssistantTranscriptPacingState(assistantTranscriptPacingRef.current)
    resetAssistantTranscriptStaleGuardState(assistantTranscriptStaleGuardRef.current)
    setIsSophiaReady(false)
    setCredentials(null)
    setRuntimeTelemetry(createLegacyRuntimeTelemetry({ sessionId: sessionIdRef.current ?? null, threadId: threadId ?? null }))
    setStage("idle")
    setIsMuted(false)
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [
    cancelPendingStartRequest,
    clearAutoPreconnectTimer,
    closeEventSource,
    clearStartupReadyTimeout,
    leave,
    clearThinking,
    requestCurrentVoiceDisconnect,
    resetGeminiOpeningGreetingLatch,
    releasePreparedVoiceConnect,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
    threadId,
  ])

  const resetVoiceState = useCallback(() => {
    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()
    closeEventSource()
    clearThinking()
    clearStartupReadyTimeout()
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "reset-voice-state",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    void releasePreparedVoiceConnect()
    void requestCurrentVoiceDisconnect()
    leave().catch(() => {})
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    recentBargeInTranscriptFingerprintsRef.current = []
    currentTurnUserTranscriptRef.current = null
    userMicMutedRef.current = false
    resetGeminiOpeningGreetingLatch()
    resetAssistantTranscriptPacingState(assistantTranscriptPacingRef.current)
    resetAssistantTranscriptStaleGuardState(assistantTranscriptStaleGuardRef.current)
    setIsSophiaReady(false)
    setCredentials(null)
    setRuntimeTelemetry(createLegacyRuntimeTelemetry({ sessionId: sessionIdRef.current ?? null, threadId: threadId ?? null }))
    setStage("idle")
    setPartialReply("")
    setFinalReply("")
    setError(undefined)
    setIsMuted(false)
    resetPresence()
  }, [cancelPendingStartRequest, clearAutoPreconnectTimer, closeEventSource, clearStartupReadyTimeout, leave, clearThinking, releasePreparedVoiceConnect, requestCurrentVoiceDisconnect, resetGeminiOpeningGreetingLatch, resetPresence, threadId])

  /**
   * Mute the microphone without tearing down the call/agent session.
   *
   * Keeps StreamVideoClient, Call, SSE, and the Voice Agent alive on the server.
   * Use this for the in-session mic toggle instead of stopTalking — avoids
   * the progressive latency accumulation caused by repeated create/destroy
   * cycles (Cartesia HTTP/2, Deepgram WebSocket, Stream SFU reconnects).
   */
  const muteMic = useCallback(async () => {
    const activeGeminiConnection = geminiConnectionRef.current
    if (activeGeminiConnection) {
      userMicMutedRef.current = true
      activeGeminiConnection.setMicrophoneMuted(true)
      setIsMuted(true)
      setStage("idle")
      setListeningPresence(false)
      settlePresence()
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "mic-muted",
        payload: {
          sessionId: sessionIdRef.current ?? null,
          callId: activeGeminiConnection.sessionId,
          runtime: "gemini_live",
        },
      })
      return
    }

    if (!call) return
  userMicMutedRef.current = true
    try {
      await call.microphone.disable()
    } catch (err) {
      logger.logError(err, {
        component: "StreamVoiceSession",
        action: "muteMic",
      })
    }
    setIsMuted(true)
    setStage("idle")
    setListeningPresence(false)
    settlePresence()
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "mic-muted",
      payload: {
        sessionId: sessionIdRef.current ?? null,
        callId: credentials?.callId ?? null,
        runtime: "legacy_cascade",
      },
    })
  }, [call, credentials?.callId, setListeningPresence, settlePresence])

  /**
   * Unmute the microphone. If no live call exists, fall back to startTalking
   * (full connect path).
   */
  const unmuteMic = useCallback(async () => {
    const activeGeminiConnection = geminiConnectionRef.current
    if (activeGeminiConnection) {
      userMicMutedRef.current = false
      activeGeminiConnection.setMicrophoneMuted(false)
      setIsMuted(false)
      setStage("listening")
      setListeningPresence(true)
      settlePresence()
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "mic-unmuted",
        payload: {
          sessionId: sessionIdRef.current ?? null,
          callId: activeGeminiConnection.sessionId,
          runtime: "gemini_live",
        },
      })
      return
    }

    if (!call || callingState !== CallingState.JOINED) {
      userMicMutedRef.current = false
      await startTalking()
      return
    }
    userMicMutedRef.current = false
    try {
      await call.microphone.enable()
    } catch (err) {
      logger.logError(err, {
        component: "StreamVoiceSession",
        action: "unmuteMic",
      })
    }
    setIsMuted(false)
    setStage("listening")
    setListeningPresence(true)
    settlePresence()
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "mic-unmuted",
      payload: {
        sessionId: sessionIdRef.current ?? null,
        callId: credentials?.callId ?? null,
        runtime: "legacy_cascade",
      },
    })
  }, [call, callingState, credentials?.callId, setListeningPresence, settlePresence, startTalking])

  // --- Cleanup on unmount --------------------------------------------------
  useEffect(() => {
    destroyedRef.current = false

    return () => {
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "hook-cleanup",
        payload: {
          sessionId: sessionIdRef.current ?? null,
          requestVersion: startRequestVersionRef.current,
        },
      })
      destroyedRef.current = true
      autoPreconnectEnabledRef.current = false
      clearAutoPreconnectTimer()
      backendWarmupControllerRef.current?.abort()
      backendWarmupControllerRef.current = null
      connectPrewarmControllerRef.current?.abort()
      connectPrewarmControllerRef.current = null
      connectPrewarmPromiseRef.current = null
      cancelPendingStartRequest()
      closeEventSource()
      void releasePreparedVoiceConnect({ keepalive: true })
      void requestCurrentVoiceDisconnect({ keepalive: true })
      if (thinkingTimeoutRef.current) {
        clearTimeout(thinkingTimeoutRef.current)
      }
      clearStartupReadyTimeout()
    }
  }, [cancelPendingStartRequest, clearAutoPreconnectTimer, closeEventSource, clearStartupReadyTimeout, releasePreparedVoiceConnect, requestCurrentVoiceDisconnect])

  return {
    stage,
    runtime: runtimeTelemetry.runtime,
    runtimeTelemetry,
    partialReply,
    finalReply,
    error,
    startTalking,
    stopTalking,
    stopVoiceTransport: stopTalking,
    muteMic,
    unmuteMic,
    isMuted,
    hasLiveCall: callingState === CallingState.JOINED || Boolean(geminiConnection),
    bargeIn,
    softBargeIn,
    resetVoiceState,
    hasRetryableVoiceTurn: () => false,
    retryLastVoiceTurn: async () => false,
    isReflectionTtsActive: false,
    needsUnlock: false,
    path: undefined,
    stream: null,
    unlockAudio: () => {},
    speakText: async () => false,
    sendArtifactFrame,
    getArtifactFrameTransportStatus,
  }
}
