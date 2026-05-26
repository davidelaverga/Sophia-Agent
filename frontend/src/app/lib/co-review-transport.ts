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

export interface CoReviewSessionState {
  state: CoReviewStateName
  normalSessionId: string | null
  coReviewSessionId: string | null
  artifactId: string | null
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
  frameBytes: number | null
  frameDimensions: ArtifactFrameDimensions | null
  frameSendLatencyMs: number | null
  providerAcceptedFrame: boolean
  visualResponseObserved: boolean
  toolCallStillWorks: boolean | null
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
}

export interface CoReviewStopResult {
  ok: boolean
  visualInputStatus: VisualInputStatus
  normalVoiceRestored: boolean
  error: string | null
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
    const startedAt = new Date().toISOString()
    this.update({
      state: "co_review_starting",
      normalSessionId: input.normalSessionId ?? this.current.normalSessionId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      artifactId: input.artifactId,
      coReviewSessionId: null,
      visualInputStatus: "connecting",
      toolAvailability: "unknown",
      startedAt,
      stoppedAt: null,
      error: null,
      transportKind: this.transport.kind,
      normalVoiceRestored: false,
    })

    const startMark = this.clock()
    const result = await this.transport.startCoReview(input)
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
      providerAcceptedFrame: result.providerAcceptedFrame ?? false,
      visualResponseObserved: result.visualResponseObserved ?? false,
      toolCallStillWorks: result.toolCallStillWorks ?? null,
      error: null,
    })
    return this.state()
  }

  async stopCoReview(): Promise<CoReviewSessionState> {
    this.update({
      state: "co_review_stopping",
      visualInputStatus: this.current.visualInputStatus === "inactive" ? "inactive" : "stopped",
      stoppedAt: new Date().toISOString(),
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
    frameBytes: null,
    frameDimensions: null,
    frameSendLatencyMs: null,
    providerAcceptedFrame: false,
    visualResponseObserved: false,
    toolCallStillWorks: null,
  }
}

type SafeCoReviewTelemetryValue = string | number | boolean | null | ArtifactFrameDimensions

export function safeCoReviewTelemetryFromState(
  state: CoReviewSessionState,
): Record<string, SafeCoReviewTelemetryValue> {
  return {
    normalVoiceSessionId: state.normalSessionId,
    coReviewSessionId: state.coReviewSessionId,
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
    frameBytes: state.frameBytes,
    frameDimensions: state.frameDimensions,
    frameSendLatencyMs: state.frameSendLatencyMs,
    providerAcceptedFrame: state.providerAcceptedFrame,
    visualResponseObserved: state.visualResponseObserved,
    toolCallStillWorks: state.toolCallStillWorks,
    estimatedVisualCost: state.estimatedVisualCost,
  }
}

function elapsedMs(now: number, then: number): number {
  return Math.max(0, Math.round(now - then))
}

function defaultClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now()
}
