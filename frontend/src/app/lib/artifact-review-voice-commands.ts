export type ArtifactReviewVoiceCommandKind =
  | "go_to_page"
  | "next_page"
  | "previous_page"
  | "first_page"
  | "last_page"
  | "zoom_in"
  | "zoom_out"
  | "fit_width"
  | "fit_page"
  | "reset_zoom"
  | "refresh_view"
  | "focus_anchor"
  | "add_annotation"

export type ArtifactReviewAnnotationKind = "highlight" | "comment"
export type ArtifactReviewAnnotationColor = "yellow" | "purple" | "blue" | "pink"
export type ArtifactReviewAnnotationAnchorType = "current_title" | "current_selection"
export type ArtifactReviewAnnotationUtteranceKind =
  | "annotation_highlight"
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
  color?: ArtifactReviewAnnotationColor
  commentText?: string
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
  const commandsWithIndex: Array<{ index: number; command: ArtifactReviewVoiceCommand }> = []

  const pageMatch = GO_TO_PAGE_PATTERN.exec(normalized)
  if (pageMatch?.[1]) {
    const pageTarget = parseSpokenPageNumber(pageMatch[1])
    if (pageTarget !== null) {
      commandsWithIndex.push({
        index: pageMatch.index,
        command: { kind: "go_to_page", pageTarget },
      })
    }
  }

  if (/\b(?:go to|open|show)\s+(?:the\s+)?first\s+page\b/u.test(normalized) || /\bfirst\s+page\b/u.test(normalized)) {
    commandsWithIndex.push({ index: normalized.indexOf("first page"), command: { kind: "first_page" } })
  }

  if (/\b(?:go to|open|show)\s+(?:the\s+)?last\s+page\b/u.test(normalized) || /\blast\s+page\b/u.test(normalized)) {
    commandsWithIndex.push({ index: normalized.indexOf("last page"), command: { kind: "last_page" } })
  }

  const nextPageIndex = normalized.search(/\bnext\s+page\b/u)
  if (nextPageIndex >= 0) {
    commandsWithIndex.push({ index: nextPageIndex, command: { kind: "next_page" } })
  }

  const previousPageIndex = firstMatchedIndex(normalized, [
    /\b(?:previous|prev)\s+page\b/u,
    /\bgo\s+back\s+(?:a\s+)?page\b/u,
  ])
  if (previousPageIndex >= 0) {
    commandsWithIndex.push({ index: previousPageIndex, command: { kind: "previous_page" } })
  }

  const focusIndex = firstMatchedIndex(normalized, [
    /\b(?:zoom\s+in|focus|center)\s+(?:on\s+)?(?:the\s+)?(?:current\s+)?title\b/u,
    /\b(?:current\s+)?title\b.*\b(?:zoom\s+in|focus|center)\b/u,
  ])
  if (focusIndex >= 0) {
    commandsWithIndex.push({
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
    commandsWithIndex.push({ index: zoomInIndex, command: { kind: "zoom_in" } })
  }

  const zoomOutIndex = normalized.search(/\bzoom\s+out\b/u)
  if (zoomOutIndex >= 0) {
    commandsWithIndex.push({ index: zoomOutIndex, command: { kind: "zoom_out" } })
  }

  const fitWidthIndex = normalized.search(/\bfit\s+width\b/u)
  if (fitWidthIndex >= 0) {
    commandsWithIndex.push({ index: fitWidthIndex, command: { kind: "fit_width" } })
  }

  const fitPageIndex = normalized.search(/\bfit\s+page\b/u)
  if (fitPageIndex >= 0) {
    commandsWithIndex.push({ index: fitPageIndex, command: { kind: "fit_page" } })
  }

  const resetZoomIndex = normalized.search(/\breset\s+zoom\b/u)
  if (resetZoomIndex >= 0) {
    commandsWithIndex.push({ index: resetZoomIndex, command: { kind: "reset_zoom" } })
  }

  const refreshIndex = normalized.search(/\brefresh\s+(?:your\s+)?(?:view|page)\b/u)
  if (refreshIndex >= 0) {
    commandsWithIndex.push({ index: refreshIndex, command: { kind: "refresh_view" } })
  }

  const highlightIndex = firstMatchedIndex(normalized, [
    /\b(?:highlight(?:ed)?|mark(?:ed)?|underline(?:d)?|flag(?:ged)?|callout)\b/u,
  ])
  if (highlightIndex >= 0) {
    commandsWithIndex.push({
      index: highlightIndex,
      command: {
        kind: "add_annotation",
        annotationKind: "highlight",
        anchorType: annotationAnchorTypeFromNormalized(normalized),
        color: annotationColorFromNormalized(normalized) ?? "yellow",
        utteranceKind: "annotation_highlight",
      },
    })
  }

  const commentIndex = firstMatchedIndex(normalized, [
    /\b(?:leave|add|make|put)\s+(?:a\s+)?(?:comment|note|feedback|pin)\b/u,
    /\b(?:comment|note|feedback|pin)\s+(?:on\s+)?(?:the\s+)?(?:title|it|this|current)\b/u,
    /\bpin(?:\s+(?:it|this|that|a\s+note|a\s+comment|note|comment))?\b/u,
    /\b(?:comment|note|feedback)\b/u,
  ])
  if (commentIndex >= 0) {
    const commentText = extractCommentText(transcript)
    commandsWithIndex.push({
      index: commentIndex,
      command: {
        kind: "add_annotation",
        annotationKind: "comment",
        anchorType: annotationAnchorTypeFromNormalized(normalized),
        commentText,
        utteranceKind: /\bpin\b/u.test(normalized) ? "annotation_pin" : "annotation_comment",
      },
    })
  }

  const followUpCommentIndex = commentIndex < 0
    ? firstMatchedIndex(normalized, [
        /\bchange\s+(?:the\s+)?font\b/u,
        /\bfont\s+(?:needs|should|must)\s+(?:to\s+)?(?:change|be\s+changed)\b/u,
      ])
    : -1
  if (followUpCommentIndex >= 0) {
    commandsWithIndex.push({
      index: followUpCommentIndex,
      command: {
        kind: "add_annotation",
        annotationKind: "comment",
        anchorType: annotationAnchorTypeFromNormalized(normalized),
        commentText: cleanCommentText(transcript) ?? "change the font",
        utteranceKind: "annotation_follow_up_comment",
      },
    })
  }

  return commandsWithIndex
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.command)
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
  const patterns = [
    /\b(?:leave|add|make|put)\s+(?:a\s+)?(?:comment|note|feedback|pin)(?:\s+on\s+(?:the\s+)?(?:current\s+)?(?:title|it|this))?\s*(?:saying|that\s+says|to\s+say|:)?\s+(.+)$/iu,
    /\b(?:comment|note|feedback|pin)\s+(?:on\s+)?(?:the\s+)?(?:current\s+)?(?:title|it|this)?\s*(?:saying|that\s+says|to\s+say|:)?\s+(.+)$/iu,
    /\b(?:comment|note|feedback|pin)\s+(?!on\b|the\b|current\b|title\b|it\b|this\b)(.+)$/iu,
    /\b(?:comment|note|feedback|pin)\s*:\s*(.+)$/iu,
  ]
  for (const pattern of patterns) {
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
