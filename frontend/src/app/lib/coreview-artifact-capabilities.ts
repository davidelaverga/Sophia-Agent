import type { ArtifactRendererFileInput, ArtifactRendererKind } from "./artifact-renderers"
import {
  COREVIEW_WORKSPACE_CONTRACT_VERSION,
  type CoreviewArtifactCapabilities,
  type CoreviewArtifactFallbackReason,
  type CoreviewCurrentViewCapabilitySummary,
  type CoreviewRenderMode,
  type CoreviewWorkspaceArtifact,
} from "./coreview-workspace-contract"

export type CoreviewTextExtractionCapabilityStatus =
  | "unavailable"
  | "idle"
  | "loading"
  | "pending"
  | "success"
  | "ready"
  | "failed"
  | "error"
  | null
  | undefined

export type CoreviewArtifactCapabilityInput = Partial<CoreviewWorkspaceArtifact> & {
  rendererKind: ArtifactRendererKind
  artifactPath?: string | null
  name?: string | null
  mimeType?: string | null
  fileExtension?: string | null
  textExtractionStatus?: CoreviewTextExtractionCapabilityStatus
  exactTextAvailable?: boolean | null
  layoutAnchorsAvailable?: boolean | null
  originalDownloadAvailable?: boolean | null
  openInNewTabAvailable?: boolean | null
}

export type CoreviewArtifactCapabilityTelemetry = {
  coreviewWorkspaceContractVersion: number
  artifactCapabilityRendererKind: ArtifactRendererKind
  artifactCapabilityRenderMode: CoreviewRenderMode
  artifactCapabilitySupportsPages: boolean
  artifactCapabilitySupportsAnnotations: boolean
  artifactCapabilitySupportsTextExtraction: boolean
  artifactCapabilitySupportsLayoutAnchors: boolean
  artifactCapabilitySupportsOCR: boolean
  artifactCapabilityRequiresOCR: boolean
  artifactCapabilitySupportsPptxNativeRender: boolean
  artifactCapabilitySupportsAnnotatedExport: boolean
  artifactCapabilityFallbackReason: CoreviewArtifactFallbackReason | null
}

const MARKDOWN_TRUTH = "Markdown preview is available. Visual annotations are not available for this format yet."
const HTML_TRUTH = "HTML preview is available. Visual annotations are not available for this format yet."
const DOCX_TRUTH = "Word documents can be opened or downloaded. In-canvas document rendering is not available yet."
const PPTX_TRUTH = "PPTX native canvas rendering is not available yet. Open or download the file to review it."
const IMAGE_TRUTH = "Image files can be opened or downloaded. OCR is not available yet."
const METADATA_TRUTH = "A metadata preview is available. Rich artifact rendering is not available for this file yet."
const UNSUPPORTED_TRUTH = "This file can be opened or downloaded, but in-canvas rendering is not available yet."
const PDF_OCR_TRUTH = "Exact text is unavailable for this PDF. OCR is not available yet."

