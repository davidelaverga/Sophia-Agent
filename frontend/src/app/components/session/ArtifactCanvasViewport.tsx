"use client"

import { FileText, Layers, ListChecks, Sparkles } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"

import type { ArtifactFitMode, ArtifactRendererKind } from "../../lib/artifact-renderers"
import { detectArtifactRendererKind } from "../../lib/artifact-renderers"
import { isMarkdownArtifactFile } from "../../lib/builder-artifacts"
import {
  registerCoreviewArtifactText,
  registerCoreviewArtifactTextStatus,
} from "../../lib/coreview-artifact-text"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import type {
  ArtifactAnnotation,
  ArtifactToolMode,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../../types/artifact-annotations"
import type { BuilderArtifactFileV1, BuilderArtifactV1 } from "../../types/builder-artifact"

import { ArtifactMarkdownPreview } from "./ArtifactMarkdownPreview"
import { ArtifactPdfPreview, type ArtifactPdfTextExtractionStatus } from "./ArtifactPdfPreview"

type ArtifactViewportFile = BuilderArtifactFileV1 & {
  mimeType?: string
  sizeBytes?: number
}

export type ArtifactVisualCaptureUnavailableReason =
  | "no_selected_artifact"
  | "preview_not_ready"
  | "capture_target_missing"
  | "capture_failed"
  | "exact_text_only_no_visual_source"

export interface ArtifactVisualCaptureStatus {
  ready: boolean
  reason: ArtifactVisualCaptureUnavailableReason | null
  source: "markdown_preview_canvas" | "metadata_canvas" | "pdf_page_canvas" | "none"
  exactTextAvailable: boolean
  pdfTextExtractionStatus?: ArtifactPdfTextExtractionStatus["status"] | null
  pdfTextExtractionSource?: ArtifactPdfTextExtractionStatus["source"] | null
  pdfTextExtractionPageCount?: number | null
  pdfTextExtractionCharCount?: number | null
  pdfTextExtractionTruncated?: boolean | null
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
  onVisualCaptureStatusChange?: (status: ArtifactVisualCaptureStatus) => void
  reviewSurfaceState?: ArtifactReviewSurfaceState
  rendererKind?: ArtifactRendererKind
  pageIndex?: number
  pageCount?: number
  zoom?: number
  fitMode?: ArtifactFitMode
  onPageIndexChange?: (pageIndex: number) => void
  onPageCountChange?: (pageCount: number) => void
  onPinchZoomChange?: (zoom: number) => void
  toolMode?: ArtifactToolMode
  annotations?: ArtifactAnnotation[]
  selectedAnnotationId?: string | null
  onCreateHighlight?: (rect: NormalizedArtifactRect) => void
  onCreateComment?: (point: NormalizedArtifactPoint) => void
  onSelectAnnotation?: (id: string | null) => void
  onUpdateCommentText?: (id: string, text: string) => void
  className?: string
}

export type ArtifactReviewSurfaceState = "idle" | "preparing" | "active" | "unavailable"

const MARKDOWN_CAPTURE_CANVAS_WIDTH = 960
const MARKDOWN_CAPTURE_CANVAS_HEIGHT = 1240
const MAX_CAPTURE_BLOCKS = 28
const ARTIFACT_CANVAS_BED_FALLBACK_BOUNDS = {
  width: 860,
  height: 720,
}

export function ArtifactCanvasViewport({
  artifact,
  files,
  typeLabel,
  previewFile,
  previewHref,
  artifactTextRegistration,
  onVisualCaptureStatusChange,
  reviewSurfaceState = "idle",
  rendererKind,
  pageIndex = 0,
  zoom = 1,
  fitMode = "custom",
  onPageIndexChange,
  onPageCountChange,
  onPinchZoomChange,
  toolMode = "select",
  annotations = [],
  selectedAnnotationId = null,
  onCreateHighlight,
  onCreateComment,
  onSelectAnnotation,
  onUpdateCommentText,
  className,
}: ArtifactCanvasViewportProps) {
  const primaryFile = previewFile ?? files.find((file) => file.isPrimary) ?? files[0]
  const supportingFiles = files.filter((file) => !file.isPrimary)
  const effectiveRendererKind = rendererKind ?? detectArtifactRendererKind(primaryFile, artifact)
  const canPreviewMarkdown = effectiveRendererKind === "markdown" || isMarkdownArtifactFile(primaryFile)
  const canPreviewPdf = effectiveRendererKind === "pdf"
  const scrollAreaRef = useRef<HTMLDivElement | null>(null)
  const canvasBedBounds = useElementClientBounds(scrollAreaRef)
  const preview = useMarkdownArtifactPreview({
    enabled: canPreviewMarkdown,
    href: previewHref,
  })
  const captureArtifactId = artifactTextRegistration?.artifactId ?? null
  const markdownCaptureKey = [
    captureArtifactId ?? "",
    primaryFile?.path ?? "",
    preview.status === "ready" ? preview.markdown : "",
  ].join("::")
  const [markdownCaptureState, setMarkdownCaptureState] = useState<{
    key: string
    status: ArtifactVisualCaptureStatus
  }>(() => ({
    key: "",
    status: unavailableCaptureStatus("preview_not_ready", "markdown_preview_canvas"),
  }))
  const currentMarkdownCaptureStatus = useMemo(() => (
    markdownCaptureState.key === markdownCaptureKey
      ? markdownCaptureState.status
      : unavailableCaptureStatus("preview_not_ready", "markdown_preview_canvas")
  ), [markdownCaptureKey, markdownCaptureState])
  const handleMarkdownCaptureStatusChange = useCallback((status: ArtifactVisualCaptureStatus) => {
    setMarkdownCaptureState((current) => {
      if (current.key === markdownCaptureKey && captureStatusesEqual(current.status, status)) {
        return current
      }
      return { key: markdownCaptureKey, status }
    })
  }, [markdownCaptureKey])
  const pdfCaptureKey = [
    captureArtifactId ?? "",
    primaryFile?.path ?? "",
    pageIndex,
    zoom,
    fitMode,
  ].join("::")
  const [pdfCaptureState, setPdfCaptureState] = useState<{
    key: string
    status: ArtifactVisualCaptureStatus
  }>(() => ({
    key: "",
    status: unavailableCaptureStatus("preview_not_ready", "pdf_page_canvas"),
  }))
  const currentPdfCaptureStatus = useMemo(() => (
    pdfCaptureState.key === pdfCaptureKey
      ? pdfCaptureState.status
      : unavailableCaptureStatus("preview_not_ready", "pdf_page_canvas")
  ), [pdfCaptureKey, pdfCaptureState])
  const handlePdfCaptureStatusChange = useCallback((status: ArtifactVisualCaptureStatus) => {
    setPdfCaptureState((current) => {
      if (current.key === pdfCaptureKey && captureStatusesEqual(current.status, status)) {
        return current
      }
      return { key: pdfCaptureKey, status }
    })
  }, [pdfCaptureKey])
  const pdfTextExtractionKey = [
    captureArtifactId ?? "",
    primaryFile?.path ?? "",
  ].join("::")
  const [pdfTextExtractionState, setPdfTextExtractionState] = useState<{
    key: string
    status: ArtifactPdfTextExtractionStatus
  }>(() => ({
    key: "",
    status: emptyPdfTextExtractionStatus("unavailable"),
  }))
  const currentPdfTextExtractionStatus = useMemo(() => (
    pdfTextExtractionState.key === pdfTextExtractionKey
      ? pdfTextExtractionState.status
      : emptyPdfTextExtractionStatus("unavailable")
  ), [pdfTextExtractionKey, pdfTextExtractionState])
  const currentPdfCaptureStatusWithText = useMemo<ArtifactVisualCaptureStatus>(() => ({
    ...currentPdfCaptureStatus,
    exactTextAvailable: currentPdfTextExtractionStatus.status === "success",
    pdfTextExtractionStatus: currentPdfTextExtractionStatus.status,
    pdfTextExtractionSource: currentPdfTextExtractionStatus.source,
    pdfTextExtractionPageCount: currentPdfTextExtractionStatus.pageCount,
    pdfTextExtractionCharCount: currentPdfTextExtractionStatus.charCount,
    pdfTextExtractionTruncated: currentPdfTextExtractionStatus.truncated,
  }), [
    currentPdfCaptureStatus,
    currentPdfTextExtractionStatus.charCount,
    currentPdfTextExtractionStatus.pageCount,
    currentPdfTextExtractionStatus.source,
    currentPdfTextExtractionStatus.status,
    currentPdfTextExtractionStatus.truncated,
  ])
  const handlePdfTextExtractionStatusChange = useCallback((status: ArtifactPdfTextExtractionStatus) => {
    setPdfTextExtractionState((current) => {
      if (
        current.key === pdfTextExtractionKey
        && pdfTextExtractionStatusesEqual(current.status, status)
      ) {
        return current
      }
      return { key: pdfTextExtractionKey, status }
    })
  }, [pdfTextExtractionKey])

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

  useEffect(() => {
    if (
      !artifactTextRegistration
      || currentPdfTextExtractionStatus.status !== "success"
      || !currentPdfTextExtractionStatus.text?.trim()
    ) {
      return
    }

    return registerCoreviewArtifactText({
      artifactId: artifactTextRegistration.artifactId,
      source: "pdf_text_extraction",
      text: currentPdfTextExtractionStatus.text,
      pageCount: currentPdfTextExtractionStatus.pageCount,
      charCount: currentPdfTextExtractionStatus.charCount,
      truncated: currentPdfTextExtractionStatus.truncated,
      sessionIds: artifactTextRegistration.sessionIds,
      threadId: artifactTextRegistration.threadId,
    })
  }, [
    artifactTextRegistration,
    currentPdfTextExtractionStatus.charCount,
    currentPdfTextExtractionStatus.pageCount,
    currentPdfTextExtractionStatus.status,
    currentPdfTextExtractionStatus.text,
    currentPdfTextExtractionStatus.truncated,
  ])

  useEffect(() => {
    if (
      !artifactTextRegistration
      || !canPreviewPdf
      || pdfTextExtractionState.key !== pdfTextExtractionKey
      || currentPdfTextExtractionStatus.status === "success"
    ) {
      return
    }

    return registerCoreviewArtifactTextStatus({
      artifactId: artifactTextRegistration.artifactId,
      source: "pdf_text_extraction",
      status: currentPdfTextExtractionStatus.status,
      safeReason: currentPdfTextExtractionStatus.safeReason,
      pageCount: currentPdfTextExtractionStatus.pageCount,
      charCount: currentPdfTextExtractionStatus.charCount,
      truncated: currentPdfTextExtractionStatus.truncated,
      sessionIds: artifactTextRegistration.sessionIds,
      threadId: artifactTextRegistration.threadId,
    })
  }, [
    artifactTextRegistration,
    canPreviewPdf,
    currentPdfTextExtractionStatus.charCount,
    currentPdfTextExtractionStatus.pageCount,
    currentPdfTextExtractionStatus.safeReason,
    currentPdfTextExtractionStatus.status,
    currentPdfTextExtractionStatus.truncated,
    pdfTextExtractionKey,
    pdfTextExtractionState.key,
  ])

  useEffect(() => {
    if (
      !captureArtifactId
      || !canPreviewPdf
      || pdfTextExtractionState.key !== pdfTextExtractionKey
      || currentPdfTextExtractionStatus.status === "loading"
    ) {
      return
    }

    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "pdf-text-extraction",
      payload: {
        artifactId: captureArtifactId,
        artifactPath: primaryFile?.path ?? null,
        pdfTextExtractionStatus: currentPdfTextExtractionStatus.status,
        pdfTextExtractionSource: currentPdfTextExtractionStatus.source,
        pdfTextExtractionPageCount: currentPdfTextExtractionStatus.pageCount,
        pdfTextExtractionCharCount: currentPdfTextExtractionStatus.charCount,
        pdfTextExtractionTruncated: currentPdfTextExtractionStatus.truncated,
        pdfTextExtractionSafeReason: currentPdfTextExtractionStatus.safeReason,
        rawArtifactTextExcluded: true,
      },
    })
  }, [
    canPreviewPdf,
    captureArtifactId,
    currentPdfTextExtractionStatus.charCount,
    currentPdfTextExtractionStatus.pageCount,
    currentPdfTextExtractionStatus.safeReason,
    currentPdfTextExtractionStatus.source,
    currentPdfTextExtractionStatus.status,
    currentPdfTextExtractionStatus.truncated,
    pdfTextExtractionKey,
    pdfTextExtractionState.key,
    primaryFile?.path,
  ])

  useEffect(() => {
    if (!onVisualCaptureStatusChange) {
      return
    }

    if (!captureArtifactId) {
      onVisualCaptureStatusChange(unavailableCaptureStatus("no_selected_artifact", "none"))
      return
    }

    if (canPreviewPdf) {
      onVisualCaptureStatusChange(currentPdfCaptureStatusWithText)
      return
    }

    if (!canPreviewMarkdown) {
      onVisualCaptureStatusChange({
        ready: true,
        reason: null,
        source: "metadata_canvas",
        exactTextAvailable: true,
      })
      return
    }

    if (preview.status === "idle" || preview.status === "loading") {
      onVisualCaptureStatusChange(unavailableCaptureStatus("preview_not_ready", "markdown_preview_canvas"))
      return
    }

    if (preview.status === "failed" || !preview.markdown.trim()) {
      onVisualCaptureStatusChange(unavailableCaptureStatus("exact_text_only_no_visual_source", "markdown_preview_canvas"))
      return
    }

    onVisualCaptureStatusChange(currentMarkdownCaptureStatus)
  }, [
    canPreviewMarkdown,
    canPreviewPdf,
    captureArtifactId,
    currentMarkdownCaptureStatus,
    currentPdfCaptureStatusWithText,
    onVisualCaptureStatusChange,
    preview.markdown,
    preview.status,
  ])

  return (
    <div
      data-testid="artifact-canvas-viewport"
      className={cn(
        "relative z-10 flex min-h-[360px] max-h-full flex-col overflow-hidden bg-[color:color-mix(in_srgb,var(--cosmic-panel)_96%,var(--bg))]",
        className,
      )}
    >
      <div
        data-testid="artifact-canvas-bed"
        className={cn(
          "relative isolate flex min-h-0 min-w-0 w-full flex-1 overflow-hidden bg-[color:color-mix(in_srgb,var(--cosmic-panel)_94%,var(--bg))]",
          reviewSurfaceState === "active"
            ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_26%,transparent),inset_0_0_44px_color-mix(in_srgb,var(--sophia-purple)_10%,transparent)]"
            : reviewSurfaceState === "preparing"
              ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_18%,transparent),inset_0_0_38px_color-mix(in_srgb,var(--sophia-purple)_8%,transparent)]"
              : "shadow-[inset_0_1px_0_color-mix(in_srgb,var(--cosmic-border-soft)_72%,transparent)]",
        )}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--cosmic-panel) 28%, transparent), transparent 26%), radial-gradient(circle at 18% 5%, color-mix(in srgb, var(--sophia-purple) 8%, transparent), transparent 32%), radial-gradient(circle at 84% 10%, color-mix(in srgb, var(--cosmic-teal) 5%, transparent), transparent 34%)",
          }}
        />
        <div
          ref={scrollAreaRef}
          data-testid="artifact-canvas-scroll-area"
          className={cn(
            "relative z-10 flex min-h-0 min-w-0 w-full flex-1 overscroll-contain px-4 py-6 [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--cosmic-border)] [&::-webkit-scrollbar-track]:bg-transparent sm:px-7 sm:py-7 lg:px-10",
            canPreviewPdf
              ? "items-stretch overflow-hidden"
              : "flex-col items-stretch overflow-y-auto",
          )}
          style={{ scrollbarColor: "var(--cosmic-border) transparent" }}
        >
          {canPreviewMarkdown ? (
            <MarkdownDocumentPage
              artifact={artifact}
              file={primaryFile}
              preview={preview}
              typeLabel={typeLabel}
            />
          ) : canPreviewPdf ? (
            <ArtifactPdfPreview
              artifact={artifact}
              file={primaryFile}
              href={previewHref}
              artifactId={captureArtifactId}
              pageIndex={pageIndex}
              zoom={zoom}
              fitMode={fitMode}
              fitBounds={canvasBedBounds}
              typeLabel={typeLabel}
              onPageIndexChange={onPageIndexChange}
              onPageCountChange={onPageCountChange}
              onRenderStatusChange={handlePdfCaptureStatusChange}
              onTextExtractionStatusChange={handlePdfTextExtractionStatusChange}
              onPinchZoomChange={onPinchZoomChange}
              toolMode={toolMode}
              annotations={annotations}
              selectedAnnotationId={selectedAnnotationId}
              onCreateHighlight={onCreateHighlight}
              onCreateComment={onCreateComment}
              onSelectAnnotation={onSelectAnnotation}
              onUpdateCommentText={onUpdateCommentText}
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
      {canPreviewMarkdown && captureArtifactId && preview.status === "ready" && preview.markdown.trim() ? (
        <MarkdownArtifactCaptureCanvas
          artifact={artifact}
          artifactId={captureArtifactId}
          file={primaryFile}
          markdown={preview.markdown}
          typeLabel={typeLabel}
          onStatusChange={handleMarkdownCaptureStatusChange}
        />
      ) : null}
    </div>
  )
}

