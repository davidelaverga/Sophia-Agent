"use client"

import type { ComponentProps } from "react"

import { haptic } from "../../hooks/useHaptics"
import { buildArtifactHref, buildThreadArtifactHref, classifyBuilderArtifactFileRole, formatBuilderArtifactFileRoleLabel, formatBuilderArtifactFileSize, formatBuilderArtifactTypeLabel, getBuilderArtifactFiles, isMarkdownArtifactFile } from "../../lib/builder-artifacts"
import { listSessionArtifacts, type ArtifactRecord, type ArtifactSessionIndex } from "../../lib/session-artifact-index"
import { cn } from "../../lib/utils"
import { isRealReflection } from "../../session/artifacts"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { RitualArtifacts } from "../../types/session"

import {
  COREVIEW_COMPANION_ARTIFACT_ID,
  CoreviewCompanionArtifactCanvas,
} from "./CoreviewCompanionArtifactCanvas"
import { CoReviewControls } from "./CoReviewControls"

export { COREVIEW_COMPANION_ARTIFACT_ID }

type CoReviewControlsState = ComponentProps<typeof CoReviewControls>["state"]
type CoReviewTransportStatus = ComponentProps<typeof CoReviewControls>["transportStatus"]

interface MinimalArtifactCoReviewControls {
  state: CoReviewControlsState
  transportStatus: CoReviewTransportStatus
  canStart: boolean
  enabled: boolean
  startReview: () => Promise<unknown> | void
  stopReview: () => Promise<unknown> | void
}

function getPathFilename(path: string | undefined): string {
  return path?.split('/').filter(Boolean).pop() || 'Builder deliverable'
}

function inferArtifactType(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1["artifactType"] {
  const mimeType = item.mimeType?.toLowerCase().split(';')[0]?.trim() ?? ''
  const extension = item.name.split('.').pop()?.toLowerCase() ?? ''

  if (mimeType.includes('presentation') || extension === 'ppt' || extension === 'pptx') {
    return 'presentation'
  }
  if (mimeType.includes('html') || extension === 'html' || extension === 'htm') {
    return 'webpage'
  }
  if (
    mimeType.includes('json')
    || mimeType.includes('csv')
    || ['csv', 'json', 'xlsx', 'xls'].includes(extension)
  ) {
    return 'data_analysis'
  }
  if (mimeType.includes('image') || extension === 'svg') {
    return 'visual_report'
  }

  return 'document'
}

function buildLibraryArtifact(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1 {
  return {
    artifactPath: item.path,
    artifactTitle: item.name || getPathFilename(item.path),
    artifactType: inferArtifactType(item),
    decisionsMade: [],
    companionSummary: 'Ready to preview in the artifact canvas.',
    userNextAction: 'Review it with Sophia when you are ready.',
  }
}

function buildSelectedArtifactFromExisting(builderArtifact: BuilderArtifactV1, path: string): BuilderArtifactV1 | null {
  const files = getBuilderArtifactFiles(builderArtifact)
  const selectedFile = files.find((file) => file.path === path)

  if (!selectedFile) {
    return null
  }

  return {
    ...builderArtifact,
    artifactPath: selectedFile.path,
    artifactTitle: selectedFile.isPrimary ? builderArtifact.artifactTitle : selectedFile.label,
    supportingFiles: files
      .filter((file) => file.path !== selectedFile.path)
      .map((file) => file.path),
  }
}

export function buildStageBuilderArtifact({
  builderArtifact,
  selectedBuilderArtifactPath,
  selectedLibraryItem,
  latestLibraryItem,
}: {
  builderArtifact?: BuilderArtifactV1 | null
  selectedBuilderArtifactPath?: string | null
  selectedLibraryItem?: BuilderArtifactLibraryItemV1 | null
  latestLibraryItem?: BuilderArtifactLibraryItemV1 | null
}): BuilderArtifactV1 | null {
  if (selectedBuilderArtifactPath) {
    const selectedExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, selectedBuilderArtifactPath)
      : null

    if (selectedExistingArtifact) {
      return selectedExistingArtifact
    }

    if (selectedLibraryItem) {
      return buildLibraryArtifact(selectedLibraryItem)
    }
  }

  if (latestLibraryItem) {
    const latestExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, latestLibraryItem.path)
      : null

    return latestExistingArtifact ?? buildLibraryArtifact(latestLibraryItem)
  }

  return builderArtifact ?? null
}

