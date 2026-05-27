import { stopArtifactVisualSource } from "./co-review-capture"
import {
  encodeArtifactStillFrame,
  type ArtifactEncodedFramePayload,
  type ArtifactFrameDimensions,
} from "./co-review-frame"
import type {
  CoReviewMediaTransport,
  CoReviewStartInput,
  CoReviewStartResult,
  CoReviewStopResult,
  CoReviewTransportStatus,
} from "./co-review-transport"

export interface ArtifactFrameSendResult {
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
  usageMetadataAfterFrame?: Record<string, unknown> | null
  imageCountAfterFrame?: number | null
  visualResponseObserved?: boolean
  estimatedVisualCost: number | null
  error: string | null
  rawFrameExcluded: true
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
  sendArtifactFrame(frame: ArtifactEncodedFramePayload): Promise<ArtifactFrameSendResult> | ArtifactFrameSendResult
  getStatus?(): ArtifactFrameSenderStatus
}

export class GeminiStillFrameTransport implements CoReviewMediaTransport {
  readonly kind = "gemini_live_websocket_still_frame_experimental"

  private stopped = false
  private activeSource: CoReviewStartInput["visualSource"] | null = null

  constructor(private readonly sender: ArtifactFrameSender) {}

  async startCoReview(input: CoReviewStartInput): Promise<CoReviewStartResult> {
    this.stopped = false
    this.activeSource = input.visualSource
    const preflightStatus = this.sender.getStatus?.()
    if (preflightStatus && !preflightStatus.websocketOpen) {
      stopArtifactVisualSource(input.visualSource)
      logCoreviewBreadcrumb("sendArtifactFramePreflightFailed", {
        error: preflightStatus.error ?? "gemini_live_websocket_not_open",
        websocketReadyStateBefore: preflightStatus.websocketReadyState,
        websocketState: preflightStatus.websocketState,
        websocketCloseCode: preflightStatus.websocketCloseCode,
        websocketCloseReasonSafe: preflightStatus.websocketCloseReasonSafe,
        websocketCloseWasClean: preflightStatus.websocketCloseWasClean,
        websocketCloseAt: preflightStatus.websocketCloseAt,
      })
      return this.errorResult(preflightStatus.error ?? "gemini_live_websocket_not_open", {
        visualInputStatus: "error",
        toolAvailability: "unavailable",
      })
    }

    logCoreviewBreadcrumb("frameEncodeStarted", {
      artifactId: input.artifactId,
      sourceKind: input.visualSource.kind,
      sourceStatus: input.visualSource.status,
    })
    const encoded = await encodeArtifactStillFrame(input.visualSource)
    if (encoded.ok === false) {
      stopArtifactVisualSource(input.visualSource)
      logCoreviewBreadcrumb("coReviewStartError", {
        error: encoded.reason,
        stage: "frame_encode",
      })
      return this.errorResult(encoded.reason)
    }
    logCoreviewBreadcrumb("frameEncodeSucceeded", {
      artifactId: encoded.payload.artifactId,
      frameBytes: encoded.payload.byteLength,
      frameDimensions: encoded.payload.dimensions,
      frameMimeType: encoded.payload.mimeType,
    })
    if (this.stopped) {
      logCoreviewBreadcrumb("coReviewStartError", {
        error: "co_review_stopped_before_frame_send",
        stage: "before_frame_send",
      })
      return this.errorResult("co_review_stopped_before_frame_send")
    }

    logCoreviewBreadcrumb("sendArtifactFrameAvailable", {
      available: typeof this.sender.sendArtifactFrame === "function",
    })
    logCoreviewBreadcrumb("sendArtifactFrameAttempted", {
      artifactId: encoded.payload.artifactId,
      frameBytes: encoded.payload.byteLength,
      frameDimensions: encoded.payload.dimensions,
      frameMimeType: encoded.payload.mimeType,
    })
    const sent = await this.sender.sendArtifactFrame(encoded.payload)
    logCoreviewBreadcrumb("sendArtifactFrameResult", {
      ok: sent.ok,
      supported: sent.supported,
      providerAcceptedFrame: sent.providerAcceptedFrame,
      websocketSendAccepted: sent.websocketSendAccepted ?? null,
      websocketReadyStateBefore: sent.websocketReadyStateBefore ?? null,
      websocketReadyStateAfter: sent.websocketReadyStateAfter ?? null,
      websocketOpenBeforeSend: sent.websocketOpenBeforeSend ?? null,
      websocketOpenAfterSend: sent.websocketOpenAfterSend ?? null,
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
      stopArtifactVisualSource(input.visualSource)
      return {
        ...this.errorResult(sent.error ?? "artifact_frame_send_failed", {
          visualInputStatus: sent.error === "frame_send_closed_gemini_websocket" ? "error" : "unsupported",
          toolAvailability: sent.error === "frame_send_closed_gemini_websocket" ? "unavailable" : "sideband_only",
        }),
        frameSentCount: 0,
        frameBytes: sent.frameBytes,
        frameDimensions: sent.frameDimensions,
        frameSendLatencyMs: sent.frameSendLatencyMs,
        providerAcceptedFrame: sent.providerAcceptedFrame,
        estimatedVisualCost: sent.estimatedVisualCost,
        visualResponseObserved: sent.visualResponseObserved ?? false,
      }
    }

    return {
      ok: true,
      coReviewSessionId: `${input.sessionId}:still-frame`,
      visualInputStatus: "live",
      toolAvailability: "available",
      videoOrFrameMode: "still_frame",
      normalVoicePaused: false,
      sessionHandoffMs: null,
      estimatedVisualCost: sent.estimatedVisualCost,
      error: null,
      frameSentCount: 1,
      frameBytes: sent.frameBytes,
      frameDimensions: sent.frameDimensions,
      frameSendLatencyMs: sent.frameSendLatencyMs ?? encoded.encodeLatencyMs,
      providerAcceptedFrame: sent.providerAcceptedFrame,
      visualResponseObserved: sent.visualResponseObserved ?? false,
      toolCallStillWorks: null,
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

  async sendFrame(_frame: Blob): Promise<void> {
    if (this.stopped) {
      throw new Error("co_review_stopped")
    }
  }

  status(): CoReviewTransportStatus {
    const senderStatus = this.sender.getStatus?.()
    if (senderStatus && !senderStatus.websocketOpen) {
      return {
        kind: this.kind,
        visualTransportSupported: false,
        toolsSupportedInCoReview: false,
        continuousVideoSupported: false,
        stillFramesSupported: true,
        statusText: `still-frame unavailable: ${senderStatus.error ?? "gemini_live_websocket_not_open"}`,
      }
    }

    return {
      kind: this.kind,
      visualTransportSupported: true,
      toolsSupportedInCoReview: true,
      continuousVideoSupported: false,
      stillFramesSupported: true,
      statusText: "still-frame mode",
    }
  }

  supportsTools(): boolean {
    return true
  }

  supportsContinuousVideo(): boolean {
    return false
  }

  supportsStillFrames(): boolean {
    return true
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
}

function logCoreviewBreadcrumb(event: string, details: Record<string, unknown> = {}) {
  if (typeof console === "undefined") return
  console.info?.(`[coreview] ${event}`, {
    ...details,
    rawFrameExcluded: true,
  })
}
