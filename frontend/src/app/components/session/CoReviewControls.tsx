"use client"

import { Eye, EyeOff, Loader2 } from "lucide-react"

import { isCoreviewStillFrameReviewEnabled } from "../../lib/co-review-flags"
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
  featureEnabled = isCoreviewStillFrameReviewEnabled(),
  className,
}: CoReviewControlsProps) {
  if (!featureEnabled) return null

  const isStarting = state.state === "co_review_starting"
  const isLive = state.state === "co_review_live"
  const isStopping = state.state === "co_review_stopping"
  const statusItems = coReviewStatusItems(state, transportStatus, canStart)
  const visualLive = hasConfirmedCoReviewFrame(state, transportStatus)

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs text-white/70", className)}>
      <div
        aria-label={visualLive ? "Sophia is looking at this artifact" : "Not looking"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-1",
          visualLive
            ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-100"
            : "border-white/12 bg-white/6 text-white/60",
        )}
        role="status"
      >
        {visualLive ? (
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span>{visualLive ? "Sophia is looking at this artifact" : "Not looking"}</span>
      </div>

      {isStarting ? (
        <div
          aria-label="Sophia is preparing to look at this artifact"
          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/40 bg-emerald-400/10 px-2 py-1 text-emerald-100"
          role="status"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>Preparing view</span>
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
        <span>{isLive || isStarting || isStopping ? "Stop Looking" : "Review with Sophia"}</span>
      </button>

      <span aria-live="polite" className="flex flex-wrap items-center gap-1.5">
        {statusItems.map((item) => (
          <span key={item} className="text-white/50">
            {item}
          </span>
        ))}
      </span>
    </div>
  )
}

export function coReviewStatusItems(
  state: CoReviewSessionState,
  transportStatus: CoReviewTransportStatus,
  canStart = true,
): string[] {
  const items: string[] = []
  const frameSent = hasConfirmedCoReviewFrame(state, transportStatus)

  if (frameSent) {
    items.push("Frame sent")
  }

  if (state.exactTextAvailable) {
    items.push("Exact text available")
  }

  if (frameSent) {
    items.push("Visual may be stale")
  }

  if (state.state === "co_review_error" || state.frameSendFailureCount > 0) {
    items.push("Frame unavailable")
    items.push(coReviewErrorText(state.error ?? state.lastFrameSendFailureReason))
  } else if (
    !canStart
    || !transportStatus.stillFramesSupported
    || (!transportStatus.visualTransportSupported && state.frameSentCount === 0)
  ) {
    items.push("Visual review not active")
  } else if (state.state !== "co_review_live" && state.frameSentCount === 0) {
    items.push("Frame not sent yet")
  }

  return items
}

export function coReviewStatusText(
  state: CoReviewSessionState,
  transportStatus: CoReviewTransportStatus,
): string {
  return coReviewStatusItems(state, transportStatus).join(" | ")
}

export function coReviewRefreshStatusText(state: CoReviewSessionState): string | null {
  if (state.refreshFrameInProgress || state.refreshFrameResult === "refreshing") return "Refreshing..."
  if (state.refreshFrameResult === "success" && state.state === "co_review_live") return "Last refreshed just now"
  if (state.refreshFrameResult === "error") {
    return `Refresh failed: ${state.refreshErrorSafeReason ?? state.error ?? "artifact_frame_refresh_failed"}`
  }
  return null
}

function coReviewErrorText(error: string | null): string {
  if (!error) return "View could not be prepared"
  if (error === "artifact_canvas_not_found" || error === "capture_target_missing") return "Artifact view unavailable"
  if (error === "preview_not_ready") return "Artifact view is still preparing"
  return "View could not be prepared"
}

function hasConfirmedCoReviewFrame(
  state: CoReviewSessionState,
  transportStatus: CoReviewTransportStatus,
): boolean {
  return Boolean(
    state.state === "co_review_live"
      && state.visualInputStatus === "live"
      && state.videoOrFrameMode === "still_frame"
      && state.frameSentCount > 0
      && transportStatus.stillFramesSupported
      && transportStatus.visualTransportSupported,
  )
}
