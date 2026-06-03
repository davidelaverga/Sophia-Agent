import { describe, expect, it } from "vitest"

import { detectArtifactRendererKind, isPdfArtifactFile } from "../../app/lib/artifact-renderers"
import {
  buildThreadArtifactHref,
  isMarkdownArtifactFile,
  normalizeBuilderArtifactPath,
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

  it("builds same-origin artifact hrefs from normalized output paths", () => {
    expect(normalizeBuilderArtifactPath("/outputs/brief.md")).toBe("mnt/user-data/outputs/brief.md")
    expect(buildThreadArtifactHref("thread-1", "/outputs/brief.md")).toBe(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/brief.md",
    )
  })
})