function useElementClientBounds(ref: RefObject<HTMLElement | null>) {
  const [bounds, setBounds] = useState(ARTIFACT_CANVAS_BED_FALLBACK_BOUNDS)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }

    const update = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      const nextBounds = {
        width: width > 0 ? width : ARTIFACT_CANVAS_BED_FALLBACK_BOUNDS.width,
        height: height > 0 ? height : ARTIFACT_CANVAS_BED_FALLBACK_BOUNDS.height,
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

function unavailableCaptureStatus(
  reason: ArtifactVisualCaptureUnavailableReason,
  source: ArtifactVisualCaptureStatus["source"],
): ArtifactVisualCaptureStatus {
  return {
    ready: false,
    reason,
    source,
    exactTextAvailable: false,
  }
}

function emptyPdfTextExtractionStatus(
  status: ArtifactPdfTextExtractionStatus["status"],
): ArtifactPdfTextExtractionStatus {
  return {
    status,
    source: "pdf_text_extraction",
    pageCount: 0,
    charCount: 0,
    truncated: false,
    safeReason: null,
  }
}

function captureStatusesEqual(
  left: ArtifactVisualCaptureStatus,
  right: ArtifactVisualCaptureStatus,
): boolean {
  return left.ready === right.ready
    && left.reason === right.reason
    && left.source === right.source
    && left.exactTextAvailable === right.exactTextAvailable
    && left.pdfTextExtractionStatus === right.pdfTextExtractionStatus
    && left.pdfTextExtractionSource === right.pdfTextExtractionSource
    && left.pdfTextExtractionPageCount === right.pdfTextExtractionPageCount
    && left.pdfTextExtractionCharCount === right.pdfTextExtractionCharCount
    && left.pdfTextExtractionTruncated === right.pdfTextExtractionTruncated
}

function pdfTextExtractionStatusesEqual(
  left: ArtifactPdfTextExtractionStatus,
  right: ArtifactPdfTextExtractionStatus,
): boolean {
  return left.status === right.status
    && left.pageCount === right.pageCount
    && left.charCount === right.charCount
    && left.truncated === right.truncated
    && left.safeReason === right.safeReason
    && left.text === right.text
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
      data-testid="artifact-document-page"
      className="mx-auto flex min-h-full w-full max-w-[1120px] flex-col overflow-hidden rounded-lg border bg-[color:color-mix(in_srgb,var(--card-bg)_96%,var(--cosmic-panel-soft))] shadow-[0_18px_54px_color-mix(in_srgb,var(--bg)_34%,transparent),0_1px_0_color-mix(in_srgb,white_26%,transparent)_inset]"
      style={{ borderColor: "var(--cosmic-border-soft)" }}
      aria-label="Artifact document preview"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[color:var(--cosmic-border-soft)] px-5 py-4 sm:px-6">
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

      <div className="flex min-h-[300px] flex-1 flex-col px-5 py-6 sm:px-8 sm:py-7">
        {preview.status === "loading" ? (
          <PreviewStateCard title="Preparing document view" body="You can still open or download the artifact." />
        ) : preview.status === "failed" || preview.status === "idle" ? (
          <PreviewStateCard title="Preview unavailable" body="Open or download the artifact to view the file." />
        ) : (
          <ArtifactMarkdownPreview markdown={preview.markdown} />
        )}
      </div>
    </div>
  )
}