export function getStagePrimaryFileWithMime(
  stageBuilderArtifact: BuilderArtifactV1 | null,
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[],
) {
  const files = getBuilderArtifactFiles(stageBuilderArtifact)
  const file = files.find((candidate) => candidate.isPrimary) ?? files[0] ?? null

  if (!file) {
    return null
  }

  const libraryItem = builderArtifactLibrary.find((item) => item.path === file.path)
  return {
    ...file,
    ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
  }
}

export function stageUsesMarkdownArtifactPreview(
  stagePrimaryFile: ReturnType<typeof getStagePrimaryFileWithMime>,
): boolean {
  return isMarkdownArtifactFile(stagePrimaryFile)
}

function BuilderArtifactLibraryList({
  builderArtifactLibrary,
  stageBuilderArtifact,
  threadId,
  onSelectedBuilderArtifactPathChange,
}: {
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[]
  stageBuilderArtifact: BuilderArtifactV1 | null
  threadId?: string
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
}) {
  const visibleFiles = builderArtifactLibrary.filter(
    (file) => classifyBuilderArtifactFileRole(file, builderArtifactLibrary) === 'primary',
  )
  return (
    <div className="flex flex-col items-center gap-2">
      {visibleFiles.map((file) => (
        <BuilderArtifactLibraryRow
          key={file.path}
          file={file}
          roleLabel={formatBuilderArtifactFileRoleLabel(classifyBuilderArtifactFileRole(file, builderArtifactLibrary))}
          isSelected={stageBuilderArtifact?.artifactPath === file.path}
          threadId={threadId}
          onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
        />
      ))}
    </div>
  )
}

