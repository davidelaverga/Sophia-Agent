import type { ArtifactVisualSource } from "./co-review-capture"
import { stopArtifactVisualSource } from "./co-review-capture"
import type { ArtifactFrameDimensions } from "./co-review-frame"

export const CO_REVIEW_STATES = [
  "normal_voice",
  "co_review_starting",
  "co_review_live",
  "co_review_stopping",
  "normal_voice_restored",
  "co_review_error",
] as const

export type CoReviewStateName = (typeof CO_REVIEW_STATES)[number]
export type VisualInputStatus = "inactive" | "unsupported" | "connecting" | "live" | "stopped" | "error"
export type ToolAvailability = "unknown" | "available" | "sideband_only" | "unavailable"
export type VideoOrFrameMode = "none" | "continuous_video" | "still_frame"
export type RefreshFrameResult = "idle" | "refreshing" | "success" | "error" | "blocked"

export interface CoreviewUsageMetadataAfterFrame {
  imageCount?: number | null
  image_count?: number | null
  videoDurationSeconds?: number | null
  video_duration_seconds?: number | null
  audioDurationSeconds?: number | null
  audio_duration_seconds?: number | null
  totalTokenCount?: number | null
  total_token_count?: number | null
  rawUsageMetadataExcluded?: true
}

export interface CoReviewSessionState {
  state: CoReviewStateName
  normalSessionId: string | null
  coReviewSessionId: string | null
  artifactId: string | null
  visualSourceKind: ArtifactVisualSource["kind"] | null
  sessionId: string | null
  threadId: string | null
  visualInputStatus: VisualInputStatus
  toolAvailability: ToolAvailability
  startedAt: string | null
  stoppedAt: string | null
  error: string | null
  transportKind: string
  videoOrFrameMode: VideoOrFrameMode
  frameCount: number
  coReviewStartLatencyMs: number | null
  coReviewStopLatencyMs: number | null
  normalVoicePaused: boolean
  normalVoiceRestored: boolean
  sessionHandoffMs: number | null
  estimatedVisualCost: number | null
  frameSentCount: number
  initialFrameSent: boolean
  refreshFrameCount: number
  frameBytes: number | null
  frameDimensions: ArtifactFrameDimensions | null
  totalFrameBytes: number
  frameSendLatencyMs: number | null
  maxFrameSendLatencyMs: number | null
  frameSendFailureCount: number
  lastFrameSendFailureReason: string | null
  refreshFrameRequested: boolean
  refreshFrameInProgress: boolean
  refreshFrameStartedAt: string | null
  refreshFrameLatencyMs: number | null
  refreshFrameResult: RefreshFrameResult
  lastRefreshAt: string | null
  lastFrameBytes: number | null
  lastFrameDimensions: ArtifactFrameDimensions | null
  websocketStateBeforeRefresh: string | null
  websocketStateAfterRefresh: string | null
  websocketClosedAfterRefresh: boolean
  websocketClosedAfterFrameCount: number
  refreshErrorSafeReason: string | null
  providerUsageImageCount: number | null
  providerUsageVideoDurationSeconds: number | null
  providerUsageAudioDurationSeconds: number | null
  providerAcceptedFrame: boolean
  visualResponseObserved: boolean
  toolCallStillWorks: boolean | null
  toolCallAfterFrameObserved: boolean
}

export interface CoReviewStartInput {
  normalSessionId?: string | null
  sessionId: string
  threadId: string
  artifactId: string
  visualSource: ArtifactVisualSource
}

export interface CoReviewStartResult {
  ok: boolean
  coReviewSessionId: string | null
  visualInputStatus: VisualInputStatus
  toolAvailability: ToolAvailability
  videoOrFrameMode: VideoOrFrameMode
  normalVoicePaused: boolean
  sessionHandoffMs: number | null
  estimatedVisualCost: number | null
  error: string | null
  frameSentCount?: number
  frameBytes?: number | null
  frameDimensions?: ArtifactFrameDimensions | null
  frameSendLatencyMs?: number | null
  providerAcceptedFrame?: boolean
  visualResponseObserved?: boolean
  toolCallStillWorks?: boolean | null
  imageCountAfterFrame?: number | null
  usageMetadataAfterFrame?: CoreviewUsageMetadataAfterFrame | null
  websocketClosedAfterFrameSend?: boolean
}

