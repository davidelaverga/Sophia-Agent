"use client"

import { FileText, Layers, ListChecks, Sparkles } from "lucide-react"
import { useEffect, useState } from "react"

import { isMarkdownArtifactFile } from "../../lib/builder-artifacts"
import { registerCoreviewArtifactText } from "../../lib/coreview-artifact-text"
import { cn } from "../../lib/utils"
import type { BuilderArtifactFileV1, BuilderArtifactV1 } from "../../types/builder-artifact"

import { ArtifactMarkdownPreview } from "./ArtifactMarkdownPreview"

type ArtifactViewportFile = BuilderArtifactFileV1 & {
  mimeType?: string
  sizeBytes?: number
}

interface ArtifactCanvasViewportProps {
  artifact: BuilderArtifactV1
  files: ArtifactViewportFile[]
  typeLabel: string
  previewFile?: ArtifactViewportFile | null
  previewHref?: string | null
  artifactTextRegistration?: {
    artifactId: string
    sessionIds?: Array<string | null | undefined>
    threadId?: string | null
  } | null
  className?: string
}

export function ArtifactCanvasViewport({
  artifact,
  files,
  typeLabel,
  previewFile,
  previewHref,
  artifactTextRegistration,
  className,
}: ArtifactCanvasViewportProps) {
  const primaryFile = previewFile ?? files.find((file) => file.isPrimary) ?? files[0]
  const supportingFiles = files.filter((file) => !file.isPrimary)
  const canPreviewMarkdown = isMarkdownArtifactFile(primaryFile)
  const preview = useMarkdownArtifactPreview({
    enabled: canPreviewMarkdown,
    href: previewHref,
  })

  useEffect(() => {
    if (!artifactTextRegistration || preview.status !== "ready" || !preview.markdown.trim()) {
      return
    }

    return registerCoreviewArtifactText({
      artifactId: artifactTextRegistration.artifactId,
      source: "builder_file",
      text: preview.markdown,
      sessionIds: artifactTextRegistration.sessionIds,
      threadId: artifactTextRegistration.threadId,
    })
  }, [artifactTextRegistration, preview.markdown, preview.status])

  return (
    <div
      className={cn(
        "relative min-h-[360px] overflow-hidden rounded-b-xl bg-[color:color-mix(in_srgb,var(--cosmic-panel-soft)_58%,transparent)]",
        className,
      )}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 24% 10%, color-mix(in srgb, var(--sophia-purple) 9%, transparent), transparent 34%), radial-gradient(circle at 78% 18%, color-mix(in srgb, var(--cosmic-teal) 8%, transparent), transparent 36%)",
        }}
      />
      <div className="relative mx-auto flex min-h-[360px] w-full max-w-[720px] flex-col px-4 py-6 sm:px-8 sm:py-8">
        {canPreviewMarkdown ? (
          <MarkdownDocumentPage
            artifact={artifact}
            file={primaryFile}
            preview={preview}
            typeLabel={typeLabel}
          />
        ) : (
          <ArtifactMetadataPage
            artifact={artifact}
            primaryFile={primaryFile}
            supportingFileCount={supportingFiles.length}
            typeLabel={typeLabel}
          />
        )}
      </div>
    </div>
  )
}

type MarkdownPreviewState =
  | { status: "idle"; markdown: "" }
  | { status: "loading"; markdown: "" }
  | { status: "ready"; markdown: string }
  | { status: "failed"; markdown: "" }

function useMarkdownArtifactPreview({
  enabled,
  href,
}: {
  enabled: boolean
  href?: string | null
}): MarkdownPreviewState {
  const [preview, setPreview] = useState<MarkdownPreviewState>({ status: "idle", markdown: "" })

  useEffect(() => {
    if (!enabled || !href) {
      setPreview({ status: "idle", markdown: "" })
      return
    }

    const controller = new AbortController()
    setPreview({ status: "loading", markdown: "" })

    fetch(href, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("preview_unavailable")
        }
        return response.text()
      })
      .then((markdown) => {
        if (!controller.signal.aborted) {
          setPreview({ status: "ready", markdown })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreview({ status: "failed", markdown: "" })
        }
      })

    return () => {
      controller.abort()
    }
  }, [enabled, href])

  return preview
}

