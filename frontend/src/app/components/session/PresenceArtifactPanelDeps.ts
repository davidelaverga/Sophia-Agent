"use client"

export { useArtifactCoReview } from "../../hooks/useArtifactCoReview"
export { haptic } from "../../hooks/useHaptics"
export {
  buildArtifactViewSignature,
  clampArtifactZoom,
  createDefaultArtifactViewState,
  detectArtifactRendererKind,
  safeArtifactViewTelemetry,
  type ArtifactViewState,
} from "../../lib/artifact-renderers"
export {
  parseArtifactReviewVoiceCommand,
  parseArtifactReviewVoiceCommands,
  type ArtifactReviewBuilderActionResult,
  type ArtifactReviewBuilderCancelRequest,
  type ArtifactReviewBuilderContext,
  type ArtifactReviewBuilderUpdateRequest,
  type ArtifactReviewAnnotationKind,
  type ArtifactReviewAnnotationUtteranceKind,
  type ArtifactReviewVoiceCommand,
  type ArtifactReviewVoiceCommandRefreshResult,
  type ArtifactReviewVoiceCommandRouteResult,
  type ArtifactReviewVoiceCommandRouter,
} from "../../lib/artifact-review-voice-commands"
export { buildThreadArtifactHref, getBuilderArtifactFiles, normalizeBuilderArtifactPath } from "../../lib/builder-artifacts"
export * from "./PresenceArtifactPanelCoreviewDeps"
export { recordSophiaCaptureEvent } from "../../lib/session-capture"
export { cn } from "../../lib/utils"
export { isRealReflection } from "../../session/artifacts"
export { usePresenceStore } from "../../stores/presence-store"