export interface CoReviewStopResult {
  ok: boolean
  visualInputStatus: VisualInputStatus
  normalVoiceRestored: boolean
  error: string | null
}

export interface CoReviewRefreshInput {
  artifactId: string
  visualSource: ArtifactVisualSource
}

export interface CoReviewRefreshResult {
  ok: boolean
  visualInputStatus: VisualInputStatus
  toolAvailability: ToolAvailability
  error: string | null
  frameSentCount?: number
  frameBytes?: number | null
  frameDimensions?: ArtifactFrameDimensions | null
  frameSendLatencyMs?: number | null
  providerAcceptedFrame?: boolean
  visualResponseObserved?: boolean
  estimatedVisualCost?: number | null
  websocketStateBeforeRefresh?: string | null
  websocketStateAfterRefresh?: string | null
  websocketClosedAfterRefresh?: boolean
  imageCountAfterFrame?: number | null
  usageMetadataAfterFrame?: CoreviewUsageMetadataAfterFrame | null
}

export interface CoReviewTransportStatus {
  kind: string
  visualTransportSupported: boolean
  toolsSupportedInCoReview: boolean
  continuousVideoSupported: boolean
  stillFramesSupported: boolean
  statusText: string
}

export interface CoReviewMediaTransport {
  readonly kind: string
  startCoReview(input: CoReviewStartInput): Promise<CoReviewStartResult>
  refreshCoReview(input: CoReviewRefreshInput): Promise<CoReviewRefreshResult>
  stopCoReview(): Promise<CoReviewStopResult>
  sendFrame?(frame: Blob): Promise<void>
  attachVideoTrack?(track: MediaStreamTrack): Promise<void>
  status(): CoReviewTransportStatus
  supportsTools(): boolean
  supportsContinuousVideo(): boolean
  supportsStillFrames(): boolean
}

export class AudioWebSocketUnsupportedTransport implements CoReviewMediaTransport {
  readonly kind = "gemini_live_audio_websocket_unsupported"

  async startCoReview(input: CoReviewStartInput): Promise<CoReviewStartResult> {
    stopArtifactVisualSource(input.visualSource)
    return {
      ok: false,
      coReviewSessionId: null,
      visualInputStatus: "unsupported",
      toolAvailability: "sideband_only",
      videoOrFrameMode: "none",
      normalVoicePaused: false,
      sessionHandoffMs: null,
      estimatedVisualCost: null,
      error: "current_gemini_audio_websocket_has_no_artifact_media_input",
    }
  }

  async stopCoReview(): Promise<CoReviewStopResult> {
    return {
      ok: true,
      visualInputStatus: "stopped",
      normalVoiceRestored: true,
      error: null,
    }
  }

  async refreshCoReview(input: CoReviewRefreshInput): Promise<CoReviewRefreshResult> {
    stopArtifactVisualSource(input.visualSource)
    return {
      ok: false,
      visualInputStatus: "unsupported",
      toolAvailability: "sideband_only",
      error: "current_gemini_audio_websocket_has_no_artifact_media_input",
      websocketStateBeforeRefresh: "unsupported",
      websocketStateAfterRefresh: "unsupported",
      websocketClosedAfterRefresh: false,
    }
  }

  status(): CoReviewTransportStatus {
    return {
      kind: this.kind,
      visualTransportSupported: false,
      toolsSupportedInCoReview: false,
      continuousVideoSupported: false,
      stillFramesSupported: false,
      statusText: "continuous unsupported",
    }
  }

  supportsTools(): boolean {
    return false
  }

  supportsContinuousVideo(): boolean {
    return false
  }

  supportsStillFrames(): boolean {
    return false
  }
}

export class CoReviewSessionMachine {
  private current: CoReviewSessionState
  private readonly transport: CoReviewMediaTransport
  private readonly onStateChange?: (state: CoReviewSessionState) => void
  private readonly clock: () => number
  private refreshRequestId = 0