function MarkdownArtifactCaptureCanvas({
  artifact,
  artifactId,
  file,
  markdown,
  typeLabel,
  onStatusChange,
}: {
  artifact: BuilderArtifactV1
  artifactId: string
  file?: ArtifactViewportFile
  markdown: string
  typeLabel: string
  onStatusChange: (status: ArtifactVisualCaptureStatus) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      onStatusChange({
        ready: false,
        reason: "capture_target_missing",
        source: "markdown_preview_canvas",
        exactTextAvailable: true,
      })
      return
    }

    const context = getCanvasContext(canvas)
    if (!context) {
      onStatusChange({
        ready: false,
        reason: "capture_failed",
        source: "markdown_preview_canvas",
        exactTextAvailable: true,
      })
      return
    }

    try {
      drawMarkdownArtifactCapture(context, canvas.width, canvas.height, {
        artifact,
        file,
        markdown,
        typeLabel,
      })
      onStatusChange({
        ready: true,
        reason: null,
        source: "markdown_preview_canvas",
        exactTextAvailable: true,
      })
    } catch {
      onStatusChange({
        ready: false,
        reason: "capture_failed",
        source: "markdown_preview_canvas",
        exactTextAvailable: true,
      })
    }
  }, [artifact, file, markdown, onStatusChange, typeLabel])

  return (
    <div
      aria-hidden="true"
      data-artifact-region="true"
      data-coreview-artifact-region="true"
      data-testid="artifact-markdown-capture-canvas"
      className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
      style={{ inset: 0 }}
    >
      <canvas
        ref={canvasRef}
        width={MARKDOWN_CAPTURE_CANVAS_WIDTH}
        height={MARKDOWN_CAPTURE_CANVAS_HEIGHT}
        data-artifact-id={artifactId}
        data-coreview-artifact-id={artifactId}
        data-artifact-canvas="true"
        data-coreview-artifact-canvas="true"
        data-artifact-canvas-source="selected-markdown-preview"
        data-coreview-offscreen-render="true"
        aria-label="Generated artifact review canvas"
      />
    </div>
  )
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d")
  } catch {
    return null
  }
}

