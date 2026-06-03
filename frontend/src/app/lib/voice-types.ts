export type VoiceStage = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error"

export type RouterPath = "direct" | "light" | "agentic"

export type SessionRuntime = "legacy_cascade" | "gemini_live"

export type RuntimeTelemetrySource = "default" | "voice-connect" | "capture"

export type GeminiRuntimeConnectionState = "idle" | "connecting" | "connected" | "closing" | "closed" | "error"
export type GeminiRuntimeWebSocketState = "idle" | "connecting" | "setup_pending" | "setup_complete" | "connected" | "error" | "closed"
export type GeminiRuntimeRelayStatus = "disconnected" | "active" | "degraded" | "terminal_error"
export type GeminiRuntimePublicSseState = "disconnected" | "connecting" | "connected" | "error"
export type GeminiRuntimeMicrophoneState = "idle" | "waiting" | "granted" | "connected" | "error"
export type GeminiRuntimeRemoteAudioState = "idle" | "expected" | "active"

export type GeminiRuntimeCategoryCounter = {
  count: number
  lastAt: string | null
}

export type GeminiRuntimeRelayClassification = "critical" | "summary" | "skip"

export type GeminiRuntimeToolCallLedgerEntry = {
  toolCallId: string
  toolName: string | null
  receivedAt: string | null
  cancelledAt: string | null
  relayStartedAt: string | null
  relayCompletedAt: string | null
  backendAcceptedAt: string | null
  toolResponsePreparedAt: string | null
  toolResponseSentAt: string | null
  sendSuppressedAt: string | null
  suppressionReason: string | null
  finalState: string
}

export type LegacyRuntimeTelemetry = {
  runtime: "legacy_cascade"
  source: RuntimeTelemetrySource
  sessionId: string | null
  threadId: string | null
  callId: string | null
  voiceAgentSessionId: string | null
  streamUrl: string | null
}

export type GeminiRuntimeTelemetry = {
  runtime: "gemini_live"
  source: RuntimeTelemetrySource
  sessionId: string | null
  streamUrl: string | null
  websocketUrl: string | null
  relayUrl: string | null
  transport: string | null
  publicEventBoundary: string | null
  connectionState: GeminiRuntimeConnectionState
  stage: string | null
  websocketState: GeminiRuntimeWebSocketState
  relayStatus: GeminiRuntimeRelayStatus
  publicSseState: GeminiRuntimePublicSseState
  microphoneState: GeminiRuntimeMicrophoneState
  remoteAudioState: GeminiRuntimeRemoteAudioState
  setupComplete: boolean
  providerEventCount: number
  lastProviderEventAt: string | null
  lastProviderEventType: string | null
  providerCategoryCounts: Record<string, GeminiRuntimeCategoryCounter>
  reviewVoiceReady?: boolean
  reviewMicAudioDetected?: boolean
  reviewUserSpeechDetected?: boolean
  reviewProviderTranscriptObserved?: boolean
  reviewPublicTranscriptObserved?: boolean
  reviewTranscriptPromotionBlockedReason?: string | null
  providerInputTranscriptCount?: number
  publicUserTranscriptCount?: number
  providerToPublicTranscriptGap?: number
  firstProviderTranscriptAt?: string | null
  firstPublicUserTranscriptAt?: string | null
  transcriptPromotionLatencyMs?: number | null
  outputAudioEventCount: number
  lastOutputAudioAt: string | null
  assistantTranscriptSource?: string | null
  assistantTranscriptFinalSeen?: boolean
  assistantTranscriptApproximate?: boolean | null
  assistantTranscriptSessionId?: string | null
  staleAssistantAudioDroppedCount: number
  staleAssistantTranscriptDroppedCount: number
  staleAssistantOutputSuppressionCount: number
  playbackGeneration: number
  assistantUserOverlapMs: number
  rawAssistantUserOverlapMs?: number
  maxRawAssistantUserOverlapMs?: number
  confirmedAssistantUserOverlapMs?: number
  maxConfirmedAssistantUserOverlapMs?: number
  userInputActiveAgeMs?: number | null
  bargeInConfirmed?: boolean
  bargeInConfirmationSource?: string | null
  bargeInConfirmationReason?: string | null
  bargeInCandidateFrameCount?: number
  inputFrameOnlyNotBargeInCount?: number
  candidateFramesDidNotConfirmCount?: number
  candidateExpiredCount?: number
  suppressionBlockedBecauseNoIntentCount?: number
  bargeInTranscriptCapturedCount?: number
  bargeInTranscriptPromotedCount?: number
  bargeInTranscriptPromotionLatencyMs?: number | null
  bargeInTranscriptIgnoredCount?: number
  bargeInTranscriptDuplicateSuppressedCount?: number
  lastBargeInTranscriptPreview?: string | null
  bargeInNewTurnDispatchCount?: number
  bargeInNewTurnDispatchBlockedReason?: string | null
  staleSuppressionArmedAt?: string | null
  staleSuppressionArmedBy?: string | null
  assistantAudioDropReason?: string | null
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
  relayClassificationCounts: Record<GeminiRuntimeRelayClassification, GeminiRuntimeCategoryCounter>
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
  transcriptCoalescingDisabledReason?: string | null
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
  lastWebSocketCloseCode?: number | null
  lastWebSocketCloseReasonSafe?: string | null
  lastWebSocketCloseWasClean?: boolean | null
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
  toolCallLedger: GeminiRuntimeToolCallLedgerEntry[]
}

export type VoiceRuntimeTelemetry = LegacyRuntimeTelemetry | GeminiRuntimeTelemetry

export type VoiceStateProps = {
  stage: VoiceStage
  partialReply: string
  finalReply: string
  error?: string
  stream?: MediaStream | null
  needsUnlock?: boolean
  path?: RouterPath
  startTalking?: () => Promise<void>
  stopTalking: () => Promise<void> | void
  bargeIn: () => void
  softBargeIn: () => void
  unlockAudio?: () => void
  resetVoiceState?: () => void
  runtime?: SessionRuntime
  runtimeTelemetry?: VoiceRuntimeTelemetry
}

export type QueuedChunk = {
  url: string
  revokeOnUse: boolean
}