  constructor({
    transport = new AudioWebSocketUnsupportedTransport(),
    initialState,
    onStateChange,
    clock = defaultClock,
  }: {
    transport?: CoReviewMediaTransport
    initialState?: Partial<CoReviewSessionState>
    onStateChange?: (state: CoReviewSessionState) => void
    clock?: () => number
  } = {}) {
    this.transport = transport
    this.onStateChange = onStateChange
    this.clock = clock
    this.current = { ...initialCoReviewState(transport.kind), ...initialState }
  }

  state(): CoReviewSessionState {
    return { ...this.current }
  }

  async startCoReview(input: CoReviewStartInput): Promise<CoReviewSessionState> {
    this.refreshRequestId += 1
    const startedAt = new Date().toISOString()
    this.update({
      state: "co_review_starting",
      normalSessionId: input.normalSessionId ?? this.current.normalSessionId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      artifactId: input.artifactId,
      visualSourceKind: input.visualSource.kind,
      coReviewSessionId: null,
      visualInputStatus: "connecting",
      toolAvailability: "unknown",
      startedAt,
      stoppedAt: null,
      error: null,
      transportKind: this.transport.kind,
      normalVoiceRestored: false,
      refreshFrameRequested: false,
      refreshFrameInProgress: false,
      refreshFrameStartedAt: null,
      refreshFrameLatencyMs: null,
      refreshFrameResult: "idle",
      lastRefreshAt: null,
      lastFrameBytes: null,
      lastFrameDimensions: null,
      initialFrameSent: false,
      refreshFrameCount: 0,
      totalFrameBytes: 0,
      maxFrameSendLatencyMs: null,
      frameSendFailureCount: 0,
      lastFrameSendFailureReason: null,
      websocketStateBeforeRefresh: null,
      websocketStateAfterRefresh: null,
      websocketClosedAfterRefresh: false,
      websocketClosedAfterFrameCount: 0,
      refreshErrorSafeReason: null,
      providerUsageImageCount: null,
      providerUsageVideoDurationSeconds: null,
      providerUsageAudioDurationSeconds: null,
      toolCallAfterFrameObserved: false,
    })

    const startMark = this.clock()
    let result: CoReviewStartResult
    try {
      result = await this.transport.startCoReview(input)
    } catch (error) {
      const coReviewStartLatencyMs = elapsedMs(this.clock(), startMark)
      this.update({
        state: "co_review_error",
        coReviewSessionId: null,
        visualInputStatus: "error",
        toolAvailability: "unavailable",
        videoOrFrameMode: "none",
        normalVoicePaused: false,
        sessionHandoffMs: null,
        estimatedVisualCost: null,
        coReviewStartLatencyMs,
        providerAcceptedFrame: false,
        visualResponseObserved: false,
        toolCallStillWorks: null,
        error: error instanceof Error ? error.message : "co_review_transport_start_exception",
      })
      return this.state()
    }
    const coReviewStartLatencyMs = elapsedMs(this.clock(), startMark)

    if (!result.ok) {
      this.update({
        state: "co_review_error",
        coReviewSessionId: result.coReviewSessionId,
        visualInputStatus: result.visualInputStatus,
        toolAvailability: result.toolAvailability,
        videoOrFrameMode: result.videoOrFrameMode,
        normalVoicePaused: result.normalVoicePaused,
        sessionHandoffMs: result.sessionHandoffMs,
        estimatedVisualCost: result.estimatedVisualCost,
        coReviewStartLatencyMs,
        frameCount: result.frameSentCount ?? this.current.frameCount,
        frameSentCount: result.frameSentCount ?? this.current.frameSentCount,
        frameBytes: result.frameBytes ?? this.current.frameBytes,
        frameDimensions: result.frameDimensions ?? this.current.frameDimensions,
        frameSendLatencyMs: result.frameSendLatencyMs ?? this.current.frameSendLatencyMs,
        maxFrameSendLatencyMs: maxNullable(this.current.maxFrameSendLatencyMs, result.frameSendLatencyMs ?? null),
        frameSendFailureCount: this.current.frameSendFailureCount + 1,
        lastFrameSendFailureReason: result.error ?? "co_review_transport_start_failed",
        lastFrameBytes: result.frameBytes ?? this.current.lastFrameBytes,
        lastFrameDimensions: result.frameDimensions ?? this.current.lastFrameDimensions,
        websocketClosedAfterFrameCount: this.current.websocketClosedAfterFrameCount + (result.websocketClosedAfterFrameSend ? 1 : 0),
        providerUsageImageCount: result.imageCountAfterFrame ?? this.current.providerUsageImageCount,
        providerUsageVideoDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "video"),
        providerUsageAudioDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "audio"),
        providerAcceptedFrame: result.providerAcceptedFrame ?? false,
        visualResponseObserved: result.visualResponseObserved ?? false,
        toolCallStillWorks: result.toolCallStillWorks ?? null,
        error: result.error ?? "co_review_transport_start_failed",
      })
      return this.state()
    }

    this.update({
      state: "co_review_live",
      coReviewSessionId: result.coReviewSessionId,
      visualInputStatus: result.visualInputStatus,
      toolAvailability: result.toolAvailability,
      videoOrFrameMode: result.videoOrFrameMode,
      normalVoicePaused: result.normalVoicePaused,
      sessionHandoffMs: result.sessionHandoffMs,
      estimatedVisualCost: result.estimatedVisualCost,
      coReviewStartLatencyMs,
      frameCount: result.frameSentCount ?? this.current.frameCount,
      frameSentCount: result.frameSentCount ?? this.current.frameSentCount,
      frameBytes: result.frameBytes ?? this.current.frameBytes,
      frameDimensions: result.frameDimensions ?? this.current.frameDimensions,
      frameSendLatencyMs: result.frameSendLatencyMs ?? this.current.frameSendLatencyMs,
      initialFrameSent: (result.frameSentCount ?? 0) > 0,
      totalFrameBytes: result.frameBytes ?? 0,
      maxFrameSendLatencyMs: maxNullable(this.current.maxFrameSendLatencyMs, result.frameSendLatencyMs ?? null),
      lastFrameBytes: result.frameBytes ?? this.current.lastFrameBytes,
      lastFrameDimensions: result.frameDimensions ?? this.current.lastFrameDimensions,
      websocketClosedAfterFrameCount: this.current.websocketClosedAfterFrameCount + (result.websocketClosedAfterFrameSend ? 1 : 0),
      providerUsageImageCount: result.imageCountAfterFrame ?? this.current.providerUsageImageCount,
      providerUsageVideoDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "video"),
      providerUsageAudioDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "audio"),
      providerAcceptedFrame: result.providerAcceptedFrame ?? false,
      visualResponseObserved: result.visualResponseObserved ?? false,
      toolCallStillWorks: result.toolCallStillWorks ?? null,
      error: null,
    })
    return this.state()
  }

  async stopCoReview(): Promise<CoReviewSessionState> {
    this.refreshRequestId += 1
    this.update({
      state: "co_review_stopping",
      visualInputStatus: this.current.visualInputStatus === "inactive" ? "inactive" : "stopped",
      stoppedAt: new Date().toISOString(),
      refreshFrameInProgress: false,
    })

    const stopMark = this.clock()
    const result = await this.transport.stopCoReview()
    const coReviewStopLatencyMs = elapsedMs(this.clock(), stopMark)

    this.update({
      state: "normal_voice_restored",
      visualInputStatus: result.visualInputStatus,
      coReviewSessionId: null,
      stoppedAt: new Date().toISOString(),
      error: result.error,
      coReviewStopLatencyMs,
      normalVoiceRestored: result.normalVoiceRestored,
      normalVoicePaused: false,
      videoOrFrameMode: "none",
      visualResponseObserved: false,
      refreshFrameInProgress: false,
    })
    return this.state()
  }

  async failCoReview(error: string): Promise<CoReviewSessionState> {
    this.refreshRequestId += 1
    try {
      await this.transport.stopCoReview()
    } catch {
      // Co-review cleanup must not close or destabilize the normal voice socket.
    }

    this.update({
      state: "co_review_error",
      visualInputStatus: "error",
      toolAvailability: "unavailable",
      coReviewSessionId: null,
      stoppedAt: new Date().toISOString(),
      error,
      normalVoiceRestored: true,
      normalVoicePaused: false,
      videoOrFrameMode: "none",
      visualResponseObserved: false,
      toolCallStillWorks: null,
      refreshFrameInProgress: false,
    })
    return this.state()
  }

  async refreshCoReview(input: CoReviewRefreshInput): Promise<CoReviewSessionState> {
    if (this.current.state !== "co_review_live") {
      this.update({
        refreshFrameRequested: true,
        refreshFrameInProgress: false,
        refreshFrameResult: "blocked",
        refreshErrorSafeReason: "co_review_not_live",
      })
      return this.state()
    }

    if (this.current.refreshFrameInProgress) {
      this.update({
        refreshFrameRequested: true,
        refreshFrameResult: "blocked",
        refreshErrorSafeReason: "refresh_already_in_progress",
      })
      return this.state()
    }

    const refreshId = this.refreshRequestId + 1
    this.refreshRequestId = refreshId
    const refreshFrameStartedAt = new Date().toISOString()
    const refreshMark = this.clock()
    this.update({
      refreshFrameRequested: true,
      refreshFrameInProgress: true,
      refreshFrameStartedAt,
      refreshFrameLatencyMs: null,
      refreshFrameResult: "refreshing",
      refreshErrorSafeReason: null,
      websocketStateBeforeRefresh: null,
      websocketStateAfterRefresh: null,
      websocketClosedAfterRefresh: false,
    })

    let result: CoReviewRefreshResult
    try {
      result = await this.transport.refreshCoReview(input)
    } catch (error) {
      result = {
        ok: false,
        visualInputStatus: "error",
        toolAvailability: "unavailable",
        error: error instanceof Error ? error.message : "co_review_refresh_exception",
        websocketStateBeforeRefresh: null,
        websocketStateAfterRefresh: null,
        websocketClosedAfterRefresh: false,
      }
    }

    if (refreshId !== this.refreshRequestId || this.current.state !== "co_review_live") {
      return this.state()
    }

    const refreshFrameLatencyMs = elapsedMs(this.clock(), refreshMark)
    if (!result.ok) {
      this.update({
        state: "co_review_error",
        visualInputStatus: result.visualInputStatus,
        toolAvailability: result.toolAvailability,
        coReviewSessionId: null,
        error: result.error ?? "artifact_frame_refresh_failed",
        videoOrFrameMode: "none",
        normalVoicePaused: false,
        normalVoiceRestored: true,
        refreshFrameInProgress: false,
        refreshFrameLatencyMs,
        refreshFrameResult: "error",
        refreshErrorSafeReason: result.error ?? "artifact_frame_refresh_failed",
        websocketStateBeforeRefresh: result.websocketStateBeforeRefresh ?? null,
        websocketStateAfterRefresh: result.websocketStateAfterRefresh ?? null,
        websocketClosedAfterRefresh: result.websocketClosedAfterRefresh ?? false,
        websocketClosedAfterFrameCount: this.current.websocketClosedAfterFrameCount + (result.websocketClosedAfterRefresh ? 1 : 0),
        frameBytes: result.frameBytes ?? this.current.frameBytes,
        frameDimensions: result.frameDimensions ?? this.current.frameDimensions,
        frameSendLatencyMs: result.frameSendLatencyMs ?? this.current.frameSendLatencyMs,
        maxFrameSendLatencyMs: maxNullable(this.current.maxFrameSendLatencyMs, result.frameSendLatencyMs ?? null),
        frameSendFailureCount: this.current.frameSendFailureCount + 1,
        lastFrameSendFailureReason: result.error ?? "artifact_frame_refresh_failed",
        lastFrameBytes: result.frameBytes ?? this.current.lastFrameBytes,
        lastFrameDimensions: result.frameDimensions ?? this.current.lastFrameDimensions,
        providerUsageImageCount: result.imageCountAfterFrame ?? this.current.providerUsageImageCount,
        providerUsageVideoDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "video") ?? this.current.providerUsageVideoDurationSeconds,
        providerUsageAudioDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "audio") ?? this.current.providerUsageAudioDurationSeconds,
        providerAcceptedFrame: result.providerAcceptedFrame ?? false,
        visualResponseObserved: result.visualResponseObserved ?? false,
        estimatedVisualCost: result.estimatedVisualCost ?? this.current.estimatedVisualCost,
      })
      return this.state()
    }

    const additionalFrames = result.frameSentCount ?? 1
    this.update({
      state: "co_review_live",
      visualInputStatus: result.visualInputStatus,
      toolAvailability: result.toolAvailability,
      error: null,
      videoOrFrameMode: "still_frame",
      refreshFrameInProgress: false,
      refreshFrameLatencyMs,
      refreshFrameResult: "success",
      lastRefreshAt: new Date().toISOString(),
      refreshErrorSafeReason: null,
      websocketStateBeforeRefresh: result.websocketStateBeforeRefresh ?? null,
      websocketStateAfterRefresh: result.websocketStateAfterRefresh ?? null,
      websocketClosedAfterRefresh: result.websocketClosedAfterRefresh ?? false,
      frameCount: this.current.frameCount + additionalFrames,
      frameSentCount: this.current.frameSentCount + additionalFrames,
      refreshFrameCount: this.current.refreshFrameCount + additionalFrames,
      frameBytes: result.frameBytes ?? this.current.frameBytes,
      frameDimensions: result.frameDimensions ?? this.current.frameDimensions,
      frameSendLatencyMs: result.frameSendLatencyMs ?? this.current.frameSendLatencyMs,
      totalFrameBytes: this.current.totalFrameBytes + (result.frameBytes ?? 0),
      maxFrameSendLatencyMs: maxNullable(this.current.maxFrameSendLatencyMs, result.frameSendLatencyMs ?? null),
      lastFrameBytes: result.frameBytes ?? this.current.lastFrameBytes,
      lastFrameDimensions: result.frameDimensions ?? this.current.lastFrameDimensions,
      websocketClosedAfterFrameCount: this.current.websocketClosedAfterFrameCount + (result.websocketClosedAfterRefresh ? 1 : 0),
      providerUsageImageCount: result.imageCountAfterFrame ?? this.current.providerUsageImageCount,
      providerUsageVideoDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "video") ?? this.current.providerUsageVideoDurationSeconds,
      providerUsageAudioDurationSeconds: readUsageDurationSeconds(result.usageMetadataAfterFrame ?? null, "audio") ?? this.current.providerUsageAudioDurationSeconds,
      providerAcceptedFrame: result.providerAcceptedFrame ?? this.current.providerAcceptedFrame,
      visualResponseObserved: result.visualResponseObserved ?? this.current.visualResponseObserved,
      estimatedVisualCost: result.estimatedVisualCost ?? this.current.estimatedVisualCost,
    })
    return this.state()
  }

  status(): CoReviewTransportStatus {
    return this.transport.status()
  }

  private update(patch: Partial<CoReviewSessionState>): void {
    this.current = { ...this.current, ...patch }
    this.onStateChange?.(this.state())
  }
}