function drawMarkdownArtifactCapture(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  input: {
    artifact: BuilderArtifactV1
    file?: ArtifactViewportFile
    markdown: string
    typeLabel: string
  },
) {
  const title = firstMarkdownHeading(input.markdown) || input.artifact.artifactTitle || input.file?.name || "Generated artifact"
  const blocks = markdownToCaptureBlocks(input.markdown)
  const pageX = 64
  const pageY = 48
  const pageWidth = width - pageX * 2
  const pageHeight = height - pageY * 2
  const contentX = pageX + 54
  const maxTextWidth = pageWidth - 108
  let y = pageY + 118

  context.clearRect(0, 0, width, height)
  context.fillStyle = "#ebe7f0"
  context.fillRect(0, 0, width, height)

  context.fillStyle = "#fbfaf7"
  fillRoundedRect(context, pageX, pageY, pageWidth, pageHeight, 24)

  context.fillStyle = "#574f67"
  context.font = "600 14px system-ui, sans-serif"
  context.fillText(input.typeLabel.toUpperCase(), contentX, pageY + 48)

  context.fillStyle = "#282233"
  context.font = "700 32px system-ui, sans-serif"
  y = drawWrappedCanvasText(context, title, contentX, y, maxTextWidth, 39, 2)

  context.fillStyle = "#81798d"
  context.font = "14px system-ui, sans-serif"
  drawSingleLineCanvasText(context, input.file?.name ?? "Generated artifact", contentX, y + 12, maxTextWidth)
  y += 52

  context.fillStyle = "#ddd6e8"
  context.fillRect(contentX, y, maxTextWidth, 1)
  y += 38

  for (const block of blocks.slice(0, MAX_CAPTURE_BLOCKS)) {
    if (y > pageY + pageHeight - 78) {
      drawOverflowHint(context, contentX, pageY + pageHeight - 42, maxTextWidth)
      break
    }

    y = drawMarkdownCaptureBlock(context, block, {
      contentX,
      maxTextWidth,
      y,
    })
  }

  context.fillStyle = "#81798d"
  context.font = "13px system-ui, sans-serif"
  context.fillText("Artifact review view. Exact wording is available through trusted text.", contentX, height - 48)
}

