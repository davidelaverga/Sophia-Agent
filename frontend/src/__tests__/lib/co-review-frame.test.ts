import { afterEach, describe, expect, it, vi } from "vitest"

import type { ArtifactVisualSource } from "../../app/lib/co-review-capture"
import {
  encodeArtifactStillFrame,
  safeArtifactFrameTelemetry,
} from "../../app/lib/co-review-frame"

const originalToBlob = HTMLCanvasElement.prototype.toBlob

afterEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value: originalToBlob,
  })
})

function canvasSource(width = 2048, height = 512): ArtifactVisualSource {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return {
    kind: "canvas_element",
    status: "ready",
    artifactId: "artifact-frame",
    element: canvas,
    reason: null,
  }
}

function mockCanvasEncoding(size = 64) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)

  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value(callback: BlobCallback, mimeType?: string) {
      callback(new Blob([new Uint8Array(size)], { type: mimeType || "image/jpeg" }))
    },
  })
}

describe("co-review still-frame encoder", () => {
  it("encodes only the artifact canvas and caps the longest edge", async () => {
    mockCanvasEncoding()

    const result = await encodeArtifactStillFrame(canvasSource(), {
      maxLongestEdge: 1024,
      clock: vi.fn().mockReturnValueOnce(5).mockReturnValueOnce(9),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.dimensions).toEqual({ width: 1024, height: 256 })
    expect(result.payload.byteLength).toBe(64)
    expect(result.payload.mimeType).toBe("image/jpeg")
    expect(result.encodeLatencyMs).toBe(4)
  })

  it("returns unsupported for DOM-only artifacts without screen capture", async () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })

    const result = await encodeArtifactStillFrame({
      kind: "unsupported",
      status: "unsupported",
      artifactId: "dom-only",
      element: null,
      reason: "artifact_canvas_not_found",
    })

    expect(result.ok).toBe(false)
    if (result.ok === true) return
    expect(result.reason).toBe("artifact_canvas_not_found")
    expect(result.rawFrameExcluded).toBe(true)
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("redacts raw base64 from telemetry", async () => {
    mockCanvasEncoding()

    const result = await encodeArtifactStillFrame(canvasSource(320, 160))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const telemetry = safeArtifactFrameTelemetry(result.payload)
    const serialized = JSON.stringify(telemetry)

    expect(serialized).toContain("frameBytes")
    expect(serialized).not.toContain(result.payload.data)
    expect(Object.keys(telemetry)).not.toContain("data")
  })

  it("rejects frames that remain over the byte cap after compression attempts", async () => {
    mockCanvasEncoding(128)

    const result = await encodeArtifactStillFrame(canvasSource(320, 160), {
      maxBytes: 16,
    })

    expect(result.ok).toBe(false)
    if (result.ok === true) return
    expect(result.reason).toBe("encoded_frame_exceeds_byte_cap")
    expect(result.rawFrameExcluded).toBe(true)
  })
})
