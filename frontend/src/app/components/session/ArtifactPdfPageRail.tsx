"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import type { PdfDocumentProxy, PdfRenderTask } from "../../lib/pdfjs-loader"
import { cn } from "../../lib/utils"

interface ArtifactPdfPageRailProps {
  document: PdfDocumentProxy
  pageCount: number
  pageIndex: number
  onPageIndexChange?: (pageIndex: number) => void
  annotationPageCounts?: ReadonlyMap<number, number>
  annotationVersion?: string
}

type ThumbnailRenderState = "loading" | "ready" | "failed"

const MAX_PDF_RAIL_PAGES = 80
const PDF_THUMBNAIL_WIDTH = 54

export function ArtifactPdfPageRail({
  document,
  pageCount,
  pageIndex,
  onPageIndexChange,
  annotationPageCounts,
  annotationVersion = "",
}: ArtifactPdfPageRailProps) {
  const documentKey = getPdfDocumentKey(document)
  const pages = useMemo(() => (
    Array.from({ length: Math.min(MAX_PDF_RAIL_PAGES, Math.max(0, pageCount)) }, (_, index) => index)
  ), [pageCount])

  if (pages.length <= 1) {
    return null
  }

  return (
    <aside
      data-testid="artifact-page-rail"
      aria-label="PDF pages"
      className="relative z-10 hidden w-[88px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-[color:var(--cosmic-border-soft)] bg-[color:color-mix(in_srgb,var(--cosmic-panel)_92%,var(--bg))] px-2 py-3 [scrollbar-gutter:stable] sm:flex"
    >
      {pages.map((index) => (
        <ArtifactPdfPageThumbnail
          key={`${documentKey}:${index}`}
          document={document}
          documentKey={documentKey}
          pageNumber={index + 1}
          annotationCount={annotationPageCounts?.get(index) ?? 0}
          annotationVersion={annotationVersion}
          selected={index === pageIndex}
          onSelect={() => onPageIndexChange?.(index)}
        />
      ))}
    </aside>
  )
}

