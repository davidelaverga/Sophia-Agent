"use client"

import { FileText, Layers, ListChecks, Sparkles } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type RefObject } from "react"

import type { ArtifactFitMode, ArtifactRendererKind } from "../../lib/artifact-renderers"
import { detectArtifactRendererKind } from "../../lib/artifact-renderers"
import { isHtmlArtifactFile, isMarkdownArtifactFile } from "../../lib/builder-artifacts"
import {
  getCoreviewArtifactCapabilitiesForFile,
} from "../../lib/coreview-artifact-capabilities"
import {
  registerCoreviewArtifactText,
  registerCoreviewArtifactTextStatus,
} from "../../lib/coreview-artifact-text"
import type { CoreviewPdfTextLayout } from "../../lib/coreview-pdf-text-layout"
import type { CoreviewArtifactCapabilities } from "../../lib/coreview-workspace-contract"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import type {
  ArtifactAnnotation,
  ArtifactAnnotationColor,
  ArtifactToolMode,
  NormalizedArtifactLine,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../../types/artifact-annotations"
import type { BuilderArtifactFileV1, BuilderArtifactV1 } from "../../types/builder-artifact"

import { ArtifactMarkdownPreview } from "./ArtifactMarkdownPreview"
import { ArtifactPdfPreview, type ArtifactPdfFocusRequest, type ArtifactPdfTextExtractionStatus } from "./ArtifactPdfPreview"

type ArtifactViewportFile = BuilderArtifactFileV1 & {
  mimeType?: string
  sizeBytes?: number
}

type HtmlCaptureRegistrationResult =
  | "registered"
  | "canvas_missing"
  | "context_unavailable"
  | "draw_failed"
  | "unregistered"

export type ArtifactVisualCaptureUnavailableReason =
  | "no_selected_artifact"
  | "preview_not_ready"
  | "capture_target_missing"
  | "capture_failed"
  | "exact_text_only_no_visual_source"

export interface ArtifactVisualCaptureStatus {
  ready: boolean
  reason: ArtifactVisualCaptureUnavailableReason | null
  source: "markdown_preview_canvas" | "html_preview_canvas" | "metadata_canvas" | "pdf_page_canvas" | "none"
  exactTextAvailable: boolean
  artifactPath?: string | null
  previewHref?: string | null
  pdfTextExtractionStatus?: ArtifactPdfTextExtractionStatus["status"] | null
  pdfTextExtractionSource?: ArtifactPdfTextExtractionStatus["source"] | null
  pdfTextExtractionPageCount?: number | null
  pdfTextExtractionCharCount?: number | null
  pdfTextExtractionTruncated?: boolean | null
  annotationOverlayCaptured?: boolean | null
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
    artifactStableIdentity?: string | null
    artifactLogicalId?: string | null
    artifactVersionId?: string | null
  } | null
  onVisualCaptureStatusChange?: (status: ArtifactVisualCaptureStatus) => void
  onHtmlTextChange?: (text: string) => void
  onPdfTextLayoutChange?: (layout: CoreviewPdfTextLayout | null) => void
  reviewSurfaceState?: ArtifactReviewSurfaceState
  rendererKind?: ArtifactRendererKind
  capabilities?: CoreviewArtifactCapabilities
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
  onCreateUnderline?: (rect: NormalizedArtifactRect) => void
  onCreateArrow?: (line: NormalizedArtifactLine) => void
  onSelectAnnotation?: (id: string | null) => void
  onUpdateCommentText?: (id: string, text: string) => void
  focusRequest?: ArtifactPdfFocusRequest | null
  className?: string
}

export type ArtifactReviewSurfaceState = "idle" | "preparing" | "active" | "unavailable"

