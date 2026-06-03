"use client"

import { Download, ExternalLink } from "lucide-react"

import { haptic } from "../../hooks/useHaptics"
import { cn } from "../../lib/utils"

interface ArtifactToolbarProps {
  title: string
  pageLabel?: string
  openHref?: string | null
  downloadHref?: string | null
  downloadName?: string
  className?: string
}

export function ArtifactToolbar({
  title,
  pageLabel = "Page 1 of 1",
  openHref,
  downloadHref,
  downloadName,
  className,
}: ArtifactToolbarProps) {
  return (
    <div
      data-testid="artifact-toolbar"
      className={cn(
        "flex flex-col gap-3 border-b border-[color:var(--cosmic-border-soft)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium" style={{ color: "var(--cosmic-text-strong)" }}>
          {title}
        </p>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--cosmic-text-muted)" }}>
          {pageLabel}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
        {openHref ? (
          <a
            href={openHref}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${title} in new tab`}
            className="cosmic-focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-[color:var(--cosmic-border-soft)] px-2.5 text-[11px] font-medium text-[color:var(--cosmic-text)] transition hover:bg-[color:var(--cosmic-panel-soft)]"
            onClick={() => haptic("light")}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Open in new tab</span>
          </a>
        ) : null}
        {downloadHref ? (
          <a
            href={downloadHref}
            download={downloadName}
            aria-label={`Download ${title}`}
            className="cosmic-focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-[color:var(--cosmic-border)] bg-[color:color-mix(in_srgb,var(--sophia-purple)_10%,transparent)] px-2.5 text-[11px] font-medium text-[color:var(--sophia-purple)] transition hover:bg-[color:color-mix(in_srgb,var(--sophia-purple)_16%,transparent)]"
            onClick={() => haptic("medium")}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Download</span>
          </a>
        ) : null}
      </div>
    </div>
  )
}
