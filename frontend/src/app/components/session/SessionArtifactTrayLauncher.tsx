"use client"

import { Download, ExternalLink, Eye, File as FileIcon, FileText, Globe, Image as ImageIcon, Layers, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { haptic } from "../../hooks/useHaptics"
import { buildArtifactHref, formatBuilderArtifactTypeLabel } from "../../lib/builder-artifacts"
import { listSessionArtifacts, type ArtifactRecord, type ArtifactSessionIndex } from "../../lib/session-artifact-index"
import { cn } from "../../lib/utils"

/**
 * Persistent entry point for the local session artifact index.
 *
 * Renders a compact "Artifacts" pill with a count badge whenever the index
 * holds at least one record; clicking it opens a small panel listing the
 * saved artifacts with the same actions the in-panel tray offers (View in
 * canvas via the existing open flow, Open in new tab, Download). Renders
 * nothing when the index is empty so quiet sessions stay uncluttered.
 *
 * Only sanitized index metadata (title, renderer/type labels, version) is
 * shown — artifact records never carry raw content (`rawContentExcluded`).
 */

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

function ArtifactKindIcon({ rendererKind }: { rendererKind: ArtifactRecord["rendererKind"] }) {
  const className = "h-3.5 w-3.5 shrink-0"
  const style = { color: "color-mix(in srgb, var(--sophia-purple) 72%, var(--cosmic-text-whisper))" }
  if (rendererKind === "html") {
    return <Globe className={className} style={style} aria-hidden />
  }
  if (rendererKind === "image") {
    return <ImageIcon className={className} style={style} aria-hidden />
  }
  if (rendererKind === "pdf" || rendererKind === "markdown") {
    return <FileText className={className} style={style} aria-hidden />
  }
  return <FileIcon className={className} style={style} aria-hidden />
}

function isRegistryBackedArtifact(artifact: ArtifactRecord): boolean {
  return (
    artifact.storageProvider !== "local"
    || Boolean(artifact.storageObjectPath || artifact.contentUrl || artifact.downloadUrl)
    || !artifact.artifactId.startsWith("artifact:")
  )
}

function SessionArtifactTrayLauncherRow({
  artifact,
  artifacts,
  isActive,
  threadId,
  onOpenInCanvas,
}: {
  artifact: ArtifactRecord
  artifacts: ArtifactRecord[]
  isActive: boolean
  threadId?: string
  onOpenInCanvas: (artifact: ArtifactRecord) => void
}) {
  const missing = artifact.review?.missing === true
  const preferArtifactId = isRegistryBackedArtifact(artifact)
  const openHref = missing ? null : buildArtifactHref({
    threadId,
    artifactPath: artifact.localPath,
    artifactId: artifact.artifactId,
    contentUrl: artifact.contentUrl,
    downloadUrl: artifact.downloadUrl,
    preferArtifactId,
  })
  const downloadHref = missing ? null : buildArtifactHref({
    threadId,
    artifactPath: artifact.localPath,
    artifactId: artifact.artifactId,
    contentUrl: artifact.contentUrl,
    downloadUrl: artifact.downloadUrl,
    preferArtifactId,
  }, { download: true })
  const meta = [
    formatRendererKindLabel(artifact.rendererKind),
    formatBuilderArtifactTypeLabel(artifact.artifactType),
    getSessionArtifactVersionLabel(artifact, artifacts),
    missing ? "Unavailable" : null,
  ].filter(Boolean).join(" • ")

  return (
    <li
      data-testid="session-artifact-tray-row"
      className="rounded-[14px] border px-2.5 py-2 transition-colors"
      style={{
        borderColor: isActive
          ? "color-mix(in srgb, var(--sophia-purple) 26%, var(--cosmic-border-soft))"
          : "color-mix(in srgb, var(--cosmic-border-soft) 82%, transparent)",
        background: isActive
          ? "color-mix(in srgb, var(--sophia-purple) 8%, transparent)"
          : "color-mix(in srgb, var(--cosmic-panel-soft) 44%, transparent)",
      }}
    >
      <div className="flex items-center gap-2">
        <ArtifactKindIcon rendererKind={artifact.rendererKind} />
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11px] tracking-[0.03em]" style={{ color: "var(--cosmic-text)" }}>
              {artifact.title}
            </span>
            {isActive && (
              <span
                className="shrink-0 rounded-full px-1.5 py-0.5 text-[8px] tracking-[0.1em] lowercase"
                style={{
                  color: "var(--cosmic-teal)",
                  background: "color-mix(in srgb, var(--cosmic-teal) 14%, transparent)",
                }}
              >
                Active
              </span>
            )}
          </div>
          <span
            className="block truncate text-[9px] tracking-[0.06em]"
            style={{ color: missing ? "var(--cosmic-text-muted)" : "var(--cosmic-text-faint)" }}
          >
            {meta}
          </span>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          aria-label={`View ${artifact.title} in canvas`}
          disabled={missing}
          className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[9px] tracking-[0.08em] transition-opacity hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-45"
          style={{
            borderColor: "color-mix(in srgb, var(--sophia-purple) 22%, var(--cosmic-border-soft))",
            color: "var(--sophia-purple)",
            background: isActive
              ? "color-mix(in srgb, var(--sophia-purple) 12%, transparent)"
              : "color-mix(in srgb, var(--cosmic-panel-soft) 64%, transparent)",
          }}
          onClick={() => {
            if (missing) {
              return
            }
            haptic("light")
            onOpenInCanvas(artifact)
          }}
        >
          <Eye className="h-3 w-3" aria-hidden />
          View in canvas
        </button>
        {openHref && (
          <a
            href={openHref}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${artifact.title} in new tab`}
            className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[9px] tracking-[0.08em] transition-opacity hover:opacity-100"
            style={{
              borderColor: "color-mix(in srgb, var(--cosmic-border-soft) 88%, transparent)",
              color: "var(--cosmic-text-whisper)",
              background: "color-mix(in srgb, var(--cosmic-panel-soft) 52%, transparent)",
            }}
            onClick={() => haptic("light")}
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            Open
          </a>
        )}
        {downloadHref && (
          <a
            href={downloadHref}
            aria-label={`Download ${artifact.title}`}
            className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[9px] tracking-[0.08em] transition-opacity hover:opacity-100"
            style={{
              borderColor: "color-mix(in srgb, var(--sophia-purple) 24%, var(--cosmic-border-soft))",
              color: "var(--sophia-purple)",
              background: "color-mix(in srgb, var(--sophia-purple) 8%, transparent)",
            }}
            onClick={() => haptic("medium")}
          >
            <Download className="h-3 w-3" aria-hidden />
            Download
          </a>
        )}
      </div>
    </li>
  )
}

export function SessionArtifactTrayLauncher({
  sessionArtifactIndex,
  threadId,
  onSessionArtifactOpen,
  className,
}: {
  sessionArtifactIndex?: ArtifactSessionIndex | null
  threadId?: string
  onSessionArtifactOpen: (artifact: ArtifactRecord) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(
    () => (sessionArtifactIndex ? getSessionArtifactRows(sessionArtifactIndex) : []),
    [sessionArtifactIndex],
  )

  useEffect(() => {
    if (!open) {
      return
    }
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", closeOnOutsidePointer)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [open])

  if (rows.length === 0) {
    return null
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {open && (
        <div
          role="dialog"
          aria-label="Session artifacts"
          data-testid="session-artifact-tray-panel"
          className="absolute bottom-[calc(100%+10px)] right-0 z-40 w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-[20px] border p-3 backdrop-blur-xl"
          style={{
            borderColor: "color-mix(in srgb, var(--sophia-purple) 22%, var(--cosmic-border-soft))",
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--sophia-purple) 8%, var(--cosmic-panel-soft)), color-mix(in srgb, var(--cosmic-panel) 90%, transparent))",
            boxShadow: "0 16px 40px color-mix(in srgb, var(--sophia-purple) 14%, transparent)",
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[9px] tracking-[0.18em] uppercase" style={{ color: "var(--cosmic-text-faint)" }}>
              Artifacts · this session
            </span>
            <button
              type="button"
              aria-label="Close artifacts"
              className="relative inline-flex h-5 w-5 items-center justify-center rounded-full border transition-opacity hover:opacity-100 before:absolute before:-inset-[10px] before:content-['']"
              style={{
                borderColor: "color-mix(in srgb, var(--cosmic-border-soft) 88%, transparent)",
                color: "var(--cosmic-text-whisper)",
                background: "color-mix(in srgb, var(--cosmic-panel-soft) 52%, transparent)",
                opacity: 0.78,
              }}
              onClick={() => {
                haptic("selection")
                setOpen(false)
              }}
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
          <ul className="flex max-h-[min(46vh,320px)] flex-col gap-1.5 overflow-y-auto pr-0.5">
            {rows.map((artifact) => (
              <SessionArtifactTrayLauncherRow
                key={artifact.artifactId}
                artifact={artifact}
                artifacts={rows}
                isActive={sessionArtifactIndex?.activeArtifactId === artifact.artifactId}
                threadId={threadId}
                onOpenInCanvas={(record) => {
                  setOpen(false)
                  onSessionArtifactOpen(record)
                }}
              />
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Artifacts, ${rows.length} saved`}
        data-testid="session-artifact-tray-launcher"
        className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[10px] tracking-[0.14em] lowercase backdrop-blur-xl transition-all hover:opacity-100"
        style={{
          borderColor: "color-mix(in srgb, var(--sophia-purple) 22%, var(--cosmic-border-soft))",
          color: "var(--cosmic-text-whisper)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--sophia-purple) 8%, color-mix(in srgb, var(--cosmic-panel-soft) 64%, transparent)), color-mix(in srgb, var(--cosmic-panel) 58%, transparent))",
          boxShadow: open
            ? "0 12px 30px color-mix(in srgb, var(--sophia-purple) 16%, transparent)"
            : "0 8px 22px color-mix(in srgb, var(--sophia-purple) 8%, transparent)",
          opacity: 0.96,
        }}
        onClick={() => {
          haptic("light")
          setOpen((current) => !current)
        }}
      >
        <Layers className="h-3.5 w-3.5" style={{ color: "var(--sophia-purple)" }} aria-hidden />
        Artifacts
        <span
          data-testid="session-artifact-tray-count"
          className="rounded-full px-1.5 py-0.5 text-[9px] tracking-[0.1em]"
          style={{
            color: "var(--sophia-purple)",
            background: "color-mix(in srgb, var(--sophia-purple) 16%, transparent)",
          }}
        >
          {rows.length}
        </span>
      </button>
    </div>
  )
}
