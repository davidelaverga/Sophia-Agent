"use client"

import { FileText, Layers } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type RefObject, type TouchEvent } from "react"

import type { ArtifactFitMode } from "../../lib/artifact-renderers"
import { clampArtifactZoom } from "../../lib/artifact-renderers"
import {
  buildCoreviewPdfTextLines,
  type CoreviewPdfTextItemLayout,
  type CoreviewPdfTextLayout,
} from "../../lib/coreview-pdf-text-layout"
import { loadPdfJs, type PdfDocumentProxy, type PdfRenderTask } from "../../lib/pdfjs-loader"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import type {
  ArtifactAnnotationColor,
  ArtifactAnnotation,
  ArtifactToolMode,
  NormalizedArtifactLine,
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
  layout?: CoreviewPdfTextLayout
}

export interface ArtifactPdfFocusRequest {
  id: string
  pageIndex: number
  rect: NormalizedArtifactRect
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
  onCreateUnderline?: (rect: NormalizedArtifactRect) => void
  onCreateArrow?: (line: NormalizedArtifactLine) => void
  onSelectAnnotation?: (id: string | null) => void
  onUpdateCommentText?: (id: string, text: string) => void
  focusRequest?: ArtifactPdfFocusRequest | null
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

type PdfPanGestureResult = "success" | "no_scroll_container" | "no_overflow" | "cancelled"

type PdfPanDragState = {
  pointerId: number
  startClientX: number
  startClientY: number
  startScrollLeft: number
  startScrollTop: number
  hadOverflow: boolean
  didScroll: boolean
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
  onCreateUnderline,
  onCreateArrow,
  onSelectAnnotation,
  onUpdateCommentText,
  focusRequest = null,
}: ArtifactPdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const pageHostRef = useRef<HTMLDivElement | null>(null)
  const pageFrameRef = useRef<HTMLDivElement | null>(null)
  const renderTokenRef = useRef(0)
  const activeRenderRef = useRef<ActivePdfRender | null>(null)
  const onPageCountChangeRef = useRef(onPageCountChange)
  const onRenderStatusChangeRef = useRef(onRenderStatusChange)
  const onTextExtractionStatusChangeRef = useRef(onTextExtractionStatusChange)
  const pinchStateRef = useRef<{ distance: number; zoom: number } | null>(null)
  const panDragStateRef = useRef<PdfPanDragState | null>(null)
  const panGestureCountRef = useRef(0)
  const thumbnailAnnotationSignatureRef = useRef<string | null>(null)
  const thumbnailAnnotationRefreshCountRef = useRef(0)
  const [isPanDragging, setIsPanDragging] = useState(false)
  const [annotationDraft, setAnnotationDraft] = useState<{
    kind: "highlight" | "underline" | "arrow"
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
              layout: result.layout,
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

      const canvasContext = canvas.getContext("2d")
      if (!canvasContext) {
        setPageRenderState("failed")
        onRenderStatusChangeRef.current?.({
          ready: false,
          reason: "capture_failed",
          source: "pdf_page_canvas",
          exactTextAvailable: false,
          annotationOverlayCaptured: false,
        })
        return
      }

      const renderTask = page.render({
        canvasContext,
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
        annotationOverlayCaptured: false,
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
  const annotationDraftRect = annotationDraft?.kind === "highlight"
    ? normalizedRectFromPoints(annotationDraft.start, annotationDraft.current)
    : annotationDraft?.kind === "underline"
      ? normalizedUnderlineRectFromPoints(annotationDraft.start, annotationDraft.current)
      : null
  const annotationDraftLine = annotationDraft?.kind === "arrow"
    ? { start: annotationDraft.start, end: annotationDraft.current }
    : null
  const pageAnnotationSignature = useMemo(() => (
    pageAnnotations
      .map(pdfAnnotationSignature)
      .join("|")
  ), [pageAnnotations])
  const annotationPageCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const annotation of annotations) {
      counts.set(annotation.pageIndex, (counts.get(annotation.pageIndex) ?? 0) + 1)
    }
    return counts
  }, [annotations])
  const annotationVersion = useMemo(() => (
    annotations
      .map(pdfAnnotationSignature)
      .join("|")
  ), [annotations])

