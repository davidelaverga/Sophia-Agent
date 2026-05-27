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
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("captures only an artifact canvas stream when one is available", () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const root = document.createElement("section")
    const canvas = document.createElement("canvas") as HTMLCanvasElement & {
      captureStream: (frameRate?: number) => MediaStream
    }
    canvas.dataset.artifactId = "artifact-2"
    canvas.captureStream = vi.fn(() => stream)
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-2",
      frameRate: 2,
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("canvas_stream")
    expect(source.stream).toBe(stream)
    expect(canvas.captureStream).toHaveBeenCalledWith(2)

    stopArtifactVisualSource(source)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("does not fall back to DOM or browser chrome capture when canvas captureStream is missing", () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })

    const root = document.createElement("section")
    const canvas = document.createElement("canvas")
    canvas.dataset.coreviewArtifactCanvas = "true"
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({ root, artifactId: "artifact-3" })

    expect(source.status).toBe("unsupported")
    expect(source.reason).toBe("canvas_capture_stream_unavailable")
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
      artifactId: "artifact-4",
      mode: "still_frame",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("canvas_element")
    expect(source.element).toBe(canvas)
    expect(source.stream).toBeNull()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("uses the guarded real-artifact missing-canvas reason without falling back to broader capture", () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })

    const root = document.createElement("section")
    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-5",
      mode: "still_frame",
      missingCanvasReason: "real_artifact_canvas_unavailable",
    })

    expect(source.status).toBe("unsupported")
    expect(source.reason).toBe("real_artifact_canvas_unavailable")
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("marks offscreen-rendered builder canvases as offscreen_render sources", () => {
    const root = document.createElement("section")
    const canvas = document.createElement("canvas")
    canvas.dataset.artifactId = "artifact-6"
    canvas.dataset.coreviewOffscreenRender = "true"
    root.appendChild(canvas)

    const source = resolveArtifactVisualSource({
      root,
      artifactId: "artifact-6",
      mode: "still_frame",
    })

    expect(source.status).toBe("ready")
    expect(source.kind).toBe("offscreen_render")
  })
})
