export type ArtifactReviewVoiceCommandKind =
  | "go_to_page"
  | "next_page"
  | "previous_page"
  | "first_page"
  | "last_page"
  | "scroll_down"
  | "scroll_up"
  | "go_to_top"
  | "go_to_bottom"
  | "zoom_in"
  | "zoom_out"
  | "fit_width"
  | "fit_page"
  | "reset_zoom"
  | "refresh_view"
  | "focus_anchor"
  | "add_annotation"
  | "builder_update"
  | "builder_cancel"

export type ArtifactReviewAnnotationKind = "highlight" | "comment" | "underline" | "arrow"
export type ArtifactReviewAnnotationColor = "yellow" | "purple" | "blue" | "pink"
export type ArtifactReviewAnnotationAnchorType = "current_title" | "current_selection" | "text_quote"
export type ArtifactReviewAnnotationUtteranceKind =
  | "annotation_highlight"
  | "annotation_underline"
  | "annotation_arrow"
  | "annotation_comment"
  | "annotation_pin"
  | "annotation_follow_up_comment"
  | "annotation_compound"

export type ArtifactReviewVoiceCommandBlockedReason =
  | "not_artifact_review_context"
  | "no_artifact_selected"
  | "no_multipage_artifact_selected"
  | "requested_page_out_of_bounds"
  | "visual_refresh_unavailable"
  | "iframe_not_ready"
  | "document_unavailable"
  | "layout_anchor_not_supported"
  | "text_anchor_not_found"
  | "section_not_found"
  | "unsupported_update_mode"
  | "no_active_builder_task"

export type ArtifactReviewVoiceCommandRefreshResult =
  | "not_requested"
  | "pending"
  | "success"
  | "error"
  | "not_active"
  | "unavailable"

export interface ArtifactReviewVoiceCommand {
  kind: ArtifactReviewVoiceCommandKind
  pageTarget?: number
  annotationKind?: ArtifactReviewAnnotationKind
  anchorType?: ArtifactReviewAnnotationAnchorType
  anchorText?: string
  color?: ArtifactReviewAnnotationColor
  commentText?: string
  updateRequest?: string
  updateMode?: "create_new" | "update_existing" | "revise_version" | "convert_format" | "repair_artifact"
  zoomDelta?: number
  utteranceKind?: ArtifactReviewAnnotationUtteranceKind
}

export interface ArtifactReviewVoiceCommandRouteResult {
  handled: boolean
  command?: ArtifactReviewVoiceCommand
  applied?: boolean
  blockedReason?: ArtifactReviewVoiceCommandBlockedReason | null
  triggeredRefresh?: boolean
  refreshResult?: ArtifactReviewVoiceCommandRefreshResult
  userMessage?: string | null
  suppressAssistant?: boolean
  assistantAnnotationClaimSuppressed?: boolean
}

export type ArtifactReviewVoiceCommandRouter = (
  transcript: string,
) => ArtifactReviewVoiceCommandRouteResult

export interface ArtifactReviewVoiceCommandApplyResult {
  applied: boolean
  changed: boolean
  shouldRefresh: boolean
  blockedReason: ArtifactReviewVoiceCommandBlockedReason | null
  artifactCurrentPageIndex: number
  artifactCurrentPageCount: number
}

const PAGE_NUMBER_WORDS = new Map<string, number>([
  ["one", 1],
  ["first", 1],
  ["two", 2],
  ["second", 2],
  ["three", 3],
  ["third", 3],
  ["four", 4],
  ["fourth", 4],
  ["five", 5],
  ["fifth", 5],
  ["six", 6],
  ["sixth", 6],
  ["seven", 7],
  ["seventh", 7],
  ["eight", 8],
  ["eighth", 8],
  ["nine", 9],
  ["ninth", 9],
  ["ten", 10],
  ["tenth", 10],
  ["eleven", 11],
  ["eleventh", 11],
  ["twelve", 12],
  ["twelfth", 12],
  ["thirteen", 13],
  ["thirteenth", 13],
  ["fourteen", 14],
  ["fourteenth", 14],
  ["fifteen", 15],
  ["fifteenth", 15],
  ["sixteen", 16],
  ["sixteenth", 16],
  ["seventeen", 17],
  ["seventeenth", 17],
  ["eighteen", 18],
  ["eighteenth", 18],
  ["nineteen", 19],
  ["nineteenth", 19],
  ["twenty", 20],
  ["twentieth", 20],
])