  useEffect(() => {
    const pageCounts = [...annotationPageCounts.entries()]
      .filter(([, count]) => count > 0)
      .sort(([leftPage], [rightPage]) => leftPage - rightPage)
      .map(([annotationPageIndex, annotationCount]) => ({
        annotationPageIndex,
        annotationCount,
      }))
    const signature = pageCounts
      .map((entry) => `${entry.annotationPageIndex}:${entry.annotationCount}`)
      .join("|")

    if (thumbnailAnnotationSignatureRef.current === signature) {
      return
    }

    thumbnailAnnotationSignatureRef.current = signature
    thumbnailAnnotationRefreshCountRef.current += 1
    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "artifact-thumbnail-annotation-state",
      payload: {
        artifactId: artifactId ?? null,
        artifactPath: file?.path ?? artifact.artifactPath ?? null,
        artifactRendererKind: "pdf",
        thumbnailAnnotationIndicatorMode: "badge",
        thumbnailAnnotationPageCounts: pageCounts,
        thumbnailAnnotationRefreshCount: thumbnailAnnotationRefreshCountRef.current,
        canvasPointerBlockedAfterAnnotation: false,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [annotationPageCounts, artifact.artifactPath, artifactId, file?.path])

  useLayoutEffect(() => {
    const source = canvasRef.current
    const composite = compositeCanvasRef.current
    if (!source || !composite || !pageSize || pageRenderState !== "ready") {
      return
    }

    const drawn = drawPdfCompositeCaptureCanvas(composite, source, {
      pageSize,
      annotations: pageAnnotations,
    })
    if (!drawn) {
      return
    }
    onRenderStatusChangeRef.current?.({
      ready: true,
      reason: null,
      source: "pdf_page_canvas",
      exactTextAvailable: false,
      annotationOverlayCaptured: pageAnnotations.length > 0,
    })
  }, [pageAnnotationSignature, pageAnnotations, pageRenderState, pageSize])

  useLayoutEffect(() => {
    const focusRect = focusRequest?.pageIndex === pageIndex ? focusRequest.rect : null
    if (!focusRect || !pageSize) {
      return
    }
    centerPdfRectInPanLayer({
      panLayer: pageHostRef.current,
      pageFrame: pageFrameRef.current,
      pageSize,
      rect: focusRect,
    })
  }, [focusRequest, pageIndex, pageSize, zoom, fitMode])

  useEffect(() => {
    if (toolMode === "pan") {
      return
    }
    if (panDragStateRef.current) {
      panDragStateRef.current = null
      setIsPanDragging(false)
    }
  }, [toolMode])

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
  const recordPanGesture = useCallback((
    result: PdfPanGestureResult,
    deltaX: number | null = null,
    deltaY: number | null = null,
  ) => {
    panGestureCountRef.current += 1
    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "artifact-pan-gesture",
      payload: {
        artifactId: artifactId ?? null,
        artifactPath: file?.path ?? null,
        artifactRendererKind: "pdf",
        artifactPageIndex: pageIndex,
        artifactPageNumber: pageNumber,
        artifactZoom: zoom,
        artifactFitMode: fitMode,
        artifactToolMode: toolMode,
        panModeActive: toolMode === "pan",
        panGestureCount: panGestureCountRef.current,
        panGestureResult: result,
        panScrollDeltaX: deltaX === null ? null : Math.round(deltaX),
        panScrollDeltaY: deltaY === null ? null : Math.round(deltaY),
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
        rawCommentTextExcluded: true,
      },
    })
  }, [artifactId, file?.path, fitMode, pageIndex, pageNumber, toolMode, zoom])
  const finishPanDrag = useCallback((
    event: PointerEvent<HTMLDivElement> | null,
    resultOverride?: PdfPanGestureResult,
  ) => {
    const dragState = panDragStateRef.current
    if (!dragState) {
      return
    }

    const panLayer = pageHostRef.current
    const deltaX = panLayer ? panLayer.scrollLeft - dragState.startScrollLeft : 0
    const deltaY = panLayer ? panLayer.scrollTop - dragState.startScrollTop : 0
    const result = resultOverride ?? (
      dragState.didScroll
        ? "success"
        : dragState.hadOverflow
          ? "cancelled"
          : "no_overflow"
    )

    if (event) {
      event.preventDefault()
      event.stopPropagation()
      try {
        event.currentTarget.releasePointerCapture(dragState.pointerId)
      } catch {
        // Pointer capture release is optional across browsers and tests.
      }
    }

    panDragStateRef.current = null
    setIsPanDragging(false)
    recordPanGesture(result, deltaX, deltaY)
  }, [recordPanGesture])
  const handlePanLayerPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!showCanvas || toolMode !== "pan" || event.button !== 0) {
      return
    }

    const panLayer = pageHostRef.current ?? event.currentTarget
    if (!panLayer) {
      event.preventDefault()
      event.stopPropagation()
      recordPanGesture("no_scroll_container")
      return
    }

    const overflow = getPdfPanOverflow(panLayer)

    event.preventDefault()
    event.stopPropagation()
    panDragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: panLayer.scrollLeft,
      startScrollTop: panLayer.scrollTop,
      hadOverflow: overflow.hasOverflow,
      didScroll: false,
    }
    setIsPanDragging(true)

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Dragging still works while the pointer remains over the pan layer.
    }
  }, [recordPanGesture, showCanvas, toolMode])
  const handlePanLayerPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const dragState = panDragStateRef.current
    if (dragState?.pointerId !== event.pointerId) {
      return
    }

    const panLayer = pageHostRef.current
    if (!panLayer) {
      finishPanDrag(event, "no_scroll_container")
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const overflow = getPdfPanOverflow(panLayer)
    dragState.hadOverflow = dragState.hadOverflow || overflow.hasOverflow
    const nextScrollLeft = clampScroll(
      dragState.startScrollLeft - (event.clientX - dragState.startClientX),
      overflow.maxScrollLeft,
    )
    const nextScrollTop = clampScroll(
      dragState.startScrollTop - (event.clientY - dragState.startClientY),
      overflow.maxScrollTop,
    )
    panLayer.scrollLeft = nextScrollLeft
    panLayer.scrollTop = nextScrollTop
    dragState.didScroll = dragState.didScroll
      || Math.abs(nextScrollLeft - dragState.startScrollLeft) > 0
      || Math.abs(nextScrollTop - dragState.startScrollTop) > 0
  }, [finishPanDrag])
  const handlePanLayerPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (panDragStateRef.current?.pointerId !== event.pointerId) {
      return
    }
    finishPanDrag(event)
  }, [finishPanDrag])
  const handlePanLayerPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (panDragStateRef.current?.pointerId !== event.pointerId) {
      return
    }
    finishPanDrag(event, "cancelled")
  }, [finishPanDrag])
  const handlePanLayerPointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (
      panDragStateRef.current?.pointerId !== event.pointerId
      || event.currentTarget.hasPointerCapture?.(event.pointerId)
    ) {
      return
    }
    finishPanDrag(event, "cancelled")
  }, [finishPanDrag])
  const handlePanLayerLostPointerCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (panDragStateRef.current?.pointerId !== event.pointerId) {
      return
    }
    finishPanDrag(event, "cancelled")
  }, [finishPanDrag])
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

    if (toolMode === "highlight" || toolMode === "underline" || toolMode === "arrow") {
      setAnnotationDraft({ kind: toolMode, start: point, current: point })
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is optional; the layer still handles normal pointerup.
    }
  }, [onCreateComment, onSelectAnnotation, pageSize, showCanvas, toolMode])
  const handleAnnotationLayerPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (toolMode !== annotationDraft?.kind) {
      return
    }

    event.preventDefault()
    const point = normalizedPointFromPointerEvent(event, pageSize)
    setAnnotationDraft((current) => (
      current
        ? { ...current, current: point }
        : current
    ))
  }, [annotationDraft, pageSize, toolMode])
  const finishAnnotationDraft = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (toolMode !== annotationDraft?.kind) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const endPoint = normalizedPointFromPointerEvent(event, pageSize)
    const draft = { ...annotationDraft, current: endPoint }
    setAnnotationDraft(null)

    if (draft.kind === "arrow") {
      const line = normalizedLineFromPoints(draft.start, draft.current)
      if (line) {
        onCreateArrow?.(line)
      }
      return
    }

    const rect = draft.kind === "underline"
      ? normalizedUnderlineRectFromPoints(draft.start, draft.current)
      : normalizedRectFromPoints(draft.start, draft.current)

    if (
      rect.width < MIN_NORMALIZED_HIGHLIGHT_SIZE
      || (draft.kind === "highlight" && rect.height < MIN_NORMALIZED_HIGHLIGHT_SIZE)
    ) {
      return
    }

    if (draft.kind === "underline") {
      onCreateUnderline?.(rect)
    } else {
      onCreateHighlight?.(rect)
    }
  }, [annotationDraft, onCreateArrow, onCreateHighlight, onCreateUnderline, pageSize, toolMode])
  const cancelAnnotationDraft = useCallback(() => {
    setAnnotationDraft(null)
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
            annotationPageCounts={annotationPageCounts}
            annotationVersion={annotationVersion}
          />
        ) : null}
        <div
          ref={pageHostRef}
          data-testid="artifact-pdf-pan-layer"
          data-pan-mode-active={toolMode === "pan" ? "true" : "false"}
          data-pan-dragging={isPanDragging ? "true" : "false"}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-auto bg-[#ebe7f0] [scrollbar-gutter:stable] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--cosmic-border)] [&::-webkit-scrollbar-track]:bg-transparent",
            toolMode === "pan" && (isPanDragging ? "cursor-grabbing select-none" : "cursor-grab"),
          )}
          style={{
            scrollbarColor: "var(--cosmic-border) transparent",
            touchAction: toolMode === "pan" ? "none" : "pan-x pan-y",
          }}
          onPointerDown={handlePanLayerPointerDown}
          onPointerMove={handlePanLayerPointerMove}
          onPointerUp={handlePanLayerPointerUp}
          onPointerCancel={handlePanLayerPointerCancel}
          onPointerLeave={handlePanLayerPointerLeave}
          onLostPointerCapture={handlePanLayerLostPointerCapture}
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
              ref={pageFrameRef}
              data-testid="artifact-pdf-page-frame"
              data-annotation-overlay-captured={pageAnnotations.length > 0 ? "true" : "false"}
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
                draftRect={annotationDraftRect}
                draftLine={annotationDraftLine}
                onPointerDown={handleAnnotationLayerPointerDown}
                onPointerMove={handleAnnotationLayerPointerMove}
                onPointerUp={finishAnnotationDraft}
                onPointerCancel={cancelAnnotationDraft}
                onSelectAnnotation={handleAnnotationSelect}
                onCommentTextChange={handleCommentTextChange}
              />
            </div>
            <canvas
              ref={compositeCanvasRef}
              data-testid="artifact-pdf-composite-canvas"
              data-artifact-region="true"
              data-coreview-artifact-region="true"
              data-artifact-id={artifactId ?? undefined}
              data-coreview-artifact-id={artifactId ?? undefined}
              data-artifact-canvas={artifactId ? "true" : undefined}
              data-coreview-artifact-canvas={artifactId ? "true" : undefined}
              data-artifact-canvas-source="selected-pdf-page-composite"
              data-coreview-offscreen-render="true"
              data-annotation-overlay-captured={pageAnnotations.length > 0 ? "true" : "false"}
              aria-hidden="true"
              className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
            />
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
  draftLine,
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
  draftLine: NormalizedArtifactLine | null
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
      data-annotation-overlay-captured={annotations.length > 0 ? "true" : "false"}
      className={cn(
        "absolute inset-0 z-10",
        toolMode === "pan" ? "pointer-events-none" : "pointer-events-auto",
        toolMode === "highlight" && "cursor-crosshair",
        toolMode === "underline" && "cursor-crosshair",
        toolMode === "arrow" && "cursor-crosshair",
        toolMode === "comment" && "cursor-copy",
        toolMode === "select" && "cursor-default",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {annotations.map((annotation) => (
        <PdfAnnotation
          key={annotation.id}
          annotation={annotation}
          selected={selectedAnnotation?.id === annotation.id}
          onSelect={onSelectAnnotation}
          onCommentTextChange={onCommentTextChange}
        />
      ))}
      {draftRect ? (
        <div
          data-testid={toolMode === "underline" ? "artifact-underline-draft" : "artifact-highlight-draft"}
          data-annotation-page-index={String(pageIndex)}
          className={cn(
            "pointer-events-none absolute rounded-[3px] border shadow-[0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_22%,transparent)]",
            toolMode === "underline"
              ? "border-transparent bg-transparent"
              : "border-[color:color-mix(in_srgb,var(--sophia-purple)_74%,#facc15)] bg-[color:color-mix(in_srgb,#facc15_32%,var(--sophia-purple)_18%)]",
          )}
          style={rectToStyle(draftRect)}
        >
          {toolMode === "underline" ? (
            <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-full bg-[color:var(--sophia-purple)] shadow-[0_0_10px_color-mix(in_srgb,var(--sophia-purple)_34%,transparent)]" />
          ) : null}
        </div>
      ) : null}
      {draftLine ? (
        <div
          data-testid="artifact-arrow-draft"
          data-annotation-page-index={String(pageIndex)}
          className="pointer-events-none absolute overflow-visible"
          style={lineBoundsToStyle(draftLine)}
        >
          <ArrowAnnotationSvg
            testId="artifact-arrow-draft-vector"
            line={draftLine}
            color="purple"
            selected={false}
            pageIndex={pageIndex}
          />
        </div>
      ) : null}
    </div>
  )
}

