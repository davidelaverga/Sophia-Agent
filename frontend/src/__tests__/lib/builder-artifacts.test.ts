import { describe, expect, it } from "vitest"

import { detectArtifactRendererKind, isPdfArtifactFile } from "../../app/lib/artifact-renderers"
import {
  buildThreadArtifactHref,
  classifyBuilderArtifactFileRole,
  formatBuilderArtifactFileRoleLabel,
  getBuilderArtifactFileBaseStem,
  isHtmlArtifactFile,
  isMarkdownArtifactFile,
  isPptxArtifactFile,
  normalizeBuilderArtifactPath,
  normalizeBuilderArtifactPayload,
  rankBuilderArtifactLibraryItems,
  resolveCanvasRenderFile,
} from "../../app/lib/builder-artifacts"

describe("builder artifact utilities", () => {
  it("detects markdown artifacts by extension or content type", () => {
    expect(isMarkdownArtifactFile({
      path: "mnt/user-data/outputs/brief.md",
      name: "brief.md",
    })).toBe(true)

    expect(isMarkdownArtifactFile({
      path: "mnt/user-data/outputs/brief",
      name: "brief",
      mimeType: "text/markdown; charset=utf-8",
    })).toBe(true)

    expect(isMarkdownArtifactFile({
      path: "mnt/user-data/outputs/brief.pdf",
      name: "brief.pdf",
      mimeType: "application/pdf",
    })).toBe(false)
  })

  it("detects PDF artifacts as the PDF renderer by extension, content type, or metadata", () => {
    expect(isPdfArtifactFile({
      path: "mnt/user-data/outputs/brief.pdf",
      name: "brief.pdf",
    })).toBe(true)

    expect(detectArtifactRendererKind({
      path: "mnt/user-data/outputs/brief",
      name: "brief",
      mimeType: "application/pdf",
    })).toBe("pdf")

    expect(detectArtifactRendererKind({
      path: "mnt/user-data/outputs/brief",
      name: "brief",
    }, {
      artifactType: "pdf",
    })).toBe("pdf")
  })

  it("detects HTML artifacts by extension or content type", () => {
    expect(isHtmlArtifactFile({
      path: "mnt/user-data/outputs/deck-fallback.html",
      name: "deck-fallback.html",
    })).toBe(true)

    expect(isHtmlArtifactFile({
      path: "mnt/user-data/outputs/deck-fallback",
      name: "deck-fallback",
      mimeType: "text/html; charset=utf-8",
    })).toBe(true)

    expect(isHtmlArtifactFile({
      path: "mnt/user-data/outputs/deck-fallback.md",
      name: "deck-fallback.md",
      mimeType: "text/markdown",
    })).toBe(false)

    expect(detectArtifactRendererKind({
      path: "mnt/user-data/outputs/sophia-workspace-demo.html",
      name: "sophia-workspace-demo.html",
    })).toBe("html")
  })

  it("builds same-origin artifact hrefs from normalized output paths", () => {
    expect(normalizeBuilderArtifactPath("/outputs/brief.md")).toBe("mnt/user-data/outputs/brief.md")
    expect(buildThreadArtifactHref("thread-1", "/outputs/brief.md")).toBe(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/brief.md",
    )
  })

  it("detects PPTX artifacts by extension or content type", () => {
    expect(isPptxArtifactFile({ path: "mnt/user-data/outputs/deck.pptx", name: "deck.pptx" })).toBe(true)
    expect(isPptxArtifactFile({ path: "mnt/user-data/outputs/deck.ppt", name: "deck.ppt" })).toBe(true)
    expect(isPptxArtifactFile({
      path: "mnt/user-data/outputs/deck",
      name: "deck",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    })).toBe(true)
    expect(isPptxArtifactFile({ path: "mnt/user-data/outputs/deck.pdf", name: "deck.pdf" })).toBe(false)
  })

  it("normalizes artifact_preview_filename from builder payloads", () => {
    const artifact = normalizeBuilderArtifactPayload({
      artifact_path: "/mnt/user-data/outputs/sophia-deck.pptx",
      artifact_type: "presentation",
      artifact_title: "Sophia deck",
      artifact_preview_filename: "sophia-deck.preview.pdf",
      supporting_files: ["/mnt/user-data/outputs/sophia-deck.preview.pdf"],
    })

    expect(artifact).toMatchObject({
      artifactPath: "mnt/user-data/outputs/sophia-deck.pptx",
      artifactPreviewFilename: "sophia-deck.preview.pdf",
    })
  })
})

