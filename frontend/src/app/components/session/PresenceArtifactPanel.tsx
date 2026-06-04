"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useArtifactCoReview } from "../../hooks/useArtifactCoReview"
import { haptic } from "../../hooks/useHaptics"
import {
  buildArtifactViewSignature,
  createDefaultArtifactViewState,
  detectArtifactRendererKind,
  clampArtifactZoom,
  safeArtifactViewTelemetry,
  type ArtifactViewState,
} from "../../lib/artifact-renderers"
import {
  parseArtifactReviewVoiceCommand,
  type ArtifactReviewVoiceCommand,
  type ArtifactReviewVoiceCommandRefreshResult,
  type ArtifactReviewVoiceCommandRouteResult,
  type ArtifactReviewVoiceCommandRouter,
} from "../../lib/artifact-review-voice-commands"
import { getBuilderArtifactFiles, normalizeBuilderArtifactPath } from "../../lib/builder-artifacts"
import { coreviewFlagDiagnostics, isCoreviewStillFrameReviewEnabled } from "../../lib/co-review-flags"
import type { CoReviewMediaTransport } from "../../lib/co-review-transport"
import {
  COREVIEW_REFRESH_VIEW_TOOL_NAME,
  COREVIEW_SET_VIEW_TOOL_NAME,
  createCoreviewActionBus,
  registerCoreviewToolBridge,
  wasRecentCoreviewToolActionHandled,
  type CoreviewActionBus,
  type CoreviewActionResult,
  type CoreviewCurrentView,
  type CoreviewRendererAdapter,
  type CoreviewSetViewInput,
  type CoreviewToolBlockedReason,
  type CoreviewToolCallInput,
  type CoreviewToolName,
  type CoreviewToolRefreshResult,
  type CoreviewViewReadyResult,
} from "../../lib/coreview-actions"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import { isRealReflection } from "../../session/artifacts"
import { usePresenceStore } from "../../stores/presence-store"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { RitualArtifacts } from "../../types/session"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import { ArtifactStage, type ArtifactReviewVoiceCommandTarget } from "./ArtifactStage"
import { buildCoreviewRealArtifactId, CoreviewRealArtifactCanvas } from "./CoreviewRealArtifactCanvas"
import {
  COREVIEW_COMPANION_ARTIFACT_ID,
  PresenceArtifactSecondarySurfaces,
} from "./PresenceArtifactSecondarySurfaces"
import { VoiceArtifactStage } from "./VoiceArtifactStage"

interface PresenceArtifactPanelProps {
  artifacts: RitualArtifacts | null | undefined
  builderArtifact?: BuilderArtifactV1 | null
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  selectedBuilderArtifactPath?: string | null
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
  sessionId?: string | null
  normalSessionId?: string | null
  threadId?: string
  isVisible: boolean
  onDismiss: () => void
  isVoiceMode: boolean
  coReviewTransport?: CoReviewMediaTransport
  pendingBuilderArtifactReview?: boolean
  onStartVoiceBuilderArtifactReview?: () => void
  onPendingBuilderArtifactReviewConsumed?: () => void
  onArtifactReviewVoiceCommandRouteChange?: (handler: ArtifactReviewVoiceCommandRouter | null) => void
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
}

type ArtifactVoiceCommandStatus = {
  text: string
  tone: "neutral" | "pending" | "success" | "warn"
}

function getPathFilename(path: string | undefined): string {
  return path?.split('/').filter(Boolean).pop() || 'Builder deliverable'
}

function inferArtifactTypeFromMetadata(
  name: string | undefined,
  mimeTypeValue?: string,
): BuilderArtifactV1["artifactType"] {
  const mimeType = mimeTypeValue?.toLowerCase().split(';')[0]?.trim() ?? ''
  const extension = name?.split('.').pop()?.toLowerCase() ?? ''

  if (mimeType.includes('presentation') || extension === 'ppt' || extension === 'pptx') {
    return 'presentation'
  }
  if (mimeType.includes('html') || extension === 'html' || extension === 'htm') {
    return 'webpage'
  }
  if (
    mimeType.includes('json')
    || mimeType.includes('csv')
    || ['csv', 'json', 'xlsx', 'xls'].includes(extension)
  ) {
    return 'data_analysis'
  }
  if (mimeType.includes('image') || extension === 'svg') {
    return 'visual_report'
  }

  return 'document'
}