function PdfAnnotation({
  annotation,
  selected,
  onSelect,
  onCommentTextChange,
}: {
  annotation: ArtifactAnnotation
  selected: boolean
  onSelect: (id: string) => void
  onCommentTextChange: (id: string, value: string) => void
}) {
  switch (annotation.kind) {
    case "highlight":
      return <HighlightAnnotation annotation={annotation} selected={selected} onSelect={onSelect} />
    case "comment":
      return (
        <CommentAnnotation
          annotation={annotation}
          selected={selected}
          onSelect={onSelect}
          onTextChange={onCommentTextChange}
        />
      )
    case "underline":
      return <UnderlineAnnotation annotation={annotation} selected={selected} onSelect={onSelect} />
    case "arrow":
      return <ArrowAnnotation annotation={annotation} selected={selected} onSelect={onSelect} />
    default:
      return null
  }
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
      data-annotation-color={annotation.color ?? "yellow"}
      data-annotation-source={annotation.source ?? "user"}
      aria-label="Highlight annotation"
      aria-pressed={selected}
      className={cn(
        "cosmic-focus-ring absolute rounded-[3px] border transition",
        selected
          ? "border-[color:var(--sophia-purple)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--sophia-purple)_34%,transparent),0_0_22px_color-mix(in_srgb,var(--sophia-purple)_26%,transparent)]"
          : "border-[color:color-mix(in_srgb,var(--sophia-purple)_26%,#facc15)]",
      )}
      style={{
        ...rectToStyle(annotation.rect),
        ...highlightAnnotationStyle(annotation.color ?? "yellow"),
      }}
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

function UnderlineAnnotation({
  annotation,
  selected,
  onSelect,
}: {
  annotation: Extract<ArtifactAnnotation, { kind: "underline" }>
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-testid="artifact-underline-annotation"
      data-annotation-id={annotation.id}
      data-annotation-kind="underline"
      data-annotation-page-index={String(annotation.pageIndex)}
      data-annotation-x={formatNormalized(annotation.rect.x)}
      data-annotation-y={formatNormalized(annotation.rect.y)}
      data-annotation-width={formatNormalized(annotation.rect.width)}
      data-annotation-height={formatNormalized(annotation.rect.height)}
      data-annotation-color={annotation.color ?? "purple"}
      data-annotation-source={annotation.source ?? "user"}
      aria-label="Underline annotation"
      aria-pressed={selected}
      className={cn(
        "cosmic-focus-ring absolute rounded-[3px] border bg-transparent transition",
        selected
          ? "border-[color:var(--sophia-purple)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--sophia-purple)_30%,transparent)]"
          : "border-transparent",
      )}
      style={rectToStyle(annotation.rect)}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(annotation.id)
      }}
    >
      <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-full bg-[color:var(--sophia-purple)] shadow-[0_0_10px_color-mix(in_srgb,var(--sophia-purple)_30%,transparent)]" />
    </button>
  )
}

