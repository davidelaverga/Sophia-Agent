import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ArtifactPdfPreview } from "../../../app/components/session/ArtifactPdfPreview"
import { loadPdfJs } from "../../../app/lib/pdfjs-loader"
import type { BuilderArtifactV1 } from "../../../app/types/builder-artifact"

vi.mock("../../../app/lib/pdfjs-loader", () => ({
  loadPdfJs: vi.fn(),
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

function mockCanvasApis() {
  const context = {
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
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
  return text.split(/\s+/u).filter(Boolean).map((str) => ({ str }))
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

beforeEach(() => {
  mockCanvasApis()
  vi.mocked(loadPdfJs).mockReset()
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
})
