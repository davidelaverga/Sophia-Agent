"use client"

import { FileText, Layers } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"

import type { ArtifactFitMode } from "../../lib/artifact-renderers"
import { clampArtifactZoom } from "../../lib/artifact-renderers"
import { loadPdfJs, type PdfDocumentProxy, type PdfRenderTask } from "../../lib/pdfjs-loader"
import { cn } from "../../lib/utils"
import type { BuilderArtifactFileV1, BuilderArtifactV1 } from "../../types/builder-artifact"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"

interface ArtifactPdfPreviewProps {
  artifact: BuilderArtifactV1
  file?: (BuilderArtifactFileV1 & { mimeType?: string; sizeBytes?: number }) | null
  href?: string | null
  artifactId?: string | null
  typeLabel: string
  pageIndex: number
  zoom: number
  fitMode: ArtifactFitMode
  fitBounds?: { width: number; height: number }
  onPageCountChange?: (pageCount: number) => void
  onRenderStatusChange?: (status: ArtifactVisualCaptureStatus) => void
}

type PdfDocumentState =
  | { status: "idle"; document: null; error: null }
  | { status: "loading"; document: null; error: null }
  | { status: "ready"; document: PdfDocumentProxy; error: null }
  | { status: "failed"; document: null; error: string }

type PdfPageRenderState = "idle" | "loading" | "ready" | "failed"

type ActivePdfRender = {
  token: number
  task: PdfRenderTask
  cancelled: boolean
  settled: Promise<void>
}

const PDF_FALLBACK_BOUNDS = {
  width: 860,
  height: 720,
}

const PDF_CANVAS_GUTTER = 48
const PDF_PREVIEW_CHROME_HEIGHT = 96

