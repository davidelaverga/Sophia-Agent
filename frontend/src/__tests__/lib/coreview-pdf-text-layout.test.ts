import { describe, expect, it } from "vitest"

import {
  buildCoreviewPdfTextLines,
  resolveCoreviewPdfTextAnchor,
  type CoreviewPdfTextLayout,
} from "../../app/lib/coreview-pdf-text-layout"

function layout(): CoreviewPdfTextLayout {
  const page = buildCoreviewPdfTextLines(0, 600, 800, [
    {
      pageIndex: 0,
      text: "Quarterly Launch Review",
      rect: { x: 0.12, y: 0.08, width: 0.58, height: 0.06 },
      fontHeight: 0.06,
    },
    {
      pageIndex: 0,
      text: "Budget delta is 17.4 percent",
      rect: { x: 0.14, y: 0.28, width: 0.42, height: 0.025 },
      fontHeight: 0.025,
    },
    {
      pageIndex: 0,
      text: "Risks",
      rect: { x: 0.14, y: 0.42, width: 0.16, height: 0.032 },
      fontHeight: 0.032,
    },
  ])
  return {
    pageCount: 1,
    pages: [page],
    rawTextExcluded: true,
  }
}

describe("Coreview PDF text layout anchors", () => {
  it("resolves current_title to the prominent top line", () => {
    const result = resolveCoreviewPdfTextAnchor(layout(), { type: "current_title" }, 0)

    expect(result).toMatchObject({
      ok: true,
      anchor: {
        anchorType: "current_title",
        pageIndex: 0,
      },
    })
    expect(result.ok ? result.anchor.rect.x : null).toBeCloseTo(0.12)
    expect(result.ok ? result.anchor.rect.y : null).toBeCloseTo(0.08)
    expect(result.ok ? result.anchor.rect.width : null).toBeCloseTo(0.58)
    expect(result.ok ? result.anchor.rect.height : null).toBeCloseTo(0.06)
    expect(JSON.stringify(result)).not.toContain("Quarterly Launch Review")
  })

  it("resolves text_quote when the quote exists on the visible page", () => {
    const result = resolveCoreviewPdfTextAnchor(layout(), {
      type: "text_quote",
      text: "budget delta",
    }, 0)

    expect(result).toMatchObject({
      ok: true,
      anchor: {
        anchorType: "text_quote",
        pageIndex: 0,
        matchCount: 1,
        rect: expect.objectContaining({
          y: 0.28,
        }),
      },
    })
  })

  it("returns anchor_not_found without raw text when no quote matches", () => {
    const result = resolveCoreviewPdfTextAnchor(layout(), {
      type: "text_quote",
      text: "missing phrase",
    }, 0)

    expect(result).toEqual({
      ok: false,
      blockedReason: "anchor_not_found",
    })
    expect(JSON.stringify(result)).not.toContain("missing phrase")
  })
})
