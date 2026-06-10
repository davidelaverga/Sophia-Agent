/**
 * Central assistant-message dedupe helpers.
 *
 * The session UI can receive the same assistant reply through several paths:
 * the live `/api/chat` stream, the assistant-reply backfill (final-state
 * recovery after a missed stream / builder wakeup), and durable transcript
 * hydration on reload. Providers also vary typography between paths — the
 * same sentence can arrive once with a straight apostrophe ("I'll") and once
 * with a curly one ("I’ll"). Every appender and the message view-model share
 * these helpers so an equivalent reply is only ever rendered once, while
 * genuinely different replies are preserved.
 */

/** Minimum normalized length before containment counts as a duplicate —
 * short acknowledgements ("ok", "yes") must never merge into longer replies. */
const CONTAINMENT_MIN_LENGTH = 12

/**
 * Normalize assistant text for dedupe comparison only (never for display):
 * trim, collapse all whitespace runs, normalize curly quotes/apostrophes to
 * straight quotes, unify dash/ellipsis variants, and drop a trailing
 * terminal-punctuation run so "Hello." and "Hello" compare equal.
 */
export function normalizeAssistantTextForDedupe(text: string | null | undefined): string {
  if (!text) {
    return ""
  }
  return text
    .replace(/[‘’‚ʼ]/gu, "'")
    .replace(/[“”„]/gu, '"')
    .replace(/…/gu, "...")
    .replace(/[‐-―−]/gu, "-")
    .replace(/ /gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?。]+$/u, "")
    .trim()
}

/** True when the text has anything visible to render after normalization. */
export function hasRenderableAssistantText(text: string | null | undefined): boolean {
  return normalizeAssistantTextForDedupe(text).length > 0
}

/**
 * Collapse immediately repeated segments INSIDE one assistant message for
 * display. The live stream can emit the same reply twice into a single
 * bubble (prose-retry tokens + the merged final message), rendering as
 * "Starting the build now — I'll have it back to you shortly.Starting the
 * build now — I'll have it back to you shortly." — sometimes with curly vs
 * straight apostrophe variation between the copies.
 *
 * Display-safe and conservative: only ADJACENT repeats collapse, only when
 * the repeated segment is substantial (≥ {@link CONTAINMENT_MIN_LENGTH}
 * normalized chars — deliberate short emphasis like "No. No." is kept), and
 * the kept copy is the original segment text, untouched. Works at paragraph
 * level first, then sentence level within each paragraph. Never mutates the
 * stored transcript — callers apply it to view-model/display text only.
 */
export function collapseRepeatedAssistantText(text: string): string {
  if (!text?.trim()) {
    return text
  }
  const paragraphs = text.split(/(\n{2,})/u)
  const keptParagraphs: string[] = []
  let previousParagraphKey: string | null = null
  for (const part of paragraphs) {
    if (/^\n{2,}$/u.test(part)) {
      keptParagraphs.push(part)
      continue
    }
    const key = normalizeAssistantTextForDedupe(part)
    if (
      previousParagraphKey !== null
      && key.length >= CONTAINMENT_MIN_LENGTH
      && key === previousParagraphKey
    ) {
      // Drop the separator that introduced the skipped duplicate paragraph.
      if (keptParagraphs.length > 0 && /^\n{2,}$/u.test(keptParagraphs[keptParagraphs.length - 1])) {
        keptParagraphs.pop()
      }
      continue
    }
    keptParagraphs.push(collapseRepeatedSentences(part))
    previousParagraphKey = key
  }
  return keptParagraphs.join("")
}

function collapseRepeatedSentences(paragraph: string): string {
  // Sentences keep their terminal punctuation and trailing whitespace; the
  // boundary also matches the no-space doubled case ("…shortly.Starting…").
  const segments = paragraph.match(/[^.!?…]*[.!?…]+["')\]]*\s*|[^.!?…]+$/gu)
  if (!segments || segments.length < 2) {
    return paragraph
  }
  // Whole-run doubling first: the same (possibly multi-sentence) reply
  // emitted twice back-to-back ("A. B.A. B.") collapses to one copy.
  for (let split = 1; split < segments.length; split += 1) {
    const head = normalizeAssistantTextForDedupe(segments.slice(0, split).join(""))
    const tail = normalizeAssistantTextForDedupe(segments.slice(split).join(""))
    if (head.length >= CONTAINMENT_MIN_LENGTH && head === tail) {
      return collapseRepeatedSentences(segments.slice(0, split).join("").replace(/\s+$/u, ""))
    }
  }
  const kept: string[] = []
  let previousKey: string | null = null
  for (const segment of segments) {
    const key = normalizeAssistantTextForDedupe(segment)
    if (
      previousKey !== null
      && key.length >= CONTAINMENT_MIN_LENGTH
      && key === previousKey
    ) {
      continue
    }
    kept.push(segment)
    if (key) {
      previousKey = key
    }
  }
  return kept.join("")
}

/**
 * True when two assistant texts should be treated as the same reply:
 * normalized equality, or containment when the shorter side is substantial
 * (≥ {@link CONTAINMENT_MIN_LENGTH} chars). Containment covers the doubled
 * stream case — a streamed bubble that already includes the sentence (even
 * twice) must suppress a backfill/hydration copy of that sentence.
 */
export function isEquivalentAssistantText(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeAssistantTextForDedupe(left)
  const normalizedRight = normalizeAssistantTextForDedupe(right)
  if (!normalizedLeft || !normalizedRight) {
    return false
  }
  if (normalizedLeft === normalizedRight) {
    return true
  }
  const [shorter, longer] = normalizedLeft.length <= normalizedRight.length
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft]
  return shorter.length >= CONTAINMENT_MIN_LENGTH && longer.includes(shorter)
}
