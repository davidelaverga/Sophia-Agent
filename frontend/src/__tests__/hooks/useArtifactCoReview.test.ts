import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useArtifactCoReview } from "../../app/hooks/useArtifactCoReview"
import type { ArtifactViewState } from "../../app/lib/artifact-renderers"
import type {
  CoReviewMediaTransport,
  CoReviewRefreshResult,
  CoReviewStartInput,
  CoReviewStartResult,
  CoReviewStopResult,
} from "../../app/lib/co-review-transport"

const HTML_RETRY_STEP_MS = 80

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

function htmlViewState(overrides: Partial<ArtifactViewState> = {}): ArtifactViewState {
  return {
    artifactId: "artifact-1",
    filePath: "mnt/user-data/outputs/landing.html",
    rendererKind: "html",
    pageIndex: 0,
    pageCount: 1,
    zoom: 1,
    fitMode: "custom",
    ...overrides,
  }
}

function appendHtmlCaptureCanvas(root: HTMLElement, artifactId = "artifact-1") {
  const canvas = document.createElement("canvas")
  canvas.width = 800
  canvas.height = 600
  canvas.dataset.artifactId = artifactId
  canvas.dataset.artifactCanvasSource = "selected-html-preview"
  canvas.dataset.coreviewOffscreenRender = "true"
  root.appendChild(canvas)
  return canvas
}

afterEach(() => {
  vi.useRealTimers()
})

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

  it("waits for a delayed HTML capture target and sends the initial frame", async () => {
    vi.useFakeTimers()
    const { transport, startCoReview } = createSupportedTransport()
    const root = document.createElement("section")

    const { result } = renderHook(() => useArtifactCoReview({
      sessionId: "session-1",
      normalSessionId: "normal-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactRoot: root,
      exactTextAvailable: true,
      featureEnabled: true,
      transport,
      visualSourceReady: false,
      visualSourceUnavailableReason: "capture_target_missing",
      artifactViewState: htmlViewState(),
    }))

    await act(async () => {
      const startPromise = result.current.startReview()
      await vi.advanceTimersByTimeAsync(HTML_RETRY_STEP_MS)
      const canvas = appendHtmlCaptureCanvas(root)
      await vi.advanceTimersByTimeAsync(HTML_RETRY_STEP_MS)
      await startPromise

      expect(startCoReview).toHaveBeenCalledTimes(1)
      expect(startCoReview.mock.calls[0]?.[0]).toMatchObject({
        exactTextAvailable: true,
        visualSource: {
          status: "ready",
          kind: "html_preview_canvas",
          element: canvas,
        },
      })
    })

    expect(result.current.state.initialFrameSent).toBe(true)
    expect(result.current.state.frameSentCount).toBe(1)
  })

  it("times out delayed HTML capture target lookup with exact text still available", async () => {
    vi.useFakeTimers()
    const { transport, startCoReview } = createSupportedTransport()
    const root = document.createElement("section")

    const { result } = renderHook(() => useArtifactCoReview({
      sessionId: "session-1",
      normalSessionId: "normal-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactRoot: root,
      exactTextAvailable: true,
      featureEnabled: true,
      transport,
      visualSourceReady: false,
      visualSourceUnavailableReason: "capture_target_missing",
      artifactViewState: htmlViewState(),
    }))

    await act(async () => {
      const startPromise = result.current.startReview()
      await vi.advanceTimersByTimeAsync(1400)
      await startPromise
    })

    expect(startCoReview).not.toHaveBeenCalled()
    expect(result.current.state.frameSentCount).toBe(0)
    expect(result.current.state.state).toBe("normal_voice")
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

    expect(result.current.lastFrameViewSignature).toBe(result.current.currentViewSignature)
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
