import { describe, expect, it } from "vitest"

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

  it("builds same-origin artifact hrefs from normalized output paths", () => {
    expect(normalizeBuilderArtifactPath("/outputs/brief.md")).toBe("mnt/user-data/outputs/brief.md")
    expect(buildThreadArtifactHref("thread-1", "/outputs/brief.md")).toBe(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/brief.md",
    )
  })
})
