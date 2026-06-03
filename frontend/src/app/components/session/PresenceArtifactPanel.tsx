"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useArtifactCoReview } from "../../hooks/useArtifactCoReview"
import { haptic } from "../../hooks/useHaptics"
import {
  buildArtifactViewSignature,
  createDefaultArtifactViewState,
  detectArtifactRendererKind,
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
import {
  buildThreadArtifactHref,
  formatBuilderArtifactFileSize,
  getBuilderArtifactFiles,
  normalizeBuilderArtifactPath,
} from "../../lib/builder-artifacts"
import { coreviewFlagDiagnostics, isCoreviewStillFrameReviewEnabled } from "../../lib/co-review-flags"
import type { CoReviewMediaTransport } from "../../lib/co-review-transport"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import { isRealReflection } from "../../session/artifacts"
import { usePresenceStore } from "../../stores/presence-store"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { RitualArtifacts } from "../../types/session"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import { ArtifactStage, type ArtifactReviewVoiceCommandTarget } from "./ArtifactStage"
import {
  COREVIEW_COMPANION_ARTIFACT_ID,
  CoreviewCompanionArtifactCanvas,
} from "./CoreviewCompanionArtifactCanvas"
import { CoReviewControls } from "./CoReviewControls"
import { buildCoreviewRealArtifactId, CoreviewRealArtifactCanvas } from "./CoreviewRealArtifactCanvas"
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

type PendingArtifactReviewVoiceCommandRefresh = {
  requestId: string
  command: ArtifactReviewVoiceCommand
  artifactCurrentPageIndex: number
  artifactCurrentPageCount: number
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

function nextVoiceCommandRefreshRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function buildAppliedVoiceCommandMessage(
  command: ArtifactReviewVoiceCommand,
  pageIndex: number,
  refreshing: boolean,
): string {
  const suffix = refreshing ? " Refreshing Sophia's view..." : ""
  switch (command.kind) {
    case "go_to_page":
    case "next_page":
    case "previous_page":
    case "first_page":
    case "last_page":
      return `Switched to page ${pageIndex + 1}.${suffix}`
    case "zoom_in":
    case "zoom_out":
    case "fit_width":
    case "fit_page":
    case "reset_zoom":
      return `Updated the PDF view.${suffix}`
    case "refresh_view":
      return refreshing ? "Refreshing Sophia's view..." : "Refresh requested."
    default:
      return "Updated the artifact view."
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
): string {
  if (shouldStartVoiceReview) {
    if (command.kind === "refresh_view") {
      return "Start voice review to refresh Sophia's view."
    }

    return isPageNavigationVoiceCommand(command)
      ? "Page changed. Start voice review to refresh Sophia's view."
      : "PDF view updated. Start voice review to refresh Sophia's view."
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
  const [pendingVoiceCommandRefresh, setPendingVoiceCommandRefresh] = useState<PendingArtifactReviewVoiceCommandRefresh | null>(null)
  const voiceCommandRefreshInFlightRef = useRef<string | null>(null)
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
    const file = getBuilderArtifactFiles(stageBuilderArtifact).find((candidate) => candidate.isPrimary)
      ?? getBuilderArtifactFiles(stageBuilderArtifact)[0]
      ?? null
    if (!file) {
      return null
    }

    const libraryItem = builderArtifactLibrary.find((item) => item.path === file.path)
    return {
      ...file,
      ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
      ...(typeof libraryItem?.sizeBytes === "number" ? { sizeBytes: libraryItem.sizeBytes } : {}),
    }
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
        artifactCurrentPageIndex: details.artifactCurrentPageIndex,
        artifactCurrentPageCount: details.artifactCurrentPageCount,
        artifactRendererKind: builderArtifactViewState.rendererKind,
        artifactFitMode: builderArtifactViewState.fitMode,
        rawTranscriptExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    builderArtifactId,
    builderArtifactViewState.fitMode,
    builderArtifactViewState.rendererKind,
    normalSessionId,
    sessionId,
    threadId,
  ])

  const routeArtifactReviewVoiceCommand = useCallback((transcript: string): ArtifactReviewVoiceCommandRouteResult => {
    if (!isVisible || !builderStageActive) {
      return { handled: false }
    }

    const command = parseArtifactReviewVoiceCommand(transcript)
    if (!command) {
      return { handled: false }
    }

    const voiceCommandTarget = builderVoiceCommandTargetRef.current ?? builderVoiceCommandTarget
    const currentPageIndex = voiceCommandTarget?.pageIndex ?? builderArtifactViewState.pageIndex
    const currentPageCount = voiceCommandTarget?.pageCount ?? builderArtifactViewState.pageCount

    if (!builderArtifactId || !voiceCommandTarget) {
      recordReviewVoiceCommandTelemetry({
        command,
        applied: false,
        blockedReason: "no_artifact_selected",
        triggeredRefresh: false,
        refreshResult: "not_requested",
        artifactCurrentPageIndex: currentPageIndex,
        artifactCurrentPageCount: currentPageCount,
      })
      return {
        handled: true,
        command,
        applied: false,
        blockedReason: "no_artifact_selected",
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: buildBlockedVoiceCommandMessage(command, currentPageCount),
      }
    }

    const applyResult = voiceCommandTarget.applyCommand(command)
    let triggeredRefresh = false
    let refreshResult: ArtifactReviewVoiceCommandRefreshResult = "not_requested"
    let userMessage: string | null = null

    if (!applyResult.applied) {
      recordReviewVoiceCommandTelemetry({
        command,
        applied: false,
        blockedReason: applyResult.blockedReason,
        triggeredRefresh: false,
        refreshResult,
        artifactCurrentPageIndex: applyResult.artifactCurrentPageIndex,
        artifactCurrentPageCount: applyResult.artifactCurrentPageCount,
      })
      return {
        handled: true,
        command,
        applied: false,
        blockedReason: applyResult.blockedReason,
        triggeredRefresh: false,
        refreshResult,
        userMessage: buildBlockedVoiceCommandMessage(command, applyResult.artifactCurrentPageCount),
      }
    }

    if (applyResult.changed) {
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
    }

    if (applyResult.shouldRefresh) {
      if (builderArtifactCoReview.canRefresh || builderArtifactCoReview.state.state === "co_review_starting") {
        triggeredRefresh = true
        refreshResult = "pending"
        setPendingVoiceCommandRefresh({
          requestId: nextVoiceCommandRefreshRequestId(),
          command,
          artifactCurrentPageIndex: applyResult.artifactCurrentPageIndex,
          artifactCurrentPageCount: applyResult.artifactCurrentPageCount,
        })
        userMessage = buildAppliedVoiceCommandMessage(command, applyResult.artifactCurrentPageIndex, true)
      } else {
        refreshResult = builderArtifactCoReview.transportStatus.stillFramesSupported
          ? "not_active"
          : "unavailable"
        userMessage = buildRefreshUnavailableVoiceCommandMessage(
          command,
          builderArtifactCoReview.transportStatus.stillFramesSupported
            && !builderArtifactCoReview.transportStatus.visualTransportSupported,
        )
      }
    }

    recordReviewVoiceCommandTelemetry({
      command,
      applied: true,
      blockedReason: null,
      triggeredRefresh,
      refreshResult,
      artifactCurrentPageIndex: applyResult.artifactCurrentPageIndex,
      artifactCurrentPageCount: applyResult.artifactCurrentPageCount,
    })

    return {
      handled: true,
      command,
      applied: true,
      blockedReason: null,
      triggeredRefresh,
      refreshResult,
      userMessage: userMessage ?? buildAppliedVoiceCommandMessage(command, applyResult.artifactCurrentPageIndex, false),
    }
  }, [
    builderArtifactCoReview.canRefresh,
    builderArtifactCoReview.state.state,
    builderArtifactCoReview.transportStatus.stillFramesSupported,
    builderArtifactCoReview.transportStatus.visualTransportSupported,
    builderArtifactId,
    builderArtifactViewState.pageCount,
    builderArtifactViewState.pageIndex,
    builderStageActive,
    builderVoiceCommandTarget,
    isVisible,
    recordReviewVoiceCommandTelemetry,
  ])

  useEffect(() => {
    onArtifactReviewVoiceCommandRouteChange?.(routeArtifactReviewVoiceCommand)
    return () => onArtifactReviewVoiceCommandRouteChange?.(null)
  }, [onArtifactReviewVoiceCommandRouteChange, routeArtifactReviewVoiceCommand])

  useEffect(() => {
    const pending = pendingVoiceCommandRefresh
    if (!pending || voiceCommandRefreshInFlightRef.current === pending.requestId) {
      return
    }
    if (!builderArtifactCoReview.canRefresh || !builderVisualSourceReady) {
      return
    }
    if (builderArtifactViewState.pageIndex !== pending.artifactCurrentPageIndex) {
      return
    }

    voiceCommandRefreshInFlightRef.current = pending.requestId
    void builderArtifactCoReview.refreshReview()
      .then((nextState) => {
        const refreshResult: ArtifactReviewVoiceCommandRefreshResult =
          nextState.refreshFrameResult === "success" && (nextState.frameSentCount ?? 0) > 0
            ? "success"
            : "error"
        recordReviewVoiceCommandTelemetry({
          command: pending.command,
          applied: true,
          blockedReason: null,
          triggeredRefresh: true,
          refreshResult,
          artifactCurrentPageIndex: pending.artifactCurrentPageIndex,
          artifactCurrentPageCount: pending.artifactCurrentPageCount,
        })
      })
      .catch(() => {
        recordReviewVoiceCommandTelemetry({
          command: pending.command,
          applied: true,
          blockedReason: null,
          triggeredRefresh: true,
          refreshResult: "error",
          artifactCurrentPageIndex: pending.artifactCurrentPageIndex,
          artifactCurrentPageCount: pending.artifactCurrentPageCount,
        })
      })
      .finally(() => {
        voiceCommandRefreshInFlightRef.current = null
        setPendingVoiceCommandRefresh((current) => (
          current?.requestId === pending.requestId ? null : current
        ))
      })
  }, [
    builderArtifactCoReview,
    builderArtifactViewState.pageIndex,
    builderVisualSourceReady,
    pendingVoiceCommandRefresh,
    recordReviewVoiceCommandTelemetry,
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
            ? "unsupported"
            : "builder_metadata",
        exactTextAvailable: builderExactTextAvailable,
        visualCaptureSource: effectiveBuilderVisualCaptureStatus.source,
        visualCaptureReady: effectiveBuilderVisualCaptureStatus.ready,
        visualCaptureReason: effectiveBuilderVisualCaptureStatus.reason,
        ...safeArtifactViewTelemetry(
          builderArtifactViewState,
          builderArtifactCoReview.lastFrameViewSignature,
          builderArtifactCoReview.reviewStaleReason,
        ),
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    builderArtifactId,
    builderArtifactCoReview.lastFrameViewSignature,
    builderArtifactCoReview.reviewStaleReason,
    builderExactTextAvailable,
    builderArtifactViewSignature,
    builderArtifactViewState,
    coreviewReviewEnabled,
    coreviewDiagnostics,
    effectiveBuilderVisualCaptureStatus.reason,
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
                  reviewStale={builderArtifactCoReview.reviewStale}
                  canRefreshReview={builderArtifactCoReview.canRefresh}
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
                  reviewStale={builderArtifactCoReview.reviewStale}
                  canRefreshReview={builderArtifactCoReview.canRefresh}
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

        {hasBuilderLibrary && showSecondaryArtifactSurfaces && (
          <div
            className={cn(
              cn(stageBuilderArtifact ? "mt-4" : ""),
              "mb-4 transition-all duration-[1400ms] ease-out",
              revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            <p
              className="mb-2 text-center text-[9px] tracking-[0.18em] uppercase"
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              Session files
            </p>

            <div className="flex flex-col items-center gap-2">
              {builderArtifactLibrary.map((file) => {
                const downloadHref = buildThreadArtifactHref(threadId, file.path, { download: true })
                const openHref = buildThreadArtifactHref(threadId, file.path)
                const isSelected = stageBuilderArtifact?.artifactPath === file.path
                const meta = [formatBuilderArtifactFileSize(file.sizeBytes), file.mimeType]
                  .filter(Boolean)
                  .join(' • ')

                return (
                  <div
                    key={file.path}
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="text-center">
                      <span className="block text-[10px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                        {file.name}
                      </span>
                      {meta && (
                        <span className="block text-[9px]" style={{ color: 'var(--cosmic-text-faint)' }}>
                          {meta}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      {onSelectedBuilderArtifactPathChange && (
                        <button
                          type="button"
                          aria-label={`View ${file.name} in canvas`}
                          aria-pressed={isSelected}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
                          style={{
                            borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
                            color: 'var(--sophia-purple)',
                            background: isSelected
                              ? 'color-mix(in srgb, var(--sophia-purple) 12%, transparent)'
                              : 'transparent',
                          }}
                          onClick={() => {
                            haptic('light')
                            onSelectedBuilderArtifactPathChange(file.path)
                          }}
                        >
                          View in canvas
                        </button>
                      )}
                      {openHref && (
                        <a
                          href={openHref}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${file.name} in new tab`}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
                          style={{
                            borderColor: 'var(--cosmic-border-soft)',
                            color: 'var(--cosmic-text-whisper)',
                          }}
                          onClick={() => haptic('light')}
                        >
                          Open in new tab
                        </a>
                      )}
                      {downloadHref && (
                        <a
                          href={downloadHref}
                          aria-label={`Download ${file.name}`}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
                          style={{
                            borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
                            color: 'var(--sophia-purple)',
                            background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
                          }}
                          onClick={() => haptic('medium')}
                        >
                          Download
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {showSecondaryArtifactSurfaces ? (
        <div ref={setDomArtifactRoot}>
          {showDomArtifactCoReview && artifacts ? (
            <CoreviewCompanionArtifactCanvas
              artifacts={artifacts}
              artifactId={COREVIEW_COMPANION_ARTIFACT_ID}
              sessionId={sessionId}
              normalSessionId={normalSessionId}
              threadId={threadId}
            />
          ) : null}

          {/* === TAKEAWAY === emerges like a fading-in constellation */}
          {hasTakeaway && (
            <div
              className={cn(
                "transition-all duration-[1400ms] ease-out",
                revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
              )}
            >
              <p
                className="font-cormorant text-[17px] leading-[1.75] font-light text-center"
                style={{
                  color: revealStep >= 1 ? 'var(--cosmic-text-strong)' : 'transparent',
                  textShadow: isActive
                    ? `0 0 24px color-mix(in srgb, ${bloomColor} 22%, transparent)`
                    : "none",
                  transition: 'color 1.4s ease, text-shadow 2s ease',
                }}
              >
                {takeaway}
              </p>
            </div>
          )}

          {/* === DIVIDER === thin luminous line, like a nebula filament */}
          {hasTakeaway && (hasReflection || hasMemories) && (
            <div
              className={cn(
                "mx-auto my-4 transition-all duration-[1200ms] ease-out",
                revealStep >= 2 ? "opacity-100 scale-x-100" : "opacity-0 scale-x-0"
              )}
              style={{
                width: "32px",
                height: "1px",
                background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${bloomColor} 25%, var(--cosmic-text-faint)), transparent)`,
                transformOrigin: "center",
              }}
            />
          )}

          {/* === REFLECTION === the invitation, slightly brighter, interactive */}
          {hasReflection && (
            <div
              className={cn(
                "transition-all duration-[1400ms] ease-out",
                revealStep >= 3 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
              )}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleReflectionTap()
                }}
                disabled={reflectionTapped || !onReflectionTap}
                className={cn(
                  "w-full text-center transition-all duration-700",
                  !reflectionTapped && onReflectionTap
                    ? "cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
                    : "cursor-default",
                  reflectionTapped && "opacity-40"
                )}
              >
                <p
                  className="font-cormorant text-[15px] italic leading-[1.7] font-light"
                  style={{
                    color: reflectionTapped ? 'var(--cosmic-text-whisper)' : 'var(--cosmic-text-strong)',
                    textShadow: !reflectionTapped && isActive
                      ? `0 0 20px color-mix(in srgb, ${bloomColor} 18%, transparent)`
                      : "none",
                    transition: "color 0.7s ease, text-shadow 1s ease",
                  }}
                >
                  {reflection_candidate.prompt}
                </p>
                {reflection_candidate.why && !reflectionTapped && (
                  <p className="mt-1.5 text-[10px] tracking-[0.08em] font-light" style={{ color: 'var(--cosmic-text-faint)' }}>
                    {reflection_candidate.why}
                  </p>
                )}
                {!reflectionTapped && onReflectionTap && (
                  <span
                    className="inline-block mt-2.5 text-[9px] tracking-[0.14em] uppercase transition-colors duration-700"
                    style={{ color: `color-mix(in srgb, ${bloomColor} 40%, var(--cosmic-text-faint))` }}
                  >
                    tap to reflect
                  </span>
                )}
                {reflectionTapped && (
                  <span className="inline-block mt-1.5 text-[9px] tracking-[0.14em] uppercase" style={{ color: 'var(--cosmic-text-faint)' }}>
                    sent
                  </span>
                )}
              </button>
            </div>
          )}

          {/* === MEMORY CONSTELLATION === tiny stars, each a memory */}
          {hasMemories && (
            <div
              className={cn(
                "mt-4 flex justify-center gap-2 flex-wrap transition-all duration-[1200ms] ease-out",
                revealStep >= 4 ? "opacity-100" : "opacity-0"
              )}
            >
              {memory_candidates.slice(0, 5).map((mem, i) => (
                <span
                  key={i}
                  className={cn(
                    "group/mem relative text-[9px] tracking-[0.12em] lowercase px-2 py-[3px]",
                    "transition-all duration-[800ms] cursor-default",
                  )}
                  style={{
                    color: 'var(--cosmic-text-muted)',
                    animationDelay: `${i * 200}ms`,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {mem.memory || mem.category}
                  {/* Approve/reject on hover — tiny cosmic dust */}
                  {(onMemoryApprove || onMemoryReject) && (
                    <span className="hidden group-hover/mem:inline-flex items-center gap-0.5 ml-1">
                      {onMemoryApprove && (
                        <button
                          onClick={() => { haptic("light"); onMemoryApprove(i) }}
                          className="transition-colors hover:text-[var(--cosmic-text)]"
                          style={{ color: 'var(--cosmic-text-faint)' }}
                          aria-label="Save memory"
                        >
                          ✓
                        </button>
                      )}
                      {onMemoryReject && (
                        <button
                          onClick={() => { haptic("light"); onMemoryReject(i) }}
                          className="transition-colors hover:text-[var(--cosmic-text-muted)]"
                          style={{ color: 'var(--cosmic-text-faint)' }}
                          aria-label="Skip memory"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}

          {showDomArtifactCoReview && (
            <div className="mt-4" onClick={(e) => e.stopPropagation()}>
              <CoReviewControls
                state={domArtifactCoReview.state}
                transportStatus={domArtifactCoReview.transportStatus}
                onStart={() => { void domArtifactCoReview.startReview() }}
                onStop={() => { void domArtifactCoReview.stopReview() }}
                canStart={domArtifactCoReview.canStart}
                featureEnabled={domArtifactCoReview.enabled}
                className="justify-center"
              />
            </div>
          )}
        </div>
        ) : null}
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
