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
  stream: null,
  reason: "artifact_canvas_not_found",
  frameRate: null,
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
    stream: null,
    reason: null,
    frameRate: null,
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
    })

    expect(state.state).toBe("co_review_live")
    expect(state.videoOrFrameMode).toBe("still_frame")
    expect(state.frameSentCount).toBe(1)
    expect(state.frameBytes).toBe(32)
    expect(state.frameDimensions).toEqual({ width: 320, height: 160 })
    expect(state.frameSendLatencyMs).toBe(12)
    expect(state.providerAcceptedFrame).toBe(false)
    expect(sender.sendArtifactFrame).toHaveBeenCalledTimes(1)
  })

  it("Stop Looking disables future sends on the still-frame transport", async () => {
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
    await machine.stopCoReview()

    await expect(transport.sendFrame?.(new Blob())).rejects.toThrow("co_review_stopped")
  })
})
