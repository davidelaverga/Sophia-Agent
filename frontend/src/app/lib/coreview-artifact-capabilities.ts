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
  /** True when a PPTX deliverable renders via its .preview.pdf sibling. */
  pptxPreviewPdf?: boolean | null
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
  artifactCapabilitySupportsArtifactUpdate: boolean
  artifactCapabilitySupportsScopedEdit: boolean
  artifactCapabilitySupportsVersioning: boolean
  artifactCapabilitySupportsOverwrite: boolean
  artifactCapabilitySupportsSourceRead: boolean
  artifactCapabilitySupportsNativeEdit: boolean
  artifactCapabilitySupportsRebuildFromSource: boolean
  artifactCapabilityRequiresFullRebuild: boolean
  artifactCapabilityRequiresConversion: boolean
  artifactCapabilityUnsupportedUpdateReason: string | null
  artifactCapabilityPreferredUpdateMode: string | null
}

const MARKDOWN_TRUTH = "Markdown preview is available. Visual annotations are not available for this format yet."
const HTML_TRUTH = "HTML preview, zoom, and visual annotations are available in Coreview."
const DOCX_TRUTH = "Word documents can be opened or downloaded. In-canvas document rendering is not available yet."
const PPTX_TRUTH = "PPTX native canvas rendering is not available yet. Open or download the file to review it."
const PPTX_PREVIEW_TRUTH = "Reviewing a rendered PDF preview of this deck. Download keeps the original PPTX."
const IMAGE_TRUTH = "Image files can be opened or downloaded. OCR is not available yet."
const METADATA_TRUTH = "A metadata preview is available. Rich artifact rendering is not available for this file yet."
const UNSUPPORTED_TRUTH = "This file can be opened or downloaded, but in-canvas rendering is not available yet."
const PDF_OCR_TRUTH = "Exact text is unavailable for this PDF. OCR is not available yet."
const PDF_UPDATE_UNSUPPORTED = "PDF native editing is not available yet. Revisions need an editable source artifact."
const PPTX_UPDATE_UNSUPPORTED = "PPTX native editing is not available yet."
const DOCX_UPDATE_UNSUPPORTED = "Word document native canvas updates are not available yet."
const OCR_UPDATE_UNSUPPORTED = "OCR-based artifact updates are not available yet."
const UNSUPPORTED_UPDATE_TRUTH = "This artifact format cannot be updated from Coreview yet."

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
      const pptxPreviewPdf = input.pptxPreviewPdf === true
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
        supportsArtifactUpdate: false,
        supportsSourceRead: false,
        supportsRebuildFromSource: false,
        unsupportedUpdateReason: requiresOCR
          ? OCR_UPDATE_UNSUPPORTED
          : pptxPreviewPdf
            ? PPTX_UPDATE_UNSUPPORTED
            : PDF_UPDATE_UNSUPPORTED,
        fallbackReason: requiresOCR ? "pdf_text_unavailable" : null,
        userFacingTruth: requiresOCR
          ? PDF_OCR_TRUTH
          : pptxPreviewPdf
            ? PPTX_PREVIEW_TRUTH
            : null,
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
        supportsArtifactUpdate: Boolean(input.artifactPath),
        supportsVersioning: Boolean(input.artifactPath),
        supportsSourceRead: Boolean(input.artifactPath),
        supportsRebuildFromSource: Boolean(input.artifactPath),
        requiresFullRebuild: Boolean(input.artifactPath),
        unsupportedUpdateReason: input.artifactPath
          ? null
          : "Markdown revisions need a readable source artifact path.",
        preferredUpdateMode: input.artifactPath ? "revise_version" : null,
        userFacingTruth: MARKDOWN_TRUTH,
      })
    case "html":
      return buildCapabilities({
        canRender: true,
        renderMode: "html",
        supportsZoom: true,
        supportsTextExtraction: true,
        supportsLayoutAnchors: true,
        supportsAnnotations: true,
        supportsComments: true,
        supportsUnderline: true,
        supportsStillFrame: true,
        supportsOriginalDownload: downloadAvailable,
        supportsOpenInNewTab: openAvailable,
        supportsArtifactUpdate: Boolean(input.artifactPath),
        supportsScopedEdit: Boolean(input.artifactPath),
        supportsVersioning: Boolean(input.artifactPath),
        supportsSourceRead: Boolean(input.artifactPath),
        supportsRebuildFromSource: Boolean(input.artifactPath),
        unsupportedUpdateReason: input.artifactPath
          ? null
          : "HTML revisions need a readable source artifact path.",
        preferredUpdateMode: input.artifactPath ? "revise_version" : null,
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
        unsupportedUpdateReason: OCR_UPDATE_UNSUPPORTED,
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
          unsupportedUpdateReason: PPTX_UPDATE_UNSUPPORTED,
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
          unsupportedUpdateReason: DOCX_UPDATE_UNSUPPORTED,
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
        unsupportedUpdateReason: UNSUPPORTED_UPDATE_TRUTH,
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
        unsupportedUpdateReason: UNSUPPORTED_UPDATE_TRUTH,
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
        unsupportedUpdateReason: UNSUPPORTED_UPDATE_TRUTH,
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
  pptxPreviewPdf,
}: {
  file: ArtifactRendererFileInput | null | undefined
  rendererKind: ArtifactRendererKind
  textExtractionStatus?: CoreviewTextExtractionCapabilityStatus
  exactTextAvailable?: boolean | null
  layoutAnchorsAvailable?: boolean | null
  originalDownloadAvailable?: boolean | null
  openInNewTabAvailable?: boolean | null
  pptxPreviewPdf?: boolean | null
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
    pptxPreviewPdf,
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
    supportsArtifactUpdate: capabilities.supportsArtifactUpdate,
    supportsScopedEdit: capabilities.supportsScopedEdit,
    supportsVersioning: capabilities.supportsVersioning,
    supportsOverwrite: capabilities.supportsOverwrite,
    supportsSourceRead: capabilities.supportsSourceRead,
    supportsNativeEdit: capabilities.supportsNativeEdit,
    supportsRebuildFromSource: capabilities.supportsRebuildFromSource,
    requiresFullRebuild: capabilities.requiresFullRebuild,
    requiresConversion: capabilities.requiresConversion,
    unsupportedUpdateReason: capabilities.unsupportedUpdateReason ?? null,
    preferredUpdateMode: capabilities.preferredUpdateMode ?? null,
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
    artifactCapabilitySupportsArtifactUpdate: capabilities.supportsArtifactUpdate,
    artifactCapabilitySupportsScopedEdit: capabilities.supportsScopedEdit,
    artifactCapabilitySupportsVersioning: capabilities.supportsVersioning,
    artifactCapabilitySupportsOverwrite: capabilities.supportsOverwrite,
    artifactCapabilitySupportsSourceRead: capabilities.supportsSourceRead,
    artifactCapabilitySupportsNativeEdit: capabilities.supportsNativeEdit,
    artifactCapabilitySupportsRebuildFromSource: capabilities.supportsRebuildFromSource,
    artifactCapabilityRequiresFullRebuild: capabilities.requiresFullRebuild,
    artifactCapabilityRequiresConversion: capabilities.requiresConversion,
    artifactCapabilityUnsupportedUpdateReason: capabilities.unsupportedUpdateReason ?? null,
    artifactCapabilityPreferredUpdateMode: capabilities.preferredUpdateMode ?? null,
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
    supportsArtifactUpdate: false,
    supportsScopedEdit: false,
    supportsVersioning: false,
    supportsOverwrite: false,
    supportsSourceRead: false,
    supportsNativeEdit: false,
    supportsRebuildFromSource: false,
    requiresFullRebuild: false,
    requiresConversion: false,
    unsupportedUpdateReason: null,
    preferredUpdateMode: null,
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