const FIRST_PAGE_PATTERNS = [
  /\b(?:go to|open|show)\s+(?:the\s+)?first\s+page\b/u,
  /\bfirst\s+page\b/u,
]
const LAST_PAGE_PATTERNS = [
  /\b(?:go to|open|show)\s+(?:the\s+)?last\s+page\b/u,
  /\blast\s+page\b/u,
]
const PREVIOUS_PAGE_PATTERNS = [
  /\b(?:previous|prev)\s+page\b/u,
  /\bgo\s+back\s+(?:a\s+)?page\b/u,
]
const TITLE_FOCUS_PATTERNS = [
  /\b(?:zoom\s+in|focus|center)\s+(?:on\s+)?(?:the\s+)?(?:current\s+)?title\b/u,
  /\b(?:focus|center)\s+(?:on\s+)?(?:the\s+)?hero\s+title\b/u,
  /\b(?:current\s+)?title\b.*\b(?:zoom\s+in|focus|center)\b/u,
]
const SCROLL_DOWN_PATTERNS = [
  /\bscroll\s+down\b/u,
  /\bmove\s+down\b/u,
  /\bgo\s+down\b/u,
]
const SCROLL_UP_PATTERNS = [
  /\bscroll\s+up\b/u,
  /\bmove\s+up\b/u,
  /\bgo\s+up\b/u,
]
const GO_TO_TOP_PATTERNS = [
  /\b(?:go to|jump to|show|open)\s+(?:the\s+)?top\b/u,
  /\b(?:go to|jump to|show|open)\s+(?:the\s+)?(?:front\s+page|home|hero)\b/u,
  /\b(?:go|jump|return)\s+home\b/u,
  /\bback\s+to\s+top\b/u,
]
const GO_TO_BOTTOM_PATTERNS = [
  /\b(?:go to|jump to|show|open)\s+(?:the\s+)?bottom\b/u,
]
const GO_TO_SECTION_PATTERN = /\b(?:go to|jump to|take me to|show(?:\s+me)?|open|focus(?:\s+on)?)\s+(?:the\s+)?(?!(?:page|first|last|next|previous|prev|top|bottom|front\s+page|home|hero)\b)(?:section\s+)?([a-z0-9][a-z0-9\s-]{1,80})\b/u
const UNDERLINE_PATTERNS = [/\bunderline(?:d)?\b/u]
const ARROW_PATTERNS = [
  /\b(?:draw|add|place|put|make)\s+(?:an?\s+)?arrow\b/u,
  /\barrow\s+(?:pointing|to|at|toward|towards)\b/u,
]
const HIGHLIGHT_PATTERNS = [/\b(?:highlight(?:ed)?|mark(?:ed)?|flag(?:ged)?|callout)\b/u]
const COMMENT_PATTERNS = [
  /\b(?:leave|add|make|put)\s+(?:a\s+)?(?:comment|note|feedback|pin)\b/u,
  /\b(?:comment|note|feedback|pin)\s+(?:on\s+)?(?:the\s+)?(?:title|it|this|current)\b/u,
  /\bpin(?:\s+(?:it|this|that|a\s+note|a\s+comment|note|comment))?\b/u,
  /\b(?:comment|note|feedback)\b/u,
]
const FONT_FOLLOW_UP_PATTERNS = [
  /\bchange\s+(?:the\s+)?font\b/u,
  /\bfont\s+(?:needs|should|must)\s+(?:to\s+)?(?:change|be\s+changed)\b/u,
]
const COMMENT_TEXT_PATTERNS = [
  /\b(?:comment|note|feedback|pin)\s+on\s+.+?\s+(?:saying|that\s+says|to\s+say|:)\s+(.+)$/iu,
  /\b(?:leave|add|make|put)\s+(?:a\s+)?(?:comment|note|feedback|pin)(?:\s+on\s+(?:the\s+)?(?:current\s+)?(?:title|it|this))?\s*(?:saying|that\s+says|to\s+say|:)?\s+(.+)$/iu,
  /\b(?:comment|note|feedback|pin)\s+(?:on\s+)?(?:the\s+)?(?:current\s+)?(?:title|it|this)?\s*(?:saying|that\s+says|to\s+say|:)?\s+(.+)$/iu,
  /\b(?:comment|note|feedback|pin)\s+(?!on\b|the\b|current\b|title\b|it\b|this\b)(.+)$/iu,
  /\b(?:comment|note|feedback|pin)\s*:\s*(.+)$/iu,
]
const BUILDER_CANCEL_PATTERNS = [
  /\b(?:cancel|stop|abort)\s+(?:the\s+)?(?:builder\s+)?(?:task|build|update)\b/u,
  /\b(?:cancel|stop|abort)\s+this\s+(?:builder\s+)?(?:task|build|update)\b/u,
  /\bstop\s+the\s+build\b/u,
]
const BUILDER_UPDATE_PATTERNS = [
  /\bupdate\s+(?:this|the)\s+(?:file|artifact|document|page|canvas)\b/u,
  /\b(?:edit|revise|rewrite)\s+(?:this|the)\s+(?:file|artifact|document|page|canvas)\b/u,
  /\bchange\s+(?:the\s+)?(?:(?:main|hero|primary)\s+)?(?:title|heading|headline|background|layout|copy|text|tone|color|colour|section|hero|cards?)\b/u,
  /\bmake\s+(?:the\s+|this\s+|that\s+|those\s+)?(?:background|layout|copy|text|title|heading|headline|section|hero|cards?)\s+(?:more|less|darker|lighter|brighter|premium|polished|compact|spacious|clear|modern)\b/u,
  /\bmake\s+(?:it|this|that)\s+(?:more|less|darker|lighter|brighter|premium|polished|compact|spacious|clear|modern)\b/u,
  /\bapply\s+(?:this|the)\s+(?:comment|feedback|note|annotation)\b/u,
  /\bmake\s+(?:a\s+)?new\s+version\b/u,
  /\brebuild\s+(?:this|the)\s+(?:file|artifact|document|page|canvas)?(?:\s+as\s+(?:html|markdown|pdf|pptx|docx))?\b/u,
]

