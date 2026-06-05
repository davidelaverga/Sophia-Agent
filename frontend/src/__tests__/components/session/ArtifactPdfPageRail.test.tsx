import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ArtifactPdfPageRail } from "../../../app/components/session/ArtifactPdfPageRail"
import type { PdfDocumentProxy } from "../../../app/lib/pdfjs-loader"

function mockCanvasApis() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
}

function createMockPdfDocument(): PdfDocumentProxy {
  return {
    numPages: 3,
    fingerprints: ["rail-fixture"],
    getPage: vi.fn(async () => ({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 140 * scale,
      })),
      render: vi.fn(() => ({
        promise: Promise.resolve(),
        cancel: vi.fn(),
      })),
    })),
  } as unknown as PdfDocumentProxy
}

describe("ArtifactPdfPageRail", () => {
  beforeEach(() => {
    mockCanvasApis()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows truthful per-page annotation badges and remains clickable", async () => {
    const user = userEvent.setup()
    const document = createMockPdfDocument()
    const onPageIndexChange = vi.fn()

    const { rerender } = render(
      <ArtifactPdfPageRail
        document={document}
        pageCount={3}
        pageIndex={0}
        annotationPageCounts={new Map([[0, 1]])}
        annotationVersion="page-1"
        onPageIndexChange={onPageIndexChange}
      />,
    )

    expect(screen.getByRole("button", { name: "Page 1, 1 annotation" })).toHaveAttribute("data-annotation-count", "1")
    expect(screen.getByRole("button", { name: "Page 1, 1 annotation" })).toHaveAttribute("data-annotation-version", "page-1")
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("data-annotation-count", "0")
    expect(screen.getByTestId("artifact-pdf-thumbnail-annotation-badge")).toHaveTextContent("1")

    await user.click(screen.getByRole("button", { name: "Page 2" }))

    expect(onPageIndexChange).toHaveBeenCalledWith(1)

    rerender(
      <ArtifactPdfPageRail
        document={document}
        pageCount={3}
        pageIndex={1}
        annotationPageCounts={new Map([[1, 2]])}
        annotationVersion="page-2"
        onPageIndexChange={onPageIndexChange}
      />,
    )

    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("data-annotation-count", "0")
    expect(screen.getByRole("button", { name: "Page 2, 2 annotations" })).toHaveAttribute("data-annotation-count", "2")
    expect(screen.getByRole("button", { name: "Page 2, 2 annotations" })).toHaveAttribute("data-annotation-version", "page-2")

    rerender(
      <ArtifactPdfPageRail
        document={document}
        pageCount={3}
        pageIndex={1}
        annotationPageCounts={new Map()}
        annotationVersion="empty"
        onPageIndexChange={onPageIndexChange}
      />,
    )

    expect(screen.queryByTestId("artifact-pdf-thumbnail-annotation-badge")).not.toBeInTheDocument()
    await waitFor(() => expect(document.getPage).toHaveBeenCalled())
  })
})