function getSessionArtifactVersionLabel(record: ArtifactRecord, artifacts: ArtifactRecord[]): string {
  const explicit = /::v(\d+)$/u.exec(record.versionId)?.[1]
  if (explicit) {
    return `v${explicit}`
  }
  const logicalVersions = artifacts
    .filter((artifact) => artifact.logicalArtifactId === record.logicalArtifactId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  const versionIndex = logicalVersions.findIndex((artifact) => artifact.artifactId === record.artifactId)
  return versionIndex >= 0 ? `v${versionIndex + 1}` : "v1"
}

function formatRendererKindLabel(rendererKind: ArtifactRecord["rendererKind"]): string {
  return rendererKind
    .replace(/_/gu, " ")
    .replace(/\b\w/gu, (match) => match.toUpperCase())
}

function getSessionArtifactRows(index: ArtifactSessionIndex): ArtifactRecord[] {
  const seen = new Set<string>()
  const rows: ArtifactRecord[] = []
  for (const artifact of listSessionArtifacts(index)) {
    const key = `${artifact.threadId}|${artifact.localPath}|${artifact.rendererKind}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    rows.push(artifact)
  }
  return rows
}

function SessionArtifactTray({
  sessionArtifactIndex,
  stageBuilderArtifact,
  threadId,
  onSessionArtifactOpen,
  onSelectedBuilderArtifactPathChange,
}: {
  sessionArtifactIndex: ArtifactSessionIndex
  stageBuilderArtifact: BuilderArtifactV1 | null
  threadId?: string
  onSessionArtifactOpen?: (artifact: ArtifactRecord) => void
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
}) {
  const artifacts = getSessionArtifactRows(sessionArtifactIndex).filter(
    (artifact, _index, allArtifacts) => classifyBuilderArtifactFileRole(
      { path: artifact.localPath },
      allArtifacts.map((sibling) => ({ path: sibling.localPath })),
    ) === 'primary',
  )
  if (artifacts.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col items-center gap-2">
      {artifacts.map((artifact) => (
        <SessionArtifactTrayRow
          key={artifact.artifactId}
          artifact={artifact}
          artifacts={artifacts}
          isSelected={sessionArtifactIndex.activeArtifactId === artifact.artifactId || stageBuilderArtifact?.artifactPath === artifact.localPath}
          threadId={threadId}
          onSessionArtifactOpen={onSessionArtifactOpen}
          onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
        />
      ))}
    </div>
  )
}

function SessionArtifactTrayRow({
  artifact,
  artifacts,
  isSelected,
  threadId,
  onSessionArtifactOpen,
  onSelectedBuilderArtifactPathChange,
}: {
  artifact: ArtifactRecord
  artifacts: ArtifactRecord[]
  isSelected: boolean
  threadId?: string
  onSessionArtifactOpen?: (artifact: ArtifactRecord) => void
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
}) {
  const missing = artifact.review?.missing === true
  const preferArtifactId = (
    artifact.storageProvider !== "local"
    || Boolean(artifact.storageObjectPath || artifact.contentUrl || artifact.downloadUrl)
    || !artifact.artifactId.startsWith("artifact:")
  )
  const downloadHref = missing ? null : buildArtifactHref({
    threadId,
    artifactPath: artifact.localPath,
    artifactId: artifact.artifactId,
    contentUrl: artifact.contentUrl,
    downloadUrl: artifact.downloadUrl,
    preferArtifactId,
  }, { download: true })
  const openHref = missing ? null : buildArtifactHref({
    threadId,
    artifactPath: artifact.localPath,
    artifactId: artifact.artifactId,
    contentUrl: artifact.contentUrl,
    downloadUrl: artifact.downloadUrl,
    preferArtifactId,
  })
  const versionLabel = getSessionArtifactVersionLabel(artifact, artifacts)
  const roleLabel = formatBuilderArtifactFileRoleLabel(classifyBuilderArtifactFileRole(
    { path: artifact.localPath },
    artifacts.map((sibling) => ({ path: sibling.localPath })),
  ))
  const meta = [
    roleLabel,
    formatRendererKindLabel(artifact.rendererKind),
    formatBuilderArtifactTypeLabel(artifact.artifactType),
    versionLabel,
    missing ? "Unavailable" : null,
  ].filter(Boolean).join(" • ")

  const openInCanvas = () => {
    if (missing) {
      return
    }
    haptic("light")
    if (onSessionArtifactOpen) {
      onSessionArtifactOpen(artifact)
      return
    }
    onSelectedBuilderArtifactPathChange?.(artifact.localPath)
  }

  return (
    <div className="flex w-full max-w-[520px] items-center justify-between gap-2" onClick={(event) => event.stopPropagation()}>
      <div className="min-w-0 text-left">
        <span className="block truncate text-[10px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
          {artifact.title}
        </span>
        <span className="block truncate text-[9px]" style={{ color: missing ? 'var(--cosmic-text-muted)' : 'var(--cosmic-text-faint)' }}>
          {meta}
        </span>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button
          type="button"
          aria-label={`View ${artifact.title} in canvas`}
          aria-pressed={isSelected}
          disabled={missing}
          className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
            color: 'var(--sophia-purple)',
            background: isSelected
              ? 'color-mix(in srgb, var(--sophia-purple) 12%, transparent)'
              : 'transparent',
          }}
          onClick={openInCanvas}
        >
          {isSelected ? "Active" : "View in canvas"}
        </button>
        {openHref && (
          <a
            href={openHref}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${artifact.title} in new tab`}
            className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
            style={{
              borderColor: 'var(--cosmic-border-soft)',
              color: 'var(--cosmic-text-whisper)',
            }}
            onClick={() => haptic("light")}
          >
            Open
          </a>
        )}
        {downloadHref && (
          <a
            href={downloadHref}
            aria-label={`Download ${artifact.title}`}
            className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
            style={{
              borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
              color: 'var(--sophia-purple)',
              background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
            }}
            onClick={() => haptic("medium")}
          >
            Download
          </a>
        )}
      </div>
    </div>
  )
}

