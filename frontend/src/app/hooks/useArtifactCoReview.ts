"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  buildArtifactViewSignature,
  safeArtifactViewTelemetry,
  type ArtifactViewState,
} from "../lib/artifact-renderers"
import { resolveArtifactVisualSource } from "../lib/co-review-capture"
import { coreviewFlagDiagnostics, isCoreviewStillFrameReviewEnabled } from "../lib/co-review-flags"
import {
  AudioWebSocketUnsupportedTransport,
  CoReviewSessionMachine,
  initialCoReviewState,
  safeCoReviewTelemetryFromState,
  type CoReviewMediaTransport,
  type CoReviewSessionState,
} from "../lib/co-review-transport"
import { recordSophiaCaptureEvent } from "../lib/session-capture"

export interface UseArtifactCoReviewOptions {
  sessionId: string | null
  threadId: string | null
  normalSessionId?: string | null
  artifactId: string | null
  artifactRoot?: ParentNode | null
  exactTextAvailable?: boolean
  featureEnabled?: boolean
  transport?: CoReviewMediaTransport
  missingCanvasReason?: string
  visualSourceReady?: boolean
  visualSourceUnavailableReason?: string | null
  artifactViewState?: ArtifactViewState | null
}

export function useArtifactCoReview({
  sessionId,
  threadId,
  normalSessionId = null,
  artifactId,
  artifactRoot = null,
  exactTextAvailable = false,
  featureEnabled = isCoreviewStillFrameReviewEnabled(),
  transport,
  missingCanvasReason,
  visualSourceReady = true,
  visualSourceUnavailableReason = null,
  artifactViewState = null,
}: UseArtifactCoReviewOptions) {
  const transportRef = useRef<CoReviewMediaTransport>(transport ?? new AudioWebSocketUnsupportedTransport())
  const [state, setState] = useState<CoReviewSessionState>(() => initialCoReviewState(transportRef.current.kind))
  const [lastFrameViewSignature, setLastFrameViewSignature] = useState<string | null>(null)
  const machineRef = useRef<CoReviewSessionMachine | null>(null)
  const currentViewSignature = buildArtifactViewSignature(artifactViewState)
  const currentViewSignatureRef = useRef<string | null>(currentViewSignature)

  if (!machineRef.current) {
    machineRef.current = new CoReviewSessionMachine({
      transport: transportRef.current,
      onStateChange: setState,
    })
  }

  useEffect(() => {
    currentViewSignatureRef.current = currentViewSignature
  }, [currentViewSignature])

  const transportStatus = machineRef.current.status()
  const frameConfirmed = hasConfirmedStillFrameForReviewState(state, transportStatus)
  const reviewStaleReason = frameConfirmed
    && lastFrameViewSignature
    && currentViewSignature
    && lastFrameViewSignature !== currentViewSignature
    ? "view_changed"
    : null
  const reviewStale = Boolean(reviewStaleReason)
  const artifactViewTelemetry = useMemo(() => (
    safeArtifactViewTelemetry(artifactViewState, lastFrameViewSignature, reviewStaleReason)
  ), [artifactViewState, lastFrameViewSignature, reviewStaleReason])

  const startReview = useCallback(async () => {
    const flagDiagnostics = coreviewFlagDiagnostics()
    const reviewStartBlockedReason = reviewStartBlockedReasonFromContext({
      featureEnabled,
      sessionId,
      threadId,
      artifactId,
      visualSourceReady,
      visualSourceUnavailableReason,
    })

    logCoreviewBreadcrumb("coReviewStartClicked", {
      artifactId,
      hasSessionId: Boolean(sessionId),
      hasThreadId: Boolean(threadId),
      transportKind: transportRef.current.kind,
      requestedMode: "still_frame",
      reviewStartBlockedReason,
      ...flagDiagnostics,
    })

    if (!featureEnabled || !sessionId || !threadId || !artifactId) {
      logCoreviewBreadcrumb("coReviewStartError", {
        reason: reviewStartBlockedReason ?? "missing_required_start_context",
        featureEnabled,
        hasSessionId: Boolean(sessionId),
        hasThreadId: Boolean(threadId),
        hasArtifactId: Boolean(artifactId),
        reviewStartBlockedReason,
        ...flagDiagnostics,
      })
      recordCoreviewTelemetry("start", state, {
        featureEnabled,
        reviewStartBlockedReason: reviewStartBlockedReason ?? "missing_required_start_context",
        artifactViewTelemetry,
      })
      return state
    }

    if (!visualSourceReady) {
      logCoreviewBreadcrumb("coReviewStartError", {
        reason: reviewStartBlockedReason ?? visualSourceUnavailableReason ?? "capture_target_missing",
        featureEnabled,
        hasSessionId: Boolean(sessionId),
        hasThreadId: Boolean(threadId),
        hasArtifactId: Boolean(artifactId),
        reviewStartBlockedReason,
        ...flagDiagnostics,
      })
      recordCoreviewTelemetry("start", state, {
        featureEnabled,
        reviewStartBlockedReason: reviewStartBlockedReason ?? visualSourceUnavailableReason ?? "capture_target_missing",
        artifactViewTelemetry,
      })
      return state
    }

    const visualSource = resolveArtifactVisualSource({
      root: artifactRoot,
      artifactId,
      mode: "still_frame",
      missingCanvasReason: visualSourceUnavailableReason ?? missingCanvasReason,
    })

    logCoreviewBreadcrumb("canvasFound", {
      found: visualSource.status === "ready",
      artifactId,
      sourceKind: visualSource.kind,
      mode: "still_frame",
      reason: visualSource.reason,
    })

    const nextState = await machineRef.current.startCoReview({
      normalSessionId,
      sessionId,
      threadId,
      artifactId,
      visualSource,
      exactTextAvailable,
    })

    if (nextState.state === "co_review_error") {
      logCoreviewBreadcrumb("coReviewStartError", {
        error: nextState.error,
        visualInputStatus: nextState.visualInputStatus,
        toolAvailability: nextState.toolAvailability,
      })
    }
    if (hasConfirmedStillFrameForReviewState(nextState, machineRef.current.status())) {
      setLastFrameViewSignature(currentViewSignatureRef.current)
    }
    logCoreviewBreadcrumb("coReviewStateAfterStart", safeCoReviewTelemetryFromState(nextState))
    recordCoreviewTelemetry("start", nextState, {
      featureEnabled,
      reviewStartBlockedReason: nextState.state === "co_review_error" ? nextState.error : null,
      artifactViewTelemetry,
    })
    return nextState
  }, [artifactId, artifactRoot, artifactViewTelemetry, exactTextAvailable, featureEnabled, missingCanvasReason, normalSessionId, sessionId, state, threadId, visualSourceReady, visualSourceUnavailableReason])

  const stopReview = useCallback(async () => {
    const nextState = await machineRef.current.stopCoReview()
    recordCoreviewTelemetry("stop", nextState, { featureEnabled, artifactViewTelemetry })
    return nextState
  }, [artifactViewTelemetry, featureEnabled])

  const refreshReview = useCallback(async () => {
    logCoreviewBreadcrumb("coReviewRefreshClicked", {
      artifactId,
      hasSessionId: Boolean(sessionId),
      hasThreadId: Boolean(threadId),
      transportKind: transportRef.current.kind,
      websocketStateBeforeRefresh: transportRef.current.status().statusText,
    })

    if (!featureEnabled || !sessionId || !threadId || !artifactId || state.state !== "co_review_live" || !visualSourceReady) {
      logCoreviewBreadcrumb("coReviewRefreshError", {
        reason: "missing_required_refresh_context",
        featureEnabled,
        hasSessionId: Boolean(sessionId),
        hasThreadId: Boolean(threadId),
        hasArtifactId: Boolean(artifactId),
        currentState: state.state,
        visualSourceReady,
      })
      return state
    }

    const visualSource = resolveArtifactVisualSource({
      root: artifactRoot,
      artifactId,
      mode: "still_frame",
      missingCanvasReason: visualSourceUnavailableReason ?? missingCanvasReason,
    })

    logCoreviewBreadcrumb("coReviewRefreshCanvasFound", {
      found: visualSource.status === "ready",
      artifactId,
      sourceKind: visualSource.kind,
      mode: "still_frame",
      reason: visualSource.reason,
    })

    const nextState = await machineRef.current.refreshCoReview({
      artifactId,
      visualSource,
    })

    if (nextState.refreshFrameResult === "error" || nextState.state === "co_review_error") {
      logCoreviewBreadcrumb("coReviewRefreshError", {
        error: nextState.refreshErrorSafeReason ?? nextState.error,
        visualInputStatus: nextState.visualInputStatus,
        websocketStateBeforeRefresh: nextState.websocketStateBeforeRefresh,
        websocketStateAfterRefresh: nextState.websocketStateAfterRefresh,
        websocketClosedAfterRefresh: nextState.websocketClosedAfterRefresh,
      })
    }
    if (hasConfirmedStillFrameForReviewState(nextState, machineRef.current.status())) {
      setLastFrameViewSignature(currentViewSignatureRef.current)
    }
    logCoreviewBreadcrumb("coReviewStateAfterRefresh", safeCoReviewTelemetryFromState(nextState))
    recordCoreviewTelemetry("refresh", nextState, { featureEnabled, artifactViewTelemetry })
    return nextState
  }, [artifactId, artifactRoot, artifactViewTelemetry, featureEnabled, missingCanvasReason, sessionId, state, threadId, visualSourceReady, visualSourceUnavailableReason])

  const telemetry = useMemo(() => safeCoReviewTelemetryFromState(state), [state])
  const canStart = Boolean(
    featureEnabled
    && sessionId
    && threadId
    && artifactId
    && visualSourceReady
    && transportStatus.visualTransportSupported
    && transportStatus.stillFramesSupported,
  )
  const canRefresh = Boolean(
    featureEnabled
    && sessionId
    && threadId
    && artifactId
    && visualSourceReady
    && state.state === "co_review_live"
    && !state.refreshFrameInProgress
    && transportStatus.visualTransportSupported
    && transportStatus.stillFramesSupported,
  )

  useEffect(() => {
    if (
      state.state !== "co_review_live"
      || state.refreshFrameInProgress
      || transportStatus.visualTransportSupported
    ) {
      return
    }

    const error = transportStatus.statusText.includes(": ")
      ? transportStatus.statusText.split(": ").slice(1).join(": ")
      : "frame_send_closed_gemini_websocket"
    logCoreviewBreadcrumb("coReviewTransportClosedWhileLive", {
      error,
      transportKind: transportRef.current.kind,
      statusText: transportStatus.statusText,
    })
    void machineRef.current?.failCoReview(error || "frame_send_closed_gemini_websocket")
      .then((nextState) => recordCoreviewTelemetry("transport_closed", nextState, { featureEnabled, artifactViewTelemetry }))
  }, [artifactViewTelemetry, featureEnabled, state.refreshFrameInProgress, state.state, transportStatus.statusText, transportStatus.visualTransportSupported])

  return {
    enabled: featureEnabled,
    state,
    telemetry,
    transportStatus,
    canStart,
    canRefresh,
    reviewStale,
    reviewStaleReason,
    currentViewSignature,
    lastFrameViewSignature,
    startReview,
    stopReview,
    refreshReview,
  }
}

