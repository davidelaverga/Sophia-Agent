import { afterEach, describe, expect, it, vi } from "vitest"

import type { ArtifactVisualSource } from "../../app/lib/co-review-capture"
import { GeminiStillFrameTransport } from "../../app/lib/co-review-still-frame-transport"
import {
  AudioWebSocketUnsupportedTransport,
  CoReviewSessionMachine,
  initialCoReviewState,
  safeCoReviewTelemetryFromState,
} from "../../app/lib/co-review-transport"

const unsupportedVisualSource: ArtifactVisualSource = {
  kind: "unsupported",
  status: "unsupported",
  artifactId: "artifact-1",
  element: null,
  reason: "artifact_canvas_not_found",
}

const originalToBlob = HTMLCanvasElement.prototype.toBlob

afterEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value: originalToBlob,
  })
})

function readyCanvasSource(): ArtifactVisualSource {
  const canvas = document.createElement("canvas")
  canvas.width = 320
  canvas.height = 160
  return {
    kind: "canvas_element",
    status: "ready",
    artifactId: "artifact-1",
    element: canvas,
    reason: null,
  }
}

function openWebsocketStatus() {
  return {
    websocketReadyState: 1,
    websocketState: "open",
    websocketOpen: true,
    websocketCloseCode: null,
    websocketCloseReasonSafe: null,
    websocketCloseWasClean: null,
    websocketCloseAt: null,
    error: null,
  }
}

function closedWebsocketStatus() {
  return {
    websocketReadyState: 3,
    websocketState: "closed",
    websocketOpen: false,
    websocketCloseCode: 1007,
    websocketCloseReasonSafe: "invalid frame",
    websocketCloseWasClean: false,
    websocketCloseAt: "2026-05-27T00:00:00.000Z",
    error: "gemini_live_websocket_not_open",
  }
}

function mockCanvasEncoding() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)

  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value(callback: BlobCallback, mimeType?: string) {
      callback(new Blob([new Uint8Array(32)], { type: mimeType || "image/jpeg" }))
    },
  })
}

