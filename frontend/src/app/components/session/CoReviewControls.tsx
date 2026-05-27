"use client"

import { Eye, EyeOff, Loader2, RotateCw } from "lucide-react"

import { isCoReviewEnabled } from "../../lib/co-review-flags"
import type { CoReviewSessionState, CoReviewTransportStatus } from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"

interface CoReviewControlsProps {
  state: CoReviewSessionState
  transportStatus: CoReviewTransportStatus
  onStart: () => void
  onStop: () => void
  onRefresh?: () => void
  canStart?: boolean
  canRefresh?: boolean
  featureEnabled?: boolean
  className?: string
}

export function CoReviewControls({
  state,
  transportStatus,
  onStart,
  onStop,
  onRefresh,
  canStart = true,
  canRefresh = false,
  featureEnabled = isCoReviewEnabled(),
  className,
}: CoReviewControlsProps) {
  if (!featureEnabled) return null

  const isStarting = state.state === "co_review_starting"
  const isLive = state.state === "co_review_live"
  const isStopping = state.state === "co_review_stopping"
  const statusText = coReviewStatusText(state, transportStatus)
  const refreshStatusText = coReviewRefreshStatusText(state)
  const refreshDisabled = Boolean(
    !onRefresh
    || !canRefresh
    || state.refreshFrameInProgress
    || state.visualInputStatus !== "live"
    || !transportStatus.visualTransportSupported
  )

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs text-white/70", className)}>
      {isLive ? (
        <div
          aria-label="Sophia is looking at this artifact"
          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/40 bg-emerald-400/10 px-2 py-1 text-emerald-100"
          role="status"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Sophia is looking at this artifact</span>
        </div>
      ) : null}

      {isLive ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshDisabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-300/30 bg-emerald-300/10 px-2.5 text-emerald-50 transition hover:bg-emerald-300/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.refreshFrameInProgress ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>Refresh View</span>
        </button>
      ) : null}

      <button
        type="button"
        onClick={isLive || isStarting || isStopping ? onStop : onStart}
        disabled={isStopping || (!canStart && !isLive && !isStarting)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/15 bg-white/8 px-2.5 text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isStarting || isStopping ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : isLive ? (
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span>{isLive || isStarting || isStopping ? "Stop Looking" : "Review Together"}</span>
      </button>

      <span aria-live="polite" className="text-white/50">
        {statusText}
      </span>
      {refreshStatusText ? (
        <span aria-live="polite" className="text-white/50">
          {refreshStatusText}
        </span>
      ) : null}
    </div>
  )
}

export function coReviewStatusText(
  state: CoReviewSessionState,
  transportStatus: CoReviewTransportStatus,
): string {
  if (state.state === "co_review_starting") return "media session connecting"
  if (state.state === "co_review_live") {
    if (state.videoOrFrameMode === "still_frame") return "still-frame mode"
    return "media session live"
  }
  if (state.state === "co_review_error") return coReviewErrorText(state.error)
  if (transportStatus.stillFramesSupported && !transportStatus.visualTransportSupported) {
    return transportStatus.statusText
  }
  if (!transportStatus.continuousVideoSupported) return "continuous unsupported"
  return transportStatus.statusText
}

export function coReviewRefreshStatusText(state: CoReviewSessionState): string | null {
  if (state.refreshFrameInProgress || state.refreshFrameResult === "refreshing") return "Refreshing…"
  if (state.refreshFrameResult === "success" && state.state === "co_review_live") return "Last refreshed just now"
  if (state.refreshFrameResult === "error") {
    return `Refresh failed: ${state.refreshErrorSafeReason ?? state.error ?? "artifact_frame_refresh_failed"}`
  }
  return null
}

function coReviewErrorText(error: string | null): string {
  if (!error) return "still-frame unavailable"
  if (error === "artifact_canvas_not_found") return "Canvas not found"
  if (error === "sendArtifactFrame_missing") return "sendArtifactFrame missing"
  return `still-frame unavailable: ${error}`
}
