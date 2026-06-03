"use client"

import { FileText } from "lucide-react"

import { cn } from "../../lib/utils"

import { ArtifactReviewStatus } from "./ArtifactReviewStatus"
import { ArtifactStage, type ArtifactStageProps } from "./ArtifactStage"
import { ReviewWithSophiaButton } from "./ReviewWithSophiaButton"

export function VoiceArtifactStage({
  className,
  reviewState,
  transportStatus,
  exactTextAvailable = false,
  canStartReview = true,
  reviewEnabled = true,
  visualCaptureStatus,
  visualReviewRequiresVoice = false,
  visualReviewPreparing = false,
  pendingStartVoiceReview = false,
  onStartVoiceReview,
  onStartReview,
  onStopReview,
  ...stageProps
}: ArtifactStageProps) {
  return (
    <section
      data-testid="voice-artifact-stage"
      className={cn(
        "pointer-events-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col items-center gap-3 overflow-hidden",
        className,
      )}
      aria-label="Voice artifact review stage"
    >
      <div className="flex w-full shrink-0 flex-wrap items-center justify-center gap-2">
        <ArtifactReviewStatus
          state={reviewState}
          transportStatus={transportStatus}
          exactTextAvailable={exactTextAvailable}
          featureEnabled={reviewEnabled}
          canStart={canStartReview}
          visualSourceUnavailableReason={visualCaptureStatus?.ready === false ? visualCaptureStatus.reason : null}
          visualReviewRequiresVoice={visualReviewRequiresVoice}
          visualReviewPreparing={visualReviewPreparing}
          className="justify-center"
        />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--cosmic-text-muted)]">
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Page 1 of 1</span>
        </span>
      </div>

      <div className="flex min-h-0 w-full flex-1 overflow-hidden">
        <ArtifactStage
          {...stageProps}
          reviewState={reviewState}
          transportStatus={transportStatus}
          exactTextAvailable={exactTextAvailable}
          canStartReview={canStartReview}
          reviewEnabled={false}
          showReviewStatus={false}
          visualCaptureStatus={visualCaptureStatus}
          visualReviewRequiresVoice={visualReviewRequiresVoice}
          visualReviewPreparing={visualReviewPreparing}
          pendingStartVoiceReview={pendingStartVoiceReview}
          onStartVoiceReview={onStartVoiceReview}
          onStartReview={onStartReview}
          onStopReview={onStopReview}
          fillAvailable
          className="h-full min-h-0 flex-1 rounded-xl shadow-[0_26px_90px_color-mix(in_srgb,var(--bg)_46%,transparent)]"
        />
      </div>

      {reviewEnabled ? (
        <div className="flex w-full shrink-0 flex-wrap items-center justify-center gap-2">
          <ReviewWithSophiaButton
            state={reviewState}
            canStart={canStartReview}
            featureEnabled={reviewEnabled}
            startVoiceRequired={visualReviewRequiresVoice}
            pendingStartVoiceReview={pendingStartVoiceReview}
            onStartVoiceReview={onStartVoiceReview}
            onStart={onStartReview}
            onStop={onStopReview}
          />
        </div>
      ) : null}
    </section>
  )
}
