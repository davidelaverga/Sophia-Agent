import { describe, expect, it } from "vitest"

import { classifyCoreviewHtmlQuickEdit } from "../../app/lib/coreview-html-quick-edit"

describe("classifyCoreviewHtmlQuickEdit", () => {
  it("supports a quick main title edit", () => {
    const result = classifyCoreviewHtmlQuickEdit({
      userUpdateRequest: "Change the main title to Sophia Workspace Version Two",
      rendererKind: "html",
      artifactPath: "mnt/user-data/outputs/site.html",
    })

    expect(result).toMatchObject({
      supported: true,
      quickEditKind: "title",
      requestedChangeSummary: "Change the main title to Sophia Workspace Version Two",
      targetFields: {
        titleText: "Sophia Workspace Version Two",
      },
      fallbackReason: null,
    })
  })

  it("supports a quick card darkening edit", () => {
    const result = classifyCoreviewHtmlQuickEdit({
      userUpdateRequest: "Make the cards darker",
      rendererKind: "html",
      artifactPath: "mnt/user-data/outputs/site.html",
    })

    expect(result).toMatchObject({
      supported: true,
      quickEditKind: "cards_darker",
      fallbackReason: null,
    })
  })

  it("rejects whole-page redesign requests", () => {
    const result = classifyCoreviewHtmlQuickEdit({
      userUpdateRequest: "Redesign the whole page",
      rendererKind: "html",
      artifactPath: "mnt/user-data/outputs/site.html",
    })

    expect(result).toMatchObject({
      supported: false,
      quickEditKind: null,
      fallbackReason: "major_or_ambiguous_layout_change",
    })
  })

  it.each([
    { rendererKind: "pdf", artifactPath: "mnt/user-data/outputs/report.pdf" },
    { rendererKind: "download_only", artifactPath: "mnt/user-data/outputs/deck.pptx" },
    { rendererKind: "markdown", artifactPath: "mnt/user-data/outputs/brief.md" },
  ])("rejects non-HTML artifact requests for $artifactPath", ({ rendererKind, artifactPath }) => {
    const result = classifyCoreviewHtmlQuickEdit({
      userUpdateRequest: "Change the main title to Sophia Workspace Version Two",
      rendererKind,
      artifactPath,
    })

    expect(result.supported).toBe(false)
    expect(result.quickEditKind).toBeNull()
  })
})