type MarkdownCaptureBlock = {
  kind: "h1" | "h2" | "h3" | "paragraph" | "bullet" | "numbered" | "spacer"
  text: string
  prefix?: string
}

function drawMarkdownCaptureBlock(
  context: CanvasRenderingContext2D,
  block: MarkdownCaptureBlock,
  layout: {
    contentX: number
    maxTextWidth: number
    y: number
  },
): number {
  if (block.kind === "spacer") {
    return layout.y + 14
  }

  if (block.kind === "h1") {
    context.fillStyle = "#282233"
    context.font = "700 28px system-ui, sans-serif"
    return drawWrappedCanvasText(context, block.text, layout.contentX, layout.y, layout.maxTextWidth, 34, 2) + 16
  }

  if (block.kind === "h2" || block.kind === "h3") {
    const isSecondLevel = block.kind === "h2"
    context.fillStyle = "#312a3d"
    context.font = `${isSecondLevel ? "700 23px" : "700 19px"} system-ui, sans-serif`
    return drawWrappedCanvasText(
      context,
      block.text,
      layout.contentX,
      layout.y,
      layout.maxTextWidth,
      isSecondLevel ? 30 : 25,
      2,
    ) + 12
  }

  if (block.kind === "bullet" || block.kind === "numbered") {
    context.fillStyle = "#5f586c"
    context.font = "17px system-ui, sans-serif"
    context.fillText(block.prefix ?? "-", layout.contentX, layout.y)
    return drawWrappedCanvasText(
      context,
      block.text,
      layout.contentX + 30,
      layout.y,
      layout.maxTextWidth - 30,
      25,
      3,
    ) + 8
  }

  context.fillStyle = "#4b4359"
  context.font = "17px system-ui, sans-serif"
  return drawWrappedCanvasText(context, block.text, layout.contentX, layout.y, layout.maxTextWidth, 26, 4) + 12
}