const PAGE_NUMBER_PATTERN = [
  "\\d+",
  "one",
  "first",
  "two",
  "second",
  "three",
  "third",
  "four",
  "fourth",
  "five",
  "fifth",
  "six",
  "sixth",
  "seven",
  "seventh",
  "eight",
  "eighth",
  "nine",
  "ninth",
  "ten",
  "tenth",
  "eleven",
  "eleventh",
  "twelve",
  "twelfth",
  "thirteen",
  "thirteenth",
  "fourteen",
  "fourteenth",
  "fifteen",
  "fifteenth",
  "sixteen",
  "sixteenth",
  "seventeen",
  "seventeenth",
  "eighteen",
  "eighteenth",
  "nineteen",
  "nineteenth",
  "twenty",
  "twentieth",
].join("|")

const GO_TO_PAGE_PATTERN = new RegExp(
  `\\b(?:go to|open|show)\\s+page\\s+(${PAGE_NUMBER_PATTERN})\\b`,
  "u",
)

export function parseArtifactReviewVoiceCommand(
  transcript: string,
): ArtifactReviewVoiceCommand | null {
  return parseArtifactReviewVoiceCommands(transcript)[0] ?? null
}

export function parseArtifactReviewVoiceCommands(
  transcript: string,
): ArtifactReviewVoiceCommand[] {
  const clauses = splitArtifactReviewClauses(transcript)
  const commands: ArtifactReviewVoiceCommand[] = []

  for (const clause of clauses) {
    const clauseCommands = parseArtifactReviewVoiceCommandClause(clause)
    for (const command of clauseCommands) {
      if (!isDuplicateAdjacentArtifactCommand(commands.at(-1), command)) {
        commands.push(command)
      }
    }
  }

  return commands
}

export function isArtifactReviewAnnotationIntent(transcript: string): boolean {
  return parseArtifactReviewVoiceCommands(transcript).some((command) => command.kind === "add_annotation")
}

function parseArtifactReviewVoiceCommandClause(
  transcript: string,
): ArtifactReviewVoiceCommand[] {
  const normalized = normalizeArtifactReviewVoiceCommand(transcript)
  if (!normalized) {
    return []
  }
  const commandsWithIndex: IndexedArtifactReviewCommand[] = [
    ...parseArtifactBuilderCommands(transcript, normalized),
    ...parseArtifactPageCommands(normalized),
    ...parseArtifactViewCommands(normalized),
    ...parseArtifactRefreshCommands(normalized),
    ...parseArtifactAnnotationCommands(transcript, normalized),
  ]

  return commandsWithIndex
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.command)
}

type IndexedArtifactReviewCommand = {
  index: number
  command: ArtifactReviewVoiceCommand
}

