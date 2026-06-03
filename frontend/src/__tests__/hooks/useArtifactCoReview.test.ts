import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useArtifactCoReview } from "../../app/hooks/useArtifactCoReview"
import type {
  CoReviewMediaTransport,
  CoReviewRefreshResult,
  CoReviewStartInput,
  CoReviewStartResult,
  CoReviewStopResult,
} from "../../app/lib/co-review-transport"

function createSupportedTransport() {
  const startCoReview = vi.fn(async (input: CoReviewStartInput): Promise<CoReviewStartResult> => ({
    ok: true,
    coReviewSessionId: `${input.sessionId}:still-frame`,
    visualInputStatus: "live",
    toolAvailability: "available",
    videoOrFrameMode: "still_frame",
    normalVoicePaused: false,
    sessionHandoffMs: null,
    estimatedVisualCost: null,
    error: null,
    frameSentCount: 1,
    providerAcceptedFrame: true,
    visualResponseObserved: true,
  }))
  const transport: CoReviewMediaTransport = {
    kind: "test-still-frame",
    startCoReview,
    refreshCoReview: vi.fn(async (): Promise<CoReviewRefreshResult> => ({
      ok: false,
      visualInputStatus: "error",
      toolAvailability: "unavailable",
      error: "not_live",
    })),
    stopCoReview: vi.fn(async (): Promise<CoReviewStopResult> => ({
      ok: true,
      visualInputStatus: "stopped",
      normalVoiceRestored: true,
      error: null,
    })),
    status: () => ({
      kind: "test-still-frame",
      visualTransportSupported: true,
      toolsSupportedInCoReview: true,
      stillFramesSupported: true,
      statusText: "ready",
    }),
    supportsTools: () => true,
    supportsStillFrames: () => true,
  }

  return { transport, startCoReview }
}

describe("useArtifactCoReview", () => {
  it("blocks start while the selected artifact visual source is not ready", async () => {
    const { transport, startCoReview } = createSupportedTransport()
    const { result } = renderHook(() => useArtifactCoReview({
      sessionId: "session-1",
      normalSessionId: "normal-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      featureEnabled: true,
      transport,
      visualSourceReady: false,
      visualSourceUnavailableReason: "preview_not_ready",
    }))

    expect(result.current.canStart).toBe(false)

    await act(async () => {
      await result.current.startReview()
    })

    expect(startCoReview).not.toHaveBeenCalled()
  })

  it("starts with the selected artifact canvas once the visual source is ready", async () => {
    const { transport, startCoReview } = createSupportedTransport()
    const root = document.createElement("section")
    const canvas = document.createElement("canvas")
    canvas.width = 800
    canvas.height = 600
    canvas.dataset.artifactId = "artifact-1"
    canvas.dataset.artifactCanvasSource = "selected-markdown-preview"
    canvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(canvas)

    const { result } = renderHook(() => useArtifactCoReview({
      sessionId: "session-1",
      normalSessionId: "normal-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactRoot: root,
      exactTextAvailable: true,
      featureEnabled: true,
      transport,
      visualSourceReady: true,
    }))

    expect(result.current.canStart).toBe(true)

    await act(async () => {
      await result.current.startReview()
    })

    expect(startCoReview).toHaveBeenCalledTimes(1)
    expect(startCoReview.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      exactTextAvailable: true,
      visualSource: {
        status: "ready",
        kind: "offscreen_render",
        element: canvas,
      },
    })
  })
})
