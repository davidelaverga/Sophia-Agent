import type { CoreviewPdfTextLayout } from "../../lib/coreview-pdf-text-layout"
import type { NormalizedArtifactRect } from "../../types/artifact-annotations"

/**
 * Shared contracts for the artifact canvas surfaces.
 *
 * These types are consumed by both `ArtifactCanvasViewport` and
 * `ArtifactPdfPreview` (and re-exported from each for compatibility).
 * Keeping them in a standalone module breaks the import cycle between
 * the viewport (which renders the PDF preview) and the PDF preview
 * (which reports capture status back to the viewport).
 */

export type ArtifactPdfTextExtractionStatusValue = "loading" | "success" | "failed" | "unavailable"

export interface ArtifactPdfTextExtractionStatus {
  status: ArtifactPdfTextExtractionStatusValue
  source: "pdf_text_extraction"
  pageCount: number
  charCount: number
  truncated: boolean
  safeReason: string | null
  text?: string
  layout?: CoreviewPdfTextLayout
}

export interface ArtifactPdfFocusRequest {
  id: string
  pageIndex: number
  rect: NormalizedArtifactRect
}

export type ArtifactVisualCaptureUnavailableReason =
  | "no_selected_artifact"
  | "preview_not_ready"
  | "capture_target_missing"
  | "capture_failed"
  | "exact_text_only_no_visual_source"

export interface ArtifactVisualCaptureStatus {
  ready: boolean
  reason: ArtifactVisualCaptureUnavailableReason | null
  source: "markdown_preview_canvas" | "html_preview_canvas" | "metadata_canvas" | "pdf_page_canvas" | "none"
  exactTextAvailable: boolean
  artifactPath?: string | null
  previewHref?: string | null
  pdfTextExtractionStatus?: ArtifactPdfTextExtractionStatus["status"] | null
  pdfTextExtractionSource?: ArtifactPdfTextExtractionStatus["source"] | null
  pdfTextExtractionPageCount?: number | null
  pdfTextExtractionCharCount?: number | null
  pdfTextExtractionTruncated?: boolean | null
  annotationOverlayCaptured?: boolean | null
}