describe("co-review dual-path state machine", () => {
  it("starts in normal_voice", () => {
    expect(initialCoReviewState().state).toBe("normal_voice")
  })

  it("enters starting and then a safe error for the current unsupported transport", async () => {
    const states: string[] = []
    const machine = new CoReviewSessionMachine({
      transport: new AudioWebSocketUnsupportedTransport(),
      onStateChange: (state) => states.push(state.state),
      clock: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(38),
    })

    const state = await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: unsupportedVisualSource,
    })

    expect(states).toEqual(["co_review_starting", "co_review_error"])
    expect(state.state).toBe("co_review_error")
    expect(state.error).toBe("current_gemini_audio_websocket_has_no_artifact_media_input")
    expect(state.visualInputStatus).toBe("unsupported")
    expect(state.toolAvailability).toBe("sideband_only")
    expect(state.coReviewStartLatencyMs).toBe(28)
  })

  it("stopping co-review returns to normal_voice_restored", async () => {
    const machine = new CoReviewSessionMachine()

    await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: unsupportedVisualSource,
    })
    const state = await machine.stopCoReview()

    expect(state.state).toBe("normal_voice_restored")
    expect(state.visualInputStatus).toBe("stopped")
    expect(state.normalVoiceRestored).toBe(true)
  })

  it("safe telemetry excludes raw frames and raw artifact text", () => {
    const state = {
      ...initialCoReviewState("test_transport"),
      normalSessionId: "normal-1",
      coReviewSessionId: "coreview-1",
      frameCount: 3,
      rawArtifactText: "do not include me",
      rawFrameData: "base64-do-not-include-me",
    }

    const telemetry = safeCoReviewTelemetryFromState(state)
    const serialized = JSON.stringify(telemetry)

    expect(serialized).toContain("normal-1")
    expect(serialized).not.toContain("do not include me")
    expect(serialized).not.toContain("base64-do-not-include-me")
    expect(Object.keys(telemetry)).not.toContain("rawArtifactText")
    expect(Object.keys(telemetry)).not.toContain("rawFrameData")
    expect(telemetry).toMatchObject({
      rawFrameExcluded: true,
      rawProviderPayloadExcluded: true,
      rawArtifactTextExcluded: true,
    })
  })

  it("enters still_frame mode and records safe frame telemetry when the sender accepts a frame", async () => {
    mockCanvasEncoding()
    const sender = {
      sendArtifactFrame: vi.fn((frame) => ({
        ok: true,
        supported: true,
        providerAcceptedFrame: false,
        websocketSendAccepted: true,
        frameBytes: frame.byteLength,
        frameDimensions: frame.dimensions,
        frameSendLatencyMs: 12,
        estimatedVisualCost: null,
        error: null,
        rawFrameExcluded: true as const,
      })),
    }
    const transport = new GeminiStillFrameTransport(sender)
    const machine = new CoReviewSessionMachine({ transport })

    const state = await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
      exactTextAvailable: true,
    })

    expect(state.state).toBe("co_review_live")
    expect(state.videoOrFrameMode).toBe("still_frame")
    expect(state.frameSentCount).toBe(1)
    expect(state.initialFrameSent).toBe(true)
    expect(state.lastFrameSentAt).not.toBeNull()
    expect(state.visualFresh).toBe(true)
    expect(state.visualFreshForTurn).toBe(true)
    expect(state.exactTextAvailable).toBe(true)
    expect(state.refreshFrameCount).toBe(0)
    expect(state.totalFrameBytes).toBe(32)
    expect(state.frameBytes).toBe(32)
    expect(state.frameDimensions).toEqual({ width: 320, height: 160 })
    expect(state.frameSendLatencyMs).toBe(12)
    expect(state.providerAcceptedFrame).toBe(false)
    expect(sender.sendArtifactFrame).toHaveBeenCalledTimes(1)
    expect(sender.sendArtifactFrame).toHaveBeenCalledWith(
      expect.objectContaining({ visualSourceKind: "canvas_element" }),
      { coreviewSendStage: "start" },
    )
  })

  it("internal refreshCoReview sends one additional artifact frame and records safe telemetry", async () => {
    mockCanvasEncoding()
    const sender = {
      getStatus: vi.fn(() => openWebsocketStatus()),
      sendArtifactFrame: vi.fn((frame) => ({
        ok: true,
        supported: true,
        providerAcceptedFrame: false,
        websocketSendAccepted: true,
        websocketReadyStateBefore: 1,
        websocketReadyStateAfter: 1,
        websocketOpenBeforeSend: true,
        websocketOpenAfterSend: true,
        framePayloadSchemaVersion: "realtimeInput.video.v1",
        frameBytes: frame.byteLength,
        frameDimensions: frame.dimensions,
        mimeType: frame.mimeType,
        frameSendLatencyMs: 11,
        estimatedVisualCost: null,
        error: null,
        rawFrameExcluded: true as const,
      })),
    }
    const transport = new GeminiStillFrameTransport(sender)
    const machine = new CoReviewSessionMachine({ transport })

    await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })
    const state = await machine.refreshCoReview({
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })
    const telemetry = safeCoReviewTelemetryFromState(state)
    const serialized = JSON.stringify(telemetry)

    expect(state.state).toBe("co_review_live")
    expect(state.frameSentCount).toBe(2)
    expect(state.frameCount).toBe(2)
    expect(state.refreshFrameCount).toBe(1)
    expect(state.totalFrameBytes).toBe(64)
    expect(state.refreshFrameRequested).toBe(true)
    expect(state.refreshFrameResult).toBe("success")
    expect(state.refreshFrameLatencyMs).not.toBeNull()
    expect(state.lastFrameBytes).toBe(32)
    expect(state.lastFrameDimensions).toEqual({ width: 320, height: 160 })
    expect(state.websocketStateBeforeRefresh).toBe("open")
    expect(state.websocketStateAfterRefresh).toBe("open")
    expect(state.websocketClosedAfterRefresh).toBe(false)
    expect(sender.sendArtifactFrame).toHaveBeenCalledTimes(2)
    expect(telemetry).toMatchObject({
      refreshFrameRequested: true,
      refreshFrameResult: "success",
      frameSentCount: 2,
      initialFrameSent: true,
      refreshFrameCount: 1,
      totalFrameBytes: 64,
      lastFrameBytes: 32,
      lastFrameDimensions: { width: 320, height: 160 },
      websocketStateBeforeRefresh: "open",
      websocketStateAfterRefresh: "open",
      websocketClosedAfterRefresh: false,
      websocketClosedAfterFrameCount: 0,
      rawFrameExcluded: true,
      rawProviderPayloadExcluded: true,
      rawArtifactTextExcluded: true,
    })
    expect(serialized).not.toContain("base64")
  })

  it("shows a safe error before encoding when the Gemini websocket is closed", async () => {
    mockCanvasEncoding()
    const sender = {
      getStatus: vi.fn(() => ({
        websocketReadyState: 3,
        websocketState: "closed",
        websocketOpen: false,
        websocketCloseCode: 1007,
        websocketCloseReasonSafe: "invalid frame",
        websocketCloseWasClean: false,
        websocketCloseAt: "2026-05-27T00:00:00.000Z",
        error: "gemini_live_websocket_not_open",
      })),
      sendArtifactFrame: vi.fn(),
    }
    const transport = new GeminiStillFrameTransport(sender)
    const machine = new CoReviewSessionMachine({ transport })

    const state = await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })

    expect(state.state).toBe("co_review_error")
    expect(state.error).toBe("gemini_live_websocket_not_open")
    expect(state.visualInputStatus).toBe("error")
    expect(state.toolAvailability).toBe("unavailable")
    expect(sender.sendArtifactFrame).not.toHaveBeenCalled()
    expect(state.frameSendFailureCount).toBe(1)
    expect(state.lastFrameSendFailureReason).toBe("gemini_live_websocket_not_open")
  })

  it("blocks internal refreshCoReview with a safe reason when the websocket closes after start", async () => {
    mockCanvasEncoding()
    const getStatus = vi.fn()
      .mockReturnValueOnce(openWebsocketStatus())
      .mockReturnValueOnce(openWebsocketStatus())
      .mockReturnValueOnce(openWebsocketStatus())
      .mockReturnValue(closedWebsocketStatus())
    const sender = {
      getStatus,
      sendArtifactFrame: vi.fn((frame) => ({
        ok: true,
        supported: true,
        providerAcceptedFrame: false,
        websocketSendAccepted: true,
        frameBytes: frame.byteLength,
        frameDimensions: frame.dimensions,
        frameSendLatencyMs: 5,
        estimatedVisualCost: null,
        error: null,
        rawFrameExcluded: true as const,
      })),
    }
    const transport = new GeminiStillFrameTransport(sender)
    const machine = new CoReviewSessionMachine({ transport })

    await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })
    const state = await machine.refreshCoReview({
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })

    expect(state.state).toBe("co_review_error")
    expect(state.error).toBe("gemini_live_websocket_not_open")
    expect(state.refreshFrameResult).toBe("error")
    expect(state.refreshErrorSafeReason).toBe("gemini_live_websocket_not_open")
    expect(state.websocketStateBeforeRefresh).toBe("closed")
    expect(state.websocketStateAfterRefresh).toBe("closed")
    expect(sender.sendArtifactFrame).toHaveBeenCalledTimes(1)
  })

  it("does not enter looking state when frame send closes the Gemini websocket", async () => {
    mockCanvasEncoding()
    const sender = {
      getStatus: vi.fn(() => ({
        websocketReadyState: 1,
        websocketState: "open",
        websocketOpen: true,
        websocketCloseCode: null,
        websocketCloseReasonSafe: null,
        websocketCloseWasClean: null,
        websocketCloseAt: null,
        error: null,
      })),
      sendArtifactFrame: vi.fn((frame) => ({
        ok: false,
        supported: true,
        providerAcceptedFrame: false,
        websocketSendAccepted: true,
        websocketReadyStateBefore: 1,
        websocketReadyStateAfter: 3,
        websocketOpenBeforeSend: true,
        websocketOpenAfterSend: false,
        framePayloadSchemaVersion: "realtimeInput.video.v1",
        frameBytes: frame.byteLength,
        frameDimensions: frame.dimensions,
        mimeType: frame.mimeType,
        frameSendLatencyMs: 9,
        websocketClosedAfterFrameSend: true,
        websocketCloseCode: 1007,
        websocketCloseReasonSafe: "invalid video frame payload",
        websocketCloseWasClean: false,
        websocketCloseAt: "2026-05-27T00:00:00.000Z",
        timeFromFrameSendToCloseMs: 5,
        estimatedVisualCost: null,
        visualResponseObserved: false,
        error: "frame_send_closed_gemini_websocket",
        rawFrameExcluded: true as const,
      })),
    }
    const transport = new GeminiStillFrameTransport(sender)
    const machine = new CoReviewSessionMachine({ transport })

    const state = await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })

    expect(state.state).toBe("co_review_error")
    expect(state.error).toBe("frame_send_closed_gemini_websocket")
    expect(state.visualInputStatus).toBe("error")
    expect(state.toolAvailability).toBe("unavailable")
    expect(state.frameSentCount).toBe(0)
    expect(state.frameSendFailureCount).toBe(1)
    expect(state.lastFrameSendFailureReason).toBe("frame_send_closed_gemini_websocket")
    expect(state.websocketClosedAfterFrameCount).toBe(1)
  })

  it("clears looking state when refresh closes the Gemini websocket", async () => {
    mockCanvasEncoding()
    const sender = {
      getStatus: vi.fn(() => openWebsocketStatus()),
      sendArtifactFrame: vi.fn()
        .mockImplementationOnce((frame) => ({
          ok: true,
          supported: true,
          providerAcceptedFrame: false,
          websocketSendAccepted: true,
          websocketReadyStateBefore: 1,
          websocketReadyStateAfter: 1,
          websocketOpenBeforeSend: true,
          websocketOpenAfterSend: true,
          framePayloadSchemaVersion: "realtimeInput.video.v1",
          frameBytes: frame.byteLength,
          frameDimensions: frame.dimensions,
          mimeType: frame.mimeType,
          frameSendLatencyMs: 5,
          estimatedVisualCost: null,
          error: null,
          rawFrameExcluded: true as const,
        }))
        .mockImplementationOnce((frame) => ({
          ok: false,
          supported: true,
          providerAcceptedFrame: false,
          websocketSendAccepted: true,
          websocketReadyStateBefore: 1,
          websocketReadyStateAfter: 3,
          websocketOpenBeforeSend: true,
          websocketOpenAfterSend: false,
          framePayloadSchemaVersion: "realtimeInput.video.v1",
          frameBytes: frame.byteLength,
          frameDimensions: frame.dimensions,
          mimeType: frame.mimeType,
          frameSendLatencyMs: 9,
          estimatedVisualCost: null,
          websocketClosedAfterFrameSend: true,
          error: "frame_send_closed_gemini_websocket",
          rawFrameExcluded: true as const,
        })),
    }
    const transport = new GeminiStillFrameTransport(sender)
    const machine = new CoReviewSessionMachine({ transport })

    await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })
    const state = await machine.refreshCoReview({
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })

    expect(state.state).toBe("co_review_error")
    expect(state.error).toBe("frame_send_closed_gemini_websocket")
    expect(state.refreshFrameResult).toBe("error")
    expect(state.refreshErrorSafeReason).toBe("frame_send_closed_gemini_websocket")
    expect(state.websocketStateBeforeRefresh).toBe("open")
    expect(state.websocketStateAfterRefresh).toBe("closed")
    expect(state.websocketClosedAfterRefresh).toBe(true)
    expect(state.frameSentCount).toBe(1)
    expect(state.frameSendFailureCount).toBe(1)
    expect(state.lastFrameSendFailureReason).toBe("frame_send_closed_gemini_websocket")
    expect(state.websocketClosedAfterFrameCount).toBe(1)
    expect(sender.sendArtifactFrame).toHaveBeenCalledTimes(2)
  })

  it("Stop Looking restores normal voice and blocks later refresh sends", async () => {
    mockCanvasEncoding()
    const transport = new GeminiStillFrameTransport({
      sendArtifactFrame: vi.fn((frame) => ({
        ok: true,
        supported: true,
        providerAcceptedFrame: false,
        websocketSendAccepted: true,
        frameBytes: frame.byteLength,
        frameDimensions: frame.dimensions,
        frameSendLatencyMs: 3,
        estimatedVisualCost: null,
        error: null,
        rawFrameExcluded: true as const,
      })),
    })
    const machine = new CoReviewSessionMachine({ transport })

    await machine.startCoReview({
      normalSessionId: "normal-1",
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })
    const stopped = await machine.stopCoReview()
    const state = await machine.refreshCoReview({
      artifactId: "artifact-1",
      visualSource: readyCanvasSource(),
    })
    expect(stopped.state).toBe("normal_voice_restored")
    expect(stopped.visualFresh).toBe(false)
    expect(stopped.visualFreshForTurn).toBe(false)
    expect(state.state).toBe("normal_voice_restored")
    expect(state.refreshFrameResult).toBe("blocked")
  })
})
