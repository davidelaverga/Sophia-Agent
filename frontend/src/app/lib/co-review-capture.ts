export type ArtifactVisualSourceKind = "canvas_element" | "offscreen_render" | "unsupported"

export type ArtifactVisualSourceStatus = "ready" | "unsupported"
export type ArtifactVisualSourceMode = "still_frame"

export interface ArtifactVisualSource {
  kind: ArtifactVisualSourceKind
  status: ArtifactVisualSourceStatus
  artifactId: string | null
  element: HTMLCanvasElement | null
  reason: string | null
}

export interface ResolveArtifactVisualSourceOptions {
  root?: ParentNode | null
  artifactId?: string | null
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
  mode = "still_frame",
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
  void mode

  return {
    kind: sourceKind,
    status: "ready",
    artifactId,
    element: canvas,
    reason: null,
  }
}

function readArtifactCanvasKind(canvas: HTMLCanvasElement): ArtifactVisualSourceKind {
  if (canvas.dataset.coreviewOffscreenRender === "true") {
    return "offscreen_render"
  }
  return "canvas_element"
}

export function stopArtifactVisualSource(source: ArtifactVisualSource | null | undefined): void {
  void source
}

export function findArtifactCanvas(
  root: ParentNode,
  artifactId: string | null = null,
): HTMLCanvasElement | null {
  if (artifactId) {
    const escapedArtifactId = cssEscape(artifactId)
    const preview = root.querySelector<HTMLCanvasElement>(
      [
        `canvas[data-artifact-id='${escapedArtifactId}'][data-artifact-canvas-source='selected-markdown-preview']`,
        `canvas[data-coreview-artifact-id='${escapedArtifactId}'][data-artifact-canvas-source='selected-markdown-preview']`,
      ].join(", "),
    )
    if (preview) return preview

    const composite = root.querySelector<HTMLCanvasElement>(
      [
        `canvas[data-artifact-id='${escapedArtifactId}'][data-artifact-canvas-source='selected-pdf-page-composite']`,
        `canvas[data-coreview-artifact-id='${escapedArtifactId}'][data-artifact-canvas-source='selected-pdf-page-composite']`,
      ].join(", "),
    )
    if (composite) return composite

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
    reason,
  }
}

function cssEscape(value: string): string {
  const css = globalThis.CSS as { escape?: (input: string) => string } | undefined
  if (typeof css?.escape === "function") {
    return css.escape(value)
  }
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}