export function initialCoReviewState(transportKind = "none"): CoReviewSessionState {
  return {
    state: "normal_voice",
    normalSessionId: null,
    coReviewSessionId: null,
    artifactId: null,
    visualSourceKind: null,
    sessionId: null,
    threadId: null,
    visualInputStatus: "inactive",
    toolAvailability: "unknown",
    startedAt: null,
    stoppedAt: null,
    error: null,
    transportKind,
    videoOrFrameMode: "none",
    frameCount: 0,
    coReviewStartLatencyMs: null,
    coReviewStopLatencyMs: null,
    normalVoicePaused: false,
    normalVoiceRestored: false,
    sessionHandoffMs: null,
    estimatedVisualCost: null,
    frameSentCount: 0,
    initialFrameSent: false,
    refreshFrameCount: 0,
    frameBytes: null,
    frameDimensions: null,
    totalFrameBytes: 0,
    frameSendLatencyMs: null,
    maxFrameSendLatencyMs: null,
    frameSendFailureCount: 0,
    lastFrameSendFailureReason: null,
    refreshFrameRequested: false,
    refreshFrameInProgress: false,
    refreshFrameStartedAt: null,
    refreshFrameLatencyMs: null,
    refreshFrameResult: "idle",
    lastRefreshAt: null,
    lastFrameBytes: null,
    lastFrameDimensions: null,
    websocketStateBeforeRefresh: null,
    websocketStateAfterRefresh: null,
    websocketClosedAfterRefresh: false,
    websocketClosedAfterFrameCount: 0,
    refreshErrorSafeReason: null,
    providerUsageImageCount: null,
    providerUsageVideoDurationSeconds: null,
    providerUsageAudioDurationSeconds: null,
    providerAcceptedFrame: false,
    visualResponseObserved: false,
    toolCallStillWorks: null,
    toolCallAfterFrameObserved: false,
  }
}

