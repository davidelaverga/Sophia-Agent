export type CoreviewHtmlNavigationTargetKind =
  | "id"
  | "heading"
  | "nav"
  | "button"
  | "text"
  | "top"
  | "bottom"
  | "external"
  | "unknown"

export type CoreviewHtmlNavigationFailureReason =
  | "section_not_found"
  | "iframe_not_ready"
  | "section_index_not_ready"
  | "command_timeout"
  | "bridge_unavailable"
  | "document_unavailable"
  | "cross_origin_unavailable"
  | "unsupported_renderer"

export type CoreviewHtmlNavigationCommandKind =
  | "scroll_by"
  | "scroll_to"
  | "focus_text"
  | "internal_link"

export interface CoreviewHtmlSectionIndexEntry {
  targetKind: CoreviewHtmlNavigationTargetKind
  targetLabelSafe: string
  labels: string[]
  hrefTargetSafe?: string | null
  element?: Element | null
}

export interface CoreviewHtmlSectionIndex {
  ok: boolean
  entries: CoreviewHtmlSectionIndexEntry[]
  entryCount: number
  buildResult: "success" | CoreviewHtmlNavigationFailureReason
  builtAt: number
  rawHtmlExcluded: true
  rawArtifactTextExcluded: true
}

export interface CoreviewHtmlResolveInput {
  target: string | null | undefined
  excludeElement?: Element | null
}

export interface CoreviewHtmlResolveResult {
  ok: boolean
  targetKind: CoreviewHtmlNavigationTargetKind
  targetLabelSafe: string | null
  element: Element | null
  reason: CoreviewHtmlNavigationFailureReason | null
  indexEntryCount: number
  indexBuildResult: CoreviewHtmlSectionIndex["buildResult"]
  rawHtmlExcluded: true
  rawArtifactTextExcluded: true
}

const SAFE_LABEL_MAX_LENGTH = 96
const TEXT_INDEX_MAX_LENGTH = 140

const TOP_ALIASES = new Set(["top", "front page", "frontpage", "home", "hero"])
const BOTTOM_ALIASES = new Set(["bottom", "end"])

const TARGET_ALIASES: Record<string, string[]> = {
  top: ["top", "front page", "frontpage", "home", "hero"],
  bottom: ["bottom", "end"],
  features: ["features", "feature"],
  coreview: ["coreview", "co review", "co-review", "review"],
  docs: ["docs", "documentation", "documentations"],
  roadmap: ["roadmap", "road map"],
  pricing: ["pricing", "price", "plans"],
  about: ["about", "about us"],
  contact: ["contact", "contact us", "support"],
}

const INDEX_SELECTORS = {
  id: "[id]",
  name: "[name]",
  headings: "h1,h2,h3,h4,h5,h6,[role='heading']",
  nav: "nav a,nav button,[role='navigation'] a,[role='navigation'] button",
  links: "a[href]",
  buttons: "button,[role='button']",
  ariaLabels: "[aria-label]",
  dataTargets: "[data-target],[data-section],[data-scroll],[data-scroll-target],[data-section-target]",
  text: "main p,main li,section p,section li,article p,article li,p,li,blockquote,td,th,[data-text-anchor]",
}

type SectionIndexEntryBuilder = (element: Element) => CoreviewHtmlSectionIndexEntry | null

function idLikeSectionEntry(element: Element, attribute: "id" | "name"): CoreviewHtmlSectionIndexEntry | null {
  const value = safeHtmlNavigationLabel(element.getAttribute(attribute))
  if (!value) return null
  return {
    targetKind: "id",
    targetLabelSafe: value,
    labels: [
      value,
      labelForElement(element),
      cleanHtmlNavigationTarget(value),
    ],
    element,
  }
}

function idSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  return idLikeSectionEntry(element, "id")
}

function nameSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  return idLikeSectionEntry(element, "name")
}

function headingSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  const label = labelForElement(element, TEXT_INDEX_MAX_LENGTH)
  if (!label) return null
  return {
    targetKind: "heading",
    targetLabelSafe: label,
    labels: [
      label,
      element.getAttribute("id") ?? "",
      element.getAttribute("aria-label") ?? "",
    ],
    element,
  }
}

function navLikeSectionEntry(element: Element, fallbackLabel: string): CoreviewHtmlSectionIndexEntry | null {
  const label = labelForElement(element, TEXT_INDEX_MAX_LENGTH)
  const hrefTarget = hrefTargetFromElement(element)
  if (!label && !hrefTarget) return null
  return {
    targetKind: "nav",
    targetLabelSafe: label || hrefTarget || fallbackLabel,
    labels: [
      label,
      hrefTarget,
      cleanHtmlNavigationTarget(element.getAttribute("href") ?? ""),
    ],
    hrefTargetSafe: hrefTarget,
    element,
  }
}

function navSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  return navLikeSectionEntry(element, "navigation")
}

function linkSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  return navLikeSectionEntry(element, "link")
}

function buttonOrTextTargetKind(element: Element): CoreviewHtmlNavigationTargetKind {
  return element.matches("button,[role='button']") ? "button" : "text"
}

function dataTargetSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  const target = dataNavigationTargetFromElement(element)
  if (!target) return null
  const visibleLabel = safeHtmlNavigationLabel(element.textContent, TEXT_INDEX_MAX_LENGTH)
  return {
    targetKind: buttonOrTextTargetKind(element),
    targetLabelSafe: visibleLabel || labelForElement(element) || target,
    labels: [
      target,
      visibleLabel,
      labelForElement(element, TEXT_INDEX_MAX_LENGTH),
    ],
    hrefTargetSafe: target,
    element,
  }
}

function ariaLabelSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  const label = safeHtmlNavigationLabel(element.getAttribute("aria-label"), TEXT_INDEX_MAX_LENGTH)
  if (!label) return null
  return {
    targetKind: buttonOrTextTargetKind(element),
    targetLabelSafe: label,
    labels: [
      label,
      element.getAttribute("id") ?? "",
      dataNavigationTargetFromElement(element),
      hrefTargetFromElement(element),
    ],
    hrefTargetSafe: dataNavigationTargetFromElement(element) || hrefTargetFromElement(element),
    element,
  }
}

function buttonSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  const label = labelForElement(element, TEXT_INDEX_MAX_LENGTH)
  if (!label) return null
  return {
    targetKind: "button",
    targetLabelSafe: label,
    labels: [label],
    hrefTargetSafe: dataNavigationTargetFromElement(element),
    element,
  }
}

function textSectionEntry(element: Element): CoreviewHtmlSectionIndexEntry | null {
  const label = labelForElement(element, TEXT_INDEX_MAX_LENGTH)
  if (!label) return null
  return {
    targetKind: "text",
    targetLabelSafe: label,
    labels: [label],
    element,
  }
}

const SECTION_INDEX_COLLECTORS: ReadonlyArray<readonly [string, SectionIndexEntryBuilder]> = [
  [INDEX_SELECTORS.id, idSectionEntry],
  [INDEX_SELECTORS.name, nameSectionEntry],
  [INDEX_SELECTORS.headings, headingSectionEntry],
  [INDEX_SELECTORS.nav, navSectionEntry],
  [INDEX_SELECTORS.links, linkSectionEntry],
  [INDEX_SELECTORS.dataTargets, dataTargetSectionEntry],
  [INDEX_SELECTORS.ariaLabels, ariaLabelSectionEntry],
  [INDEX_SELECTORS.buttons, buttonSectionEntry],
  [INDEX_SELECTORS.text, textSectionEntry],
]

function pushSectionIndexEntry(
  entries: CoreviewHtmlSectionIndexEntry[],
  seen: Set<string>,
  entry: CoreviewHtmlSectionIndexEntry,
): void {
  const labels = uniqueSafeLabels(entry.labels)
  const targetLabelSafe = safeHtmlNavigationLabel(entry.targetLabelSafe || labels[0])
  if (!targetLabelSafe && labels.length === 0) {
    return
  }
  const normalizedKey = [
    entry.targetKind,
    targetLabelSafe,
    labels.map(htmlNavigationMatchKey).join(","),
    safeHtmlNavigationLabel(entry.hrefTargetSafe),
  ].join("|")
  if (seen.has(normalizedKey)) {
    return
  }
  seen.add(normalizedKey)
  entries.push({
    ...entry,
    targetLabelSafe: targetLabelSafe || labels[0] || "section",
    labels,
    hrefTargetSafe: safeHtmlNavigationLabel(entry.hrefTargetSafe) || null,
  })
}

export function buildCoreviewHtmlSectionIndex(documentRef: Document | null | undefined): CoreviewHtmlSectionIndex {
  if (!documentRef) {
    return emptyIndex("document_unavailable")
  }

  try {
    const entries: CoreviewHtmlSectionIndexEntry[] = []
    const seen = new Set<string>()

    for (const [selector, buildEntry] of SECTION_INDEX_COLLECTORS) {
      for (const element of queryElements(documentRef, selector)) {
        const entry = buildEntry(element)
        if (entry) {
          pushSectionIndexEntry(entries, seen, entry)
        }
      }
    }

    return {
      ok: true,
      entries,
      entryCount: entries.length,
      buildResult: "success",
      builtAt: Date.now(),
      rawHtmlExcluded: true,
      rawArtifactTextExcluded: true,
    }
  } catch {
    return emptyIndex("cross_origin_unavailable")
  }
}

