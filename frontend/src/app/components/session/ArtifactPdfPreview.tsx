"use client"

import { FileText, Layers } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type RefObject, type TouchEvent } from "react"

import type { ArtifactFitMode } from "../../lib/artifact-renderers"
import { clampArtifactZoom } from "../../lib/artifact-renderers"
import { loadPdfJs, type PdfDocumentProxy, type PdfRenderTask } from "../../lib/pdfjs-loader"
import { cn } from "../../lib/utils"
import type {
  ArtifactAnnotation,
  ArtifactToolMode,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../../types/artifact-annotations"
import type { BuilderArtifactFileV1, BuilderArtifactV1 } from "../../types/builder-artifact"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import { ArtifactPdfPageRail } from "./ArtifactPdfPageRail"

export type ArtifactPdfTextExtractionStatusValue = "loading" | "success" | "failed" | "unavailable"

export interface ArtifactPdfTextExtractionStatus {
  status: ArtifactPdfTextExtractionStatusValue
  source: "pdf_text_extraction"
  pageCount: number
  charCount: number
  truncated: boolean
  safeReason: string | null
  text?: string
}

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
  onPageIndexChange?: (pageIndex: number) => void
  onPageCountChange?: (pageCount: number) => void
  onRenderStatusChange?: (status: ArtifactVisualCaptureStatus) => void
  onTextExtractionStatusChange?: (status: ArtifactPdfTextExtractionStatus) => void
  onPinchZoomChange?: (zoom: number) => void
  toolMode?: ArtifactToolMode
  annotations?: ArtifactAnnotation[]
  selectedAnnotationId?: string | null
  onCreateHighlight?: (rect: NormalizedArtifactRect) => void
  onCreateComment?: (point: NormalizedArtifactPoint) => void
  onSelectAnnotation?: (id: string | null) => void
  onUpdateCommentText?: (id: string, text: string) => void
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
const MAX_PDF_TEXT_EXTRACTION_CHARS = 12_000
const MIN_NORMALIZED_HIGHLIGHT_SIZE = 0.008

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
  onPageIndexChange,
  onPageCountChange,
  onRenderStatusChange,
  onTextExtractionStatusChange,
  onPinchZoomChange,
  toolMode = "select",
  annotations = [],
  selectedAnnotationId = null,
  onCreateHighlight,
  onCreateComment,
  onSelectAnnotation,
  onUpdateCommentText,
}: ArtifactPdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pageHostRef = useRef<HTMLDivElement | null>(null)
  const renderTokenRef = useRef(0)
  const activeRenderRef = useRef<ActivePdfRender | null>(null)
  const onPageCountChangeRef = useRef(onPageCountChange)
  const onRenderStatusChangeRef = useRef(onRenderStatusChange)
  const onTextExtractionStatusChangeRef = useRef(onTextExtractionStatusChange)
  const pinchStateRef = useRef<{ distance: number; zoom: number } | null>(null)
  const [highlightDraft, setHighlightDraft] = useState<{
    start: NormalizedArtifactPoint
    current: NormalizedArtifactPoint
  } | null>(null)
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
    onTextExtractionStatusChangeRef.current = onTextExtractionStatusChange
  }, [onTextExtractionStatusChange])

  useEffect(() => {
    if (!href) {
      setDocumentState({ status: "failed", document: null, error: "missing_pdf_href" })
      onPageCountChangeRef.current?.(1)
      setPageRenderState("failed")
      onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("capture_failed"))
      onTextExtractionStatusChangeRef.current?.(pdfTextExtractionStatus("failed", {
        safeReason: "missing_pdf_href",
      }))
      return
    }

    const controller = new AbortController()
    let loadingTask: { promise: Promise<PdfDocumentProxy>; destroy?: () => Promise<void> } | null = null
    setDocumentState({ status: "loading", document: null, error: null })
    setPageRenderState("idle")
    onRenderStatusChangeRef.current?.(unavailablePdfCaptureStatus("preview_not_ready"))
    onTextExtractionStatusChangeRef.current?.(pdfTextExtractionStatus("loading"))

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

      void extractPdfPlainText(pdfDocument, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) {
            return
          }

          onTextExtractionStatusChangeRef.current?.(pdfTextExtractionStatus(
            result.text.trim() ? "success" : "unavailable",
            {
              pageCount: result.pageCount,
              charCount: result.charCount,
              truncated: result.truncated,
              safeReason: result.text.trim() ? null : "pdf_text_empty",
              text: result.text.trim() ? result.text : undefined,
            },
          ))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return
          }

          onTextExtractionStatusChangeRef.current?.(pdfTextExtractionStatus("failed", {
            safeReason: error instanceof Error ? error.message : "pdf_text_extraction_failed",
          }))
        })
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
      onTextExtractionStatusChangeRef.current?.(pdfTextExtractionStatus("failed", {
        safeReason: error instanceof Error ? error.message : "pdf_load_failed",
      }))
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
  const pageAnnotations = useMemo(() => (
    annotations.filter((annotation) => annotation.pageIndex === pageIndex)
  ), [annotations, pageIndex])
  const selectedAnnotation = useMemo(() => (
    pageAnnotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null
  ), [pageAnnotations, selectedAnnotationId])
  const highlightDraftRect = highlightDraft
    ? normalizedRectFromPoints(highlightDraft.start, highlightDraft.current)
    : null

  const handlePanLayerTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 2) {
      pinchStateRef.current = null
      return
    }

    pinchStateRef.current = {
      distance: touchDistance(event.touches[0], event.touches[1]),
      zoom: clampArtifactZoom(zoom),
    }
  }, [zoom])

  const handlePanLayerTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const pinchState = pinchStateRef.current
    if (!pinchState || event.touches.length !== 2) {
      return
    }

    const distance = touchDistance(event.touches[0], event.touches[1])
    if (pinchState.distance <= 0 || distance <= 0) {
      return
    }

    event.preventDefault()
    const nextZoom = clampArtifactZoom(pinchState.zoom * (distance / pinchState.distance))
    onPinchZoomChange?.(nextZoom)
  }, [onPinchZoomChange])

  const handlePanLayerTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length < 2) {
      pinchStateRef.current = null
    }
  }, [])
  const handleAnnotationLayerPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!showCanvas || event.button !== 0) {
      return
    }

    if (toolMode === "pan") {
      return
    }

    if (toolMode === "select") {
      onSelectAnnotation?.(null)
      return
    }

    const point = normalizedPointFromPointerEvent(event, pageSize)
    event.preventDefault()
    event.stopPropagation()

    if (toolMode === "comment") {
      onCreateComment?.(point)
      return
    }

    setHighlightDraft({ start: point, current: point })
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is optional; the layer still handles normal pointerup.
    }
  }, [onCreateComment, onSelectAnnotation, pageSize, showCanvas, toolMode])
  const handleAnnotationLayerPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (toolMode !== "highlight" || !highlightDraft) {
      return
    }

    event.preventDefault()
    const point = normalizedPointFromPointerEvent(event, pageSize)
    setHighlightDraft((current) => (
      current
        ? { ...current, current: point }
        : current
    ))
  }, [highlightDraft, pageSize, toolMode])
  const finishHighlightDraft = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (toolMode !== "highlight" || !highlightDraft) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const rect = normalizedRectFromPoints(highlightDraft.start, normalizedPointFromPointerEvent(event, pageSize))
    setHighlightDraft(null)

    if (
      rect.width < MIN_NORMALIZED_HIGHLIGHT_SIZE
      || rect.height < MIN_NORMALIZED_HIGHLIGHT_SIZE
    ) {
      return
    }

    onCreateHighlight?.(rect)
  }, [highlightDraft, onCreateHighlight, pageSize, toolMode])
  const cancelHighlightDraft = useCallback(() => {
    setHighlightDraft(null)
  }, [])
  const handleAnnotationSelect = useCallback((id: string) => {
    onSelectAnnotation?.(id)
  }, [onSelectAnnotation])
  const handleCommentTextChange = useCallback((id: string, value: string) => {
    onUpdateCommentText?.(id, value)
  }, [onUpdateCommentText])

  return (
    <div
      data-testid="artifact-document-page"
      data-renderer-kind="pdf"
      className="mx-auto flex h-full min-h-[320px] w-full min-w-0 max-w-none flex-col overflow-hidden rounded-lg border bg-[color:color-mix(in_srgb,var(--card-bg)_96%,var(--cosmic-panel-soft))] shadow-[0_18px_54px_color-mix(in_srgb,var(--bg)_34%,transparent),0_1px_0_color-mix(in_srgb,white_26%,transparent)_inset]"
      style={{ borderColor: "var(--cosmic-border-soft)" }}
      aria-label="Artifact PDF preview"
    >
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[color:var(--cosmic-border-soft)] px-5 py-4 sm:px-6">
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

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {documentState.status === "ready" ? (
          <ArtifactPdfPageRail
            document={documentState.document}
            pageCount={documentState.document.numPages}
            pageIndex={pageIndex}
            onPageIndexChange={onPageIndexChange}
          />
        ) : null}
        <div
          ref={pageHostRef}
          data-testid="artifact-pdf-pan-layer"
          className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-[#ebe7f0] [scrollbar-gutter:stable] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--cosmic-border)] [&::-webkit-scrollbar-track]:bg-transparent"
          style={{ scrollbarColor: "var(--cosmic-border) transparent", touchAction: "pan-x pan-y" }}
          onTouchStart={handlePanLayerTouchStart}
          onTouchMove={handlePanLayerTouchMove}
          onTouchEnd={handlePanLayerTouchEnd}
          onTouchCancel={handlePanLayerTouchEnd}
        >
          {documentState.status === "loading" || pageRenderState === "loading" ? (
            <PdfPreviewState title="Preparing PDF view" body="You can still open or download the artifact." />
          ) : null}

          {documentState.status === "failed" || pageRenderState === "failed" ? (
            <PdfPreviewState title="Preview unavailable" body="Open or download the artifact to view the PDF." />
          ) : null}

          <div
            data-testid="artifact-pdf-scroll-content"
            className="relative z-0 flex min-h-full min-w-full w-max items-start justify-center px-4 py-5 sm:px-7 sm:py-7"
          >
            <div
              data-testid="artifact-pdf-page-frame"
              data-annotation-overlay-captured="false"
              className={cn(
                "relative shrink-0 overflow-hidden rounded-sm bg-white shadow-[0_18px_50px_rgba(25,19,35,0.28)]",
                showCanvas ? "block" : "hidden",
                pageRenderState !== "ready" && "opacity-35",
              )}
              style={{
                width: pageSize ? `${pageSize.width}px` : undefined,
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
              <ArtifactPdfAnnotationLayer
                pageIndex={pageIndex}
                toolMode={toolMode}
                annotations={pageAnnotations}
                selectedAnnotation={selectedAnnotation}
                draftRect={highlightDraftRect}
                onPointerDown={handleAnnotationLayerPointerDown}
                onPointerMove={handleAnnotationLayerPointerMove}
                onPointerUp={finishHighlightDraft}
                onPointerCancel={cancelHighlightDraft}
                onSelectAnnotation={handleAnnotationSelect}
                onCommentTextChange={handleCommentTextChange}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ArtifactPdfAnnotationLayer({
  pageIndex,
  toolMode,
  annotations,
  selectedAnnotation,
  draftRect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onSelectAnnotation,
  onCommentTextChange,
}: {
  pageIndex: number
  toolMode: ArtifactToolMode
  annotations: ArtifactAnnotation[]
  selectedAnnotation: ArtifactAnnotation | null
  draftRect: NormalizedArtifactRect | null
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: () => void
  onSelectAnnotation: (id: string) => void
  onCommentTextChange: (id: string, value: string) => void
}) {
  return (
    <div
      data-testid="artifact-pdf-annotation-layer"
      data-artifact-tool-mode={toolMode}
      data-annotation-overlay-captured="false"
      className={cn(
        "absolute inset-0 z-10",
        toolMode === "pan" ? "pointer-events-none" : "pointer-events-auto",
        toolMode === "highlight" && "cursor-crosshair",
        toolMode === "comment" && "cursor-copy",
        toolMode === "select" && "cursor-default",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {annotations.map((annotation) => (
        annotation.kind === "highlight" ? (
          <HighlightAnnotation
            key={annotation.id}
            annotation={annotation}
            selected={selectedAnnotation?.id === annotation.id}
            onSelect={onSelectAnnotation}
          />
        ) : (
          <CommentAnnotation
            key={annotation.id}
            annotation={annotation}
            selected={selectedAnnotation?.id === annotation.id}
            onSelect={onSelectAnnotation}
            onTextChange={onCommentTextChange}
          />
        )
      ))}
      {draftRect ? (
        <div
          data-testid="artifact-highlight-draft"
          data-annotation-page-index={String(pageIndex)}
          className="pointer-events-none absolute rounded-[3px] border border-[color:color-mix(in_srgb,var(--sophia-purple)_74%,#facc15)] bg-[color:color-mix(in_srgb,#facc15_32%,var(--sophia-purple)_18%)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_22%,transparent)]"
          style={rectToStyle(draftRect)}
        />
      ) : null}
    </div>
  )
}

function HighlightAnnotation({
  annotation,
  selected,
  onSelect,
}: {
  annotation: Extract<ArtifactAnnotation, { kind: "highlight" }>
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-testid="artifact-highlight-annotation"
      data-annotation-id={annotation.id}
      data-annotation-kind="highlight"
      data-annotation-page-index={String(annotation.pageIndex)}
      data-annotation-x={formatNormalized(annotation.rect.x)}
      data-annotation-y={formatNormalized(annotation.rect.y)}
      data-annotation-width={formatNormalized(annotation.rect.width)}
      data-annotation-height={formatNormalized(annotation.rect.height)}
      aria-label="Highlight annotation"
      aria-pressed={selected}
      className={cn(
        "cosmic-focus-ring absolute rounded-[3px] border bg-[color:color-mix(in_srgb,#facc15_34%,var(--sophia-purple)_16%)] transition hover:bg-[color:color-mix(in_srgb,#facc15_40%,var(--sophia-purple)_22%)]",
        selected
          ? "border-[color:var(--sophia-purple)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--sophia-purple)_34%,transparent),0_0_22px_color-mix(in_srgb,var(--sophia-purple)_26%,transparent)]"
          : "border-[color:color-mix(in_srgb,var(--sophia-purple)_26%,#facc15)]",
      )}
      style={rectToStyle(annotation.rect)}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(annotation.id)
      }}
    />
  )
}

function CommentAnnotation({
  annotation,
  selected,
  onSelect,
  onTextChange,
}: {
  annotation: Extract<ArtifactAnnotation, { kind: "comment" }>
  selected: boolean
  onSelect: (id: string) => void
  onTextChange: (id: string, value: string) => void
}) {
  const popoverAlign = annotation.point.x > 0.72 ? "right-0" : "left-5"
  const popoverSide = annotation.point.y > 0.72 ? "bottom-5" : "top-5"

  return (
    <div
      data-testid="artifact-comment-annotation"
      data-annotation-id={annotation.id}
      data-annotation-kind="comment"
      data-annotation-page-index={String(annotation.pageIndex)}
      data-annotation-x={formatNormalized(annotation.point.x)}
      data-annotation-y={formatNormalized(annotation.point.y)}
      className="absolute"
      style={pointToStyle(annotation.point)}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
    >
      <button
        type="button"
        data-testid="artifact-comment-pin"
        aria-label={annotation.text.trim() ? "Comment annotation" : "Empty comment annotation"}
        aria-pressed={selected}
        className={cn(
          "cosmic-focus-ring flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[11px] font-semibold shadow-[0_8px_22px_rgba(25,19,35,0.22)] transition",
          selected
            ? "border-[color:var(--sophia-purple)] bg-[color:color-mix(in_srgb,var(--sophia-purple)_82%,white)] text-white ring-2 ring-[color:color-mix(in_srgb,var(--sophia-purple)_34%,transparent)]"
            : "border-[color:color-mix(in_srgb,var(--sophia-purple)_46%,white)] bg-[color:color-mix(in_srgb,var(--sophia-purple)_72%,white)] text-white hover:bg-[color:var(--sophia-purple)]",
        )}
        onClick={(event) => {
          event.stopPropagation()
          onSelect(annotation.id)
        }}
      >
        +
      </button>
      {selected ? (
        <label
          className={cn(
            "absolute z-20 flex w-[220px] flex-col gap-1 rounded-lg border border-[color:color-mix(in_srgb,var(--sophia-purple)_36%,var(--cosmic-border-soft))] bg-[color:color-mix(in_srgb,var(--cosmic-panel)_96%,white)] p-2 shadow-[0_18px_44px_rgba(25,19,35,0.24)]",
            popoverAlign,
            popoverSide,
          )}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[color:var(--cosmic-text-muted)]">
            Comment
          </span>
          <textarea
            data-testid="artifact-comment-input"
            aria-label="Comment text"
            value={annotation.text}
            maxLength={180}
            rows={3}
            className="cosmic-focus-ring min-h-[70px] resize-none rounded-md border border-[color:var(--cosmic-border-soft)] bg-white px-2 py-1.5 text-xs leading-relaxed text-[#282233] outline-none"
            placeholder="Add a note"
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onTextChange(annotation.id, event.target.value)}
          />
        </label>
      ) : null}
    </div>
  )
}

function normalizedPointFromPointerEvent(
  event: PointerEvent<HTMLElement>,
  fallbackSize: { width: number; height: number } | null,
): NormalizedArtifactPoint {
  const rect = event.currentTarget.getBoundingClientRect()
  const width = rect.width > 0 ? rect.width : fallbackSize?.width ?? 1
  const height = rect.height > 0 ? rect.height : fallbackSize?.height ?? 1
  return {
    x: clampNormalized((event.clientX - rect.left) / width),
    y: clampNormalized((event.clientY - rect.top) / height),
  }
}

function normalizedRectFromPoints(
  start: NormalizedArtifactPoint,
  end: NormalizedArtifactPoint,
): NormalizedArtifactRect {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return {
    x,
    y,
    width: Math.max(0, Math.max(start.x, end.x) - x),
    height: Math.max(0, Math.max(start.y, end.y) - y),
  }
}

function rectToStyle(rect: NormalizedArtifactRect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }
}

function pointToStyle(point: NormalizedArtifactPoint) {
  return {
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`,
  }
}

function formatNormalized(value: number): string {
  return clampNormalized(value).toFixed(4)
}

function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
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

function pdfTextExtractionStatus(
  status: ArtifactPdfTextExtractionStatusValue,
  overrides: Partial<Omit<ArtifactPdfTextExtractionStatus, "status" | "source">> = {},
): ArtifactPdfTextExtractionStatus {
  return {
    status,
    source: "pdf_text_extraction",
    pageCount: overrides.pageCount ?? 0,
    charCount: overrides.charCount ?? 0,
    truncated: overrides.truncated ?? false,
    safeReason: overrides.safeReason ?? null,
    ...(overrides.text ? { text: overrides.text } : {}),
  }
}

async function extractPdfPlainText(
  document: PdfDocumentProxy,
  signal: AbortSignal,
): Promise<{ text: string; pageCount: number; charCount: number; truncated: boolean }> {
  const pageCount = Math.max(1, Math.floor(document.numPages || 1))
  const chunks: string[] = []
  let charCount = 0
  let truncated = false

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (signal.aborted) {
      break
    }

    const page = await document.getPage(pageNumber)
    const getTextContent = (page as { getTextContent?: () => Promise<unknown> }).getTextContent
    if (typeof getTextContent !== "function") {
      throw new Error("pdf_text_content_unavailable")
    }

    const textContent = await getTextContent.call(page)
    const pageText = textFromPdfTextContent(textContent)
    if (!pageText) {
      continue
    }
    const pageChunk = [`--- Page ${pageNumber} ---`, pageText].filter(Boolean).join("\n")
    charCount += pageChunk.length + (chunks.length > 0 ? 2 : 0)

    if (!truncated) {
      const remaining = MAX_PDF_TEXT_EXTRACTION_CHARS - chunks.join("\n\n").length
      if (remaining > 0 && pageChunk.length <= remaining) {
        chunks.push(pageChunk)
      } else if (remaining > 0) {
        chunks.push(pageChunk.slice(0, remaining))
        truncated = true
      } else {
        truncated = true
      }
    }
  }

  return {
    text: chunks.join("\n\n").trim(),
    pageCount,
    charCount,
    truncated,
  }
}

function textFromPdfTextContent(textContent: unknown): string {
  const items = Array.isArray((textContent as { items?: unknown[] } | null)?.items)
    ? (textContent as { items: unknown[] }).items
    : []
  return items
    .map((item) => {
      const value = (item as { str?: unknown } | null)?.str
      return typeof value === "string" ? value : ""
    })
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
}

function touchDistance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
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
