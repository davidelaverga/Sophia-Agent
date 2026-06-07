import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ArtifactToolbar } from "../../../app/components/session/ArtifactToolbar"

vi.mock("../../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

describe("ArtifactToolbar", () => {
  it("keeps open and download actions while hiding unsupported zoom controls", () => {
    render(
      <ArtifactToolbar
        title="Launch brief"
        openHref="/artifact.md"
        downloadHref="/artifact.md?download=true"
        downloadName="artifact.md"
      />,
    )

    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief in new tab")).toHaveAttribute("href", "/artifact.md")
    expect(screen.getByLabelText("Download original Launch brief")).toHaveAttribute("download", "artifact.md")
    expect(screen.queryByLabelText("Zoom out")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Zoom in")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Fit to view")).not.toBeInTheDocument()
  })

  it("shows real pagination and zoom controls when the renderer supports them", () => {
    const onNextPage = vi.fn()
    const onZoomIn = vi.fn()
    const onFitWidth = vi.fn()

    render(
      <ArtifactToolbar
        title="Launch PDF"
        pageIndex={1}
        pageCount={3}
        supportsPagination
        supportsZoom
        zoom={1.2}
        fitMode="custom"
        onNextPage={onNextPage}
        onZoomIn={onZoomIn}
        onFitWidth={onFitWidth}
      />,
    )

    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument()
    expect(screen.getByText("120%")).toBeInTheDocument()
    expect(screen.getByLabelText("Previous page")).toBeEnabled()
    expect(screen.getByLabelText("Next page")).toBeEnabled()
    expect(screen.getByLabelText("Zoom in")).toBeInTheDocument()
    expect(screen.getByLabelText("Zoom out")).toBeInTheDocument()
    expect(screen.getByLabelText("Fit page")).toBeInTheDocument()
    expect(screen.getByLabelText("Fit width")).toBeInTheDocument()
    expect(screen.getByLabelText("Reset zoom")).toBeInTheDocument()
  })

  it("shows HTML zoom and annotation tools without page or arrow controls", () => {
    render(
      <ArtifactToolbar
        title="Launch site"
        pageLabel="HTML preview"
        supportsZoom
        supportsAnnotations
        supportsComments
        supportsUnderline
        supportsArrow={false}
        supportsFitPage={false}
        zoom={1}
        fitMode="width"
      />,
    )

    expect(screen.getByText("HTML preview")).toBeInTheDocument()
    expect(screen.getByText("Fit width")).toBeInTheDocument()
    expect(screen.getByLabelText("Select")).toBeInTheDocument()
    expect(screen.getByLabelText("Highlight")).toBeInTheDocument()
    expect(screen.getByLabelText("Underline")).toBeInTheDocument()
    expect(screen.getByLabelText("Comment")).toBeInTheDocument()
    expect(screen.getByLabelText("Zoom in")).toBeInTheDocument()
    expect(screen.getByLabelText("Zoom out")).toBeInTheDocument()
    expect(screen.queryByLabelText("Fit page")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Fit width")).toBeInTheDocument()
    expect(screen.getByLabelText("Reset zoom")).toBeInTheDocument()
    expect(screen.queryByLabelText("Previous page")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Pan")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Arrow")).not.toBeInTheDocument()
  })

  it("renders real annotation modes and marks the active tool", async () => {
    const user = userEvent.setup()
    const onToolModeChange = vi.fn()

    render(
      <ArtifactToolbar
        title="Launch PDF"
        supportsAnnotations
        supportsPan
        supportsComments
        supportsUnderline
        supportsArrow
        toolMode="highlight"
        onToolModeChange={onToolModeChange}
      />,
    )

    expect(screen.getByLabelText("Select")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Pan")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Highlight")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByLabelText("Underline")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Arrow")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Comment")).toHaveAttribute("aria-pressed", "false")

    await user.click(screen.getByLabelText("Arrow"))

    expect(onToolModeChange).toHaveBeenCalledWith("arrow")
  })

  it("truthfully separates original download from unavailable annotated export", () => {
    const onDownloadOriginal = vi.fn()
    const onExportAnnotated = vi.fn()

    render(
      <ArtifactToolbar
        title="Launch PDF"
        downloadHref="/artifact.pdf?download=true"
        downloadName="artifact.pdf"
        supportsAnnotations
        supportsPan
        supportsComments
        supportsUnderline
        supportsArrow
        annotationCount={2}
        annotationExportAvailable={false}
        onDownloadOriginal={onDownloadOriginal}
        onExportAnnotated={onExportAnnotated}
      />,
    )

    expect(screen.getByLabelText("Download original Launch PDF")).toHaveTextContent("Download original")
    const exportButton = screen.getByLabelText("Export annotated copy Launch PDF")
    expect(exportButton).toBeDisabled()
    expect(exportButton).toHaveAttribute("title", "Annotated export is not available yet.")
    expect(exportButton).toHaveAttribute("data-annotation-count", "2")
  })

  it("does not show unsupported annotation or export tools for PPTX fallback", () => {
    render(
      <ArtifactToolbar
        title="Launch deck"
        openHref="/artifact.pptx"
        downloadHref="/artifact.pptx?download=true"
        downloadName="artifact.pptx"
        supportsAnnotations={false}
        supportsPan={false}
        supportsZoom={false}
        supportsPagination={false}
        supportsOpenInNewTab
        supportsOriginalDownload
        annotationExportAvailable={false}
      />,
    )

    expect(screen.getByLabelText("Open Launch deck in new tab")).toBeInTheDocument()
    expect(screen.getByLabelText("Download original Launch deck")).toBeInTheDocument()
    expect(screen.queryByLabelText("Highlight")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Underline")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Arrow")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Comment")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Export annotated copy Launch deck")).not.toBeInTheDocument()
  })
})
