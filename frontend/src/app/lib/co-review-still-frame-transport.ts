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
  frameBytes: number
  frameDimensions: ArtifactFrameDimensions
  frameSendLatencyMs: number | null
  estimatedVisualCost: number | null
  error: string | null
  rawFrameExcluded: true
}

export interface ArtifactFrameSender {
  sendArtifactFrame(frame: ArtifactEncodedFramePayload): Promise<ArtifactFrameSendResult> | ArtifactFrameSendResult
}

export class GeminiStillFrameTransport implements CoReviewMediaTransport {
  readonly kind = "gemini_live_websocket_still_frame_experimental"

  private stopped = false
  private activeSource: CoReviewStartInput["visualSource"] | null = null

  constructor(private readonly sender: ArtifactFrameSender) {}

  async startCoReview(input: CoReviewStartInput): Promise<CoReviewStartResult> {
    this.stopped = false
    this.activeSource = input.visualSource

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
      frameBytes: sent.frameBytes,
      frameDimensions: sent.frameDimensions,
      frameSendLatencyMs: sent.frameSendLatencyMs,
      estimatedVisualCost: sent.estimatedVisualCost,
      error: sent.error,
    })
    if (!sent.ok) {
      stopArtifactVisualSource(input.visualSource)
      return {
        ...this.errorResult(sent.error ?? "artifact_frame_send_failed"),
        frameSentCount: 0,
        frameBytes: sent.frameBytes,
        frameDimensions: sent.frameDimensions,
        frameSendLatencyMs: sent.frameSendLatencyMs,
        providerAcceptedFrame: sent.providerAcceptedFrame,
        estimatedVisualCost: sent.estimatedVisualCost,
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
      visualResponseObserved: false,
      toolCallStillWorks: null,
    }
  }

  async stopCoReview(): Promise<CoReviewStopResult> {
    this.stopped = true
    stopArtifactVisualSource(this.activeSource)
    this.activeSource = null
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

  private errorResult(error: string): CoReviewStartResult {
    return {
      ok: false,
      coReviewSessionId: null,
      visualInputStatus: "unsupported",
      toolAvailability: "sideband_only",
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
