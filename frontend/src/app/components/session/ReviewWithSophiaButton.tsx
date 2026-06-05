"use client"

import { Eye, EyeOff, Loader2, Mic } from "lucide-react"

import type { CoReviewSessionState } from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"

interface ReviewWithSophiaButtonProps {
  state: CoReviewSessionState | null | undefined
  canStart?: boolean
  featureEnabled?: boolean
  startVoiceRequired?: boolean
  pendingStartVoiceReview?: boolean
  onStartVoiceReview?: () => void
  onStart: () => void
  onStop: () => void
  className?: string
}

export function ReviewWithSophiaButton({
  state,
  canStart = true,
  featureEnabled = true,
  startVoiceRequired = false,
  pendingStartVoiceReview = false,
  onStartVoiceReview,
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
  const shouldStartVoice = Boolean(startVoiceRequired && !shouldStop)
  const waitingForVoiceStart = Boolean(pendingStartVoiceReview && !shouldStop)
  const disabled = isStopping || (!canStart && !shouldStop && !(shouldStartVoice && onStartVoiceReview))
  const Icon = busy || waitingForVoiceStart ? Loader2 : shouldStop ? EyeOff : shouldStartVoice ? Mic : Eye
  const label = shouldStop
    ? "Stop Looking"
    : waitingForVoiceStart
      ? "Preparing view"
      : shouldStartVoice
        ? "Start voice & review"
        : "Review with Sophia"

  return (
    <button
      type="button"
      onClick={shouldStop ? onStop : shouldStartVoice && onStartVoiceReview ? onStartVoiceReview : onStart}
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
      <Icon className={cn("h-4 w-4", (busy || waitingForVoiceStart) && "animate-spin")} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}