function BuilderArtifactLibraryRow({
  file,
  roleLabel,
  isSelected,
  threadId,
  onSelectedBuilderArtifactPathChange,
}: {
  file: BuilderArtifactLibraryItemV1
  roleLabel?: string | null
  isSelected: boolean
  threadId?: string
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
}) {
  const downloadHref = buildThreadArtifactHref(threadId, file.path, { download: true })
  const openHref = buildThreadArtifactHref(threadId, file.path)
  const meta = [roleLabel, formatBuilderArtifactFileSize(file.sizeBytes), file.mimeType]
    .filter(Boolean)
    .join(' • ')

  return (
    <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
      <div className="text-center">
        <span className="block text-[10px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
          {file.name}
        </span>
        {meta && (
          <span className="block text-[9px]" style={{ color: 'var(--cosmic-text-faint)' }}>
            {meta}
          </span>
        )}
      </div>
      <div className="flex gap-1.5">
        {onSelectedBuilderArtifactPathChange && (
          <button
            type="button"
            aria-label={`View ${file.name} in canvas`}
            aria-pressed={isSelected}
            className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
            style={{
              borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
              color: 'var(--sophia-purple)',
              background: isSelected
                ? 'color-mix(in srgb, var(--sophia-purple) 12%, transparent)'
                : 'transparent',
            }}
            onClick={() => {
              haptic('light')
              onSelectedBuilderArtifactPathChange(file.path)
            }}
          >
            View in canvas
          </button>
        )}
        {openHref && (
          <a
            href={openHref}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${file.name} in new tab`}
            className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
            style={{
              borderColor: 'var(--cosmic-border-soft)',
              color: 'var(--cosmic-text-whisper)',
            }}
            onClick={() => haptic('light')}
          >
            Open in new tab
          </a>
        )}
        {downloadHref && (
          <a
            href={downloadHref}
            aria-label={`Download ${file.name}`}
            className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
            style={{
              borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
              color: 'var(--sophia-purple)',
              background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
            }}
            onClick={() => haptic('medium')}
          >
            Download
          </a>
        )}
      </div>
    </div>
  )
}

function TakeawayBlock({
  takeaway,
  revealStep,
  isActive,
  bloomColor,
}: {
  takeaway: string
  revealStep: number
  isActive: boolean
  bloomColor: string
}) {
  return (
    <div
      className={cn(
        "transition-all duration-[1400ms] ease-out",
        revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      )}
    >
      <p
        className="font-cormorant text-[17px] leading-[1.75] font-light text-center"
        style={{
          color: revealStep >= 1 ? 'var(--cosmic-text-strong)' : 'transparent',
          textShadow: isActive
            ? `0 0 24px color-mix(in srgb, ${bloomColor} 22%, transparent)`
            : "none",
          transition: 'color 1.4s ease, text-shadow 2s ease',
        }}
      >
        {takeaway}
      </p>
    </div>
  )
}

function NebulaDivider({ revealStep, bloomColor }: { revealStep: number; bloomColor: string }) {
  return (
    <div
      className={cn(
        "mx-auto my-4 transition-all duration-[1200ms] ease-out",
        revealStep >= 2 ? "opacity-100 scale-x-100" : "opacity-0 scale-x-0"
      )}
      style={{
        width: "32px",
        height: "1px",
        background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${bloomColor} 25%, var(--cosmic-text-faint)), transparent)`,
        transformOrigin: "center",
      }}
    />
  )
}

