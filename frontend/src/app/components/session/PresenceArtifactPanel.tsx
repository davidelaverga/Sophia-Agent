"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useArtifactCoReview } from "../../hooks/useArtifactCoReview"
import { haptic } from "../../hooks/useHaptics"
import {
  buildArtifactViewSignature,
  createDefaultArtifactViewState,
  clampArtifactZoom,
  safeArtifactViewTelemetry,
  type ArtifactViewState,
} from "../../lib/artifact-renderers"
import { coreviewFlagDiagnostics, isCoreviewStillFrameReviewEnabled } from "../../lib/co-review-flags"
import {
  createCoreviewActionBus,
  registerCoreviewToolBridge,
  wasRecentCoreviewToolActionHandled,
  type CoreviewActionBus,
  type CoreviewActionResult,
  type CoreviewAnnotationAnchor,
  type CoreviewArtifactRebindInput,
  type CoreviewArtifactRebindResult,
  type CoreviewCurrentView,
  type CoreviewRendererAdapter,
  type CoreviewToolBlockedReason,
  type CoreviewToolCallInput,
  type CoreviewViewReadyResult,
} from "../../lib/coreview-actions"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import { isRealReflection } from "../../session/artifacts"
import { usePresenceStore } from "../../stores/presence-store"
import type { ArtifactToolMode } from "../../types/artifact-annotations"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import type { PresenceArtifactPanelProps } from "./PresenceArtifactPanel.types"
import {
  COREVIEW_COMPANION_ARTIFACT_ID,
  PresenceArtifactPanelBuilderSurfaces,
  type ArtifactReviewVoiceCommandTarget,
} from "./PresenceArtifactPanelBuilderSurfaces"
import {
  annotationFallbackResultFromCoreview,
  annotationFallbackUtteranceKind,
  buildAppliedVoiceCommandStatus,
  buildBlockedVoiceCommandMessage,
  buildRefreshUnavailableVoiceCommandMessage,
  coreviewAddAnnotationInputFromVoiceCommand,
  coreviewAnnotationCommandAlreadyHandled,
  coreviewAnnotationStateChanged,
  coreviewBlockedStatusText,
  coreviewFocusAnchorInputFromVoiceCommand,
  coreviewFocusCommandAlreadyHandled,
  coreviewSetViewInputFromVoiceCommand,
  coreviewToolNameFromAction,
  coreviewToolNameFromVoiceCommand,
  exactTextRehydrateResult,
  isAnnotationOrFocusVoiceCommand,
  parseArtifactReviewVoiceCommand,
  parseArtifactReviewVoiceCommands,
  refreshResultFromCoreview,
  routeBlockedReasonFromCoreview,
  useCoreviewArtifactStageModel,
  type ArtifactReviewVoiceCommand,
  type ArtifactReviewVoiceCommandRefreshResult,
  type ArtifactReviewVoiceCommandRouteResult,
  type CoreviewArtifactWorkspaceActor,
  type CoreviewWorkspaceEventRecorderInput,
} from "./useCoreviewArtifactStageModel"

type ArtifactVoiceCommandStatus = {
  text: string
  tone: "neutral" | "pending" | "success" | "warn"
}

