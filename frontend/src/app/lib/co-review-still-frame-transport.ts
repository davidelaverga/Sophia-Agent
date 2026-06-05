import { stopArtifactVisualSource } from "./co-review-capture"
import {
  encodeArtifactStillFrame,
  type ArtifactEncodedFramePayload,
  type ArtifactFrameDimensions,
} from "./co-review-frame"
import type {
  CoReviewMediaTransport,
  CoReviewRefreshInput,
  CoReviewRefreshResult,
  CoReviewStartInput,
  CoReviewStartResult,
  CoReviewStopResult,
  CoReviewTransportStatus,
  CoreviewUsageMetadataAfterFrame,
} from "./co-review-transport"

export interface ArtifactFrameSendResult {
  coreviewSendStage?: "start" | "refresh" | null
  ok: boolean
  supported: boolean
  providerAcceptedFrame: boolean
  websocketSendAccepted?: boolean
  websocketReadyStateBefore?: number | null
  websocketReadyStateAfter?: number | null
  websocketOpenBeforeSend?: boolean
  websocketOpenAfterSend?: boolean
  framePayloadSchemaVersion?: string
  frameBytes: number
  frameDimensions: ArtifactFrameDimensions
  mimeType?: string
  frameSendLatencyMs: number | null
  sendStartedAt?: string
  sendCompletedAt?: string
  sendDurationMs?: number
  sendExceptionName?: string | null
  sendExceptionSafeMessage?: string | null
  providerEventCountBefore?: number | null
  providerEventCountAfter?: number | null
  lastProviderEventTypeBefore?: string | null
  lastProviderEventTypeAfter?: string | null
  websocketCloseCode?: number | null
  websocketCloseReasonSafe?: string | null
  websocketCloseWasClean?: boolean | null
  websocketCloseAt?: string | null
  websocketClosedAfterFrameSend?: boolean
  timeFromFrameSendToCloseMs?: number | null
  usageMetadataAfterFrame?: CoreviewUsageMetadataAfterFrame | null
  imageCountAfterFrame?: number | null
  visualResponseObserved?: boolean
  estimatedVisualCost: number | null
  error: string | null
  rawFrameExcluded: true
}

export interface ArtifactFrameSendContext {
  coreviewSendStage: "start" | "refresh"
}

export interface ArtifactFrameSenderStatus {
  websocketReadyState: number | null
  websocketState: string
  websocketOpen: boolean
  websocketCloseCode: number | null
  websocketCloseReasonSafe: string | null
  websocketCloseWasClean: boolean | null
  websocketCloseAt: string | null
  error: string | null
}

export interface ArtifactFrameSender {
  sendArtifactFrame(
    frame: ArtifactEncodedFramePayload,
    context?: ArtifactFrameSendContext,
  ): Promise<ArtifactFrameSendResult> | ArtifactFrameSendResult
  getStatus?(): ArtifactFrameSenderStatus
}

interface StillFrameSendOutcome {
  ok: boolean
  visualInputStatus: "live" | "unsupported" | "error"
  toolAvailability: "available" | "sideband_only" | "unavailable"
  error: string | null
  frameBytes: number | null
  frameDimensions: ArtifactFrameDimensions | null
  frameSendLatencyMs: number | null
  providerAcceptedFrame: boolean
  visualResponseObserved: boolean
  estimatedVisualCost: number | null
  imageCountAfterFrame: number | null
  usageMetadataAfterFrame: CoreviewUsageMetadataAfterFrame | null
  websocketStateBeforeRefresh: string | null
  websocketStateAfterRefresh: string | null
  websocketClosedAfterRefresh: boolean
  websocketClosedAfterFrameSend: boolean
}

export class GeminiStillFrameTransport implements CoReviewMediaTransport {
  readonly kind = "gemini_live_websocket_still_frame_experimental"

  private stopped = false
  private activeSource: CoReviewStartInput["visualSource"] | null = null

  constructor(
    private readonly sender: ArtifactFrameSender,
  ) {}