function ReflectionBlock({
  reflection,
  reflectionTapped,
  revealStep,
  isActive,
  bloomColor,
  onReflectionTap,
  onHandleReflectionTap,
}: {
  reflection: NonNullable<RitualArtifacts["reflection_candidate"]>
  reflectionTapped: boolean
  revealStep: number
  isActive: boolean
  bloomColor: string
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onHandleReflectionTap: () => void
}) {
  return (
    <div
      className={cn(
        "transition-all duration-[1400ms] ease-out",
        revealStep >= 3 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      )}
    >
      <button
        onClick={(event) => {
          event.stopPropagation()
          onHandleReflectionTap()
        }}
        disabled={reflectionTapped || !onReflectionTap}
        className={cn(
          "w-full text-center transition-all duration-700",
          !reflectionTapped && onReflectionTap
            ? "cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
            : "cursor-default",
          reflectionTapped && "opacity-40"
        )}
      >
        <p
          className="font-cormorant text-[15px] italic leading-[1.7] font-light"
          style={{
            color: reflectionTapped ? 'var(--cosmic-text-whisper)' : 'var(--cosmic-text-strong)',
            textShadow: !reflectionTapped && isActive
              ? `0 0 20px color-mix(in srgb, ${bloomColor} 18%, transparent)`
              : "none",
            transition: "color 0.7s ease, text-shadow 1s ease",
          }}
        >
          {reflection.prompt}
        </p>
        {reflection.why && !reflectionTapped && (
          <p className="mt-1.5 text-[10px] tracking-[0.08em] font-light" style={{ color: 'var(--cosmic-text-faint)' }}>
            {reflection.why}
          </p>
        )}
        {!reflectionTapped && onReflectionTap && (
          <span
            className="inline-block mt-2.5 text-[9px] tracking-[0.14em] uppercase transition-colors duration-700"
            style={{ color: `color-mix(in srgb, ${bloomColor} 40%, var(--cosmic-text-faint))` }}
          >
            tap to reflect
          </span>
        )}
        {reflectionTapped && (
          <span className="inline-block mt-1.5 text-[9px] tracking-[0.14em] uppercase" style={{ color: 'var(--cosmic-text-faint)' }}>
            sent
          </span>
        )}
      </button>
    </div>
  )
}