export function getCoreviewArtifactCapabilities(
  input: CoreviewArtifactCapabilityInput,
): CoreviewArtifactCapabilities {
  const extension = normalizeFileExtension(input.fileExtension)
    ?? extensionFromArtifact(input)
  const downloadAvailable = input.originalDownloadAvailable !== false
  const openAvailable = input.openInNewTabAvailable !== false
  const exactTextAvailable = input.exactTextAvailable === true
  const textExtractionReady = exactTextAvailable || input.textExtractionStatus === "success" || input.textExtractionStatus === "ready"
  const textExtractionKnownUnavailable = input.textExtractionStatus === "failed"
    || input.textExtractionStatus === "error"
    || input.textExtractionStatus === "unavailable"
  const layoutAnchorsAvailable = input.layoutAnchorsAvailable === true

  switch (input.rendererKind) {
    case "pdf": {
      const requiresOCR = textExtractionKnownUnavailable && !textExtractionReady
      return buildCapabilities({
        canRender: true,
        renderMode: "canvas",
        supportsPages: true,
        supportsPageRail: true,
        supportsZoom: true,
        supportsPan: true,
        supportsTextExtraction: textExtractionReady,
        supportsLayoutAnchors: textExtractionReady && layoutAnchorsAvailable,
        supportsAnnotations: true,
        supportsComments: true,
        supportsUnderline: true,
        supportsArrow: true,
        supportsFreeDraw: false,
        supportsStillFrame: true,
        supportsAnnotatedExport: false,
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        supportsOCR: false,
        requiresOCR,
        supportsPptxNativeRender: false,
        fallbackReason: requiresOCR ? "pdf_text_unavailable" : null,
        userFacingTruth: requiresOCR ? PDF_OCR_TRUTH : null,
      })
    }
    case "markdown":
      return buildCapabilities({
        canRender: true,
        renderMode: "markdown",
        supportsTextExtraction: true,
        supportsStillFrame: true,
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        userFacingTruth: MARKDOWN_TRUTH,
      })
    case "html":
      return buildCapabilities({
        canRender: true,
        renderMode: "html",
        supportsTextExtraction: true,
        supportsStillFrame: true,
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        userFacingTruth: HTML_TRUTH,
      })
    case "image":
      return buildCapabilities({
        canRender: true,
        renderMode: "metadata",
        supportsStillFrame: true,
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        requiresOCR: true,
        fallbackReason: "image_ocr_unavailable",
        userFacingTruth: IMAGE_TRUTH,
      })
    case "download_only":
      if (isPptxExtension(extension) || isPptxMime(input.mimeType)) {
        return buildCapabilities({
          canRender: true,
          renderMode: "metadata",
          supportsStillFrame: true,
          supportsOriginalDownload: downloadAvailable,
          supportsOpenInNewTab: openAvailable,
          supportsPptxNativeRender: false,
          fallbackReason: "pptx_native_renderer_unavailable",
          userFacingTruth: PPTX_TRUTH,
        })
      }
      if (isDocxExtension(extension) || isDocxMime(input.mimeType)) {
        return buildCapabilities({
          canRender: true,
          renderMode: "metadata",
          supportsStillFrame: true,
          supportsOriginalDownload: downloadAvailable,
          supportsOpenInNewTab: openAvailable,
          fallbackReason: "docx_native_renderer_unavailable",
          userFacingTruth: DOCX_TRUTH,
        })
      }
      return buildCapabilities({
        canRender: true,
        renderMode: "metadata",
        supportsStillFrame: true,
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        fallbackReason: "download_only",
        userFacingTruth: UNSUPPORTED_TRUTH,
      })
    case "metadata":
      return buildCapabilities({
        canRender: true,
        renderMode: "metadata",
        supportsTextExtraction: false,
        supportsStillFrame: true,
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        userFacingTruth: METADATA_TRUTH,
      })
    case "unsupported":
    default:
      return buildCapabilities({
        canRender: false,
        renderMode: "unsupported",
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        fallbackReason: "unsupported_renderer",
        userFacingTruth: UNSUPPORTED_TRUTH,
      })
  }
}

export function getCoreviewArtifactCapabilitiesForFile({
  file,
  rendererKind,
  textExtractionStatus,
  exactTextAvailable,
  layoutAnchorsAvailable,
  originalDownloadAvailable,
  openInNewTabAvailable,
}: {
  file: ArtifactRendererFileInput | null | undefined
  rendererKind: ArtifactRendererKind
  textExtractionStatus?: CoreviewTextExtractionCapabilityStatus
  exactTextAvailable?: boolean | null
  layoutAnchorsAvailable?: boolean | null
  originalDownloadAvailable?: boolean | null
  openInNewTabAvailable?: boolean | null
}): CoreviewArtifactCapabilities {
  return getCoreviewArtifactCapabilities({
    rendererKind,
    artifactPath: file?.path ?? null,
    title: file?.name ?? null,
    name: file?.name ?? null,
    mimeType: file?.mimeType ?? null,
    textExtractionStatus,
    exactTextAvailable,
    layoutAnchorsAvailable,
    originalDownloadAvailable,
    openInNewTabAvailable,
  })
}

