import type { ArtifactRendererKind } from "./artifact-renderers"
import { normalizeBuilderArtifactPath } from "./builder-artifacts"

export type CoreviewHtmlQuickEditKind =
  | "title"
  | "subtitle"
  | "button_text"
  | "paragraph"
  | "cards_darker"
  | "card_color"
  | "accent_color"

export type CoreviewHtmlQuickEditTargetFields = {
  titleText?: string
  subtitleText?: string
  buttonText?: string
  paragraphText?: string
  colorValue?: string
}

export type CoreviewHtmlQuickEditClassification = {
  supported: boolean
  quickEditKind: CoreviewHtmlQuickEditKind | null
  requestedChangeSummary: string
  targetFields: CoreviewHtmlQuickEditTargetFields
  fallbackReason: string | null
}

export type ClassifyCoreviewHtmlQuickEditInput = {
  userUpdateRequest: string | null | undefined
  rendererKind: ArtifactRendererKind | string | null | undefined
  artifactPath?: string | null | undefined
  updateMode?: string | null | undefined
}

export type CoreviewHtmlQuickPatchRequest = {
  artifact_path: string
  artifact_stable_identity?: string | null
  renderer_kind: "html"
  user_update_request: string
  requested_change_summary: string
  quick_edit_kind: CoreviewHtmlQuickEditKind
  target_fields: CoreviewHtmlQuickEditTargetFields
  workspace_key?: string | null
  session_id?: string | null
  thread_id?: string | null
}

export type CoreviewHtmlQuickPatchResponse = {
  ok: boolean
  result: "patched" | "unsupported" | "failed"
  fallback_reason?: string | null
  quick_edit_kind?: CoreviewHtmlQuickEditKind | null
  requested_change_summary?: string | null
  original_artifact_path?: string | null
  revision_artifact_path?: string | null
  source_artifact_path?: string | null
  revision_of_artifact_path?: string | null
  renderer_kind?: "html" | null
  content_hash?: string | null
  revision_path_hash?: string | null
  safe_summary?: string | null
  preserved_original?: boolean
  raw_html_excluded: true
  raw_artifact_text_excluded: true
}

