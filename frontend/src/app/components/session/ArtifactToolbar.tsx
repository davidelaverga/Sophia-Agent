"use client"

import { ChevronLeft, ChevronRight, Download, ExternalLink, Hand, Highlighter, Maximize, MessageSquare, Minimize2, MousePointer2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react"
import type { ReactNode } from "react"

import { haptic } from "../../hooks/useHaptics"
import type { ArtifactFitMode } from "../../lib/artifact-renderers"
import { cn } from "../../lib/utils"
import type { ArtifactToolMode } from "../../types/artifact-annotations"

interface ArtifactToolbarProps {
  title: string
  pageLabel?: string
  pageIndex?: number
  pageCount?: number
  supportsPagination?: boolean
  supportsZoom?: boolean
  zoom?: number
  fitMode?: ArtifactFitMode
  onPreviousPage?: () => void
  onNextPage?: () => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFitPage?: () => void
  onFitWidth?: () => void
  onResetZoom?: () => void
  supportsAnnotations?: boolean
  toolMode?: ArtifactToolMode
  onToolModeChange?: (mode: ArtifactToolMode) => void
  openHref?: string | null
  downloadHref?: string | null
  downloadName?: string
  className?: string
}

export function ArtifactToolbar({
  title,
  pageLabel,
  pageIndex = 0,
  pageCount = 1,
  supportsPagination = false,
  supportsZoom = false,
  zoom = 1,
  fitMode = "custom",
  onPreviousPage,
  onNextPage,
  onZoomIn,
  onZoomOut,
  onFitPage,
  onFitWidth,
  onResetZoom,
  supportsAnnotations = false,
  toolMode = "select",
  onToolModeChange,
  openHref,
  downloadHref,
  downloadName,
  className,
}: ArtifactToolbarProps) {
  const normalizedPageCount = Math.max(1, pageCount)
  const normalizedPageIndex = Math.min(Math.max(0, pageIndex), normalizedPageCount - 1)
  const effectivePageLabel = pageLabel ?? `Page ${normalizedPageIndex + 1} of ${normalizedPageCount}`
  const canGoPrevious = supportsPagination && normalizedPageIndex > 0
  const canGoNext = supportsPagination && normalizedPageIndex < normalizedPageCount - 1
  const zoomLabel = fitMode === "page"
    ? "Fit page"
    : fitMode === "width"
      ? "Fit width"
      : `${Math.round(zoom * 100)}%`

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
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: "var(--cosmic-text-muted)" }}>
          <span>{effectivePageLabel}</span>
          {supportsZoom ? (
            <span className="rounded-full border border-[color:var(--cosmic-border-soft)] px-2 py-0.5 text-[10px] text-[color:var(--cosmic-text-faint)]">
              {zoomLabel}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
        {supportsAnnotations ? (
          <div
            aria-label="Artifact annotation tools"
            className="mr-1 flex items-center gap-1 rounded-lg border border-[color:var(--cosmic-border-soft)] bg-[color:color-mix(in_srgb,var(--cosmic-panel-soft)_68%,transparent)] p-1"
          >
            <ToolModeButton
              mode="select"
              label="Select"
              pressed={toolMode === "select"}
              onSelect={onToolModeChange}
            >
              <MousePointer2 className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolModeButton>
            <ToolModeButton
              mode="pan"
              label="Pan"
              pressed={toolMode === "pan"}
              onSelect={onToolModeChange}
            >
              <Hand className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolModeButton>
            <ToolModeButton
              mode="highlight"
              label="Highlight"
              pressed={toolMode === "highlight"}
              onSelect={onToolModeChange}
            >
              <Highlighter className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolModeButton>
            <ToolModeButton
              mode="comment"
              label="Comment"
              pressed={toolMode === "comment"}
              onSelect={onToolModeChange}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolModeButton>
          </div>
        ) : null}
        {supportsPagination ? (
          <div className="mr-1 flex items-center gap-1">
            <ToolbarButton
              label="Previous page"
              disabled={!canGoPrevious}
              onClick={() => {
                haptic("light")
                onPreviousPage?.()
              }}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              label="Next page"
              disabled={!canGoNext}
              onClick={() => {
                haptic("light")
                onNextPage?.()
              }}
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolbarButton>
          </div>
        ) : null}
        {supportsZoom ? (
          <div className="mr-1 flex items-center gap-1">
            <ToolbarButton
              label="Zoom out"
              onClick={() => {
                haptic("light")
                onZoomOut?.()
              }}
            >
              <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              label="Zoom in"
              onClick={() => {
                haptic("light")
                onZoomIn?.()
              }}
            >
              <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              label="Fit page"
              pressed={fitMode === "page"}
              onClick={() => {
                haptic("light")
                onFitPage?.()
              }}
            >
              <Maximize className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              label="Fit width"
              pressed={fitMode === "width"}
              onClick={() => {
                haptic("light")
                onFitWidth?.()
              }}
            >
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              label="Reset zoom"
              pressed={fitMode === "custom" && Math.abs(zoom - 1) < 0.01}
              onClick={() => {
                haptic("light")
                onResetZoom?.()
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </ToolbarButton>
          </div>
        ) : null}
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

function ToolModeButton({
  mode,
  label,
  pressed,
  onSelect,
  children,
}: {
  mode: ArtifactToolMode
  label: string
  pressed: boolean
  onSelect?: (mode: ArtifactToolMode) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={() => {
        haptic("light")
        onSelect?.(mode)
      }}
      className={cn(
        "cosmic-focus-ring inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
        pressed
          ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_54%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_16%,transparent)] text-[color:var(--sophia-purple)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_14%,transparent)]"
          : "border-transparent text-[color:var(--cosmic-text-muted)] hover:border-[color:var(--cosmic-border-soft)] hover:bg-[color:var(--cosmic-panel-soft)] hover:text-[color:var(--cosmic-text)]",
      )}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function ToolbarButton({
  label,
  disabled = false,
  pressed = false,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  pressed?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "cosmic-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-md border text-[15px] font-semibold transition",
        pressed
          ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_42%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_12%,transparent)] text-[color:var(--sophia-purple)]"
          : "border-[color:var(--cosmic-border-soft)] text-[color:var(--cosmic-text)] hover:bg-[color:var(--cosmic-panel-soft)]",
        "disabled:cursor-not-allowed disabled:opacity-35",
      )}
    >
      {children}
    </button>
  )
}