function markdownToCaptureBlocks(markdown: string): MarkdownCaptureBlock[] {
  const blocks: MarkdownCaptureBlock[] = []
  let orderedIndex = 1

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) {
      if (blocks.at(-1)?.kind !== "spacer") {
        blocks.push({ kind: "spacer", text: "" })
      }
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (heading) {
      const depth = heading[1]?.length ?? 1
      blocks.push({
        kind: depth === 1 ? "h1" : depth === 2 ? "h2" : "h3",
        text: cleanMarkdownInline(heading[2] ?? ""),
      })
      orderedIndex = 1
      continue
    }

    const bullet = /^[-*+]\s+(.+)$/u.exec(line)
    if (bullet) {
      blocks.push({ kind: "bullet", prefix: "-", text: cleanMarkdownInline(bullet[1] ?? "") })
      continue
    }

    const numbered = /^\d+[.)]\s+(.+)$/u.exec(line)
    if (numbered) {
      blocks.push({ kind: "numbered", prefix: `${orderedIndex}.`, text: cleanMarkdownInline(numbered[1] ?? "") })
      orderedIndex += 1
      continue
    }

    blocks.push({ kind: "paragraph", text: cleanMarkdownInline(line) })
    orderedIndex = 1
  }

  return blocks.filter((block) => block.kind === "spacer" || block.text.trim())
}

function firstMarkdownHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^#\s+(.+)$/u.exec(line.trim())
    if (heading?.[1]) {
      return cleanMarkdownInline(heading[1])
    }
  }
  return null
}

function cleanMarkdownInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/[*_~]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function drawWrappedCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): number {
  const lines = wrapCanvasText(context, text, maxWidth)
  const visibleLines = lines.slice(0, maxLines)

  visibleLines.forEach((line, index) => {
    const isLastVisibleLine = index === maxLines - 1 && lines.length > maxLines
    context.fillText(isLastVisibleLine ? truncateCanvasLine(context, line, maxWidth) : line, x, y + index * lineHeight)
  })

  return y + Math.max(visibleLines.length, 1) * lineHeight
}

function drawSingleLineCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
) {
  context.fillText(truncateCanvasLine(context, text, maxWidth, false), x, y)
}

function drawOverflowHint(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  maxWidth: number,
) {
  context.fillStyle = "#81798d"
  context.font = "14px system-ui, sans-serif"
  drawSingleLineCanvasText(context, "More artifact content continues below in the exact text source.", x, y, maxWidth)
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = cleanMarkdownInline(text).split(/\s+/u).filter(Boolean)
  if (words.length === 0) {
    return [""]
  }

  const lines: string[] = []
  let currentLine = ""

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word
    if (measureCanvasTextWidth(context, candidate) <= maxWidth) {
      currentLine = candidate
      continue
    }

    if (currentLine) {
      lines.push(currentLine)
      currentLine = word
      continue
    }

    lines.push(truncateCanvasLine(context, word, maxWidth, false))
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines
}

