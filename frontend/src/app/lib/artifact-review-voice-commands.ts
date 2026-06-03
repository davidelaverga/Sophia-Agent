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
}

export interface ArtifactReviewVoiceCommandRouteResult {
  handled: boolean
  command?: ArtifactReviewVoiceCommand
  applied?: boolean
  blockedReason?: ArtifactReviewVoiceCommandBlockedReason | null
  triggeredRefresh?: boolean
  refreshResult?: ArtifactReviewVoiceCommandRefreshResult
  userMessage?: string | null
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
  const normalized = normalizeArtifactReviewVoiceCommand(transcript)
  if (!normalized) {
    return null
  }

  const pageMatch = GO_TO_PAGE_PATTERN.exec(normalized)
  if (pageMatch?.[1]) {
    const pageTarget = parseSpokenPageNumber(pageMatch[1])
    if (pageTarget !== null) {
      return { kind: "go_to_page", pageTarget }
    }
  }

  if (/\b(?:go to|open|show)\s+(?:the\s+)?first\s+page\b/u.test(normalized) || /\bfirst\s+page\b/u.test(normalized)) {
    return { kind: "first_page" }
  }

  if (/\b(?:go to|open|show)\s+(?:the\s+)?last\s+page\b/u.test(normalized) || /\blast\s+page\b/u.test(normalized)) {
    return { kind: "last_page" }
  }

  if (/\bnext\s+page\b/u.test(normalized)) {
    return { kind: "next_page" }
  }

  if (/\b(?:previous|prev)\s+page\b/u.test(normalized) || /\bgo\s+back\s+(?:a\s+)?page\b/u.test(normalized)) {
    return { kind: "previous_page" }
  }

  if (/\bzoom\s+in\b/u.test(normalized)) {
    return { kind: "zoom_in" }
  }

  if (/\bzoom\s+out\b/u.test(normalized)) {
    return { kind: "zoom_out" }
  }

  if (/\bfit\s+width\b/u.test(normalized)) {
    return { kind: "fit_width" }
  }

  if (/\bfit\s+page\b/u.test(normalized)) {
    return { kind: "fit_page" }
  }

  if (/\breset\s+zoom\b/u.test(normalized)) {
    return { kind: "reset_zoom" }
  }

  if (/\brefresh\s+view\b/u.test(normalized)) {
    return { kind: "refresh_view" }
  }

  return null
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
