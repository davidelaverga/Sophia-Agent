"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react"

import {
  buildArtifactViewSignature,
  safeArtifactViewTelemetry,
  type ArtifactViewState,
} from "../lib/artifact-renderers"
import { resolveArtifactVisualSource, type ArtifactVisualSource } from "../lib/co-review-capture"
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

const HTML_CAPTURE_TARGET_WAIT_TIMEOUT_MS = 1200
const HTML_CAPTURE_TARGET_RETRY_INTERVAL_MS = 80

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
  const lastTransportUnavailableTelemetryRef = useRef<string | null>(null)
  const latestCaptureContextRef = useRef({
    artifactId,
    artifactRoot,
    artifactViewState,
    exactTextAvailable,
    missingCanvasReason,
    visualSourceUnavailableReason,
    visualSourceReady,
  })

  if (!machineRef.current) {
    machineRef.current = new CoReviewSessionMachine({
      transport: transportRef.current,
      onStateChange: setState,
    })
  }

  useEffect(() => {
    currentViewSignatureRef.current = currentViewSignature
  }, [currentViewSignature])

  useEffect(() => {
    latestCaptureContextRef.current = {
      artifactId,
      artifactRoot,
      artifactViewState,
      exactTextAvailable,
      missingCanvasReason,
      visualSourceUnavailableReason,
      visualSourceReady,
    }
  }, [
    artifactId,
    artifactRoot,
    artifactViewState,
    exactTextAvailable,
    missingCanvasReason,
    visualSourceUnavailableReason,
    visualSourceReady,
  ])

  const transportStatus = machineRef.current.status()
  const frameConfirmed = hasConfirmedStillFrameForReviewState(state, transportStatus)
  const reviewStaleReason = frameConfirmed
    && visualSourceReady
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
    let reviewStartBlockedReason = reviewStartBlockedReasonFromContext({
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

    let visualSource: ArtifactVisualSource | null = null
    let htmlCaptureTargetTelemetry: Record<string, string | number | boolean | null> | null = null
    const shouldWaitForHtmlTarget = shouldWaitForHtmlCaptureTarget({
      artifactViewState,
      exactTextAvailable,
      visualSourceUnavailableReason,
    })

    if (!visualSourceReady) {
      if (shouldWaitForHtmlTarget) {
        const waitResult = await waitForHtmlCaptureTarget({
          latestContext: latestCaptureContextRef,
          initialArtifactId: artifactId,
          initialArtifactRoot: artifactRoot,
          initialMissingCanvasReason: visualSourceUnavailableReason ?? missingCanvasReason,
        })
        htmlCaptureTargetTelemetry = htmlCaptureTargetTelemetryFromWait(waitResult)
        if (waitResult.visualSource) {
          visualSource = waitResult.visualSource
          reviewStartBlockedReason = null
        } else {
          const finalReason = "capture_target_missing_final"
          logCoreviewBreadcrumb("coReviewStartError", {
            reason: finalReason,
            featureEnabled,
            hasSessionId: Boolean(sessionId),
            hasThreadId: Boolean(threadId),
            hasArtifactId: Boolean(artifactId),
            reviewStartBlockedReason: finalReason,
            ...flagDiagnostics,
          })
          recordCoreviewTelemetry("start", state, {
            featureEnabled,
            reviewStartBlockedReason: finalReason,
            artifactViewTelemetry,
            captureTargetTelemetry: htmlCaptureTargetTelemetry,
          })
          return state
        }
      } else {
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
    }

    if (!visualSource) {
      visualSource = resolveArtifactVisualSource({
        root: artifactRoot,
        artifactId,
        mode: "still_frame",
        missingCanvasReason: visualSourceUnavailableReason ?? missingCanvasReason,
      })
      if (visualSource.status !== "ready" && shouldWaitForHtmlTarget) {
        const waitResult = await waitForHtmlCaptureTarget({
          latestContext: latestCaptureContextRef,
          initialArtifactId: artifactId,
          initialArtifactRoot: artifactRoot,
          initialMissingCanvasReason: visualSource.reason ?? visualSourceUnavailableReason ?? missingCanvasReason,
        })
        htmlCaptureTargetTelemetry = htmlCaptureTargetTelemetryFromWait(waitResult)
        if (waitResult.visualSource) {
          visualSource = waitResult.visualSource
          reviewStartBlockedReason = null
        } else {
          const finalReason = "capture_target_missing_final"
          logCoreviewBreadcrumb("coReviewStartError", {
            reason: finalReason,
            featureEnabled,
            hasSessionId: Boolean(sessionId),
            hasThreadId: Boolean(threadId),
            hasArtifactId: Boolean(artifactId),
            reviewStartBlockedReason: finalReason,
            ...flagDiagnostics,
          })
          recordCoreviewTelemetry("start", state, {
            featureEnabled,
            reviewStartBlockedReason: finalReason,
            artifactViewTelemetry,
            captureTargetTelemetry: htmlCaptureTargetTelemetry,
          })
          return state
        }
      }
    }

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
      captureTargetTelemetry: htmlCaptureTargetTelemetry,
    })
    return nextState
  }, [artifactId, artifactRoot, artifactViewState, artifactViewTelemetry, exactTextAvailable, featureEnabled, missingCanvasReason, normalSessionId, sessionId, state, threadId, visualSourceReady, visualSourceUnavailableReason])

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
      lastTransportUnavailableTelemetryRef.current = null
      return
    }

    const error = transportStatus.statusText.includes(": ")
      ? transportStatus.statusText.split(": ").slice(1).join(": ")
      : "frame_send_closed_gemini_websocket"
    logCoreviewBreadcrumb("coReviewTransportClosedWhileLive", {
      error,
      transportKind: transportRef.current.kind,
      statusText: transportStatus.statusText,
      reviewPreserved: true,
    })
    const telemetryKey = `${state.sessionId ?? ""}:${state.artifactId ?? ""}:${error}`
    if (lastTransportUnavailableTelemetryRef.current !== telemetryKey) {
      lastTransportUnavailableTelemetryRef.current = telemetryKey
      recordCoreviewTelemetry("transport_unavailable", state, { featureEnabled, artifactViewTelemetry })
    }
  }, [artifactViewTelemetry, featureEnabled, state, transportStatus.statusText, transportStatus.visualTransportSupported])

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
  action: "start" | "refresh" | "stop" | "transport_closed" | "transport_unavailable",
  state: CoReviewSessionState,
  details: {
    featureEnabled: boolean
    reviewStartBlockedReason?: string | null
    artifactViewTelemetry?: Record<string, string | number | boolean | null>
    captureTargetTelemetry?: Record<string, string | number | boolean | null> | null
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
        ...(details.captureTargetTelemetry ?? {}),
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

type HtmlCaptureTargetWaitResult = {
  visualSource: ArtifactVisualSource | null
  result: "success" | "timeout"
  attempts: number
  latencyMs: number
  missingBeforeRetry: boolean
  retryAttempted: boolean
  finalReason: string | null
}

function shouldWaitForHtmlCaptureTarget({
  artifactViewState,
  exactTextAvailable,
  visualSourceUnavailableReason,
}: {
  artifactViewState: ArtifactViewState | null
  exactTextAvailable: boolean
  visualSourceUnavailableReason: string | null
}): boolean {
  return Boolean(
    artifactViewState?.rendererKind === "html"
      && exactTextAvailable
      && (
        !visualSourceUnavailableReason
        || visualSourceUnavailableReason === "preview_not_ready"
        || visualSourceUnavailableReason === "capture_target_missing"
        || visualSourceUnavailableReason === "artifact_canvas_not_found"
      ),
  )
}

async function waitForHtmlCaptureTarget({
  latestContext,
  initialArtifactId,
  initialArtifactRoot,
  initialMissingCanvasReason,
}: {
  latestContext: MutableRefObject<{
    artifactId: string | null
    artifactRoot: ParentNode | null
    artifactViewState: ArtifactViewState | null
    exactTextAvailable: boolean
    missingCanvasReason?: string
    visualSourceUnavailableReason: string | null
    visualSourceReady: boolean
  }>
  initialArtifactId: string
  initialArtifactRoot: ParentNode | null
  initialMissingCanvasReason?: string | null
}): Promise<HtmlCaptureTargetWaitResult> {
  const startedAt = nowMs()
  let attempts = 0
  recordHtmlCaptureTargetRetryEvent("capture_target_wait_started", {
    artifactId: initialArtifactId,
    result: "waiting_for_capture_target",
    attempts,
    latencyMs: 0,
    missingBeforeRetry: true,
    retryAttempted: true,
    finalReason: initialMissingCanvasReason ?? "capture_target_missing",
    sourceKind: null,
  })

  while (nowMs() - startedAt <= HTML_CAPTURE_TARGET_WAIT_TIMEOUT_MS) {
    attempts += 1
    const current = latestContext.current
    const artifactId = current.artifactId ?? initialArtifactId
    const root = current.artifactRoot ?? initialArtifactRoot
    const source = resolveArtifactVisualSource({
      root,
      artifactId,
      mode: "still_frame",
      missingCanvasReason: current.visualSourceUnavailableReason
        ?? current.missingCanvasReason
        ?? initialMissingCanvasReason
        ?? "capture_target_missing",
    })
    if (source.status === "ready") {
      const latencyMs = Math.max(0, Math.round(nowMs() - startedAt))
      recordHtmlCaptureTargetRetryEvent("capture_target_retry_success", {
        artifactId,
        result: "success",
        attempts,
        latencyMs,
        missingBeforeRetry: true,
        retryAttempted: true,
        finalReason: null,
        sourceKind: source.kind,
      })
      return {
        visualSource: source,
        result: "success",
        attempts,
        latencyMs,
        missingBeforeRetry: true,
        retryAttempted: true,
        finalReason: null,
      }
    }
    await delay(HTML_CAPTURE_TARGET_RETRY_INTERVAL_MS)
  }

  const latencyMs = Math.max(0, Math.round(nowMs() - startedAt))
  const finalReason = "capture_target_missing_final"
  recordHtmlCaptureTargetRetryEvent("capture_target_retry_timeout", {
    artifactId: latestContext.current.artifactId ?? initialArtifactId,
    result: "timeout",
    attempts,
    latencyMs,
    missingBeforeRetry: true,
    retryAttempted: true,
    finalReason,
    sourceKind: null,
  })
  recordHtmlCaptureTargetRetryEvent("capture_target_missing_final", {
    artifactId: latestContext.current.artifactId ?? initialArtifactId,
    result: "capture_target_missing_final",
    attempts,
    latencyMs,
    missingBeforeRetry: true,
    retryAttempted: true,
    finalReason,
    sourceKind: null,
  })
  return {
    visualSource: null,
    result: "timeout",
    attempts,
    latencyMs,
    missingBeforeRetry: true,
    retryAttempted: true,
    finalReason,
  }
}

function htmlCaptureTargetTelemetryFromWait(
  result: HtmlCaptureTargetWaitResult,
): Record<string, string | number | boolean | null> {
  return {
    reviewStartWaitedForHtmlCaptureTarget: true,
    reviewStartHtmlCaptureTargetResult: result.finalReason ?? result.result,
    htmlCaptureTargetMissingBeforeRetry: result.missingBeforeRetry,
    htmlCaptureTargetRetryAttempted: result.retryAttempted,
    htmlCaptureTargetRetryResult: result.finalReason ?? result.result,
    htmlCaptureTargetReadyLatencyMs: result.latencyMs,
    htmlFrameCaptureSourceKind: result.visualSource?.kind ?? null,
  }
}

function recordHtmlCaptureTargetRetryEvent(
  name: "capture_target_wait_started" | "capture_target_retry_success" | "capture_target_retry_timeout" | "capture_target_missing_final",
  input: {
    artifactId: string | null
    result: string
    attempts: number
    latencyMs: number
    missingBeforeRetry: boolean
    retryAttempted: boolean
    finalReason: string | null
    sourceKind: string | null
  },
) {
  recordSophiaCaptureEvent({
    category: "artifacts-runtime",
    name,
    payload: {
      artifactId: input.artifactId,
      rendererKind: "html",
      reviewStartWaitedForHtmlCaptureTarget: true,
      reviewStartHtmlCaptureTargetResult: input.result,
      htmlCaptureTargetMissingBeforeRetry: input.missingBeforeRetry,
      htmlCaptureTargetRetryAttempted: input.retryAttempted,
      htmlCaptureTargetRetryResult: input.result,
      htmlCaptureTargetRetryAttemptCount: input.attempts,
      htmlCaptureTargetReadyLatencyMs: input.latencyMs,
      htmlFrameCaptureSourceKind: input.sourceKind,
      htmlFrameCaptureSucceeded: input.result === "success",
      htmlFrameCaptureFailureReason: input.finalReason,
      rawArtifactTextExcluded: true,
      rawHtmlExcluded: true,
      rawCommentTextExcluded: true,
      rawFrameExcluded: true,
      rawScreenshotExcluded: true,
    },
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function nowMs(): number {
  return Date.now()
}
