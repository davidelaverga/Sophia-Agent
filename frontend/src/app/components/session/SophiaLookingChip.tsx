"use client"

import { AlertCircle, Clock3, Eye, EyeOff, Loader2 } from "lucide-react"

import type { CoReviewSessionState } from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"

interface SophiaLookingChipProps {
  state: CoReviewSessionState | null | undefined
  frameConfirmed?: boolean
  stale?: boolean
  viewPending?: boolean
  className?: string
}

export function SophiaLookingChip({ state, frameConfirmed = false, stale = false, viewPending = false, className }: SophiaLookingChipProps) {
  const visualLive = Boolean(frameConfirmed && state?.state === "co_review_live" && state.visualInputStatus === "live")
  const preparing = viewPending || state?.state === "co_review_starting" || state?.refreshFrameInProgress
  const unavailable = state?.state === "co_review_error" || ((state?.frameSendFailureCount ?? 0) > 0 && !frameConfirmed)
  const label = unavailable
    ? "Frame unavailable"
    : preparing
      ? "Preparing view"
      : visualLive && stale
        ? "Sophia's view is stale"
        : visualLive
        ? "Sophia is looking at this artifact"
        : "Not looking"
  const Icon = unavailable ? AlertCircle : preparing ? Loader2 : visualLive && stale ? Clock3 : visualLive ? Eye : EyeOff

  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        visualLive && stale
          ? "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)]"
          : visualLive
          ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_48%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_14%,transparent)] text-[color:var(--cosmic-text-strong)] shadow-[0_0_18px_color-mix(in_srgb,var(--sophia-purple)_14%,transparent)]"
          : unavailable
            ? "border-[color:var(--cosmic-danger-border)] bg-[color:var(--cosmic-danger-bg)] text-[color:var(--cosmic-danger-text)]"
            : preparing
              ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_34%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_9%,var(--cosmic-panel-soft))] text-[color:var(--cosmic-text)]"
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
