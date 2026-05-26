"use client"

import { Eye, EyeOff, Loader2 } from "lucide-react"

import { isCoReviewEnabled } from "../../lib/co-review-flags"
import type { CoReviewSessionState, CoReviewTransportStatus } from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"

interface CoReviewControlsProps {
  state: CoReviewSessionState
  transportStatus: CoReviewTransportStatus
  onStart: () => void
  onStop: () => void
  canStart?: boolean
  featureEnabled?: boolean
  className?: string
}

export function CoReviewControls({
  state,
  transportStatus,
  onStart,
  onStop,
  canStart = true,
  featureEnabled = isCoReviewEnabled(),
  className,
}: CoReviewControlsProps) {
  if (!featureEnabled) return null

  const isStarting = state.state === "co_review_starting"
  const isLive = state.state === "co_review_live"
  const isStopping = state.state === "co_review_stopping"
  const statusText = coReviewStatusText(state, transportStatus)

  return (
    <div className={cn("flex items-center gap-2 text-xs text-white/70", className)}>
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
  if (state.state === "co_review_error") return "tool unavailable"
  if (!transportStatus.continuousVideoSupported) return "continuous unsupported"
  return transportStatus.statusText
}