export function ArtifactPdfPreview({
  artifact,
  file,
  href,
  artifactId,
  typeLabel,
  pageIndex,
  zoom,
  fitMode,
  fitBounds,
  onPageCountChange,
  onRenderStatusChange,
}: ArtifactPdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pageHostRef = useRef<HTMLDivElement | null>(null)
  const renderTokenRef = useRef(0)
  const activeRenderRef = useRef<ActivePdfRender | null>(null)
  const onPageCountChangeRef = useRef(onPageCountChange)
  const onRenderStatusChangeRef = useRef(onRenderStatusChange)
  const [documentState, setDocumentState] = useState<PdfDocumentState>({
    status: "idle",
    document: null,
    error: null,
  })
  const [pageRenderState, setPageRenderState] = useState<PdfPageRenderState>("idle")
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)
  const measuredPageHostBounds = useElementBounds(pageHostRef)
  const bounds = useMemo(() => (
    fitBounds
      ? normalizePdfFitBounds(fitBounds)
      : measuredPageHostBounds
  ), [fitBounds, measuredPageHostBounds])

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange
  }, [onPageCountChange])

  useEffect(() => {
    onRenderStatusChangeRef.current = onRenderStatusChange
  }, [onRenderStatusChange])

  useEffect(() => {
    if (!href) {
      setDocumentState({ status: "failed", document: null, error: "missing_pdf_href" })
      onPageCountChangeRef.current?.(1)
      setPageRenderState("failed")
      onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("capture_failed"))
      return
    }

    const controller = new AbortController()
    let loadingTask: { promise: Promise<PdfDocumentProxy>; destroy?: () => Promise<void> } | null = null
    setDocumentState({ status: "loading", document: null, error: null })
    setPageRenderState("idle")
    onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("preview_not_ready"))

    void (async () => {
      const response = await fetch(href, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error("pdf_fetch_failed")
      }

      const arrayBuffer = await response.arrayBuffer()
      if (controller.signal.aborted) {
        return
      }

      const pdfjs = await loadPdfJs()
      if (controller.signal.aborted) {
        return
      }

      loadingTask = pdfjs.getDocument({
        data: new Uint8Array(arrayBuffer),
      }) as { promise: Promise<PdfDocumentProxy>; destroy?: () => Promise<void> }

      const pdfDocument = await loadingTask.promise
      if (controller.signal.aborted) {
        return
      }

      setDocumentState({ status: "ready", document: pdfDocument, error: null })
      onPageCountChangeRef.current?.(Math.max(1, pdfDocument.numPages))
    })().catch((error: unknown) => {
      if (controller.signal.aborted) {
        return
      }

      setDocumentState({
        status: "failed",
        document: null,
        error: error instanceof Error ? error.message : "pdf_load_failed",
      })
      setPageRenderState("failed")
      onPageCountChangeRef.current?.(1)
      onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("capture_failed"))
    })

    return () => {
      controller.abort()
      void loadingTask?.destroy?.()
    }
  }, [href])

  useEffect(() => {
    return () => {
      const activeRender = activeRenderRef.current
      if (activeRender) {
        cancelActivePdfRender(activeRender)
        activeRenderRef.current = null
      }
    }
  }, [])

  const pageNumber = documentState.status === "ready"
    ? clampPdfPageNumber(pageIndex + 1, documentState.document.numPages)
    : Math.max(1, pageIndex + 1)

  useEffect(() => {
    if (documentState.status !== "ready") {
      return
    }

    let disposed = false
    const token = renderTokenRef.current + 1
    renderTokenRef.current = token
    const canvas = canvasRef.current

    setPageRenderState("loading")
    onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("preview_not_ready"))

    if (!canvas) {
      setPageRenderState("failed")
      onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("capture_target_missing"))
      return
    }

    void (async () => {
      const previousRender = activeRenderRef.current
      cancelActivePdfRender(previousRender)
      if (previousRender) {
        await previousRender.settled
        if (activeRenderRef.current?.token === previousRender.token) {
          activeRenderRef.current = null
        }
      }

      if (isStalePdfRender(disposed, token, renderTokenRef)) {
        return
      }

      const page = await documentState.document.getPage(pageNumber)

      if (isStalePdfRender(disposed, token, renderTokenRef)) {
        return
      }

      const baseViewport = page.getViewport({ scale: 1 })
      const nextScale = computePdfScale({
        baseWidth: baseViewport.width,
        baseHeight: baseViewport.height,
        bounds,
        fitMode,
        zoom,
      })
      const viewport = page.getViewport({ scale: nextScale })
      const devicePixelRatio = getDevicePixelRatio()
      const cssWidth = Math.max(1, Math.ceil(viewport.width))
      const cssHeight = Math.max(1, Math.ceil(viewport.height))

      canvas.width = Math.max(1, Math.ceil(viewport.width * devicePixelRatio))
      canvas.height = Math.max(1, Math.ceil(viewport.height * devicePixelRatio))
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      canvas.dataset.artifactPdfScale = String(nextScale)
      canvas.dataset.artifactPdfRenderToken = String(token)
      setPageSize({
        width: cssWidth,
        height: cssHeight,
      })
      clearPdfCanvas(canvas)

      if (isStalePdfRender(disposed, token, renderTokenRef)) {
        return
      }

      const renderTask = page.render({
        canvas,
        viewport,
        transform: devicePixelRatio === 1 ? undefined : [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
      })
      activeRenderRef.current = {
        token,
        task: renderTask,
        cancelled: false,
        settled: renderTask.promise.then(() => undefined, () => undefined),
      }

      await renderTask.promise

      if (isStalePdfRender(disposed, token, renderTokenRef)) {
        return
      }

      if (activeRenderRef.current?.token === token) {
        activeRenderRef.current = null
      }

      setPageRenderState("ready")
      onRenderStatusChangeRef.current?.({
        ready: true,
        reason: null,
        source: "pdf_page_canvas",
        exactTextAvailable: false,
      })
    })().catch((error: unknown) => {
      if (isStalePdfRender(disposed, token, renderTokenRef) || isPdfRenderCancellation(error)) {
        return
      }

      if (activeRenderRef.current?.token === token) {
        activeRenderRef.current = null
      }
      setPageRenderState("failed")
      onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("capture_failed"))
    })

    return () => {
      disposed = true
      if (activeRenderRef.current?.token === token) {
        cancelActivePdfRender(activeRenderRef.current)
      }
    }
  }, [
    bounds,
    documentState,
    fitMode,
    pageNumber,
    zoom,
  ])

  const pageTitle = useMemo(() => (
    file?.name ?? artifact.artifactTitle
  ), [artifact.artifactTitle, file?.name])

  const showCanvas = documentState.status === "ready" && pageRenderState !== "failed"

  return (
    <div
      data-testid="artifact-document-page"
      data-renderer-kind="pdf"
      className="mx-auto flex min-h-full w-full min-w-[min(100%,320px)] max-w-none flex-col overflow-visible rounded-lg border bg-[color:color-mix(in_srgb,var(--card-bg)_96%,var(--cosmic-panel-soft))] shadow-[0_18px_54px_color-mix(in_srgb,var(--bg)_34%,transparent),0_1px_0_color-mix(in_srgb,white_26%,transparent)_inset]"
      style={{ borderColor: "var(--cosmic-border-soft)" }}
      aria-label="Artifact PDF preview"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[color:var(--cosmic-border-soft)] px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--cosmic-border-soft)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--cosmic-text-muted)]">
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            {typeLabel}
          </span>
          <p className="mt-2 truncate text-xs text-[color:var(--cosmic-text-faint)]">
            {pageTitle}
          </p>
        </div>
        <FileText className="h-7 w-7 shrink-0 text-[color:var(--cosmic-text-faint)]" aria-hidden="true" />
      </div>

      <div
        ref={pageHostRef}
        className="relative flex min-h-[320px] flex-1 items-start justify-center overflow-visible bg-[#ebe7f0] px-4 py-5 sm:px-7 sm:py-7"
      >
        {documentState.status === "loading" || pageRenderState === "loading" ? (
          <PdfPreviewState title="Preparing PDF view" body="You can still open or download the artifact." />
        ) : null}

        {documentState.status === "failed" || pageRenderState === "failed" ? (
          <PdfPreviewState title="Preview unavailable" body="Open or download the artifact to view the PDF." />
        ) : null}

        <div
          data-testid="artifact-pdf-page-frame"
          className={cn(
            "relative shrink-0 overflow-hidden rounded-sm bg-white shadow-[0_18px_50px_rgba(25,19,35,0.28)]",
            showCanvas ? "block" : "hidden",
            pageRenderState !== "ready" && "opacity-35",
          )}
          style={{
            minWidth: pageSize ? `${pageSize.width}px` : undefined,
            height: pageSize ? `${pageSize.height}px` : undefined,
          }}
        >
          <canvas
            ref={canvasRef}
            data-testid="artifact-pdf-page-canvas"
            data-artifact-region="true"
            data-coreview-artifact-region="true"
            data-artifact-id={artifactId ?? undefined}
            data-coreview-artifact-id={artifactId ?? undefined}
            data-artifact-canvas={artifactId ? "true" : undefined}
            data-coreview-artifact-canvas={artifactId ? "true" : undefined}
            data-artifact-canvas-source="selected-pdf-page"
            data-artifact-page-index={String(pageIndex)}
            data-artifact-page-number={String(pageNumber)}
            data-artifact-fit-mode={fitMode}
            data-artifact-zoom={String(clampArtifactZoom(zoom))}
            aria-label={`PDF page ${pageNumber}`}
            className="block bg-white"
          />
        </div>
      </div>
    </div>
  )
}

