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
    if (!featureEnabled || !sessionId || !threadId || !artifactId) {
      return state
    }

    const visualSource = resolveArtifactVisualSource({
      root: artifactRoot,
      artifactId,
    })

    return machineRef.current.startCoReview({
      normalSessionId,
      sessionId,
      threadId,
      artifactId,
      visualSource,
    })
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
