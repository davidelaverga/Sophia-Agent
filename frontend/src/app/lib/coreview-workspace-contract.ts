import type {
  ArtifactFitMode,
  ArtifactRendererKind,
} from "./artifact-renderers"
import type { CoreviewLayoutAnchor, CoreviewLayoutIndexState } from "./coreview-layout-index"

export const COREVIEW_WORKSPACE_CONTRACT_VERSION = 1

export type CoreviewArtifactSource =
  | "builder"
  | "artifact_store"
  | "user_upload"
  | "session"
  | "system"
  | "unknown"

export type CoreviewRenderMode =
  | "native"
  | "canvas"
  | "markdown"
  | "html"
  | "metadata"
  | "download_only"
  | "unsupported"

export type CoreviewArtifactFallbackReason =
  | "pdf_text_unavailable"
  | "docx_native_renderer_unavailable"
  | "pptx_native_renderer_unavailable"
  | "image_ocr_unavailable"
  | "download_only"
  | "unsupported_renderer"

export interface CoreviewWorkspaceArtifact {
  stableArtifactIdentity: string | null
  artifactId: string | null
  artifactPath: string | null
  title: string | null
  rendererKind: ArtifactRendererKind
  mimeType?: string | null
  fileExtension?: string | null
  source: CoreviewArtifactSource
  threadId?: string | null
  builderTaskId?: string | null
}

export interface CoreviewArtifactCapabilities {
  canRender: boolean
  renderMode: CoreviewRenderMode
  supportsPages: boolean
  supportsPageRail: boolean
  supportsZoom: boolean
  supportsPan: boolean
  supportsTextExtraction: boolean
  supportsLayoutAnchors: boolean
  supportsAnnotations: boolean
  supportsComments: boolean
  supportsUnderline: boolean
  supportsArrow: boolean
  supportsFreeDraw: boolean
  supportsStillFrame: boolean
  supportsAnnotatedExport: boolean
  supportsOriginalDownload: boolean
  supportsOpenInNewTab: boolean
  supportsOCR: boolean
  requiresOCR: boolean
  supportsPptxNativeRender: boolean
  supportsArtifactUpdate: boolean
  supportsScopedEdit: boolean
  supportsVersioning: boolean
  supportsOverwrite: boolean
  supportsSourceRead: boolean
  supportsNativeEdit: boolean
  supportsRebuildFromSource: boolean
  requiresFullRebuild: boolean
  requiresConversion: boolean
  unsupportedUpdateReason?: string | null
  preferredUpdateMode?: "create_new" | "update_existing" | "revise_version" | "convert_format" | "repair_artifact" | null
  fallbackReason?: CoreviewArtifactFallbackReason | null
  userFacingTruth?: string | null
}

export interface CoreviewCurrentViewCapabilitySummary {
  rendererKind: ArtifactRendererKind
  renderMode: CoreviewRenderMode
  supportsPages: boolean
  supportsPageRail: boolean
  currentPage: number | null
  pageCount: number | null
  supportsTextExtraction: boolean
  supportsLayoutAnchors: boolean
  supportsAnnotations: boolean
  supportsZoom: boolean
  supportsPan: boolean
  supportsAnnotatedExport: boolean
  supportsOCR: boolean
  requiresOCR: boolean
  supportsPptxNativeRender: boolean
  supportsArtifactUpdate: boolean
  supportsScopedEdit: boolean
  supportsVersioning: boolean
  supportsOverwrite: boolean
  supportsSourceRead: boolean
  supportsNativeEdit: boolean
  supportsRebuildFromSource: boolean
  requiresFullRebuild: boolean
  requiresConversion: boolean
  unsupportedUpdateReason: string | null
  preferredUpdateMode: "create_new" | "update_existing" | "revise_version" | "convert_format" | "repair_artifact" | null
  fallbackReason: CoreviewArtifactFallbackReason | null
  userFacingTruth: string | null
}

export type CoreviewTextExtractionState =
  | { status: "unavailable"; safeReason?: string | null }
  | { status: "pending"; source?: string | null }
  | { status: "ready"; source: string; pageCount?: number | null; charCount?: number | null; truncated?: boolean | null }
  | { status: "failed"; safeReason?: string | null }

export interface CoreviewRendererViewInput {
  pageIndex?: number
  zoom?: number
  fitMode?: ArtifactFitMode
}

export interface CoreviewRendererAdapterContract<TAnnotation = unknown> {
  rendererKind: ArtifactRendererKind
  canRender(artifact: CoreviewWorkspaceArtifact): boolean
  getCapabilities(artifact: CoreviewWorkspaceArtifact): CoreviewArtifactCapabilities
  getCurrentView(): unknown
  setView(input: CoreviewRendererViewInput): Promise<void> | void
  focusAnchor(anchor: CoreviewLayoutAnchor): Promise<boolean> | boolean
  captureFrame(): Promise<unknown> | unknown
  getTextExtractionState(): CoreviewTextExtractionState
  getLayoutIndexState(): CoreviewLayoutIndexState
  getAnnotations(): TAnnotation[]
  exportAnnotatedCopy(): Promise<Blob | null> | Blob | null
}
