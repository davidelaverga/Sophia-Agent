"use client"

import { AlertCircle, CheckCircle2, Clock3 } from "lucide-react"

import type {
  CoReviewSessionState,
  CoReviewTransportStatus,
} from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"

import { ExactTextBadge } from "./ExactTextBadge"
import { SophiaLookingChip } from "./SophiaLookingChip"

interface ArtifactReviewStatusProps {
  state: CoReviewSessionState | null | undefined
  transportStatus: CoReviewTransportStatus | null | undefined
  exactTextAvailable?: boolean
  featureEnabled?: boolean
  canStart?: boolean
  visualSourceUnavailableReason?: string | null
  visualReviewRequiresVoice?: boolean
  visualReviewPreparing?: boolean
  className?: string
}

export function ArtifactReviewStatus({
  state,
  transportStatus,
  exactTextAvailable: exactTextAvailableOverride = false,
  featureEnabled = true,
  canStart = true,
  visualSourceUnavailableReason = null,
  visualReviewRequiresVoice = false,
  visualReviewPreparing = false,
  className,
}: ArtifactReviewStatusProps) {
  const exactTextAvailable = Boolean(state?.exactTextAvailable || exactTextAvailableOverride)
  if (!featureEnabled) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 text-[11px]",
          className,
        )}
        aria-live="polite"
      >
        <StatusPill icon="alert" label="Visual review disabled locally" tone="danger" />
        <ExactTextBadge available={exactTextAvailable} />
      </div>
    )
  }

  const frameSent = hasConfirmedStillFrame(state, transportStatus)
  const stale = Boolean(frameSent && state?.state === "co_review_live")
  const hasFrameError = Boolean(
    state?.state === "co_review_error"
    || (state?.frameSendFailureCount ?? 0) > 0
  )
  const waitingForVoice = Boolean(visualReviewRequiresVoice && !frameSent && !hasFrameError)
  const preparingView = Boolean(visualReviewPreparing && !frameSent && !hasFrameError)
  const frameUnavailable = Boolean(
    !waitingForVoice
    && !preparingView
    && (
      hasFrameError
      || transportStatus?.stillFramesSupported === false
      || (transportStatus?.visualTransportSupported === false && !frameSent)
      || Boolean(visualSourceUnavailableReason && !frameSent)
    )
  )

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 text-[11px]",
        className,
      )}
      aria-live="polite"
    >
      <SophiaLookingChip state={state} frameConfirmed={frameSent} />
      {frameSent ? <StatusPill icon="check" label="Frame sent" /> : null}
      {stale ? <StatusPill icon="clock" label="View may be stale" muted /> : null}
      {preparingView ? <StatusPill icon="clock" label="Preparing view" muted /> : null}
      {waitingForVoice ? <StatusPill icon="clock" label="Start voice to review visually" muted /> : null}
      {frameUnavailable ? <StatusPill icon="alert" label="Visual review not active" tone="danger" /> : null}
      {!frameSent && !frameUnavailable && !waitingForVoice && !preparingView && canStart ? <StatusPill icon="clock" label="Frame not sent yet" muted /> : null}
      <ExactTextBadge available={exactTextAvailable} />
    </div>
  )
}

function hasConfirmedStillFrame(
  state: CoReviewSessionState | null | undefined,
  transportStatus: CoReviewTransportStatus | null | undefined,
): boolean {
  return Boolean(
    state?.state === "co_review_live"
      && state.visualInputStatus === "live"
      && state.videoOrFrameMode === "still_frame"
      && (state.frameSentCount ?? 0) > 0
      && transportStatus?.stillFramesSupported !== false
      && transportStatus?.visualTransportSupported !== false,
  )
}

function StatusPill({
  icon,
  label,
  muted = false,
  tone = "default",
}: {
  icon: "alert" | "check" | "clock"
  label: string
  muted?: boolean
  tone?: "danger" | "default"
}) {
  const Icon = icon === "alert" ? AlertCircle : icon === "check" ? CheckCircle2 : Clock3

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium",
        tone === "danger"
          ? "border-[color:var(--cosmic-danger-border)] bg-[color:var(--cosmic-danger-bg)] text-[color:var(--cosmic-danger-text)]"
          : muted
            ? "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)]"
            : "border-[color:var(--cosmic-teal-border)] bg-[color:var(--cosmic-teal-bg)] text-[color:var(--cosmic-text-strong)]",
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
