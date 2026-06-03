import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ArtifactStage } from "../../../app/components/session/ArtifactStage"
import {
  AudioWebSocketUnsupportedTransport,
  initialCoReviewState,
  type CoReviewSessionState,
} from "../../../app/lib/co-review-transport"
import {
  clearCoreviewArtifactTextRegistryForTests,
  readCoreviewArtifactTextSideband,
} from "../../../app/lib/coreview-artifact-text"
import { loadPdfJs } from "../../../app/lib/pdfjs-loader"

vi.mock("../../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

vi.mock("../../../app/lib/pdfjs-loader", () => ({
  loadPdfJs: vi.fn(),
}))

const unsupportedTransportStatus = new AudioWebSocketUnsupportedTransport().status()
const supportedTransportStatus = {
  ...unsupportedTransportStatus,
  visualTransportSupported: true,
  toolsSupportedInCoReview: true,
  stillFramesSupported: true,
  statusText: "ready",
}

const builderArtifact = {
  artifactTitle: "Launch brief overview",
  artifactType: "document",
  artifactPath: "mnt/user-data/outputs/launch-brief.docx",
  supportingFiles: ["mnt/user-data/outputs/launch-brief-notes.md"],
  decisionsMade: [
    "Kept the visual review focused on the deliverable.",
    "Left exact table values to trusted text.",
  ],
  companionSummary: "Overview card for the completed launch brief.",
  userNextAction: "Open the document for the full deliverable.",
}

const pdfBuilderArtifact = {
  ...builderArtifact,
  artifactPath: "mnt/user-data/outputs/launch-brief.pdf",
  supportingFiles: [],
  userNextAction: "Review the PDF in the canvas.",
}
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

const markdownBuilderArtifact = {
  ...builderArtifact,
  artifactPath: "mnt/user-data/outputs/launch-brief.md",
  supportingFiles: [],
  userNextAction: "Review the rendered brief.",
}

function mockCanvasApis() {
  const context = {
    arcTo: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    moveTo: vi.fn(),
    fillStyle: "",
    font: "",
  } as unknown as CanvasRenderingContext2D

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
}

function mockPdfDocument({
  pageCount = 3,
  rejectLoad = false,
  neverLoad = false,
}: {
  pageCount?: number
  rejectLoad?: boolean
  neverLoad?: boolean
} = {}) {
  const fetchPdf = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(pdfBytes.slice(), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }),
  )
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({
    width: 600 * scale,
    height: 800 * scale,
    scale,
  }))
  const render = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }))
  const getPage = vi.fn(async () => ({
    getViewport,
    render,
  }))
  const pdfDocument = {
    numPages: pageCount,
    fingerprints: [`stage-pdf-${pageCount}`],
    getPage,
  }
  const getDocument = vi.fn(() => ({
    promise: neverLoad
      ? new Promise(() => undefined)
      : rejectLoad
        ? Promise.reject(new Error("pdf failed"))
        : Promise.resolve(pdfDocument),
    destroy: vi.fn(),
  }))

  vi.mocked(loadPdfJs).mockResolvedValue({
    getDocument,
  } as unknown as Awaited<ReturnType<typeof loadPdfJs>>)

  return { fetchPdf, getDocument, getPage, getViewport, render }
}

