import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState, type ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ArtifactPdfPreview } from "../../../app/components/session/ArtifactPdfPreview"
import { loadPdfJs } from "../../../app/lib/pdfjs-loader"
import { recordSophiaCaptureEvent } from "../../../app/lib/session-capture"
import type {
  ArtifactAnnotation,
  ArtifactToolMode,
  NormalizedArtifactLine,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../../../app/types/artifact-annotations"
import type { BuilderArtifactV1 } from "../../../app/types/builder-artifact"

vi.mock("../../../app/lib/pdfjs-loader", () => ({
  loadPdfJs: vi.fn(),
}))

vi.mock("../../../app/lib/session-capture", () => ({
  recordSophiaCaptureEvent: vi.fn(),
}))

const pdfArtifact = {
  artifactTitle: "Launch brief PDF",
  artifactType: "pdf",
  artifactPath: "mnt/user-data/outputs/launch-brief.pdf",
  supportingFiles: [],
  decisionsMade: [],
  companionSummary: "A generated PDF artifact.",
  userNextAction: "Review the PDF.",
} satisfies BuilderArtifactV1

const pdfFile = {
  path: "mnt/user-data/outputs/launch-brief.pdf",
  name: "launch-brief.pdf",
  label: "launch-brief.pdf",
  isPrimary: true,
  mimeType: "application/pdf",
}
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
let canvasContext: CanvasRenderingContext2D

function mockCanvasApis() {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
  return context
}

function createDeferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}

function pdfCancelError() {
  const error = new Error("RenderingCancelledException")
  error.name = "RenderingCancelledException"
  return error
}

function immediateRenderTask() {
  return {
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }
}

type MockPdfRenderParams = {
  canvas?: HTMLCanvasElement
}

type MockPdfRenderTask = {
  promise: Promise<void>
  cancel: ReturnType<typeof vi.fn>
}

function isThumbnailRender(params: unknown): boolean {
  return (params as MockPdfRenderParams).canvas?.dataset.artifactPdfThumbnail === "true"
}

function mockPdfDocument({
  pageCount = 3,
  renderTaskForPage = () => immediateRenderTask(),
  textByPage = [],
}: {
  pageCount?: number
  renderTaskForPage?: (pageNumber: number, params: unknown) => MockPdfRenderTask
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
  const render = vi.fn((pageNumber: number, params: unknown) => renderTaskForPage(pageNumber, params))
  const getTextContent = vi.fn(async (pageNumber: number) => ({
    items: textToPdfTextItems(textByPage[pageNumber - 1] ?? ""),
  }))
  const getPage = vi.fn(async (pageNumber: number) => ({
    getViewport,
    render: (params: unknown) => render(pageNumber, params),
    getTextContent: () => getTextContent(pageNumber),
  }))
  const pdfDocument = {
    numPages: pageCount,
    fingerprints: [`mock-pdf-${pageCount}`],
    getPage,
  }
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve(pdfDocument),
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

function renderPreview(
  overrides: Partial<ComponentProps<typeof ArtifactPdfPreview>> = {},
) {
  const props: ComponentProps<typeof ArtifactPdfPreview> = {
    artifact: pdfArtifact,
    file: pdfFile,
    href: "/artifact.pdf",
    artifactId: "artifact-1",
    typeLabel: "PDF",
    pageIndex: 0,
    zoom: 1,
    fitMode: "custom",
    fitBounds: { width: 900, height: 800 },
    ...overrides,
  }

  const view = render(<ArtifactPdfPreview {...props} />)

  return {
    ...view,
    rerenderPreview: (nextOverrides: Partial<ComponentProps<typeof ArtifactPdfPreview>>) => {
      view.rerender(<ArtifactPdfPreview {...props} {...nextOverrides} />)
    },
  }
}

function renderAnnotationPreview({
  initialToolMode = "select",
  initialAnnotations = [],
  pageIndex = 0,
  zoom = 1,
}: {
  initialToolMode?: ArtifactToolMode
  initialAnnotations?: ArtifactAnnotation[]
  pageIndex?: number
  zoom?: number
} = {}) {
  function AnnotationHarness() {
    const [toolMode] = useState<ArtifactToolMode>(initialToolMode)
    const [annotations, setAnnotations] = useState<ArtifactAnnotation[]>(initialAnnotations)
    const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)

    return (
      <ArtifactPdfPreview
        artifact={pdfArtifact}
        file={pdfFile}
        href="/artifact.pdf"
        artifactId="artifact-1"
        typeLabel="PDF"
        pageIndex={pageIndex}
        zoom={zoom}
        fitMode="custom"
        fitBounds={{ width: 900, height: 800 }}
        toolMode={toolMode}
        annotations={annotations}
        selectedAnnotationId={selectedAnnotationId}
        onCreateHighlight={(rect: NormalizedArtifactRect) => {
          const id = `highlight-${annotations.length + 1}`
          setAnnotations((current) => [
            ...current,
            { id, kind: "highlight", pageIndex, rect, createdAt: 1 },
          ])
          setSelectedAnnotationId(id)
        }}
        onCreateComment={(point: NormalizedArtifactPoint) => {
          const id = `comment-${annotations.length + 1}`
          setAnnotations((current) => [
            ...current,
            { id, kind: "comment", pageIndex, point, text: "", createdAt: 1 },
          ])
          setSelectedAnnotationId(id)
        }}
        onCreateUnderline={(rect: NormalizedArtifactRect) => {
          const id = `underline-${annotations.length + 1}`
          setAnnotations((current) => [
            ...current,
            { id, kind: "underline", pageIndex, rect, color: "purple", createdAt: 1 },
          ])
          setSelectedAnnotationId(id)
        }}
        onCreateArrow={(line: NormalizedArtifactLine) => {
          const id = `arrow-${annotations.length + 1}`
          setAnnotations((current) => [
            ...current,
            { id, kind: "arrow", pageIndex, line, color: "purple", createdAt: 1 },
          ])
          setSelectedAnnotationId(id)
        }}
        onSelectAnnotation={setSelectedAnnotationId}
        onUpdateCommentText={(id, text) => {
          setAnnotations((current) => current.map((annotation) => (
            annotation.id === id && annotation.kind === "comment"
              ? { ...annotation, text }
              : annotation
          )))
        }}
      />
    )
  }

  return render(<AnnotationHarness />)
}

function mockAnnotationLayerBounds(layer: HTMLElement, width = 600, height = 800) {
  vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect)
}

