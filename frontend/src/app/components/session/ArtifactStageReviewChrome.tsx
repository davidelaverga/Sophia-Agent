import { RefreshCw } from "lucide-react"
import type { ReactNode } from "react"

import type { ArtifactFitMode } from "../../lib/artifact-renderers"
import type {
  CoReviewSessionState,
  CoReviewTransportStatus,
} from "../../lib/co-review-transport"
import type { CoreviewArtifactCapabilities } from "../../lib/coreview-workspace-contract"
import { cn } from "../../lib/utils"
import type { ArtifactToolMode } from "../../types/artifact-annotations"

import { ArtifactReviewStatus, hasConfirmedStillFrame } from "./ArtifactReviewStatus"
import { ArtifactToolbar } from "./ArtifactToolbar"
import { ReviewWithSophiaButton } from "./ReviewWithSophiaButton"

type AnnotationCounts = {
  annotationCount: number
  highlightCount: number
  commentCount: number
  underlineCount: number
  arrowCount: number
  drawPathCount: number
}

export type ArtifactReviewSurfaceState = "active" | "preparing" | "unavailable" | "idle"

export function getArtifactReviewSurfaceState({
  reviewState,
  transportStatus,
  visualReviewPreparing,
  visualCaptureReady,
}: {
  reviewState?: CoReviewSessionState | null
  transportStatus?: CoReviewTransportStatus | null
  visualReviewPreparing: boolean
  visualCaptureReady?: boolean | null
}): ArtifactReviewSurfaceState {
  if (hasConfirmedStillFrame(reviewState, transportStatus)) {
    return "active"
  }
  if (visualReviewPreparing || reviewState?.state === "co_review_starting" || reviewState?.refreshFrameInProgress) {
    return "preparing"
  }
  if (visualCaptureReady === false || reviewState?.state === "co_review_error") {
    return "unavailable"
  }
  return "idle"
}