function renderStage({
  artifact = builderArtifact,
  artifactLibrary = [],
  artifactId,
  sessionId,
  normalSessionId,
  state = {},
  exactTextAvailable = true,
  canStartReview = true,
  reviewEnabled = true,
  visualCaptureStatus = null,
  reviewStale = false,
  canRefreshReview = false,
  onVisualCaptureStatusChange,
  onRefreshReview,
  visualReviewRequiresVoice = false,
  pendingStartVoiceReview = false,
  onStartVoiceReview,
  transportStatus = supportedTransportStatus,
  fillAvailable = false,
}: {
  artifact?: typeof builderArtifact
  artifactLibrary?: Array<{
    path: string
    name: string
    sizeBytes?: number
    mimeType?: string
    modifiedAt?: string
  }>
  artifactId?: string | null
  sessionId?: string | null
  normalSessionId?: string | null
  state?: Partial<CoReviewSessionState>
  exactTextAvailable?: boolean
  canStartReview?: boolean
  reviewEnabled?: boolean
  visualCaptureStatus?: ComponentProps<typeof ArtifactStage>["visualCaptureStatus"]
  reviewStale?: ComponentProps<typeof ArtifactStage>["reviewStale"]
  canRefreshReview?: ComponentProps<typeof ArtifactStage>["canRefreshReview"]
  onVisualCaptureStatusChange?: ComponentProps<typeof ArtifactStage>["onVisualCaptureStatusChange"]
  onRefreshReview?: ComponentProps<typeof ArtifactStage>["onRefreshReview"]
  visualReviewRequiresVoice?: ComponentProps<typeof ArtifactStage>["visualReviewRequiresVoice"]
  pendingStartVoiceReview?: ComponentProps<typeof ArtifactStage>["pendingStartVoiceReview"]
  onStartVoiceReview?: ComponentProps<typeof ArtifactStage>["onStartVoiceReview"]
  transportStatus?: typeof supportedTransportStatus
  fillAvailable?: boolean
} = {}) {
  const onStartReview = vi.fn()
  const onStopReview = vi.fn()

  const view = render(
    <ArtifactStage
      builderArtifact={artifact}
      builderArtifactLibrary={artifactLibrary}
      threadId="thread-1"
      artifactId={artifactId}
      sessionId={sessionId}
      normalSessionId={normalSessionId}
      reviewState={{
        ...initialCoReviewState(transportStatus.kind),
        ...state,
      }}
      transportStatus={transportStatus}
      exactTextAvailable={exactTextAvailable}
      canStartReview={canStartReview}
      reviewEnabled={reviewEnabled}
      visualReviewRequiresVoice={visualReviewRequiresVoice}
      pendingStartVoiceReview={pendingStartVoiceReview}
      visualCaptureStatus={visualCaptureStatus}
      reviewStale={reviewStale}
      canRefreshReview={canRefreshReview}
      onVisualCaptureStatusChange={onVisualCaptureStatusChange}
      onStartVoiceReview={onStartVoiceReview}
      onStartReview={onStartReview}
      onStopReview={onStopReview}
      onRefreshReview={onRefreshReview}
      fillAvailable={fillAvailable}
    />,
  )

  return { ...view, onStartReview, onStopReview }
}

beforeEach(() => {
  mockCanvasApis()
  vi.mocked(loadPdfJs).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearCoreviewArtifactTextRegistryForTests()
})