function mockPanLayerOverflow(
  panLayer: HTMLElement,
  {
    clientWidth = 360,
    clientHeight = 280,
    scrollWidth = 1100,
    scrollHeight = 1280,
    scrollLeft = 120,
    scrollTop = 140,
  }: Partial<{
    clientWidth: number
    clientHeight: number
    scrollWidth: number
    scrollHeight: number
    scrollLeft: number
    scrollTop: number
  }> = {},
) {
  Object.defineProperty(panLayer, "clientWidth", { configurable: true, value: clientWidth })
  Object.defineProperty(panLayer, "clientHeight", { configurable: true, value: clientHeight })
  Object.defineProperty(panLayer, "scrollWidth", { configurable: true, value: scrollWidth })
  Object.defineProperty(panLayer, "scrollHeight", { configurable: true, value: scrollHeight })
  panLayer.scrollLeft = scrollLeft
  panLayer.scrollTop = scrollTop
}

beforeEach(() => {
  canvasContext = mockCanvasApis()
  vi.mocked(loadPdfJs).mockReset()
  vi.mocked(recordSophiaCaptureEvent).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ArtifactPdfPreview", () => {
  it("shows preview unavailable when the artifact fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("missing", { status: 404 }))

    renderPreview()

    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument()
    expect(vi.mocked(loadPdfJs)).not.toHaveBeenCalled()
  })

  it("loads page 1 and sizes the canvas from the PDF.js viewport", async () => {
    const pdf = mockPdfDocument()
    renderPreview({ zoom: 1.25 })

    const canvas = await screen.findByLabelText("PDF page 1")
    expect(pdf.fetchPdf).toHaveBeenCalledWith(
      "/artifact.pdf",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        method: "GET",
      }),
    )
    expect(pdf.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.any(Uint8Array),
    }))
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(1))
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1.25"))

    expect(canvas).toHaveAttribute("width", "750")
    expect(canvas).toHaveAttribute("height", "1000")
    expect(canvas.style.width).toBe("750px")
    expect(canvas.style.height).toBe("1000px")
    expect(pdf.render).toHaveBeenCalledWith(1, expect.objectContaining({ canvas }))
  })

  it("extracts PDF.js textContent and reports exact text metadata without OCR", async () => {
    const onTextExtractionStatusChange = vi.fn()
    const pdf = mockPdfDocument({
      pageCount: 2,
      textByPage: ["Launch metric Alpha 42", "Budget delta 17.4 percent"],
    })

    renderPreview({ onTextExtractionStatusChange })

    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument()
    await waitFor(() => expect(pdf.getTextContent).toHaveBeenCalledWith(1))
    await waitFor(() => expect(pdf.getTextContent).toHaveBeenCalledWith(2))
    await waitFor(() => expect(onTextExtractionStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      source: "pdf_text_extraction",
      pageCount: 2,
      truncated: false,
      text: expect.stringContaining("Launch metric Alpha 42"),
    })))
    expect(onTextExtractionStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Budget delta 17.4 percent"),
    }))
  })

  it("reports exact text unavailable when PDF.js textContent has no text", async () => {
    const onTextExtractionStatusChange = vi.fn()
    mockPdfDocument({ pageCount: 2, textByPage: ["", ""] })

    renderPreview({ onTextExtractionStatusChange })

    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument()
    await waitFor(() => expect(onTextExtractionStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "unavailable",
      source: "pdf_text_extraction",
      pageCount: 2,
      charCount: 0,
      safeReason: "pdf_text_empty",
    })))
    expect(JSON.stringify(onTextExtractionStatusChange.mock.calls)).not.toMatch(/rawArtifactText/)
  })

  it("keeps the zoomed PDF page inside an internal pan layer", async () => {
    mockPdfDocument({ pageCount: 2 })
    renderPreview({
      fitMode: "custom",
      zoom: 1.8,
      fitBounds: { width: 760, height: 620 },
    })

    const canvas = await screen.findByLabelText("PDF page 1")
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1.8"))

    const documentPage = screen.getByTestId("artifact-document-page")
    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    const scrollContent = screen.getByTestId("artifact-pdf-scroll-content")
    const pageFrame = screen.getByTestId("artifact-pdf-page-frame")
    const rail = screen.getByTestId("artifact-page-rail")

    expect(documentPage.className).toContain("overflow-hidden")
    expect(documentPage.className).not.toContain("overflow-visible")
    expect(panLayer.className).toContain("overflow-auto")
    expect(panLayer.style.scrollbarColor).toBe("var(--cosmic-border) transparent")
    expect(scrollContent.className).toContain("w-max")
    expect(pageFrame.style.width).toBe("1080px")
    expect(pageFrame.style.height).toBe("1440px")
    expect(documentPage).toContainElement(rail)
    expect(panLayer).not.toContainElement(rail)
  })

  it("renders PDF page thumbnails and selects pages from the rail", async () => {
    const onPageIndexChange = vi.fn()
    const pdf = mockPdfDocument({ pageCount: 2 })
    const { rerenderPreview } = renderPreview({ onPageIndexChange })

    const rail = await screen.findByTestId("artifact-page-rail")
    await waitFor(() => {
      expect(within(rail).getAllByTestId("artifact-pdf-thumbnail-canvas")).toHaveLength(2)
      expect(
        within(rail)
          .getAllByTestId("artifact-pdf-thumbnail-canvas")
          .map((canvas) => canvas.getAttribute("data-artifact-pdf-thumbnail-page-number")),
      ).toEqual(["1", "2"])
    })
    expect(pdf.render).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        canvas: expect.objectContaining({
          dataset: expect.objectContaining({
            artifactPdfThumbnail: "true",
            artifactPdfThumbnailPageNumber: "2",
          }),
        }),
      }),
    )

    const pageOneButton = within(rail).getByLabelText("Page 1")
    const pageTwoButton = within(rail).getByLabelText("Page 2")
    expect(pageOneButton).toHaveAttribute("aria-current", "page")
    expect(pageOneButton.className).toContain("ring-2")

    fireEvent.click(pageTwoButton)
    expect(onPageIndexChange).toHaveBeenCalledWith(1)

    rerenderPreview({ pageIndex: 1, onPageIndexChange })
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2))
    expect(await screen.findByLabelText("PDF page 2")).toHaveAttribute("data-artifact-page-number", "2")
    expect(within(rail).getByLabelText("Page 2")).toHaveAttribute("aria-current", "page")
  })

  it("falls back to numbered page buttons when thumbnail rendering fails", async () => {
    mockPdfDocument({
      pageCount: 2,
      renderTaskForPage: (_pageNumber, params) => (
        isThumbnailRender(params)
          ? { promise: Promise.reject(new Error("thumbnail failed")), cancel: vi.fn() }
          : immediateRenderTask()
      ),
    })

    renderPreview()

    const rail = await screen.findByTestId("artifact-page-rail")
    await waitFor(() => {
      expect(within(rail).getAllByTestId("artifact-pdf-thumbnail-fallback")).toHaveLength(2)
    })
    expect(within(rail).getByLabelText("Page 1")).toHaveAttribute("aria-current", "page")
    expect(within(rail).getByLabelText("Page 2")).toBeInTheDocument()
  })

  it("renders next and previous pages without stale cancellation blanking the current canvas", async () => {
    const firstRender = createDeferred<void>()
    const secondRender = createDeferred<void>()
    let firstPageRenderCount = 0
    const firstCancel = vi.fn(() => firstRender.reject(pdfCancelError()))
    const pdf = mockPdfDocument({
      renderTaskForPage: (pageNumber, params) => {
        if (isThumbnailRender(params)) {
          return immediateRenderTask()
        }

        if (pageNumber === 1) {
          firstPageRenderCount += 1
          return firstPageRenderCount === 1
            ? { promise: firstRender.promise, cancel: firstCancel }
            : immediateRenderTask()
        }

        if (pageNumber === 2) {
          return { promise: secondRender.promise, cancel: vi.fn() }
        }

        return immediateRenderTask()
      },
    })

    const { rerenderPreview } = renderPreview()

    await waitFor(() => expect(pdf.render).toHaveBeenCalledWith(1, expect.anything()))

    rerenderPreview({ pageIndex: 1 })

    await waitFor(() => expect(firstCancel).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2))

    await act(async () => {
      secondRender.resolve()
      await secondRender.promise
    })

    const pageTwoCanvas = await screen.findByLabelText("PDF page 2")
    await waitFor(() => expect(pageTwoCanvas).toHaveAttribute("data-artifact-page-number", "2"))
    expect(Number(pageTwoCanvas.getAttribute("width"))).toBeGreaterThan(0)
    expect(Number(pageTwoCanvas.getAttribute("height"))).toBeGreaterThan(0)

    rerenderPreview({ pageIndex: 0 })

    await waitFor(() => expect(pdf.getPage).toHaveBeenLastCalledWith(1))
    expect(await screen.findByLabelText("PDF page 1")).toHaveAttribute("data-artifact-page-number", "1")
  })

  it("applies fit width, fit page, and custom zoom as PDF.js viewport scales", async () => {
    mockPdfDocument()
    const { rerenderPreview } = renderPreview({
      fitBounds: { width: 1000, height: 900 },
      fitMode: "width",
      zoom: 1,
    })

    const canvas = await screen.findByLabelText("PDF page 1")
    await waitFor(() => expect(Number(canvas.getAttribute("data-artifact-pdf-scale"))).toBeCloseTo(1.59, 2))

    rerenderPreview({
      fitBounds: { width: 1000, height: 900 },
      fitMode: "page",
      zoom: 1,
    })
    await waitFor(() => expect(Number(canvas.getAttribute("data-artifact-pdf-scale"))).toBeGreaterThan(0.93))
    expect(Number(canvas.getAttribute("data-artifact-pdf-scale"))).toBeLessThan(0.96)

    rerenderPreview({
      fitBounds: { width: 1000, height: 900 },
      fitMode: "custom",
      zoom: 1.4,
    })
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1.4"))
  })

  it("creates a page-scoped normalized highlight by dragging on the PDF page", async () => {
    mockPdfDocument({ pageCount: 2 })
    renderAnnotationPreview({ initialToolMode: "highlight" })

    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument()
    const layer = screen.getByTestId("artifact-pdf-annotation-layer")
    mockAnnotationLayerBounds(layer)

    fireEvent.pointerDown(layer, { button: 0, clientX: 60, clientY: 80, pointerId: 1 })
    fireEvent.pointerMove(layer, { button: 0, clientX: 240, clientY: 320, pointerId: 1 })
    expect(screen.getByTestId("artifact-highlight-draft")).toBeInTheDocument()
    fireEvent.pointerUp(layer, { button: 0, clientX: 240, clientY: 320, pointerId: 1 })

    const highlight = await screen.findByTestId("artifact-highlight-annotation")
    expect(highlight).toHaveAttribute("data-annotation-page-index", "0")
    expect(highlight).toHaveAttribute("data-annotation-x", "0.1000")
    expect(highlight).toHaveAttribute("data-annotation-y", "0.1000")
    expect(highlight).toHaveAttribute("data-annotation-width", "0.3000")
    expect(highlight).toHaveAttribute("data-annotation-height", "0.3000")
    expect(highlight).toHaveAttribute("aria-pressed", "true")
    expect(layer).toHaveAttribute("data-artifact-tool-mode", "highlight")
  })

  it("creates a visible page-scoped underline without creating a highlight or comment", async () => {
    mockPdfDocument({ pageCount: 2 })
    renderAnnotationPreview({ initialToolMode: "underline" })

    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument()
    const layer = screen.getByTestId("artifact-pdf-annotation-layer")
    mockAnnotationLayerBounds(layer)

    fireEvent.pointerDown(layer, { button: 0, clientX: 90, clientY: 180, pointerId: 11 })
    fireEvent.pointerMove(layer, { button: 0, clientX: 390, clientY: 210, pointerId: 11 })
    expect(screen.getByTestId("artifact-underline-draft")).toBeInTheDocument()
    fireEvent.pointerUp(layer, { button: 0, clientX: 390, clientY: 210, pointerId: 11 })

    const underline = await screen.findByTestId("artifact-underline-annotation")
    expect(underline).toHaveAttribute("data-annotation-page-index", "0")
    expect(underline).toHaveAttribute("data-annotation-kind", "underline")
    expect(underline).toHaveAttribute("data-annotation-x", "0.1500")
    expect(underline).toHaveAttribute("data-annotation-width", "0.5000")
    expect(underline).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByTestId("artifact-highlight-annotation")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-comment-pin")).not.toBeInTheDocument()
    expect(layer).toHaveAttribute("data-artifact-tool-mode", "underline")
  })

  it("creates a visible page-scoped arrow without triggering pan or comments", async () => {
    const onCreateComment = vi.fn()
    mockPdfDocument({ pageCount: 2 })
    renderAnnotationPreview({ initialToolMode: "arrow" })

    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument()
    const layer = screen.getByTestId("artifact-pdf-annotation-layer")
    mockAnnotationLayerBounds(layer)

    fireEvent.pointerDown(layer, { button: 0, clientX: 120, clientY: 160, pointerId: 12 })
    fireEvent.pointerMove(layer, { button: 0, clientX: 420, clientY: 360, pointerId: 12 })
    expect(screen.getByTestId("artifact-arrow-draft-vector")).toBeInTheDocument()
    fireEvent.pointerUp(layer, { button: 0, clientX: 420, clientY: 360, pointerId: 12 })

    const arrow = await screen.findByTestId("artifact-arrow-annotation")
    expect(arrow).toHaveAttribute("data-annotation-page-index", "0")
    expect(arrow).toHaveAttribute("data-annotation-kind", "arrow")
    expect(arrow).toHaveAttribute("data-annotation-start-x", "0.2000")
    expect(arrow).toHaveAttribute("data-annotation-start-y", "0.2000")
    expect(arrow).toHaveAttribute("data-annotation-end-x", "0.7000")
    expect(arrow).toHaveAttribute("data-annotation-end-y", "0.4500")
    expect(screen.getByTestId("artifact-pdf-pan-layer")).toHaveAttribute("data-pan-dragging", "false")
    expect(onCreateComment).not.toHaveBeenCalled()
    expect(layer).toHaveAttribute("data-artifact-tool-mode", "arrow")
  })

  it("keeps highlight, comment, underline, and arrow overlays visible after a zoom rerender", async () => {
    mockPdfDocument({ pageCount: 2 })
    const highlightAnnotation = {
      id: "highlight-1",
      kind: "highlight",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.2, width: 0.35, height: 0.18 },
      createdAt: 1,
    } satisfies ArtifactAnnotation
    const commentAnnotation = {
      id: "comment-1",
      kind: "comment",
      pageIndex: 0,
      point: { x: 0.62, y: 0.22 },
      text: "change the font",
      createdAt: 1,
    } satisfies ArtifactAnnotation
    const underlineAnnotation = {
      id: "underline-1",
      kind: "underline",
      pageIndex: 0,
      rect: { x: 0.18, y: 0.42, width: 0.32, height: 0.04 },
      color: "purple",
      createdAt: 1,
    } satisfies ArtifactAnnotation
    const arrowAnnotation = {
      id: "arrow-1",
      kind: "arrow",
      pageIndex: 0,
      line: { start: { x: 0.25, y: 0.55 }, end: { x: 0.55, y: 0.68 } },
      color: "purple",
      createdAt: 1,
    } satisfies ArtifactAnnotation

    const { rerenderPreview } = renderPreview({
      annotations: [highlightAnnotation, commentAnnotation, underlineAnnotation, arrowAnnotation],
      selectedAnnotationId: "highlight-1",
    })

    const highlight = await screen.findByTestId("artifact-highlight-annotation")
    expect(highlight).toHaveStyle({
      left: "10%",
      top: "20%",
      width: "35%",
      height: "18%",
    })
    expect(screen.getByTestId("artifact-comment-pin")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-underline-annotation")).toHaveStyle({
      left: "18%",
      top: "42%",
      width: "32%",
      height: "4%",
    })
    expect(screen.getByTestId("artifact-arrow-vector")).toBeInTheDocument()

    rerenderPreview({
      annotations: [highlightAnnotation, commentAnnotation, underlineAnnotation, arrowAnnotation],
      selectedAnnotationId: "highlight-1",
      zoom: 1.8,
    })

    await waitFor(() => expect(screen.getByLabelText("PDF page 1")).toHaveAttribute("data-artifact-pdf-scale", "1.8"))
    expect(screen.getByTestId("artifact-highlight-annotation")).toHaveStyle({
      left: "10%",
      top: "20%",
      width: "35%",
      height: "18%",
    })
    expect(screen.getByTestId("artifact-comment-pin")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-underline-annotation")).toHaveStyle({
      left: "18%",
      top: "42%",
      width: "32%",
      height: "4%",
    })
    expect(screen.getByTestId("artifact-arrow-vector")).toBeInTheDocument()
  })

  it("creates a page-scoped comment pin with editable local text", async () => {
    mockPdfDocument({ pageCount: 2 })
    renderAnnotationPreview({ initialToolMode: "comment" })

    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument()
    const layer = screen.getByTestId("artifact-pdf-annotation-layer")
    mockAnnotationLayerBounds(layer)

    await act(async () => {
      fireEvent.pointerDown(layer, { button: 0, clientX: 300, clientY: 200, pointerId: 1 })
    })

    const pin = await screen.findByTestId("artifact-comment-pin")
    expect(pin).toHaveAttribute("aria-pressed", "true")
    const comment = screen.getByTestId("artifact-comment-annotation")
    expect(comment).toHaveAttribute("data-annotation-page-index", "0")
    expect(comment).toHaveAttribute("data-annotation-x", "0.5000")
    expect(comment).toHaveAttribute("data-annotation-y", "0.2500")
    expect(layer).toHaveAttribute("data-artifact-tool-mode", "comment")

    const input = screen.getByLabelText("Comment text")
    await act(async () => {
      fireEvent.change(input, { target: { value: "Tighten this paragraph." } })
    })
    expect(screen.getByDisplayValue("Tighten this paragraph.")).toBeInTheDocument()
  })

  it("selects annotations only in select mode and keeps pan mode non-intercepting", async () => {
    const annotation = {
      id: "highlight-1",
      kind: "highlight",
      pageIndex: 0,
      rect: { x: 0.15, y: 0.2, width: 0.3, height: 0.2 },
      createdAt: 1,
    } satisfies ArtifactAnnotation
    const onSelectAnnotation = vi.fn()
    mockPdfDocument({ pageCount: 2 })
    const { rerenderPreview } = renderPreview({
      annotations: [annotation],
      toolMode: "select",
      onSelectAnnotation,
    })

    const highlight = await screen.findByTestId("artifact-highlight-annotation")
    fireEvent.click(highlight)
    expect(onSelectAnnotation).toHaveBeenCalledWith("highlight-1")

    rerenderPreview({
      annotations: [annotation],
      selectedAnnotationId: "highlight-1",
      toolMode: "pan",
      onSelectAnnotation,
      zoom: 1.6,
    })

    expect(screen.getByTestId("artifact-pdf-annotation-layer").className).toContain("pointer-events-none")
    expect(screen.getByTestId("artifact-pdf-pan-layer").className).toContain("overflow-auto")
    await waitFor(() => expect(screen.getByLabelText("PDF page 1")).toHaveAttribute("data-artifact-pdf-scale", "1.6"))
  })

  it("pans the zoomed PDF scroll container in Pan mode without creating annotations", async () => {
    const onCreateHighlight = vi.fn()
    const onCreateComment = vi.fn()
    mockPdfDocument({ pageCount: 2 })
    renderPreview({
      toolMode: "pan",
      zoom: 1.8,
      fitMode: "custom",
      fitBounds: { width: 760, height: 620 },
      onCreateHighlight,
      onCreateComment,
    })

    await waitFor(() => expect(screen.getByLabelText("PDF page 1")).toHaveAttribute("data-artifact-pdf-scale", "1.8"))
    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    mockPanLayerOverflow(panLayer, { scrollLeft: 120, scrollTop: 140 })

    expect(panLayer).toHaveAttribute("data-pan-mode-active", "true")
    expect(panLayer).toHaveAttribute("data-pan-dragging", "false")
    expect(panLayer.className).toContain("cursor-grab")

    fireEvent.pointerDown(panLayer, { button: 0, clientX: 300, clientY: 240, pointerId: 7 })
    expect(panLayer).toHaveAttribute("data-pan-dragging", "true")
    expect(panLayer.className).toContain("cursor-grabbing")

    fireEvent.pointerMove(panLayer, { clientX: 240, clientY: 180, pointerId: 7 })
    expect(panLayer.scrollLeft).toBe(180)
    expect(panLayer.scrollTop).toBe(200)

    fireEvent.pointerUp(panLayer, { clientX: 240, clientY: 180, pointerId: 7 })
    expect(panLayer).toHaveAttribute("data-pan-dragging", "false")
    expect(onCreateHighlight).not.toHaveBeenCalled()
    expect(onCreateComment).not.toHaveBeenCalled()
    expect(screen.queryByTestId("artifact-highlight-draft")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-comment-pin")).not.toBeInTheDocument()
    expect(vi.mocked(recordSophiaCaptureEvent)).toHaveBeenCalledWith(expect.objectContaining({
      category: "artifacts-runtime",
      name: "artifact-pan-gesture",
      payload: expect.objectContaining({
        panModeActive: true,
        panGestureCount: 1,
        panGestureResult: "success",
        panScrollDeltaX: 60,
        panScrollDeltaY: 60,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
        rawCommentTextExcluded: true,
      }),
    }))
  })

  it("re-measures Pan mode overflow during drag after zoom layout settles", async () => {
    mockPdfDocument({ pageCount: 2 })
    renderPreview({
      toolMode: "pan",
      zoom: 1.8,
      fitMode: "custom",
      fitBounds: { width: 760, height: 620 },
    })

    await waitFor(() => expect(screen.getByLabelText("PDF page 1")).toHaveAttribute("data-artifact-pdf-scale", "1.8"))
    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    mockPanLayerOverflow(panLayer, {
      clientWidth: 360,
      clientHeight: 280,
      scrollWidth: 360,
      scrollHeight: 280,
      scrollLeft: 0,
      scrollTop: 0,
    })

    fireEvent.pointerDown(panLayer, { button: 0, clientX: 300, clientY: 240, pointerId: 9 })
    expect(panLayer).toHaveAttribute("data-pan-dragging", "true")

    mockPanLayerOverflow(panLayer, {
      clientWidth: 360,
      clientHeight: 280,
      scrollWidth: 1100,
      scrollHeight: 1280,
      scrollLeft: 0,
      scrollTop: 0,
    })

    fireEvent.pointerMove(panLayer, { clientX: 220, clientY: 190, pointerId: 9 })
    expect(panLayer.scrollLeft).toBe(80)
    expect(panLayer.scrollTop).toBe(50)

    fireEvent.pointerUp(panLayer, { clientX: 220, clientY: 190, pointerId: 9 })
    expect(panLayer).toHaveAttribute("data-pan-dragging", "false")
    expect(vi.mocked(recordSophiaCaptureEvent)).toHaveBeenLastCalledWith(expect.objectContaining({
      category: "artifacts-runtime",
      name: "artifact-pan-gesture",
      payload: expect.objectContaining({
        panModeActive: true,
        panGestureResult: "success",
        panScrollDeltaX: 80,
        panScrollDeltaY: 50,
      }),
    }))
  })

  it("keeps Pan mode bound after zoom and page changes", async () => {
    mockPdfDocument({ pageCount: 2 })
    const { rerenderPreview } = renderPreview({
      toolMode: "pan",
      zoom: 1.2,
      fitMode: "custom",
      fitBounds: { width: 760, height: 620 },
    })

    await waitFor(() => expect(screen.getByLabelText("PDF page 1")).toHaveAttribute("data-artifact-pdf-scale", "1.2"))

    rerenderPreview({
      toolMode: "pan",
      zoom: 1.8,
      fitMode: "custom",
      pageIndex: 1,
      fitBounds: { width: 760, height: 620 },
    })
    await waitFor(() => expect(screen.getByLabelText("PDF page 2")).toHaveAttribute("data-artifact-pdf-scale", "1.8"))

    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    mockPanLayerOverflow(panLayer, { scrollLeft: 40, scrollTop: 50 })

    fireEvent.pointerDown(panLayer, { button: 0, clientX: 220, clientY: 210, pointerId: 12 })
    fireEvent.pointerMove(panLayer, { clientX: 180, clientY: 170, pointerId: 12 })
    fireEvent.pointerUp(panLayer, { clientX: 180, clientY: 170, pointerId: 12 })

    expect(panLayer.scrollLeft).toBe(80)
    expect(panLayer.scrollTop).toBe(90)
    expect(vi.mocked(recordSophiaCaptureEvent)).toHaveBeenLastCalledWith(expect.objectContaining({
      name: "artifact-pan-gesture",
      payload: expect.objectContaining({
        artifactPageIndex: 1,
        artifactPageNumber: 2,
        artifactZoom: 1.8,
        panGestureResult: "success",
      }),
    }))
  })

  it("shows only annotations for the active PDF page", async () => {
    mockPdfDocument({ pageCount: 2 })
    const annotations: ArtifactAnnotation[] = [
      {
        id: "highlight-page-1",
        kind: "highlight",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        createdAt: 1,
      },
      {
        id: "comment-page-2",
        kind: "comment",
        pageIndex: 1,
        point: { x: 0.5, y: 0.5 },
        text: "Second page note",
        createdAt: 1,
      },
      {
        id: "underline-page-2",
        kind: "underline",
        pageIndex: 1,
        rect: { x: 0.2, y: 0.65, width: 0.32, height: 0.04 },
        createdAt: 1,
      },
      {
        id: "arrow-page-1",
        kind: "arrow",
        pageIndex: 0,
        line: { start: { x: 0.24, y: 0.28 }, end: { x: 0.42, y: 0.36 } },
        createdAt: 1,
      },
    ]

    const { rerenderPreview } = renderPreview({ annotations, pageIndex: 0 })
    expect(await screen.findByTestId("artifact-highlight-annotation")).toHaveAttribute("data-annotation-id", "highlight-page-1")
    expect(screen.getByTestId("artifact-arrow-annotation")).toHaveAttribute("data-annotation-id", "arrow-page-1")
    expect(screen.queryByTestId("artifact-comment-pin")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-underline-annotation")).not.toBeInTheDocument()

    rerenderPreview({ annotations, pageIndex: 1 })
    await waitFor(() => expect(screen.getByLabelText("PDF page 2")).toHaveAttribute("data-artifact-page-index", "1"))
    expect(screen.queryByTestId("artifact-highlight-annotation")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-arrow-annotation")).not.toBeInTheDocument()
    expect(screen.getByTestId("artifact-comment-pin")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-underline-annotation")).toHaveAttribute("data-annotation-id", "underline-page-2")
  })

  it("composites highlight, comment, underline, and arrow overlays into the still-frame canvas", async () => {
    const onRenderStatusChange = vi.fn()
    mockPdfDocument({ pageCount: 1 })
    const annotations: ArtifactAnnotation[] = [
      {
        id: "highlight-1",
        kind: "highlight",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.12, width: 0.42, height: 0.08 },
        color: "yellow",
        source: "sophia",
        createdAt: 1,
      },
      {
        id: "comment-1",
        kind: "comment",
        pageIndex: 0,
        point: { x: 0.56, y: 0.12 },
        text: "change the font",
        source: "sophia",
        createdAt: 1,
      },
      {
        id: "underline-1",
        kind: "underline",
        pageIndex: 0,
        rect: { x: 0.18, y: 0.28, width: 0.32, height: 0.04 },
        color: "purple",
        source: "sophia",
        createdAt: 1,
      },
      {
        id: "arrow-1",
        kind: "arrow",
        pageIndex: 0,
        line: { start: { x: 0.22, y: 0.48 }, end: { x: 0.58, y: 0.62 } },
        color: "purple",
        source: "sophia",
        createdAt: 1,
      },
    ]

    renderPreview({ annotations, onRenderStatusChange })

    const composite = await screen.findByTestId("artifact-pdf-composite-canvas")
    await waitFor(() => expect(composite).toHaveAttribute("data-annotation-overlay-captured", "true"))
    await waitFor(() => expect(onRenderStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      ready: true,
      source: "pdf_page_canvas",
      annotationOverlayCaptured: true,
    })))
    expect(canvasContext.drawImage).toHaveBeenCalled()
    expect(canvasContext.fillRect).toHaveBeenCalled()
    expect(canvasContext.arc).toHaveBeenCalled()
    expect(canvasContext.moveTo).toHaveBeenCalled()
    expect(canvasContext.lineTo).toHaveBeenCalled()
    expect(canvasContext.stroke).toHaveBeenCalled()
    expect(JSON.stringify(onRenderStatusChange.mock.calls)).not.toContain("change the font")
  })
})