function logCoreviewBreadcrumb(event: string, details: Record<string, unknown> = {}) {
  if (typeof console === "undefined") return
  console.info?.(`[coreview] ${event}`, {
    ...details,
    rawFrameExcluded: true,
  })
}

function recordCoreviewTelemetry(
  action: "start" | "refresh" | "stop" | "transport_closed",
  state: CoReviewSessionState,
  details: {
    featureEnabled: boolean
    reviewStartBlockedReason?: string | null
    artifactViewTelemetry?: Record<string, string | number | null>
  },
) {
  const flagDiagnostics = coreviewFlagDiagnostics()
  recordSophiaCaptureEvent({
    category: "voice-session",
    name: "coreview-state",
    payload: {
      action,
      sessionId: state.sessionId,
      threadId: state.threadId,
      coreview: {
        coreviewEnabled: details.featureEnabled,
        ...flagDiagnostics,
        reviewStartBlockedReason: details.reviewStartBlockedReason ?? null,
        ...safeCoReviewTelemetryFromState(state),
        ...(details.artifactViewTelemetry ?? {}),
      },
    },
  })
}

function hasConfirmedStillFrameForReviewState(
  state: CoReviewSessionState,
  transportStatus: { visualTransportSupported: boolean; stillFramesSupported: boolean },
): boolean {
  return Boolean(
    state.state === "co_review_live"
      && state.visualInputStatus === "live"
      && state.videoOrFrameMode === "still_frame"
      && (state.frameSentCount ?? 0) > 0
      && transportStatus.stillFramesSupported !== false
      && transportStatus.visualTransportSupported !== false,
  )
}

function reviewStartBlockedReasonFromContext({
  featureEnabled,
  sessionId,
  threadId,
  artifactId,
  visualSourceReady,
  visualSourceUnavailableReason,
}: {
  featureEnabled: boolean
  sessionId: string | null
  threadId: string | null
  artifactId: string | null
  visualSourceReady: boolean
  visualSourceUnavailableReason: string | null
}): string | null {
  if (!sessionId) return "missing_session_id"
  if (!threadId) return "missing_thread_id"
  if (!artifactId) return "missing_artifact_id"
  if (!featureEnabled) return coreviewFlagDiagnostics().coreviewDisabledReason ?? "coreview_feature_disabled"
  if (!visualSourceReady) return visualSourceUnavailableReason ?? "capture_target_missing"
  return null
}