function ArrowAnnotation({
  annotation,
  selected,
  onSelect,
}: {
  annotation: Extract<ArtifactAnnotation, { kind: "arrow" }>
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-testid="artifact-arrow-annotation"
      data-annotation-id={annotation.id}
      data-annotation-kind="arrow"
      data-annotation-page-index={String(annotation.pageIndex)}
      data-annotation-start-x={formatNormalized(annotation.line.start.x)}
      data-annotation-start-y={formatNormalized(annotation.line.start.y)}
      data-annotation-end-x={formatNormalized(annotation.line.end.x)}
      data-annotation-end-y={formatNormalized(annotation.line.end.y)}
      data-annotation-color={annotation.color ?? "purple"}
      data-annotation-source={annotation.source ?? "user"}
      aria-label="Arrow annotation"
      aria-pressed={selected}
      className={cn(
        "cosmic-focus-ring absolute overflow-visible rounded-[3px] border bg-transparent p-0 transition",
        selected
          ? "border-[color:color-mix(in_srgb,var(--sophia-purple)_42%,transparent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--sophia-purple)_22%,transparent)]"
          : "border-transparent",
      )}
      style={lineBoundsToStyle(annotation.line)}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(annotation.id)
      }}
    >
      <ArrowAnnotationSvg
        testId="artifact-arrow-vector"
        line={annotation.line}
        color={annotation.color ?? "purple"}
        selected={selected}
        pageIndex={annotation.pageIndex}
      />
    </button>
  )
}

