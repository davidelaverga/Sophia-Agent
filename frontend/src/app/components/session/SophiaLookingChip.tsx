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
  const view = sophiaLookingChipView({ state, frameConfirmed, stale, viewPending })

  return (
    <span
      aria-label={view.label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        view.className,
        className,
      )}
      role="status"
    >
      <view.Icon className={cn("h-3.5 w-3.5", view.spinning && "animate-spin")} aria-hidden="true" />
      <span>{view.label}</span>
    </span>
  )
}

function sophiaLookingChipView({
  state,
  frameConfirmed,
  stale,
  viewPending,
}: Required<Pick<SophiaLookingChipProps, "frameConfirmed" | "stale" | "viewPending">> & {
  state: CoReviewSessionState | null | undefined
}) {
  const visualLive = sophiaLookingVisualLive(state, frameConfirmed)
  const preparing = sophiaLookingPreparing(state, viewPending)
  const unavailable = sophiaLookingUnavailable(state, frameConfirmed)
  if (unavailable) {
    return {
      label: "Frame unavailable",
      Icon: AlertCircle,
      spinning: false,
      className: "border-[color:var(--cosmic-danger-border)] bg-[color:var(--cosmic-danger-bg)] text-[color:var(--cosmic-danger-text)]",
    }
  }
  if (preparing) {
    return {
      label: "Preparing view",
      Icon: Loader2,
      spinning: true,
      className: "border-[color:color-mix(in_srgb,var(--sophia-purple)_34%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_9%,var(--cosmic-panel-soft))] text-[color:var(--cosmic-text)]",
    }
  }
  if (visualLive && stale) {
    return {
      label: "Sophia's view is stale",
      Icon: Clock3,
      spinning: false,
      className: "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)]",
    }
  }
  if (visualLive) {
    return {
      label: "Sophia is looking at this artifact",
      Icon: Eye,
      spinning: false,
      className: "border-[color:color-mix(in_srgb,var(--sophia-purple)_48%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_14%,transparent)] text-[color:var(--cosmic-text-strong)] shadow-[0_0_18px_color-mix(in_srgb,var(--sophia-purple)_14%,transparent)]",
    }
  }
  return {
    label: "Not looking",
    Icon: EyeOff,
    spinning: false,
    className: "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)]",
  }
}

function sophiaLookingVisualLive(state: CoReviewSessionState | null | undefined, frameConfirmed: boolean): boolean {
  return Boolean(frameConfirmed && state?.state === "co_review_live" && state.visualInputStatus === "live")
}

function sophiaLookingPreparing(state: CoReviewSessionState | null | undefined, viewPending: boolean): boolean {
  return Boolean(viewPending || state?.state === "co_review_starting" || state?.refreshFrameInProgress)
}

function sophiaLookingUnavailable(state: CoReviewSessionState | null | undefined, frameConfirmed: boolean): boolean {
  return Boolean(state?.state === "co_review_error" || ((state?.frameSendFailureCount ?? 0) > 0 && !frameConfirmed))
}