  async startCoReview(input: CoReviewStartInput): Promise<CoReviewStartResult> {
    this.stopped = false
    this.activeSource = input.visualSource
    const outcome = await this.sendCurrentStillFrame(input.visualSource, input.artifactId, "start")
    if (!outcome.ok) {
      return {
        ...this.errorResult(outcome.error ?? "artifact_frame_send_failed", {
          visualInputStatus: outcome.visualInputStatus,
          toolAvailability: outcome.toolAvailability,
        }),
        frameSentCount: 0,
        frameBytes: outcome.frameBytes,
        frameDimensions: outcome.frameDimensions,
        frameSendLatencyMs: outcome.frameSendLatencyMs,
        providerAcceptedFrame: outcome.providerAcceptedFrame,
        estimatedVisualCost: outcome.estimatedVisualCost,
        visualResponseObserved: outcome.visualResponseObserved,
        imageCountAfterFrame: outcome.imageCountAfterFrame,
        usageMetadataAfterFrame: outcome.usageMetadataAfterFrame,
        websocketClosedAfterFrameSend: outcome.websocketClosedAfterFrameSend,
      }
    }

    const result: CoReviewStartResult = {
      ok: true,
      coReviewSessionId: `${input.sessionId}:still-frame`,
      visualInputStatus: "live",
      toolAvailability: "available",
      videoOrFrameMode: "still_frame",
      normalVoicePaused: false,
      sessionHandoffMs: null,
      estimatedVisualCost: outcome.estimatedVisualCost,
      error: null,
      frameSentCount: 1,
      frameBytes: outcome.frameBytes,
      frameDimensions: outcome.frameDimensions,
      frameSendLatencyMs: outcome.frameSendLatencyMs,
      providerAcceptedFrame: outcome.providerAcceptedFrame,
      visualResponseObserved: outcome.visualResponseObserved,
      imageCountAfterFrame: outcome.imageCountAfterFrame,
      usageMetadataAfterFrame: outcome.usageMetadataAfterFrame,
      websocketClosedAfterFrameSend: outcome.websocketClosedAfterFrameSend,
      toolCallStillWorks: null,
    }
    return result
  }

  async refreshCoReview(input: CoReviewRefreshInput): Promise<CoReviewRefreshResult> {
    if (this.stopped) {
      stopArtifactVisualSource(input.visualSource)
      return this.refreshErrorResult("co_review_stopped", {
        websocketStateBeforeRefresh: null,
        websocketStateAfterRefresh: null,
        websocketClosedAfterRefresh: false,
      })
    }

    this.activeSource = input.visualSource
    const outcome = await this.sendCurrentStillFrame(input.visualSource, input.artifactId, "refresh")
    if (!outcome.ok) {
      return {
        ok: false,
        visualInputStatus: outcome.visualInputStatus,
        toolAvailability: outcome.toolAvailability,
        error: outcome.error ?? "artifact_frame_refresh_failed",
        frameSentCount: 0,
        frameBytes: outcome.frameBytes,
        frameDimensions: outcome.frameDimensions,
        frameSendLatencyMs: outcome.frameSendLatencyMs,
        providerAcceptedFrame: outcome.providerAcceptedFrame,
        visualResponseObserved: outcome.visualResponseObserved,
        estimatedVisualCost: outcome.estimatedVisualCost,
        websocketStateBeforeRefresh: outcome.websocketStateBeforeRefresh,
        websocketStateAfterRefresh: outcome.websocketStateAfterRefresh,
        websocketClosedAfterRefresh: outcome.websocketClosedAfterRefresh,
        imageCountAfterFrame: outcome.imageCountAfterFrame,
        usageMetadataAfterFrame: outcome.usageMetadataAfterFrame,
      }
    }

    return {
      ok: true,
      visualInputStatus: "live",
      toolAvailability: "available",
      error: null,
      frameSentCount: 1,
      frameBytes: outcome.frameBytes,
      frameDimensions: outcome.frameDimensions,
      frameSendLatencyMs: outcome.frameSendLatencyMs,
      providerAcceptedFrame: outcome.providerAcceptedFrame,
      visualResponseObserved: outcome.visualResponseObserved,
      estimatedVisualCost: outcome.estimatedVisualCost,
      websocketStateBeforeRefresh: outcome.websocketStateBeforeRefresh,
      websocketStateAfterRefresh: outcome.websocketStateAfterRefresh,
      websocketClosedAfterRefresh: outcome.websocketClosedAfterRefresh,
      imageCountAfterFrame: outcome.imageCountAfterFrame,
      usageMetadataAfterFrame: outcome.usageMetadataAfterFrame,
    }
  }