export function resolveCoreviewHtmlNavigationTarget(
  documentRef: Document | null | undefined,
  input: CoreviewHtmlResolveInput,
): CoreviewHtmlResolveResult {
  const target = cleanHtmlNavigationTarget(input.target ?? "")
  const aliasTarget = canonicalHtmlNavigationAlias(target)
  const index = buildCoreviewHtmlSectionIndex(documentRef)

  if (!index.ok) {
    return {
      ok: false,
      targetKind: "unknown",
      targetLabelSafe: safeHtmlNavigationLabel(target) || null,
      element: null,
      reason: index.buildResult as CoreviewHtmlNavigationFailureReason,
      indexEntryCount: index.entryCount,
      indexBuildResult: index.buildResult,
      rawHtmlExcluded: true,
      rawArtifactTextExcluded: true,
    }
  }

  if (!target || TOP_ALIASES.has(htmlNavigationMatchKey(aliasTarget))) {
    return resolvedVirtualTarget("top", target || "top", index)
  }
  if (BOTTOM_ALIASES.has(htmlNavigationMatchKey(aliasTarget))) {
    return resolvedVirtualTarget("bottom", target || "bottom", index)
  }

  const candidates = matchCandidates(aliasTarget)
  const entry = findMatchingEntry(index.entries, candidates, input.excludeElement ?? null)
  if (!entry) {
    return {
      ok: false,
      targetKind: "unknown",
      targetLabelSafe: safeHtmlNavigationLabel(target) || null,
      element: null,
      reason: "section_not_found",
      indexEntryCount: index.entryCount,
      indexBuildResult: index.buildResult,
      rawHtmlExcluded: true,
      rawArtifactTextExcluded: true,
    }
  }

  return {
    ok: true,
    targetKind: entry.targetKind,
    targetLabelSafe: entry.targetLabelSafe,
    element: entry.element ?? null,
    reason: null,
    indexEntryCount: index.entryCount,
    indexBuildResult: index.buildResult,
    rawHtmlExcluded: true,
    rawArtifactTextExcluded: true,
  }
}

