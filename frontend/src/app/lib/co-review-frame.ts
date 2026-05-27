import type { ArtifactVisualSource } from "./co-review-capture"

export const DEFAULT_ARTIFACT_FRAME_MAX_LONG_EDGE = 1024
export const DEFAULT_ARTIFACT_FRAME_MAX_BYTES = 512 * 1024
export const DEFAULT_ARTIFACT_FRAME_MIME_TYPE = "image/jpeg"
export const DEFAULT_ARTIFACT_FRAME_QUALITY = 0.82

export interface ArtifactFrameDimensions {
  width: number
  height: number
}

export interface ArtifactEncodedFramePayload {
  artifactId: string | null
  visualSourceKind: ArtifactVisualSource["kind"]
  data: string
  mimeType: string
  byteLength: number
  dimensions: ArtifactFrameDimensions
  rawFrameExcluded: true
}

export interface ArtifactFrameEncodeSuccess {
  ok: true
  payload: ArtifactEncodedFramePayload
  encodeLatencyMs: number
}

export interface ArtifactFrameEncodeFailure {
  ok: false
  reason: string
  encodeLatencyMs: number
  rawFrameExcluded: true
}

export type ArtifactFrameEncodeResult = ArtifactFrameEncodeSuccess | ArtifactFrameEncodeFailure

export interface EncodeArtifactFrameOptions {
  maxLongestEdge?: number
  maxBytes?: number
  mimeType?: "image/jpeg" | "image/png"
  quality?: number
  clock?: () => number
  canvasFactory?: () => HTMLCanvasElement
}

export async function encodeArtifactStillFrame(
  source: ArtifactVisualSource,
  options: EncodeArtifactFrameOptions = {},
): Promise<ArtifactFrameEncodeResult> {
  const clock = options.clock ?? defaultClock
  const startedAt = clock()
  const frameCanvas = renderArtifactFrameCanvas(source, options)
  if (frameCanvas.ok === false) {
    return {
      ok: false,
      reason: frameCanvas.reason,
      encodeLatencyMs: elapsedMs(clock(), startedAt),
      rawFrameExcluded: true,
    }
  }

  const mimeType = options.mimeType ?? DEFAULT_ARTIFACT_FRAME_MIME_TYPE
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_FRAME_MAX_BYTES
  const qualities = mimeType === "image/jpeg"
    ? jpegQualityAttempts(options.quality ?? DEFAULT_ARTIFACT_FRAME_QUALITY)
    : [undefined]

  for (const quality of qualities) {
    const blob = await canvasToBlob(frameCanvas.canvas, mimeType, quality)
    if (!blob) {
      return {
        ok: false,
        reason: "canvas_encode_failed",
        encodeLatencyMs: elapsedMs(clock(), startedAt),
        rawFrameExcluded: true,
      }
    }
    if (blob.size > maxBytes) {
      continue
    }

    return {
      ok: true,
      payload: {
        artifactId: source.artifactId,
        visualSourceKind: source.kind,
        data: await blobToBase64(blob),
        mimeType: blob.type || mimeType,
        byteLength: blob.size,
        dimensions: frameCanvas.dimensions,
        rawFrameExcluded: true,
      },
      encodeLatencyMs: elapsedMs(clock(), startedAt),
    }
  }

  return {
    ok: false,
    reason: "encoded_frame_exceeds_byte_cap",
    encodeLatencyMs: elapsedMs(clock(), startedAt),
    rawFrameExcluded: true,
  }
}

export function renderArtifactFrameCanvas(
  source: ArtifactVisualSource,
  options: EncodeArtifactFrameOptions = {},
): { ok: true; canvas: HTMLCanvasElement; dimensions: ArtifactFrameDimensions } | { ok: false; reason: string } {
  if (source.status !== "ready" || !source.element) {
    return { ok: false, reason: source.reason ?? "artifact_canvas_unavailable" }
  }

  const sourceWidth = source.element.width || source.element.clientWidth
  const sourceHeight = source.element.height || source.element.clientHeight
  if (!sourceWidth || !sourceHeight) {
    return { ok: false, reason: "artifact_canvas_has_no_dimensions" }
  }

  const maxLongestEdge = options.maxLongestEdge ?? DEFAULT_ARTIFACT_FRAME_MAX_LONG_EDGE
  const scale = Math.min(1, maxLongestEdge / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  let canvas: HTMLCanvasElement
  try {
    canvas = (options.canvasFactory ?? defaultCanvasFactory)()
  } catch {
    return { ok: false, reason: "document_unavailable" }
  }
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext("2d")
  if (!context) {
    return { ok: false, reason: "canvas_2d_context_unavailable" }
  }

  try {
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, width, height)
    context.drawImage(source.element, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height)
  } catch {
    return { ok: false, reason: "artifact_canvas_render_failed" }
  }

  return {
    ok: true,
    canvas,
    dimensions: { width, height },
  }
}

export function safeArtifactFrameTelemetry(
  payload: ArtifactEncodedFramePayload,
): {
  frameBytes: number
  frameDimensions: ArtifactFrameDimensions
  frameMimeType: string
  visualSourceKind: ArtifactVisualSource["kind"]
  rawFrameExcluded: true
} {
  return {
    frameBytes: payload.byteLength,
    frameDimensions: payload.dimensions,
    frameMimeType: payload.mimeType,
    visualSourceKind: payload.visualSourceKind,
    rawFrameExcluded: true,
  }
}

function jpegQualityAttempts(initialQuality: number): number[] {
  const normalized = Math.min(0.92, Math.max(0.35, initialQuality))
  return [...new Set([
    normalized,
    Math.min(normalized, 0.72),
    Math.min(normalized, 0.58),
    0.42,
  ])]
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): Promise<Blob | null> {
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, mimeType, quality)
    })
  }

  try {
    const dataUrl = canvas.toDataURL(mimeType, quality)
    return Promise.resolve(dataUrlToBlob(dataUrl))
  } catch {
    return Promise.resolve(null)
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blobToArrayBuffer(blob))
  return bytesToBase64(bytes)
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer()
  }
  if (typeof FileReader === "undefined") {
    return Promise.reject(new Error("blob_array_buffer_unavailable"))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("blob_read_failed"))
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
        return
      }
      reject(new Error("blob_read_returned_non_array_buffer"))
    }
    reader.readAsArrayBuffer(blob)
  })
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.*)$/u.exec(dataUrl)
  if (!match) {
    return null
  }
  const bytes = base64ToBytes(match[2] ?? "")
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([buffer], { type: match[1] })
}

function bytesToBase64(bytes: Uint8Array): string {
  const bufferApi = (globalThis as unknown as {
    Buffer?: { from: (bytes: Uint8Array) => { toString: (encoding: string) => string } }
  }).Buffer
  if (bufferApi) {
    return bufferApi.from(bytes).toString("base64")
  }

  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const bufferApi = (globalThis as unknown as {
    Buffer?: { from: (value: string, encoding: string) => Uint8Array }
  }).Buffer
  if (bufferApi) {
    return bufferApi.from(value, "base64")
  }

  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function defaultCanvasFactory(): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new Error("document_unavailable")
  }
  return document.createElement("canvas")
}

function elapsedMs(now: number, then: number): number {
  return Math.max(0, Math.round(now - then))
}

function defaultClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now()
}