function ArrowAnnotationSvg({
  testId,
  line,
  color,
  selected,
  pageIndex,
}: {
  testId: string
  line: NormalizedArtifactLine
  color: ArtifactAnnotationColor
  selected: boolean
  pageIndex: number
}) {
  const vector = lineVectorToSvg(line)
  const stroke = color === "yellow"
    ? "#a16207"
    : color === "blue"
      ? "#2563eb"
      : color === "pink"
        ? "#be185d"
        : "#7c4cca"
  const markerId = `${testId}-${pageIndex}-${Math.round(vector.x1)}-${Math.round(vector.y1)}-${Math.round(vector.x2)}-${Math.round(vector.y2)}`
  return (
    <svg
      data-testid={testId}
      data-annotation-page-index={String(pageIndex)}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={cn("pointer-events-none absolute inset-0 overflow-visible", selected && "drop-shadow-[0_0_8px_rgba(124,76,202,0.35)]")}
      aria-hidden="true"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="6.8"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L8,4 L0,8 Z" fill={stroke} />
        </marker>
      </defs>
      <line
        x1={vector.x1}
        y1={vector.y1}
        x2={vector.x2}
        y2={vector.y2}
        stroke={stroke}
        strokeWidth={selected ? 4.5 : 3.5}
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
    </svg>
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
      data-annotation-source={annotation.source ?? "user"}
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

function normalizedUnderlineRectFromPoints(
  start: NormalizedArtifactPoint,
  end: NormalizedArtifactPoint,
): NormalizedArtifactRect {
  const rect = normalizedRectFromPoints(start, end)
  const height = Math.max(rect.height, 0.012)
  return {
    x: rect.x,
    y: Math.min(rect.y, 1 - height),
    width: rect.width,
    height,
  }
}

function normalizedLineFromPoints(
  start: NormalizedArtifactPoint,
  end: NormalizedArtifactPoint,
): NormalizedArtifactLine | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_NORMALIZED_HIGHLIGHT_SIZE) {
    return null
  }
  return { start, end }
}

function rectToStyle(rect: NormalizedArtifactRect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }
}

function lineBoundsToStyle(line: NormalizedArtifactLine) {
  const bounds = lineBounds(line)
  return {
    left: `${bounds.x * 100}%`,
    top: `${bounds.y * 100}%`,
    width: `${bounds.width * 100}%`,
    height: `${bounds.height * 100}%`,
  }
}

function lineVectorToSvg(line: NormalizedArtifactLine) {
  const bounds = lineBounds(line)
  return {
    x1: ((line.start.x - bounds.x) / bounds.width) * 100,
    y1: ((line.start.y - bounds.y) / bounds.height) * 100,
    x2: ((line.end.x - bounds.x) / bounds.width) * 100,
    y2: ((line.end.y - bounds.y) / bounds.height) * 100,
  }
}

function lineBounds(line: NormalizedArtifactLine): NormalizedArtifactRect {
  const minDimension = 0.012
  const centerX = (line.start.x + line.end.x) / 2
  const centerY = (line.start.y + line.end.y) / 2
  const width = Math.max(Math.abs(line.end.x - line.start.x), minDimension)
  const height = Math.max(Math.abs(line.end.y - line.start.y), minDimension)
  const safeWidth = Math.min(width, 1)
  const safeHeight = Math.min(height, 1)
  return {
    x: Math.min(Math.max(0, centerX - safeWidth / 2), 1 - safeWidth),
    y: Math.min(Math.max(0, centerY - safeHeight / 2), 1 - safeHeight),
    width: safeWidth,
    height: safeHeight,
  }
}

