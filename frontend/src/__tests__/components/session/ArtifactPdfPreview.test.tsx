import { act, render, screen, waitFor } from "@testing-library/react"
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

function mockPdfDocument({
  pageCount = 3,
  renderTaskForPage = () => immediateRenderTask(),
}: {
  pageCount?: number
  renderTaskForPage?: (pageNumber: number) => { promise: Promise<void>; cancel: ReturnType<typeof vi.fn> }
} = {}) {
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({
    width: 600 * scale,
    height: 800 * scale,
    scale,
  }))
  const render = vi.fn((pageNumber: number, _params: unknown) => renderTaskForPage(pageNumber))
  const getPage = vi.fn(async (pageNumber: number) => ({
    getViewport,
    render: (params: unknown) => render(pageNumber, params),
  }))
  const pdfDocument = {
    numPages: pageCount,
    getPage,
  }
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve(pdfDocument),
    destroy: vi.fn(),
  }))

  vi.mocked(loadPdfJs).mockResolvedValue({
    getDocument,
  } as unknown as Awaited<ReturnType<typeof loadPdfJs>>)

  return { getDocument, getPage, getViewport, render }
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
  it("loads page 1 and sizes the canvas from the PDF.js viewport", async () => {
    const pdf = mockPdfDocument()
    renderPreview({ zoom: 1.25 })

    const canvas = await screen.findByLabelText("PDF page 1")
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(1))
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1.25"))

    expect(canvas).toHaveAttribute("width", "750")
    expect(canvas).toHaveAttribute("height", "1000")
    expect(canvas.style.width).toBe("750px")
    expect(canvas.style.height).toBe("1000px")
    expect(pdf.render).toHaveBeenLastCalledWith(1, expect.objectContaining({ canvas }))
  })

  it("renders next and previous pages without stale cancellation blanking the current canvas", async () => {
    const firstRender = createDeferred<void>()
    const secondRender = createDeferred<void>()
    let firstPageRenderCount = 0
    const firstCancel = vi.fn(() => firstRender.reject(pdfCancelError()))
    const pdf = mockPdfDocument({
      renderTaskForPage: (pageNumber) => {
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
