import type { ArtifactReviewVoiceCommandRouter } from "../../lib/artifact-review-voice-commands"
import type { CoReviewMediaTransport } from "../../lib/co-review-transport"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { RitualArtifacts } from "../../types/session"

export interface PresenceArtifactPanelProps {
  artifacts: RitualArtifacts | null | undefined
  builderArtifact?: BuilderArtifactV1 | null
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  selectedBuilderArtifactPath?: string | null
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
  sessionId?: string | null
  normalSessionId?: string | null
  voiceAgentSessionId?: string | null
  userId?: string | null
  threadId?: string
  isVisible: boolean
  onDismiss: () => void
  isVoiceMode: boolean
  coReviewTransport?: CoReviewMediaTransport
  pendingBuilderArtifactReview?: boolean
  onStartVoiceBuilderArtifactReview?: () => void
  onPendingBuilderArtifactReviewConsumed?: () => void
  onArtifactReviewVoiceCommandRouteChange?: (handler: ArtifactReviewVoiceCommandRouter | null) => void
  onAnnotationActionSucceeded?: (counts: {
    annotationCount?: number | null
    highlightCount?: number | null
    commentCount?: number | null
    underlineCount?: number | null
    arrowCount?: number | null
    drawPathCount?: number | null
  }) => void
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
}