function normalizePdfFitBounds(bounds: { width: number; height: number }): { width: number; height: number } {
  const width = Number.isFinite(bounds.width) ? bounds.width - PDF_CANVAS_GUTTER : PDF_FALLBACK_BOUNDS.width
  const height = Number.isFinite(bounds.height)
    ? bounds.height - PDF_CANVAS_GUTTER - PDF_PREVIEW_CHROME_HEIGHT
    : PDF_FALLBACK_BOUNDS.height
  return {
    width: width > 0 ? width : PDF_FALLBACK_BOUNDS.width,
    height: height > 0 ? height : PDF_FALLBACK_BOUNDS.height,
  }
}

function clampPdfPageNumber(pageNumber: number, pageCount: number): number {
  return Math.min(Math.max(1, Math.floor(pageNumber)), Math.max(1, Math.floor(pageCount)))
}

function clearPdfCanvas(canvas: HTMLCanvasElement) {
  try {
    const context = canvas.getContext("2d")
    context?.clearRect(0, 0, canvas.width, canvas.height)
  } catch {
    // Canvas clearing is best-effort; PDF.js may still render using the canvas directly.
  }
}

function cancelActivePdfRender(activeRender: ActivePdfRender | null | undefined) {
  if (!activeRender || activeRender.cancelled) {
    return
  }
  activeRender.cancelled = true
  cancelPdfRenderTask(activeRender.task)
}

