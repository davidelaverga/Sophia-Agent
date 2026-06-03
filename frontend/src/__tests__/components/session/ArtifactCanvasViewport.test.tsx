import { render, screen, within } from "@testing-library/react"
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
})
