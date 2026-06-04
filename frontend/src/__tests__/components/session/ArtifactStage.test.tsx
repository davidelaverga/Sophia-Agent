import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ArtifactStage, type ArtifactReviewVoiceCommandTarget } from "../../../app/components/session/ArtifactStage"
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
    drawImage: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    moveTo: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
}

function mockPdfDocument({
  pageCount = 3,
  rejectLoad = false,
  neverLoad = false,
  textByPage = [],
}: {
  pageCount?: number
  rejectLoad?: boolean
  neverLoad?: boolean
  textByPage?: string[]
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
  const getTextContent = vi.fn(async (pageNumber: number) => ({
    items: textToPdfTextItems(textByPage[pageNumber - 1] ?? ""),
  }))
  const getPage = vi.fn(async (pageNumber: number) => ({
    getViewport,
    render,
    getTextContent: () => getTextContent(pageNumber),
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

  return { fetchPdf, getDocument, getPage, getViewport, render, getTextContent }
}

function textToPdfTextItems(text: string) {
  return text.split(/\s+/u).filter(Boolean).map((str, index) => ({
    str,
    width: Math.max(24, str.length * 9),
    height: 24,
    transform: [24, 0, 0, 24, 72 + index * 72, 704],
  }))
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
  onVoiceCommandTargetChange,
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
  onVoiceCommandTargetChange?: ComponentProps<typeof ArtifactStage>["onVoiceCommandTargetChange"]
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
      onVoiceCommandTargetChange={onVoiceCommandTargetChange}
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
    expect(screen.getByTestId("artifact-review-room")).toBe(artifactRegion)
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
    expect(screen.queryByLabelText("Select")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Highlight")).not.toBeInTheDocument()
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
    expect(screen.getByLabelText("Select")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByLabelText("Pan")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Highlight")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Comment")).toHaveAttribute("aria-pressed", "false")
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

  it("registers extracted PDF text for read_artifact_text sideband reads", async () => {
    const pdf = mockPdfDocument({
      pageCount: 2,
      textByPage: ["North equals 42", "Budget delta is 17.4 percent"],
    })
    const onVisualCaptureStatusChange = vi.fn()

    renderStage({
      artifact: pdfBuilderArtifact,
      artifactId: "artifact-1",
      sessionId: "session-1",
      normalSessionId: "session-1",
      exactTextAvailable: false,
      onVisualCaptureStatusChange,
    })

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument()
    await waitFor(() => expect(pdf.getTextContent).toHaveBeenCalledWith(1))
    await waitFor(() => expect(onVisualCaptureStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      exactTextAvailable: true,
      pdfTextExtractionSource: "pdf_text_extraction",
      pdfTextExtractionStatus: "success",
      pdfTextExtractionPageCount: 2,
    })))

    const response = readCoreviewArtifactTextSideband({
      artifactId: "artifact-1",
      sessionId: "session-1",
      threadId: "thread-1",
    })
    expect(response).toMatchObject({
      ok: true,
      source: "pdf_text_extraction",
      page_count: 2,
      char_count: expect.any(Number),
      truncated: false,
    })
    expect(response.ok ? response.text : "").toContain("North equals 42")
    expect(response.ok ? response.text : "").toContain("Budget delta is 17.4 percent")
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

  it("applies PDF page voice commands through the registered stage target", async () => {
    let voiceTarget: ArtifactReviewVoiceCommandTarget | null = null
    mockPdfDocument({ pageCount: 3 })
    renderStage({
      artifact: pdfBuilderArtifact,
      artifactId: "artifact-1",
      exactTextAvailable: false,
      onVoiceCommandTargetChange: (target) => {
        voiceTarget = target
      },
    })

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument()
    await waitFor(() => expect(voiceTarget?.pageCount).toBe(3))

    let result: ReturnType<ArtifactReviewVoiceCommandTarget["applyCommand"]> | null = null
    act(() => {
      result = voiceTarget?.applyCommand({ kind: "go_to_page", pageTarget: 2 }) ?? null
    })
    expect(result).toMatchObject({
      applied: true,
      changed: true,
      shouldRefresh: true,
      blockedReason: null,
      artifactCurrentPageIndex: 1,
      artifactCurrentPageCount: 3,
    })
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument()
    await waitFor(() => expect(voiceTarget?.pageIndex).toBe(1))

    act(() => {
      result = voiceTarget?.applyCommand({ kind: "next_page" }) ?? null
    })
    expect(result).toMatchObject({ applied: true, artifactCurrentPageIndex: 2 })
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument()
    await waitFor(() => expect(voiceTarget?.pageIndex).toBe(2))

    act(() => {
      result = voiceTarget?.applyCommand({ kind: "previous_page" }) ?? null
    })
    expect(result).toMatchObject({ applied: true, artifactCurrentPageIndex: 1 })
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument()
    await waitFor(() => expect(voiceTarget?.pageIndex).toBe(1))

    act(() => {
      result = voiceTarget?.applyCommand({ kind: "first_page" }) ?? null
    })
    expect(result).toMatchObject({ applied: true, artifactCurrentPageIndex: 0 })
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument()
    await waitFor(() => expect(voiceTarget?.pageIndex).toBe(0))

    act(() => {
      result = voiceTarget?.applyCommand({ kind: "last_page" }) ?? null
    })
    expect(result).toMatchObject({ applied: true, artifactCurrentPageIndex: 2 })
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument()
  })

  it("blocks out-of-bounds and non-multipage voice page commands safely", async () => {
    let pdfVoiceTarget: ArtifactReviewVoiceCommandTarget | null = null
    mockPdfDocument({ pageCount: 2 })
    renderStage({
      artifact: pdfBuilderArtifact,
      artifactId: "artifact-1",
      exactTextAvailable: false,
      onVoiceCommandTargetChange: (target) => {
        pdfVoiceTarget = target
      },
    })

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument()
    await waitFor(() => expect(pdfVoiceTarget?.pageCount).toBe(2))

    let result: ReturnType<ArtifactReviewVoiceCommandTarget["applyCommand"]> | null = null
    act(() => {
      result = pdfVoiceTarget?.applyCommand({ kind: "go_to_page", pageTarget: 5 }) ?? null
    })
    expect(result).toMatchObject({
      applied: false,
      blockedReason: "requested_page_out_of_bounds",
      artifactCurrentPageIndex: 0,
      artifactCurrentPageCount: 2,
    })
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument()

    let metadataVoiceTarget: ArtifactReviewVoiceCommandTarget | null = null
    renderStage({
      artifact: builderArtifact,
      artifactId: "artifact-2",
      exactTextAvailable: false,
      onVoiceCommandTargetChange: (target) => {
        metadataVoiceTarget = target
      },
    })

    await waitFor(() => expect(metadataVoiceTarget).not.toBeNull())
    act(() => {
      result = metadataVoiceTarget?.applyCommand({ kind: "next_page" }) ?? null
    })
    expect(result).toMatchObject({
      applied: false,
      blockedReason: "no_multipage_artifact_selected",
    })
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

  it("returns to select mode with Escape after choosing another PDF annotation tool", async () => {
    const user = userEvent.setup()
    mockPdfDocument({ pageCount: 2 })
    renderStage({ artifact: pdfBuilderArtifact, exactTextAvailable: false })

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument()

    await user.click(screen.getByLabelText("Highlight"))
    expect(screen.getByLabelText("Highlight")).toHaveAttribute("aria-pressed", "true")

    fireEvent.keyDown(screen.getByTestId("artifact-review-room"), { key: "Escape" })

    expect(screen.getByLabelText("Select")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByLabelText("Highlight")).toHaveAttribute("aria-pressed", "false")
  })

  it("supports scoped PDF keyboard shortcuts without firing inside inputs", async () => {
    const onRefreshReview = vi.fn()
    mockPdfDocument({ pageCount: 3 })
    renderStage({
      artifact: pdfBuilderArtifact,
      artifactId: "artifact-1",
      exactTextAvailable: false,
      canRefreshReview: true,
      reviewStale: true,
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
        frameSentCount: 1,
        initialFrameSent: true,
      },
      onRefreshReview,
    })

    const stage = screen.getByRole("region", { name: /generated artifact/i })
    const canvas = await screen.findByLabelText("PDF page 1")
    stage.focus()

    fireEvent.keyDown(stage, { key: "ArrowRight" })
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "ArrowLeft" })
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "End" })
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "Home" })
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "+" })
    expect(await screen.findByText("120%")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-zoom", "1.2"))

    fireEvent.keyDown(stage, { key: "-" })
    expect(await screen.findByText("100%")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "w" })
    expect(await screen.findByText("Fit width")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "p" })
    expect(await screen.findByText("Fit page")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "0" })
    expect(await screen.findByText("100%")).toBeInTheDocument()

    fireEvent.keyDown(stage, { key: "r" })
    expect(onRefreshReview).toHaveBeenCalledTimes(1)

    const input = document.createElement("input")
    stage.appendChild(input)
    fireEvent.keyDown(input, { key: "ArrowRight" })
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument()
  })

  it("zooms PDFs with a two-touch pinch inside the pan layer", async () => {
    mockPdfDocument({ pageCount: 2 })
    renderStage({
      artifact: pdfBuilderArtifact,
      artifactId: "artifact-1",
      exactTextAvailable: false,
      reviewStale: true,
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
        frameSentCount: 1,
        initialFrameSent: true,
      },
    })

    const canvas = await screen.findByLabelText("PDF page 1")
    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    const bodyWidthBefore = document.body.getBoundingClientRect().width

    fireEvent.touchStart(panLayer, {
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ],
    })
    fireEvent.touchMove(panLayer, {
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 150, clientY: 0 },
      ],
    })

    expect(await screen.findByText("150%")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-zoom", "1.5"))
    expect(panLayer.className).toContain("overflow-auto")
    expect(document.body.getBoundingClientRect().width).toBe(bodyWidthBefore)
    expect(screen.getByText("View changed. Refresh Sophia's view.")).toBeInTheDocument()
  })

  it("applies PDF zoom voice commands through the registered stage target", async () => {
    let voiceTarget: ArtifactReviewVoiceCommandTarget | null = null
    mockPdfDocument({ pageCount: 2 })
    renderStage({
      artifact: pdfBuilderArtifact,
      artifactId: "artifact-1",
      exactTextAvailable: false,
      onVoiceCommandTargetChange: (target) => {
        voiceTarget = target
      },
    })

    const canvas = await screen.findByLabelText("PDF page 1")
    await waitFor(() => expect(voiceTarget?.pageCount).toBe(2))

    act(() => {
      voiceTarget?.applyCommand({ kind: "zoom_in" })
    })
    expect(await screen.findByText("120%")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-zoom", "1.2"))
    await waitFor(() => expect(voiceTarget?.fitMode).toBe("custom"))

    act(() => {
      voiceTarget?.applyCommand({ kind: "zoom_out" })
    })
    expect(await screen.findByText("100%")).toBeInTheDocument()

    act(() => {
      voiceTarget?.applyCommand({ kind: "fit_width" })
    })
    expect(await screen.findByText("Fit width")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-fit-mode", "width"))

    act(() => {
      voiceTarget?.applyCommand({ kind: "fit_page" })
    })
    expect(await screen.findByText("Fit page")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-fit-mode", "page"))

    act(() => {
      voiceTarget?.applyCommand({ kind: "reset_zoom" })
    })
    expect(await screen.findByText("100%")).toBeInTheDocument()
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-fit-mode", "custom"))
  })

  it("lets the Coreview stage target highlight, comment, and focus the current PDF title", async () => {
    let voiceTarget: ArtifactReviewVoiceCommandTarget | null = null
    mockPdfDocument({
      pageCount: 1,
      textByPage: ["Q3 Launch Review"],
    })
    renderStage({
      artifact: pdfBuilderArtifact,
      artifactId: "artifact-1",
      exactTextAvailable: false,
      onVoiceCommandTargetChange: (target) => {
        voiceTarget = target
      },
    })

    const canvas = await screen.findByLabelText("PDF page 1")
    await waitFor(() => expect(voiceTarget?.pageCount).toBe(1))
    await waitFor(() => {
      const resolved = voiceTarget?.resolveAnchor({ anchor: { type: "current_title" }, pageIndex: 0 })
      expect(resolved).toMatchObject({ ok: true })
    })

    const resolvedTitle = voiceTarget?.resolveAnchor({ anchor: { type: "current_title" }, pageIndex: 0 })
    expect(resolvedTitle?.ok).toBe(true)
    if (!resolvedTitle?.ok) {
      throw new Error("title anchor did not resolve")
    }

    act(() => {
      voiceTarget?.addAnnotation({
        kind: "highlight",
        pageIndex: 0,
        anchor: resolvedTitle.anchor,
        rect: resolvedTitle.anchor.rect,
        point: null,
        color: "yellow",
        text: null,
        source: "sophia",
      })
    })

    const highlight = await screen.findByTestId("artifact-highlight-annotation")
    expect(highlight).toHaveAttribute("data-annotation-color", "yellow")
    expect(highlight).toHaveAttribute("data-annotation-source", "sophia")

    act(() => {
      voiceTarget?.addAnnotation({
        kind: "comment",
        pageIndex: 0,
        anchor: resolvedTitle.anchor,
        rect: null,
        point: { x: 0.72, y: 0.12 },
        color: "yellow",
        text: "change the font",
        source: "sophia",
      })
    })

    expect(await screen.findByTestId("artifact-comment-pin")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByDisplayValue("change the font")).toBeInTheDocument()
    expect(voiceTarget?.annotationCounts).toMatchObject({
      annotationCount: 2,
      highlightCount: 1,
      commentCount: 1,
    })

    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    const scrollTo = vi.fn()
    panLayer.scrollTo = scrollTo
    Object.defineProperty(panLayer, "clientWidth", { configurable: true, value: 300 })
    Object.defineProperty(panLayer, "clientHeight", { configurable: true, value: 260 })
    Object.defineProperty(panLayer, "scrollWidth", { configurable: true, value: 900 })
    Object.defineProperty(panLayer, "scrollHeight", { configurable: true, value: 1000 })

    act(() => {
      const result = voiceTarget?.focusAnchor({
        pageIndex: 0,
        anchor: resolvedTitle.anchor,
        zoom: 1.4,
        fitMode: "custom",
      })
      expect(result).toMatchObject({ ok: true })
    })

    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-zoom", "1.4"))
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(screen.getByRole("status", { name: /not looking/i })).toBeInTheDocument()
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
    expect(screen.getByText("View changed. Refresh Sophia's view.")).toBeInTheDocument()
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
    const lookingChip = screen.getByRole("status", { name: "Sophia's view is stale" })
    expect(lookingChip).toBeInTheDocument()
    expect(lookingChip.className).toContain("cosmic-text-muted")
    const frameSent = screen.getByText("Frame sent").parentElement
    expect(frameSent?.className).toContain("cosmic-teal")
    expect(screen.getByText("View changed. Refresh Sophia's view.")).toBeInTheDocument()
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
