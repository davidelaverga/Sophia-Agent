export type ArtifactVisualSourceKind = "canvas_element" | "canvas_stream" | "offscreen_render" | "unsupported"

export type ArtifactVisualSourceStatus = "ready" | "unsupported"
export type ArtifactVisualSourceMode = "stream" | "still_frame"

export interface ArtifactVisualSource {
  kind: ArtifactVisualSourceKind
  status: ArtifactVisualSourceStatus
  artifactId: string | null
  element: HTMLCanvasElement | null
  stream: MediaStream | null
  reason: string | null
  frameRate: number | null
}

export interface ResolveArtifactVisualSourceOptions {
  root?: ParentNode | null
  artifactId?: string | null
  frameRate?: number
  mode?: ArtifactVisualSourceMode
  missingCanvasReason?: string
}

const ARTIFACT_CANVAS_SELECTORS = [
  "canvas[data-coreview-artifact-canvas='true']",
  "canvas[data-artifact-canvas='true']",
  "[data-artifact-region='true'] canvas",
  "[data-coreview-artifact-region='true'] canvas",
]

export function resolveArtifactVisualSource({
  root,
  artifactId = null,
  frameRate = 1,
  mode = "stream",
  missingCanvasReason = "artifact_canvas_not_found",
}: ResolveArtifactVisualSourceOptions = {}): ArtifactVisualSource {
  const searchRoot = root ?? (typeof document === "undefined" ? null : document)
  if (!searchRoot) {
    return unsupportedArtifactVisualSource("document_unavailable", artifactId)
  }

  const canvas = findArtifactCanvas(searchRoot, artifactId)
  if (!canvas) {
    return unsupportedArtifactVisualSource(missingCanvasReason, artifactId)
  }

  const sourceKind = readArtifactCanvasKind(canvas)

  if (mode === "still_frame") {
    return {
      kind: sourceKind,
      status: "ready",
      artifactId,
      element: canvas,
      stream: null,
      reason: null,
      frameRate: null,
    }
  }

  const captureStream = canvas.captureStream
  if (typeof captureStream !== "function") {
    return {
      ...unsupportedArtifactVisualSource("canvas_capture_stream_unavailable", artifactId),
      element: canvas,
    }
  }

  return {
    kind: "canvas_stream",
    status: "ready",
    artifactId,
    element: canvas,
    stream: captureStream.call(canvas, frameRate),
    reason: null,
    frameRate,
  }
}

function readArtifactCanvasKind(canvas: HTMLCanvasElement): ArtifactVisualSourceKind {
  if (canvas.dataset.coreviewOffscreenRender === "true") {
    return "offscreen_render"
  }
  return "canvas_element"
}

export function stopArtifactVisualSource(source: ArtifactVisualSource | null | undefined): void {
  source?.stream?.getTracks().forEach((track) => track.stop())
}

export function findArtifactCanvas(
  root: ParentNode,
  artifactId: string | null = null,
): HTMLCanvasElement | null {
  if (artifactId) {
    const escapedArtifactId = cssEscape(artifactId)
    const direct = root.querySelector<HTMLCanvasElement>(
      `canvas[data-artifact-id='${escapedArtifactId}'], canvas[data-coreview-artifact-id='${escapedArtifactId}']`,
    )
    if (direct) return direct
  }

  for (const selector of ARTIFACT_CANVAS_SELECTORS) {
    const canvas = root.querySelector<HTMLCanvasElement>(selector)
    if (canvas) return canvas
  }

  return null
}

function unsupportedArtifactVisualSource(reason: string, artifactId: string | null): ArtifactVisualSource {
  return {
    kind: "unsupported",
    status: "unsupported",
    artifactId,
    element: null,
    stream: null,
    reason,
    frameRate: null,
  }
}

function cssEscape(value: string): string {
  const css = globalThis.CSS as { escape?: (input: string) => string } | undefined
  if (typeof css?.escape === "function") {
    return css.escape(value)
  }
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}
