import type {
  CoreviewAnnotationAnchor,
  CoreviewNormalizedPoint,
  CoreviewNormalizedRect,
  CoreviewResolveAnnotationAnchorResult,
} from "./coreview-actions"

export interface CoreviewPdfTextItemLayout {
  pageIndex: number
  text: string
  rect: CoreviewNormalizedRect
  fontHeight: number
}

export interface CoreviewPdfTextLineLayout {
  pageIndex: number
  text: string
  rect: CoreviewNormalizedRect
  maxFontHeight: number
  itemCount: number
}

export interface CoreviewPdfTextPageLayout {
  pageIndex: number
  width: number
  height: number
  items: CoreviewPdfTextItemLayout[]
  lines: CoreviewPdfTextLineLayout[]
}

export interface CoreviewPdfTextLayout {
  pageCount: number
  pages: CoreviewPdfTextPageLayout[]
  rawTextExcluded: true
}

export function resolveCoreviewPdfTextAnchor(
  layout: CoreviewPdfTextLayout | null | undefined,
  anchor: CoreviewAnnotationAnchor,
  pageIndex: number,
  currentSelection: { rect?: CoreviewNormalizedRect | null; point?: CoreviewNormalizedPoint | null } | null = null,
): CoreviewResolveAnnotationAnchorResult {
  if (anchor.type === "rect") {
    const rect = normalizeRect(anchor)
    return rect
      ? { ok: true, anchor: { anchorType: "rect", pageIndex, rect, point: null } }
      : { ok: false, blockedReason: "invalid_rect" }
  }

  if (anchor.type === "point") {
    return {
      ok: true,
      anchor: {
        anchorType: "point",
        pageIndex,
        rect: null,
        point: { x: clampNormalized(anchor.x), y: clampNormalized(anchor.y) },
      },
    }
  }

  if (anchor.type === "current_selection") {
    const rect = currentSelection?.rect ? normalizeRect(currentSelection.rect) : null
    const point = currentSelection?.point ? normalizePoint(currentSelection.point) : null
    if (rect || point) {
      return {
        ok: true,
        anchor: {
          anchorType: "current_selection",
          pageIndex,
          rect,
          point,
        },
      }
    }
    return { ok: false, blockedReason: "anchor_not_found" }
  }

  const page = layout?.pages.find((candidate) => candidate.pageIndex === pageIndex)
  if (!page) {
    return { ok: false, blockedReason: "anchor_not_found" }
  }

  if (anchor.type === "current_title") {
    const title = resolveCurrentTitleLine(page)
    if (!title) {
      return { ok: false, blockedReason: "anchor_not_found" }
    }
    return {
      ok: true,
      anchor: {
        anchorType: "current_title",
        pageIndex,
        rect: title.rect,
        point: null,
        matchCount: 1,
        textLength: title.text.length,
      },
    }
  }

  const quote = normalizeSearchText(anchor.text)
  if (!quote) {
    return { ok: false, blockedReason: "anchor_not_found" }
  }
  const occurrence = Math.max(1, Math.floor(anchor.occurrence ?? 1))
  const matches = page.lines.filter((line) => normalizeSearchText(line.text).includes(quote))
  const match = matches[occurrence - 1] ?? null
  if (!match) {
    return { ok: false, blockedReason: "anchor_not_found" }
  }
  return {
    ok: true,
    anchor: {
      anchorType: "text_quote",
      pageIndex,
      rect: match.rect,
      point: null,
      matchCount: matches.length,
      textLength: match.text.length,
    },
  }
}

export function buildCoreviewPdfTextLines(
  pageIndex: number,
  width: number,
  height: number,
  items: CoreviewPdfTextItemLayout[],
): CoreviewPdfTextPageLayout {
  const sorted = items
    .filter((item) => item.pageIndex === pageIndex && item.text.trim() && item.rect.width > 0 && item.rect.height > 0)
    .sort((left, right) => (
      Math.abs(left.rect.y - right.rect.y) > 0.006
        ? left.rect.y - right.rect.y
        : left.rect.x - right.rect.x
    ))

  const grouped: CoreviewPdfTextItemLayout[][] = []
  for (const item of sorted) {
    const centerY = item.rect.y + item.rect.height / 2
    const group = grouped.find((candidate) => {
      const first = candidate[0]
      if (!first) {
        return false
      }
      const groupCenter = first.rect.y + first.rect.height / 2
      const tolerance = Math.max(first.rect.height, item.rect.height, 0.012) * 0.72
      return Math.abs(groupCenter - centerY) <= tolerance
    })

    if (group) {
      group.push(item)
    } else {
      grouped.push([item])
    }
  }

  const lines = grouped
    .map((group) => {
      const ordered = [...group].sort((left, right) => left.rect.x - right.rect.x)
      const rect = unionRects(ordered.map((item) => item.rect))
      if (!rect) {
        return null
      }
      return {
        pageIndex,
        text: ordered.map((item) => item.text.trim()).filter(Boolean).join(" ").replace(/\s+/gu, " "),
        rect,
        maxFontHeight: Math.max(...ordered.map((item) => item.fontHeight), rect.height),
        itemCount: ordered.length,
      } satisfies CoreviewPdfTextLineLayout
    })
    .filter((line): line is CoreviewPdfTextLineLayout => Boolean(line?.text.trim()))

  return {
    pageIndex,
    width,
    height,
    items: sorted,
    lines,
  }
}

function resolveCurrentTitleLine(page: CoreviewPdfTextPageLayout): CoreviewPdfTextLineLayout | null {
  const lines = page.lines.filter((line) => line.text.trim())
  if (lines.length === 0) {
    return null
  }
  const maxHeight = Math.max(...lines.map((line) => line.maxFontHeight))
  const prominent = lines.filter((line) => (
    line.rect.y <= 0.55
    && line.maxFontHeight >= maxHeight * 0.78
  ))
  const candidates = prominent.length > 0
    ? prominent
    : lines.filter((line) => line.maxFontHeight >= maxHeight * 0.9)

  return [...candidates].sort((left, right) => {
    const heightDelta = right.maxFontHeight - left.maxFontHeight
    if (Math.abs(heightDelta) > 0.006) {
      return heightDelta
    }
    const yDelta = left.rect.y - right.rect.y
    if (Math.abs(yDelta) > 0.006) {
      return yDelta
    }
    return left.rect.x - right.rect.x
  })[0] ?? null
}

function unionRects(rects: CoreviewNormalizedRect[]): CoreviewNormalizedRect | null {
  const normalized = rects.map(normalizeRect).filter((rect): rect is CoreviewNormalizedRect => rect !== null)
  if (normalized.length === 0) {
    return null
  }
  const left = Math.min(...normalized.map((rect) => rect.x))
  const top = Math.min(...normalized.map((rect) => rect.y))
  const right = Math.max(...normalized.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...normalized.map((rect) => rect.y + rect.height))
  return normalizeRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  })
}

function normalizeRect(rect: CoreviewNormalizedRect): CoreviewNormalizedRect | null {
  if (
    !Number.isFinite(rect.x)
    || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) {
    return null
  }
  const x = clampNormalized(rect.x)
  const y = clampNormalized(rect.y)
  const right = clampNormalized(rect.x + rect.width)
  const bottom = clampNormalized(rect.y + rect.height)
  if (right <= x || bottom <= y) {
    return null
  }
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  }
}

function normalizePoint(point: CoreviewNormalizedPoint): CoreviewNormalizedPoint | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null
  }
  return {
    x: clampNormalized(point.x),
    y: clampNormalized(point.y),
  }
}

function normalizeSearchText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase()
}

function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}
