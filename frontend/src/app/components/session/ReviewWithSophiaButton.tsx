"use client"

import { Eye, EyeOff, Loader2 } from "lucide-react"

import type { CoReviewSessionState } from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"

interface ReviewWithSophiaButtonProps {
  state: CoReviewSessionState | null | undefined
  canStart?: boolean
  featureEnabled?: boolean
  onStart: () => void
  onStop: () => void
  className?: string
}

export function ReviewWithSophiaButton({
  state,
  canStart = true,
  featureEnabled = true,
  onStart,
  onStop,
  className,
}: ReviewWithSophiaButtonProps) {
  if (!featureEnabled) return null

  const isStarting = state?.state === "co_review_starting"
  const isLive = state?.state === "co_review_live"
  const isStopping = state?.state === "co_review_stopping"
  const busy = isStarting || isStopping
  const shouldStop = isLive || isStarting || isStopping
  const disabled = isStopping || (!canStart && !shouldStop)
  const Icon = busy ? Loader2 : shouldStop ? EyeOff : Eye

  return (
    <button
      type="button"
      onClick={shouldStop ? onStop : onStart}
      disabled={disabled}
      className={cn(
        "cosmic-focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium transition-all",
        shouldStop
          ? "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text)] hover:bg-[color:var(--cosmic-panel)]"
          : "border-[color:var(--cosmic-border)] bg-[color:var(--sophia-purple)] text-white shadow-[0_12px_30px_color-mix(in_srgb,var(--sophia-purple)_22%,transparent)] hover:bg-[color:var(--sophia-glow)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <Icon className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" />
      <span>{shouldStop ? "Stop Looking" : "Review with Sophia"}</span>
    </button>
  )
}