type SafeCoReviewTelemetryValue = string | number | boolean | null | ArtifactFrameDimensions

export function safeCoReviewTelemetryFromState(
  state: CoReviewSessionState,
): Record<string, SafeCoReviewTelemetryValue> {
  return {
    normalVoiceSessionId: state.normalSessionId,
    coReviewSessionId: state.coReviewSessionId,
    coreviewSessionActive: state.state === "co_review_live" && state.visualInputStatus === "live",
    coreviewArtifactId: state.artifactId,
    visualSourceKind: state.visualSourceKind,
    transportKind: state.transportKind,
    visualTransportSupported: state.visualInputStatus === "live",
    toolsSupportedInCoReview: state.toolAvailability === "available",
    coReviewStartLatencyMs: state.coReviewStartLatencyMs,
    coReviewStopLatencyMs: state.coReviewStopLatencyMs,
    normalVoicePaused: state.normalVoicePaused,
    normalVoiceRestored: state.normalVoiceRestored,
    sessionHandoffMs: state.sessionHandoffMs,
    videoOrFrameMode: state.videoOrFrameMode,
    frameCount: state.frameCount,
    frameSentCount: state.frameSentCount,
    initialFrameSent: state.initialFrameSent,
    refreshFrameCount: state.refreshFrameCount,
    frameBytes: state.frameBytes,
    frameDimensions: state.frameDimensions,
    totalFrameBytes: state.totalFrameBytes,
    frameSendLatencyMs: state.frameSendLatencyMs,
    maxFrameSendLatencyMs: state.maxFrameSendLatencyMs,
    frameSendFailureCount: state.frameSendFailureCount,
    lastFrameSendFailureReason: state.lastFrameSendFailureReason,
    refreshFrameRequested: state.refreshFrameRequested,
    refreshFrameStartedAt: state.refreshFrameStartedAt,
    refreshFrameLatencyMs: state.refreshFrameLatencyMs,
    refreshFrameResult: state.refreshFrameResult,
    lastFrameBytes: state.lastFrameBytes,
    lastFrameDimensions: state.lastFrameDimensions,
    websocketStateBeforeRefresh: state.websocketStateBeforeRefresh,
    websocketStateAfterRefresh: state.websocketStateAfterRefresh,
    websocketClosedAfterRefresh: state.websocketClosedAfterRefresh,
    websocketClosedAfterFrameCount: state.websocketClosedAfterFrameCount,
    refreshErrorSafeReason: state.refreshErrorSafeReason,
    providerUsageImageCount: state.providerUsageImageCount,
    providerUsageVideoDurationSeconds: state.providerUsageVideoDurationSeconds,
    providerUsageAudioDurationSeconds: state.providerUsageAudioDurationSeconds,
    rawFrameExcluded: true,
    providerAcceptedFrame: state.providerAcceptedFrame,
    visualResponseObserved: state.visualResponseObserved,
    toolCallStillWorks: state.toolCallStillWorks,
    toolCallAfterFrameObserved: state.toolCallAfterFrameObserved,
    estimatedVisualCost: state.estimatedVisualCost,
  }
}

function elapsedMs(now: number, then: number): number {
  return Math.max(0, Math.round(now - then))
}

function defaultClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now()
}

function maxNullable(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current
  return current === null ? candidate : Math.max(current, candidate)
}

function readUsageDurationSeconds(
  metadata: CoreviewUsageMetadataAfterFrame | null,
  kind: "audio" | "video",
): number | null {
  if (!metadata) return null
  const camelValue = kind === "audio" ? metadata.audioDurationSeconds : metadata.videoDurationSeconds
  if (typeof camelValue === "number" && Number.isFinite(camelValue)) return camelValue
  const snakeValue = kind === "audio" ? metadata.audio_duration_seconds : metadata.video_duration_seconds
  return typeof snakeValue === "number" && Number.isFinite(snakeValue) ? snakeValue : null
}