function pdfAnnotationSignature(annotation: ArtifactAnnotation): string {
  if (annotation.kind === "highlight" || annotation.kind === "underline") {
    return [
      annotation.id,
      annotation.kind,
      annotation.color ?? "yellow",
      annotation.rect.x.toFixed(4),
      annotation.rect.y.toFixed(4),
      annotation.rect.width.toFixed(4),
      annotation.rect.height.toFixed(4),
    ].join(":")
  }
  if (annotation.kind === "arrow") {
    return [
      annotation.id,
      annotation.kind,
      annotation.color ?? "purple",
      annotation.line.start.x.toFixed(4),
      annotation.line.start.y.toFixed(4),
      annotation.line.end.x.toFixed(4),
      annotation.line.end.y.toFixed(4),
    ].join(":")
  }
  return [
    annotation.id,
    annotation.kind,
    annotation.point.x.toFixed(4),
    annotation.point.y.toFixed(4),
    annotation.text.length,
  ].join(":")
}

function pointToStyle(point: NormalizedArtifactPoint) {
  return {
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`,
  }
}

function highlightAnnotationStyle(color: ArtifactAnnotationColor) {
  const palette = annotationColorPalette(color)
  return {
    backgroundColor: palette.background,
    borderColor: palette.border,
  }
}

function drawPdfCompositeCaptureCanvas(
  composite: HTMLCanvasElement,
  source: HTMLCanvasElement,
  input: {
    pageSize: { width: number; height: number }
    annotations: ArtifactAnnotation[]
  },
): boolean {
  const context = get2dCanvasContext(composite)
  if (!context || typeof context.drawImage !== "function") {
    return false
  }

  const width = Math.max(1, source.width || Math.round(input.pageSize.width))
  const height = Math.max(1, source.height || Math.round(input.pageSize.height))
  const dprX = width / Math.max(1, input.pageSize.width)
  const dprY = height / Math.max(1, input.pageSize.height)

  composite.width = width
  composite.height = height
  composite.style.width = `${input.pageSize.width}px`
  composite.style.height = `${input.pageSize.height}px`
  safeClearRect(context, 0, 0, width, height)
  try {
    context.drawImage(source, 0, 0, width, height)
  } catch {
    return false
  }

  for (const annotation of input.annotations) {
    if (annotation.kind === "highlight") {
      const palette = annotationColorPalette(annotation.color ?? "yellow")
      const x = annotation.rect.x * width
      const y = annotation.rect.y * height
      const rectWidth = annotation.rect.width * width
      const rectHeight = annotation.rect.height * height
      context.fillStyle = palette.captureFill
      safeFillRect(context, x, y, rectWidth, rectHeight)
      context.strokeStyle = palette.captureStroke
      context.lineWidth = Math.max(1, Math.min(dprX, dprY))
      safeStrokeRect(context, x, y, rectWidth, rectHeight)
      continue
    }
    if (annotation.kind === "underline") {
      const palette = annotationColorPalette(annotation.color ?? "purple")
      const x = annotation.rect.x * width
      const y = (annotation.rect.y + annotation.rect.height) * height
      const rectWidth = annotation.rect.width * width
      context.strokeStyle = palette.captureStroke
      context.lineWidth = Math.max(3, Math.round(3 * Math.min(dprX, dprY)))
      safeBeginPath(context)
      safeMoveTo(context, x, y)
      safeLineTo(context, x + rectWidth, y)
      safeStroke(context)
      continue
    }
    if (annotation.kind === "arrow") {
      const palette = annotationColorPalette(annotation.color ?? "purple")
      drawCanvasArrow(context, annotation.line, {
        width,
        height,
        stroke: palette.captureStroke,
        scale: Math.min(dprX, dprY),
      })
      continue
    }

    const x = annotation.point.x * width
    const y = annotation.point.y * height
    const radius = Math.max(9, Math.round(11 * Math.min(dprX, dprY)))
    context.fillStyle = "rgba(124, 76, 202, 0.92)"
    context.strokeStyle = "rgba(255, 255, 255, 0.96)"
    context.lineWidth = Math.max(2, Math.round(2 * Math.min(dprX, dprY)))
    safeBeginPath(context)
    safeArc(context, x, y, radius, 0, Math.PI * 2)
    safeFill(context)
    safeStroke(context)
    context.fillStyle = "#ffffff"
    context.font = `${Math.max(13, Math.round(14 * Math.min(dprX, dprY)))}px system-ui, sans-serif`
    context.textAlign = "center"
    context.textBaseline = "middle"
    safeFillText(context, "+", x, y - Math.max(1, radius * 0.04))
  }

  return true
}

function centerPdfRectInPanLayer({
  panLayer,
  pageFrame,
  pageSize,
  rect,
}: {
  panLayer: HTMLDivElement | null
  pageFrame: HTMLDivElement | null
  pageSize: { width: number; height: number }
  rect: NormalizedArtifactRect
}) {
  if (!panLayer || !pageFrame) {
    return
  }
  const targetX = pageFrame.offsetLeft + (rect.x + rect.width / 2) * pageSize.width
  const targetY = pageFrame.offsetTop + (rect.y + rect.height / 2) * pageSize.height
  const left = clampScroll(targetX - panLayer.clientWidth / 2, panLayer.scrollWidth - panLayer.clientWidth)
  const top = clampScroll(targetY - panLayer.clientHeight / 2, panLayer.scrollHeight - panLayer.clientHeight)

  if (typeof panLayer.scrollTo === "function") {
    panLayer.scrollTo({ left, top, behavior: "auto" })
  } else {
    panLayer.scrollLeft = left
    panLayer.scrollTop = top
  }
}

function getPdfPanOverflow(panLayer: HTMLElement): {
  maxScrollLeft: number
  maxScrollTop: number
  hasOverflow: boolean
} {
  const maxScrollLeft = Math.max(0, panLayer.scrollWidth - panLayer.clientWidth)
  const maxScrollTop = Math.max(0, panLayer.scrollHeight - panLayer.clientHeight)
  return {
    maxScrollLeft,
    maxScrollTop,
    hasOverflow: maxScrollLeft > 0 || maxScrollTop > 0,
  }
}

function annotationColorPalette(color: ArtifactAnnotationColor) {
  switch (color) {
    case "purple":
      return {
        background: "color-mix(in srgb, var(--sophia-purple) 30%, transparent)",
        border: "color-mix(in srgb, var(--sophia-purple) 58%, white)",
        captureFill: "rgba(147, 97, 216, 0.34)",
        captureStroke: "rgba(124, 76, 202, 0.62)",
      }
    case "blue":
      return {
        background: "rgba(96, 165, 250, 0.28)",
        border: "rgba(59, 130, 246, 0.58)",
        captureFill: "rgba(96, 165, 250, 0.34)",
        captureStroke: "rgba(37, 99, 235, 0.62)",
      }
    case "pink":
      return {
        background: "rgba(244, 114, 182, 0.28)",
        border: "rgba(219, 39, 119, 0.54)",
        captureFill: "rgba(244, 114, 182, 0.34)",
        captureStroke: "rgba(190, 24, 93, 0.62)",
      }
    case "yellow":
    default:
      return {
        background: "color-mix(in srgb, #facc15 34%, var(--sophia-purple) 16%)",
        border: "color-mix(in srgb, var(--sophia-purple) 26%, #facc15)",
        captureFill: "rgba(250, 204, 21, 0.36)",
        captureStroke: "rgba(161, 98, 7, 0.54)",
      }
  }
}

function get2dCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d")
  } catch {
    return null
  }
}

function safeClearRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  if (typeof context.clearRect === "function") {
    context.clearRect(x, y, width, height)
  }
}

function safeFillRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  if (typeof context.fillRect === "function") {
    context.fillRect(x, y, width, height)
  }
}

function safeStrokeRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  if (typeof context.strokeRect === "function") {
    context.strokeRect(x, y, width, height)
  }
}

function safeBeginPath(context: CanvasRenderingContext2D) {
  if (typeof context.beginPath === "function") {
    context.beginPath()
  }
}

function safeMoveTo(context: CanvasRenderingContext2D, x: number, y: number) {
  if (typeof context.moveTo === "function") {
    context.moveTo(x, y)
  }
}

function safeLineTo(context: CanvasRenderingContext2D, x: number, y: number) {
  if (typeof context.lineTo === "function") {
    context.lineTo(x, y)
  }
}

function safeArc(context: CanvasRenderingContext2D, x: number, y: number, radius: number, startAngle: number, endAngle: number) {
  if (typeof context.arc === "function") {
    context.arc(x, y, radius, startAngle, endAngle)
  }
}

function safeFill(context: CanvasRenderingContext2D) {
  if (typeof context.fill === "function") {
    context.fill()
  }
}

function safeStroke(context: CanvasRenderingContext2D) {
  if (typeof context.stroke === "function") {
    context.stroke()
  }
}

function safeFillText(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  if (typeof context.fillText === "function") {
    context.fillText(text, x, y)
  }
}

function drawCanvasArrow(
  context: CanvasRenderingContext2D,
  line: NormalizedArtifactLine,
  input: {
    width: number
    height: number
    stroke: string
    scale: number
  },
) {
  const startX = line.start.x * input.width
  const startY = line.start.y * input.height
  const endX = line.end.x * input.width
  const endY = line.end.y * input.height
  const angle = Math.atan2(endY - startY, endX - startX)
  const headLength = Math.max(10, Math.round(13 * input.scale))
  const headAngle = Math.PI / 7

  context.strokeStyle = input.stroke
  context.fillStyle = input.stroke
  context.lineWidth = Math.max(3, Math.round(3 * input.scale))
  safeBeginPath(context)
  safeMoveTo(context, startX, startY)
  safeLineTo(context, endX, endY)
  safeStroke(context)
  safeBeginPath(context)
  safeMoveTo(context, endX, endY)
  safeLineTo(context, endX - headLength * Math.cos(angle - headAngle), endY - headLength * Math.sin(angle - headAngle))
  safeLineTo(context, endX - headLength * Math.cos(angle + headAngle), endY - headLength * Math.sin(angle + headAngle))
  safeLineTo(context, endX, endY)
  safeFill(context)
}

function clampScroll(value: number, max: number): number {
  const safeMax = Number.isFinite(max) ? Math.max(0, max) : 0
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(safeMax, Math.max(0, value))
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
    ...(overrides.layout ? { layout: overrides.layout } : {}),
  }
}

async function extractPdfPlainText(
  document: PdfDocumentProxy,
  signal: AbortSignal,
): Promise<{ text: string; pageCount: number; charCount: number; truncated: boolean; layout: CoreviewPdfTextLayout }> {
  const pageCount = Math.max(1, Math.floor(document.numPages || 1))
  const chunks: string[] = []
  const pages: CoreviewPdfTextLayout["pages"] = []
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
    const baseViewport = typeof (page as { getViewport?: unknown }).getViewport === "function"
      ? (page as { getViewport: (input: { scale: number }) => { width: number; height: number; convertToViewportRectangle?: (rect: number[]) => number[] } }).getViewport({ scale: 1 })
      : null
    const pageWidth = positiveNumber(baseViewport?.width) ?? 1
    const pageHeight = positiveNumber(baseViewport?.height) ?? 1
    pages.push(buildCoreviewPdfTextLines(
      pageNumber - 1,
      pageWidth,
      pageHeight,
      textItemsFromPdfTextContent(textContent, {
        pageIndex: pageNumber - 1,
        pageWidth,
        pageHeight,
        convertToViewportRectangle: typeof baseViewport?.convertToViewportRectangle === "function"
          ? baseViewport.convertToViewportRectangle.bind(baseViewport)
          : null,
      }),
    ))
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
    layout: {
      pageCount,
      pages,
      rawTextExcluded: true,
    },
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

function textItemsFromPdfTextContent(
  textContent: unknown,
  layout: {
    pageIndex: number
    pageWidth: number
    pageHeight: number
    convertToViewportRectangle: ((rect: number[]) => number[]) | null
  },
): CoreviewPdfTextItemLayout[] {
  const items = Array.isArray((textContent as { items?: unknown[] } | null)?.items)
    ? (textContent as { items: unknown[] }).items
    : []
  return items
    .map((item) => pdfTextItemLayout(item, layout))
    .filter((item): item is CoreviewPdfTextItemLayout => item !== null)
}

function pdfTextItemLayout(
  item: unknown,
  layout: {
    pageIndex: number
    pageWidth: number
    pageHeight: number
    convertToViewportRectangle: ((rect: number[]) => number[]) | null
  },
): CoreviewPdfTextItemLayout | null {
  const record = isRecord(item) ? item : null
  const text = typeof record?.str === "string" ? record.str.replace(/\s+/gu, " ").trim() : ""
  if (!text) {
    return null
  }
  const transform = Array.isArray(record?.transform)
    ? record.transform.map((value) => Number(value))
    : []
  if (transform.length < 6 || transform.some((value) => !Number.isFinite(value))) {
    return null
  }
  const x = transform[4] ?? 0
  const y = transform[5] ?? 0
  const width = positiveNumber(record?.width) ?? estimateTextItemWidth(text, transform)
  const height = positiveNumber(record?.height) ?? Math.max(Math.hypot(transform[2] ?? 0, transform[3] ?? 0), 1)
  const rect = normalizedTextRect({
    x,
    y,
    width,
    height,
    pageWidth: layout.pageWidth,
    pageHeight: layout.pageHeight,
    convertToViewportRectangle: layout.convertToViewportRectangle,
  })
  if (!rect) {
    return null
  }
  return {
    pageIndex: layout.pageIndex,
    text,
    rect,
    fontHeight: rect.height,
  }
}

function normalizedTextRect(input: {
  x: number
  y: number
  width: number
  height: number
  pageWidth: number
  pageHeight: number
  convertToViewportRectangle: ((rect: number[]) => number[]) | null
}): NormalizedArtifactRect | null {
  let left: number
  let top: number
  let right: number
  let bottom: number
  if (input.convertToViewportRectangle) {
    const viewportRect = input.convertToViewportRectangle([
      input.x,
      input.y,
      input.x + input.width,
      input.y + input.height,
    ])
    if (viewportRect.length < 4 || viewportRect.some((value) => !Number.isFinite(value))) {
      return null
    }
    left = Math.min(viewportRect[0] ?? 0, viewportRect[2] ?? 0)
    top = Math.min(viewportRect[1] ?? 0, viewportRect[3] ?? 0)
    right = Math.max(viewportRect[0] ?? 0, viewportRect[2] ?? 0)
    bottom = Math.max(viewportRect[1] ?? 0, viewportRect[3] ?? 0)
  } else {
    left = input.x
    right = input.x + input.width
    top = input.pageHeight - input.y - input.height
    bottom = input.pageHeight - input.y
  }
  const rect = {
    x: left / input.pageWidth,
    y: top / input.pageHeight,
    width: (right - left) / input.pageWidth,
    height: (bottom - top) / input.pageHeight,
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  return {
    x: clampNormalized(rect.x),
    y: clampNormalized(rect.y),
    width: Math.min(1 - clampNormalized(rect.x), Math.max(0, rect.width)),
    height: Math.min(1 - clampNormalized(rect.y), Math.max(0, rect.height)),
  }
}

function estimateTextItemWidth(text: string, transform: number[]): number {
  const fontWidth = Math.max(Math.hypot(transform[0] ?? 0, transform[1] ?? 0), 1)
  return Math.max(fontWidth, text.length * fontWidth * 0.52)
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