function ArtifactPdfPageThumbnail({
  document,
  documentKey,
  pageNumber,
  annotationCount,
  annotationVersion,
  selected,
  onSelect,
}: {
  document: PdfDocumentProxy
  documentKey: string
  pageNumber: number
  annotationCount: number
  annotationVersion: string
  selected: boolean
  onSelect: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [renderState, setRenderState] = useState<ThumbnailRenderState>("loading")

  useEffect(() => {
    const canvas = canvasRef.current
    let disposed = false
    let renderTask: PdfRenderTask | null = null

    setRenderState("loading")

    if (!canvas) {
      setRenderState("failed")
      return
    }

    void (async () => {
      const page = await document.getPage(pageNumber)
      if (disposed) {
        return
      }

      const baseViewport = page.getViewport({ scale: 1 })
      const thumbnailScale = baseViewport.width > 0
        ? PDF_THUMBNAIL_WIDTH / baseViewport.width
        : 0.1
      const viewport = page.getViewport({ scale: thumbnailScale })
      const devicePixelRatio = getDevicePixelRatio()
      const cssWidth = Math.max(1, Math.ceil(viewport.width))
      const cssHeight = Math.max(1, Math.ceil(viewport.height))

      canvas.width = Math.max(1, Math.ceil(viewport.width * devicePixelRatio))
      canvas.height = Math.max(1, Math.ceil(viewport.height * devicePixelRatio))
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      canvas.dataset.artifactPdfThumbnail = "true"
      canvas.dataset.artifactPdfThumbnailDocument = documentKey
      canvas.dataset.artifactPdfThumbnailPageNumber = String(pageNumber)
      clearThumbnailCanvas(canvas)

      if (disposed) {
        return
      }

      renderTask = page.render({
        canvas,
        viewport,
        transform: devicePixelRatio === 1 ? undefined : [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
      })

      await renderTask.promise

      if (!disposed) {
        setRenderState("ready")
      }
    })().catch((error: unknown) => {
      if (disposed || isPdfRenderCancellation(error)) {
        return
      }
      setRenderState("failed")
    })

    return () => {
      disposed = true
      cancelPdfRenderTask(renderTask)
    }
  }, [document, documentKey, pageNumber])

  const thumbnailReady = renderState === "ready"
  const thumbnailFailed = renderState === "failed"

  return (
    <button
      type="button"
      aria-label={annotationCount > 0
        ? `Page ${pageNumber}, ${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`
        : `Page ${pageNumber}`}
      aria-current={selected ? "page" : undefined}
      data-annotation-count={String(annotationCount)}
      data-annotation-version={annotationVersion}
      onClick={onSelect}
      className={cn(
        "cosmic-focus-ring flex w-full flex-col items-center gap-1 rounded-lg border px-1.5 py-1.5 text-xs font-medium transition",
        selected
          ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_62%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--sophia-purple)_14%,transparent)] text-[color:var(--sophia-purple)] ring-2 ring-[color:var(--sophia-purple)] ring-offset-1 ring-offset-[color:var(--cosmic-panel)]"
          : "border-[color:var(--cosmic-border-soft)] bg-[color:color-mix(in_srgb,var(--cosmic-panel-soft)_82%,transparent)] text-[color:var(--cosmic-text-muted)] hover:text-[color:var(--cosmic-text)]",
      )}
    >
      <span className="relative flex h-[76px] w-[58px] items-center justify-center overflow-hidden rounded-md bg-[#ebe7f0] shadow-[0_1px_0_color-mix(in_srgb,white_28%,transparent)_inset]">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          data-testid="artifact-pdf-thumbnail-canvas"
          className={cn("block bg-white shadow-sm", !thumbnailReady && "opacity-0")}
        />
        {renderState === "loading" ? (
          <span
            data-testid="artifact-pdf-thumbnail-loading"
            aria-hidden="true"
            className="absolute inset-2 animate-pulse rounded-sm bg-[color:color-mix(in_srgb,var(--cosmic-border-soft)_54%,white)]"
          />
        ) : null}
        {thumbnailFailed ? (
          <span
            data-testid="artifact-pdf-thumbnail-fallback"
            className="absolute inset-0 flex items-center justify-center text-sm font-semibold"
          >
            {pageNumber}
          </span>
        ) : null}
        {annotationCount > 0 ? (
          <span
            data-testid="artifact-pdf-thumbnail-annotation-badge"
            aria-hidden="true"
            className="absolute right-1 top-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full border border-white/85 bg-[color:var(--sophia-purple)] px-1 text-[10px] font-semibold leading-none text-white shadow-[0_4px_12px_rgba(25,19,35,0.25)]"
          >
            {annotationCount > 9 ? "9+" : annotationCount}
          </span>
        ) : null}
      </span>
      <span className="leading-none">{pageNumber}</span>
    </button>
  )
}

function getPdfDocumentKey(document: PdfDocumentProxy): string {
  const fingerprints = document.fingerprints?.filter((fingerprint): fingerprint is string => Boolean(fingerprint))
  return fingerprints && fingerprints.length > 0
    ? fingerprints.join(":")
    : `pages:${document.numPages}`
}

function clearThumbnailCanvas(canvas: HTMLCanvasElement) {
  try {
    const context = canvas.getContext("2d")
    context?.clearRect(0, 0, canvas.width, canvas.height)
  } catch {
    // Thumbnail cleanup is best-effort; stale render guards still protect the UI.
  }
}

function cancelPdfRenderTask(task: PdfRenderTask | null | undefined) {
  try {
    task?.cancel()
  } catch {
    // Cancellation is best-effort; stale effects are ignored by the render guard.
  }
}

function isPdfRenderCancellation(error: unknown): boolean {
  return error instanceof Error && /cancel/i.test(error.name || error.message)
}

function getDevicePixelRatio(): number {
  return Math.max(1, Math.min(2, window.devicePixelRatio || 1))
}
