import { describe, expect, it, vi } from "vitest"

import {
  resolveArtifactVisualSource,
  stopArtifactVisualSource,
} from "../../app/lib/co-review-capture"

describe("co-review artifact capture", () => {
  it("returns unsupported without using whole-screen capture when no artifact canvas exists", () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })

    const root = document.createElement("section")
    const source = resolveArtifactVisualSource({ root, artifactId: "artifact-1" })

    expect(source.status).toBe("unsupported")
    expect(source.reason).toBe("artifact_canvas_not_found")
    expect(source.element).toBeNull()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("resolves still-frame canvas sources without requiring captureStream", () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })

    const root = document.createElement("section")
    const canvas = document.createElement("canvas")
    canvas.dataset.coreviewArtifactCanvas = "true"
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-2",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("canvas_element")
    expect(source.element).toBe(canvas)
    expect("stream" in source).toBe(false)
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("does not fall back to DOM, browser chrome, or captureStream for still frames", () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })

    const root = document.createElement("section")
    const canvas = document.createElement("canvas") as HTMLCanvasElement & {
      captureStream: (frameRate?: number) => MediaStream
    }
    canvas.dataset.coreviewArtifactCanvas = "true"
    canvas.captureStream = vi.fn()
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-3",
      mode: "still_frame",
    })

    expect(source.status).toBe("ready")
    expect(canvas.captureStream).not.toHaveBeenCalled()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("uses the guarded real-artifact missing-canvas reason without broader capture", () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })

    const root = document.createElement("section")
    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-4",
      missingCanvasReason: "real_artifact_canvas_unavailable",
    })

    expect(source.status).toBe("unsupported")
    expect(source.reason).toBe("real_artifact_canvas_unavailable")
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("marks offscreen-rendered canvases as offscreen_render sources", () => {
    const root = document.createElement("section")
    const canvas = document.createElement("canvas")
    canvas.dataset.artifactId = "artifact-5"
    canvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-5",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("offscreen_render")
  })

  it("prefers the selected markdown preview canvas over an older matching metadata canvas", () => {
    const root = document.createElement("section")
    const metadataCanvas = document.createElement("canvas")
    metadataCanvas.dataset.artifactId = "artifact-6"
    metadataCanvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(metadataCanvas)

    const selectedPreviewCanvas = document.createElement("canvas")
    selectedPreviewCanvas.dataset.artifactId = "artifact-6"
    selectedPreviewCanvas.dataset.artifactCanvasSource = "selected-markdown-preview"
    selectedPreviewCanvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(selectedPreviewCanvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-6",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("offscreen_render")
    expect(source.element).toBe(selectedPreviewCanvas)
  })

  it("resolves selected HTML preview canvases with an HTML source kind", () => {
    const root = document.createElement("section")
    const canvas = document.createElement("canvas")
    canvas.dataset.artifactId = "artifact-html"
    canvas.dataset.artifactCanvasSource = "selected-html-preview"
    canvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-html",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("html_preview_canvas")
    expect(source.element).toBe(canvas)
  })

  it("prefers the selected HTML revision canvas over an older matching metadata canvas", () => {
    const root = document.createElement("section")
    const metadataCanvas = document.createElement("canvas")
    metadataCanvas.dataset.artifactId = "artifact-html-revision"
    metadataCanvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(metadataCanvas)

    const selectedRevisionCanvas = document.createElement("canvas")
    selectedRevisionCanvas.dataset.coreviewArtifactId = "artifact-html-revision"
    selectedRevisionCanvas.dataset.coreviewArtifactCanvasSource = "selected-html-preview"
    selectedRevisionCanvas.dataset.coreviewArtifactVersionId = "logical-html-artifact::v2"
    selectedRevisionCanvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(selectedRevisionCanvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-html-revision",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("html_preview_canvas")
    expect(source.element).toBe(selectedRevisionCanvas)
  })

  it("keeps PDF composite capture behavior unchanged", () => {
    const root = document.createElement("section")
    const canvas = document.createElement("canvas")
    canvas.dataset.artifactId = "artifact-pdf"
    canvas.dataset.artifactCanvasSource = "selected-pdf-page-composite"
    canvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-pdf",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("offscreen_render")
    expect(source.element).toBe(canvas)
  })

  it("stopArtifactVisualSource is a no-op for one-shot still-frame sources", () => {
    expect(() => stopArtifactVisualSource(resolveArtifactVisualSource())).not.toThrow()
  })
})