function cancelPdfRenderTask(task: PdfRenderTask | null | undefined) {
  try {
    task?.cancel()
  } catch {
    // Cancellation is best-effort; the render token still prevents stale completion.
  }
}

function isStalePdfRender(
  disposed: boolean,
  token: number,
  renderTokenRef: RefObject<number>,
): boolean {
  return disposed || renderTokenRef.current !== token
}

function useElementBounds(ref: RefObject<HTMLElement | null>) {
  const [bounds, setBounds] = useState(PDF_FALLBACK_BOUNDS)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }

    const update = () => {
      const width = element.clientWidth - PDF_CANVAS_GUTTER
      const height = element.clientHeight - PDF_CANVAS_GUTTER
      const nextBounds = {
        width: width > 0 ? width : PDF_FALLBACK_BOUNDS.width,
        height: height > 0 ? height : PDF_FALLBACK_BOUNDS.height,
      }
      setBounds((current) => (
        current.width === nextBounds.width && current.height === nextBounds.height
          ? current
          : nextBounds
      ))
    }

    update()

    const observeWindowResize = () => {
      window.addEventListener("resize", update)
      return () => window.removeEventListener("resize", update)
    }

    if (typeof ResizeObserver === "undefined") {
      return observeWindowResize()
    }

    const observer = new ResizeObserver(update)
    if (typeof observer.observe !== "function" || typeof observer.disconnect !== "function") {
      return observeWindowResize()
    }

    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return bounds
}

function computePdfScale({
  baseWidth,
  baseHeight,
  bounds,
  fitMode,
  zoom,
}: {
  baseWidth: number
  baseHeight: number
  bounds: { width: number; height: number }
  fitMode: ArtifactFitMode
  zoom: number
}): number {
  const widthScale = bounds.width > 0 && baseWidth > 0 ? bounds.width / baseWidth : 1
  const pageScale = bounds.height > 0 && baseHeight > 0
    ? Math.min(widthScale, bounds.height / baseHeight)
    : widthScale

  if (fitMode === "width") {
    return clampArtifactZoom(widthScale)
  }

  if (fitMode === "page") {
    return clampArtifactZoom(pageScale)
  }

  return clampArtifactZoom(zoom)
}

function unavailablePdfCaptureStatus(
  reason: ArtifactVisualCaptureStatus["reason"],
): ArtifactVisualCaptureStatus {
  return {
    ready: false,
    reason,
    source: "pdf_page_canvas",
    exactTextAvailable: false,
  }
}

function isPdfRenderCancellation(error: unknown): boolean {
  return error instanceof Error && /cancel/i.test(error.name || error.message)
}

function getDevicePixelRatio(): number {
  return Math.max(1, Math.min(2, window.devicePixelRatio || 1))
}

function PdfPreviewState({
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
      data-testid="artifact-preview-state"
      className="absolute bottom-0 left-0 right-0 top-0 z-10 flex min-h-[260px] flex-col items-center justify-center bg-[#ebe7f0] px-6 text-center"
    >
      <p className="text-sm font-medium text-[color:var(--cosmic-text-strong)]">{title}</p>
      <p className="mt-2 max-w-[320px] text-sm leading-relaxed text-[color:var(--cosmic-text-muted)]">
        {body}
      </p>
    </div>
  )
}