export function ArtifactStageReviewChrome({
  title,
  pageIndex,
  pageCount,
  supportsPagination,
  supportsZoom,
  zoom,
  fitMode,
  onPreviousPage,
  onNextPage,
  onZoomIn,
  onZoomOut,
  onFitPage,
  onFitWidth,
  onResetZoom,
  artifactCapabilities,
  toolMode,
  onToolModeChange,
  openHref,
  downloadHref,
  downloadName,
  annotationCounts,
  onDownloadOriginal,
  onExportAnnotated,
  voiceCommandStatusText,
  voiceCommandStatusTone,
  showReviewStatus,
  reviewState,
  transportStatus,
  exactTextAvailable,
  reviewEnabled,
  canStartReview,
  visualSourceUnavailableReason,
  visualReviewRequiresVoice,
  visualReviewPreparing,
  reviewViewPending,
  reviewStale,
  reviewSurfaceState,
  onRefreshReview,
  canRefreshReview,
  pendingStartVoiceReview,
  onStartVoiceReview,
  onStartReview,
  onStopReview,
  children,
}: {
  title: string
  pageIndex: number
  pageCount: number
  supportsPagination: boolean
  supportsZoom: boolean
  zoom: number
  fitMode: ArtifactFitMode
  onPreviousPage: () => void
  onNextPage: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFitPage: () => void
  onFitWidth: () => void
  onResetZoom: () => void
  artifactCapabilities: CoreviewArtifactCapabilities
  toolMode: ArtifactToolMode
  onToolModeChange: (mode: ArtifactToolMode) => void
  openHref: string | null
  downloadHref: string | null
  downloadName?: string
  annotationCounts: AnnotationCounts
  onDownloadOriginal: () => void
  onExportAnnotated: () => void
  voiceCommandStatusText?: string | null
  voiceCommandStatusTone: "neutral" | "pending" | "success" | "warn"
  showReviewStatus: boolean
  reviewState?: CoReviewSessionState | null
  transportStatus?: CoReviewTransportStatus | null
  exactTextAvailable: boolean
  reviewEnabled: boolean
  canStartReview: boolean
  visualSourceUnavailableReason?: string | null
  visualReviewRequiresVoice: boolean
  visualReviewPreparing: boolean
  reviewViewPending: boolean
  reviewStale: boolean
  reviewSurfaceState: ArtifactReviewSurfaceState
  onRefreshReview?: () => void
  canRefreshReview: boolean
  pendingStartVoiceReview: boolean
  onStartVoiceReview?: () => void
  onStartReview: () => void
  onStopReview: () => void
  children: ReactNode
}) {
  const frameConfirmed = reviewSurfaceState === "active"

  return (
    <>
      <ArtifactToolbar
        title={title}
        pageIndex={pageIndex}
        pageCount={pageCount}
        supportsPagination={supportsPagination}
        supportsZoom={supportsZoom}
        zoom={zoom}
        fitMode={fitMode}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onFitPage={onFitPage}
        onFitWidth={onFitWidth}
        onResetZoom={onResetZoom}
        supportsAnnotations={artifactCapabilities.supportsAnnotations}
        supportsPan={artifactCapabilities.supportsPan}
        supportsComments={artifactCapabilities.supportsComments}
        supportsUnderline={artifactCapabilities.supportsUnderline}
        supportsArrow={artifactCapabilities.supportsArrow}
        supportsOriginalDownload={artifactCapabilities.supportsOriginalDownload}
        supportsOpenInNewTab={artifactCapabilities.supportsOpenInNewTab}
        toolMode={toolMode}
        onToolModeChange={onToolModeChange}
        openHref={openHref}
        downloadHref={downloadHref}
        downloadName={downloadName}
        annotationCount={annotationCounts.annotationCount}
        annotationExportAvailable={artifactCapabilities.supportsAnnotatedExport}
        onDownloadOriginal={onDownloadOriginal}
        onExportAnnotated={onExportAnnotated}
        className="relative z-10 shrink-0"
      />

      {voiceCommandStatusText ? (
        <div className="relative z-10 border-b border-[color:var(--cosmic-border-soft)] bg-[color:color-mix(in_srgb,var(--cosmic-panel)_96%,var(--bg))] px-4 py-2">
          <span
            role="status"
            aria-live="polite"
            data-testid="artifact-voice-command-status"
            className={cn(
              "inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
              voiceCommandStatusTone === "success"
                ? "border-[color:var(--cosmic-teal-border)] bg-[color:var(--cosmic-teal-bg)] text-[color:var(--cosmic-text-strong)]"
                : voiceCommandStatusTone === "warn"
                  ? "border-[color:color-mix(in_srgb,#fbbf24_36%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,#fbbf24_10%,transparent)] text-[color:var(--cosmic-text)]"
                  : voiceCommandStatusTone === "pending"
                    ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_34%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_9%,var(--cosmic-panel-soft))] text-[color:var(--cosmic-text)]"
                    : "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)]",
            )}
          >
            <span className="truncate">{voiceCommandStatusText}</span>
          </span>
        </div>
      ) : null}

      {children}

      {showReviewStatus ? (
        <div
          data-testid="artifact-review-chrome"
          className="relative z-10 flex shrink-0 flex-col gap-3 border-t border-[color:var(--cosmic-border-soft)] bg-[color:color-mix(in_srgb,var(--cosmic-panel)_96%,var(--bg))] px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <ArtifactReviewStatus
            state={reviewState}
            transportStatus={transportStatus}
            exactTextAvailable={exactTextAvailable}
            featureEnabled={reviewEnabled}
            canStart={canStartReview}
            visualSourceUnavailableReason={visualSourceUnavailableReason ?? null}
            visualReviewRequiresVoice={visualReviewRequiresVoice}
            visualReviewPreparing={visualReviewPreparing}
            reviewViewPending={reviewViewPending}
            reviewStale={reviewStale}
            className="min-w-0"
          />
          {reviewEnabled ? (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {frameConfirmed && reviewStale && onRefreshReview ? (
                <button
                  type="button"
                  aria-label="Refresh view"
                  onClick={onRefreshReview}
                  disabled={!canRefreshReview || reviewState?.refreshFrameInProgress}
                  className="cosmic-focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[color:color-mix(in_srgb,var(--sophia-purple)_34%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_10%,transparent)] px-4 text-sm font-medium text-[color:var(--sophia-purple)] transition hover:bg-[color:color-mix(in_srgb,var(--sophia-purple)_16%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-4 w-4", reviewState?.refreshFrameInProgress && "animate-spin")} aria-hidden="true" />
                  <span>{reviewState?.refreshFrameInProgress ? "Refreshing view" : "Refresh view"}</span>
                </button>
              ) : null}
              <ReviewWithSophiaButton
                state={reviewState}
                canStart={canStartReview}
                featureEnabled={reviewEnabled}
                startVoiceRequired={visualReviewRequiresVoice}
                pendingStartVoiceReview={pendingStartVoiceReview}
                onStartVoiceReview={onStartVoiceReview}
                onStart={onStartReview}
                onStop={onStopReview}
                className="w-full sm:w-auto"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
