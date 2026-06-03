import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useArtifactCoReview } from "../../app/hooks/useArtifactCoReview"
import type { ArtifactViewState } from "../../app/lib/artifact-renderers"
import type {
  CoReviewMediaTransport,
  CoReviewRefreshResult,
  CoReviewStartInput,
  CoReviewStartResult,
  CoReviewStopResult,
} from "../../app/lib/co-review-transport"

function createSupportedTransport({ refreshOk = false }: { refreshOk?: boolean } = {}) {
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
  const refreshCoReview = vi.fn(async (): Promise<CoReviewRefreshResult> => (
    refreshOk
      ? {
          ok: true,
          visualInputStatus: "live",
          toolAvailability: "available",
          error: null,
          frameSentCount: 1,
          providerAcceptedFrame: true,
          visualResponseObserved: true,
        }
      : {
          ok: false,
          visualInputStatus: "error",
          toolAvailability: "unavailable",
          error: "not_live",
        }
  ))
  const transport: CoReviewMediaTransport = {
    kind: "test-still-frame",
    startCoReview,
    refreshCoReview,
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

  return { transport, startCoReview, refreshCoReview }
}

function createArtifactRoot() {
  const root = document.createElement("section")
  const canvas = document.createElement("canvas")
  canvas.width = 800
  canvas.height = 600
  canvas.dataset.artifactId = "artifact-1"
  canvas.dataset.artifactCanvasSource = "selected-pdf-page"
  canvas.dataset.coreviewOffscreenRender = "true"
  root.appendChild(canvas)
  return { root, canvas }
}

function pdfViewState(overrides: Partial<ArtifactViewState> = {}): ArtifactViewState {
  return {
    artifactId: "artifact-1",
    filePath: "mnt/user-data/outputs/launch-brief.pdf",
    rendererKind: "pdf",
    pageIndex: 0,
    pageCount: 3,
    zoom: 1,
    fitMode: "page",
    ...overrides,
  }
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

  it("marks review stale when the PDF page changes after a frame was sent", async () => {
    const { transport } = createSupportedTransport()
    const { root } = createArtifactRoot()
    const { result, rerender } = renderHook(({ viewState }) => useArtifactCoReview({
      sessionId: "session-1",
      normalSessionId: "normal-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactRoot: root,
      exactTextAvailable: false,
      featureEnabled: true,
      transport,
      visualSourceReady: true,
      artifactViewState: viewState,
    }), {
      initialProps: { viewState: pdfViewState() },
    })

    await act(async () => {
      await result.current.startReview()
    })

    expect(result.current.reviewStale).toBe(false)

    rerender({ viewState: pdfViewState({ pageIndex: 1 }) })

    expect(result.current.reviewStale).toBe(true)
    expect(result.current.reviewStaleReason).toBe("view_changed")
  })

  it("marks review stale when PDF zoom changes after a frame was sent", async () => {
    const { transport } = createSupportedTransport()
    const { root } = createArtifactRoot()
    const { result, rerender } = renderHook(({ viewState }) => useArtifactCoReview({
      sessionId: "session-1",
      normalSessionId: "normal-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactRoot: root,
      exactTextAvailable: false,
      featureEnabled: true,
      transport,
      visualSourceReady: true,
      artifactViewState: viewState,
    }), {
      initialProps: { viewState: pdfViewState() },
    })

    await act(async () => {
      await result.current.startReview()
    })

    rerender({ viewState: pdfViewState({ fitMode: "custom", zoom: 1.2 }) })

    expect(result.current.reviewStale).toBe(true)
    expect(result.current.currentViewSignature).toContain("zoom:1.20")
  })

  it("clears stale state after a successful refresh sends the current view", async () => {
    const { transport, refreshCoReview } = createSupportedTransport({ refreshOk: true })
    const { root } = createArtifactRoot()
    const { result, rerender } = renderHook(({ viewState }) => useArtifactCoReview({
      sessionId: "session-1",
      normalSessionId: "normal-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactRoot: root,
      exactTextAvailable: false,
      featureEnabled: true,
      transport,
      visualSourceReady: true,
      artifactViewState: viewState,
    }), {
      initialProps: { viewState: pdfViewState() },
    })

    await act(async () => {
      await result.current.startReview()
    })
    rerender({ viewState: pdfViewState({ pageIndex: 1 }) })
    await waitFor(() => expect(result.current.reviewStale).toBe(true))

    await act(async () => {
      await result.current.refreshReview()
    })

    expect(refreshCoReview).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.reviewStale).toBe(false))
    expect(result.current.lastFrameViewSignature).toBe(result.current.currentViewSignature)
  })
})