function indexedCommand(
  normalized: string,
  patterns: RegExp[],
  command: ArtifactReviewVoiceCommand,
): IndexedArtifactReviewCommand[] {
  const index = firstMatchedIndex(normalized, patterns)
  return index >= 0 ? [{ index, command }] : []
}

function parseArtifactPageCommands(normalized: string): IndexedArtifactReviewCommand[] {
  const commands: IndexedArtifactReviewCommand[] = []
  const pageMatch = GO_TO_PAGE_PATTERN.exec(normalized)
  if (pageMatch?.[1]) {
    const pageTarget = parseSpokenPageNumber(pageMatch[1])
    if (pageTarget !== null) {
      commands.push({ index: pageMatch.index, command: { kind: "go_to_page", pageTarget } })
    }
  }
  commands.push(...indexedCommand(normalized, FIRST_PAGE_PATTERNS, { kind: "first_page" }))
  commands.push(...indexedCommand(normalized, LAST_PAGE_PATTERNS, { kind: "last_page" }))
  const nextPageIndex = normalized.search(/\bnext\s+page\b/u)
  if (nextPageIndex >= 0) {
    commands.push({ index: nextPageIndex, command: { kind: "next_page" } })
  }
  commands.push(...indexedCommand(normalized, PREVIOUS_PAGE_PATTERNS, { kind: "previous_page" }))
  return commands
}

function parseArtifactViewCommands(normalized: string): IndexedArtifactReviewCommand[] {
  const commands: IndexedArtifactReviewCommand[] = []
  commands.push(...indexedCommand(normalized, SCROLL_DOWN_PATTERNS, { kind: "scroll_down" }))
  commands.push(...indexedCommand(normalized, SCROLL_UP_PATTERNS, { kind: "scroll_up" }))
  commands.push(...indexedCommand(normalized, GO_TO_TOP_PATTERNS, { kind: "go_to_top" }))
  commands.push(...indexedCommand(normalized, GO_TO_BOTTOM_PATTERNS, { kind: "go_to_bottom" }))

  const sectionMatch = GO_TO_SECTION_PATTERN.exec(normalized)
  const sectionText = cleanAnchorText(sectionMatch?.[1])
  if (sectionMatch && sectionText) {
    commands.push({
      index: sectionMatch.index,
      command: {
        kind: "focus_anchor",
        anchorType: "text_quote",
        anchorText: sectionText,
        zoomDelta: 1,
      },
    })
  }

  const focusIndex = firstMatchedIndex(normalized, TITLE_FOCUS_PATTERNS)
  if (focusIndex >= 0) {
    commands.push({
      index: focusIndex,
      command: {
        kind: "focus_anchor",
        anchorType: "current_title",
        zoomDelta: 1.35,
      },
    })
  }
  const zoomInIndex = normalized.search(/\bzoom\s+in\b/u)
  if (zoomInIndex >= 0 && focusIndex < 0) {
    commands.push({ index: zoomInIndex, command: { kind: "zoom_in" } })
  }
  for (const [index, kind] of [
    [normalized.search(/\bzoom\s+out\b/u), "zoom_out"],
    [normalized.search(/\bfit\s+width\b/u), "fit_width"],
    [normalized.search(/\bfit\s+page\b/u), "fit_page"],
    [normalized.search(/\breset\s+zoom\b/u), "reset_zoom"],
  ] as const) {
    if (index >= 0) {
      commands.push({ index, command: { kind } })
    }
  }
  return commands
}

function parseArtifactRefreshCommands(normalized: string): IndexedArtifactReviewCommand[] {
  const refreshIndex = normalized.search(/\brefresh\s+(?:your\s+)?(?:view|page)\b/u)
  return refreshIndex >= 0
    ? [{ index: refreshIndex, command: { kind: "refresh_view" } }]
    : []
}

function parseArtifactBuilderCommands(
  transcript: string,
  normalized: string,
): IndexedArtifactReviewCommand[] {
  const cancelIndex = firstMatchedIndex(normalized, BUILDER_CANCEL_PATTERNS)
  if (cancelIndex >= 0) {
    return [{
      index: cancelIndex,
      command: {
        kind: "builder_cancel",
      },
    }]
  }

  const updateIndex = firstMatchedIndex(normalized, BUILDER_UPDATE_PATTERNS)
  if (updateIndex < 0) {
    return []
  }
  return [{
    index: updateIndex,
    command: {
      kind: "builder_update",
      updateRequest: cleanUpdateRequest(transcript),
      updateMode: updateModeFromNormalized(normalized),
    },
  }]
}

