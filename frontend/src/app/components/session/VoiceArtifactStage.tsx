"use client"

import { cn } from "../../lib/utils"

import { ArtifactStage, type ArtifactStageProps } from "./ArtifactStage"

export function VoiceArtifactStage({
  className,
  ...stageProps
}: ArtifactStageProps) {
  return (
    <section
      data-testid="voice-artifact-stage"
      className={cn(
        "pointer-events-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col overflow-hidden",
        className,
      )}
      aria-label="Voice artifact review stage"
    >
      <div className="flex min-h-0 w-full flex-1 overflow-hidden">
        <ArtifactStage
          {...stageProps}
          fillAvailable
          className="h-full min-h-0 flex-1 rounded-xl shadow-[0_26px_90px_color-mix(in_srgb,var(--bg)_46%,transparent)]"
        />
      </div>
    </section>
  )
}