  async stopCoReview(): Promise<CoReviewStopResult> {
    const before = this.sender.getStatus?.()
    logCoreviewBreadcrumb("stopClicked", {
      visualInputStatusBefore: this.activeSource ? "live" : "stopped",
      normalVoiceWebsocketStateBefore: before?.websocketState ?? null,
      websocketReadyStateBefore: before?.websocketReadyState ?? null,
    })
    this.stopped = true
    stopArtifactVisualSource(this.activeSource)
    this.activeSource = null
    const after = this.sender.getStatus?.()
    logCoreviewBreadcrumb("stopCompleted", {
      visualInputStatusAfter: "stopped",
      normalVoiceWebsocketStateAfter: after?.websocketState ?? null,
      websocketReadyStateAfter: after?.websocketReadyState ?? null,
      didStopCloseNormalVoiceSocket: Boolean(before?.websocketOpen && after && !after.websocketOpen),
      didStopOnlyClearCoreviewState: true,
    })
    return {
      ok: true,
      visualInputStatus: "stopped",
      normalVoiceRestored: true,
      error: null,
    }
  }

  status(): CoReviewTransportStatus {
    const senderStatus = this.sender.getStatus?.()
    if (senderStatus && !senderStatus.websocketOpen) {
      return {
        kind: this.kind,
        visualTransportSupported: false,
        toolsSupportedInCoReview: false,
        stillFramesSupported: true,
        statusText: `still-frame unavailable: ${senderStatus.error ?? "gemini_live_websocket_not_open"}`,
      }
    }

    return {
      kind: this.kind,
      visualTransportSupported: true,
      toolsSupportedInCoReview: true,
      stillFramesSupported: true,
      statusText: "still-frame mode",
    }
  }

  supportsTools(): boolean {
    return true
  }

  supportsStillFrames(): boolean {
    return true
  }