export function cleanHtmlNavigationTarget(value: string | null | undefined): string {
  const decoded = safeDecode(value ?? "")
  const withoutOrigin = decoded.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/#?]+/iu, "")
  const hashTarget = withoutOrigin.includes("#")
    ? withoutOrigin.slice(withoutOrigin.lastIndexOf("#") + 1)
    : withoutOrigin
  let text = hashTarget
    .replace(/^#+/u, "")
    .replace(/^\.\//u, "")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .trim()
  const pathParts = text.split(/[/?#]/u)[0]?.split("/").filter(Boolean) ?? []
  if (pathParts.length > 0) {
    text = pathParts[pathParts.length - 1] ?? text
  }
  return safeHtmlNavigationLabel(
    text
      .replace(/\.[a-z0-9]{1,8}$/iu, "")
      .replace(/[-_]+/gu, " "),
  )
}

export function safeHtmlNavigationLabel(value: string | null | undefined, maxLength = SAFE_LABEL_MAX_LENGTH): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength)
}

export function htmlNavigationMatchKey(value: string | null | undefined): string {
  return safeHtmlNavigationLabel(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
}

export function htmlNavigationSlug(value: string | null | undefined): string {
  return htmlNavigationMatchKey(value).replace(/\s+/gu, "")
}

export function hrefNavigationTarget(value: string | null | undefined): string {
  const href = String(value ?? "").trim()
  if (!href || /^(?:javascript|data|vbscript):/iu.test(href)) {
    return ""
  }
  if (/^(?:https?:|mailto:|tel:)/iu.test(href) || href.startsWith("//")) {
    return ""
  }
  return cleanHtmlNavigationTarget(href)
}

function emptyIndex(reason: CoreviewHtmlNavigationFailureReason): CoreviewHtmlSectionIndex {
  return {
    ok: false,
    entries: [],
    entryCount: 0,
    buildResult: reason,
    builtAt: Date.now(),
    rawHtmlExcluded: true,
    rawArtifactTextExcluded: true,
  }
}

function resolvedVirtualTarget(
  targetKind: "top" | "bottom",
  target: string,
  index: CoreviewHtmlSectionIndex,
): CoreviewHtmlResolveResult {
  return {
    ok: true,
    targetKind,
    targetLabelSafe: safeHtmlNavigationLabel(target || targetKind),
    element: null,
    reason: null,
    indexEntryCount: index.entryCount,
    indexBuildResult: index.buildResult,
    rawHtmlExcluded: true,
    rawArtifactTextExcluded: true,
  }
}

function queryElements(documentRef: Document, selector: string): Element[] {
  return Array.from(documentRef.querySelectorAll(selector))
    .filter((element) => !element.closest("script,style,noscript"))
}

function labelForElement(element: Element, maxLength = SAFE_LABEL_MAX_LENGTH): string {
  return safeHtmlNavigationLabel(
    element.getAttribute("aria-label")
      || element.getAttribute("data-section")
      || element.getAttribute("data-target")
      || element.getAttribute("data-scroll")
      || element.getAttribute("data-scroll-target")
      || element.getAttribute("data-section-target")
      || element.getAttribute("name")
      || element.getAttribute("id")
      || element.textContent
      || "",
    maxLength,
  )
}

function hrefTargetFromElement(element: Element): string {
  return hrefNavigationTarget(element.getAttribute("href"))
}

function dataNavigationTargetFromElement(element: Element): string {
  return cleanHtmlNavigationTarget(
    element.getAttribute("data-target")
      || element.getAttribute("data-section")
      || element.getAttribute("data-scroll")
      || element.getAttribute("data-scroll-target")
      || element.getAttribute("data-section-target")
      || "",
  )
}

function uniqueSafeLabels(values: Array<string | null | undefined>): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const label = safeHtmlNavigationLabel(value, TEXT_INDEX_MAX_LENGTH)
    const key = htmlNavigationMatchKey(label)
    if (!label || !key || seen.has(key)) {
      continue
    }
    seen.add(key)
    labels.push(label)
  }
  return labels
}

function canonicalHtmlNavigationAlias(target: string): string {
  const key = htmlNavigationMatchKey(target)
  for (const [canonical, aliases] of Object.entries(TARGET_ALIASES)) {
    if (aliases.some((alias) => htmlNavigationMatchKey(alias) === key || htmlNavigationSlug(alias) === htmlNavigationSlug(target))) {
      return canonical
    }
  }
  return target
}

function matchCandidates(target: string): Array<{ key: string; slug: string }> {
  const aliases = TARGET_ALIASES[htmlNavigationMatchKey(target)] ?? []
  const values = uniqueSafeLabels([target, canonicalHtmlNavigationAlias(target), ...aliases])
  return values.map((value) => ({
    key: htmlNavigationMatchKey(value),
    slug: htmlNavigationSlug(value),
  })).filter((value) => value.key || value.slug)
}

function findMatchingEntry(
  entries: CoreviewHtmlSectionIndexEntry[],
  candidates: Array<{ key: string; slug: string }>,
  excludeElement: Element | null,
): CoreviewHtmlSectionIndexEntry | null {
  const orderedEntries = [
    ...entries.filter((entry) => entry.targetKind === "id"),
    ...entries.filter((entry) => entry.targetKind === "heading"),
    ...entries.filter((entry) => entry.targetKind === "nav"),
    ...entries.filter((entry) => entry.targetKind === "button"),
    ...entries.filter((entry) => entry.targetKind === "text"),
  ]
  const labelMatches = (entry: CoreviewHtmlSectionIndexEntry, mode: "exact" | "partial") => {
    const labels = [...entry.labels, entry.targetLabelSafe, entry.hrefTargetSafe ?? ""]
    return labels.some((label) => {
      const key = htmlNavigationMatchKey(label)
      const slug = htmlNavigationSlug(label)
      if (!key && !slug) {
        return false
      }
      return candidates.some((candidate) => {
        if (mode === "exact") {
          return key === candidate.key || slug === candidate.slug
        }
        return candidate.key.length >= 3 && (
          key.includes(candidate.key)
          || candidate.key.includes(key)
          || (candidate.slug.length >= 3 && (slug.includes(candidate.slug) || candidate.slug.includes(slug)))
        )
      })
    })
  }
  return orderedEntries.find((entry) => entry.element !== excludeElement && labelMatches(entry, "exact"))
    ?? orderedEntries.find((entry) => entry.element !== excludeElement && labelMatches(entry, "partial"))
    ?? null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "))
  } catch {
    return value
  }
}
