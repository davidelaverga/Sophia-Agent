"use client"

import { RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import {
  artifactRendererSupportsPagination,
  artifactRendererSupportsZoom,
  buildArtifactViewSignature,
  clampArtifactZoom,
  detectArtifactRendererKind,
  type ArtifactFitMode,
  type ArtifactRendererKind,
  type ArtifactViewState,
} from "../../lib/artifact-renderers"
import type {
  ArtifactReviewVoiceCommand,
  ArtifactReviewVoiceCommandApplyResult,
} from "../../lib/artifact-review-voice-commands"
import {
  buildThreadArtifactHref,
  formatBuilderArtifactTypeLabel,
  getBuilderArtifactFiles,
} from "../../lib/builder-artifacts"
import type {
  CoReviewSessionState,
  CoReviewTransportStatus,
} from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"
import type {
  BuilderArtifactLibraryItemV1,
  BuilderArtifactV1,
} from "../../types/builder-artifact"

import { ArtifactCanvasViewport, type ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import { ArtifactReviewStatus, hasConfirmedStillFrame } from "./ArtifactReviewStatus"
import { ArtifactToolbar } from "./ArtifactToolbar"
import { ReviewWithSophiaButton } from "./ReviewWithSophiaButton"

export interface ArtifactStageProps {
  builderArtifact: BuilderArtifactV1
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  threadId?: string | null
  artifactId?: string | null
  sessionId?: string | null
  normalSessionId?: string | null
  reviewState?: CoReviewSessionState | null
  transportStatus?: CoReviewTransportStatus | null
  exactTextAvailable?: boolean
  canStartReview?: boolean
  reviewEnabled?: boolean
  visualReviewRequiresVoice?: boolean
  visualReviewPreparing?: boolean
  pendingStartVoiceReview?: boolean
  showReviewStatus?: boolean
  visualCaptureStatus?: ArtifactVisualCaptureStatus | null
  reviewStale?: boolean
  canRefreshReview?: boolean
  onVisualCaptureStatusChange?: (status: ArtifactVisualCaptureStatus) => void
  onArtifactViewStateChange?: (state: ArtifactViewState) => void
  onVoiceCommandTargetChange?: (target: ArtifactReviewVoiceCommandTarget | null) => void
  onStartVoiceReview?: () => void
  onStartReview: () => void
  onStopReview: () => void
  onRefreshReview?: () => void
  fillAvailable?: boolean
  className?: string
}

export interface ArtifactReviewVoiceCommandTarget {
  artifactId: string | null
  filePath: string | null
  rendererKind: ArtifactRendererKind
  supportsPagination: boolean
  supportsZoom: boolean
  pageIndex: number
  pageCount: number
  zoom: number
  fitMode: ArtifactFitMode
  applyCommand: (command: ArtifactReviewVoiceCommand) => ArtifactReviewVoiceCommandApplyResult
}

export function ArtifactStage({
  builderArtifact,
  builderArtifactLibrary = [],
  threadId,
  artifactId,
  sessionId,
  normalSessionId,
  reviewState,
  transportStatus,
  exactTextAvailable = false,
  canStartReview = true,
  reviewEnabled = true,
  visualReviewRequiresVoice = false,
  visualReviewPreparing = false,
  pendingStartVoiceReview = false,
  showReviewStatus: showReviewStatusOverride,
  visualCaptureStatus,
  reviewStale = false,
  canRefreshReview = false,
  onVisualCaptureStatusChange,
  onArtifactViewStateChange,
  onVoiceCommandTargetChange,
  onStartVoiceReview,
  onStartReview,
  onStopReview,
  onRefreshReview,
  fillAvailable = false,
  className,
}: ArtifactStageProps) {
  const files = useMemo(() => {
    const libraryByPath = new Map(builderArtifactLibrary.map((item) => [item.path, item]))
    return getBuilderArtifactFiles(builderArtifact).map((file) => {
      const libraryItem = libraryByPath.get(file.path)
      return {
        ...file,
        ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
        ...(typeof libraryItem?.sizeBytes === "number" ? { sizeBytes: libraryItem.sizeBytes } : {}),
      }
    })
  }, [builderArtifact, builderArtifactLibrary])
  const primaryFile = files.find((file) => file.isPrimary) ?? files[0] ?? builderArtifactLibrary[0]
  const openHref = buildThreadArtifactHref(threadId, primaryFile?.path)
  const downloadHref = buildThreadArtifactHref(threadId, primaryFile?.path, { download: true })
  const typeLabel = formatBuilderArtifactTypeLabel(builderArtifact.artifactType)
  const rendererKind = detectArtifactRendererKind(primaryFile, builderArtifact)
  const supportsPagination = artifactRendererSupportsPagination(rendererKind)
  const supportsZoom = artifactRendererSupportsZoom(rendererKind)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState<ArtifactFitMode>(rendererKind === "pdf" ? "page" : "custom")
  const viewportPrimaryFile = primaryFile
    ? {
        path: primaryFile.path,
        name: primaryFile.name,
        label: "label" in primaryFile ? primaryFile.label : primaryFile.name,
        isPrimary: "isPrimary" in primaryFile ? primaryFile.isPrimary : true,
        ...("mimeType" in primaryFile && primaryFile.mimeType ? { mimeType: primaryFile.mimeType } : {}),
        ...("sizeBytes" in primaryFile && typeof primaryFile.sizeBytes === "number" ? { sizeBytes: primaryFile.sizeBytes } : {}),
      }
    : null
  const artifactTextRegistration = useMemo(() => (
    artifactId ? {
      artifactId,
      sessionIds: [sessionId, normalSessionId],
      threadId,
    } : null
  ), [artifactId, normalSessionId, sessionId, threadId])
  const rendererResetKey = `${primaryFile?.path ?? ""}|${rendererKind}`

  useEffect(() => {
    setPageIndex(0)
    setPageCount(1)
    setZoom(1)
    setFitMode(rendererKind === "pdf" ? "page" : "custom")
  }, [rendererKind, rendererResetKey])

  const handlePageCountChange = useCallback((nextPageCount: number) => {
    const normalizedPageCount = Math.max(1, Math.floor(nextPageCount))
    setPageCount(normalizedPageCount)
    setPageIndex((current) => Math.min(current, normalizedPageCount - 1))
  }, [])
  const handlePreviousPage = useCallback(() => {
    setPageIndex((current) => Math.max(0, current - 1))
  }, [])
  const handleNextPage = useCallback(() => {
    setPageIndex((current) => Math.min(Math.max(1, pageCount) - 1, current + 1))
  }, [pageCount])
  const handlePageIndexChange = useCallback((nextPageIndex: number) => {
    setPageIndex(Math.min(Math.max(0, nextPageIndex), Math.max(1, pageCount) - 1))
  }, [pageCount])
  const handleZoomIn = useCallback(() => {
    setFitMode("custom")
    setZoom((current) => clampArtifactZoom(current * 1.2))
  }, [])
  const handleZoomOut = useCallback(() => {
    setFitMode("custom")
    setZoom((current) => clampArtifactZoom(current / 1.2))
  }, [])
  const handleFitPage = useCallback(() => {
    setFitMode("page")
    setZoom(1)
  }, [])
  const handleFitWidth = useCallback(() => {
    setFitMode("width")
    setZoom(1)
  }, [])
  const handleResetZoom = useCallback(() => {
    setFitMode("custom")
    setZoom(1)
  }, [])
  const applyVoiceCommand = useCallback((command: ArtifactReviewVoiceCommand): ArtifactReviewVoiceCommandApplyResult => {
    const normalizedPageCount = Math.max(1, Math.floor(pageCount))
    const currentPageIndex = Math.min(Math.max(0, pageIndex), normalizedPageCount - 1)
    const blocked = (
      blockedReason: ArtifactReviewVoiceCommandApplyResult["blockedReason"],
    ): ArtifactReviewVoiceCommandApplyResult => ({
      applied: false,
      changed: false,
      shouldRefresh: false,
      blockedReason,
      artifactCurrentPageIndex: currentPageIndex,
      artifactCurrentPageCount: normalizedPageCount,
    })
    const applied = (
      nextPageIndex: number,
      changed: boolean,
      shouldRefresh = true,
    ): ArtifactReviewVoiceCommandApplyResult => ({
      applied: true,
      changed,
      shouldRefresh,
      blockedReason: null,
      artifactCurrentPageIndex: Math.min(Math.max(0, nextPageIndex), normalizedPageCount - 1),
      artifactCurrentPageCount: normalizedPageCount,
    })
    const canApplyPageCommand = supportsPagination && normalizedPageCount > 1
    const canApplyZoomCommand = supportsZoom

    if (!artifactId) {
      return blocked("no_artifact_selected")
    }

    switch (command.kind) {
      case "go_to_page": {
        if (!canApplyPageCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        const targetPage = command.pageTarget
        if (!targetPage || targetPage < 1 || targetPage > normalizedPageCount) {
          return blocked("requested_page_out_of_bounds")
        }
        const nextPageIndex = targetPage - 1
        setPageIndex(nextPageIndex)
        return applied(nextPageIndex, nextPageIndex !== currentPageIndex)
      }
      case "next_page": {
        if (!canApplyPageCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        if (currentPageIndex >= normalizedPageCount - 1) {
          return blocked("requested_page_out_of_bounds")
        }
        const nextPageIndex = currentPageIndex + 1
        setPageIndex(nextPageIndex)
        return applied(nextPageIndex, true)
      }
      case "previous_page": {
        if (!canApplyPageCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        if (currentPageIndex <= 0) {
          return blocked("requested_page_out_of_bounds")
        }
        const nextPageIndex = currentPageIndex - 1
        setPageIndex(nextPageIndex)
        return applied(nextPageIndex, true)
      }
      case "first_page": {
        if (!canApplyPageCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        setPageIndex(0)
        return applied(0, currentPageIndex !== 0)
      }
      case "last_page": {
        if (!canApplyPageCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        const nextPageIndex = normalizedPageCount - 1
        setPageIndex(nextPageIndex)
        return applied(nextPageIndex, nextPageIndex !== currentPageIndex)
      }
      case "zoom_in": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        const nextZoom = clampArtifactZoom(zoom * 1.2)
        setFitMode("custom")
        setZoom(nextZoom)
        return applied(currentPageIndex, fitMode !== "custom" || nextZoom !== zoom)
      }
      case "zoom_out": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        const nextZoom = clampArtifactZoom(zoom / 1.2)
        setFitMode("custom")
        setZoom(nextZoom)
        return applied(currentPageIndex, fitMode !== "custom" || nextZoom !== zoom)
      }
      case "fit_width": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        setFitMode("width")
        setZoom(1)
        return applied(currentPageIndex, fitMode !== "width" || zoom !== 1)
      }
      case "fit_page": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        setFitMode("page")
        setZoom(1)
        return applied(currentPageIndex, fitMode !== "page" || zoom !== 1)
      }
      case "reset_zoom": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        setFitMode("custom")
        setZoom(1)
        return applied(currentPageIndex, fitMode !== "custom" || zoom !== 1)
      }
      case "refresh_view": {
        if (!supportsPagination && !supportsZoom) {
          return blocked("no_multipage_artifact_selected")
        }
        return applied(currentPageIndex, false)
      }
      default:
        return blocked("not_artifact_review_context")
    }
  }, [
    artifactId,
    fitMode,
    pageCount,
    pageIndex,
    supportsPagination,
    supportsZoom,
    zoom,
  ])
  const artifactViewState = useMemo<ArtifactViewState>(() => ({
    artifactId: artifactId ?? null,
    filePath: primaryFile?.path ?? null,
    rendererKind,
    pageIndex,
    pageCount,
    zoom,
    fitMode,
  }), [artifactId, fitMode, pageCount, pageIndex, primaryFile?.path, rendererKind, zoom])
  const artifactViewSignature = buildArtifactViewSignature(artifactViewState)

  useEffect(() => {
    onArtifactViewStateChange?.(artifactViewState)
  }, [artifactViewState, onArtifactViewStateChange])

  const voiceCommandTarget = useMemo<ArtifactReviewVoiceCommandTarget>(() => ({
    artifactId: artifactId ?? null,
    filePath: primaryFile?.path ?? null,
    rendererKind,
    supportsPagination,
    supportsZoom,
    pageIndex,
    pageCount,
    zoom,
    fitMode,
    applyCommand: applyVoiceCommand,
  }), [
    applyVoiceCommand,
    artifactId,
    fitMode,
    pageCount,
    pageIndex,
    primaryFile?.path,
    rendererKind,
    supportsPagination,
    supportsZoom,
    zoom,
  ])

  useEffect(() => {
    onVoiceCommandTargetChange?.(voiceCommandTarget)
    return () => onVoiceCommandTargetChange?.(null)
  }, [onVoiceCommandTargetChange, voiceCommandTarget])

  const showReviewStatus = showReviewStatusOverride ?? Boolean(reviewEnabled || exactTextAvailable || visualCaptureStatus)
  const frameConfirmed = hasConfirmedStillFrame(reviewState, transportStatus)
  const reviewSurfaceState = frameConfirmed
    ? "active"
    : visualReviewPreparing || reviewState?.state === "co_review_starting" || reviewState?.refreshFrameInProgress
      ? "preparing"
      : visualCaptureStatus?.ready === false || reviewState?.state === "co_review_error"
        ? "unavailable"
        : "idle"

  return (
    <section
      data-review-state={reviewSurfaceState}
      data-artifact-renderer-kind={rendererKind}
      data-artifact-view-signature={artifactViewSignature ?? undefined}
      className={cn(
        "relative isolate flex min-h-0 w-full flex-col overflow-hidden rounded-xl border bg-[color:color-mix(in_srgb,var(--cosmic-panel)_98%,var(--bg))] shadow-[var(--cosmic-shadow-md)] transition-[border-color,box-shadow,background-color] duration-500",
        reviewSurfaceState === "active"
          ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_58%,var(--cosmic-border-soft))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_18%,transparent),0_26px_88px_color-mix(in_srgb,var(--sophia-purple)_18%,transparent)]"
          : reviewSurfaceState === "preparing"
            ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_42%,var(--cosmic-border-soft))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_10%,transparent),0_24px_76px_color-mix(in_srgb,var(--sophia-purple)_12%,transparent)]"
            : "border-[color:var(--cosmic-border-soft)]",
        className,
      )}
      aria-label="Generated artifact"
    >
      <div
        data-testid="artifact-stage-review-aura"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-500",
          (reviewSurfaceState === "active" || reviewSurfaceState === "preparing") && "opacity-100",
        )}
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--sophia-purple) 7%, transparent), transparent 32%), radial-gradient(circle at 50% -18%, color-mix(in srgb, var(--sophia-purple) 15%, transparent), transparent 48%)",
        }}
      />
      <ArtifactToolbar
        title={builderArtifact.artifactTitle}
        pageIndex={pageIndex}
        pageCount={pageCount}
        supportsPagination={supportsPagination}
        supportsZoom={supportsZoom}
        zoom={zoom}
        fitMode={fitMode}
        onPreviousPage={handlePreviousPage}
        onNextPage={handleNextPage}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFitPage={handleFitPage}
        onFitWidth={handleFitWidth}
        onResetZoom={handleResetZoom}
        openHref={openHref}
        downloadHref={downloadHref}
        downloadName={primaryFile?.name}
        className="relative z-10 shrink-0"
      />

      <ArtifactCanvasViewport
        artifact={builderArtifact}
        files={files}
        typeLabel={typeLabel}
        previewFile={viewportPrimaryFile}
        previewHref={openHref}
        artifactTextRegistration={artifactTextRegistration}
        onVisualCaptureStatusChange={onVisualCaptureStatusChange}
        reviewSurfaceState={reviewSurfaceState}
        rendererKind={rendererKind}
        pageIndex={pageIndex}
        pageCount={pageCount}
        zoom={zoom}
        fitMode={fitMode}
        onPageIndexChange={handlePageIndexChange}
        onPageCountChange={handlePageCountChange}
        className={fillAvailable ? "min-h-0 flex-1" : undefined}
      />

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
            visualSourceUnavailableReason={visualCaptureStatus?.ready === false ? visualCaptureStatus.reason : null}
            visualReviewRequiresVoice={visualReviewRequiresVoice}
            visualReviewPreparing={visualReviewPreparing}
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
    </section>
  )
}