function updateModeFromNormalized(
  normalized: string,
): ArtifactReviewVoiceCommand["updateMode"] {
  if (/\bnew\s+version\b/u.test(normalized)) {
    return "revise_version"
  }
  if (/\brebuild\b/u.test(normalized)) {
    return /\bas\s+(?:html|markdown|pdf|pptx|docx)\b/u.test(normalized)
      ? "convert_format"
      : "revise_version"
  }
  return undefined
}

function parseArtifactAnnotationCommands(
  transcript: string,
  normalized: string,
): IndexedArtifactReviewCommand[] {
  const commentIndex = firstMatchedIndex(normalized, COMMENT_PATTERNS)
  return [
    annotationCommand(normalized, UNDERLINE_PATTERNS, "underline", "purple", "annotation_underline"),
    annotationCommand(normalized, ARROW_PATTERNS, "arrow", "purple", "annotation_arrow"),
    annotationCommand(normalized, HIGHLIGHT_PATTERNS, "highlight", "yellow", "annotation_highlight"),
    commentCommand(transcript, normalized, commentIndex),
    followUpCommentCommand(transcript, normalized, commentIndex),
  ].filter((command): command is IndexedArtifactReviewCommand => command !== null)
}

function annotationCommand(
  normalized: string,
  patterns: RegExp[],
  annotationKind: ArtifactReviewAnnotationKind,
  defaultColor: ArtifactReviewAnnotationColor,
  utteranceKind: ArtifactReviewAnnotationUtteranceKind,
): IndexedArtifactReviewCommand | null {
  const index = firstMatchedIndex(normalized, patterns)
  if (index < 0) {
    return null
  }
  return {
    index,
    command: {
      kind: "add_annotation",
      annotationKind,
      ...annotationAnchorFromTranscript(transcriptFromNormalized(normalized), normalized, annotationKind),
      color: annotationColorFromNormalized(normalized) ?? defaultColor,
      utteranceKind,
    },
  }
}

function commentCommand(
  transcript: string,
  normalized: string,
  commentIndex: number,
): IndexedArtifactReviewCommand | null {
  if (commentIndex < 0) {
    return null
  }
  return {
    index: commentIndex,
    command: {
      kind: "add_annotation",
      annotationKind: "comment",
      ...annotationAnchorFromTranscript(transcript, normalized, "comment"),
      commentText: extractCommentText(transcript),
      utteranceKind: /\bpin\b/u.test(normalized) ? "annotation_pin" : "annotation_comment",
    },
  }
}

function followUpCommentCommand(
  transcript: string,
  normalized: string,
  commentIndex: number,
): IndexedArtifactReviewCommand | null {
  const index = commentIndex < 0 ? firstMatchedIndex(normalized, FONT_FOLLOW_UP_PATTERNS) : -1
  if (index < 0) {
    return null
  }
  return {
    index,
    command: {
      kind: "add_annotation",
      annotationKind: "comment",
      ...annotationAnchorFromTranscript(transcript, normalized, "comment"),
      commentText: cleanCommentText(transcript) ?? "change the font",
      utteranceKind: "annotation_follow_up_comment",
    },
  }
}

