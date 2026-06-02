"use client"

import { useMemo } from "react"

import {
  buildThreadArtifactHref,
  formatBuilderArtifactTypeLabel,
  getBuilderArtifactFiles,
} from "../../lib/builder-artifacts"
import type {
  CoReviewSessionState,
  CoReviewTransportStatus,
} from "../../lib/co-review-transport"
import { cn } from "../../lib/utils"
import type {
  BuilderArtifactLibraryItemV1,
  BuilderArtifactV1,
} from "../../types/builder-artifact"

import { ArtifactCanvasViewport } from "./ArtifactCanvasViewport"
import { ArtifactReviewStatus } from "./ArtifactReviewStatus"
import { ArtifactToolbar } from "./ArtifactToolbar"
import { ReviewWithSophiaButton } from "./ReviewWithSophiaButton"

interface ArtifactStageProps {
  builderArtifact: BuilderArtifactV1
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  threadId?: string | null
  artifactId?: string | null
  sessionId?: string | null
  normalSessionId?: string | null
  reviewState?: CoReviewSessionState | null
  transportStatus?: CoReviewTransportStatus | null
  exactTextAvailable?: boolean
  canStartReview?: boolean
  reviewEnabled?: boolean
  onStartReview: () => void
  onStopReview: () => void
  className?: string
}

export function ArtifactStage({
  builderArtifact,
  builderArtifactLibrary = [],
  threadId,
  artifactId,
  sessionId,
  normalSessionId,
  reviewState,
  transportStatus,
  exactTextAvailable = false,
  canStartReview = true,
  reviewEnabled = true,
  onStartReview,
  onStopReview,
  className,
}: ArtifactStageProps) {
  const files = useMemo(() => {
    const libraryByPath = new Map(builderArtifactLibrary.map((item) => [item.path, item]))
    return getBuilderArtifactFiles(builderArtifact).map((file) => {
      const libraryItem = libraryByPath.get(file.path)
      return {
        ...file,
        ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
        ...(typeof libraryItem?.sizeBytes === "number" ? { sizeBytes: libraryItem.sizeBytes } : {}),
      }
    })
  }, [builderArtifact, builderArtifactLibrary])
  const primaryFile = files.find((file) => file.isPrimary) ?? files[0] ?? builderArtifactLibrary[0]
  const openHref = buildThreadArtifactHref(threadId, primaryFile?.path)
  const downloadHref = buildThreadArtifactHref(threadId, primaryFile?.path, { download: true })
  const typeLabel = formatBuilderArtifactTypeLabel(builderArtifact.artifactType)
  const viewportPrimaryFile = primaryFile
    ? {
        path: primaryFile.path,
        name: primaryFile.name,
        label: "label" in primaryFile ? primaryFile.label : primaryFile.name,
        isPrimary: "isPrimary" in primaryFile ? primaryFile.isPrimary : true,
        ...("mimeType" in primaryFile && primaryFile.mimeType ? { mimeType: primaryFile.mimeType } : {}),
        ...("sizeBytes" in primaryFile && typeof primaryFile.sizeBytes === "number" ? { sizeBytes: primaryFile.sizeBytes } : {}),
      }
    : null
  const artifactTextRegistration = useMemo(() => (
    artifactId ? {
      artifactId,
      sessionIds: [sessionId, normalSessionId],
      threadId,
    } : null
  ), [artifactId, normalSessionId, sessionId, threadId])

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel)] shadow-[var(--cosmic-shadow-md)]",
        className,
      )}
      aria-label="Generated artifact"
    >
      <ArtifactToolbar
        title={builderArtifact.artifactTitle}
        pageLabel="Page 1 of 1"
        openHref={openHref}
        downloadHref={downloadHref}
        downloadName={primaryFile?.name}
      />

      <ArtifactCanvasViewport
        artifact={builderArtifact}
        files={files}
        typeLabel={typeLabel}
        previewFile={viewportPrimaryFile}
        previewHref={openHref}
        artifactTextRegistration={artifactTextRegistration}
      />

      {reviewEnabled ? (
        <div className="flex flex-col gap-3 border-t border-[color:var(--cosmic-border-soft)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <ArtifactReviewStatus
            state={reviewState}
            transportStatus={transportStatus}
            exactTextAvailable={exactTextAvailable}
            featureEnabled={reviewEnabled}
            canStart={canStartReview}
            className="min-w-0"
          />
          <ReviewWithSophiaButton
            state={reviewState}
            canStart={canStartReview}
            featureEnabled={reviewEnabled}
            onStart={onStartReview}
            onStop={onStopReview}
            className="w-full sm:w-auto"
          />
        </div>
      ) : null}
    </section>
  )
}
