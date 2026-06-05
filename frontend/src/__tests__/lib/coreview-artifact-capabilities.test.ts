import { describe, expect, it } from "vitest"

import {
  coreviewArtifactCapabilityTelemetry,
  getCoreviewArtifactCapabilities,
} from "../../app/lib/coreview-artifact-capabilities"

const INTERNAL_TRUTH_TERMS = [
  "download_only",
  "unsupported_renderer",
  "debug",
  "fixture",
  "provider",
  "transport",
]

describe("Coreview artifact capability matrix", () => {
  it("returns PDF canvas capabilities when text layout is available", () => {
    const capabilities = getCoreviewArtifactCapabilities({
      rendererKind: "pdf",
      artifactPath: "outputs/report.pdf",
      exactTextAvailable: true,
      textExtractionStatus: "success",
      layoutAnchorsAvailable: true,
    })

    expect(capabilities).toMatchObject({
      canRender: true,
      renderMode: "canvas",
      supportsPages: true,
      supportsPageRail: true,
      supportsZoom: true,
      supportsPan: true,
      supportsTextExtraction: true,
      supportsLayoutAnchors: true,
      supportsAnnotations: true,
      supportsComments: true,
      supportsUnderline: true,
      supportsArrow: true,
      supportsFreeDraw: false,
      supportsStillFrame: true,
      supportsAnnotatedExport: false,
      supportsOriginalDownload: true,
      supportsOCR: false,
      requiresOCR: false,
    })
  })

  it("returns truthful PPTX metadata fallback capabilities", () => {
    const capabilities = getCoreviewArtifactCapabilities({
      rendererKind: "download_only",
      artifactPath: "outputs/deck.pptx",
      title: "deck.pptx",
    })

    expect(capabilities).toMatchObject({
      canRender: true,
      renderMode: "metadata",
      supportsAnnotations: false,
      supportsTextExtraction: false,
      supportsOCR: false,
      requiresOCR: false,
      supportsPptxNativeRender: false,
      supportsOriginalDownload: true,
      supportsAnnotatedExport: false,
      fallbackReason: "pptx_native_renderer_unavailable",
    })
    expect(capabilities.userFacingTruth).toBe("PPTX native canvas rendering is not available yet. Open or download the file to review it.")
  })

  it("returns truthful DOCX metadata fallback capabilities", () => {
    const capabilities = getCoreviewArtifactCapabilities({
      rendererKind: "download_only",
      artifactPath: "outputs/brief.docx",
      title: "brief.docx",
    })

    expect(capabilities).toMatchObject({
      canRender: true,
      renderMode: "metadata",
      supportsAnnotations: false,
      supportsTextExtraction: false,
      supportsOriginalDownload: true,
      supportsAnnotatedExport: false,
      fallbackReason: "docx_native_renderer_unavailable",
    })
    expect(capabilities.userFacingTruth).toContain("Word documents can be opened or downloaded")
  })

  it("returns Markdown capabilities without page or annotation claims", () => {
    const capabilities = getCoreviewArtifactCapabilities({
      rendererKind: "markdown",
      artifactPath: "outputs/brief.md",
    })

    expect(capabilities).toMatchObject({
      canRender: true,
      renderMode: "markdown",
      supportsPages: false,
      supportsTextExtraction: true,
      supportsLayoutAnchors: false,
      supportsAnnotations: false,
      supportsStillFrame: true,
      supportsOriginalDownload: true,
    })
  })

  it("returns HTML capabilities without annotation claims", () => {
    const capabilities = getCoreviewArtifactCapabilities({
      rendererKind: "html",
      artifactPath: "outputs/site.html",
    })

    expect(capabilities).toMatchObject({
      canRender: true,
      renderMode: "html",
      supportsPages: false,
      supportsTextExtraction: true,
      supportsLayoutAnchors: false,
      supportsAnnotations: false,
      supportsStillFrame: true,
      supportsOriginalDownload: true,
    })
  })

  it("marks text images as requiring OCR while keeping OCR unavailable", () => {
    const capabilities = getCoreviewArtifactCapabilities({
      rendererKind: "image",
      artifactPath: "outputs/scan.png",
    })

    expect(capabilities).toMatchObject({
      renderMode: "metadata",
      supportsTextExtraction: false,
      supportsOCR: false,
      requiresOCR: true,
      fallbackReason: "image_ocr_unavailable",
    })
    expect(capabilities.userFacingTruth).toContain("OCR is not available yet")
  })

  it("emits safe capability telemetry and keeps user-facing truth free of internal terms", () => {
    const cases = [
      getCoreviewArtifactCapabilities({ rendererKind: "pdf", artifactPath: "outputs/report.pdf" }),
      getCoreviewArtifactCapabilities({ rendererKind: "markdown", artifactPath: "outputs/brief.md" }),
      getCoreviewArtifactCapabilities({ rendererKind: "html", artifactPath: "outputs/site.html" }),
      getCoreviewArtifactCapabilities({ rendererKind: "download_only", artifactPath: "outputs/brief.docx" }),
      getCoreviewArtifactCapabilities({ rendererKind: "download_only", artifactPath: "outputs/deck.pptx" }),
      getCoreviewArtifactCapabilities({ rendererKind: "image", artifactPath: "outputs/scan.png" }),
    ]

    const telemetry = coreviewArtifactCapabilityTelemetry("download_only", cases[4])
    expect(telemetry).toMatchObject({
      coreviewWorkspaceContractVersion: 1,
      artifactCapabilityRenderMode: "metadata",
      artifactCapabilitySupportsOCR: false,
      artifactCapabilitySupportsPptxNativeRender: false,
      artifactCapabilitySupportsAnnotatedExport: false,
    })

    for (const capabilities of cases) {
      const truth = capabilities.userFacingTruth
      if (!truth) {
        continue
      }
      for (const term of INTERNAL_TRUTH_TERMS) {
        expect(truth.toLowerCase()).not.toContain(term)
      }
    }
  })
})