export function normalizeArtifactReviewVoiceCommand(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

function parseSpokenPageNumber(value: string): number | null {
  const normalized = normalizeArtifactReviewVoiceCommand(value)
  if (/^\d+$/u.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return PAGE_NUMBER_WORDS.get(normalized) ?? null
}

function splitArtifactReviewClauses(value: string): string[] {
  return value
    .replace(/\b(?:and then|then)\b/giu, ".")
    .split(/[.!?;]+/u)
    .map((clause) => stripWakeWord(clause).trim())
    .filter(Boolean)
}

function stripWakeWord(value: string): string {
  return value.replace(/^\s*(?:sophia|sofia)\b[\s,.:;-]*/iu, "")
}

function firstMatchedIndex(value: string, patterns: RegExp[]): number {
  let index = -1
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    if (!match) {
      continue
    }
    index = index === -1 ? match.index : Math.min(index, match.index)
  }
  return index
}

function annotationAnchorTypeFromNormalized(
  normalized: string,
): ArtifactReviewAnnotationAnchorType | undefined {
  if (/\b(?:current\s+)?title\b/u.test(normalized)) {
    return "current_title"
  }
  if (/\b(?:selection|selected\s+text)\b/u.test(normalized)) {
    return "current_selection"
  }
  return undefined
}

function annotationAnchorFromTranscript(
  transcript: string,
  normalized: string,
  kind: ArtifactReviewAnnotationKind,
): Pick<ArtifactReviewVoiceCommand, "anchorType" | "anchorText"> {
  const explicit = annotationAnchorTypeFromNormalized(normalized)
  if (explicit) {
    return { anchorType: explicit }
  }

  const anchorText = extractAnnotationAnchorText(transcript, kind)
  return anchorText
    ? { anchorType: "text_quote", anchorText }
    : {}
}

function extractAnnotationAnchorText(
  transcript: string,
  kind: ArtifactReviewAnnotationKind,
): string | undefined {
  const stripped = stripWakeWord(transcript)
  const patterns = kind === "comment"
    ? [
        /\b(?:comment|note|feedback|pin)\s+on\s+(?:the\s+)?(?:(?:text|words?|phrase)\s+)?(?:that\s+says|saying|called|named)?\s*["'“”`]?(.+?)(?:["'“”`]\s*)?(?:\s+(?:saying|that\s+says|to\s+say|:)\s+.+)?$/iu,
      ]
    : [
        /\b(?:highlight|underline|mark|flag|callout)\s+(?:the\s+)?(?:(?:text|words?|phrase)\s+|(?:that\s+says|saying|called|named)\s+|["'“”`])(.+?)(?:["'“”`]\s*)?(?:\s+(?:in|with)\s+(?:yellow|purple|blue|pink))?$/iu,
      ]

  for (const pattern of patterns) {
    const match = pattern.exec(stripped)
    const candidate = cleanAnchorText(match?.[1])
    if (candidate) {
      return candidate
    }
  }
  return undefined
}

function cleanAnchorText(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/^(?:the\s+)?(?:current\s+)?(?:text|words?|phrase)\s+/iu, "")
    .replace(/^(?:["'`]|\u2018|\u2019|\u201c|\u201d)+|(?:["'`]|\u2018|\u2019|\u201c|\u201d)+$/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/gu, "")
    .trim()
  if (!cleaned || cleaned.length < 2 || cleaned.length > 120) {
    return undefined
  }
  if (/^(?:on\s+)?(?:the\s+)?(?:current\s+)?(?:title|selection|selected\s+text|it|this|that)$/iu.test(cleaned)) {
    return undefined
  }
  return cleaned
}

function transcriptFromNormalized(normalized: string): string {
  return normalized
}

function annotationColorFromNormalized(
  normalized: string,
): ArtifactReviewAnnotationColor | null {
  if (/\bpurple\b/u.test(normalized)) return "purple"
  if (/\bblue\b/u.test(normalized)) return "blue"
  if (/\bpink\b/u.test(normalized)) return "pink"
  if (/\byellow\b/u.test(normalized)) return "yellow"
  return null
}

function extractCommentText(value: string): string | undefined {
  const text = stripWakeWord(value)
  for (const pattern of COMMENT_TEXT_PATTERNS) {
    const match = pattern.exec(text)
    const candidate = cleanCommentText(match?.[1])
    if (candidate) {
      return candidate
    }
  }
  return undefined
}

function cleanCommentText(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/^(?:["'`]|\u2018|\u2019|\u201c|\u201d)+|(?:["'`]|\u2018|\u2019|\u201c|\u201d)+$/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/gu, "")
    .trim()
  if (/^(?:on\s+)?(?:the\s+)?(?:current\s+)?(?:title|it|this)$/iu.test(cleaned ?? "")) {
    return undefined
  }
  return cleaned || undefined
}

function cleanUpdateRequest(value: string | undefined): string | undefined {
  const cleaned = stripWakeWord(value ?? "")
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/gu, "")
    .trim()
  return cleaned || undefined
}

function isDuplicateAdjacentArtifactCommand(
  previous: ArtifactReviewVoiceCommand | undefined,
  next: ArtifactReviewVoiceCommand,
): boolean {
  if (previous?.kind !== next.kind) {
    return false
  }
  if (previous.kind !== "add_annotation") {
    return true
  }
  return previous.annotationKind === next.annotationKind
    && previous.anchorType === next.anchorType
    && previous.color === next.color
    && previous.commentText === next.commentText
}