const MARKDOWN_CAPTURE_CANVAS_WIDTH = 960
const MARKDOWN_CAPTURE_CANVAS_HEIGHT = 1240
const HTML_CAPTURE_CANVAS_WIDTH = 960
const HTML_CAPTURE_CANVAS_HEIGHT = 720
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
  onHtmlTextChange,
  onPdfTextLayoutChange,
  reviewSurfaceState = "idle",
  rendererKind,
  capabilities,
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
  onCreateUnderline,
  onCreateArrow,
  onSelectAnnotation,
  onUpdateCommentText,
  focusRequest = null,
  className,
}: ArtifactCanvasViewportProps) {
  const primaryFile = previewFile ?? files.find((file) => file.isPrimary) ?? files[0]
  const supportingFiles = files.filter((file) => !file.isPrimary)
  const effectiveRendererKind = rendererKind ?? detectArtifactRendererKind(primaryFile, artifact)
  const effectiveCapabilities = capabilities ?? getCoreviewArtifactCapabilitiesForFile({
    file: primaryFile,
    rendererKind: effectiveRendererKind,
    originalDownloadAvailable: Boolean(previewHref),
    openInNewTabAvailable: Boolean(previewHref),
  })
  const canPreviewHtml = effectiveCapabilities.renderMode === "html" && (effectiveRendererKind === "html" || isHtmlArtifactFile(primaryFile))
  const canPreviewMarkdown = !canPreviewHtml && effectiveCapabilities.renderMode === "markdown" && (effectiveRendererKind === "markdown" || isMarkdownArtifactFile(primaryFile))
  const canPreviewPdf = !canPreviewHtml && effectiveCapabilities.renderMode === "canvas" && effectiveRendererKind === "pdf"
  const scrollAreaRef = useRef<HTMLDivElement | null>(null)
  const canvasBedBounds = useElementClientBounds(scrollAreaRef)
  const preview = useMarkdownArtifactPreview({
    enabled: canPreviewMarkdown,
    href: previewHref,
  })
  const htmlPreview = useHtmlArtifactPreview({
    enabled: canPreviewHtml,
    href: previewHref,
  })
  const htmlPreviewText = useMemo(() => (
    htmlPreview.status === "ready" ? extractTextFromHtml(htmlPreview.html) : ""
  ), [htmlPreview])
  const htmlAnnotationSignature = useMemo(() => (
    annotations
      .filter((annotation) => annotation.pageIndex === 0)
      .map(pdfAnnotationSignature)
      .join("|")
  ), [annotations])
  const captureArtifactId = artifactTextRegistration?.artifactId ?? null
  const htmlCaptureKey = [
    captureArtifactId ?? "",
    primaryFile?.path ?? "",
    htmlPreview.status === "ready" ? htmlPreview.html : "",
  ].join("::")
  const [htmlCaptureState, setHtmlCaptureState] = useState<{
    key: string
    status: ArtifactVisualCaptureStatus
  }>(() => ({
    key: "",
    status: unavailableCaptureStatus("preview_not_ready", "html_preview_canvas"),
  }))
  const currentHtmlCaptureStatus = useMemo(() => (
    htmlCaptureState.key === htmlCaptureKey
      ? {
          ...htmlCaptureState.status,
          annotationOverlayCaptured: Boolean(htmlAnnotationSignature),
        }
      : {
          ...unavailableCaptureStatus("preview_not_ready", "html_preview_canvas", Boolean(htmlPreviewText.trim())),
          annotationOverlayCaptured: Boolean(htmlAnnotationSignature),
        }
  ), [htmlAnnotationSignature, htmlCaptureKey, htmlCaptureState, htmlPreviewText])
  const handleHtmlCaptureStatusChange = useCallback((status: ArtifactVisualCaptureStatus) => {
    setHtmlCaptureState((current) => {
      if (current.key === htmlCaptureKey && captureStatusesEqual(current.status, status)) {
        return current
      }
      return { key: htmlCaptureKey, status }
    })
  }, [htmlCaptureKey])
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
    annotations
      .filter((annotation) => annotation.pageIndex === pageIndex)
      .map(pdfAnnotationSignature)
      .join("|"),
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
    annotationOverlayCaptured: currentPdfCaptureStatus.annotationOverlayCaptured ?? false,
  }), [
    currentPdfCaptureStatus,
    currentPdfTextExtractionStatus.charCount,
    currentPdfTextExtractionStatus.pageCount,
    currentPdfTextExtractionStatus.source,
    currentPdfTextExtractionStatus.status,
    currentPdfTextExtractionStatus.truncated,
  ])
  const baseVisualCaptureStatus = useMemo(() => resolveVisualCaptureStatus({
    captureArtifactId,
    canPreviewHtml,
    canPreviewMarkdown,
    canPreviewPdf,
    currentHtmlCaptureStatus,
    currentMarkdownCaptureStatus,
    currentPdfCaptureStatusWithText,
    effectiveCapabilities,
    htmlPreview,
    htmlPreviewText,
    markdownPreview: preview,
  }), [
    canPreviewHtml,
    canPreviewMarkdown,
    canPreviewPdf,
    captureArtifactId,
    currentHtmlCaptureStatus,
    currentMarkdownCaptureStatus,
    currentPdfCaptureStatusWithText,
    effectiveCapabilities,
    htmlPreview,
    htmlPreviewText,
    preview,
  ])
  const visualCaptureStatus = useMemo(() => withRenderedArtifactSource(
    baseVisualCaptureStatus,
    primaryFile?.path ?? null,
    previewHref ?? null,
  ), [baseVisualCaptureStatus, previewHref, primaryFile?.path])
  const handlePdfTextExtractionStatusChange = useCallback((status: ArtifactPdfTextExtractionStatus) => {
    onPdfTextLayoutChange?.(status.status === "success" ? status.layout ?? null : null)
    setPdfTextExtractionState((current) => {
      if (
        current.key === pdfTextExtractionKey
        && pdfTextExtractionStatusesEqual(current.status, status)
      ) {
        return current
      }
      return { key: pdfTextExtractionKey, status }
    })
  }, [onPdfTextLayoutChange, pdfTextExtractionKey])

  useEffect(() => {
    if (canPreviewPdf) {
      onPdfTextLayoutChange?.(null)
    }
  }, [canPreviewPdf, onPdfTextLayoutChange, pdfTextExtractionKey])

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
      artifactStableIdentity: artifactTextRegistration.artifactStableIdentity,
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
      artifactStableIdentity: artifactTextRegistration.artifactStableIdentity,
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
      artifactStableIdentity: artifactTextRegistration.artifactStableIdentity,
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
        artifactStableIdentity: artifactTextRegistration?.artifactStableIdentity ?? null,
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
    artifactTextRegistration?.artifactStableIdentity,
    pdfTextExtractionKey,
    pdfTextExtractionState.key,
    primaryFile?.path,
  ])

  useEffect(() => {
    if (!artifactTextRegistration || !htmlPreviewText.trim()) {
      onHtmlTextChange?.("")
      return
    }

    onHtmlTextChange?.(htmlPreviewText)
    return registerCoreviewArtifactText({
      artifactId: artifactTextRegistration.artifactId,
      source: "builder_file",
      text: htmlPreviewText,
      sessionIds: artifactTextRegistration.sessionIds,
      threadId: artifactTextRegistration.threadId,
      artifactStableIdentity: artifactTextRegistration.artifactStableIdentity,
    })
  }, [artifactTextRegistration, htmlPreviewText, onHtmlTextChange])

  useEffect(() => {
    if (!onVisualCaptureStatusChange) {
      return
    }
    onVisualCaptureStatusChange(visualCaptureStatus)
  }, [onVisualCaptureStatusChange, visualCaptureStatus])

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
          {canPreviewHtml ? (
            <HtmlDocumentPage
              artifact={artifact}
              file={primaryFile}
              preview={htmlPreview}
              typeLabel={typeLabel}
              zoom={zoom}
              fitMode={fitMode}
              toolMode={toolMode}
              annotations={annotations.filter((annotation) => annotation.pageIndex === 0)}
              selectedAnnotationId={selectedAnnotationId}
              onCreateHighlight={onCreateHighlight}
              onCreateComment={onCreateComment}
              onCreateUnderline={onCreateUnderline}
              onSelectAnnotation={onSelectAnnotation}
              onUpdateCommentText={onUpdateCommentText}
            />
          ) : canPreviewMarkdown ? (
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
              onCreateUnderline={onCreateUnderline}
              onCreateArrow={onCreateArrow}
              onSelectAnnotation={onSelectAnnotation}
              onUpdateCommentText={onUpdateCommentText}
              focusRequest={focusRequest}
            />
          ) : (
            <ArtifactMetadataPage
              artifact={artifact}
              primaryFile={primaryFile}
              supportingFileCount={supportingFiles.length}
              typeLabel={typeLabel}
              capabilityTruth={effectiveCapabilities.userFacingTruth ?? null}
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
      {canPreviewHtml && captureArtifactId && htmlPreview.status === "ready" && htmlPreview.html.trim() ? (
        <HtmlArtifactCaptureCanvas
          artifact={artifact}
          artifactId={captureArtifactId}
          file={primaryFile}
          html={htmlPreview.html}
          previewText={htmlPreviewText}
          typeLabel={typeLabel}
          artifactStableIdentity={artifactTextRegistration?.artifactStableIdentity ?? null}
          artifactLogicalId={artifactTextRegistration?.artifactLogicalId ?? artifactTextRegistration?.artifactStableIdentity ?? null}
          artifactVersionId={artifactTextRegistration?.artifactVersionId ?? null}
          onStatusChange={handleHtmlCaptureStatusChange}
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

type HtmlPreviewState =
  | { status: "idle"; html: "" }
  | { status: "loading"; html: "" }
  | { status: "ready"; html: string }
  | { status: "failed"; html: "" }

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

function useHtmlArtifactPreview({
  enabled,
  href,
}: {
  enabled: boolean
  href?: string | null
}): HtmlPreviewState {
  const [preview, setPreview] = useState<HtmlPreviewState>({ status: "idle", html: "" })

  useEffect(() => {
    if (!enabled || !href) {
      setPreview({ status: "idle", html: "" })
      return
    }

    const controller = new AbortController()
    setPreview({ status: "loading", html: "" })

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
      .then((html) => {
        if (!controller.signal.aborted) {
          setPreview({ status: "ready", html })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreview({ status: "failed", html: "" })
        }
      })

    return () => {
      controller.abort()
    }
  }, [enabled, href])

  return preview
}

function extractTextFromHtml(html: string): string {
  if (!html.trim()) {
    return ""
  }

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, "text/html")
    return (doc.body?.textContent ?? doc.documentElement.textContent ?? "")
      .replace(/\s+/gu, " ")
      .trim()
  } catch {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/giu, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  }
}

function resolveVisualCaptureStatus({
  captureArtifactId,
  canPreviewHtml,
  canPreviewMarkdown,
  canPreviewPdf,
  currentHtmlCaptureStatus,
  currentMarkdownCaptureStatus,
  currentPdfCaptureStatusWithText,
  effectiveCapabilities,
  htmlPreview,
  htmlPreviewText,
  markdownPreview,
}: {
  captureArtifactId: string | null
  canPreviewHtml: boolean
  canPreviewMarkdown: boolean
  canPreviewPdf: boolean
  currentHtmlCaptureStatus: ArtifactVisualCaptureStatus
  currentMarkdownCaptureStatus: ArtifactVisualCaptureStatus
  currentPdfCaptureStatusWithText: ArtifactVisualCaptureStatus
  effectiveCapabilities: CoreviewArtifactCapabilities
  htmlPreview: HtmlPreviewState
  htmlPreviewText: string
  markdownPreview: MarkdownPreviewState
}): ArtifactVisualCaptureStatus {
  if (!captureArtifactId) {
    return unavailableCaptureStatus("no_selected_artifact", "none")
  }
  if (canPreviewHtml) {
    return htmlVisualCaptureStatus(htmlPreview, htmlPreviewText, currentHtmlCaptureStatus)
  }
  if (canPreviewPdf) {
    return currentPdfCaptureStatusWithText
  }
  if (!canPreviewMarkdown) {
    return {
      ready: effectiveCapabilities.supportsStillFrame,
      reason: effectiveCapabilities.supportsStillFrame ? null : "exact_text_only_no_visual_source",
      source: "metadata_canvas",
      exactTextAvailable: effectiveCapabilities.canRender && effectiveCapabilities.renderMode === "metadata"
        ? true
        : effectiveCapabilities.supportsTextExtraction,
    }
  }
  if (markdownPreview.status === "idle" || markdownPreview.status === "loading") {
    return unavailableCaptureStatus("preview_not_ready", "markdown_preview_canvas")
  }
  if (markdownPreview.status === "failed" || !markdownPreview.markdown.trim()) {
    return unavailableCaptureStatus("exact_text_only_no_visual_source", "markdown_preview_canvas")
  }
  return currentMarkdownCaptureStatus
}

function htmlVisualCaptureStatus(
  preview: HtmlPreviewState,
  previewText: string,
  currentHtmlCaptureStatus: ArtifactVisualCaptureStatus,
): ArtifactVisualCaptureStatus {
  if (preview.status === "idle" || preview.status === "loading") {
    return unavailableCaptureStatus("preview_not_ready", "html_preview_canvas")
  }
  if (preview.status === "failed" || !preview.html.trim()) {
    return unavailableCaptureStatus("exact_text_only_no_visual_source", "html_preview_canvas")
  }
  return {
    ...currentHtmlCaptureStatus,
    exactTextAvailable: currentHtmlCaptureStatus.exactTextAvailable || Boolean(previewText.trim()),
  }
}

function withRenderedArtifactSource(
  status: ArtifactVisualCaptureStatus,
  artifactPath: string | null,
  previewHref: string | null,
): ArtifactVisualCaptureStatus {
  if (status.artifactPath === artifactPath && status.previewHref === previewHref) {
    return status
  }
  return {
    ...status,
    artifactPath,
    previewHref,
  }
}

function unavailableCaptureStatus(
  reason: ArtifactVisualCaptureUnavailableReason,
  source: ArtifactVisualCaptureStatus["source"],
  exactTextAvailable = false,
): ArtifactVisualCaptureStatus {
  return {
    ready: false,
    reason,
    source,
    exactTextAvailable,
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
    && left.artifactPath === right.artifactPath
    && left.previewHref === right.previewHref
    && left.pdfTextExtractionStatus === right.pdfTextExtractionStatus
    && left.pdfTextExtractionSource === right.pdfTextExtractionSource
    && left.pdfTextExtractionPageCount === right.pdfTextExtractionPageCount
    && left.pdfTextExtractionCharCount === right.pdfTextExtractionCharCount
    && left.pdfTextExtractionTruncated === right.pdfTextExtractionTruncated
    && left.annotationOverlayCaptured === right.annotationOverlayCaptured
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

function HtmlDocumentPage({
  artifact,
  file,
  preview,
  typeLabel,
  zoom,
  fitMode,
  toolMode,
  annotations,
  selectedAnnotationId,
  onCreateHighlight,
  onCreateComment,
  onCreateUnderline,
  onSelectAnnotation,
  onUpdateCommentText,
}: {
  artifact: BuilderArtifactV1
  file?: ArtifactViewportFile
  preview: HtmlPreviewState
  typeLabel: string
  zoom: number
  fitMode: ArtifactFitMode
  toolMode: ArtifactToolMode
  annotations: ArtifactAnnotation[]
  selectedAnnotationId?: string | null
  onCreateHighlight?: (rect: NormalizedArtifactRect) => void
  onCreateComment?: (point: NormalizedArtifactPoint) => void
  onCreateUnderline?: (rect: NormalizedArtifactRect) => void
  onSelectAnnotation?: (id: string | null) => void
  onUpdateCommentText?: (id: string, text: string) => void
}) {
  const normalizedZoom = Math.max(0.25, Math.min(4, zoom))
  const selectedAnnotation = useMemo(() => (
    annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null
  ), [annotations, selectedAnnotationId])

  return (
    <div
      data-testid="artifact-document-page"
      className="mx-auto flex min-h-full w-full max-w-[1120px] flex-col overflow-hidden rounded-lg border bg-[color:color-mix(in_srgb,var(--card-bg)_96%,var(--cosmic-panel-soft))] shadow-[0_18px_54px_color-mix(in_srgb,var(--bg)_34%,transparent),0_1px_0_color-mix(in_srgb,white_26%,transparent)_inset]"
      style={{ borderColor: "var(--cosmic-border-soft)" }}
      aria-label="Artifact HTML preview"
      data-artifact-fit-mode={fitMode}
      data-artifact-zoom={String(normalizedZoom)}
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
        <Sparkles className="h-7 w-7 shrink-0 text-[color:var(--cosmic-text-faint)]" aria-hidden="true" />
      </div>

      <div className="flex min-h-[420px] flex-1 flex-col px-4 py-4 sm:px-5 sm:py-5">
        {preview.status === "loading" ? (
          <PreviewStateCard title="Preparing webpage view" body="You can still open or download the artifact." />
        ) : preview.status === "failed" || preview.status === "idle" ? (
          <PreviewStateCard title="Preview unavailable" body="Open or download the artifact to view the file." />
        ) : (
          <div
            data-testid="artifact-html-zoom-frame"
            data-artifact-fit-mode={fitMode}
            data-artifact-zoom={String(normalizedZoom)}
            className="origin-top"
            style={{
              transform: `scale(${normalizedZoom})`,
              transformOrigin: "top center",
              width: `${100 / normalizedZoom}%`,
              minHeight: `${Math.max(560, 560 * normalizedZoom)}px`,
            }}
          >
            <div
              data-testid="artifact-html-annotation-host"
              data-annotation-overlay-captured={annotations.length > 0 ? "true" : "false"}
              className="relative min-h-[560px] w-full"
            >
              <iframe
                title={`Preview of ${file?.name ?? artifact.artifactTitle}`}
                sandbox=""
                srcDoc={preview.html}
                className="min-h-[560px] w-full rounded-md border bg-white"
                style={{ borderColor: "var(--cosmic-border-soft)" }}
              />
              <ArtifactHtmlAnnotationLayer
                toolMode={toolMode}
                annotations={annotations}
                selectedAnnotation={selectedAnnotation}
                onCreateHighlight={onCreateHighlight}
                onCreateComment={onCreateComment}
                onCreateUnderline={onCreateUnderline}
                onSelectAnnotation={onSelectAnnotation}
                onUpdateCommentText={onUpdateCommentText}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ArtifactHtmlAnnotationLayer({
  toolMode,
  annotations,
  selectedAnnotation,
  onCreateHighlight,
  onCreateComment,
  onCreateUnderline,
  onSelectAnnotation,
  onUpdateCommentText,
}: {
  toolMode: ArtifactToolMode
  annotations: ArtifactAnnotation[]
  selectedAnnotation: ArtifactAnnotation | null
  onCreateHighlight?: (rect: NormalizedArtifactRect) => void
  onCreateComment?: (point: NormalizedArtifactPoint) => void
  onCreateUnderline?: (rect: NormalizedArtifactRect) => void
  onSelectAnnotation?: (id: string | null) => void
  onUpdateCommentText?: (id: string, text: string) => void
}) {
  const [draft, setDraft] = useState<{
    kind: "highlight" | "underline"
    start: NormalizedArtifactPoint
    current: NormalizedArtifactPoint
  } | null>(null)
  const draftRect = draft
    ? draft.kind === "underline"
      ? normalizedUnderlineRectFromPoints(draft.start, draft.current)
      : normalizedRectFromPoints(draft.start, draft.current)
    : null

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || toolMode === "pan") {
      return
    }
    if (toolMode === "select") {
      onSelectAnnotation?.(null)
      return
    }

    const point = normalizedPointFromPointerEvent(event)
    event.preventDefault()
    event.stopPropagation()

    if (toolMode === "comment") {
      onCreateComment?.(point)
      return
    }
    if (toolMode === "highlight" || toolMode === "underline") {
      setDraft({ kind: toolMode, start: point, current: point })
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is optional for this overlay.
      }
    }
  }, [onCreateComment, onSelectAnnotation, toolMode])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (toolMode !== draft?.kind) {
      return
    }
    event.preventDefault()
    const point = normalizedPointFromPointerEvent(event)
    setDraft((current) => current ? { ...current, current: point } : current)
  }, [draft, toolMode])

  const finishDraft = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (toolMode !== draft?.kind) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const current = normalizedPointFromPointerEvent(event)
    const rect = draft.kind === "underline"
      ? normalizedUnderlineRectFromPoints(draft.start, current)
      : normalizedRectFromPoints(draft.start, current)
    setDraft(null)
    if (rect.width < 0.008 || (draft.kind === "highlight" && rect.height < 0.008)) {
      return
    }
    if (draft.kind === "underline") {
      onCreateUnderline?.(rect)
    } else {
      onCreateHighlight?.(rect)
    }
  }, [draft, onCreateHighlight, onCreateUnderline, toolMode])

  return (
    <div
      data-testid="artifact-html-annotation-layer"
      data-artifact-tool-mode={toolMode}
      data-annotation-overlay-captured={annotations.length > 0 ? "true" : "false"}
      className={cn(
        "absolute inset-0 z-10",
        toolMode === "pan" ? "pointer-events-none" : "pointer-events-auto",
        toolMode === "highlight" && "cursor-crosshair",
        toolMode === "underline" && "cursor-crosshair",
        toolMode === "comment" && "cursor-copy",
        toolMode === "select" && "cursor-default",
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDraft}
      onPointerCancel={() => setDraft(null)}
    >
      {annotations.map((annotation) => (
        <HtmlAnnotation
          key={annotation.id}
          annotation={annotation}
          selected={selectedAnnotation?.id === annotation.id}
          onSelect={(id) => onSelectAnnotation?.(id)}
          onTextChange={(id, text) => onUpdateCommentText?.(id, text)}
        />
      ))}
      {draftRect ? (
        <div
          data-testid={draft?.kind === "underline" ? "artifact-html-underline-draft" : "artifact-html-highlight-draft"}
          data-annotation-page-index="0"
          data-page-index="0"
          className={cn(
            "pointer-events-none absolute rounded-[3px] border shadow-[0_0_0_1px_color-mix(in_srgb,var(--sophia-purple)_22%,transparent)]",
            draft?.kind === "underline"
              ? "border-transparent bg-transparent"
              : "border-[color:color-mix(in_srgb,var(--sophia-purple)_74%,#facc15)] bg-[color:color-mix(in_srgb,#facc15_32%,var(--sophia-purple)_18%)]",
          )}
          style={rectToStyle(draftRect)}
        >
          {draft?.kind === "underline" ? (
            <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-full bg-[color:var(--sophia-purple)] shadow-[0_0_10px_color-mix(in_srgb,var(--sophia-purple)_34%,transparent)]" />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function HtmlAnnotation({
  annotation,
  selected,
  onSelect,
  onTextChange,
}: {
  annotation: ArtifactAnnotation
  selected: boolean
  onSelect: (id: string) => void
  onTextChange: (id: string, value: string) => void
}) {
  if (annotation.kind === "highlight") {
    return <HtmlHighlightAnnotation annotation={annotation} selected={selected} onSelect={onSelect} />
  }
  if (annotation.kind === "underline") {
    return <HtmlUnderlineAnnotation annotation={annotation} selected={selected} onSelect={onSelect} />
  }
  if (annotation.kind === "comment") {
    return (
      <HtmlCommentAnnotation
        annotation={annotation}
        selected={selected}
        onSelect={onSelect}
        onTextChange={onTextChange}
      />
    )
  }
  return null
}

function HtmlHighlightAnnotation({
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
      data-testid="artifact-html-highlight-annotation"
      data-annotation-id={annotation.id}
      data-annotation-kind="highlight"
      data-annotation-page-index="0"
      data-page-index={annotation.pageIndex}
      data-annotation-source={annotation.source ?? "user"}
      aria-label="Highlight annotation"
      aria-pressed={selected}
      className={cn(
        "cosmic-focus-ring absolute rounded-[3px] border transition",
        selected
          ? "border-[color:var(--sophia-purple)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--sophia-purple)_34%,transparent)]"
          : "border-[color:color-mix(in_srgb,var(--sophia-purple)_26%,#facc15)]",
      )}
      style={{
        ...rectToStyle(annotation.rect),
        ...highlightAnnotationStyle(annotation.color ?? "yellow"),
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(annotation.id)
      }}
    />
  )
}

function HtmlUnderlineAnnotation({
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
      data-testid="artifact-html-underline-annotation"
      data-annotation-id={annotation.id}
      data-annotation-kind="underline"
      data-annotation-page-index="0"
      data-page-index={annotation.pageIndex}
      data-annotation-source={annotation.source ?? "user"}
      aria-label="Underline annotation"
      aria-pressed={selected}
      className={cn(
        "cosmic-focus-ring absolute rounded-[3px] border bg-transparent transition",
        selected ? "border-[color:var(--sophia-purple)]" : "border-transparent",
      )}
      style={rectToStyle(annotation.rect)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(annotation.id)
      }}
    >
      <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-full bg-[color:var(--sophia-purple)] shadow-[0_0_10px_color-mix(in_srgb,var(--sophia-purple)_30%,transparent)]" />
    </button>
  )
}

function HtmlCommentAnnotation({
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
      data-testid="artifact-html-comment-annotation"
      data-annotation-id={annotation.id}
      data-annotation-kind="comment"
      data-annotation-page-index="0"
      data-page-index={annotation.pageIndex}
      data-annotation-source={annotation.source ?? "user"}
      className="absolute"
      style={pointToStyle(annotation.point)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        data-testid="artifact-html-comment-pin"
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
            data-testid="artifact-html-comment-input"
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

function normalizedPointFromPointerEvent(event: PointerEvent<HTMLElement>): NormalizedArtifactPoint {
  const rect = event.currentTarget.getBoundingClientRect()
  const width = rect.width > 0 ? rect.width : 1
  const height = rect.height > 0 ? rect.height : 1
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

function highlightAnnotationStyle(color: ArtifactAnnotationColor) {
  const palette = annotationColorPalette(color)
  return {
    backgroundColor: palette.background,
    borderColor: palette.border,
  }
}

function annotationColorPalette(color: ArtifactAnnotationColor) {
  switch (color) {
    case "purple":
      return {
        background: "color-mix(in srgb, var(--sophia-purple) 30%, transparent)",
        border: "color-mix(in srgb, var(--sophia-purple) 58%, white)",
      }
    case "blue":
      return {
        background: "rgba(96, 165, 250, 0.28)",
        border: "rgba(59, 130, 246, 0.58)",
      }
    case "pink":
      return {
        background: "rgba(244, 114, 182, 0.28)",
        border: "rgba(219, 39, 119, 0.54)",
      }
    case "yellow":
    default:
      return {
        background: "color-mix(in srgb, #facc15 34%, var(--sophia-purple) 16%)",
        border: "color-mix(in srgb, var(--sophia-purple) 26%, #facc15)",
      }
  }
}

function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function HtmlArtifactCaptureCanvas({
  artifact,
  artifactId,
  file,
  html,
  previewText,
  typeLabel,
  artifactStableIdentity,
  artifactLogicalId,
  artifactVersionId,
  onStatusChange,
}: {
  artifact: BuilderArtifactV1
  artifactId: string
  file?: ArtifactViewportFile
  html: string
  previewText: string
  typeLabel: string
  artifactStableIdentity?: string | null
  artifactLogicalId?: string | null
  artifactVersionId?: string | null
  onStatusChange: (status: ArtifactVisualCaptureStatus) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const mountedAtMsRef = useRef(nowMs())
  const registrationCountRef = useRef(0)
  const exactTextAvailable = Boolean(previewText.trim())

  useLayoutEffect(() => {
    const latencyMs = Math.max(0, Math.round(nowMs() - mountedAtMsRef.current))
    const emitTelemetry = (
      result: HtmlCaptureRegistrationResult,
      succeeded: boolean,
      failureReason: ArtifactVisualCaptureUnavailableReason | null,
    ) => {
      recordHtmlCaptureTargetTelemetry({
        artifactId,
        artifactPath: file?.path ?? null,
        artifactStableIdentity,
        artifactLogicalId,
        artifactVersionId,
        result,
        succeeded,
        failureReason,
        readyLatencyMs: latencyMs,
        rebindCount: registrationCountRef.current,
      })
    }
    const unavailableStatus = (reason: ArtifactVisualCaptureUnavailableReason): ArtifactVisualCaptureStatus => ({
      ready: false,
      reason,
      source: "html_preview_canvas",
      exactTextAvailable,
    })
    const canvas = canvasRef.current
    if (!canvas) {
      onStatusChange(unavailableStatus("capture_target_missing"))
      emitTelemetry("canvas_missing", false, "capture_target_missing")
      return
    }

    const context = getCanvasContext(canvas)
    if (!context) {
      onStatusChange(unavailableStatus("capture_failed"))
      emitTelemetry("context_unavailable", false, "capture_failed")
      return
    }

    try {
      drawHtmlArtifactCapture(context, canvas.width, canvas.height, {
        artifact,
        file,
        html,
        previewText,
        typeLabel,
      })
      const rebindCount = registrationCountRef.current
      registrationCountRef.current += 1
      onStatusChange({
        ready: true,
        reason: null,
        source: "html_preview_canvas",
        exactTextAvailable,
      })
      recordHtmlCaptureTargetTelemetry({
        artifactId,
        artifactPath: file?.path ?? null,
        artifactStableIdentity,
        artifactLogicalId,
        artifactVersionId,
        result: "registered",
        succeeded: true,
        failureReason: null,
        readyLatencyMs: latencyMs,
        rebindCount,
      })
    } catch {
      onStatusChange(unavailableStatus("capture_failed"))
      emitTelemetry("draw_failed", false, "capture_failed")
    }

    return () => {
      recordHtmlCaptureTargetTelemetry({
        artifactId,
        artifactPath: file?.path ?? null,
        artifactStableIdentity,
        artifactLogicalId,
        artifactVersionId,
        result: "unregistered",
        succeeded: false,
        failureReason: "capture_target_missing",
        readyLatencyMs: latencyMs,
        rebindCount: registrationCountRef.current,
      })
    }
  }, [
    artifact,
    artifactId,
    artifactLogicalId,
    artifactStableIdentity,
    artifactVersionId,
    exactTextAvailable,
    file,
    html,
    onStatusChange,
    previewText,
    typeLabel,
  ])

  return (
    <div
      aria-hidden="true"
      data-artifact-region="true"
      data-coreview-artifact-region="true"
      data-coreview-renderer-kind="html"
      data-coreview-artifact-stable-identity={artifactStableIdentity ?? undefined}
      data-coreview-artifact-logical-id={artifactLogicalId ?? undefined}
      data-coreview-artifact-version-id={artifactVersionId ?? undefined}
      data-testid="artifact-html-capture-canvas"
      className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
      style={{ inset: 0 }}
    >
      <canvas
        ref={canvasRef}
        width={HTML_CAPTURE_CANVAS_WIDTH}
        height={HTML_CAPTURE_CANVAS_HEIGHT}
        data-artifact-id={artifactId}
        data-coreview-artifact-id={artifactId}
        data-artifact-path={file?.path ?? undefined}
        data-coreview-artifact-path={file?.path ?? undefined}
        data-coreview-artifact-stable-identity={artifactStableIdentity ?? undefined}
        data-coreview-artifact-logical-id={artifactLogicalId ?? undefined}
        data-coreview-artifact-version-id={artifactVersionId ?? undefined}
        data-coreview-renderer-kind="html"
        data-artifact-canvas="true"
        data-coreview-artifact-canvas="true"
        data-artifact-canvas-source="selected-html-preview"
        data-coreview-artifact-canvas-source="selected-html-preview"
        data-coreview-offscreen-render="true"
        aria-label="Generated HTML artifact review canvas"
      />
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

function drawHtmlArtifactCapture(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  input: {
    artifact: BuilderArtifactV1
    file?: ArtifactViewportFile
    html: string
    previewText: string
    typeLabel: string
  },
) {
  const title = firstHtmlHeading(input.html)
    || htmlDocumentTitle(input.html)
    || input.artifact.artifactTitle
    || input.file?.name
    || "Generated webpage"
  const blocks = htmlTextToCaptureBlocks(input.previewText)
  const pageX = 54
  const pageY = 44
  const pageWidth = width - pageX * 2
  const pageHeight = height - pageY * 2
  const contentX = pageX + 48
  const maxTextWidth = pageWidth - 96
  let y = pageY + 116

  context.clearRect(0, 0, width, height)
  context.fillStyle = "#eef2f7"
  context.fillRect(0, 0, width, height)

  context.fillStyle = "#ffffff"
  fillRoundedRect(context, pageX, pageY, pageWidth, pageHeight, 22)

  context.fillStyle = "#e7edf5"
  fillRoundedRect(context, pageX + 18, pageY + 18, pageWidth - 36, 52, 18)
  context.fillStyle = "#ef4444"
  context.beginPath()
  context.arc(contentX, pageY + 44, 5, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = "#f59e0b"
  context.beginPath()
  context.arc(contentX + 20, pageY + 44, 5, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = "#10b981"
  context.beginPath()
  context.arc(contentX + 40, pageY + 44, 5, 0, Math.PI * 2)
  context.fill()

  context.fillStyle = "#64748b"
  context.font = "600 13px system-ui, sans-serif"
  context.fillText(input.typeLabel.toUpperCase(), contentX, pageY + 92)

  context.fillStyle = "#0f172a"
  context.font = "700 34px system-ui, sans-serif"
  y = drawWrappedCanvasText(context, title, contentX, y, maxTextWidth, 40, 2)

  context.fillStyle = "#64748b"
  context.font = "14px system-ui, sans-serif"
  drawSingleLineCanvasText(context, input.file?.name ?? "Generated webpage", contentX, y + 12, maxTextWidth)
  y += 48

  context.fillStyle = "#dbe3ee"
  context.fillRect(contentX, y, maxTextWidth, 1)
  y += 34

  for (const block of blocks.slice(0, MAX_CAPTURE_BLOCKS)) {
    if (y > pageY + pageHeight - 72) {
      drawOverflowHint(context, contentX, pageY + pageHeight - 42, maxTextWidth)
      break
    }

    context.fillStyle = block.kind === "h2" ? "#111827" : "#334155"
    context.font = block.kind === "h2" ? "700 22px system-ui, sans-serif" : "17px system-ui, sans-serif"
    y = drawWrappedCanvasText(
      context,
      block.text,
      contentX,
      y,
      maxTextWidth,
      block.kind === "h2" ? 30 : 25,
      block.kind === "h2" ? 2 : 4,
    ) + (block.kind === "h2" ? 12 : 10)
  }

  context.fillStyle = "#64748b"
  context.font = "13px system-ui, sans-serif"
  context.fillText("HTML artifact review view. Exact wording is available through trusted text.", contentX, height - 44)
}

type MarkdownCaptureBlock = {
  kind: "h1" | "h2" | "h3" | "paragraph" | "bullet" | "numbered" | "spacer"
  text: string
  prefix?: string
}

type HtmlCaptureBlock = {
  kind: "h2" | "paragraph"
  text: string
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

function firstHtmlHeading(html: string): string | null {
  const doc = parseHtmlDocument(html)
  const heading = doc?.querySelector("h1, h2, h3")?.textContent
  return normalizeCanvasText(heading)
}

function htmlDocumentTitle(html: string): string | null {
  const doc = parseHtmlDocument(html)
  return normalizeCanvasText(doc?.querySelector("title")?.textContent)
}

function htmlTextToCaptureBlocks(text: string): HtmlCaptureBlock[] {
  const normalized = normalizeCanvasText(text)
  if (!normalized) {
    return [{
      kind: "paragraph",
      text: "HTML preview content is ready. Use exact text for full wording.",
    }]
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean)
  const blocks: HtmlCaptureBlock[] = []
  let current = ""

  for (const sentence of sentences.length > 0 ? sentences : [normalized]) {
    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length <= 220) {
      current = candidate
      continue
    }
    if (current) {
      blocks.push({ kind: blocks.length === 0 ? "h2" : "paragraph", text: current })
    }
    current = sentence
  }

  if (current) {
    blocks.push({ kind: blocks.length === 0 ? "h2" : "paragraph", text: current })
  }

  return blocks
}

function parseHtmlDocument(html: string): Document | null {
  if (!html.trim() || typeof DOMParser === "undefined") {
    return null
  }
  try {
    return new DOMParser().parseFromString(html, "text/html")
  } catch {
    return null
  }
}

function normalizeCanvasText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? ""
  return normalized || null
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

function recordHtmlCaptureTargetTelemetry(input: {
  artifactId: string
  artifactPath: string | null
  artifactStableIdentity?: string | null
  artifactLogicalId?: string | null
  artifactVersionId?: string | null
  result: HtmlCaptureRegistrationResult
  succeeded: boolean
  failureReason: ArtifactVisualCaptureUnavailableReason | null
  readyLatencyMs: number
  rebindCount: number
}) {
  recordSophiaCaptureEvent({
    category: "artifacts-runtime",
    name: input.result === "registered" ? "capture_target_registered" : "html-capture-target",
    payload: {
      artifactId: input.artifactId,
      rendererKind: "html",
      htmlCaptureTargetRegistered: input.result === "registered",
      htmlCaptureTargetRegistrationResult: input.result,
      htmlCaptureTargetArtifactPathHash: stableTelemetryHash(input.artifactPath),
      htmlCaptureTargetStableIdentityHash: stableTelemetryHash(input.artifactStableIdentity),
      htmlCaptureTargetVersionAware: Boolean(input.artifactLogicalId || input.artifactVersionId),
      htmlCaptureTargetRebindCount: Math.max(0, input.rebindCount),
      htmlCaptureTargetReadyLatencyMs: input.readyLatencyMs,
      htmlFrameCaptureSourceKind: "html_preview_canvas",
      htmlFrameCaptureSucceeded: input.succeeded,
      htmlFrameCaptureFailureReason: input.failureReason,
      rawArtifactTextExcluded: true,
      rawHtmlExcluded: true,
      rawCommentTextExcluded: true,
      rawFrameExcluded: true,
      rawScreenshotExcluded: true,
    },
  })
}

function stableTelemetryHash(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function nowMs(): number {
  return Date.now()
}

function ArtifactMetadataPage({
  artifact,
  primaryFile,
  supportingFileCount,
  typeLabel,
  capabilityTruth,
}: {
  artifact: BuilderArtifactV1
  primaryFile?: ArtifactViewportFile
  supportingFileCount: number
  typeLabel: string
  capabilityTruth?: string | null
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

      {capabilityTruth ? (
        <p className="mt-4 text-sm leading-relaxed text-[color:var(--cosmic-text-muted)]">
          {capabilityTruth}
        </p>
      ) : null}

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
