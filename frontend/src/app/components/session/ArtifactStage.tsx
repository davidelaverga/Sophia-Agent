"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"

import {
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
import type {
  CoReviewSessionState,
  CoReviewTransportStatus,
} from "../../lib/co-review-transport"
import type {
  CoreviewAddAnnotationAdapterInput,
  CoreviewAddAnnotationAdapterResult,
  CoreviewAnnotationAnchor,
  CoreviewFocusAnchorAdapterInput,
  CoreviewFocusAnchorAdapterResult,
  CoreviewResolveAnnotationAnchorResult,
} from "../../lib/coreview-actions"
import {
  COREVIEW_ANNOTATION_STORAGE_VERSION,
  type CoreviewAnnotationStoreTelemetry,
} from "../../lib/coreview-annotation-store"
import {
  resolveCoreviewPdfTextAnchor,
  type CoreviewPdfTextLayout,
} from "../../lib/coreview-pdf-text-layout"
import type {
  CoreviewArtifactCapabilities,
} from "../../lib/coreview-workspace-contract"
import type {
  ArtifactAnnotation,
  ArtifactToolMode,
  NormalizedArtifactLine,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../../types/artifact-annotations"
import type {
  BuilderArtifactLibraryItemV1,
  BuilderArtifactV1,
} from "../../types/builder-artifact"

import { ArtifactCanvasViewport, type ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import type { ArtifactPdfFocusRequest } from "./ArtifactPdfPreview"
import { ArtifactReviewStatus, hasConfirmedStillFrame } from "./ArtifactReviewStatus"
import {
  buildThreadArtifactHref,
  cn,
  coreviewArtifactCapabilityTelemetry,
  formatBuilderArtifactTypeLabel,
  getBuilderArtifactFiles,
  getCoreviewArtifactCapabilitiesForFile,
  recordSophiaCaptureEvent,
  RefreshCw,
} from "./ArtifactStageDeps"
import { ArtifactToolbar } from "./ArtifactToolbar"
import { ReviewWithSophiaButton } from "./ReviewWithSophiaButton"

type ToolModeResetReason = "escape_key" | "select_button" | "unsupported_renderer" | null
type ArtifactStageAnnotationPatch = { text?: string | null }

export interface ArtifactStageProps {
  builderArtifact: BuilderArtifactV1
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  threadId?: string | null
  artifactId?: string | null
  sessionId?: string | null
  normalSessionId?: string | null
  voiceAgentSessionId?: string | null
  artifactStableIdentity?: string | null
  artifactLogicalId?: string | null
  artifactVersionId?: string | null
  annotations?: ArtifactAnnotation[]
  annotationStoreTelemetry?: CoreviewAnnotationStoreTelemetry | null
  onAddAnnotation?: (input: CoreviewAddAnnotationAdapterInput) => CoreviewAddAnnotationAdapterResult
  onUpdateAnnotation?: (annotationId: string, patch: ArtifactStageAnnotationPatch) => boolean
  onDeleteAnnotation?: (annotationId: string) => boolean
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
  onWorkspaceToolModeChange?: (mode: ArtifactToolMode) => void
  onWorkspaceExportRequested?: (input: { exportKind: "original" | "annotated"; annotationCount: number }) => void
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
  capabilities: CoreviewArtifactCapabilities
  supportsPagination: boolean
  supportsZoom: boolean
  pageIndex: number
  pageCount: number
  zoom: number
  fitMode: ArtifactFitMode
  applyCommand: (command: ArtifactReviewVoiceCommand) => ArtifactReviewVoiceCommandApplyResult
  setView: (view: { pageIndex: number; zoom: number; fitMode: ArtifactFitMode }) => void
  resolveAnchor: (input: { anchor: CoreviewAnnotationAnchor; pageIndex: number }) => CoreviewResolveAnnotationAnchorResult
  addAnnotation: (input: CoreviewAddAnnotationAdapterInput) => CoreviewAddAnnotationAdapterResult
  focusAnchor: (input: CoreviewFocusAnchorAdapterInput) => CoreviewFocusAnchorAdapterResult
  annotationCounts: {
    annotationCount: number
    highlightCount: number
    commentCount: number
    underlineCount: number
    arrowCount: number
    drawPathCount: number
  }
  annotationOverlayCaptured: boolean | null
}

type VoiceCommandContext = {
  artifactId?: string | null
  currentPageIndex: number
  normalizedPageCount: number
  supportsPagination: boolean
  supportsZoom: boolean
  zoom: number
  fitMode: ArtifactFitMode
  setPageIndex: (index: number) => void
  handleZoomIn: () => void
  handleZoomOut: () => void
  handleFitWidth: () => void
  handleFitPage: () => void
  handleResetZoom: () => void
}

type ArtifactVoiceCommandHandler = (
  command: ArtifactReviewVoiceCommand,
  context: VoiceCommandContext,
) => ArtifactReviewVoiceCommandApplyResult

function blockedVoiceCommand(
  context: VoiceCommandContext,
  blockedReason: ArtifactReviewVoiceCommandApplyResult["blockedReason"],
): ArtifactReviewVoiceCommandApplyResult {
  return {
    applied: false,
    changed: false,
    shouldRefresh: false,
    blockedReason,
    artifactCurrentPageIndex: context.currentPageIndex,
    artifactCurrentPageCount: context.normalizedPageCount,
  }
}

function appliedVoiceCommand(
  context: VoiceCommandContext,
  nextPageIndex: number,
  changed: boolean,
  shouldRefresh = true,
): ArtifactReviewVoiceCommandApplyResult {
  return {
    applied: true,
    changed,
    shouldRefresh,
    blockedReason: null,
    artifactCurrentPageIndex: Math.min(Math.max(0, nextPageIndex), context.normalizedPageCount - 1),
    artifactCurrentPageCount: context.normalizedPageCount,
  }
}

function requirePageCommand(context: VoiceCommandContext): ArtifactReviewVoiceCommandApplyResult | null {
  return context.supportsPagination && context.normalizedPageCount > 1
    ? null
    : blockedVoiceCommand(context, "no_multipage_artifact_selected")
}

function requireZoomCommand(context: VoiceCommandContext): ArtifactReviewVoiceCommandApplyResult | null {
  return context.supportsZoom ? null : blockedVoiceCommand(context, "no_multipage_artifact_selected")
}

function applyArtifactVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  context: VoiceCommandContext,
): ArtifactReviewVoiceCommandApplyResult {
  if (!context.artifactId) {
    return blockedVoiceCommand(context, "no_artifact_selected")
  }
  const handler = ARTIFACT_VOICE_COMMAND_HANDLERS[command.kind]
  return handler
    ? handler(command, context)
    : blockedVoiceCommand(context, "not_artifact_review_context")
}

function applyZoomVoiceCommand(
  context: VoiceCommandContext,
  action: () => void,
  nextZoom: number,
  nextFitMode: ArtifactFitMode,
): ArtifactReviewVoiceCommandApplyResult {
  const blocked = requireZoomCommand(context)
  if (blocked) return blocked
  action()
  return appliedVoiceCommand(
    context,
    context.currentPageIndex,
    context.fitMode !== nextFitMode || nextZoom !== context.zoom,
  )
}

const ARTIFACT_VOICE_COMMAND_HANDLERS: Partial<Record<ArtifactReviewVoiceCommand["kind"], ArtifactVoiceCommandHandler>> = {
  go_to_page: (command, context) => {
    const blocked = requirePageCommand(context)
    if (blocked) return blocked
    const targetPage = command.pageTarget
    if (!targetPage || targetPage < 1 || targetPage > context.normalizedPageCount) {
      return blockedVoiceCommand(context, "requested_page_out_of_bounds")
    }
    const nextPageIndex = targetPage - 1
    context.setPageIndex(nextPageIndex)
    return appliedVoiceCommand(context, nextPageIndex, nextPageIndex !== context.currentPageIndex)
  },
  next_page: (_command, context) => {
    const blocked = requirePageCommand(context)
    if (blocked) return blocked
    if (context.currentPageIndex >= context.normalizedPageCount - 1) {
      return blockedVoiceCommand(context, "requested_page_out_of_bounds")
    }
    const nextPageIndex = context.currentPageIndex + 1
    context.setPageIndex(nextPageIndex)
    return appliedVoiceCommand(context, nextPageIndex, true)
  },
  previous_page: (_command, context) => {
    const blocked = requirePageCommand(context)
    if (blocked) return blocked
    if (context.currentPageIndex <= 0) {
      return blockedVoiceCommand(context, "requested_page_out_of_bounds")
    }
    const nextPageIndex = context.currentPageIndex - 1
    context.setPageIndex(nextPageIndex)
    return appliedVoiceCommand(context, nextPageIndex, true)
  },
  first_page: (_command, context) => {
    const blocked = requirePageCommand(context)
    if (blocked) return blocked
    context.setPageIndex(0)
    return appliedVoiceCommand(context, 0, context.currentPageIndex !== 0)
  },
  last_page: (_command, context) => {
    const blocked = requirePageCommand(context)
    if (blocked) return blocked
    const nextPageIndex = context.normalizedPageCount - 1
    context.setPageIndex(nextPageIndex)
    return appliedVoiceCommand(context, nextPageIndex, nextPageIndex !== context.currentPageIndex)
  },
  zoom_in: (_command, context) => applyZoomVoiceCommand(context, context.handleZoomIn, clampArtifactZoom(context.zoom * 1.2), "custom"),
  zoom_out: (_command, context) => applyZoomVoiceCommand(context, context.handleZoomOut, clampArtifactZoom(context.zoom / 1.2), "custom"),
  fit_width: (_command, context) => applyZoomVoiceCommand(context, context.handleFitWidth, 1, "width"),
  fit_page: (_command, context) => applyZoomVoiceCommand(context, context.handleFitPage, 1, "page"),
  reset_zoom: (_command, context) => applyZoomVoiceCommand(context, context.handleResetZoom, 1, "custom"),
  refresh_view: (_command, context) => {
    if (!context.supportsPagination && !context.supportsZoom) {
      return blockedVoiceCommand(context, "no_multipage_artifact_selected")
    }
    return appliedVoiceCommand(context, context.currentPageIndex, false)
  },
}

function resolveCoreviewHtmlTextAnchor(
  exactText: string,
  anchor: CoreviewAnnotationAnchor,
  pageIndex: number,
  selected: { rect?: NormalizedArtifactRect | null; point?: NormalizedArtifactPoint | null } | null,
): CoreviewResolveAnnotationAnchorResult {
  if (pageIndex !== 0) {
    return { ok: false, blockedReason: "requested_page_out_of_bounds" }
  }
  if (anchor.type === "rect") {
    return {
      ok: true,
      anchor: {
        anchorType: "rect",
        pageIndex: 0,
        rect: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
        point: null,
      },
    }
  }
  if (anchor.type === "point") {
    return {
      ok: true,
      anchor: {
        anchorType: "point",
        pageIndex: 0,
        rect: null,
        point: { x: anchor.x, y: anchor.y },
      },
    }
  }
  if (anchor.type === "current_selection") {
    if (selected?.rect) {
      return {
        ok: true,
        anchor: {
          anchorType: "current_selection",
          pageIndex: 0,
          rect: selected.rect,
          point: null,
        },
      }
    }
    if (selected?.point) {
      return {
        ok: true,
        anchor: {
          anchorType: "current_selection",
          pageIndex: 0,
          rect: null,
          point: selected.point,
        },
      }
    }
    return { ok: false, blockedReason: "anchor_not_found" }
  }
  if (anchor.type === "current_title") {
    return {
      ok: true,
      anchor: {
        anchorType: "current_title",
        pageIndex: 0,
        rect: { x: 0.08, y: 0.1, width: 0.74, height: 0.08 },
        point: { x: 0.84, y: 0.13 },
      },
    }
  }

  const text = exactText.replace(/\s+/gu, " ").trim()
  const needle = anchor.text.replace(/\s+/gu, " ").trim()
  if (!text || !needle) {
    return { ok: false, blockedReason: "layout_anchor_not_supported" }
  }
  const index = text.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) {
    return { ok: false, blockedReason: "text_anchor_not_found" }
  }
  const progress = index / Math.max(text.length, 1)
  const width = Math.min(0.76, Math.max(0.18, needle.length / 90))
  const x = Math.min(0.82 - width, 0.08 + (progress % 0.18))
  const y = Math.min(0.86, 0.16 + progress * 0.68)
  const rect = {
    x,
    y,
    width,
    height: 0.045,
  }
  return {
    ok: true,
    anchor: {
      anchorType: "text_quote",
      pageIndex: 0,
      rect,
      point: {
        x: Math.min(0.96, rect.x + rect.width + 0.025),
        y: Math.min(0.96, rect.y + rect.height / 2),
      },
      matchCount: countCaseInsensitiveMatches(text, needle),
      textLength: needle.length,
    },
  }
}

function countCaseInsensitiveMatches(text: string, needle: string): number {
  if (!needle) {
    return 0
  }
  let count = 0
  let offset = 0
  const haystack = text.toLowerCase()
  const normalizedNeedle = needle.toLowerCase()
  while (offset < haystack.length) {
    const index = haystack.indexOf(normalizedNeedle, offset)
    if (index < 0) {
      break
    }
    count += 1
    offset = index + normalizedNeedle.length
  }
  return count
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
  artifactLogicalId,
  artifactVersionId,
  annotations: coreviewAnnotations = [],
  annotationStoreTelemetry = null,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
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
  onWorkspaceToolModeChange,
  onWorkspaceExportRequested,
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
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState<ArtifactFitMode>(rendererKind === "pdf" ? "page" : "custom")
  const [toolMode, setToolMode] = useState<ArtifactToolMode>("select")
  const annotations = coreviewAnnotations
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [htmlPreviewText, setHtmlPreviewText] = useState("")
  const [toolModeTelemetry, setToolModeTelemetry] = useState<{
    stickyToolModeEnabled: true
    lastToolModeBeforeAction: ArtifactToolMode
    lastToolModeAfterAction: ArtifactToolMode
    toolModeResetReason: ToolModeResetReason
  }>(() => ({
    stickyToolModeEnabled: true,
    lastToolModeBeforeAction: "select",
    lastToolModeAfterAction: "select",
    toolModeResetReason: null,
  }))
  const [pdfTextLayout, setPdfTextLayout] = useState<CoreviewPdfTextLayout | null>(null)
  const [pdfFocusRequest, setPdfFocusRequest] = useState<ArtifactPdfFocusRequest | null>(null)
  const annotationsRef = useRef<ArtifactAnnotation[]>([])
  const toolModeRef = useRef<ArtifactToolMode>("select")
  const voiceCommandTargetRegistrationRef = useRef<{
    key: string
    target: ArtifactReviewVoiceCommandTarget
  } | null>(null)
  const annotationTelemetrySignatureRef = useRef<string | null>(null)
  const viewportPrimaryFile = useMemo(() => (
    primaryFile
      ? {
          path: primaryFile.path,
          name: primaryFile.name,
          label: "label" in primaryFile ? primaryFile.label : primaryFile.name,
          isPrimary: "isPrimary" in primaryFile ? primaryFile.isPrimary : true,
          ...("mimeType" in primaryFile && primaryFile.mimeType ? { mimeType: primaryFile.mimeType } : {}),
          ...("sizeBytes" in primaryFile && typeof primaryFile.sizeBytes === "number" ? { sizeBytes: primaryFile.sizeBytes } : {}),
        }
      : null
  ), [primaryFile])
  const artifactCapabilities = useMemo(() => (
    getCoreviewArtifactCapabilitiesForFile({
      file: viewportPrimaryFile,
      rendererKind,
      textExtractionStatus: visualCaptureStatus?.pdfTextExtractionStatus ?? null,
      exactTextAvailable: exactTextAvailable || visualCaptureStatus?.exactTextAvailable === true || Boolean(pdfTextLayout),
      layoutAnchorsAvailable: rendererKind === "pdf" && Boolean(pdfTextLayout),
      originalDownloadAvailable: Boolean(downloadHref),
      openInNewTabAvailable: Boolean(openHref),
    })
  ), [
    downloadHref,
    exactTextAvailable,
    openHref,
    pdfTextLayout,
    rendererKind,
    viewportPrimaryFile,
    visualCaptureStatus?.exactTextAvailable,
    visualCaptureStatus?.pdfTextExtractionStatus,
  ])
  const artifactCapabilityTelemetry = useMemo(() => (
    coreviewArtifactCapabilityTelemetry(rendererKind, artifactCapabilities)
  ), [artifactCapabilities, rendererKind])
  const supportsPagination = artifactCapabilities.supportsPages
  const supportsZoom = artifactCapabilities.supportsZoom
  const toolbarPageLabel = !supportsPagination && rendererKind === "html" ? "HTML preview" : undefined
  const artifactTextRegistration = useMemo(() => (
    artifactId ? {
      artifactId,
      sessionIds: [sessionId, normalSessionId, voiceAgentSessionId],
      threadId,
      artifactStableIdentity,
      artifactLogicalId,
      artifactVersionId,
    } : null
  ), [artifactId, artifactLogicalId, artifactStableIdentity, artifactVersionId, normalSessionId, sessionId, threadId, voiceAgentSessionId])
  const rendererResetKey = `${primaryFile?.path ?? ""}|${rendererKind}`
  const annotationStableArtifactIdentity = artifactStableIdentity ?? null
  const annotationStore = useMemo(() => (
    annotationStoreTelemetry ?? emptyCoreviewAnnotationStoreTelemetry()
  ), [annotationStoreTelemetry])
  const annotationStorageKeyHash = annotationStore.annotationStorageKeyHash

  const recordToolModeAction = useCallback((
    before: ArtifactToolMode,
    after: ArtifactToolMode,
    resetReason: ToolModeResetReason,
  ) => {
    setToolModeTelemetry({
      stickyToolModeEnabled: true,
      lastToolModeBeforeAction: before,
      lastToolModeAfterAction: after,
      toolModeResetReason: resetReason,
    })
  }, [])
  const setToolModeWithTelemetry = useCallback((nextMode: ArtifactToolMode, resetReason: ToolModeResetReason) => {
    const before = toolModeRef.current
    toolModeRef.current = nextMode
    setToolMode(nextMode)
    recordToolModeAction(before, nextMode, resetReason)
  }, [recordToolModeAction])
  useEffect(() => {
    setPageIndex(0)
    setPageCount(1)
    setZoom(1)
    setFitMode(supportsZoom ? "page" : "custom")
    setSelectedAnnotationId(null)
    setPdfTextLayout(null)
    setHtmlPreviewText("")
    setPdfFocusRequest(null)
  }, [
    annotationStableArtifactIdentity,
    rendererKind,
    rendererResetKey,
    supportsZoom,
  ])

  useEffect(() => {
    annotationsRef.current = annotations
  }, [annotations])

  useEffect(() => {
    toolModeRef.current = toolMode
  }, [toolMode])

  useEffect(() => {
    if (!artifactToolModeSupported(toolMode, artifactCapabilities)) {
      setToolModeWithTelemetry("select", "unsupported_renderer")
    }
  }, [artifactCapabilities, setToolModeWithTelemetry, toolMode])

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
    if (!artifactToolModeSupported(mode, artifactCapabilities)) {
      return
    }
    if (mode === toolModeRef.current) {
      return
    }
    setToolModeWithTelemetry(mode, mode === "select" ? "select_button" : null)
    onWorkspaceToolModeChange?.(mode)
    if (mode === "pan") {
      setSelectedAnnotationId(null)
    }
  }, [artifactCapabilities, onWorkspaceToolModeChange, setToolModeWithTelemetry])
  const commitAnnotation = useCallback((input: CoreviewAddAnnotationAdapterInput): CoreviewAddAnnotationAdapterResult => {
    if (!artifactCapabilities.supportsAnnotations || !onAddAnnotation) {
      return {
        ok: false,
        annotationId: null,
        blockedReason: artifactCapabilities.supportsAnnotations ? "annotation_target_unavailable" : "annotations_not_supported",
        ...countAnnotations(annotationsRef.current),
      }
    }

    const result = onAddAnnotation(input)
    if (result.ok && result.annotationId) {
      setSelectedAnnotationId(result.annotationId)
      recordToolModeAction(toolModeRef.current, toolModeRef.current, null)
    }
    return result
  }, [artifactCapabilities.supportsAnnotations, onAddAnnotation, recordToolModeAction])
  const handleCreateHighlight = useCallback((rect: NormalizedArtifactRect) => {
    if (!artifactCapabilities.supportsAnnotations) {
      return
    }

    commitAnnotation({
      kind: "highlight",
      pageIndex,
      anchor: {
        anchorType: "rect",
        pageIndex,
        rect,
        point: null,
      },
      rect,
      point: null,
      line: null,
      color: "yellow",
      text: null,
      source: "user",
    })
  }, [artifactCapabilities.supportsAnnotations, commitAnnotation, pageIndex])
  const handleCreateComment = useCallback((point: NormalizedArtifactPoint) => {
    if (!artifactCapabilities.supportsComments) {
      return
    }

    commitAnnotation({
      kind: "comment",
      pageIndex,
      anchor: {
        anchorType: "point",
        pageIndex,
        rect: null,
        point,
      },
      rect: null,
      point,
      line: null,
      color: "purple",
      text: "",
      source: "user",
    })
  }, [artifactCapabilities.supportsComments, commitAnnotation, pageIndex])
  const handleCreateUnderline = useCallback((rect: NormalizedArtifactRect) => {
    if (!artifactCapabilities.supportsUnderline) {
      return
    }

    commitAnnotation({
      kind: "underline",
      pageIndex,
      anchor: {
        anchorType: "rect",
        pageIndex,
        rect,
        point: null,
      },
      rect,
      point: null,
      line: null,
      color: "purple",
      text: null,
      source: "user",
    })
  }, [artifactCapabilities.supportsUnderline, commitAnnotation, pageIndex])
  const handleCreateArrow = useCallback((line: NormalizedArtifactLine) => {
    if (!artifactCapabilities.supportsArrow) {
      return
    }

    commitAnnotation({
      kind: "arrow",
      pageIndex,
      anchor: {
        anchorType: "point",
        pageIndex,
        rect: null,
        point: line.end,
      },
      rect: null,
      point: null,
      line,
      color: "purple",
      text: null,
      source: "user",
    })
  }, [artifactCapabilities.supportsArrow, commitAnnotation, pageIndex])
  const handleSelectAnnotation = useCallback((id: string | null) => {
    setSelectedAnnotationId(id)
  }, [])
  const handleUpdateCommentText = useCallback((id: string, text: string) => {
    onUpdateAnnotation?.(id, { text: text.slice(0, 180) })
  }, [onUpdateAnnotation])
  const handleDeleteSelectedAnnotation = useCallback(() => {
    const selectedId = selectedAnnotationId
    if (!selectedId) {
      return false
    }
    const deleted = onDeleteAnnotation?.(selectedId) ?? false
    if (!deleted) {
      setSelectedAnnotationId(null)
      return false
    }
    setSelectedAnnotationId(null)
    return true
  }, [onDeleteAnnotation, selectedAnnotationId])
  const annotationCounts = useMemo(() => {
    return countAnnotations(annotations)
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
        annotationOverlayCaptured: artifactCapabilities.supportsAnnotations ? annotationCounts.annotationCount > 0 : null,
        ...annotationCounts,
        ...artifactCapabilityTelemetry,
        reviewStale,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
        ...details,
      },
    })
  }, [annotationCounts, artifactCapabilities.supportsAnnotations, artifactCapabilityTelemetry, artifactId, fitMode, pageCount, pageIndex, primaryFile?.path, rendererKind, reviewStale, toolMode, zoom])
  const applyVoiceCommand = useCallback((command: ArtifactReviewVoiceCommand): ArtifactReviewVoiceCommandApplyResult => {
    const normalizedPageCount = Math.max(1, Math.floor(pageCount))
    const currentPageIndex = Math.min(Math.max(0, pageIndex), normalizedPageCount - 1)
    return applyArtifactVoiceCommand(command, {
      artifactId,
      currentPageIndex,
      normalizedPageCount,
      supportsPagination,
      supportsZoom,
      zoom,
      fitMode,
      setPageIndex,
      handleZoomIn,
      handleZoomOut,
      handleFitWidth,
      handleFitPage,
      handleResetZoom,
    })
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
  const resolveCoreviewAnchor = useCallback((input: {
    anchor: CoreviewAnnotationAnchor
    pageIndex: number
  }): CoreviewResolveAnnotationAnchorResult => {
    if (!artifactCapabilities.supportsLayoutAnchors) {
      return {
        ok: false,
        blockedReason: artifactCapabilities.requiresOCR ? "ocr_not_available" : "layout_anchor_not_supported",
      }
    }
    const selected = selectedAnnotationId
      ? annotationsRef.current.find((annotation) => annotation.id === selectedAnnotationId && annotation.pageIndex === input.pageIndex)
      : null
    if (rendererKind === "html") {
      return resolveCoreviewHtmlTextAnchor(
        htmlPreviewText,
        input.anchor,
        input.pageIndex,
        selected?.kind === "highlight" || selected?.kind === "underline"
          ? { rect: selected.rect }
          : selected?.kind === "comment"
            ? { point: selected.point }
            : null,
      )
    }
    return resolveCoreviewPdfTextAnchor(
      pdfTextLayout,
      input.anchor,
      input.pageIndex,
      selected?.kind === "highlight" || selected?.kind === "underline"
        ? { rect: selected.rect }
        : selected?.kind === "comment"
          ? { point: selected.point }
          : null,
    )
  }, [artifactCapabilities.requiresOCR, artifactCapabilities.supportsLayoutAnchors, htmlPreviewText, pdfTextLayout, rendererKind, selectedAnnotationId])
  const addCoreviewAnnotation = useCallback((input: CoreviewAddAnnotationAdapterInput): CoreviewAddAnnotationAdapterResult => {
    if (!artifactAnnotationKindSupported(input.kind, artifactCapabilities)) {
      return {
        ok: false,
        annotationId: null,
        blockedReason: "annotations_not_supported",
        ...countAnnotations(annotationsRef.current),
      }
    }
    if (input.kind === "highlight" && !input.rect) {
      return {
        ok: false,
        annotationId: null,
        blockedReason: "invalid_rect",
        ...countAnnotations(annotationsRef.current),
      }
    }
    if (input.kind === "underline" && !input.rect) {
      return {
        ok: false,
        annotationId: null,
        blockedReason: "invalid_rect",
        ...countAnnotations(annotationsRef.current),
      }
    }
    if (input.kind === "comment" && !input.point) {
      return {
        ok: false,
        annotationId: null,
        blockedReason: "anchor_not_found",
        ...countAnnotations(annotationsRef.current),
      }
    }
    if (input.kind === "arrow" && !input.line) {
      return {
        ok: false,
        annotationId: null,
        blockedReason: "anchor_not_found",
        ...countAnnotations(annotationsRef.current),
      }
    }

    return commitAnnotation(input)
  }, [artifactCapabilities, commitAnnotation])
  const focusCoreviewAnchor = useCallback((input: CoreviewFocusAnchorAdapterInput): CoreviewFocusAnchorAdapterResult => {
    if (!artifactCapabilities.supportsLayoutAnchors) {
      return {
        ok: false,
        blockedReason: artifactCapabilities.requiresOCR ? "ocr_not_available" : "layout_anchor_not_supported",
      }
    }
    if (!artifactCapabilities.supportsZoom) {
      return {
        ok: false,
        blockedReason: "zoom_not_supported",
      }
    }
    if (!input.anchor.rect) {
      return {
        ok: false,
        blockedReason: "anchor_not_found",
      }
    }
    const normalizedPageCount = Math.max(1, Math.floor(pageCount))
    const nextPageIndex = Math.min(Math.max(0, Math.floor(input.pageIndex)), normalizedPageCount - 1)
    setPageIndex(nextPageIndex)
    setFitMode(input.fitMode)
    setZoom(clampArtifactZoom(input.zoom))
    setPdfFocusRequest({
      id: `focus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      pageIndex: nextPageIndex,
      rect: input.anchor.rect,
    })
    return {
      ok: true,
      blockedReason: null,
    }
  }, [artifactCapabilities.requiresOCR, artifactCapabilities.supportsLayoutAnchors, artifactCapabilities.supportsZoom, pageCount])
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
    if (isArtifactShortcutTypingTarget(event.target)) {
      return
    }

    if (event.key === "Escape") {
      if (toolMode !== "select" || selectedAnnotationId) {
        event.preventDefault()
        setToolModeWithTelemetry("select", "escape_key")
        setSelectedAnnotationId(null)
      }
      return
    }

    if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationId) {
      if (handleDeleteSelectedAnnotation()) {
        event.preventDefault()
      }
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
    handleDeleteSelectedAnnotation,
    setToolModeWithTelemetry,
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
    capabilities: artifactCapabilities,
    supportsPagination,
    supportsZoom,
    pageIndex,
    pageCount,
    zoom,
    fitMode,
    applyCommand: applyVoiceCommand,
    setView: setCoreviewTargetView,
    resolveAnchor: resolveCoreviewAnchor,
    addAnnotation: addCoreviewAnnotation,
    focusAnchor: focusCoreviewAnchor,
    annotationCounts,
    annotationOverlayCaptured: artifactCapabilities.supportsAnnotations ? annotationCounts.annotationCount > 0 : null,
  }), [
    addCoreviewAnnotation,
    artifactCapabilities,
    applyVoiceCommand,
    artifactId,
    annotationCounts,
    fitMode,
    focusCoreviewAnchor,
    pageCount,
    pageIndex,
    primaryFile?.path,
    rendererKind,
    resolveCoreviewAnchor,
    supportsPagination,
    supportsZoom,
    setCoreviewTargetView,
    zoom,
  ])
  const voiceCommandTargetRegistrationKey = [
    artifactStableIdentity ?? "",
    artifactId ?? "",
    primaryFile?.path ?? "",
    rendererKind,
  ].join("|")
  voiceCommandTargetRegistrationRef.current = {
    key: voiceCommandTargetRegistrationKey,
    target: voiceCommandTarget,
  }

  useEffect(() => {
    onVoiceCommandTargetChange?.(voiceCommandTarget)
    return () => {
      const currentRegistration = voiceCommandTargetRegistrationRef.current
      if (
        currentRegistration?.key !== voiceCommandTargetRegistrationKey
        || currentRegistration.target !== voiceCommandTarget
      ) {
        return
      }

      voiceCommandTargetRegistrationRef.current = null
      onVoiceCommandTargetChange?.(null)
    }
  }, [onVoiceCommandTargetChange, voiceCommandTarget, voiceCommandTargetRegistrationKey])

  useEffect(() => {
    if (!artifactCapabilities.supportsAnnotations) {
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
      annotationCounts.underlineCount,
      annotationCounts.arrowCount,
      annotationCounts.drawPathCount,
      annotationStore.coreviewAnnotationStoreActive,
      annotationStore.coreviewAnnotationStateSource,
      annotationStore.annotationPersistenceStatus ?? "",
      annotationStore.annotationRestoreCount,
      annotationStore.annotationPersistedCount,
      annotationStore.annotationDeleteCount,
      annotationStore.annotationEditCount,
      annotationStore.annotationRestoreAttempted,
      annotationStore.annotationRestoreResult ?? "",
      annotationStore.annotationRestoreSource ?? "",
      annotationStore.annotationIdentityReadHash ?? "",
      annotationStore.annotationPersistAttempted,
      annotationStore.annotationPersistResult ?? "",
      annotationStore.annotationPersistCount,
      annotationStore.annotationIdentityWriteHash ?? "",
      annotationStore.annotationPreventedEmptyOverwriteCount,
      annotationStore.annotationMigratedIdentityCount,
      annotationStore.annotationStoreSurvivedCanvasClose,
      annotationStore.annotationStoreHydratedArtifactStage,
      annotationStore.annotationStateClearedReason ?? "",
      toolModeTelemetry.lastToolModeBeforeAction,
      toolModeTelemetry.lastToolModeAfterAction,
      toolModeTelemetry.toolModeResetReason ?? "",
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
        ...artifactCapabilityTelemetry,
        artifactToolMode: toolMode,
        panModeActive: toolMode === "pan",
        annotationPageIndex: pageIndex,
        annotationOverlayCaptured: annotationCounts.annotationCount > 0,
        selectedAnnotationKind,
        coreviewAnnotationStoreActive: annotationStore.coreviewAnnotationStoreActive,
        coreviewAnnotationStateSource: annotationStore.coreviewAnnotationStateSource,
        annotationPersistenceStatus: annotationStore.annotationPersistenceStatus,
        annotationRestoreAttempted: annotationStore.annotationRestoreAttempted,
        annotationRestoreResult: annotationStore.annotationRestoreResult,
        annotationRestoreCount: annotationStore.annotationRestoreCount,
        annotationRestoreSource: annotationStore.annotationRestoreSource,
        annotationPersistAttempted: annotationStore.annotationPersistAttempted,
        annotationPersistResult: annotationStore.annotationPersistResult,
        annotationPersistCount: annotationStore.annotationPersistCount,
        annotationPersistedCount: annotationStore.annotationPersistedCount,
        annotationStorageVersion: annotationStore.annotationStorageVersion,
        annotationStorageKeyHash,
        annotationIdentityWriteHash: annotationStore.annotationIdentityWriteHash,
        annotationIdentityReadHash: annotationStore.annotationIdentityReadHash,
        annotationRestoreOverwrittenCount: 0,
        annotationPreventedEmptyOverwriteCount: annotationStore.annotationPreventedEmptyOverwriteCount,
        annotationMigratedIdentityCount: annotationStore.annotationMigratedIdentityCount,
        annotationStoreSurvivedCanvasClose: annotationStore.annotationStoreSurvivedCanvasClose,
        annotationStoreHydratedArtifactStage: annotationStore.annotationStoreHydratedArtifactStage,
        annotationStateClearedReason: annotationStore.annotationStateClearedReason,
        canvasPointerBlockedAfterAnnotation: false,
        stickyToolModeEnabled: toolModeTelemetry.stickyToolModeEnabled,
        lastToolModeBeforeAction: toolModeTelemetry.lastToolModeBeforeAction,
        lastToolModeAfterAction: toolModeTelemetry.lastToolModeAfterAction,
        toolModeResetReason: toolModeTelemetry.toolModeResetReason,
        annotationExportAvailable: artifactCapabilities.supportsAnnotatedExport,
        annotationExportResult: "unavailable",
        annotationExportKind: "annotated",
        annotationExportPageScope: "unavailable",
        annotationDeleteCount: annotationStore.annotationDeleteCount,
        annotationEditCount: annotationStore.annotationEditCount,
        unsupportedAnnotationKind: null,
        ...annotationCounts,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    annotationStore,
    annotationCounts,
    annotationStorageKeyHash,
    artifactCapabilities.supportsAnnotatedExport,
    artifactCapabilities.supportsAnnotations,
    artifactCapabilityTelemetry,
    artifactId,
    pageIndex,
    primaryFile?.path,
    rendererKind,
    selectedAnnotationKind,
    toolMode,
    toolModeTelemetry,
  ])

  const handleDownloadOriginal = useCallback(() => {
    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "artifact-annotation-export",
      payload: {
        artifactId: artifactId ?? null,
        artifactPath: primaryFile?.path ?? null,
        artifactRendererKind: rendererKind,
        ...artifactCapabilityTelemetry,
        annotationExportAvailable: artifactCapabilities.supportsAnnotatedExport,
        annotationExportResult: "original_download_started",
        annotationExportKind: "original",
        annotationExportPageScope: "unavailable",
        annotationStorageVersion: COREVIEW_ANNOTATION_STORAGE_VERSION,
        annotationStorageKeyHash,
        ...annotationCounts,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
    onWorkspaceExportRequested?.({
      exportKind: "original",
      annotationCount: annotationCounts.annotationCount,
    })
  }, [annotationCounts, annotationStorageKeyHash, artifactCapabilities.supportsAnnotatedExport, artifactCapabilityTelemetry, artifactId, onWorkspaceExportRequested, primaryFile?.path, rendererKind])

  const handleExportAnnotated = useCallback(() => {
    onWorkspaceExportRequested?.({
      exportKind: "annotated",
      annotationCount: annotationCounts.annotationCount,
    })
  }, [annotationCounts.annotationCount, onWorkspaceExportRequested])

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
        pageLabel={toolbarPageLabel}
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
        supportsAnnotations={artifactCapabilities.supportsAnnotations}
        supportsPan={artifactCapabilities.supportsPan}
        supportsComments={artifactCapabilities.supportsComments}
        supportsUnderline={artifactCapabilities.supportsUnderline}
        supportsArrow={artifactCapabilities.supportsArrow}
        supportsOriginalDownload={artifactCapabilities.supportsOriginalDownload}
        supportsOpenInNewTab={artifactCapabilities.supportsOpenInNewTab}
        toolMode={toolMode}
        onToolModeChange={handleToolModeChange}
        openHref={openHref}
        downloadHref={downloadHref}
        downloadName={primaryFile?.name}
        annotationCount={annotationCounts.annotationCount}
        annotationExportAvailable={artifactCapabilities.supportsAnnotatedExport}
        onDownloadOriginal={handleDownloadOriginal}
        onExportAnnotated={handleExportAnnotated}
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
        onHtmlTextChange={setHtmlPreviewText}
        onPdfTextLayoutChange={setPdfTextLayout}
        reviewSurfaceState={reviewSurfaceState}
        rendererKind={rendererKind}
        capabilities={artifactCapabilities}
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
        onCreateUnderline={handleCreateUnderline}
        onCreateArrow={handleCreateArrow}
        onSelectAnnotation={handleSelectAnnotation}
        onUpdateCommentText={handleUpdateCommentText}
        focusRequest={pdfFocusRequest}
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

function countAnnotations(annotations: ArtifactAnnotation[]): {
  annotationCount: number
  highlightCount: number
  commentCount: number
  underlineCount: number
  arrowCount: number
  drawPathCount: number
} {
  let highlightCount = 0
  let commentCount = 0
  let underlineCount = 0
  let arrowCount = 0
  for (const annotation of annotations) {
    if (annotation.kind === "highlight") {
      highlightCount += 1
    } else if (annotation.kind === "comment") {
      commentCount += 1
    } else if (annotation.kind === "underline") {
      underlineCount += 1
    } else if (annotation.kind === "arrow") {
      arrowCount += 1
    }
  }
  return {
    annotationCount: annotations.length,
    highlightCount,
    commentCount,
    underlineCount,
    arrowCount,
    drawPathCount: 0,
  }
}

function artifactToolModeSupported(
  mode: ArtifactToolMode,
  capabilities: CoreviewArtifactCapabilities,
): boolean {
  if (mode === "select") {
    return true
  }
  if (mode === "pan") {
    return capabilities.supportsPan
  }
  if (mode === "comment") {
    return capabilities.supportsComments
  }
  if (mode === "underline") {
    return capabilities.supportsUnderline
  }
  if (mode === "arrow") {
    return capabilities.supportsArrow
  }
  return capabilities.supportsAnnotations
}

function artifactAnnotationKindSupported(
  kind: CoreviewAddAnnotationAdapterInput["kind"],
  capabilities: CoreviewArtifactCapabilities,
): boolean {
  if (!capabilities.supportsAnnotations) {
    return false
  }
  if (kind === "comment") {
    return capabilities.supportsComments
  }
  if (kind === "underline") {
    return capabilities.supportsUnderline
  }
  if (kind === "arrow") {
    return capabilities.supportsArrow
  }
  return true
}

function emptyCoreviewAnnotationStoreTelemetry(): CoreviewAnnotationStoreTelemetry {
  return {
    coreviewAnnotationStoreActive: false,
    coreviewAnnotationStateSource: "coreview",
    annotationPersistenceStatus: null,
    annotationRestoreAttempted: false,
    annotationRestoreResult: null,
    annotationRestoreCount: 0,
    annotationRestoreSource: null,
    annotationPersistAttempted: false,
    annotationPersistResult: null,
    annotationPersistCount: 0,
    annotationPersistedCount: 0,
    annotationStorageVersion: COREVIEW_ANNOTATION_STORAGE_VERSION,
    annotationStorageKeyHash: null,
    annotationIdentityWriteHash: null,
    annotationIdentityReadHash: null,
    annotationPreventedEmptyOverwriteCount: 0,
    annotationMigratedIdentityCount: 0,
    annotationStoreSurvivedCanvasClose: false,
    annotationStoreHydratedArtifactStage: false,
    annotationStateClearedReason: null,
    annotationDeleteCount: 0,
    annotationEditCount: 0,
  }
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