describe("ArtifactStage", () => {
  it("renders a native artifact shell with open and download actions", () => {
    renderStage()

    const artifactRegion = screen.getByRole("region", { name: /generated artifact/i })
    expect(artifactRegion).toBeInTheDocument()
    expect(artifactRegion.className).toContain("w-full")
    expect(artifactRegion.className).toContain("min-h-0")
    expect(artifactRegion.className).not.toMatch(/\bfixed\b|\binset-0\b/)
    expect(artifactRegion).toHaveAttribute("data-review-state", "idle")
    const viewport = screen.getByTestId("artifact-canvas-viewport")
    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const documentPage = screen.getByTestId("artifact-document-page")
    expect(viewport).toContainElement(canvasBed)
    expect(canvasBed.className).toContain("flex-1")
    expect(documentPage.className).toContain("min-h-full")
    expect(documentPage.className).toContain("max-w-[960px]")
    expect(screen.getAllByText("Launch brief overview")).toHaveLength(2)
    expect(screen.getByText("Document")).toBeInTheDocument()
    expect(screen.getByText("launch-brief.docx")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.docx",
    )
    expect(screen.getByLabelText("Download Launch brief overview")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.docx?download=true",
    )
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument()
    expect(screen.queryByLabelText("Zoom out")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Zoom in")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Fit to view")).not.toBeInTheDocument()
  })

  it("detects and loads a PDF artifact inside the canvas bed", async () => {
    const pdf = mockPdfDocument({ pageCount: 3 })
    renderStage({ artifact: pdfBuilderArtifact, exactTextAvailable: false, fillAvailable: true })

    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    expect(canvasBed).toContainElement(await screen.findByLabelText("Artifact PDF preview"))
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument()
    expect(pdf.fetchPdf).toHaveBeenCalledWith(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.pdf",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        method: "GET",
      }),
    )
    expect(pdf.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.any(Uint8Array),
    }))
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument()
    expect(screen.getByText("Fit page")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.pdf",
    )
    expect(screen.getByLabelText("Download Launch brief overview")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.pdf?download=true",
    )
    expect(screen.getByText("Exact text unavailable")).toBeInTheDocument()
  })

  it("keeps the PDF loading state inside the canvas bed", async () => {
    mockPdfDocument({ neverLoad: true })
    renderStage({ artifact: pdfBuilderArtifact, exactTextAvailable: false })

    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    expect(canvasBed).toContainElement(await screen.findByTestId("artifact-preview-state"))
    expect(screen.getByText("Preparing PDF view")).toBeInTheDocument()
  })

  it("shows PDF preview failure while keeping open and download actions", async () => {
    mockPdfDocument({ rejectLoad: true })
    renderStage({ artifact: pdfBuilderArtifact, exactTextAvailable: false })

    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toBeInTheDocument()
    expect(screen.getByLabelText("Download Launch brief overview")).toBeInTheDocument()
  })

  it("navigates PDF pages with real bounds", async () => {
    const user = userEvent.setup()
    const pdf = mockPdfDocument({ pageCount: 3 })
    renderStage({ artifact: pdfBuilderArtifact, exactTextAvailable: false })

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument()
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(1))
    expect(screen.getByLabelText("Previous page")).toBeDisabled()
    expect(screen.getByLabelText("Next page")).toBeEnabled()
    const pageRail = screen.getByTestId("artifact-page-rail")
    expect(pageRail).toBeInTheDocument()
    await waitFor(() => {
      expect(within(pageRail).getAllByTestId("artifact-pdf-thumbnail-canvas")).toHaveLength(3)
    })

    await user.click(screen.getByLabelText("Next page"))
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument()
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2))
    expect(screen.getByLabelText("Previous page")).toBeEnabled()
    expect(screen.getByLabelText("PDF page 2")).toHaveAttribute("data-artifact-page-index", "1")

    await user.click(screen.getByLabelText("Page 3"))
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument()
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(3))
    expect(screen.getByLabelText("Page 3")).toHaveAttribute("aria-current", "page")
    expect(screen.getByLabelText("Next page")).toBeDisabled()

    await user.click(screen.getByLabelText("Previous page"))
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument()
    await waitFor(() => expect(pdf.getPage).toHaveBeenLastCalledWith(2))
  })

  it("applies PDF zoom and fit controls to view state", async () => {
    const user = userEvent.setup()
    mockPdfDocument({ pageCount: 2 })
    renderStage({ artifact: pdfBuilderArtifact, exactTextAvailable: false })

    const stage = screen.getByRole("region", { name: /generated artifact/i })
    const canvas = await screen.findByLabelText("PDF page 1")
    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    const pageRail = screen.getByTestId("artifact-page-rail")

    expect(await screen.findByText("Fit page")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "0.72"))
    expect(canvasBed.className).toContain("overflow-hidden")
    expect(scrollArea.className).toContain("overflow-hidden")
    expect(panLayer.className).toContain("overflow-auto")
    expect(panLayer).not.toContainElement(pageRail)
    expect(stage).toHaveAttribute("data-artifact-view-signature", expect.stringContaining("fit:page"))
    await user.click(screen.getByLabelText("Zoom in"))
    expect(await screen.findByText("120%")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-zoom", "1.2"))
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1.2"))
    expect(stage).toHaveAttribute("data-artifact-view-signature", expect.stringContaining("zoom:1.20"))
    await user.click(screen.getByLabelText("Zoom out"))
    expect(await screen.findByText("100%")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1"))
    await user.click(screen.getByLabelText("Fit width"))
    expect(await screen.findByText("Fit width")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-fit-mode", "width"))
    await waitFor(() => expect(Number(canvas.getAttribute("data-artifact-pdf-scale"))).toBeCloseTo(1.35, 2))
    expect(screen.getByTestId("artifact-pdf-page-frame").style.width).not.toBe("")
    expect(screen.getByTestId("artifact-pdf-page-frame").style.height).not.toBe("")
    await user.click(screen.getByLabelText("Fit page"))
    expect(await screen.findByText("Fit page")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "0.72"))
    await user.click(screen.getByLabelText("Reset zoom"))
    expect(await screen.findByText("100%")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-fit-mode", "custom"))
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1"))
  })

  it("reports page and zoom changes through the artifact view state callback", async () => {
    const user = userEvent.setup()
    const onArtifactViewStateChange = vi.fn()
    mockPdfDocument({ pageCount: 2 })
    const onStartReview = vi.fn()
    const onStopReview = vi.fn()

    render(
      <ArtifactStage
        builderArtifact={pdfBuilderArtifact}
        threadId="thread-1"
        artifactId="artifact-1"
        reviewState={{
          ...initialCoReviewState(supportedTransportStatus.kind),
          state: "co_review_live",
          visualInputStatus: "live",
          videoOrFrameMode: "still_frame",
          frameSentCount: 1,
          initialFrameSent: true,
        }}
        transportStatus={supportedTransportStatus}
        exactTextAvailable={false}
        reviewStale
        canRefreshReview
        onArtifactViewStateChange={onArtifactViewStateChange}
        onStartReview={onStartReview}
        onStopReview={onStopReview}
        onRefreshReview={vi.fn()}
      />,
    )

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument()

    await user.click(screen.getByLabelText("Next page"))
    await waitFor(() => expect(onArtifactViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      pageIndex: 1,
      zoom: 1,
      fitMode: "page",
    })))
    expect(screen.getByText("View may be stale")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /refresh view/i })).toBeEnabled()

    await user.click(screen.getByLabelText("Zoom in"))
    await waitFor(() => expect(onArtifactViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      pageIndex: 1,
      zoom: 1.2,
      fitMode: "custom",
    })))
  })

  it("makes Review with Sophia prominent and calls the existing start handler", async () => {
    const user = userEvent.setup()
    const { onStartReview } = renderStage()

    await user.click(screen.getByRole("button", { name: /review with sophia/i }))

    expect(onStartReview).toHaveBeenCalledTimes(1)
  })

  it("shows Sophia is looking at this artifact, Frame sent, stale state, and exact text availability from existing review state", () => {
    renderStage({
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
        frameSentCount: 1,
        initialFrameSent: true,
        exactTextAvailable: true,
      },
      reviewStale: true,
    })

    const artifactRegion = screen.getByRole("region", { name: /generated artifact/i })
    expect(artifactRegion).toHaveAttribute("data-review-state", "active")
    expect(screen.getByTestId("artifact-stage-review-aura").className).toContain("opacity-100")
    const lookingChip = screen.getByRole("status", { name: "Sophia is looking at this artifact" })
    expect(lookingChip).toBeInTheDocument()
    expect(lookingChip.className).toContain("sophia-purple")
    const frameSent = screen.getByText("Frame sent").parentElement
    expect(frameSent?.className).toContain("cosmic-teal")
    expect(screen.getByText("View may be stale")).toBeInTheDocument()
    const exactText = screen.getByText("Exact text available").parentElement
    expect(exactText?.className).toContain("cosmic-teal")
  })

  it("maps starting review state to Preparing view", () => {
    renderStage({
      state: {
        state: "co_review_starting",
        visualInputStatus: "connecting",
      },
    })

    expect(screen.getByRole("status", { name: "Preparing view" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: /generated artifact/i })).toHaveAttribute("data-review-state", "preparing")
  })

  it("shows Not looking and exact text availability before review", () => {
    renderStage()

    expect(screen.getByRole("status", { name: /not looking/i })).toBeInTheDocument()
    expect(screen.getByText("Frame not sent yet")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
  })

  it("shows local disabled review state while keeping exact text visible", () => {
    renderStage({
      reviewEnabled: false,
      exactTextAvailable: true,
      visualCaptureStatus: {
        ready: true,
        reason: null,
        source: "metadata_canvas",
        exactTextAvailable: true,
      },
    })

    expect(screen.getByText("Visual review disabled locally")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /review with sophia/i })).not.toBeInTheDocument()
  })

  it("does not claim Sophia is looking when live state has no confirmed sent frame", () => {
    renderStage({
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
        frameSentCount: 0,
        initialFrameSent: true,
        exactTextAvailable: true,
      },
    })

    expect(screen.getByRole("status", { name: /not looking/i })).toBeInTheDocument()
    expect(screen.queryByRole("status", { name: "Sophia is looking at this artifact" })).not.toBeInTheDocument()
    expect(screen.queryByText("Frame sent")).not.toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
  })

  it("shows start-voice review copy instead of frame-unavailable copy when the visual sender needs voice", async () => {
    const user = userEvent.setup()
    const onStartVoiceReview = vi.fn()
    renderStage({
      canStartReview: false,
      exactTextAvailable: true,
      visualReviewRequiresVoice: true,
      visualCaptureStatus: {
        ready: true,
        reason: null,
        source: "markdown_preview_canvas",
        exactTextAvailable: true,
      },
      transportStatus: {
        ...supportedTransportStatus,
        visualTransportSupported: false,
        stillFramesSupported: true,
        statusText: "still-frame unavailable: voice not started",
      },
      onStartVoiceReview,
    })

    expect(screen.getByText("Start voice to review visually")).toBeInTheDocument()
    expect(screen.queryByText("Frame unavailable")).not.toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /start voice & review/i }))

    expect(onStartVoiceReview).toHaveBeenCalledTimes(1)
  })

  it("can show unavailable exact text when the artifact has no trusted text", () => {
    renderStage({ exactTextAvailable: false })

    expect(screen.getByText("Exact text unavailable")).toBeInTheDocument()
  })

  it("surfaces frame unavailable without exposing implementation terminology", () => {
    const { container } = renderStage({
      state: {
        state: "co_review_error",
        error: "frame_send_closed_gemini_websocket",
        frameSendFailureCount: 1,
      },
      canStartReview: false,
      transportStatus: unsupportedTransportStatus,
    })

    expect(screen.getAllByText("Frame unavailable").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeDisabled()
    const artifactRegion = screen.getByRole("region", { name: /generated artifact/i })
    const renderedText = within(artifactRegion).queryByText(/coreview|gemini|websocket|transport|liveframes|fixture|direct video|provider ack/i)
    expect(renderedText).not.toBeInTheDocument()
    expect(container.textContent?.toLowerCase()).not.toContain("still-frame")
  })

  it("shows inactive visual review when the artifact capture target is missing", () => {
    renderStage({
      canStartReview: false,
      visualCaptureStatus: {
        ready: false,
        reason: "capture_target_missing",
        source: "markdown_preview_canvas",
        exactTextAvailable: true,
      },
    })

    expect(screen.getByText("Visual review not active")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeDisabled()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
  })

  it("uses Stop Looking while review is active", async () => {
    const user = userEvent.setup()
    const { onStopReview } = renderStage({
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
      },
    })

    await user.click(screen.getByRole("button", { name: /stop looking/i }))

    expect(onStopReview).toHaveBeenCalledTimes(1)
  })

  it("hides review controls when review is disabled", () => {
    renderStage({ reviewEnabled: false, exactTextAvailable: false })

    expect(screen.queryByRole("button", { name: /review with sophia/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/exact text/i)).not.toBeInTheDocument()
  })

  it("fetches and renders a markdown artifact as a document preview", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nThe artifact is **ready** for review.", {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    )

    renderStage({ artifact: markdownBuilderArtifact, fillAvailable: true })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    expect(screen.getByText(/The artifact is/i)).toBeInTheDocument()
    expect(screen.getByText("ready")).toBeInTheDocument()
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md",
      expect.objectContaining({
        cache: "no-store",
        method: "GET",
      }),
    )
  })

  it("renders markdown from content type metadata even when the extension is not enough", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("## Metadata Preview\n\nA markdown response from the artifact route.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderStage({
      artifact: {
        ...builderArtifact,
        artifactPath: "mnt/user-data/outputs/launch-brief",
      },
      artifactLibrary: [{
        path: "mnt/user-data/outputs/launch-brief",
        name: "launch-brief",
        mimeType: "text/markdown",
      }],
    })

    expect(await screen.findByRole("heading", { name: "Metadata Preview" })).toBeInTheDocument()
  })

  it("escapes markdown HTML instead of mounting untrusted elements", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Safe\n\n<script>alert(\"x\")</script>", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )
    const { container } = renderStage({ artifact: markdownBuilderArtifact })

    expect(await screen.findByRole("heading", { name: "Safe" })).toBeInTheDocument()
    expect(screen.getByText("<script>alert(\"x\")</script>")).toBeInTheDocument()
    expect(container.querySelector("script")).toBeNull()
  })

  it("shows a loading state while markdown preview content is being fetched", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    )

    renderStage({ artifact: markdownBuilderArtifact, fillAvailable: true })

    const viewport = await screen.findByTestId("artifact-canvas-viewport")
    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    expect(viewport).toContainElement(screen.getByTestId("artifact-canvas-scroll-area"))
    expect(canvasBed).toContainElement(screen.getByTestId("artifact-preview-state"))
    const previewRegion = await screen.findByLabelText("Artifact document preview")
    expect(within(previewRegion).getByText("Preparing document view")).toBeInTheDocument()
    expect(screen.queryByText("Loading preview")).not.toBeInTheDocument()
  })

  it("scrolls long markdown inside the canvas while toolbar and review actions remain outside it", async () => {
    const longMarkdown = [
      "# Launch Brief",
      "",
      ...Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}: more detail for the in-session canvas.`),
    ].join("\n\n")
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(longMarkdown, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    )

    renderStage({ artifact: markdownBuilderArtifact, fillAvailable: true })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    const toolbar = screen.getByTestId("artifact-toolbar")
    const viewport = screen.getByTestId("artifact-canvas-viewport")
    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const documentPage = screen.getByTestId("artifact-document-page")

    expect(viewport.className).toContain("flex-1")
    expect(canvasBed.className).toContain("flex-1")
    expect(scrollArea.className).toContain("overflow-y-auto")
    expect(documentPage.className).toContain("max-w-[1120px]")
    expect(screen.queryByTestId("artifact-page-rail")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-pdf-thumbnail-canvas")).not.toBeInTheDocument()
    expect(toolbar).not.toBe(scrollArea)
    expect(scrollArea).not.toContainElement(toolbar)
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toBeInTheDocument()
    expect(screen.getByLabelText("Download Launch brief overview")).toBeInTheDocument()
  })

  it("shows preview unavailable on fetch failure while keeping Open and Download available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("missing", { status: 404 }))

    renderStage({ artifact: markdownBuilderArtifact })

    const previewRegion = await screen.findByLabelText("Artifact document preview")
    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    expect(canvasBed).toContainElement(screen.getByTestId("artifact-preview-state"))
    expect(within(previewRegion).getByText("Preview unavailable")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md",
    )
    expect(screen.getByLabelText("Download Launch brief overview")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true",
    )
  })

  it("keeps Review with Sophia visible for markdown previews without debug terminology", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nA clean document preview.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    const { container } = renderStage({ artifact: markdownBuilderArtifact })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeInTheDocument()
    expect(container.textContent?.toLowerCase()).not.toMatch(
      /coreview|gemini|websocket|transport|liveframes|fixture|direct video|provider ack/,
    )
  })

  it("registers fetched markdown as trusted builder file text when an artifact id is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Exact Title\n\nBudget delta: 17.4%", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderStage({
      artifact: markdownBuilderArtifact,
      artifactId: "coreview-real-artifact-launch-brief",
      sessionId: "session-1",
      normalSessionId: "normal-1",
    })

    expect(await screen.findByRole("heading", { name: "Exact Title" })).toBeInTheDocument()
    const response = readCoreviewArtifactTextSideband({
      artifactId: "coreview-real-artifact-launch-brief",
      sessionId: "session-1",
      threadId: "thread-1",
    })

    expect(response).toMatchObject({
      ok: true,
      source: "builder_file",
      text: "# Exact Title\n\nBudget delta: 17.4%",
    })
  })

  it("reports selected markdown capture readiness from the rendered preview", async () => {
    const onVisualCaptureStatusChange = vi.fn()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Exact Title\n\nBudget delta: 17.4%", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderStage({
      artifact: markdownBuilderArtifact,
      artifactId: "coreview-real-artifact-launch-brief",
      sessionId: "session-1",
      normalSessionId: "normal-1",
      onVisualCaptureStatusChange,
    })

    expect(await screen.findByRole("heading", { name: "Exact Title" })).toBeInTheDocument()
    const captureCanvas = screen.getByTestId("artifact-markdown-capture-canvas").querySelector("canvas")
    expect(captureCanvas).toHaveAttribute("data-artifact-canvas-source", "selected-markdown-preview")
    await waitFor(() => {
      expect(onVisualCaptureStatusChange).toHaveBeenLastCalledWith({
        ready: true,
        reason: null,
        source: "markdown_preview_canvas",
        exactTextAvailable: true,
      })
    })
  })

  it("does not fetch non-markdown artifacts and keeps the existing shell fallback", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    renderStage()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText("Primary file")).toBeInTheDocument()
    expect(screen.getByText("launch-brief.docx")).toBeInTheDocument()
  })
})
