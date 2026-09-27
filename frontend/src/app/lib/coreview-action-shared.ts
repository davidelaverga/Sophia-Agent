import type {
  ArtifactFitMode,
  ArtifactRendererKind,
} from "./artifact-renderers"
import type { CoreviewArtifactCapabilities } from "./coreview-workspace-contract"

// Gemini fixes its tools for the whole voice session, so every review-only
// tool scopes itself to an active review. Without this an ordinary greeting
// can read the review schemas as evidence that a file is open.
export const COREVIEW_REVIEW_ONLY_TOOL_SCOPE =
  "Only while the app has said artifact review is active; otherwise no artifact is open, so do not call or mention this tool. "

export type CoreviewArtifactRebindStatus = "not_attempted" | "success" | "failed" | "not_needed"

export interface CoreviewCurrentView {
  artifactId: string | null
  artifactPath: string | null
  artifactTitle: string | null
  artifactStableIdentity?: string | null
  rendererKind: ArtifactRendererKind
  capabilities: CoreviewArtifactCapabilities
  supportsPagination: boolean
  supportsZoom: boolean
  pageIndex: number
  pageCount: number
  zoom: number
  fitMode: ArtifactFitMode
  scrollTop?: number | null
  scrollHeight?: number | null
  documentHeight?: number | null
  viewportHeight?: number | null
  viewportWidth?: number | null
  scale?: number | null
  visibleTextSummary?: string | null
  visibleHeadings?: string[]
  currentSection?: string | null
  htmlBridgeReady?: boolean | null
  htmlSectionIndexReady?: boolean | null
  htmlSectionIndexEntryCount?: number | null
  htmlSectionIndexBuildResult?: string | null
  stillFrameAvailable?: boolean | null
  viewSignature: string | null
  stale: boolean
  refreshInProgress: boolean
  canRefresh: boolean
  reviewActive: boolean
  reviewHasFrame: boolean
  exactTextAvailable: boolean
  visualFrameFresh: boolean
  annotationOverlayCaptured: boolean | null
  annotationCount: number
  highlightCount: number
  commentCount: number
  underlineCount?: number
  arrowCount?: number
  drawPathCount?: number
  rebindStatus?: CoreviewArtifactRebindStatus
}
