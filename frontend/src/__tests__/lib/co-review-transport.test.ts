import { describe, expect, it, vi } from "vitest"

import type { ArtifactVisualSource } from "../../app/lib/co-review-capture"
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
})
