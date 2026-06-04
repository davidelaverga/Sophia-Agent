"use client"

import { RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"

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
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import type {
  ArtifactAnnotation,
  ArtifactToolMode,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../../types/artifact-annotations"
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
  voiceAgentSessionId?: string | null
  artifactStableIdentity?: string | null
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
  reviewViewPending?: boolean
  reviewStale?: boolean
  canRefreshReview?: boolean
  voiceCommandStatusText?: string | null
  voiceCommandStatusTone?: "neutral" | "pending" | "success" | "warn"
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
  setView: (view: { pageIndex: number; zoom: number; fitMode: ArtifactFitMode }) => void
}

export function ArtifactStage({
  builderArtifact,
  builderArtifactLibrary = [],
  threadId,
  artifactId,
  sessionId,
  normalSessionId,
  voiceAgentSessionId,
  artifactStableIdentity,
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
  reviewViewPending = false,
  reviewStale = false,
  canRefreshReview = false,
  voiceCommandStatusText = null,
  voiceCommandStatusTone = "neutral",
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
  const [toolMode, setToolMode] = useState<ArtifactToolMode>("select")
  const [annotations, setAnnotations] = useState<ArtifactAnnotation[]>([])
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const annotationTelemetrySignatureRef = useRef<string | null>(null)
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
      sessionIds: [sessionId, normalSessionId, voiceAgentSessionId],
      threadId,
      artifactStableIdentity,
    } : null
  ), [artifactId, artifactStableIdentity, normalSessionId, sessionId, threadId, voiceAgentSessionId])
  const rendererResetKey = `${primaryFile?.path ?? ""}|${rendererKind}`

  useEffect(() => {
    setPageIndex(0)
    setPageCount(1)
    setZoom(1)
    setFitMode(rendererKind === "pdf" ? "page" : "custom")
    setToolMode("select")
    setAnnotations([])
    setSelectedAnnotationId(null)
  }, [artifactId, rendererKind, rendererResetKey])

  useEffect(() => {
    if (rendererKind !== "pdf" && toolMode !== "select") {
      setToolMode("select")
    }
  }, [rendererKind, toolMode])

  useEffect(() => {
    if (!selectedAnnotationId) {
      return
    }

    const selected = annotations.find((annotation) => annotation.id === selectedAnnotationId)
    if (selected?.pageIndex !== pageIndex) {
      setSelectedAnnotationId(null)
    }
  }, [annotations, pageIndex, selectedAnnotationId])

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
  const handleToolModeChange = useCallback((mode: ArtifactToolMode) => {
    if (rendererKind !== "pdf") {
      return
    }
    setToolMode(mode)
    if (mode === "pan") {
      setSelectedAnnotationId(null)
    }
  }, [rendererKind])
  const handleCreateHighlight = useCallback((rect: NormalizedArtifactRect) => {
    if (rendererKind !== "pdf") {
      return
    }

    const id = nextArtifactAnnotationId("highlight")
    setAnnotations((current) => [
      ...current,
      {
        id,
        kind: "highlight",
        pageIndex,
        rect,
        createdAt: Date.now(),
      },
    ])
    setSelectedAnnotationId(id)
    setToolMode("select")
  }, [pageIndex, rendererKind])
  const handleCreateComment = useCallback((point: NormalizedArtifactPoint) => {
    if (rendererKind !== "pdf") {
      return
    }

    const id = nextArtifactAnnotationId("comment")
    setAnnotations((current) => [
      ...current,
      {
        id,
        kind: "comment",
        pageIndex,
        point,
        text: "",
        createdAt: Date.now(),
      },
    ])
    setSelectedAnnotationId(id)
    setToolMode("select")
  }, [pageIndex, rendererKind])
  const handleSelectAnnotation = useCallback((id: string | null) => {
    setSelectedAnnotationId(id)
    if (id) {
      setToolMode("select")
    }
  }, [])
  const handleUpdateCommentText = useCallback((id: string, text: string) => {
    setAnnotations((current) => current.map((annotation) => (
      annotation.id === id && annotation.kind === "comment"
        ? { ...annotation, text: text.slice(0, 180) }
        : annotation
    )))
  }, [])
  const annotationCounts = useMemo(() => {
    let highlightCount = 0
    let commentCount = 0
    for (const annotation of annotations) {
      if (annotation.kind === "highlight") {
        highlightCount += 1
      } else {
        commentCount += 1
      }
    }
    return {
      annotationCount: annotations.length,
      highlightCount,
      commentCount,
    }
  }, [annotations])
  const selectedAnnotationKind = useMemo(() => (
    annotations.find((annotation) => annotation.id === selectedAnnotationId)?.kind ?? null
  ), [annotations, selectedAnnotationId])
  const recordArtifactControlTelemetry = useCallback((
    name: "artifact-keyboard-shortcut" | "artifact-pinch-zoom",
    details: Record<string, string | number | boolean | null>,
  ) => {
    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name,
      payload: {
        artifactId: artifactId ?? null,
        artifactPath: primaryFile?.path ?? null,
        artifactRendererKind: rendererKind,
        artifactPageIndex: pageIndex,
        artifactPageCount: pageCount,
        artifactZoom: zoom,
        artifactFitMode: fitMode,
        artifactToolMode: toolMode,
        annotationOverlayCaptured: rendererKind === "pdf" ? false : null,
        reviewStale,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
        ...details,
      },
    })
  }, [artifactId, fitMode, pageCount, pageIndex, primaryFile?.path, rendererKind, reviewStale, toolMode, zoom])
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
        handleZoomIn()
        return applied(currentPageIndex, fitMode !== "custom" || nextZoom !== zoom)
      }
      case "zoom_out": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        const nextZoom = clampArtifactZoom(zoom / 1.2)
        handleZoomOut()
        return applied(currentPageIndex, fitMode !== "custom" || nextZoom !== zoom)
      }
      case "fit_width": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        handleFitWidth()
        return applied(currentPageIndex, fitMode !== "width" || zoom !== 1)
      }
      case "fit_page": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        handleFitPage()
        return applied(currentPageIndex, fitMode !== "page" || zoom !== 1)
      }
      case "reset_zoom": {
        if (!canApplyZoomCommand) {
          return blocked("no_multipage_artifact_selected")
        }
        handleResetZoom()
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
    handleFitPage,
    handleFitWidth,
    handleResetZoom,
    handleZoomIn,
    handleZoomOut,
    pageCount,
    pageIndex,
    supportsPagination,
    supportsZoom,
    zoom,
  ])
  const setCoreviewTargetView = useCallback((view: { pageIndex: number; zoom: number; fitMode: ArtifactFitMode }) => {
    const normalizedPageCount = Math.max(1, Math.floor(pageCount))
    if (supportsPagination) {
      setPageIndex(Math.min(Math.max(0, Math.floor(view.pageIndex)), normalizedPageCount - 1))
    }
    if (supportsZoom) {
      setFitMode(view.fitMode)
      setZoom(clampArtifactZoom(view.zoom))
    }
  }, [pageCount, supportsPagination, supportsZoom])
  const handlePinchZoomChange = useCallback((nextZoom: number) => {
    if (!supportsZoom) {
      return
    }

    const normalizedZoom = clampArtifactZoom(nextZoom)
    if (Math.abs(normalizedZoom - zoom) < 0.01 && fitMode === "custom") {
      return
    }

    setFitMode("custom")
    setZoom(normalizedZoom)
    recordArtifactControlTelemetry("artifact-pinch-zoom", {
      pinchZoomUsed: true,
      pinchZoom: normalizedZoom,
    })
  }, [fitMode, recordArtifactControlTelemetry, supportsZoom, zoom])
  const handleStageKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      if (toolMode !== "select" || selectedAnnotationId) {
        event.preventDefault()
        setToolMode("select")
        setSelectedAnnotationId(null)
      }
      return
    }

    if (isArtifactShortcutTypingTarget(event.target)) {
      return
    }

    const command = artifactCommandFromKeyboardEvent(event)
    if (!command) {
      return
    }

    if (command.kind === "refresh_view") {
      if (!onRefreshReview || !canRefreshReview) {
        return
      }

      event.preventDefault()
      onRefreshReview()
      recordArtifactControlTelemetry("artifact-keyboard-shortcut", {
        keyboardArtifactShortcutUsed: keyboardShortcutLabel(event),
        keyboardArtifactCommandKind: command.kind,
      })
      return
    }

    const applyResult = applyVoiceCommand(command)
    if (!applyResult.applied) {
      return
    }

    event.preventDefault()
    recordArtifactControlTelemetry("artifact-keyboard-shortcut", {
      keyboardArtifactShortcutUsed: keyboardShortcutLabel(event),
      keyboardArtifactCommandKind: command.kind,
    })
  }, [
    applyVoiceCommand,
    canRefreshReview,
    onRefreshReview,
    recordArtifactControlTelemetry,
    selectedAnnotationId,
    toolMode,
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
    setView: setCoreviewTargetView,
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
    setCoreviewTargetView,
    zoom,
  ])

  useEffect(() => {
    onVoiceCommandTargetChange?.(voiceCommandTarget)
    return () => onVoiceCommandTargetChange?.(null)
  }, [onVoiceCommandTargetChange, voiceCommandTarget])

  useEffect(() => {
    if (rendererKind !== "pdf") {
      return
    }

    const signature = [
      artifactId ?? "",
      primaryFile?.path ?? "",
      toolMode,
      pageIndex,
      annotationCounts.annotationCount,
      annotationCounts.highlightCount,
      annotationCounts.commentCount,
      selectedAnnotationKind ?? "",
    ].join("|")

    if (annotationTelemetrySignatureRef.current === signature) {
      return
    }
    annotationTelemetrySignatureRef.current = signature

    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "artifact-annotation-state",
      payload: {
        artifactId: artifactId ?? null,
        artifactPath: primaryFile?.path ?? null,
        artifactRendererKind: rendererKind,
        artifactToolMode: toolMode,
        annotationPageIndex: pageIndex,
        annotationOverlayCaptured: false,
        selectedAnnotationKind,
        ...annotationCounts,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    annotationCounts,
    artifactId,
    pageIndex,
    primaryFile?.path,
    rendererKind,
    selectedAnnotationKind,
    toolMode,
  ])

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
      data-testid="artifact-review-room"
      data-review-state={reviewSurfaceState}
      data-artifact-renderer-kind={rendererKind}
      data-artifact-view-signature={artifactViewSignature ?? undefined}
      tabIndex={0}
      onKeyDown={handleStageKeyDown}
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
        supportsAnnotations={rendererKind === "pdf"}
        toolMode={toolMode}
        onToolModeChange={handleToolModeChange}
        openHref={openHref}
        downloadHref={downloadHref}
        downloadName={primaryFile?.name}
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
        onPinchZoomChange={handlePinchZoomChange}
        toolMode={toolMode}
        annotations={annotations}
        selectedAnnotationId={selectedAnnotationId}
        onCreateHighlight={handleCreateHighlight}
        onCreateComment={handleCreateComment}
        onSelectAnnotation={handleSelectAnnotation}
        onUpdateCommentText={handleUpdateCommentText}
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
    </section>
  )
}

function nextArtifactAnnotationId(kind: ArtifactAnnotation["kind"]): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function artifactCommandFromKeyboardEvent(
  event: KeyboardEvent<HTMLElement>,
): ArtifactReviewVoiceCommand | null {
  const key = event.key.toLowerCase()
  switch (key) {
    case "arrowright":
    case "pagedown":
      return { kind: "next_page" }
    case "arrowleft":
    case "pageup":
      return { kind: "previous_page" }
    case "home":
      return { kind: "first_page" }
    case "end":
      return { kind: "last_page" }
    case "+":
    case "=":
      return { kind: "zoom_in" }
    case "-":
      return { kind: "zoom_out" }
    case "0":
      return { kind: "reset_zoom" }
    case "w":
      return { kind: "fit_width" }
    case "p":
      return { kind: "fit_page" }
    case "r":
      return { kind: "refresh_view" }
    default:
      return null
  }
}

function keyboardShortcutLabel(event: KeyboardEvent<HTMLElement>): string {
  return event.key.length === 1 ? event.key.toUpperCase() : event.key
}

function isArtifactShortcutTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  const editable = target.closest("input, textarea, select, [contenteditable='true']")
  return editable !== null
}