export function buildCoreviewCapabilitySummary({
  capabilities,
  rendererKind,
  pageIndex,
  pageCount,
}: {
  capabilities: CoreviewArtifactCapabilities
  rendererKind: ArtifactRendererKind
  pageIndex?: number | null
  pageCount?: number | null
}): CoreviewCurrentViewCapabilitySummary {
  return {
    rendererKind,
    renderMode: capabilities.renderMode,
    supportsPages: capabilities.supportsPages,
    supportsPageRail: capabilities.supportsPageRail,
    currentPage: typeof pageIndex === "number" ? Math.max(1, Math.floor(pageIndex) + 1) : null,
    pageCount: typeof pageCount === "number" ? Math.max(1, Math.floor(pageCount)) : null,
    supportsTextExtraction: capabilities.supportsTextExtraction,
    supportsLayoutAnchors: capabilities.supportsLayoutAnchors,
    supportsAnnotations: capabilities.supportsAnnotations,
    supportsZoom: capabilities.supportsZoom,
    supportsPan: capabilities.supportsPan,
    supportsAnnotatedExport: capabilities.supportsAnnotatedExport,
    supportsOCR: capabilities.supportsOCR,
    requiresOCR: capabilities.requiresOCR,
    supportsPptxNativeRender: capabilities.supportsPptxNativeRender,
    fallbackReason: capabilities.fallbackReason ?? null,
    userFacingTruth: capabilities.userFacingTruth ?? null,
  }
}

export function coreviewArtifactCapabilityTelemetry(
  rendererKind: ArtifactRendererKind,
  capabilities: CoreviewArtifactCapabilities,
): CoreviewArtifactCapabilityTelemetry {
  return {
    coreviewWorkspaceContractVersion: COREVIEW_WORKSPACE_CONTRACT_VERSION,
    artifactCapabilityRendererKind: rendererKind,
    artifactCapabilityRenderMode: capabilities.renderMode,
    artifactCapabilitySupportsPages: capabilities.supportsPages,
    artifactCapabilitySupportsAnnotations: capabilities.supportsAnnotations,
    artifactCapabilitySupportsTextExtraction: capabilities.supportsTextExtraction,
    artifactCapabilitySupportsLayoutAnchors: capabilities.supportsLayoutAnchors,
    artifactCapabilitySupportsOCR: capabilities.supportsOCR,
    artifactCapabilityRequiresOCR: capabilities.requiresOCR,
    artifactCapabilitySupportsPptxNativeRender: capabilities.supportsPptxNativeRender,
    artifactCapabilitySupportsAnnotatedExport: capabilities.supportsAnnotatedExport,
    artifactCapabilityFallbackReason: capabilities.fallbackReason ?? null,
  }
}

function buildCapabilities(
  overrides: Partial<CoreviewArtifactCapabilities>,
): CoreviewArtifactCapabilities {
  return {
    canRender: false,
    renderMode: "unsupported",
    supportsPages: false,
    supportsPageRail: false,
    supportsZoom: false,
    supportsPan: false,
    supportsTextExtraction: false,
    supportsLayoutAnchors: false,
    supportsAnnotations: false,
    supportsComments: false,
    supportsUnderline: false,
    supportsArrow: false,
    supportsFreeDraw: false,
    supportsStillFrame: false,
    supportsAnnotatedExport: false,
    supportsOriginalDownload: false,
    supportsOpenInNewTab: false,
    supportsOCR: false,
    requiresOCR: false,
    supportsPptxNativeRender: false,
    fallbackReason: null,
    userFacingTruth: null,
    ...overrides,
  }
}

function extensionFromArtifact(input: CoreviewArtifactCapabilityInput): string | null {
  const value = [input.name, input.title, input.artifactPath]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
  if (!value) {
    return null
  }
  const clean = value.toLowerCase().split(/[?#]/u)[0] ?? ""
  const match = /\.[a-z0-9]+$/u.exec(clean)
  return match?.[0] ?? null
}

function normalizeFileExtension(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return null
  }
  return normalized.startsWith(".") ? normalized : `.${normalized}`
}

function isDocxExtension(value: string | null): boolean {
  return value === ".doc" || value === ".docx"
}

function isPptxExtension(value: string | null): boolean {
  return value === ".ppt" || value === ".pptx"
}

function isDocxMime(value: string | null | undefined): boolean {
  const mimeType = normalizeMime(value)
  return mimeType === "application/msword"
    || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

function isPptxMime(value: string | null | undefined): boolean {
  const mimeType = normalizeMime(value)
  return mimeType === "application/vnd.ms-powerpoint"
    || mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
}

function normalizeMime(value: string | null | undefined): string {
  return value?.toLowerCase().split(";")[0]?.trim() ?? ""
}
