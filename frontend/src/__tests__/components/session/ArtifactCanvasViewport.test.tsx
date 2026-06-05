import { render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactCanvasViewport } from "../../../app/components/session/ArtifactCanvasViewport"
import { loadPdfJs } from "../../../app/lib/pdfjs-loader"
import type { BuilderArtifactV1 } from "../../../app/types/builder-artifact"

vi.mock("../../../app/lib/pdfjs-loader", () => ({
  loadPdfJs: vi.fn(),
}))

const builderArtifact = {
  artifactTitle: "Launch brief overview",
  artifactType: "document",
  artifactPath: "mnt/user-data/outputs/launch-brief.docx",
  supportingFiles: [],
  decisionsMade: ["Kept the review focused."],
  companionSummary: "Overview card for the completed launch brief.",
  userNextAction: "Open the document for the full deliverable.",
} satisfies BuilderArtifactV1

const pdfArtifact = {
  ...builderArtifact,
  artifactPath: "mnt/user-data/outputs/launch-brief.pdf",
} satisfies BuilderArtifactV1

const markdownArtifact = {
  ...builderArtifact,
  artifactPath: "mnt/user-data/outputs/launch-brief.md",
} satisfies BuilderArtifactV1
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

function mockCanvasApis() {
  const context = {
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
}

function mockPdfDocument({ pageCount = 2 }: { pageCount?: number } = {}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({
      numPages: pageCount,
      fingerprints: [`viewport-pdf-${pageCount}`],
      getPage,
    }),
    destroy: vi.fn(),
  }))

  vi.mocked(loadPdfJs).mockResolvedValue({
    getDocument,
  } as unknown as Awaited<ReturnType<typeof loadPdfJs>>)

  return { getDocument, getPage, getViewport, render }
}

const htmlArtifact = {
  ...builderArtifact,
  artifactType: "webpage",
  artifactPath: "mnt/user-data/outputs/launch-brief.html",
} satisfies BuilderArtifactV1

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(loadPdfJs).mockReset()
})

describe("ArtifactCanvasViewport", () => {
  it("renders a complete canvas bed around the document page", () => {
    render(
      <ArtifactCanvasViewport
        artifact={builderArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.docx",
          name: "launch-brief.docx",
          label: "launch-brief.docx",
          isPrimary: true,
        }]}
        typeLabel="Document"
        reviewSurfaceState="active"
      />,
    )

    const viewport = screen.getByTestId("artifact-canvas-viewport")
    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const documentPage = screen.getByTestId("artifact-document-page")

    expect(viewport).toContainElement(canvasBed)
    expect(canvasBed).toContainElement(scrollArea)
    expect(scrollArea).toContainElement(documentPage)
    expect(canvasBed.className).toContain("sophia-purple")
    expect(scrollArea.className).toContain("[scrollbar-gutter:stable]")
    expect(scrollArea.style.scrollbarColor).toBe("var(--cosmic-border) transparent")
    expect(documentPage.className).toContain("min-h-full")
    expect(documentPage.className).toContain("max-w-[960px]")
  })

  it("keeps PDF loading state inside the canvas bed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(pdfBytes.slice(), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    )
    vi.mocked(loadPdfJs).mockResolvedValue({
      getDocument: vi.fn(() => ({
        promise: new Promise(() => undefined),
        destroy: vi.fn(),
      })),
    } as unknown as Awaited<ReturnType<typeof loadPdfJs>>)

    render(
      <ArtifactCanvasViewport
        artifact={pdfArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.pdf",
          name: "launch-brief.pdf",
          label: "launch-brief.pdf",
          isPrimary: true,
          mimeType: "application/pdf",
        }]}
        typeLabel="Document"
        previewHref="/artifact.pdf"
      />,
    )

    const canvasBed = await screen.findByTestId("artifact-canvas-bed")
    const previewRegion = await screen.findByLabelText("Artifact PDF preview")

    expect(canvasBed).toContainElement(screen.getByTestId("artifact-preview-state"))
    expect(within(previewRegion).getByText("Preparing PDF view")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-preview-state").className).not.toMatch(/\bfixed\b|\binset-0\b/)
  })

  it("keeps the PDF rail fixed while the PDF pan layer owns zoom overflow", async () => {
    mockCanvasApis()
    const pdf = mockPdfDocument({ pageCount: 2 })

    render(
      <ArtifactCanvasViewport
        artifact={pdfArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.pdf",
          name: "launch-brief.pdf",
          label: "launch-brief.pdf",
          isPrimary: true,
          mimeType: "application/pdf",
        }]}
        typeLabel="Document"
        previewHref="/artifact.pdf"
        pageIndex={0}
        pageCount={2}
        zoom={1.6}
        fitMode="custom"
      />,
    )

    const canvas = await screen.findByLabelText("PDF page 1")
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1.6"))

    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const documentPage = screen.getByTestId("artifact-document-page")
    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    const rail = screen.getByTestId("artifact-page-rail")

    expect(canvasBed.className).toContain("overflow-hidden")
    expect(scrollArea.className).toContain("overflow-hidden")
    expect(scrollArea.className).toContain("min-w-0")
    expect(documentPage.className).toContain("overflow-hidden")
    expect(panLayer.className).toContain("overflow-auto")
    expect(documentPage).toContainElement(rail)
    expect(panLayer).not.toContainElement(rail)
    expect(within(rail).getAllByTestId("artifact-pdf-thumbnail-canvas")).toHaveLength(2)
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2))
  })

  it("keeps markdown loading state inside the canvas bed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    )

    render(
      <ArtifactCanvasViewport
        artifact={markdownArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.md",
          name: "launch-brief.md",
          label: "launch-brief.md",
          isPrimary: true,
          mimeType: "text/markdown",
        }]}
        typeLabel="Document"
        previewHref="/artifact.md"
      />,
    )

    const canvasBed = await screen.findByTestId("artifact-canvas-bed")
    const previewRegion = await screen.findByLabelText("Artifact document preview")

    expect(canvasBed).toContainElement(screen.getByTestId("artifact-preview-state"))
    expect(within(previewRegion).getByText("Preparing document view")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-preview-state").className).not.toMatch(/\bfixed\b|\binset-0\b/)
  })

  it("renders HTML artifacts in a sandboxed iframe preview", async () => {
    const onVisualCaptureStatusChange = vi.fn()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><head><title>Deck fallback</title></head><body><h1>Deck fallback</h1><p>Readable slide content.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        onVisualCaptureStatusChange={onVisualCaptureStatusChange}
      />,
    )

    const previewRegion = await screen.findByLabelText("Artifact HTML preview")
    const iframe = await screen.findByTitle("Preview of launch-brief.html")

    expect(previewRegion).toContainElement(iframe)
    expect(iframe).toHaveAttribute("sandbox", "")
    expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Deck fallback</h1>"))
    expect(onVisualCaptureStatusChange).toHaveBeenLastCalledWith({
      ready: true,
      reason: null,
      source: "html_preview_canvas",
      exactTextAvailable: true,
    })
  })
})