  private async sendCurrentStillFrame(
    visualSource: CoReviewStartInput["visualSource"],
    artifactId: string,
    stage: "start" | "refresh",
  ): Promise<StillFrameSendOutcome> {
    const preflightStatus = this.sender.getStatus?.()
    if (preflightStatus && !preflightStatus.websocketOpen) {
      stopArtifactVisualSource(visualSource)
      logCoreviewBreadcrumb(stage === "refresh" ? "refreshFramePreflightFailed" : "sendArtifactFramePreflightFailed", {
        error: preflightStatus.error ?? "gemini_live_websocket_not_open",
        websocketReadyStateBefore: preflightStatus.websocketReadyState,
        websocketState: preflightStatus.websocketState,
        websocketCloseCode: preflightStatus.websocketCloseCode,
        websocketCloseReasonSafe: preflightStatus.websocketCloseReasonSafe,
        websocketCloseWasClean: preflightStatus.websocketCloseWasClean,
        websocketCloseAt: preflightStatus.websocketCloseAt,
      })
      return this.frameErrorOutcome(preflightStatus.error ?? "gemini_live_websocket_not_open", {
        visualInputStatus: "error",
        toolAvailability: "unavailable",
        websocketStateBeforeRefresh: preflightStatus.websocketState,
        websocketStateAfterRefresh: preflightStatus.websocketState,
        websocketClosedAfterRefresh: false,
      })
    }

    logCoreviewBreadcrumb(stage === "refresh" ? "refreshFrameEncodeStarted" : "frameEncodeStarted", {
      artifactId,
      sourceKind: visualSource.kind,
      sourceStatus: visualSource.status,
    })
    const encoded = await encodeArtifactStillFrame(visualSource)
    if (encoded.ok === false) {
      stopArtifactVisualSource(visualSource)
      logCoreviewBreadcrumb(stage === "refresh" ? "coReviewRefreshError" : "coReviewStartError", {
        error: encoded.reason,
        stage: "frame_encode",
      })
      return this.frameErrorOutcome(encoded.reason)
    }
    logCoreviewBreadcrumb(stage === "refresh" ? "refreshFrameEncodeSucceeded" : "frameEncodeSucceeded", {
      artifactId: encoded.payload.artifactId,
      frameBytes: encoded.payload.byteLength,
      frameDimensions: encoded.payload.dimensions,
      frameMimeType: encoded.payload.mimeType,
    })
    if (this.stopped) {
      stopArtifactVisualSource(visualSource)
      const error = stage === "refresh" ? "co_review_stopped_before_refresh_frame_send" : "co_review_stopped_before_frame_send"
      logCoreviewBreadcrumb(stage === "refresh" ? "coReviewRefreshError" : "coReviewStartError", {
        error,
        stage: "before_frame_send",
      })
      return this.frameErrorOutcome(error)
    }

    const senderStatusBefore = this.sender.getStatus?.()
    logCoreviewBreadcrumb("sendArtifactFrameAvailable", {
      available: typeof this.sender.sendArtifactFrame === "function",
      refresh: stage === "refresh",
    })
    logCoreviewBreadcrumb(stage === "refresh" ? "refreshFrameSendAttempted" : "sendArtifactFrameAttempted", {
      artifactId: encoded.payload.artifactId,
      frameBytes: encoded.payload.byteLength,
      frameDimensions: encoded.payload.dimensions,
      frameMimeType: encoded.payload.mimeType,
    })
    const sent = await this.sender.sendArtifactFrame(encoded.payload, { coreviewSendStage: stage })
    const senderStatusAfter = this.sender.getStatus?.()
    const websocketStateBeforeRefresh = websocketReadyStateLabel(sent.websocketReadyStateBefore ?? null)
      ?? senderStatusBefore?.websocketState
      ?? null
    const websocketStateAfterRefresh = websocketReadyStateLabel(sent.websocketReadyStateAfter ?? null)
      ?? senderStatusAfter?.websocketState
      ?? null
    const websocketClosedAfterRefresh = sent.websocketClosedAfterFrameSend
      ?? Boolean((senderStatusBefore?.websocketOpen ?? sent.websocketOpenBeforeSend) && !(senderStatusAfter?.websocketOpen ?? sent.websocketOpenAfterSend))

    logCoreviewBreadcrumb(stage === "refresh" ? "refreshFrameResult" : "sendArtifactFrameResult", {
      ok: sent.ok,
      supported: sent.supported,
      providerAcceptedFrame: sent.providerAcceptedFrame,
      websocketSendAccepted: sent.websocketSendAccepted ?? null,
      websocketReadyStateBefore: sent.websocketReadyStateBefore ?? null,
      websocketReadyStateAfter: sent.websocketReadyStateAfter ?? null,
      websocketOpenBeforeSend: sent.websocketOpenBeforeSend ?? null,
      websocketOpenAfterSend: sent.websocketOpenAfterSend ?? null,
      websocketStateBeforeRefresh,
      websocketStateAfterRefresh,
      websocketClosedAfterRefresh,
      framePayloadSchemaVersion: sent.framePayloadSchemaVersion ?? null,
      frameBytes: sent.frameBytes,
      frameDimensions: sent.frameDimensions,
      mimeType: sent.mimeType ?? null,
      frameSendLatencyMs: sent.frameSendLatencyMs,
      sendStartedAt: sent.sendStartedAt ?? null,
      sendCompletedAt: sent.sendCompletedAt ?? null,
      sendDurationMs: sent.sendDurationMs ?? null,
      sendExceptionName: sent.sendExceptionName ?? null,
      sendExceptionSafeMessage: sent.sendExceptionSafeMessage ?? null,
      providerEventCountBefore: sent.providerEventCountBefore ?? null,
      providerEventCountAfter: sent.providerEventCountAfter ?? null,
      lastProviderEventTypeBefore: sent.lastProviderEventTypeBefore ?? null,
      lastProviderEventTypeAfter: sent.lastProviderEventTypeAfter ?? null,
      websocketCloseCode: sent.websocketCloseCode ?? null,
      websocketCloseReasonSafe: sent.websocketCloseReasonSafe ?? null,
      websocketCloseWasClean: sent.websocketCloseWasClean ?? null,
      websocketCloseAt: sent.websocketCloseAt ?? null,
      websocketClosedAfterFrameSend: sent.websocketClosedAfterFrameSend ?? false,
      timeFromFrameSendToCloseMs: sent.timeFromFrameSendToCloseMs ?? null,
      usageMetadataAfterFrame: sent.usageMetadataAfterFrame ? "present" : null,
      imageCountAfterFrame: sent.imageCountAfterFrame ?? null,
      visualResponseObserved: sent.visualResponseObserved ?? false,
      estimatedVisualCost: sent.estimatedVisualCost,
      error: sent.error,
    })
    if (!sent.ok) {
      stopArtifactVisualSource(visualSource)
      return this.frameErrorOutcome(sent.error ?? "artifact_frame_send_failed", {
        visualInputStatus: sent.error === "frame_send_closed_gemini_websocket" ? "error" : "unsupported",
        toolAvailability: sent.error === "frame_send_closed_gemini_websocket" ? "unavailable" : "sideband_only",
        frameBytes: sent.frameBytes,
        frameDimensions: sent.frameDimensions,
        frameSendLatencyMs: sent.frameSendLatencyMs,
        providerAcceptedFrame: sent.providerAcceptedFrame,
        visualResponseObserved: sent.visualResponseObserved ?? false,
        estimatedVisualCost: sent.estimatedVisualCost,
        imageCountAfterFrame: sent.imageCountAfterFrame ?? null,
        usageMetadataAfterFrame: sent.usageMetadataAfterFrame ?? null,
        websocketStateBeforeRefresh,
        websocketStateAfterRefresh,
        websocketClosedAfterRefresh,
        websocketClosedAfterFrameSend: sent.websocketClosedAfterFrameSend ?? websocketClosedAfterRefresh,
      })
    }

    return {
      ok: true,
      visualInputStatus: "live",
      toolAvailability: "available",
      error: null,
      frameBytes: sent.frameBytes,
      frameDimensions: sent.frameDimensions,
      frameSendLatencyMs: sent.frameSendLatencyMs ?? encoded.encodeLatencyMs,
      providerAcceptedFrame: sent.providerAcceptedFrame,
      visualResponseObserved: sent.visualResponseObserved ?? false,
      estimatedVisualCost: sent.estimatedVisualCost,
      imageCountAfterFrame: sent.imageCountAfterFrame ?? null,
      usageMetadataAfterFrame: sent.usageMetadataAfterFrame ?? null,
      websocketStateBeforeRefresh,
      websocketStateAfterRefresh,
      websocketClosedAfterRefresh,
      websocketClosedAfterFrameSend: sent.websocketClosedAfterFrameSend ?? websocketClosedAfterRefresh,
    }
  }

