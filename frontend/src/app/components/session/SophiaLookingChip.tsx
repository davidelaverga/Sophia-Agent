"use client"

import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react"

import type { CoReviewSessionState } from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"

interface SophiaLookingChipProps {
  state: CoReviewSessionState | null | undefined
  frameConfirmed?: boolean
  className?: string
}

export function SophiaLookingChip({ state, frameConfirmed = false, className }: SophiaLookingChipProps) {
  const visualLive = Boolean(frameConfirmed && state?.state === "co_review_live" && state.visualInputStatus === "live")
  const preparing = state?.state === "co_review_starting" || state?.refreshFrameInProgress
  const unavailable = state?.state === "co_review_error" || (state?.frameSendFailureCount ?? 0) > 0
  const label = unavailable
    ? "Frame unavailable"
    : preparing
      ? "Preparing view"
      : visualLive
        ? "Sophia is looking at this artifact"
        : "Not looking"
  const Icon = unavailable ? AlertCircle : preparing ? Loader2 : visualLive ? Eye : EyeOff

  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        visualLive
          ? "border-[color:var(--cosmic-teal-border)] bg-[color:var(--cosmic-teal-bg)] text-[color:var(--cosmic-text-strong)]"
          : unavailable
            ? "border-[color:var(--cosmic-danger-border)] bg-[color:var(--cosmic-danger-bg)] text-[color:var(--cosmic-danger-text)]"
            : "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)]",
        className,
      )}
      role="status"
    >
      <Icon className={cn("h-3.5 w-3.5", preparing && "animate-spin")} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
