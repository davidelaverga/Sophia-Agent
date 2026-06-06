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

  const view = reviewWithSophiaButtonView({
    state,
    canStart,
    startVoiceRequired,
    pendingStartVoiceReview,
    canStartVoiceReview: Boolean(onStartVoiceReview),
  })

  return (
    <button
      type="button"
      onClick={view.action === "stop" ? onStop : view.action === "start_voice" && onStartVoiceReview ? onStartVoiceReview : onStart}
      disabled={view.disabled}
      className={cn(
        "cosmic-focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium transition-all",
        view.action === "stop"
          ? "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text)] hover:bg-[color:var(--cosmic-panel)]"
          : "border-[color:var(--cosmic-border)] bg-[color:var(--sophia-purple)] text-white shadow-[0_12px_30px_color-mix(in_srgb,var(--sophia-purple)_22%,transparent)] hover:bg-[color:var(--sophia-glow)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <view.Icon className={cn("h-4 w-4", view.spinning && "animate-spin")} aria-hidden="true" />
      <span>{view.label}</span>
    </button>
  )
}

function reviewWithSophiaButtonView({
  state,
  canStart,
  startVoiceRequired,
  pendingStartVoiceReview,
  canStartVoiceReview,
}: {
  state: CoReviewSessionState | null | undefined
  canStart: boolean
  startVoiceRequired: boolean
  pendingStartVoiceReview: boolean
  canStartVoiceReview: boolean
}) {
  const isStarting = state?.state === "co_review_starting"
  const isLive = state?.state === "co_review_live"
  const isStopping = state?.state === "co_review_stopping"
  const shouldStop = reviewButtonShouldStop(isLive, isStarting, isStopping)
  const shouldStartVoice = Boolean(startVoiceRequired && !shouldStop)
  const waitingForVoiceStart = Boolean(pendingStartVoiceReview && !shouldStop)
  const disabled = reviewButtonDisabled({
    isStopping,
    canStart,
    shouldStop,
    shouldStartVoice,
    canStartVoiceReview,
  })
  if (shouldStop) {
    return { action: "stop" as const, disabled, Icon: isStopping || isStarting ? Loader2 : EyeOff, label: "Stop Looking", spinning: isStarting || isStopping }
  }
  if (waitingForVoiceStart) {
    return { action: "start" as const, disabled, Icon: Loader2, label: "Preparing view", spinning: true }
  }
  if (shouldStartVoice) {
    return { action: "start_voice" as const, disabled, Icon: Mic, label: "Start voice & review", spinning: false }
  }
  return { action: "start" as const, disabled, Icon: Eye, label: "Review with Sophia", spinning: false }
}

function reviewButtonShouldStop(isLive: boolean, isStarting: boolean, isStopping: boolean): boolean {
  return isLive || isStarting || isStopping
}

function reviewButtonDisabled({
  isStopping,
  canStart,
  shouldStop,
  shouldStartVoice,
  canStartVoiceReview,
}: {
  isStopping: boolean
  canStart: boolean
  shouldStop: boolean
  shouldStartVoice: boolean
  canStartVoiceReview: boolean
}): boolean {
  if (isStopping) return true
  if (canStart || shouldStop) return false
  return !(shouldStartVoice && canStartVoiceReview)
}
