"use client"

import { useCallback, useMemo, useRef, useState } from "react"

import { resolveArtifactVisualSource } from "../lib/co-review-capture"
import { isCoReviewEnabled } from "../lib/co-review-flags"
import {
  AudioWebSocketUnsupportedTransport,
  CoReviewSessionMachine,
  initialCoReviewState,
  safeCoReviewTelemetryFromState,
  type CoReviewMediaTransport,
  type CoReviewSessionState,
} from "../lib/co-review-transport"

export interface UseArtifactCoReviewOptions {
  sessionId: string | null
  threadId: string | null
  normalSessionId?: string | null
  artifactId: string | null
  artifactRoot?: ParentNode | null
  featureEnabled?: boolean
  transport?: CoReviewMediaTransport
}

export function useArtifactCoReview({
  sessionId,
  threadId,
  normalSessionId = null,
  artifactId,
  artifactRoot = null,
  featureEnabled = isCoReviewEnabled(),
  transport,
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
      requestedMode: transportRef.current.supportsStillFrames() ? "still_frame" : "stream",
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

    const requestedMode = transportRef.current.supportsStillFrames() ? "still_frame" : "stream"
    const visualSource = resolveArtifactVisualSource({
      root: artifactRoot,
      artifactId,
      mode: requestedMode,
    })

    logCoreviewBreadcrumb("canvasFound", {
      found: visualSource.status === "ready",
      artifactId,
      sourceKind: visualSource.kind,
      mode: requestedMode,
      reason: visualSource.reason,
    })

    const nextState = await machineRef.current.startCoReview({
      normalSessionId,
      sessionId,
      threadId,
      artifactId,
      visualSource,
    })

    if (nextState.state === "co_review_error") {
      logCoreviewBreadcrumb("coReviewStartError", {
        error: nextState.error,
        visualInputStatus: nextState.visualInputStatus,
        toolAvailability: nextState.toolAvailability,
      })
    }
    logCoreviewBreadcrumb("coReviewStateAfterStart", safeCoReviewTelemetryFromState(nextState))
    return nextState
  }, [artifactId, artifactRoot, featureEnabled, normalSessionId, sessionId, state, threadId])

  const stopReview = useCallback(async () => {
    return machineRef.current.stopCoReview()
  }, [])

  const telemetry = useMemo(() => safeCoReviewTelemetryFromState(state), [state])

  return {
    enabled: featureEnabled,
    state,
    telemetry,
    transportStatus: machineRef.current.status(),
    canStart: Boolean(featureEnabled && sessionId && threadId && artifactId),
    startReview,
    stopReview,
  }
}

function logCoreviewBreadcrumb(event: string, details: Record<string, unknown> = {}) {
  if (typeof console === "undefined") return
  console.info?.(`[coreview] ${event}`, {
    ...details,
    rawFrameExcluded: true,
  })
}
