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
  type ArtifactReviewAnnotationKind,
  type ArtifactReviewAnnotationUtteranceKind,
  type ArtifactReviewVoiceCommand,
  type ArtifactReviewVoiceCommandRefreshResult,
  type ArtifactReviewVoiceCommandRouteResult,
  type ArtifactReviewVoiceCommandRouter,
} from "../../lib/artifact-review-voice-commands"
export {
  getBuilderArtifactFiles,
  isHtmlArtifactFile,
  normalizeBuilderArtifactPath,
  resolveCanvasRenderFile,
} from "../../lib/builder-artifacts"
export { requestCoreviewHtmlQuickPatch } from "../../lib/coreview-html-quick-edit"
export * from "./PresenceArtifactPanelCoreviewDeps"
export { recordSophiaCaptureEvent } from "../../lib/session-capture"
export { cn } from "../../lib/utils"
export { isRealReflection } from "../../session/artifacts"
export { usePresenceStore } from "../../stores/presence-store"
export type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasShared"