function unavailableCaptureStatus(reason: ArtifactVisualCaptureStatus["reason"]): ArtifactVisualCaptureStatus {
  return {
    ready: false,
    reason,
    source: "none",
    exactTextAvailable: false,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
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
  voiceAgentSessionId,
  userId,
  threadId,
  isVisible,
  onDismiss,
  isVoiceMode,
  coReviewTransport,
  pendingBuilderArtifactReview = false,
  onStartVoiceBuilderArtifactReview,
  onPendingBuilderArtifactReviewConsumed,
  onArtifactReviewVoiceCommandRouteChange,
  onAnnotationActionSucceeded,
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
  const selectedStageRebindSignatureRef = useRef<string | null>(null)
  const builderStageVisibilitySignatureRef = useRef<string | null>(null)
  const [builderArtifactRoot, setBuilderArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [domArtifactRoot, setDomArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [builderVisualCaptureStatus, setBuilderVisualCaptureStatus] = useState<ArtifactVisualCaptureStatus>(
    () => unavailableCaptureStatus("no_selected_artifact"),
  )
  const [reportedBuilderArtifactViewState, setReportedBuilderArtifactViewState] = useState<ArtifactViewState | null>(null)
  const [builderVoiceCommandTarget, setBuilderVoiceCommandTarget] = useState<ArtifactReviewVoiceCommandTarget | null>(null)
  const builderVoiceCommandTargetRef = useRef<ArtifactReviewVoiceCommandTarget | null>(null)
  const lastCoreviewFocusedAnchorTypeRef = useRef<CoreviewAnnotationAnchor["type"] | null>(null)
  const pendingWorkspaceViewActorRef = useRef<CoreviewArtifactWorkspaceActor | null>(null)
  const lastWorkspaceViewSignatureRef = useRef<string | null>(null)
  const recordCoreviewWorkspaceEventRef = useRef<((input: CoreviewWorkspaceEventRecorderInput) => void) | null>(null)
  const [voiceCommandStaleViewSignature, setVoiceCommandStaleViewSignature] = useState<string | null>(null)
  const [voiceCommandStatus, setVoiceCommandStatus] = useState<ArtifactVoiceCommandStatus | null>(null)
  const coreviewCurrentViewRef = useRef<CoreviewCurrentView | null>(null)
  const coreviewVisualReadyRef = useRef(false)
  const status = usePresenceStore((s) => s.status)
  const {
    hasBuilderLibrary,
    normalizedSelectedBuilderArtifactPath,
    stageBuilderArtifact,
    hasBuilder,
    builderStageActive,
    builderArtifactId,
    stagePrimaryFile,
    stageRendererKind,
    stageArtifactPath,
    stageArtifactCapabilities,
    stageArtifactCapabilityTelemetry,
    builderStageVisibilitySignature,
    artifactStableIdentity,
    coreviewWorkspaceKey,
    coreviewArtifactKey,
    userWorkspaceActor,
    sophiaWorkspaceActor,
    coreviewAnnotationList,
    coreviewAnnotationCounts,
    coreviewAnnotationTelemetry,
    recordCoreviewWorkspaceEvent,
    addCoreviewAnnotation,
    updateCoreviewAnnotation,
    deleteCoreviewAnnotation,
  } = useCoreviewArtifactStageModel({
    builderArtifact,
    builderArtifactLibrary,
    selectedBuilderArtifactPath,
    builderVisualCaptureStatus,
    userId,
    threadId,
  })
  const takeaway = artifacts?.takeaway
  const reflection_candidate = artifacts?.reflection_candidate
  const memory_candidates = artifacts?.memory_candidates
  const hasReflection = isRealReflection(reflection_candidate?.prompt)
  const hasMemories = memory_candidates && memory_candidates.length > 0
  const hasTakeaway = !!takeaway?.trim()
  const coreviewReviewEnabled = isCoreviewStillFrameReviewEnabled()
  const coreviewDiagnostics = useMemo(() => coreviewFlagDiagnostics(), [])
  const builderReviewEnabled = Boolean(coreviewReviewEnabled && builderArtifactId)
  useEffect(() => {
    recordCoreviewWorkspaceEventRef.current = recordCoreviewWorkspaceEvent
  }, [recordCoreviewWorkspaceEvent])

  const stageUsesMarkdownPreview = stageArtifactCapabilities.renderMode === "markdown"
  const stageUsesPdfPreview = stageArtifactCapabilities.renderMode === "canvas" && stageRendererKind === "pdf"
  const fallbackBuilderArtifactViewState = useMemo(() => (
    createDefaultArtifactViewState({
      artifactId: builderArtifactId,
      filePath: stageArtifactPath,
      rendererKind: stageRendererKind,
    })
  ), [builderArtifactId, stageArtifactPath, stageRendererKind])
  const builderArtifactViewState = (
    reportedBuilderArtifactViewState?.artifactId === builderArtifactId
    && reportedBuilderArtifactViewState?.filePath === stageArtifactPath
  )
    ? reportedBuilderArtifactViewState
    : fallbackBuilderArtifactViewState
  const builderArtifactViewSignature = buildArtifactViewSignature(builderArtifactViewState)
  const workspaceArtifactDescriptor = useMemo(() => (
    isVisible && builderStageActive && builderArtifactId && coreviewArtifactKey
      ? {
          signature: [
            coreviewWorkspaceKey,
            coreviewArtifactKey,
            builderArtifactId,
          ].join("|"),
          artifactKey: coreviewArtifactKey,
          artifactId: builderArtifactId,
          artifactPath: stageArtifactPath,
          artifactTitle: stageBuilderArtifact?.artifactTitle ?? null,
          rendererKind: stageRendererKind,
        }
      : null
  ), [
    builderArtifactId,
    builderStageActive,
    coreviewArtifactKey,
    coreviewWorkspaceKey,
    isVisible,
    stageArtifactPath,
    stageBuilderArtifact?.artifactTitle,
    stageRendererKind,
  ])
  const handleReportedBuilderArtifactViewStateChange = useCallback((state: ArtifactViewState) => {
    setReportedBuilderArtifactViewState(state)
    const nextSignature = buildArtifactViewSignature(state)
    if (!coreviewArtifactKey || !nextSignature) {
      lastWorkspaceViewSignatureRef.current = nextSignature
      return
    }

    const previousSignature = lastWorkspaceViewSignatureRef.current
    if (!previousSignature) {
      lastWorkspaceViewSignatureRef.current = nextSignature
      return
    }
    if (previousSignature === nextSignature) {
      return
    }

    lastWorkspaceViewSignatureRef.current = nextSignature
    const actor = pendingWorkspaceViewActorRef.current ?? userWorkspaceActor
    pendingWorkspaceViewActorRef.current = null
    recordCoreviewWorkspaceEvent({
      type: "view.changed",
      actor,
      payload: {
        artifactId: state.artifactId,
        artifactPath: state.filePath,
        rendererKind: state.rendererKind,
        pageIndex: state.pageIndex,
        pageCount: state.pageCount,
        zoom: state.zoom,
        fitMode: state.fitMode,
        viewSignatureChanged: true,
      },
    })
  }, [coreviewArtifactKey, recordCoreviewWorkspaceEvent, userWorkspaceActor])

  useEffect(() => {
    lastWorkspaceViewSignatureRef.current = null
  }, [coreviewArtifactKey])

  useEffect(() => {
    if (!workspaceArtifactDescriptor) {
      return
    }

    recordCoreviewWorkspaceEventRef.current?.({
      type: "artifact.opened",
      actor: userWorkspaceActor,
      artifactKey: workspaceArtifactDescriptor.artifactKey,
      payload: {
        artifactId: workspaceArtifactDescriptor.artifactId,
        artifactPath: workspaceArtifactDescriptor.artifactPath,
        artifactTitle: workspaceArtifactDescriptor.artifactTitle,
        rendererKind: workspaceArtifactDescriptor.rendererKind,
      },
    })

    return () => {
      recordCoreviewWorkspaceEventRef.current?.({
        type: "artifact.closed",
        actor: userWorkspaceActor,
        artifactKey: workspaceArtifactDescriptor.artifactKey,
        payload: {
          artifactId: workspaceArtifactDescriptor.artifactId,
          artifactPath: workspaceArtifactDescriptor.artifactPath,
          artifactTitle: workspaceArtifactDescriptor.artifactTitle,
          rendererKind: workspaceArtifactDescriptor.rendererKind,
        },
      })
    }
  }, [userWorkspaceActor, workspaceArtifactDescriptor])
  const handleWorkspaceToolModeChange = useCallback((mode: ArtifactToolMode) => {
    recordCoreviewWorkspaceEvent({
      type: "tool.changed",
      actor: userWorkspaceActor,
      payload: {
        toolMode: mode,
        artifactId: builderArtifactId ?? null,
        artifactPath: stageArtifactPath,
        rendererKind: stageRendererKind,
      },
    })
  }, [builderArtifactId, recordCoreviewWorkspaceEvent, stageArtifactPath, stageRendererKind, userWorkspaceActor])
  const handleWorkspaceExportRequested = useCallback((input: {
    exportKind: "original" | "annotated"
    annotationCount: number
  }) => {
    recordCoreviewWorkspaceEvent({
      type: "export.requested",
      actor: userWorkspaceActor,
      payload: {
        exportKind: input.exportKind,
        annotationCount: input.annotationCount,
        artifactId: builderArtifactId ?? null,
        artifactPath: stageArtifactPath,
        rendererKind: stageRendererKind,
      },
    })
  }, [builderArtifactId, recordCoreviewWorkspaceEvent, stageArtifactPath, stageRendererKind, userWorkspaceActor])
  const effectiveBuilderVisualCaptureStatus = useMemo<ArtifactVisualCaptureStatus>(() => {
    if (!builderArtifactId) {
      return unavailableCaptureStatus("no_selected_artifact")
    }

    if (!stageUsesMarkdownPreview && !stageUsesPdfPreview) {
      return {
        ready: stageArtifactCapabilities.supportsStillFrame,
        reason: stageArtifactCapabilities.supportsStillFrame ? null : "exact_text_only_no_visual_source",
        source: "metadata_canvas",
        exactTextAvailable: stageArtifactCapabilities.canRender && stageArtifactCapabilities.renderMode === "metadata"
          ? true
          : stageArtifactCapabilities.supportsTextExtraction,
      }
    }

    return builderVisualCaptureStatus
  }, [
    builderArtifactId,
    builderVisualCaptureStatus,
    stageArtifactCapabilities.canRender,
    stageArtifactCapabilities.renderMode,
    stageArtifactCapabilities.supportsStillFrame,
    stageArtifactCapabilities.supportsTextExtraction,
    stageUsesMarkdownPreview,
    stageUsesPdfPreview,
  ])
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
    setBuilderVoiceCommandTarget((current) => (
      current === target ? current : target
    ))
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
  const coreviewCurrentView = useMemo<CoreviewCurrentView>(() => {
    const capabilities = builderVoiceCommandTarget?.capabilities ?? stageArtifactCapabilities
    return {
      artifactId: builderArtifactId,
      artifactPath: stageArtifactPath,
      artifactTitle: stageBuilderArtifact?.artifactTitle ?? null,
      artifactStableIdentity,
      rendererKind: builderArtifactViewState.rendererKind,
      capabilities,
      supportsPagination: capabilities.supportsPages,
      supportsZoom: capabilities.supportsZoom,
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
      annotationOverlayCaptured: builderVoiceCommandTarget?.annotationOverlayCaptured ?? (capabilities.supportsAnnotations ? coreviewAnnotationCounts.annotationCount > 0 : null),
      annotationCount: builderVoiceCommandTarget?.annotationCounts.annotationCount ?? coreviewAnnotationCounts.annotationCount,
      highlightCount: builderVoiceCommandTarget?.annotationCounts.highlightCount ?? coreviewAnnotationCounts.highlightCount,
      commentCount: builderVoiceCommandTarget?.annotationCounts.commentCount ?? coreviewAnnotationCounts.commentCount,
      underlineCount: builderVoiceCommandTarget?.annotationCounts.underlineCount ?? coreviewAnnotationCounts.underlineCount,
      arrowCount: builderVoiceCommandTarget?.annotationCounts.arrowCount ?? coreviewAnnotationCounts.arrowCount,
      drawPathCount: builderVoiceCommandTarget?.annotationCounts.drawPathCount ?? coreviewAnnotationCounts.drawPathCount,
      rebindStatus: "not_attempted",
    }
  }, [
    artifactStableIdentity,
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
    coreviewAnnotationCounts.annotationCount,
    coreviewAnnotationCounts.arrowCount,
    coreviewAnnotationCounts.commentCount,
    coreviewAnnotationCounts.drawPathCount,
    coreviewAnnotationCounts.highlightCount,
    coreviewAnnotationCounts.underlineCount,
    stageBuilderArtifact?.artifactTitle,
    stageArtifactPath,
    stageArtifactCapabilities,
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

  const recordSelectedStageArtifactTelemetry = useCallback((details: {
    rebindAttempted: boolean
    rebindSource: CoreviewArtifactRebindInput["source"]
    rebindReason?: string | null
    requestedArtifactId?: string | null
  }): boolean => {
    if (!isVisible || !stageBuilderArtifact || !builderArtifactId) {
      return false
    }

    const requestedArtifactId = details.requestedArtifactId ?? null
    const rebindResult = details.rebindAttempted
      ? requestedArtifactId && requestedArtifactId !== builderArtifactId
        ? "failed"
        : "success"
      : "not_attempted"
    const rebindReason = details.rebindAttempted && rebindResult === "failed"
      ? "artifact_not_available_in_current_session"
      : details.rebindReason ?? null
    const exactRehydrateResult = exactTextRehydrateResult({
      isPdf: stageUsesPdfPreview,
      exactTextAvailable: builderExactTextAvailable,
      pdfStatus: effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus ?? null,
    })

    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "select-stage-artifact",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        voiceAgentSessionId: voiceAgentSessionId ?? null,
        threadId: threadId ?? null,
        artifactId: builderArtifactId,
        coreviewArtifactId: builderArtifactId,
        artifactPath: stageArtifactPath,
        artifactTitle: stageBuilderArtifact.artifactTitle,
        artifactType: stageBuilderArtifact.artifactType,
        artifactKind: "builder_file",
        artifactStableIdentity,
        selectedBuilderArtifactPath: normalizedSelectedBuilderArtifactPath ?? null,
        source: normalizedSelectedBuilderArtifactPath ? "selected_builder_artifact" : "latest_builder_artifact",
        reviewFeatureEnabled: coreviewReviewEnabled,
        artifactRebindAttempted: details.rebindAttempted,
        artifactRebindResult: rebindResult,
        artifactRebindReason: rebindReason,
        artifactReboundFromRenderedState: details.rebindAttempted && isVisible,
        artifactRebindSource: details.rebindSource,
        exactTextRehydrated: details.rebindAttempted && builderExactTextAvailable,
        exactTextRehydrateResult: exactRehydrateResult,
        currentRunSelectedStageEvents: 1,
        longLivedSelectedStageState: true,
        telemetryScopeMode: details.rebindAttempted ? "current_run_rebind" : "long_lived_selected_stage",
        ...coreviewDiagnostics,
        ...stageArtifactCapabilityTelemetry,
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
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    })

    return rebindResult !== "failed"
  }, [
    artifactStableIdentity,
    builderArtifactCoReview.lastFrameViewSignature,
    builderArtifactId,
    builderArtifactViewState,
    builderExactTextAvailable,
    builderReviewStaleReason,
    coreviewDiagnostics,
    coreviewReviewEnabled,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionCharCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionPageCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionSource,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus,
    effectiveBuilderVisualCaptureStatus.ready,
    effectiveBuilderVisualCaptureStatus.reason,
    effectiveBuilderVisualCaptureStatus.source,
    isVisible,
    normalSessionId,
    normalizedSelectedBuilderArtifactPath,
    sessionId,
    stageArtifactPath,
    stageArtifactCapabilityTelemetry,
    stageBuilderArtifact,
    stageUsesMarkdownPreview,
    stageUsesPdfPreview,
    threadId,
    voiceAgentSessionId,
  ])

  const recordReviewVoiceCommandTelemetry = useCallback((details: {
    command: ArtifactReviewVoiceCommand
    commands?: ArtifactReviewVoiceCommand[]
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
    annotationFallbackAttempted?: boolean
    annotationFallbackResult?: "success" | "partial_success" | "blocked" | "not_attempted" | "annotation_commit_failed" | null
    annotationFallbackBlockedReason?: string | null
    recentAnnotationActionSucceeded?: boolean
    annotationCommitAttempted?: boolean
    annotationCommitResult?: string | null
    annotationCommitCountBefore?: number | null
    annotationCommitCountAfter?: number | null
    annotationCommitVerified?: boolean
    annotationCommandPreventedNavigation?: boolean
    annotationCommandKeptArtifactMounted?: boolean
    annotationViewReadyTimedOut?: boolean
    annotationPartialSuccess?: boolean
    sessionLeaveGuardSuppressedForAnnotation?: boolean
  }) => {
    const annotationIntentDetected = details.command.kind === "add_annotation"
    const annotationFallbackKind = annotationFallbackUtteranceKind(details.command, details.commands)
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
        annotationIntentDetected,
        annotationIntentDetectedCount: annotationIntentDetected ? 1 : 0,
        annotationIntentSource: annotationIntentDetected ? "artifact_review_voice_command" : null,
        annotationFallbackAttempted: details.annotationFallbackAttempted ?? false,
        annotationFallbackResult: details.annotationFallbackResult ?? null,
        annotationFallbackBlockedReason: details.annotationFallbackBlockedReason ?? null,
        annotationFallbackUtteranceKind: annotationFallbackKind,
        recentAnnotationActionSucceeded: details.recentAnnotationActionSucceeded ?? false,
        annotationCommitAttempted: details.annotationCommitAttempted ?? false,
        annotationCommitResult: details.annotationCommitResult ?? null,
        annotationCommitCountBefore: details.annotationCommitCountBefore ?? null,
        annotationCommitCountAfter: details.annotationCommitCountAfter ?? null,
        annotationCommitVerified: details.annotationCommitVerified ?? false,
        annotationCommandPreventedNavigation: details.annotationCommandPreventedNavigation ?? false,
        annotationCommandKeptArtifactMounted: details.annotationCommandKeptArtifactMounted ?? false,
        annotationViewReadyTimedOut: details.annotationViewReadyTimedOut ?? false,
        annotationPartialSuccess: details.annotationPartialSuccess ?? false,
        sessionLeaveGuardSuppressedForAnnotation: details.sessionLeaveGuardSuppressedForAnnotation ?? false,
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
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
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
    const annotationStateChanged = coreviewAnnotationStateChanged(result)
    const annotationFallbackResult = annotationFallbackResultFromCoreview(result)
    const capabilitySummary = result.capability_summary ?? null
    const annotationCommandKeptArtifactMounted = Boolean(
      result.action === "add_annotation"
      && isVisible
      && builderStageActive
      && builderVoiceCommandTargetRef.current,
    )

    if (result.action === "add_annotation" && annotationStateChanged) {
      onAnnotationActionSucceeded?.({
        annotationCount: result.annotation_count,
        highlightCount: result.highlight_count,
        commentCount: result.comment_count,
        underlineCount: result.underline_count,
        arrowCount: result.arrow_count,
        drawPathCount: result.draw_path_count,
      })
    }

    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "coreview-tool-call",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        coreviewToolCallCount: 1,
        coreviewToolCompletedCount: 1,
        coreviewToolName: coreviewToolNameFromAction(result.action),
        coreviewToolResult: result.ok ? "success" : "blocked",
        coreviewToolLastResult: result.ok ? "success" : "blocked",
        coreviewToolBlockedReason: result.blocked_reason,
        coreviewToolCommandSource: result.command_source,
        coreviewToolPreservedMic: result.preserved_mic,
        coreviewToolPreservedReview: result.preserved_review,
        coreviewToolRefreshAttempted: result.refresh_attempted,
        coreviewToolRefreshResult: result.refresh_result,
        coreviewToolVisualFreshAfterResult: result.visual_fresh ?? result.visual_frame_fresh ?? false,
        coreviewToolViewReadyWaitMs: result.view_ready_wait_ms,
        coreviewToolViewSignatureBefore: result.view_signature_before,
        coreviewToolViewSignatureAfter: result.view_signature_after,
        coreviewWorkspaceContractVersion: result.coreview_workspace_contract_version ?? null,
        artifactCapabilityRendererKind: capabilitySummary?.rendererKind ?? result.renderer_kind,
        artifactCapabilityRenderMode: capabilitySummary?.renderMode ?? null,
        artifactCapabilitySupportsPages: capabilitySummary?.supportsPages ?? null,
        artifactCapabilitySupportsAnnotations: capabilitySummary?.supportsAnnotations ?? null,
        artifactCapabilitySupportsTextExtraction: capabilitySummary?.supportsTextExtraction ?? null,
        artifactCapabilitySupportsLayoutAnchors: capabilitySummary?.supportsLayoutAnchors ?? null,
        artifactCapabilitySupportsOCR: capabilitySummary?.supportsOCR ?? null,
        artifactCapabilityRequiresOCR: capabilitySummary?.requiresOCR ?? null,
        artifactCapabilitySupportsPptxNativeRender: capabilitySummary?.supportsPptxNativeRender ?? null,
        artifactCapabilitySupportsAnnotatedExport: capabilitySummary?.supportsAnnotatedExport ?? null,
        artifactCapabilityFallbackReason: capabilitySummary?.fallbackReason ?? null,
        coreviewAnnotationToolCount: result.action === "add_annotation" ? 1 : 0,
        coreviewAnnotationToolResult: result.action === "add_annotation" ? annotationFallbackResult : null,
        coreviewAnnotationFallbackCount: result.action === "add_annotation" && result.command_source === "frontend_fallback" ? 1 : 0,
        coreviewAnnotationCommandSource: result.action === "add_annotation" ? result.command_source : null,
        coreviewAnnotationFallbackResult: result.action === "add_annotation" && result.command_source === "frontend_fallback" ? annotationFallbackResult : null,
        coreviewAnnotationKind: result.annotation_kind ?? null,
        coreviewAnnotationAnchorType: result.annotation_anchor_type ?? null,
        coreviewAnnotationColor: result.annotation_color ?? null,
        coreviewAnnotationPageIndex: result.annotation_page_index ?? null,
        coreviewAnnotationBlockedReason: result.action === "add_annotation" ? result.blocked_reason : null,
        annotationIntentDetectedCount: result.action === "add_annotation" ? 1 : 0,
        annotationIntentSource: result.action === "add_annotation" ? "coreview_tool_result" : null,
        annotationFallbackAttempted: result.action === "add_annotation" && result.command_source === "frontend_fallback",
        annotationFallbackResult: result.action === "add_annotation" && result.command_source === "frontend_fallback"
          ? annotationFallbackResult
          : null,
        annotationFallbackBlockedReason: result.action === "add_annotation" && result.command_source === "frontend_fallback"
          ? result.blocked_reason
          : null,
        recentAnnotationActionSucceeded: annotationStateChanged,
        annotationCommitAttempted: result.annotation_commit_attempted ?? false,
        annotationCommitResult: result.annotation_commit_result ?? null,
        annotationCommitCountBefore: result.annotation_commit_count_before ?? null,
        annotationCommitCountAfter: result.annotation_commit_count_after ?? null,
        annotationCommitVerified: result.annotation_commit_verified ?? false,
        annotationCommandPreventedNavigation: result.action === "add_annotation",
        annotationCommandKeptArtifactMounted,
        annotationViewReadyTimedOut: result.annotation_view_ready_timed_out ?? false,
        annotationPartialSuccess: result.annotation_partial_success ?? false,
        sessionLeaveGuardSuppressedForAnnotation: result.action === "add_annotation",
        coreviewFocusAnchorCount: result.action === "focus_anchor" ? 1 : 0,
        coreviewFocusAnchorResult: result.action === "focus_anchor" ? (result.ok ? "success" : "blocked") : null,
        coreviewFocusAnchorType: result.focus_anchor_type ?? null,
        annotationOverlayCaptured: result.annotation_overlay_captured ?? null,
        annotationCount: result.annotation_count ?? null,
        highlightCount: result.highlight_count ?? null,
        commentCount: result.comment_count ?? null,
        underlineCount: result.underline_count ?? null,
        arrowCount: result.arrow_count ?? null,
        drawPathCount: result.draw_path_count ?? null,
        unsupportedAnnotationKind: result.unsupported_annotation_kind ?? null,
        annotationActionSource: result.annotation_action_source ?? null,
        artifactStableIdentity: result.artifact_stable_identity ?? artifactStableIdentity,
        artifactRebindAttempted: result.rebind_attempted,
        artifactRebindResult: result.rebind_result,
        artifactRebindReason: result.rebind_reason,
        artifactRebindSource: result.rebind_attempted ? "coreview_tool" : null,
        artifactReboundFromRenderedState: result.rebind_attempted && isVisible,
        coreviewSetViewPageIndex: result.action === "set_view" ? result.page_index : null,
        coreviewSetViewPageCount: result.action === "set_view" ? result.page_count : null,
        artifactId: result.artifact_id,
        artifactPath: result.artifact_path,
        artifactRendererKind: result.renderer_kind,
        artifactCurrentPageIndex: result.page_index,
        artifactCurrentPageCount: result.page_count,
        rawTranscriptExcluded: true,
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [artifactStableIdentity, builderStageActive, isVisible, normalSessionId, onAnnotationActionSucceeded, sessionId, threadId])

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

    if (result.action === "add_annotation") {
      if (result.annotation_partial_success && result.blocked_reason === "view_ready_timeout") {
        setVoiceCommandStatus({
          text: result.annotation_kind === "comment"
            ? "Comment added; refresh timed out"
            : "Highlight added; refresh timed out",
          tone: "warn",
        })
        return
      }
      setVoiceCommandStatus({
        text: result.annotation_kind === "comment"
          ? "Sophia added a comment"
          : "Sophia added a highlight",
        tone: "success",
      })
      return
    }

    if (result.action === "focus_anchor") {
      setVoiceCommandStatus({
        text: result.focus_anchor_type === "current_title"
          ? "Sophia focused the title"
          : "Sophia focused the anchor",
        tone: "success",
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
    resolveAnnotationAnchor: (input) => {
      const target = builderVoiceCommandTargetRef.current
      return target
        ? target.resolveAnchor(input)
        : { ok: false, blockedReason: "annotation_target_unavailable" }
    },
    addAnnotation: (input) => {
      const target = builderVoiceCommandTargetRef.current
      if (!target) {
        return {
          ok: false,
          annotationId: null,
          blockedReason: "annotation_target_unavailable",
          annotationCount: 0,
          highlightCount: 0,
          commentCount: 0,
          underlineCount: 0,
          arrowCount: 0,
          drawPathCount: 0,
        }
      }

      const result = target.addAnnotation(input)
      coreviewCurrentViewRef.current = {
        ...(coreviewCurrentViewRef.current ?? coreviewCurrentView),
        annotationOverlayCaptured: result.annotationCount > 0,
        annotationCount: result.annotationCount,
        highlightCount: result.highlightCount,
        commentCount: result.commentCount,
        underlineCount: result.underlineCount,
        arrowCount: result.arrowCount,
        drawPathCount: result.drawPathCount,
      }
      coreviewVisualReadyRef.current = false
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
      return result
    },
    focusAnnotationAnchor: (input) => {
      const target = builderVoiceCommandTargetRef.current
      if (target) {
        setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
      }
      return target
        ? target.focusAnchor(input)
        : { ok: false, blockedReason: "annotation_target_unavailable" }
    },
    rebindVisibleArtifact: (input: CoreviewArtifactRebindInput): CoreviewArtifactRebindResult => {
      const current = coreviewCurrentViewRef.current ?? coreviewCurrentView
      if (!isVisible || !builderStageActive || !builderArtifactId) {
        return {
          ok: false,
          status: "failed",
          reason: "no_selected_artifact",
          currentView: {
            ...current,
            rebindStatus: "failed",
          },
        }
      }

      if (input.requestedArtifactId && input.requestedArtifactId !== builderArtifactId) {
        void recordSelectedStageArtifactTelemetry({
          rebindAttempted: true,
          rebindSource: input.source,
          rebindReason: "artifact_not_available_in_current_session",
          requestedArtifactId: input.requestedArtifactId,
        })
        return {
          ok: false,
          status: "failed",
          reason: "artifact_not_available_in_current_session",
          currentView: {
            ...current,
            rebindStatus: "failed",
          },
        }
      }

      const rebound = recordSelectedStageArtifactTelemetry({
        rebindAttempted: true,
        rebindSource: input.source,
        rebindReason: input.reason,
        requestedArtifactId: input.requestedArtifactId ?? null,
      })
      const nextCurrent = {
        ...(coreviewCurrentViewRef.current ?? coreviewCurrentView),
        rebindStatus: rebound ? "success" : "failed",
      } satisfies CoreviewCurrentView

      return {
        ok: rebound,
        status: rebound ? "success" : "failed",
        reason: rebound ? input.reason : "artifact_rebind_failed",
        currentView: nextCurrent,
      }
    },
  }), [
    builderArtifactCoReview,
    builderArtifactId,
    builderStageActive,
    coreviewCurrentView,
    isVisible,
    recordSelectedStageArtifactTelemetry,
    waitForCoreviewViewReady,
  ])

  const coreviewActionBus = useMemo<CoreviewActionBus>(() => (
    createCoreviewActionBus(coreviewAdapter)
  ), [coreviewAdapter])

  const runCoreviewAction = useCallback(async (
    runner: (bus: CoreviewActionBus) => Promise<CoreviewActionResult> | CoreviewActionResult,
    options?: { applyStatus?: boolean },
  ): Promise<CoreviewActionResult> => {
    pendingWorkspaceViewActorRef.current = sophiaWorkspaceActor
    const result = await runner(coreviewActionBus)
    if (result.ok && result.action === "focus_anchor" && result.focus_anchor_type) {
      lastCoreviewFocusedAnchorTypeRef.current = result.focus_anchor_type
    } else if (result.ok && result.action === "add_annotation" && result.annotation_anchor_type) {
      lastCoreviewFocusedAnchorTypeRef.current = result.annotation_anchor_type
    }
    if (options?.applyStatus !== false) {
      applyCoreviewActionStatus(result)
    }
    recordCoreviewToolTelemetry(result)
    if (pendingWorkspaceViewActorRef.current === sophiaWorkspaceActor) {
      pendingWorkspaceViewActorRef.current = null
    }
    return result
  }, [applyCoreviewActionStatus, coreviewActionBus, recordCoreviewToolTelemetry, sophiaWorkspaceActor])

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

    const commands = parseArtifactReviewVoiceCommands(transcript)
    const command = commands[0] ?? parseArtifactReviewVoiceCommand(transcript)
    if (!command) {
      return { handled: false }
    }

    const startedAtMs = Date.now()
    const annotationOrFocusCommands = commands.filter(isAnnotationOrFocusVoiceCommand)
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

    if (annotationOrFocusCommands.length > 0) {
      const allNativeCommandsAlreadyHandled = annotationOrFocusCommands.every((candidate) => (
        candidate.kind === "add_annotation"
          ? coreviewAnnotationCommandAlreadyHandled(candidate, startedAtMs - 2200)
          : coreviewFocusCommandAlreadyHandled(startedAtMs - 2200)
      ))

      if (nativeToolsPrimary && allNativeCommandsAlreadyHandled) {
        return {
          handled: true,
          command,
          applied: true,
          blockedReason: null,
          triggeredRefresh: false,
          refreshResult: "not_requested",
          userMessage: null,
          suppressAssistant: false,
        }
      }

      if (!builderArtifactId || !currentView.artifactId) {
        setVoiceCommandStatus({
          text: "No artifact is selected.",
          tone: "warn",
        })
        recordReviewVoiceCommandTelemetry({
          command,
          commands,
          applied: false,
          blockedReason: "no_artifact_selected",
          triggeredRefresh: false,
          refreshResult: "not_requested",
          artifactCurrentPageIndex: currentPageIndex,
          artifactCurrentPageCount: currentPageCount,
          autoRefreshBlockedReason: "no_artifact_selected",
          transportStateBefore,
          transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
          annotationFallbackAttempted: command.kind === "add_annotation",
          annotationFallbackResult: command.kind === "add_annotation" ? "blocked" : null,
          annotationFallbackBlockedReason: command.kind === "add_annotation" ? "no_artifact_selected" : null,
          recentAnnotationActionSucceeded: false,
          annotationCommitAttempted: false,
          annotationCommitResult: command.kind === "add_annotation" ? "no_selected_artifact" : null,
          annotationCommitCountBefore: command.kind === "add_annotation" ? 0 : null,
          annotationCommitCountAfter: command.kind === "add_annotation" ? 0 : null,
          annotationCommitVerified: false,
          annotationCommandPreventedNavigation: command.kind === "add_annotation",
          annotationCommandKeptArtifactMounted: false,
          annotationViewReadyTimedOut: false,
          annotationPartialSuccess: false,
          sessionLeaveGuardSuppressedForAnnotation: command.kind === "add_annotation",
        })
        return {
          handled: true,
          command,
          applied: false,
          blockedReason: "no_artifact_selected",
          triggeredRefresh: false,
          refreshResult: "not_requested",
          userMessage: null,
          suppressAssistant: true,
          assistantAnnotationClaimSuppressed: true,
        }
      }

      setVoiceCommandStatus({
        text: nativeToolsPrimary ? "Annotation request queued" : buildAppliedVoiceCommandStatus(command, currentPageIndex),
        tone: nativeToolsPrimary ? "pending" : "neutral",
      })

      const executeFallbackCommands = async () => {
        for (const nextCommand of commands) {
          if (
            nativeToolsPrimary
            && nextCommand.kind === "add_annotation"
            && coreviewAnnotationCommandAlreadyHandled(nextCommand, startedAtMs)
          ) {
            continue
          }
          if (
            nativeToolsPrimary
            && nextCommand.kind === "focus_anchor"
            && coreviewFocusCommandAlreadyHandled(startedAtMs)
          ) {
            continue
          }

          const commandView = coreviewCurrentViewRef.current ?? currentView
          const result = await runCoreviewAction((bus) => {
            if (nextCommand.kind === "refresh_view") {
              return bus.refreshView({ reason: "voice command fallback" }, "frontend_fallback")
            }
            if (nextCommand.kind === "add_annotation") {
              return bus.addAnnotation(
                coreviewAddAnnotationInputFromVoiceCommand(
                  nextCommand,
                  commandView,
                  lastCoreviewFocusedAnchorTypeRef.current,
                ),
                "frontend_fallback",
              )
            }
            if (nextCommand.kind === "focus_anchor") {
              return bus.focusAnchor(
                coreviewFocusAnchorInputFromVoiceCommand(
                  nextCommand,
                  commandView,
                  lastCoreviewFocusedAnchorTypeRef.current,
                ),
                "frontend_fallback",
              )
            }
            return bus.setView(coreviewSetViewInputFromVoiceCommand(nextCommand, commandView), "frontend_fallback")
          })
          const annotationStateChanged = coreviewAnnotationStateChanged(result)
          const annotationFallbackResult = annotationFallbackResultFromCoreview(result)
          const annotationCommand = nextCommand.kind === "add_annotation"
          const annotationCommandKeptArtifactMounted = Boolean(
            annotationCommand
            && isVisible
            && builderStageActive
            && builderVoiceCommandTargetRef.current,
          )

          recordReviewVoiceCommandTelemetry({
            command: nextCommand,
            commands,
            applied: annotationCommand
              ? annotationStateChanged
              : (
                  result.ok
                  || routeBlockedReasonFromCoreview(result.blocked_reason) === null
                  || result.blocked_reason === "refresh_unavailable"
                  || result.blocked_reason === "review_not_active"
                ),
            blockedReason: result.ok ? null : routeBlockedReasonFromCoreview(result.blocked_reason),
            triggeredRefresh: result.refresh_attempted,
            refreshResult: result.refresh_attempted
              ? refreshResultFromCoreview(result.refresh_result)
              : "not_requested",
            artifactCurrentPageIndex: result.page_index ?? commandView.pageIndex,
            artifactCurrentPageCount: result.page_count ?? Math.max(1, commandView.pageCount),
            staleAfterPageChange: result.stale,
            waitedForViewReady: result.view_ready_wait_ms !== null,
            autoRefreshTiming: result.view_ready_wait_ms !== null
              ? `after_view_ready:${result.view_ready_wait_ms}ms`
              : null,
            autoRefreshBlockedReason: result.blocked_reason,
            transportStateBefore,
            transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
            annotationFallbackAttempted: annotationCommand,
            annotationFallbackResult: annotationCommand ? annotationFallbackResult : null,
            annotationFallbackBlockedReason: annotationCommand ? result.blocked_reason : null,
            recentAnnotationActionSucceeded: annotationStateChanged,
            annotationCommitAttempted: annotationCommand ? result.annotation_commit_attempted : false,
            annotationCommitResult: annotationCommand ? result.annotation_commit_result : null,
            annotationCommitCountBefore: annotationCommand ? result.annotation_commit_count_before : null,
            annotationCommitCountAfter: annotationCommand ? result.annotation_commit_count_after : null,
            annotationCommitVerified: annotationCommand ? result.annotation_commit_verified : false,
            annotationCommandPreventedNavigation: annotationCommand,
            annotationCommandKeptArtifactMounted,
            annotationViewReadyTimedOut: annotationCommand ? result.annotation_view_ready_timed_out : false,
            annotationPartialSuccess: annotationCommand ? result.annotation_partial_success : false,
            sessionLeaveGuardSuppressedForAnnotation: annotationCommand,
          })
        }
      }

      window.setTimeout(() => {
        void executeFallbackCommands().catch(() => {
          recordReviewVoiceCommandTelemetry({
            command,
            commands,
            applied: false,
            blockedReason: "visual_refresh_unavailable",
            triggeredRefresh: false,
            refreshResult: "error",
            artifactCurrentPageIndex: currentPageIndex,
            artifactCurrentPageCount: currentPageCount,
            staleAfterPageChange: false,
            waitedForViewReady: false,
            autoRefreshTiming: nativeToolsPrimary ? "delayed_native_tool_fallback" : "queued",
            autoRefreshBlockedReason: "refresh_exception",
            transportStateBefore,
            transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
            annotationFallbackAttempted: command.kind === "add_annotation",
            annotationFallbackResult: command.kind === "add_annotation" ? "blocked" : null,
            annotationFallbackBlockedReason: command.kind === "add_annotation" ? "refresh_exception" : null,
            recentAnnotationActionSucceeded: false,
            annotationCommitAttempted: command.kind === "add_annotation",
            annotationCommitResult: command.kind === "add_annotation" ? "annotation_commit_failed" : null,
            annotationCommitCountBefore: command.kind === "add_annotation" ? currentView.annotationCount : null,
            annotationCommitCountAfter: command.kind === "add_annotation" ? currentView.annotationCount : null,
            annotationCommitVerified: false,
            annotationCommandPreventedNavigation: command.kind === "add_annotation",
            annotationCommandKeptArtifactMounted: Boolean(
              command.kind === "add_annotation"
              && isVisible
              && builderStageActive
              && builderVoiceCommandTargetRef.current,
            ),
            annotationViewReadyTimedOut: false,
            annotationPartialSuccess: false,
            sessionLeaveGuardSuppressedForAnnotation: command.kind === "add_annotation",
          })
        })
      }, nativeToolsPrimary ? 120 : 0)

      return {
        handled: true,
        command,
        applied: true,
        blockedReason: null,
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: null,
        suppressAssistant: true,
        assistantAnnotationClaimSuppressed: false,
      }
    }

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
          suppressAssistant: true,
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
        commands,
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
      if (requestedPage && (!currentView.capabilities.supportsPages || currentPageCount <= 1)) {
        blockedReason = "pages_not_supported"
      } else if (requestedPage && (nextPageIndex < 0 || nextPageIndex >= currentPageCount)) {
        blockedReason = "requested_page_out_of_bounds"
      } else if (requestedZoom && !currentView.capabilities.supportsZoom) {
        blockedReason = "zoom_not_supported"
      }
    }

    if (blockedReason) {
      setVoiceCommandStatus({
        text: buildBlockedVoiceCommandMessage(command, currentPageCount),
        tone: "warn",
      })
      recordReviewVoiceCommandTelemetry({
        command,
        commands,
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
          commands,
          applied: result.ok
            || routeBlockedReasonFromCoreview(result.blocked_reason) === null
            || result.blocked_reason === "refresh_unavailable"
            || result.blocked_reason === "review_not_active",
          blockedReason: result.ok
            ? null
            : result.action === "set_view" && result.blocked_reason
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
      stageArtifactPath ?? "",
      stageRendererKind,
      builderArtifactViewSignature ?? "",
      effectiveBuilderVisualCaptureStatus.ready ? "ready" : "not-ready",
      builderExactTextAvailable ? "exact" : "no-exact",
    ].join("|")

    if (selectedStageCaptureSignatureRef.current === signature) {
      return
    }
    selectedStageCaptureSignatureRef.current = signature

    recordSelectedStageArtifactTelemetry({
      rebindAttempted: false,
      rebindSource: "artifact_stage_mount",
      rebindReason: null,
    })
  }, [
    builderArtifactId,
    builderArtifactViewSignature,
    builderExactTextAvailable,
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
    recordSelectedStageArtifactTelemetry,
    sessionId,
    stageBuilderArtifact,
    stageArtifactPath,
    stageRendererKind,
    threadId,
  ])

  useEffect(() => {
    if (!isVisible || !stageBuilderArtifact || !builderArtifactId || !voiceAgentSessionId) {
      return
    }

    const signature = [
      "voice_connect",
      voiceAgentSessionId,
      threadId ?? "",
      builderArtifactId,
      stageArtifactPath ?? "",
      stageRendererKind,
      builderArtifactViewSignature ?? "",
      effectiveBuilderVisualCaptureStatus.ready ? "ready" : "not-ready",
      builderExactTextAvailable ? "exact" : "no-exact",
    ].join("|")

    if (selectedStageRebindSignatureRef.current === signature) {
      return
    }
    selectedStageRebindSignatureRef.current = signature

    recordSelectedStageArtifactTelemetry({
      rebindAttempted: true,
      rebindSource: "voice_connect",
      rebindReason: "voice_connect_visible_artifact",
    })
  }, [
    builderArtifactId,
    builderArtifactViewSignature,
    builderExactTextAvailable,
    effectiveBuilderVisualCaptureStatus.ready,
    isVisible,
    recordSelectedStageArtifactTelemetry,
    stageArtifactPath,
    stageBuilderArtifact,
    stageRendererKind,
    threadId,
    voiceAgentSessionId,
  ])

  useEffect(() => {
    if (
      !isVisible
      || !stageBuilderArtifact
      || !builderArtifactId
      || (builderReviewStateName !== "co_review_starting" && builderReviewStateName !== "co_review_live")
    ) {
      return
    }

    const signature = [
      "review_start",
      sessionId ?? "",
      normalSessionId ?? "",
      voiceAgentSessionId ?? "",
      threadId ?? "",
      builderArtifactId,
      stageArtifactPath ?? "",
      stageRendererKind,
      builderArtifactViewSignature ?? "",
    ].join("|")

    if (selectedStageRebindSignatureRef.current === signature) {
      return
    }
    selectedStageRebindSignatureRef.current = signature

    recordSelectedStageArtifactTelemetry({
      rebindAttempted: true,
      rebindSource: "review_start",
      rebindReason: "review_start_visible_artifact",
    })
  }, [
    builderArtifactId,
    builderArtifactViewSignature,
    builderReviewStateName,
    isVisible,
    normalSessionId,
    recordSelectedStageArtifactTelemetry,
    sessionId,
    stageArtifactPath,
    stageBuilderArtifact,
    stageRendererKind,
    threadId,
    voiceAgentSessionId,
  ])

  // Phase lifecycle
  useEffect(() => {
    if (isVisible && stageBuilderArtifact) {
      const sameVisibleBuilderStage = builderStageVisibilitySignatureRef.current === builderStageVisibilitySignature
      builderStageVisibilitySignatureRef.current = builderStageVisibilitySignature
      setPhase("visible")
      setRevealStep(4)
      setReflectionTapped(false)
      if (sameVisibleBuilderStage) {
        recordSophiaCaptureEvent({
          category: "builder-ui",
          name: "artifact-stage-unmount-prevented",
          payload: {
            artifactStageUnmountPrevented: true,
            artifactStageProtectedFromSnapshot: true,
            builderSnapshotIgnoredForActiveArtifact: true,
            artifactRendererKind: stageRendererKind,
            selectedBuilderArtifactPathPresent: Boolean(normalizedSelectedBuilderArtifactPath),
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        })
      }
      return
    }

    if (isVisible && (artifacts || stageBuilderArtifact || hasBuilderLibrary)) {
      builderStageVisibilitySignatureRef.current = null
      setPhase("entering")
      setRevealStep(0)
      setReflectionTapped(false)
      requestAnimationFrame(() => setPhase("visible"))
    } else if (phase !== "hidden") {
      builderStageVisibilitySignatureRef.current = null
      setPhase("exiting")
      const t = setTimeout(() => setPhase("hidden"), 800)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    artifacts,
    builderStageVisibilitySignature,
    hasBuilderLibrary,
    isVisible,
    normalizedSelectedBuilderArtifactPath,
    stageBuilderArtifact,
    stageRendererKind,
  ])

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

        <PresenceArtifactPanelBuilderSurfaces
          artifacts={artifacts}
          builderArtifactLibrary={builderArtifactLibrary}
          stageBuilderArtifact={stageBuilderArtifact}
          hasBuilder={hasBuilder}
          builderArtifactId={builderArtifactId}
          stageUsesMarkdownPreview={stageUsesMarkdownPreview}
          stageUsesPdfPreview={stageUsesPdfPreview}
          isTextModeBuilderStage={isTextModeBuilderStage}
          isVoiceMode={isVoiceMode}
          revealStep={revealStep}
          voiceAgentSessionId={voiceAgentSessionId}
          artifactStableIdentity={artifactStableIdentity}
          coreviewAnnotationList={coreviewAnnotationList}
          coreviewAnnotationTelemetry={coreviewAnnotationTelemetry}
          addCoreviewAnnotation={addCoreviewAnnotation}
          updateCoreviewAnnotation={updateCoreviewAnnotation}
          deleteCoreviewAnnotation={deleteCoreviewAnnotation}
          builderArtifactCoReview={builderArtifactCoReview}
          builderExactTextAvailable={builderExactTextAvailable}
          visualReviewPreparing={visualReviewPreparing}
          visualReviewRequiresVoice={visualReviewRequiresVoice}
          pendingBuilderArtifactReview={pendingBuilderArtifactReview}
          builderVisualCaptureStatus={builderVisualCaptureStatus}
          voiceCommandViewPending={voiceCommandViewPending}
          builderReviewStale={builderReviewStale}
          voiceCommandStatusText={voiceCommandStatus?.text ?? null}
          voiceCommandStatusTone={voiceCommandStatus?.tone}
          setBuilderVisualCaptureStatus={setBuilderVisualCaptureStatus}
          handleReportedBuilderArtifactViewStateChange={handleReportedBuilderArtifactViewStateChange}
          handleBuilderVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
          handleWorkspaceToolModeChange={handleWorkspaceToolModeChange}
          handleWorkspaceExportRequested={handleWorkspaceExportRequested}
          onStartVoiceBuilderArtifactReview={onStartVoiceBuilderArtifactReview}
          showSecondaryArtifactSurfaces={showSecondaryArtifactSurfaces}
          showDomArtifactCoReview={showDomArtifactCoReview}
          threadId={threadId}
          sessionId={sessionId}
          normalSessionId={normalSessionId}
          isActive={isActive}
          bloomColor={bloomColor}
          reflectionTapped={reflectionTapped}
          domArtifactCoReview={domArtifactCoReview}
          onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
          onHandleReflectionTap={handleReflectionTap}
          onReflectionTap={onReflectionTap}
          onMemoryApprove={onMemoryApprove}
          onMemoryReject={onMemoryReject}
          onBuilderArtifactRootChange={setBuilderArtifactRoot}
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