  private frameErrorOutcome(
    error: string,
    overrides: Partial<StillFrameSendOutcome> = {},
  ): StillFrameSendOutcome {
    return {
      ok: false,
      visualInputStatus: overrides.visualInputStatus ?? "unsupported",
      toolAvailability: overrides.toolAvailability ?? "sideband_only",
      error,
      frameBytes: overrides.frameBytes ?? null,
      frameDimensions: overrides.frameDimensions ?? null,
      frameSendLatencyMs: overrides.frameSendLatencyMs ?? null,
      providerAcceptedFrame: overrides.providerAcceptedFrame ?? false,
      visualResponseObserved: overrides.visualResponseObserved ?? false,
      estimatedVisualCost: overrides.estimatedVisualCost ?? null,
      imageCountAfterFrame: overrides.imageCountAfterFrame ?? null,
      usageMetadataAfterFrame: overrides.usageMetadataAfterFrame ?? null,
      websocketStateBeforeRefresh: overrides.websocketStateBeforeRefresh ?? null,
      websocketStateAfterRefresh: overrides.websocketStateAfterRefresh ?? null,
      websocketClosedAfterRefresh: overrides.websocketClosedAfterRefresh ?? false,
      websocketClosedAfterFrameSend: overrides.websocketClosedAfterFrameSend ?? false,
    }
  }

  private errorResult(
    error: string,
    overrides: Partial<Pick<CoReviewStartResult, "visualInputStatus" | "toolAvailability">> = {},
  ): CoReviewStartResult {
    return {
      ok: false,
      coReviewSessionId: null,
      visualInputStatus: overrides.visualInputStatus ?? "unsupported",
      toolAvailability: overrides.toolAvailability ?? "sideband_only",
      videoOrFrameMode: "none",
      normalVoicePaused: false,
      sessionHandoffMs: null,
      estimatedVisualCost: null,
      error,
    }
  }

  private refreshErrorResult(
    error: string,
    overrides: Pick<
      CoReviewRefreshResult,
      "websocketStateBeforeRefresh" | "websocketStateAfterRefresh" | "websocketClosedAfterRefresh"
    >,
  ): CoReviewRefreshResult {
    return {
      ok: false,
      visualInputStatus: "error",
      toolAvailability: "unavailable",
      error,
      frameSentCount: 0,
      frameBytes: null,
      frameDimensions: null,
      frameSendLatencyMs: null,
      providerAcceptedFrame: false,
      visualResponseObserved: false,
      estimatedVisualCost: null,
      ...overrides,
    }
  }
}

function websocketReadyStateLabel(readyState: number | null): string | null {
  if (readyState === 0) return "connecting"
  if (readyState === 1) return "open"
  if (readyState === 2) return "closing"
  if (readyState === 3) return "closed"
  return null
}

function logCoreviewBreadcrumb(event: string, details: Record<string, unknown> = {}) {
  if (typeof console === "undefined") return
  console.info?.(`[coreview] ${event}`, {
    ...details,
    rawFrameExcluded: true,
  })
}
