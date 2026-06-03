"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { resolveArtifactVisualSource } from "../lib/co-review-capture"
import { isCoreviewStillFrameReviewEnabled } from "../lib/co-review-flags"
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
}: UseArtifactCoReviewOptions) {
  const transportRef = useRef<CoReviewMediaTransport>(transport ?? new AudioWebSocketUnsupportedTransport())
  const [state, setState] = useState<CoReviewSessionState>(() => initialCoReviewState(transportRef.current.kind))
  const machineRef = useRef<CoReviewSessionMachine | null>(null)

  if (!machineRef.current) {
    machineRef.current = new CoReviewSessionMachine({
      transport: transportRef.current,
      onStateChange: setState,
    })
  }

  const startReview = useCallback(async () => {
    logCoreviewBreadcrumb("coReviewStartClicked", {
      artifactId,
      hasSessionId: Boolean(sessionId),
      hasThreadId: Boolean(threadId),
      transportKind: transportRef.current.kind,
      requestedMode: "still_frame",
    })

    if (!featureEnabled || !sessionId || !threadId || !artifactId) {
      logCoreviewBreadcrumb("coReviewStartError", {
        reason: "missing_required_start_context",
        featureEnabled,
        hasSessionId: Boolean(sessionId),
        hasThreadId: Boolean(threadId),
        hasArtifactId: Boolean(artifactId),
      })
      return state
    }

    if (!visualSourceReady) {
      logCoreviewBreadcrumb("coReviewStartError", {
        reason: visualSourceUnavailableReason ?? "capture_target_missing",
        featureEnabled,
        hasSessionId: Boolean(sessionId),
        hasThreadId: Boolean(threadId),
        hasArtifactId: Boolean(artifactId),
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
    logCoreviewBreadcrumb("coReviewStateAfterStart", safeCoReviewTelemetryFromState(nextState))
    recordCoreviewTelemetry("start", nextState, { featureEnabled })
    return nextState
  }, [artifactId, artifactRoot, exactTextAvailable, featureEnabled, missingCanvasReason, normalSessionId, sessionId, state, threadId, visualSourceReady, visualSourceUnavailableReason])

  const stopReview = useCallback(async () => {
    const nextState = await machineRef.current.stopCoReview()
    recordCoreviewTelemetry("stop", nextState, { featureEnabled })
    return nextState
  }, [featureEnabled])

  const refreshReview = useCallback(async () => {
    logCoreviewBreadcrumb("coReviewRefreshClicked", {
      artifactId,
      hasSessionId: Boolean(sessionId),
      hasThreadId: Boolean(threadId),
      transportKind: transportRef.current.kind,
      websocketStateBeforeRefresh: transportRef.current.status().statusText,
    })

    if (!featureEnabled || !sessionId || !threadId || !artifactId || state.state !== "co_review_live") {
      logCoreviewBreadcrumb("coReviewRefreshError", {
        reason: "missing_required_refresh_context",
        featureEnabled,
        hasSessionId: Boolean(sessionId),
        hasThreadId: Boolean(threadId),
        hasArtifactId: Boolean(artifactId),
        currentState: state.state,
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
    logCoreviewBreadcrumb("coReviewStateAfterRefresh", safeCoReviewTelemetryFromState(nextState))
    recordCoreviewTelemetry("refresh", nextState, { featureEnabled })
    return nextState
  }, [artifactId, artifactRoot, featureEnabled, missingCanvasReason, sessionId, state, threadId, visualSourceUnavailableReason])

  const telemetry = useMemo(() => safeCoReviewTelemetryFromState(state), [state])
  const transportStatus = machineRef.current.status()
  const canStart = Boolean(
    featureEnabled
    && sessionId
    && threadId
    && artifactId
    && visualSourceReady
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
      .then((nextState) => recordCoreviewTelemetry("transport_closed", nextState, { featureEnabled }))
  }, [featureEnabled, state.refreshFrameInProgress, state.state, transportStatus.statusText, transportStatus.visualTransportSupported])

  return {
    enabled: featureEnabled,
    state,
    telemetry,
    transportStatus,
    canStart,
    canRefresh: false,
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
  details: { featureEnabled: boolean },
) {
  recordSophiaCaptureEvent({
    category: "voice-session",
    name: "coreview-state",
    payload: {
      action,
      sessionId: state.sessionId,
      threadId: state.threadId,
      coreview: {
        coreviewEnabled: details.featureEnabled,
        ...safeCoReviewTelemetryFromState(state),
      },
    },
  })
}