function inferArtifactType(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1["artifactType"] {
  return inferArtifactTypeFromMetadata(item.name, item.mimeType)
}

function buildLibraryArtifact(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1 {
  return {
    artifactPath: item.path,
    artifactTitle: item.name || getPathFilename(item.path),
    artifactType: inferArtifactType(item),
    decisionsMade: [],
    companionSummary: 'Ready to preview in the artifact canvas.',
    userNextAction: 'Review it with Sophia when you are ready.',
  }
}

function buildSelectedPathArtifact(path: string): BuilderArtifactV1 | null {
  const normalizedPath = normalizeBuilderArtifactPath(path)
  if (!normalizedPath) {
    return null
  }

  const name = getPathFilename(normalizedPath)
  return {
    artifactPath: normalizedPath,
    artifactTitle: name,
    artifactType: inferArtifactTypeFromMetadata(name),
    decisionsMade: [],
    supportingFiles: [],
    userNextAction: 'Open or download the artifact if the in-canvas preview is unavailable.',
  }
}

function unavailableCaptureStatus(reason: ArtifactVisualCaptureStatus["reason"]): ArtifactVisualCaptureStatus {
  return {
    ready: false,
    reason,
    source: "none",
    exactTextAvailable: false,
  }
}

function buildAppliedVoiceCommandStatus(
  command: ArtifactReviewVoiceCommand,
  pageIndex: number,
): string {
  switch (command.kind) {
    case "go_to_page":
    case "next_page":
    case "previous_page":
    case "first_page":
    case "last_page":
      return `Page ${pageIndex + 1} selected`
    case "zoom_in":
    case "zoom_out":
    case "fit_width":
    case "fit_page":
    case "reset_zoom":
      return "PDF view updated"
    case "refresh_view":
      return "Refresh requested"
    default:
      return "Artifact view updated"
  }
}

function isPageNavigationVoiceCommand(command: ArtifactReviewVoiceCommand): boolean {
  return (
    command.kind === "go_to_page"
    || command.kind === "next_page"
    || command.kind === "previous_page"
    || command.kind === "first_page"
    || command.kind === "last_page"
  )
}

function buildRefreshUnavailableVoiceCommandMessage(
  command: ArtifactReviewVoiceCommand,
  shouldStartVoiceReview: boolean,
  staleAfterViewChange = false,
): string {
  if (staleAfterViewChange && command.kind !== "refresh_view") {
    return isPageNavigationVoiceCommand(command)
      ? "Page changed. Sophia's view is stale."
      : "PDF view updated. Sophia's view is stale."
  }

  if (shouldStartVoiceReview) {
    return isPageNavigationVoiceCommand(command)
      ? "Page changed. Start Review with Sophia to share this view."
      : "PDF view updated. Start Review with Sophia to share this view."
  }

  if (command.kind === "refresh_view") {
    return "Visual refresh is not active."
  }

  return isPageNavigationVoiceCommand(command)
    ? "Page changed. Visual refresh is not active."
    : "PDF view updated. Visual refresh is not active."
}

function buildBlockedVoiceCommandMessage(
  command: ArtifactReviewVoiceCommand,
  pageCount: number,
): string {
  if (command.kind === "go_to_page" && command.pageTarget && command.pageTarget > Math.max(1, pageCount)) {
    return "That page is not available in this PDF."
  }

  if (command.kind === "go_to_page" && command.pageTarget) {
    return `I can only review the page you have open. Please switch to page ${command.pageTarget} or use the page controls.`
  }

  return "I can only review the page you have open. Please use the page controls."
}

function coreviewToolNameFromAction(action: CoreviewActionResult["action"]): CoreviewToolName {
  return action === "refresh_view"
    ? COREVIEW_REFRESH_VIEW_TOOL_NAME
    : COREVIEW_SET_VIEW_TOOL_NAME
}

function coreviewToolNameFromVoiceCommand(command: ArtifactReviewVoiceCommand): CoreviewToolName {
  return command.kind === "refresh_view"
    ? COREVIEW_REFRESH_VIEW_TOOL_NAME
    : COREVIEW_SET_VIEW_TOOL_NAME
}

function coreviewBlockedStatusText(reason: CoreviewToolBlockedReason | null): string {
  switch (reason) {
    case "no_selected_artifact":
      return "No artifact is selected."
    case "artifact_mismatch":
      return "That artifact is not selected."
    case "requested_page_out_of_bounds":
      return "That page is not available in this PDF."
    case "unsupported_pages":
    case "unsupported_renderer":
      return "This view cannot be controlled by Sophia."
    case "review_not_active":
      return "Visual review is not active."
    case "refresh_unavailable":
      return "Sophia's visual refresh is unavailable."
    case "view_ready_timeout":
      return "The artifact view did not become ready in time."
    case "tool_unavailable":
      return "Sophia cannot control this view right now."
    case "invalid_tool_args":
      return "Sophia asked for an invalid view change."
    default:
      return "Sophia could not update this view."
  }
}

function routeBlockedReasonFromCoreview(
  reason: CoreviewToolBlockedReason | null,
): ArtifactReviewVoiceCommandRouteResult["blockedReason"] {
  switch (reason) {
    case "no_selected_artifact":
      return "no_artifact_selected"
    case "requested_page_out_of_bounds":
      return "requested_page_out_of_bounds"
    case "unsupported_pages":
    case "unsupported_renderer":
      return "no_multipage_artifact_selected"
    default:
      return reason ? "visual_refresh_unavailable" : null
  }
}

function refreshResultFromCoreview(
  result: CoreviewToolRefreshResult,
): ArtifactReviewVoiceCommandRefreshResult {
  switch (result) {
    case "success":
      return "success"
    case "error":
      return "error"
    case "not_active":
      return "not_active"
    case "refresh_unavailable":
      return "unavailable"
    default:
      return "not_requested"
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function coreviewSetViewInputFromVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  current: CoreviewCurrentView,
): CoreviewSetViewInput {
  switch (command.kind) {
    case "go_to_page":
      return {
        artifactId: current.artifactId ?? undefined,
        pageNumber: command.pageTarget,
        reason: "voice command fallback",
      }
    case "next_page":
      return {
        artifactId: current.artifactId ?? undefined,
        pageIndex: current.pageIndex + 1,
        reason: "voice command fallback",
      }
    case "previous_page":
      return {
        artifactId: current.artifactId ?? undefined,
        pageIndex: current.pageIndex - 1,
        reason: "voice command fallback",
      }
    case "first_page":
      return {
        artifactId: current.artifactId ?? undefined,
        pageIndex: 0,
        reason: "voice command fallback",
      }
    case "last_page":
      return {
        artifactId: current.artifactId ?? undefined,
        pageIndex: Math.max(0, current.pageCount - 1),
        reason: "voice command fallback",
      }
    case "zoom_in":
      return {
        artifactId: current.artifactId ?? undefined,
        zoom: clampArtifactZoom(current.zoom * 1.2),
        fitMode: "custom",
        reason: "voice command fallback",
      }
    case "zoom_out":
      return {
        artifactId: current.artifactId ?? undefined,
        zoom: clampArtifactZoom(current.zoom / 1.2),
        fitMode: "custom",
        reason: "voice command fallback",
      }
    case "fit_width":
      return {
        artifactId: current.artifactId ?? undefined,
        zoom: 1,
        fitMode: "width",
        reason: "voice command fallback",
      }
    case "fit_page":
      return {
        artifactId: current.artifactId ?? undefined,
        zoom: 1,
        fitMode: "page",
        reason: "voice command fallback",
      }
    case "reset_zoom":
      return {
        artifactId: current.artifactId ?? undefined,
        zoom: 1,
        fitMode: "custom",
        reason: "voice command fallback",
      }
    default:
      return {
        artifactId: current.artifactId ?? undefined,
        reason: "voice command fallback",
      }
  }
}

function buildSelectedArtifactFromExisting(builderArtifact: BuilderArtifactV1, path: string): BuilderArtifactV1 | null {
  const files = getBuilderArtifactFiles(builderArtifact)
  const selectedFile = files.find((file) => file.path === path)

  if (!selectedFile) {
    return null
  }

  return {
    ...builderArtifact,
    artifactPath: selectedFile.path,
    artifactTitle: selectedFile.isPrimary ? builderArtifact.artifactTitle : selectedFile.label,
    supportingFiles: files
      .filter((file) => file.path !== selectedFile.path)
      .map((file) => file.path),
  }
}

function buildStageBuilderArtifact({
  builderArtifact,
  selectedBuilderArtifactPath,
  selectedLibraryItem,
  latestLibraryItem,
}: {
  builderArtifact?: BuilderArtifactV1 | null
  selectedBuilderArtifactPath?: string | null
  selectedLibraryItem?: BuilderArtifactLibraryItemV1 | null
  latestLibraryItem?: BuilderArtifactLibraryItemV1 | null
}): BuilderArtifactV1 | null {
  const normalizedSelectedPath = normalizeBuilderArtifactPath(selectedBuilderArtifactPath)

  if (normalizedSelectedPath) {
    const selectedExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, normalizedSelectedPath)
      : null

    if (selectedExistingArtifact) {
      return selectedExistingArtifact
    }

    if (selectedLibraryItem) {
      return buildLibraryArtifact(selectedLibraryItem)
    }

    return buildSelectedPathArtifact(normalizedSelectedPath)
  }

  if (latestLibraryItem) {
    const latestExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, latestLibraryItem.path)
      : null

    return latestExistingArtifact ?? buildLibraryArtifact(latestLibraryItem)
  }

  if (builderArtifact) {
    return builderArtifact
  }

  return null
}

function getStagePrimaryFileWithMime(
  stageBuilderArtifact: BuilderArtifactV1 | null,
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[],
) {
  const files = getBuilderArtifactFiles(stageBuilderArtifact)
  const file = files.find((candidate) => candidate.isPrimary) ?? files[0] ?? null

  if (!file) {
    return null
  }

  const libraryItem = builderArtifactLibrary.find((item) => item.path === file.path)
  return {
    ...file,
    ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
    ...(typeof libraryItem?.sizeBytes === 'number' ? { sizeBytes: libraryItem.sizeBytes } : {}),
  }
}
/**
 * Cosmic artifact panel — part of the presence field.
 *
 * No card. No border. No solid background. The artifacts emerge from
 * the nebula like constellations becoming visible — text materialises
 * at ultra-low opacity, gains presence through gentle bloom, and the
 * nebula shows through everything.
 *
 * Voice: floats above mic, translucent veil. Text: inline above composer.
 * Dismiss via tap on the whisper-thin close zone or swipe-down.
 */
export function PresenceArtifactPanel({
  artifacts,
  builderArtifact,
  builderArtifactLibrary = [],
  selectedBuilderArtifactPath,
  onSelectedBuilderArtifactPathChange,
  sessionId,
  normalSessionId,
  threadId,
  isVisible,
  onDismiss,
  isVoiceMode,
  coReviewTransport,
  pendingBuilderArtifactReview = false,
  onStartVoiceBuilderArtifactReview,
  onPendingBuilderArtifactReviewConsumed,
  onArtifactReviewVoiceCommandRouteChange,
  onReflectionTap,
  onMemoryApprove,
  onMemoryReject,
}: PresenceArtifactPanelProps) {
  const [phase, setPhase] = useState<"hidden" | "entering" | "visible" | "exiting">("hidden")
  const [revealStep, setRevealStep] = useState(0)
  const [reflectionTapped, setReflectionTapped] = useState(false)
  const autoCollapseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const staggerRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const selectedStageCaptureSignatureRef = useRef<string | null>(null)
  const [builderArtifactRoot, setBuilderArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [domArtifactRoot, setDomArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [builderVisualCaptureStatus, setBuilderVisualCaptureStatus] = useState<ArtifactVisualCaptureStatus>(
    () => unavailableCaptureStatus("no_selected_artifact"),
  )
  const [reportedBuilderArtifactViewState, setReportedBuilderArtifactViewState] = useState<ArtifactViewState | null>(null)
  const [builderVoiceCommandTarget, setBuilderVoiceCommandTarget] = useState<ArtifactReviewVoiceCommandTarget | null>(null)
  const builderVoiceCommandTargetRef = useRef<ArtifactReviewVoiceCommandTarget | null>(null)
  const [voiceCommandStaleViewSignature, setVoiceCommandStaleViewSignature] = useState<string | null>(null)
  const [voiceCommandStatus, setVoiceCommandStatus] = useState<ArtifactVoiceCommandStatus | null>(null)
  const coreviewCurrentViewRef = useRef<CoreviewCurrentView | null>(null)
  const coreviewVisualReadyRef = useRef(false)
  const status = usePresenceStore((s) => s.status)
  const hasBuilderLibrary = builderArtifactLibrary.length > 0
  const normalizedSelectedBuilderArtifactPath = useMemo(
    () => normalizeBuilderArtifactPath(selectedBuilderArtifactPath),
    [selectedBuilderArtifactPath],
  )
  const selectedBuilderLibraryItem = useMemo(
    () => builderArtifactLibrary.find((file) => file.path === normalizedSelectedBuilderArtifactPath) ?? null,
    [builderArtifactLibrary, normalizedSelectedBuilderArtifactPath],
  )
  const stageBuilderArtifact = useMemo(
    () => buildStageBuilderArtifact({
      builderArtifact,
      selectedBuilderArtifactPath: normalizedSelectedBuilderArtifactPath,
      selectedLibraryItem: selectedBuilderLibraryItem,
      latestLibraryItem: builderArtifactLibrary[0] ?? null,
    }),
    [builderArtifact, builderArtifactLibrary, normalizedSelectedBuilderArtifactPath, selectedBuilderLibraryItem],
  )
  const takeaway = artifacts?.takeaway
  const reflection_candidate = artifacts?.reflection_candidate
  const memory_candidates = artifacts?.memory_candidates
  const hasBuilder = !!stageBuilderArtifact
  const builderStageActive = hasBuilder && Boolean(stageBuilderArtifact)
  const hasReflection = isRealReflection(reflection_candidate?.prompt)
  const hasMemories = memory_candidates && memory_candidates.length > 0
  const hasTakeaway = !!takeaway?.trim()
  const coreviewReviewEnabled = isCoreviewStillFrameReviewEnabled()
  const coreviewDiagnostics = useMemo(() => coreviewFlagDiagnostics(), [])
  const builderArtifactId = stageBuilderArtifact
    ? buildCoreviewRealArtifactId(stageBuilderArtifact)
    : null
  const builderReviewEnabled = Boolean(coreviewReviewEnabled && builderArtifactId)
  const stagePrimaryFile = useMemo(() => {
    return getStagePrimaryFileWithMime(stageBuilderArtifact, builderArtifactLibrary)
  }, [builderArtifactLibrary, stageBuilderArtifact])
  const stageRendererKind = detectArtifactRendererKind(stagePrimaryFile, stageBuilderArtifact)
  const stageUsesMarkdownPreview = stageRendererKind === "markdown"
  const stageUsesPdfPreview = stageRendererKind === "pdf"
  const fallbackBuilderArtifactViewState = useMemo(() => (
    createDefaultArtifactViewState({
      artifactId: builderArtifactId,
      filePath: stagePrimaryFile?.path ?? stageBuilderArtifact?.artifactPath ?? null,
      rendererKind: stageRendererKind,
    })
  ), [builderArtifactId, stageBuilderArtifact?.artifactPath, stagePrimaryFile?.path, stageRendererKind])
  const builderArtifactViewState = (
    reportedBuilderArtifactViewState?.artifactId === builderArtifactId
    && reportedBuilderArtifactViewState?.filePath === (stagePrimaryFile?.path ?? stageBuilderArtifact?.artifactPath ?? null)
  )
    ? reportedBuilderArtifactViewState
    : fallbackBuilderArtifactViewState
  const builderArtifactViewSignature = buildArtifactViewSignature(builderArtifactViewState)
  const effectiveBuilderVisualCaptureStatus = useMemo<ArtifactVisualCaptureStatus>(() => {
    if (!builderArtifactId) {
      return unavailableCaptureStatus("no_selected_artifact")
    }

    if (!stageUsesMarkdownPreview && !stageUsesPdfPreview) {
      return {
        ready: true,
        reason: null,
        source: "metadata_canvas",
        exactTextAvailable: true,
      }
    }

    return builderVisualCaptureStatus
  }, [builderArtifactId, builderVisualCaptureStatus, stageUsesMarkdownPreview, stageUsesPdfPreview])
  const builderVisualSourceReady = Boolean(
    builderArtifactId
    && effectiveBuilderVisualCaptureStatus.ready,
  )
  const builderVisualUnavailableReason = builderArtifactId
    ? effectiveBuilderVisualCaptureStatus.reason
    : "no_selected_artifact"
  const builderExactTextAvailable = Boolean(
    builderArtifactId && effectiveBuilderVisualCaptureStatus.exactTextAvailable,
  )
  const handleBuilderVoiceCommandTargetChange = useCallback((target: ArtifactReviewVoiceCommandTarget | null) => {
    builderVoiceCommandTargetRef.current = target
    setBuilderVoiceCommandTarget(target)
  }, [])

  useEffect(() => {
    setReportedBuilderArtifactViewState(null)
  }, [builderArtifactId, stagePrimaryFile?.path, stageRendererKind])

  const showDomArtifactCoReview = Boolean(
    coreviewReviewEnabled
    && !builderArtifactId
    && (hasTakeaway || hasReflection || hasMemories),
  )
  const builderArtifactCoReview = useArtifactCoReview({
    sessionId: sessionId ?? null,
    normalSessionId: normalSessionId ?? null,
    threadId: threadId ?? null,
    artifactId: builderArtifactId,
    artifactRoot: builderArtifactRoot,
    featureEnabled: builderReviewEnabled,
    exactTextAvailable: builderExactTextAvailable,
    transport: coReviewTransport,
    missingCanvasReason: builderVisualUnavailableReason ?? "capture_target_missing",
    visualSourceReady: builderVisualSourceReady,
    visualSourceUnavailableReason: builderVisualUnavailableReason,
    artifactViewState: builderArtifactViewState,
  })
  const voiceCommandReviewStale = Boolean(
    voiceCommandStaleViewSignature
      && builderArtifactViewSignature === voiceCommandStaleViewSignature
      && builderArtifactCoReview.state.state === "co_review_live"
      && (builderArtifactCoReview.state.frameSentCount ?? 0) > 0,
  )
  const voiceCommandViewPending = Boolean(
    voiceCommandStaleViewSignature
      && builderArtifactViewSignature === voiceCommandStaleViewSignature
      && !builderVisualSourceReady,
  )
  const builderReviewStale = Boolean(builderArtifactCoReview.reviewStale || voiceCommandReviewStale)
  const builderReviewStaleReason = builderArtifactCoReview.reviewStaleReason
    ?? (voiceCommandReviewStale ? "view_changed" : null)
  const builderReviewHasFrame = Boolean(
    builderArtifactCoReview.state.state === "co_review_live"
      && (builderArtifactCoReview.state.frameSentCount ?? 0) > 0,
  )
  const coreviewCurrentView = useMemo<CoreviewCurrentView>(() => ({
    artifactId: builderArtifactId,
    artifactPath: stagePrimaryFile?.path ?? stageBuilderArtifact?.artifactPath ?? null,
    artifactTitle: stageBuilderArtifact?.artifactTitle ?? null,
    rendererKind: builderArtifactViewState.rendererKind,
    supportsPagination: builderVoiceCommandTarget?.supportsPagination ?? stageRendererKind === "pdf",
    supportsZoom: builderVoiceCommandTarget?.supportsZoom ?? stageRendererKind === "pdf",
    pageIndex: builderVoiceCommandTarget?.pageIndex ?? builderArtifactViewState.pageIndex,
    pageCount: Math.max(1, builderVoiceCommandTarget?.pageCount ?? builderArtifactViewState.pageCount),
    zoom: builderVoiceCommandTarget?.zoom ?? builderArtifactViewState.zoom,
    fitMode: builderVoiceCommandTarget?.fitMode ?? builderArtifactViewState.fitMode,
    viewSignature: builderArtifactViewSignature,
    stale: builderReviewStale,
    refreshInProgress: builderArtifactCoReview.state.refreshFrameInProgress,
    canRefresh: builderArtifactCoReview.canRefresh,
    reviewActive: builderArtifactCoReview.state.state === "co_review_live",
    reviewHasFrame: builderReviewHasFrame,
    exactTextAvailable: builderExactTextAvailable,
    visualFrameFresh: builderReviewHasFrame && !builderReviewStale,
    annotationOverlayCaptured: stageRendererKind === "pdf" ? false : null,
  }), [
    builderArtifactCoReview.canRefresh,
    builderArtifactCoReview.state.refreshFrameInProgress,
    builderArtifactCoReview.state.state,
    builderArtifactId,
    builderArtifactViewSignature,
    builderArtifactViewState.fitMode,
    builderArtifactViewState.pageCount,
    builderArtifactViewState.pageIndex,
    builderArtifactViewState.rendererKind,
    builderArtifactViewState.zoom,
    builderExactTextAvailable,
    builderReviewHasFrame,
    builderReviewStale,
    builderVoiceCommandTarget,
    stageBuilderArtifact?.artifactPath,
    stageBuilderArtifact?.artifactTitle,
    stagePrimaryFile?.path,
    stageRendererKind,
  ])
  useEffect(() => {
    coreviewCurrentViewRef.current = coreviewCurrentView
  }, [coreviewCurrentView])
  useEffect(() => {
    coreviewVisualReadyRef.current = builderVisualSourceReady
  }, [builderVisualSourceReady])
  const domArtifactCoReview = useArtifactCoReview({
    sessionId: sessionId ?? null,
    normalSessionId: normalSessionId ?? null,
    threadId: threadId ?? null,
    artifactId: showDomArtifactCoReview ? COREVIEW_COMPANION_ARTIFACT_ID : null,
    artifactRoot: domArtifactRoot,
    featureEnabled: showDomArtifactCoReview,
    exactTextAvailable: showDomArtifactCoReview,
    transport: coReviewTransport,
    missingCanvasReason: "artifact_canvas_not_found",
  })
  const builderReviewCanStart = builderArtifactCoReview.canStart
  const builderReviewStateName = builderArtifactCoReview.state.state
  const startBuilderArtifactReview = builderArtifactCoReview.startReview
  const transportNeedsVoice = Boolean(
    builderArtifactId
    && builderVisualSourceReady
    && builderArtifactCoReview.transportStatus.stillFramesSupported
    && !builderArtifactCoReview.transportStatus.visualTransportSupported
    && builderArtifactCoReview.state.state !== "co_review_error"
    && builderArtifactCoReview.state.frameSendFailureCount === 0
  )
  const visualReviewRequiresVoice = Boolean(
    transportNeedsVoice
    && !isVoiceMode
  )
  const visualReviewPreparing = Boolean(
    transportNeedsVoice
    && isVoiceMode
  )

  const recordReviewVoiceCommandTelemetry = useCallback((details: {
    command: ArtifactReviewVoiceCommand
    applied: boolean
    blockedReason: ArtifactReviewVoiceCommandRouteResult["blockedReason"]
    triggeredRefresh: boolean
    refreshResult: ArtifactReviewVoiceCommandRefreshResult
    artifactCurrentPageIndex: number
    artifactCurrentPageCount: number
    staleAfterPageChange?: boolean
    waitedForViewReady?: boolean
    autoRefreshTiming?: string | null
    autoRefreshBlockedReason?: string | null
    transportStateBefore?: string | null
    transportStateAfter?: string | null
  }) => {
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "artifact-review-voice-command",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        artifactId: builderArtifactId,
        coreviewArtifactId: builderArtifactId,
        reviewVoiceCommandDetected: true,
        reviewVoiceCommandKind: details.command.kind,
        reviewVoiceCommandPageTarget: details.command.pageTarget ?? null,
        reviewVoiceCommandApplied: details.applied,
        reviewVoiceCommandBlockedReason: details.blockedReason ?? null,
        reviewVoiceCommandTriggeredRefresh: details.triggeredRefresh,
        reviewVoiceCommandRefreshResult: details.refreshResult,
        reviewVoiceCommandTransportStateBefore: details.transportStateBefore ?? builderArtifactCoReview.transportStatus.statusText,
        reviewVoiceCommandTransportStateAfter: details.transportStateAfter ?? builderArtifactCoReview.transportStatus.statusText,
        reviewVoiceCommandDidHardIntercept: false,
        reviewVoiceCommandWaitedForViewReady: details.waitedForViewReady ?? false,
        reviewVoiceCommandAutoRefreshTiming: details.autoRefreshTiming ?? null,
        reviewVoiceCommandAutoRefreshBlockedReason: details.autoRefreshBlockedReason ?? null,
        reviewCommandPreservedMic: true,
        reviewCommandPreservedReview: true,
        reviewCommandAutoRefreshAttempted: details.triggeredRefresh,
        reviewCommandAutoRefreshResult: details.refreshResult,
        reviewCommandStaleAfterPageChange: details.staleAfterPageChange ?? false,
        reviewCommandStaleAfterViewChange: details.staleAfterPageChange ?? false,
        lastReviewVoiceCommandKind: details.command.kind,
        lastReviewVoiceCommandApplied: details.applied,
        lastReviewVoiceCommandUiMode: isVoiceMode ? "voice" : "text",
        artifactCurrentPageIndex: details.artifactCurrentPageIndex,
        artifactCurrentPageCount: details.artifactCurrentPageCount,
        artifactRendererKind: builderArtifactViewState.rendererKind,
        artifactFitMode: builderArtifactViewState.fitMode,
        artifactViewSignature: builderArtifactViewSignature,
        rawTranscriptExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    builderArtifactCoReview.transportStatus.statusText,
    builderArtifactId,
    builderArtifactViewSignature,
    builderArtifactViewState.fitMode,
    builderArtifactViewState.rendererKind,
    isVoiceMode,
    normalSessionId,
    sessionId,
    threadId,
  ])

  const recordCoreviewToolTelemetry = useCallback((result: CoreviewActionResult) => {
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "coreview-tool-call",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        coreviewToolCallCount: 1,
        coreviewToolName: coreviewToolNameFromAction(result.action),
        coreviewToolResult: result.ok ? "success" : "blocked",
        coreviewToolBlockedReason: result.blocked_reason,
        coreviewToolCommandSource: result.command_source,
        coreviewToolPreservedMic: result.preserved_mic,
        coreviewToolPreservedReview: result.preserved_review,
        coreviewToolRefreshAttempted: result.refresh_attempted,
        coreviewToolRefreshResult: result.refresh_result,
        coreviewToolViewReadyWaitMs: result.view_ready_wait_ms,
        coreviewToolViewSignatureBefore: result.view_signature_before,
        coreviewToolViewSignatureAfter: result.view_signature_after,
        coreviewSetViewPageIndex: result.action === "set_view" ? result.page_index : null,
        coreviewSetViewPageCount: result.action === "set_view" ? result.page_count : null,
        artifactId: result.artifact_id,
        artifactPath: result.artifact_path,
        artifactRendererKind: result.renderer_kind,
        artifactCurrentPageIndex: result.page_index,
        artifactCurrentPageCount: result.page_count,
        rawTranscriptExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [normalSessionId, sessionId, threadId])

  const applyCoreviewActionStatus = useCallback((result: CoreviewActionResult) => {
    if (!result.ok) {
      setVoiceCommandStatus({
        text: coreviewBlockedStatusText(result.blocked_reason),
        tone: "warn",
      })
      return
    }

    if (result.action === "refresh_view") {
      setVoiceCommandStatus({
        text: result.refresh_result === "success" ? "Sophia's view refreshed" : "Refresh requested",
        tone: result.refresh_result === "success" ? "success" : "neutral",
      })
      return
    }

    if (result.action === "set_view") {
      setVoiceCommandStatus({
        text: result.refresh_attempted && result.refresh_result === "success"
          ? "Sophia's view refreshed"
          : result.page_number
            ? `Page ${result.page_number} selected`
            : "Artifact view updated",
        tone: result.refresh_attempted && result.refresh_result === "success" ? "success" : "neutral",
      })
      return
    }

    setVoiceCommandStatus({
      text: result.page_number && result.page_count
        ? `Page ${result.page_number} of ${result.page_count}`
        : "Current view ready",
      tone: "neutral",
    })
  }, [])

  const waitForCoreviewViewReady = useCallback(async (viewSignature: string | null): Promise<CoreviewViewReadyResult> => {
    const startedAt = Date.now()
    const timeoutMs = 2500
    const pollMs = 25

    while (Date.now() - startedAt <= timeoutMs) {
      const current = coreviewCurrentViewRef.current
      const signatureReady = !viewSignature || current?.viewSignature === viewSignature
      if (signatureReady && coreviewVisualReadyRef.current) {
        return {
          ok: true,
          waitMs: Date.now() - startedAt,
          blockedReason: null,
        }
      }
      await delay(pollMs)
    }

    return {
      ok: false,
      waitMs: Date.now() - startedAt,
      blockedReason: "view_ready_timeout",
    }
  }, [])

  const coreviewAdapter = useMemo<CoreviewRendererAdapter>(() => ({
    getCurrentViewState: () => coreviewCurrentViewRef.current ?? coreviewCurrentView,
    setView: (view) => {
      const current = coreviewCurrentViewRef.current ?? coreviewCurrentView
      const expectedViewSignature = buildArtifactViewSignature({
        artifactId: current.artifactId,
        filePath: current.artifactPath,
        rendererKind: current.rendererKind,
        pageIndex: view.pageIndex,
        pageCount: current.pageCount,
        zoom: view.zoom,
        fitMode: view.fitMode,
      })
      if (expectedViewSignature !== current.viewSignature) {
        setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
      }
      builderVoiceCommandTargetRef.current?.setView(view)
    },
    refreshView: async () => {
      if (!builderArtifactCoReview.canRefresh) {
        return {
          ok: false,
          refreshResult: builderArtifactCoReview.state.state === "co_review_live" ? "refresh_unavailable" : "not_active",
          blockedReason: builderArtifactCoReview.state.state === "co_review_live" ? "refresh_unavailable" : "review_not_active",
        }
      }
      const nextState = await builderArtifactCoReview.refreshReview()
      const ok = nextState.refreshFrameResult === "success" && (nextState.frameSentCount ?? 0) > 0
      return {
        ok,
        refreshResult: ok ? "success" : "error",
        blockedReason: ok
          ? null
          : "refresh_unavailable",
      }
    },
    waitForViewReady: waitForCoreviewViewReady,
    markViewStale: (viewSignature) => {
      if (viewSignature) {
        setVoiceCommandStaleViewSignature(viewSignature)
      }
    },
    clearViewStale: (viewSignature) => {
      setVoiceCommandStaleViewSignature((current) => (
        current && (!viewSignature || current === viewSignature) ? null : current
      ))
    },
  }), [builderArtifactCoReview, coreviewCurrentView, waitForCoreviewViewReady])

  const coreviewActionBus = useMemo<CoreviewActionBus>(() => (
    createCoreviewActionBus(coreviewAdapter)
  ), [coreviewAdapter])

  const runCoreviewAction = useCallback(async (
    runner: (bus: CoreviewActionBus) => Promise<CoreviewActionResult> | CoreviewActionResult,
    options?: { applyStatus?: boolean },
  ): Promise<CoreviewActionResult> => {
    const result = await runner(coreviewActionBus)
    if (options?.applyStatus !== false) {
      applyCoreviewActionStatus(result)
    }
    recordCoreviewToolTelemetry(result)
    return result
  }, [applyCoreviewActionStatus, coreviewActionBus, recordCoreviewToolTelemetry])

  useEffect(() => {
    if (!isVisible || !builderStageActive) {
      return
    }

    return registerCoreviewToolBridge((call: CoreviewToolCallInput) => (
      runCoreviewAction((bus) => bus.handleToolCall(call))
    ))
  }, [builderStageActive, isVisible, runCoreviewAction])

  const routeArtifactReviewVoiceCommand = useCallback((transcript: string): ArtifactReviewVoiceCommandRouteResult => {
    if (!isVisible || !builderStageActive) {
      return { handled: false }
    }

    const command = parseArtifactReviewVoiceCommand(transcript)
    if (!command) {
      return { handled: false }
    }

    const currentView = coreviewCurrentViewRef.current ?? coreviewCurrentView
    const currentPageIndex = currentView.pageIndex
    const currentPageCount = Math.max(1, currentView.pageCount)
    const transportStateBefore = builderArtifactCoReview.transportStatus.statusText
    const toolName = coreviewToolNameFromVoiceCommand(command)
    const nativeToolsPrimary = Boolean(
      isVoiceMode
        && builderArtifactCoReview.state.state === "co_review_live"
        && builderArtifactCoReview.transportStatus.toolsSupportedInCoReview
    )

    if (nativeToolsPrimary) {
      if (wasRecentCoreviewToolActionHandled({ toolName, sinceMs: Date.now() - 2200 })) {
        return {
          handled: true,
          command,
          applied: true,
          blockedReason: null,
          triggeredRefresh: false,
          refreshResult: "not_requested",
          userMessage: null,
        }
      }
      return { handled: false }
    }

    if (!builderArtifactId || !currentView.artifactId) {
      setVoiceCommandStatus({
        text: buildBlockedVoiceCommandMessage(command, currentPageCount),
        tone: "warn",
      })
      recordReviewVoiceCommandTelemetry({
        command,
        applied: false,
        blockedReason: "no_artifact_selected",
        triggeredRefresh: false,
        refreshResult: "not_requested",
        artifactCurrentPageIndex: currentPageIndex,
        artifactCurrentPageCount: currentPageCount,
        autoRefreshBlockedReason: "no_artifact_selected",
        transportStateBefore,
        transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
      })
      return {
        handled: true,
        command,
        applied: false,
        blockedReason: "no_artifact_selected",
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: null,
      }
    }

    const frameSenderAvailable = Boolean(
      builderArtifactCoReview.transportStatus.stillFramesSupported
      && builderArtifactCoReview.transportStatus.visualTransportSupported
    )
    let blockedReason: CoreviewToolBlockedReason | null = null
    let nextPageIndex = currentPageIndex
    let nextZoom = currentView.zoom
    let nextFitMode = currentView.fitMode

    if (command.kind !== "refresh_view") {
      const setInput = coreviewSetViewInputFromVoiceCommand(command, currentView)
      if (typeof setInput.pageIndex === "number") {
        nextPageIndex = Math.floor(setInput.pageIndex)
      } else if (typeof setInput.pageNumber === "number") {
        nextPageIndex = Math.floor(setInput.pageNumber) - 1
      }
      nextZoom = typeof setInput.zoom === "number" ? clampArtifactZoom(setInput.zoom) : nextZoom
      nextFitMode = setInput.fitMode ?? nextFitMode

      const requestedPage = typeof setInput.pageIndex === "number" || typeof setInput.pageNumber === "number"
      const requestedZoom = typeof setInput.zoom === "number" || typeof setInput.fitMode === "string"
      if (requestedPage && (!currentView.supportsPagination || currentPageCount <= 1)) {
        blockedReason = "unsupported_pages"
      } else if (requestedPage && (nextPageIndex < 0 || nextPageIndex >= currentPageCount)) {
        blockedReason = "requested_page_out_of_bounds"
      } else if (requestedZoom && !currentView.supportsZoom) {
        blockedReason = "unsupported_renderer"
      }
    }

    if (blockedReason) {
      setVoiceCommandStatus({
        text: buildBlockedVoiceCommandMessage(command, currentPageCount),
        tone: "warn",
      })
      recordReviewVoiceCommandTelemetry({
        command,
        applied: false,
        blockedReason: routeBlockedReasonFromCoreview(blockedReason),
        triggeredRefresh: false,
        refreshResult: "not_requested",
        artifactCurrentPageIndex: currentPageIndex,
        artifactCurrentPageCount: currentPageCount,
        autoRefreshBlockedReason: blockedReason,
        transportStateBefore,
        transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
      })
      return {
        handled: true,
        command,
        applied: false,
        blockedReason: routeBlockedReasonFromCoreview(blockedReason),
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: null,
      }
    }

    const viewChanged = (
      command.kind !== "refresh_view"
      && (
        nextPageIndex !== currentPageIndex
        || Math.abs(nextZoom - currentView.zoom) >= 0.01
        || nextFitMode !== currentView.fitMode
      )
    )
    const refreshResult: ArtifactReviewVoiceCommandRefreshResult = currentView.canRefresh
      ? "pending"
      : frameSenderAvailable
        ? "not_active"
        : "unavailable"
    const triggeredRefresh = currentView.canRefresh
    const shouldStartVoiceReview = command.kind !== "refresh_view" && (
      !currentView.reviewHasFrame
      || (
        builderArtifactCoReview.transportStatus.stillFramesSupported
        && !builderArtifactCoReview.transportStatus.visualTransportSupported
      )
    )

    if (viewChanged) {
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
    }
    setVoiceCommandStatus(triggeredRefresh
      ? {
          text: buildAppliedVoiceCommandStatus(command, nextPageIndex),
          tone: "neutral",
        }
      : {
          text: buildRefreshUnavailableVoiceCommandMessage(command, shouldStartVoiceReview, viewChanged && currentView.reviewHasFrame),
          tone: command.kind === "refresh_view" || viewChanged ? "warn" : "neutral",
        })

    void runCoreviewAction((bus) => (
      command.kind === "refresh_view"
        ? bus.refreshView({ reason: "voice command fallback" }, "frontend_fallback")
        : bus.setView(coreviewSetViewInputFromVoiceCommand(command, currentView), "frontend_fallback")
    ), { applyStatus: triggeredRefresh })
      .then((result) => {
        recordReviewVoiceCommandTelemetry({
          command,
          applied: routeBlockedReasonFromCoreview(result.blocked_reason) === null
            || result.blocked_reason === "refresh_unavailable"
            || result.blocked_reason === "review_not_active",
          blockedReason: result.action === "set_view" && result.blocked_reason
            ? routeBlockedReasonFromCoreview(result.blocked_reason)
            : null,
          triggeredRefresh: result.refresh_attempted,
          refreshResult: result.refresh_attempted
            ? refreshResultFromCoreview(result.refresh_result)
            : refreshResult,
          artifactCurrentPageIndex: result.page_index ?? nextPageIndex,
          artifactCurrentPageCount: result.page_count ?? currentPageCount,
          staleAfterPageChange: result.stale,
          waitedForViewReady: result.view_ready_wait_ms !== null,
          autoRefreshTiming: result.view_ready_wait_ms !== null
            ? `after_view_ready:${result.view_ready_wait_ms}ms`
            : null,
          autoRefreshBlockedReason: result.blocked_reason,
          transportStateBefore,
          transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
        })
      })
      .catch(() => {
        recordReviewVoiceCommandTelemetry({
          command,
          applied: true,
          blockedReason: null,
          triggeredRefresh,
          refreshResult: "error",
          artifactCurrentPageIndex: nextPageIndex,
          artifactCurrentPageCount: currentPageCount,
          staleAfterPageChange: viewChanged,
          waitedForViewReady: false,
          autoRefreshTiming: triggeredRefresh ? "queued" : "not_requested",
          autoRefreshBlockedReason: "refresh_exception",
          transportStateBefore,
          transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
        })
      })

    return {
      handled: true,
      command,
      applied: true,
      blockedReason: null,
      triggeredRefresh,
      refreshResult,
      userMessage: null,
    }
  }, [
    builderArtifactCoReview.state.state,
    builderArtifactCoReview.transportStatus.statusText,
    builderArtifactCoReview.transportStatus.stillFramesSupported,
    builderArtifactCoReview.transportStatus.toolsSupportedInCoReview,
    builderArtifactCoReview.transportStatus.visualTransportSupported,
    builderArtifactId,
    builderStageActive,
    coreviewCurrentView,
    isVoiceMode,
    isVisible,
    recordReviewVoiceCommandTelemetry,
    runCoreviewAction,
  ])

  useEffect(() => {
    onArtifactReviewVoiceCommandRouteChange?.(routeArtifactReviewVoiceCommand)
    return () => onArtifactReviewVoiceCommandRouteChange?.(null)
  }, [onArtifactReviewVoiceCommandRouteChange, routeArtifactReviewVoiceCommand])

  useEffect(() => {
    setVoiceCommandStaleViewSignature(null)
    setVoiceCommandStatus(null)
  }, [builderArtifactId, stagePrimaryFile?.path, stageRendererKind])

  useEffect(() => {
    if (
      !voiceCommandStaleViewSignature
      || builderArtifactCoReview.state.state !== "co_review_live"
      || (builderArtifactCoReview.state.frameSentCount ?? 0) <= 0
    ) {
      if (voiceCommandStaleViewSignature) {
        setVoiceCommandStaleViewSignature(null)
      }
      return
    }

    if (
      builderArtifactCoReview.state.refreshFrameResult === "success"
      && builderArtifactViewSignature === voiceCommandStaleViewSignature
      && !builderArtifactCoReview.reviewStale
    ) {
      setVoiceCommandStaleViewSignature(null)
    }
  }, [
    builderArtifactCoReview.reviewStale,
    builderArtifactCoReview.state.frameSentCount,
    builderArtifactCoReview.state.refreshFrameResult,
    builderArtifactCoReview.state.state,
    builderArtifactViewSignature,
    voiceCommandStaleViewSignature,
  ])

  useEffect(() => {
    if (!isVisible || !stageBuilderArtifact || !builderArtifactId) {
      selectedStageCaptureSignatureRef.current = null
      return
    }

    const signature = [
      sessionId ?? "",
      normalSessionId ?? "",
      threadId ?? "",
      builderArtifactId,
      stagePrimaryFile?.path ?? stageBuilderArtifact.artifactPath ?? "",
      stageRendererKind,
      builderArtifactViewSignature ?? "",
      effectiveBuilderVisualCaptureStatus.ready ? "ready" : "not-ready",
      builderExactTextAvailable ? "exact" : "no-exact",
    ].join("|")

    if (selectedStageCaptureSignatureRef.current === signature) {
      return
    }
    selectedStageCaptureSignatureRef.current = signature

    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "select-stage-artifact",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        artifactId: builderArtifactId,
        coreviewArtifactId: builderArtifactId,
        artifactPath: stagePrimaryFile?.path ?? stageBuilderArtifact.artifactPath ?? null,
        artifactTitle: stageBuilderArtifact.artifactTitle,
        artifactType: stageBuilderArtifact.artifactType,
        artifactKind: "builder_file",
        selectedBuilderArtifactPath: normalizedSelectedBuilderArtifactPath ?? null,
        source: normalizedSelectedBuilderArtifactPath ? "selected_builder_artifact" : "latest_builder_artifact",
        reviewFeatureEnabled: coreviewReviewEnabled,
        ...coreviewDiagnostics,
        exactTextSource: stageUsesMarkdownPreview
          ? "builder_file"
          : stageUsesPdfPreview
            ? builderExactTextAvailable
              ? "pdf_text_extraction"
              : "unsupported"
            : "builder_metadata",
        exactTextAvailable: builderExactTextAvailable,
        pdfTextExtractionStatus: effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus ?? null,
        pdfTextExtractionPageCount: effectiveBuilderVisualCaptureStatus.pdfTextExtractionPageCount ?? null,
        pdfTextExtractionCharCount: effectiveBuilderVisualCaptureStatus.pdfTextExtractionCharCount ?? null,
        pdfTextExtractionSource: effectiveBuilderVisualCaptureStatus.pdfTextExtractionSource ?? null,
        visualCaptureSource: effectiveBuilderVisualCaptureStatus.source,
        visualCaptureReady: effectiveBuilderVisualCaptureStatus.ready,
        visualCaptureReason: effectiveBuilderVisualCaptureStatus.reason,
        ...safeArtifactViewTelemetry(
          builderArtifactViewState,
          builderArtifactCoReview.lastFrameViewSignature,
          builderReviewStaleReason,
        ),
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    builderArtifactId,
    builderArtifactCoReview.lastFrameViewSignature,
    builderReviewStaleReason,
    builderExactTextAvailable,
    builderArtifactViewSignature,
    builderArtifactViewState,
    coreviewReviewEnabled,
    coreviewDiagnostics,
    effectiveBuilderVisualCaptureStatus.reason,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionCharCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionPageCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionSource,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus,
    effectiveBuilderVisualCaptureStatus.ready,
    effectiveBuilderVisualCaptureStatus.source,
    isVisible,
    normalSessionId,
    normalizedSelectedBuilderArtifactPath,
    sessionId,
    stageBuilderArtifact,
    stagePrimaryFile?.path,
    stageRendererKind,
    stageUsesMarkdownPreview,
    stageUsesPdfPreview,
    threadId,
  ])

  // Phase lifecycle
  useEffect(() => {
    if (isVisible && (artifacts || stageBuilderArtifact || hasBuilderLibrary)) {
      setPhase("entering")
      setRevealStep(0)
      setReflectionTapped(false)
      requestAnimationFrame(() => setPhase("visible"))
    } else if (phase !== "hidden") {
      setPhase("exiting")
      const t = setTimeout(() => setPhase("hidden"), 800)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, artifacts, stageBuilderArtifact, hasBuilderLibrary])

  useEffect(() => {
    if (!builderArtifactId) {
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("no_selected_artifact"))
      return
    }

    if (!stageUsesMarkdownPreview && !stageUsesPdfPreview) {
      setBuilderVisualCaptureStatus({
        ready: true,
        reason: null,
        source: "metadata_canvas",
        exactTextAvailable: true,
      })
      return
    }

    setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
  }, [builderArtifactId, stageUsesMarkdownPreview, stageUsesPdfPreview])

  // Staggered reveal — each piece fades in like a star brightening
  useEffect(() => {
    staggerRef.current.forEach(clearTimeout)
    staggerRef.current = []

    if (phase === "visible") {
      const delays = [100, 800, 1600, 2800]
      delays.forEach((d, i) => {
        staggerRef.current.push(setTimeout(() => setRevealStep(i + 1), d))
      })
    } else if (phase === "hidden") {
      setRevealStep(0)
    }

    return () => staggerRef.current.forEach(clearTimeout)
  }, [phase])

  // Voice mode: auto-dismiss after 18s — BUT NOT when builder deliverable is present
  // Builder results are high-value; user needs time to act on them
  useEffect(() => {
    if (autoCollapseRef.current) {
      clearTimeout(autoCollapseRef.current)
      autoCollapseRef.current = null
    }
    if (phase === "visible" && isVoiceMode && !stageBuilderArtifact && !hasBuilderLibrary && !showDomArtifactCoReview) {
      autoCollapseRef.current = setTimeout(() => {
        autoCollapseRef.current = null
        onDismiss()
      }, 18000)
    }
    return () => {
      if (autoCollapseRef.current) clearTimeout(autoCollapseRef.current)
    }
  }, [phase, isVoiceMode, onDismiss, stageBuilderArtifact, hasBuilderLibrary, showDomArtifactCoReview])

  useEffect(() => {
    if (!pendingBuilderArtifactReview || !hasBuilder || !stageBuilderArtifact) {
      return
    }

    if (builderReviewStateName === "co_review_live" || builderReviewStateName === "co_review_starting") {
      onPendingBuilderArtifactReviewConsumed?.()
      return
    }

    if (!builderReviewCanStart) {
      return
    }

    onPendingBuilderArtifactReviewConsumed?.()
    void startBuilderArtifactReview()
  }, [
    builderReviewCanStart,
    builderReviewStateName,
    hasBuilder,
    onPendingBuilderArtifactReviewConsumed,
    pendingBuilderArtifactReview,
    stageBuilderArtifact,
    startBuilderArtifactReview,
  ])

  const handleDismiss = useCallback(() => {
    haptic("light")
    onDismiss()
  }, [onDismiss])

  const handleReflectionTap = useCallback(() => {
    if (!artifacts?.reflection_candidate || !isRealReflection(artifacts.reflection_candidate.prompt) || reflectionTapped) return
    haptic("medium")
    setReflectionTapped(true)
    onReflectionTap?.({
      prompt: artifacts.reflection_candidate.prompt,
      why: artifacts.reflection_candidate.why,
    })
  }, [artifacts?.reflection_candidate, reflectionTapped, onReflectionTap])

  if ((!artifacts && !stageBuilderArtifact && !hasBuilderLibrary) || phase === "hidden") return null

  const hasContent = hasBuilder || hasBuilderLibrary || hasTakeaway || hasReflection || hasMemories

  if (!hasContent) return null

  const isActive = phase === "visible"
  const isTextModeBuilderStage = !isVoiceMode && hasBuilder
  const showSecondaryArtifactSurfaces = !builderStageActive

  // Presence-reactive bloom color
  const bloomColor =
    status === "speaking"
      ? "var(--sophia-glow)"
      : status === "listening"
        ? "var(--cosmic-teal)"
        : "var(--sophia-purple)"

  return (
    <div
      className={cn(
        "pointer-events-none select-none",
        "transition-all duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        isVoiceMode
          ? hasBuilder
            ? "fixed inset-x-0 top-[72px] bottom-[calc(8.75rem+env(safe-area-inset-bottom,0px))] z-25 flex min-h-0 items-center justify-center overflow-hidden px-3 sm:px-6"
            : "fixed left-1/2 -translate-x-1/2 bottom-[155px] z-25 w-full max-w-[720px] px-4 sm:px-6"
          : isTextModeBuilderStage
            ? "relative z-10 h-full min-h-0 w-full max-w-none px-0"
          : cn(
              "relative z-10 w-full mx-auto px-6 mb-3",
              hasBuilder ? "max-w-4xl" : "max-w-2xl",
            ),
        isActive ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      )}
      role="complementary"
      aria-label="Session artifacts"
    >
      {/* Bloom halo — the nebula glow behind the content */}
      <div
        className="absolute inset-0 -inset-x-8 -inset-y-4 rounded-full pointer-events-none transition-opacity duration-[2000ms]"
        style={{
          background: `radial-gradient(ellipse 80% 70% at 50% 40%, color-mix(in srgb, ${bloomColor} 8%, transparent) 0%, transparent 70%)`,
          filter: "blur(30px)",
          opacity: isActive ? 1 : 0,
        }}
      />

      {/* Dismiss zone — entire panel, tap to dismiss in voice mode */}
      <div
        className={cn(
          "relative pointer-events-auto",
          isVoiceMode && "cursor-pointer",
          isVoiceMode
            ? hasBuilder
              ? "flex h-full min-h-0 w-full max-w-[1120px] flex-col overflow-hidden rounded-xl px-0 py-0"
              : "max-h-[68vh] overflow-y-auto rounded-2xl px-4 py-4"
            : isTextModeBuilderStage
              ? "flex h-full min-h-0 flex-col overflow-hidden rounded-xl"
              : "rounded-2xl px-5 py-4"
        )}
        style={isTextModeBuilderStage || (isVoiceMode && hasBuilder)
          ? undefined
          : {
              background: 'var(--cosmic-panel)',
              borderRadius: '16px',
              border: '1px solid var(--cosmic-border-soft)',
              backdropFilter: 'blur(20px) saturate(1.2)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
            }}
        onClick={isVoiceMode && !hasBuilder ? handleDismiss : undefined}
      >
        {/* Dismiss hint — whisper-thin, top-right */}
        <button
          onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
          className={cn(
            "absolute right-2 top-2 z-10 w-6 h-6 flex items-center justify-center",
            "transition-all duration-700",
            "pointer-events-auto cursor-pointer",
            revealStep >= 1 ? "opacity-100" : "opacity-0"
          )}
          style={{ color: 'var(--cosmic-text-faint)' }}
          aria-label="Dismiss"
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2 2l8 8M10 2l-8 8" strokeLinecap="round" />
          </svg>
        </button>

        {hasBuilder && stageBuilderArtifact && (
          <div
            ref={setBuilderArtifactRoot}
            className={cn(
              "relative transition-all duration-[1400ms] ease-out",
              isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
              isVoiceMode && "flex h-full min-h-0 w-full flex-col overflow-hidden",
              revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            {builderArtifactId && !stageUsesMarkdownPreview && !stageUsesPdfPreview && (
              <CoreviewRealArtifactCanvas
                artifactId={builderArtifactId}
                builderArtifact={stageBuilderArtifact}
                sessionId={sessionId}
                normalSessionId={normalSessionId}
                threadId={threadId}
              />
            )}

            <div
              className={cn(
                isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
                isVoiceMode && "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              {isVoiceMode ? (
                <VoiceArtifactStage
                  builderArtifact={stageBuilderArtifact}
                  builderArtifactLibrary={builderArtifactLibrary}
                  threadId={threadId}
                  artifactId={builderArtifactId}
                  sessionId={sessionId}
                  normalSessionId={normalSessionId}
                  reviewState={builderArtifactCoReview.state}
                  transportStatus={builderArtifactCoReview.transportStatus}
                  exactTextAvailable={builderExactTextAvailable}
                  canStartReview={builderArtifactCoReview.canStart}
                  reviewEnabled={builderArtifactCoReview.enabled}
                  visualReviewPreparing={visualReviewPreparing}
                  pendingStartVoiceReview={pendingBuilderArtifactReview}
                  visualCaptureStatus={stageUsesMarkdownPreview || stageUsesPdfPreview ? builderVisualCaptureStatus : null}
                  reviewViewPending={voiceCommandViewPending}
                  reviewStale={builderReviewStale}
                  canRefreshReview={builderArtifactCoReview.canRefresh}
                  voiceCommandStatusText={voiceCommandStatus?.text ?? null}
                  voiceCommandStatusTone={voiceCommandStatus?.tone}
                  onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
                  onArtifactViewStateChange={setReportedBuilderArtifactViewState}
                  onVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
                  onStartReview={() => { void builderArtifactCoReview.startReview() }}
                  onStopReview={() => { void builderArtifactCoReview.stopReview() }}
                  onRefreshReview={() => { void builderArtifactCoReview.refreshReview() }}
                />
              ) : (
                <ArtifactStage
                  builderArtifact={stageBuilderArtifact}
                  builderArtifactLibrary={builderArtifactLibrary}
                  threadId={threadId}
                  artifactId={builderArtifactId}
                  sessionId={sessionId}
                  normalSessionId={normalSessionId}
                  reviewState={builderArtifactCoReview.state}
                  transportStatus={builderArtifactCoReview.transportStatus}
                  exactTextAvailable={builderExactTextAvailable}
                  canStartReview={builderArtifactCoReview.canStart}
                  reviewEnabled={builderArtifactCoReview.enabled}
                  visualReviewRequiresVoice={visualReviewRequiresVoice}
                  pendingStartVoiceReview={pendingBuilderArtifactReview}
                  visualCaptureStatus={stageUsesMarkdownPreview || stageUsesPdfPreview ? builderVisualCaptureStatus : null}
                  reviewViewPending={voiceCommandViewPending}
                  reviewStale={builderReviewStale}
                  canRefreshReview={builderArtifactCoReview.canRefresh}
                  voiceCommandStatusText={voiceCommandStatus?.text ?? null}
                  voiceCommandStatusTone={voiceCommandStatus?.tone}
                  onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
                  onArtifactViewStateChange={setReportedBuilderArtifactViewState}
                  onVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
                  onStartVoiceReview={onStartVoiceBuilderArtifactReview}
                  onStartReview={() => { void builderArtifactCoReview.startReview() }}
                  onStopReview={() => { void builderArtifactCoReview.stopReview() }}
                  onRefreshReview={() => { void builderArtifactCoReview.refreshReview() }}
                  fillAvailable={isTextModeBuilderStage}
                  className={cn(isTextModeBuilderStage && "min-h-0 flex-1")}
                />
              )}
            </div>
          </div>
        )}

        <PresenceArtifactSecondarySurfaces
          artifacts={artifacts}
          builderArtifactLibrary={builderArtifactLibrary}
          stageBuilderArtifact={stageBuilderArtifact}
          showSecondaryArtifactSurfaces={showSecondaryArtifactSurfaces}
          showDomArtifactCoReview={showDomArtifactCoReview}
          threadId={threadId}
          sessionId={sessionId}
          normalSessionId={normalSessionId}
          revealStep={revealStep}
          isActive={isActive}
          bloomColor={bloomColor}
          reflectionTapped={reflectionTapped}
          domArtifactCoReview={domArtifactCoReview}
          onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
          onHandleReflectionTap={handleReflectionTap}
          onReflectionTap={onReflectionTap}
          onMemoryApprove={onMemoryApprove}
          onMemoryReject={onMemoryReject}
          onDomArtifactRootChange={setDomArtifactRoot}
        />
      </div>
    </div>
  )
}

/**
 * Cosmic toggle — a faint constellation marker that glows when tapped.
 * Shows when artifacts are dismissed but available.
 * Matches the whisper-indicator aesthetic: near-invisible, part of the field.
 */
export function ArtifactToggleIcon({
  hasArtifacts,
  onClick,
  isNew,
}: {
  hasArtifacts: boolean
  onClick: () => void
  /** True when new/unseen insights are available */
  isNew?: boolean
}) {
  if (!hasArtifacts) return null

  return (
    <button
      onClick={() => { haptic("light"); onClick() }}
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 rounded-full",
        "transition-all duration-500 cursor-pointer",
        isNew && "animate-[insightPulse_2.5s_ease-in-out_infinite]",
      )}
      style={{
        color: isNew ? 'var(--cosmic-text-strong)' : 'var(--cosmic-text)',
        background: isNew
          ? 'color-mix(in srgb, var(--sophia-purple) 18%, var(--cosmic-panel))'
          : 'var(--cosmic-panel-soft)',
        border: isNew
          ? '1px solid color-mix(in srgb, var(--sophia-purple) 35%, transparent)'
          : '1px solid var(--cosmic-border-soft)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      aria-label={isNew ? "New insights available" : "Show insights"}
    >
      {/* Bloom dot */}
      <span
        className={cn(
          "w-2 h-2 rounded-full transition-all duration-700",
          isNew && "shadow-[0_0_10px_var(--sophia-glow)]",
        )}
        style={{
          background: isNew
            ? 'var(--sophia-glow)'
            : 'color-mix(in srgb, var(--sophia-purple) 50%, var(--cosmic-panel-soft))',
        }}
      />
      <span className={cn(
        "text-[11px] tracking-[0.1em] lowercase font-medium",
        isNew && "text-[12px]",
      )}>
        {isNew ? 'new insight' : 'insights'}
      </span>
    </button>
  )
}