describe("builder artifact file roles", () => {
  it("derives base stems across render-source and preview siblings", () => {
    expect(getBuilderArtifactFileBaseStem({ name: "sophia-roadmap.pdf" })).toBe("sophia-roadmap")
    expect(getBuilderArtifactFileBaseStem({ name: "sophia-roadmap.pdf.md" })).toBe("sophia-roadmap")
    expect(getBuilderArtifactFileBaseStem({ name: "deck.preview.pdf" })).toBe("deck")
    expect(getBuilderArtifactFileBaseStem({ name: "deck.pptx" })).toBe("deck")
    expect(getBuilderArtifactFileBaseStem({ path: "mnt/user-data/outputs/deck.pptx.md" })).toBe("deck")
  })

  it("classifies render-source and preview siblings as non-deliverables", () => {
    expect(classifyBuilderArtifactFileRole({ name: "sophia-roadmap.pdf.md" })).toBe("source")
    expect(classifyBuilderArtifactFileRole({ name: "deck.pptx.md" })).toBe("source")
    expect(classifyBuilderArtifactFileRole({ name: "deck.preview.pdf" })).toBe("preview")
    expect(classifyBuilderArtifactFileRole({ name: "sophia-roadmap.pdf" })).toBe("deliverable")
    expect(classifyBuilderArtifactFileRole({ name: "deck.pptx" })).toBe("deliverable")
  })

  it("classifies a same-stem markdown next to a rendered deliverable as source", () => {
    const siblings = [
      { name: "report.md", path: "mnt/user-data/outputs/report.md" },
      { name: "report.pdf", path: "mnt/user-data/outputs/report.pdf" },
    ]
    expect(classifyBuilderArtifactFileRole(siblings[0], siblings)).toBe("source")
    expect(classifyBuilderArtifactFileRole(siblings[1], siblings)).toBe("deliverable")
    expect(classifyBuilderArtifactFileRole({ name: "standalone-notes.md" }, siblings)).toBe("deliverable")
  })

  it("formats badge labels only for non-deliverable roles", () => {
    expect(formatBuilderArtifactFileRoleLabel("source")).toBe("Source")
    expect(formatBuilderArtifactFileRoleLabel("preview")).toBe("Preview")
    expect(formatBuilderArtifactFileRoleLabel("deliverable")).toBeNull()
  })

  it("ranks the primary deliverable above newer source and preview siblings", () => {
    // Incoming order mirrors the gateway's mtime DESC sort: the markdown
    // render source and deck preview are written after the deliverables.
    const ranked = rankBuilderArtifactLibraryItems([
      { path: "mnt/user-data/outputs/sophia-roadmap.pdf.md", name: "sophia-roadmap.pdf.md" },
      { path: "mnt/user-data/outputs/deck.preview.pdf", name: "deck.preview.pdf" },
      { path: "mnt/user-data/outputs/sophia-roadmap.pdf", name: "sophia-roadmap.pdf" },
      { path: "mnt/user-data/outputs/deck.pptx", name: "deck.pptx" },
    ])

    expect(ranked.map((item) => item.name)).toEqual([
      "sophia-roadmap.pdf",
      "deck.pptx",
      "sophia-roadmap.pdf.md",
      "deck.preview.pdf",
    ])
  })

  it("orders same-stem deliverables by extension priority and keeps unrelated order stable", () => {
    const ranked = rankBuilderArtifactLibraryItems([
      { path: "mnt/user-data/outputs/launch.md", name: "launch.md" },
      { path: "mnt/user-data/outputs/launch.html", name: "launch.html" },
      { path: "mnt/user-data/outputs/launch.pptx", name: "launch.pptx" },
      { path: "mnt/user-data/outputs/launch.pdf", name: "launch.pdf" },
      { path: "mnt/user-data/outputs/unrelated-notes.txt", name: "unrelated-notes.txt" },
    ])

    // launch.md classifies as a render source (same stem as launch.pdf), so
    // it sinks below every deliverable, including unrelated ones.
    expect(ranked.map((item) => item.name)).toEqual([
      "launch.pdf",
      "launch.pptx",
      "launch.html",
      "unrelated-notes.txt",
      "launch.md",
    ])
  })
})

describe("resolveCanvasRenderFile", () => {
  const pptxPrimary = {
    path: "mnt/user-data/outputs/sophia-deck.pptx",
    name: "sophia-deck.pptx",
    label: "sophia-deck.pptx",
    isPrimary: true,
  }
  const previewSibling = {
    path: "mnt/user-data/outputs/sophia-deck.preview.pdf",
    name: "sophia-deck.preview.pdf",
    label: "sophia-deck.preview.pdf",
    isPrimary: false,
  }

  it("renders a PPTX through its stem-matched .preview.pdf sibling while downloads keep the deck", () => {
    const resolved = resolveCanvasRenderFile([pptxPrimary, previewSibling])

    expect(resolved.renderFile).toBe(previewSibling)
    expect(resolved.downloadFile).toBe(pptxPrimary)
    expect(resolved.previewKind).toBe("pptx_pdf_preview")
  })

  it("prefers artifact_preview_filename from the completion metadata when present", () => {
    const namedPreview = {
      path: "mnt/user-data/outputs/deck-render.preview.pdf",
      name: "deck-render.preview.pdf",
      label: "deck-render.preview.pdf",
      isPrimary: false,
    }
    const resolved = resolveCanvasRenderFile(
      [pptxPrimary, namedPreview],
      { artifactPreviewFilename: "deck-render.preview.pdf" },
    )

    expect(resolved.renderFile).toBe(namedPreview)
    expect(resolved.downloadFile).toBe(pptxPrimary)
    expect(resolved.previewKind).toBe("pptx_pdf_preview")
  })

  it("falls back to stem matching when the named preview is missing from the file set", () => {
    const resolved = resolveCanvasRenderFile(
      [pptxPrimary, previewSibling],
      { artifactPreviewFilename: "somewhere-else.preview.pdf" },
    )

    expect(resolved.renderFile).toBe(previewSibling)
    expect(resolved.previewKind).toBe("pptx_pdf_preview")
  })

  it("keeps rendering the primary when no preview sibling exists", () => {
    const resolved = resolveCanvasRenderFile([pptxPrimary])

    expect(resolved.renderFile).toBe(pptxPrimary)
    expect(resolved.downloadFile).toBe(pptxPrimary)
    expect(resolved.previewKind).toBeNull()
  })

  it("never reroutes non-PPTX primaries", () => {
    const pdfPrimary = {
      path: "mnt/user-data/outputs/report.pdf",
      name: "report.pdf",
      label: "report.pdf",
      isPrimary: true,
    }
    const resolved = resolveCanvasRenderFile([pdfPrimary, previewSibling])

    expect(resolved.renderFile).toBe(pdfPrimary)
    expect(resolved.downloadFile).toBe(pdfPrimary)
    expect(resolved.previewKind).toBeNull()
  })
})