const WHOLE_PAGE_REDESIGN_RE = /\b(redesign|rebuild|rework|revamp|remake|overhaul|start over|from scratch|whole page|entire page|new layout|landing page|add (?:several|multiple|many) sections?)\b/iu
const CONVERSION_RE = /\b(convert|export|turn (?:it|this) into|make (?:it|this) a (?:pdf|pptx|docx|markdown|sheet|spreadsheet))\b/iu
const NON_HTML_EXTENSION_RE = /\.(?:pdf|pptx?|docx?|xlsx?|csv|md|markdown)(?:$|[?#])/iu

export function classifyCoreviewHtmlQuickEdit(
  input: ClassifyCoreviewHtmlQuickEditInput,
): CoreviewHtmlQuickEditClassification {
  const request = normalizeRequest(input.userUpdateRequest)
  const requestedChangeSummary = summarizeQuickEditRequest(request)
  const normalizedPath = normalizeBuilderArtifactPath(input.artifactPath)

  if (input.rendererKind !== "html") {
    return unsupported(requestedChangeSummary, "renderer_not_html")
  }
  if (normalizedPath && NON_HTML_EXTENSION_RE.test(normalizedPath)) {
    return unsupported(requestedChangeSummary, "artifact_not_html")
  }
  if (input.updateMode === "convert_format" || CONVERSION_RE.test(request)) {
    return unsupported(requestedChangeSummary, "format_conversion")
  }
  if (WHOLE_PAGE_REDESIGN_RE.test(request)) {
    return unsupported(requestedChangeSummary, "major_or_ambiguous_layout_change")
  }

  const titleText = extractTargetText(request, [
    /\b(?:change|set|update|rename|make)\s+(?:the\s+)?(?:(?:main|hero)\s+)?title\s+(?:to|as)\s+(.+)$/iu,
    /\b(?:change|set|update|rename|make)\s+(?:the\s+)?(?:h1|headline|heading)\s+(?:to|as)\s+(.+)$/iu,
  ])
  if (titleText) {
    return supported("title", requestedChangeSummary, { titleText })
  }

  const subtitleText = extractTargetText(request, [
    /\b(?:change|set|update|rename|make)\s+(?:the\s+)?(?:subtitle|subheading|subhead|tagline)\s+(?:to|as)\s+(.+)$/iu,
  ])
  if (subtitleText) {
    return supported("subtitle", requestedChangeSummary, { subtitleText })
  }

  const buttonText = extractTargetText(request, [
    /\b(?:change|set|update|rename|make)\s+(?:the\s+)?(?:button|cta|call to action|call-to-action)(?:\s+text)?\s+(?:to|as)\s+(.+)$/iu,
  ])
  if (buttonText) {
    return supported("button_text", requestedChangeSummary, { buttonText })
  }

  const paragraphText = extractTargetText(request, [
    /\b(?:add|insert)\s+(?:a\s+)?short\s+paragraph\s+(?:that\s+says|saying|with|to)\s+(.+)$/iu,
    /\b(?:change|update)\s+(?:the\s+)?(?:intro|introductory|lead)\s+paragraph\s+(?:to|as)\s+(.+)$/iu,
  ])
  if (paragraphText) {
    return supported("paragraph", requestedChangeSummary, { paragraphText })
  }

  if (/\b(?:make|turn|set|darken)\s+(?:the\s+)?cards?\s+(?:a\s+bit\s+)?darker\b/iu.test(request)
    || /\bdarken\s+(?:the\s+)?cards?\b/iu.test(request)) {
    return supported("cards_darker", requestedChangeSummary, {})
  }

  const colorValue = extractColorValue(request)
  if (colorValue && /\bcards?\b/iu.test(request)) {
    return supported("card_color", requestedChangeSummary, { colorValue })
  }
  if (colorValue && /\baccent\b/iu.test(request)) {
    return supported("accent_color", requestedChangeSummary, { colorValue })
  }

  return unsupported(requestedChangeSummary, "unsupported_or_ambiguous_quick_edit")
}

export async function requestCoreviewHtmlQuickPatch(
  threadId: string,
  input: CoreviewHtmlQuickPatchRequest,
): Promise<CoreviewHtmlQuickPatchResponse> {
  const response = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/artifacts/quick-html-patch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(input),
    },
  )

  if (!response.ok) {
    return {
      ok: false,
      result: "failed",
      fallback_reason: `quick_patch_http_${response.status}`,
      raw_html_excluded: true,
      raw_artifact_text_excluded: true,
    }
  }

  return response.json() as Promise<CoreviewHtmlQuickPatchResponse>
}

function supported(
  quickEditKind: CoreviewHtmlQuickEditKind,
  requestedChangeSummary: string,
  targetFields: CoreviewHtmlQuickEditTargetFields,
): CoreviewHtmlQuickEditClassification {
  return {
    supported: true,
    quickEditKind,
    requestedChangeSummary,
    targetFields,
    fallbackReason: null,
  }
}

function unsupported(
  requestedChangeSummary: string,
  fallbackReason: string,
): CoreviewHtmlQuickEditClassification {
  return {
    supported: false,
    quickEditKind: null,
    requestedChangeSummary,
    targetFields: {},
    fallbackReason,
  }
}

function normalizeRequest(value: string | null | undefined): string {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/gu, " ").trim()
    : ""
}

function summarizeQuickEditRequest(value: string): string {
  return value ? value.slice(0, 160) : "Update selected artifact"
}

function extractTargetText(value: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    const raw = match?.[1]
    const normalized = cleanTargetText(raw)
    if (normalized) {
      return normalized
    }
  }
  return null
}

function cleanTargetText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value
    .trim()
    .replace(/^["'`]+|["'`.!?]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
  if (!normalized || normalized.length > 120) {
    return null
  }
  return normalized
}

function extractColorValue(value: string): string | null {
  const hex = /#[0-9a-f]{3,8}\b/iu.exec(value)?.[0]
  if (hex) {
    return hex
  }
  const named = /\b(?:black|white|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/iu.exec(value)?.[0]
  return named ?? null
}