function MarkdownDocumentPage({
  artifact,
  file,
  preview,
  typeLabel,
}: {
  artifact: BuilderArtifactV1
  file?: ArtifactViewportFile
  preview: MarkdownPreviewState
  typeLabel: string
}) {
  return (
    <div
      className="mx-auto flex w-full max-w-[620px] flex-1 flex-col rounded-xl border bg-[color:color-mix(in_srgb,var(--card-bg)_90%,transparent)] shadow-[0_24px_70px_color-mix(in_srgb,var(--bg)_34%,transparent)]"
      style={{ borderColor: "var(--cosmic-border-soft)" }}
      aria-label="Artifact document preview"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[color:var(--cosmic-border-soft)] px-6 py-4">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--cosmic-border-soft)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--cosmic-text-muted)]">
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            {typeLabel}
          </span>
          <p className="mt-2 truncate text-xs text-[color:var(--cosmic-text-faint)]">
            {file?.name ?? artifact.artifactTitle}
          </p>
        </div>
        <FileText className="h-7 w-7 shrink-0 text-[color:var(--cosmic-text-faint)]" aria-hidden="true" />
      </div>

      <div className="min-h-[300px] px-6 py-7 sm:px-8">
        {preview.status === "loading" ? (
          <PreviewStateCard title="Loading preview" body="Preparing document view" />
        ) : preview.status === "failed" || preview.status === "idle" ? (
          <PreviewStateCard title="Preview unavailable" body="Open or download the artifact to view the file." />
        ) : (
          <ArtifactMarkdownPreview markdown={preview.markdown} />
        )}
      </div>
    </div>
  )
}

function ArtifactMetadataPage({
  artifact,
  primaryFile,
  supportingFileCount,
  typeLabel,
}: {
  artifact: BuilderArtifactV1
  primaryFile?: ArtifactViewportFile
  supportingFileCount: number
  typeLabel: string
}) {
  return (
    <div
      className="mx-auto flex w-full max-w-[560px] flex-1 flex-col rounded-xl border bg-[color:color-mix(in_srgb,var(--card-bg)_84%,transparent)] px-6 py-7 shadow-[0_24px_70px_color-mix(in_srgb,var(--bg)_34%,transparent)]"
      style={{ borderColor: "var(--cosmic-border-soft)" }}
      aria-label="Artifact document preview"
    >
      <div className="mb-6 flex items-start justify-between gap-4 border-b border-[color:var(--cosmic-border-soft)] pb-4">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--cosmic-border-soft)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--cosmic-text-muted)]">
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            {typeLabel}
          </span>
          <h3 className="mt-4 font-cormorant text-[28px] font-light leading-[1.1] text-[color:var(--cosmic-text-strong)]">
            {artifact.artifactTitle}
          </h3>
        </div>
        <FileText className="h-8 w-8 shrink-0 text-[color:var(--cosmic-text-faint)]" aria-hidden="true" />
      </div>

      {artifact.companionSummary ? (
        <p className="font-cormorant text-[17px] font-light leading-[1.65] text-[color:var(--cosmic-text)]">
          {artifact.companionSummary}
        </p>
      ) : (
        <p className="font-cormorant text-[17px] font-light leading-[1.65] text-[color:var(--cosmic-text)]">
          The artifact is ready to review.
        </p>
      )}

      {primaryFile ? (
        <div className="mt-6 rounded-lg border border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] px-3.5 py-3">
          <p className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--cosmic-text-faint)]">
            Primary file
          </p>
          <p className="mt-1 truncate text-sm font-medium text-[color:var(--cosmic-text-strong)]">
            {primaryFile.name}
          </p>
        </div>
      ) : null}

      {artifact.decisionsMade.length > 0 ? (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[color:var(--cosmic-text-muted)]">
            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
            Decisions
          </div>
          <ul className="space-y-2">
            {artifact.decisionsMade.slice(0, 3).map((decision) => (
              <li key={decision} className="flex gap-2 text-sm leading-relaxed text-[color:var(--cosmic-text)]">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--cosmic-teal)]" />
                <span>{decision}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {artifact.userNextAction || supportingFileCount > 0 ? (
        <div className="mt-auto pt-6">
          {artifact.userNextAction ? (
            <p className="flex items-start gap-2 text-sm leading-relaxed text-[color:var(--cosmic-text-muted)]">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--sophia-purple)]" aria-hidden="true" />
              <span>{artifact.userNextAction}</span>
            </p>
          ) : null}
          {supportingFileCount > 0 ? (
            <p className="mt-3 text-[11px] text-[color:var(--cosmic-text-faint)]">
              {supportingFileCount} supporting {supportingFileCount === 1 ? "file" : "files"} attached
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function PreviewStateCard({
  title,
  body,
}: {
  title: string
  body: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[220px] flex-col items-center justify-center rounded-lg border border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] px-6 text-center"
    >
      <p className="text-sm font-medium text-[color:var(--cosmic-text-strong)]">{title}</p>
      <p className="mt-2 max-w-[320px] text-sm leading-relaxed text-[color:var(--cosmic-text-muted)]">
        {body}
      </p>
    </div>
  )
}