function truncateCanvasLine(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  includeEllipsis = true,
): string {
  const suffix = includeEllipsis ? "..." : ""
  if (measureCanvasTextWidth(context, text) <= maxWidth) {
    return text
  }

  let result = text
  while (result.length > 0 && measureCanvasTextWidth(context, `${result}${suffix}`) > maxWidth) {
    result = result.slice(0, -1)
  }

  return `${result.trimEnd()}${suffix}`
}

function measureCanvasTextWidth(context: CanvasRenderingContext2D, text: string): number {
  return typeof context.measureText === "function" ? context.measureText(text).width : text.length * 8
}

function fillRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
  context.fill()
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
      data-testid="artifact-document-page"
      className="mx-auto flex min-h-full w-full max-w-[960px] flex-col rounded-lg border bg-[color:color-mix(in_srgb,var(--card-bg)_94%,var(--cosmic-panel-soft))] px-5 py-6 shadow-[0_18px_54px_color-mix(in_srgb,var(--bg)_34%,transparent),0_1px_0_color-mix(in_srgb,white_24%,transparent)_inset] sm:px-7 sm:py-7"
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
      data-testid="artifact-preview-state"
      className="flex min-h-[260px] flex-1 flex-col items-center justify-center px-6 text-center"
    >
      <p className="text-sm font-medium text-[color:var(--cosmic-text-strong)]">{title}</p>
      <p className="mt-2 max-w-[320px] text-sm leading-relaxed text-[color:var(--cosmic-text-muted)]">
        {body}
      </p>
    </div>
  )
}
