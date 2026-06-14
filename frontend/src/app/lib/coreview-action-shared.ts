import type {
  ArtifactFitMode,
  ArtifactRendererKind,
} from "./artifact-renderers"
import type { CoreviewArtifactCapabilities } from "./coreview-workspace-contract"

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