function MemoryConstellation({
  memories,
  revealStep,
  onMemoryApprove,
  onMemoryReject,
}: {
  memories: NonNullable<RitualArtifacts["memory_candidates"]>
  revealStep: number
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
}) {
  return (
    <div
      className={cn(
        "mt-4 flex justify-center gap-2 flex-wrap transition-all duration-[1200ms] ease-out",
        revealStep >= 4 ? "opacity-100" : "opacity-0"
      )}
    >
      {memories.slice(0, 5).map((mem, index) => (
        <span
          key={index}
          className={cn(
            "group/mem relative text-[9px] tracking-[0.12em] lowercase px-2 py-[3px]",
            "transition-all duration-[800ms] cursor-default",
          )}
          style={{
            color: 'var(--cosmic-text-muted)',
            animationDelay: `${index * 200}ms`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {mem.memory || mem.category}
          {(onMemoryApprove || onMemoryReject) && (
            <span className="hidden group-hover/mem:inline-flex items-center gap-0.5 ml-1">
              {onMemoryApprove && (
                <button
                  onClick={() => { haptic("light"); onMemoryApprove(index) }}
                  className="transition-colors hover:text-[var(--cosmic-text)]"
                  style={{ color: 'var(--cosmic-text-faint)' }}
                  aria-label="Save memory"
                >
                  ✓
                </button>
              )}
              {onMemoryReject && (
                <button
                  onClick={() => { haptic("light"); onMemoryReject(index) }}
                  className="transition-colors hover:text-[var(--cosmic-text-muted)]"
                  style={{ color: 'var(--cosmic-text-faint)' }}
                  aria-label="Skip memory"
                >
                  ×
                </button>
              )}
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

function DomArtifactReviewControls({ coReview }: { coReview: MinimalArtifactCoReviewControls }) {
  return (
    <div className="mt-4" onClick={(event) => event.stopPropagation()}>
      <CoReviewControls
        state={coReview.state}
        transportStatus={coReview.transportStatus}
        onStart={() => { void coReview.startReview() }}
        onStop={() => { void coReview.stopReview() }}
        canStart={coReview.canStart}
        featureEnabled={coReview.enabled}
        className="justify-center"
      />
    </div>
  )
}

export function PresenceArtifactSecondarySurfaces({
  artifacts,
  builderArtifactLibrary,
  stageBuilderArtifact,
  sessionArtifactIndex,
  showSecondaryArtifactSurfaces,
  showDomArtifactCoReview,
  threadId,
  sessionId,
  normalSessionId,
  revealStep,
  isActive,
  bloomColor,
  reflectionTapped,
  domArtifactCoReview,
  onSelectedBuilderArtifactPathChange,
  onSessionArtifactOpen,
  onHandleReflectionTap,
  onReflectionTap,
  onMemoryApprove,
  onMemoryReject,
  onDomArtifactRootChange,
}: {
  artifacts: RitualArtifacts | null | undefined
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[]
  stageBuilderArtifact: BuilderArtifactV1 | null
  sessionArtifactIndex?: ArtifactSessionIndex | null
  showSecondaryArtifactSurfaces: boolean
  showDomArtifactCoReview: boolean
  threadId?: string
  sessionId?: string | null
  normalSessionId?: string | null
  revealStep: number
  isActive: boolean
  bloomColor: string
  reflectionTapped: boolean
  domArtifactCoReview: MinimalArtifactCoReviewControls
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
  onSessionArtifactOpen?: (artifact: ArtifactRecord) => void
  onHandleReflectionTap: () => void
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
  onDomArtifactRootChange: (node: HTMLDivElement | null) => void
}) {
  const takeaway = artifacts?.takeaway
  const reflection = artifacts?.reflection_candidate
  const memories = artifacts?.memory_candidates
  const hasTakeaway = Boolean(takeaway?.trim())
  const hasReflection = isRealReflection(reflection?.prompt)
  const hasMemories = Boolean(memories && memories.length > 0)
  const hasBuilderLibrary = builderArtifactLibrary.length > 0
  const hasSessionArtifactTray = Boolean(sessionArtifactIndex && sessionArtifactIndex.artifacts.length > 0)

  if (!showSecondaryArtifactSurfaces) {
    return null
  }

  return (
    <>
      {(hasSessionArtifactTray || hasBuilderLibrary) && (
        <div
          className={cn(
            cn(stageBuilderArtifact ? "mt-4" : ""),
            "mb-4 transition-all duration-[1400ms] ease-out",
            revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
          )}
        >
          <p
            className="mb-2 text-center text-[9px] tracking-[0.18em] uppercase"
            style={{ color: 'var(--cosmic-text-faint)' }}
          >
            {hasSessionArtifactTray ? "Artifacts" : "Session files"}
          </p>
          {sessionArtifactIndex && hasSessionArtifactTray ? (
            <SessionArtifactTray
              sessionArtifactIndex={sessionArtifactIndex}
              stageBuilderArtifact={stageBuilderArtifact}
              threadId={threadId}
              onSessionArtifactOpen={onSessionArtifactOpen}
              onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
            />
          ) : (
            <BuilderArtifactLibraryList
              builderArtifactLibrary={builderArtifactLibrary}
              stageBuilderArtifact={stageBuilderArtifact}
              threadId={threadId}
              onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
            />
          )}
        </div>
      )}

      <div ref={onDomArtifactRootChange}>
        {showDomArtifactCoReview && artifacts ? (
          <CoreviewCompanionArtifactCanvas
            artifacts={artifacts}
            artifactId={COREVIEW_COMPANION_ARTIFACT_ID}
            sessionId={sessionId}
            normalSessionId={normalSessionId}
            threadId={threadId}
          />
        ) : null}

        {hasTakeaway && takeaway ? (
          <TakeawayBlock
            takeaway={takeaway}
            revealStep={revealStep}
            isActive={isActive}
            bloomColor={bloomColor}
          />
        ) : null}

        {hasTakeaway && (hasReflection || hasMemories) ? (
          <NebulaDivider revealStep={revealStep} bloomColor={bloomColor} />
        ) : null}

        {hasReflection && reflection ? (
          <ReflectionBlock
            reflection={reflection}
            reflectionTapped={reflectionTapped}
            revealStep={revealStep}
            isActive={isActive}
            bloomColor={bloomColor}
            onReflectionTap={onReflectionTap}
            onHandleReflectionTap={onHandleReflectionTap}
          />
        ) : null}

        {hasMemories && memories ? (
          <MemoryConstellation
            memories={memories}
            revealStep={revealStep}
            onMemoryApprove={onMemoryApprove}
            onMemoryReject={onMemoryReject}
          />
        ) : null}

        {showDomArtifactCoReview ? (
          <DomArtifactReviewControls coReview={domArtifactCoReview} />
        ) : null}
      </div>
    </>
  )
}
