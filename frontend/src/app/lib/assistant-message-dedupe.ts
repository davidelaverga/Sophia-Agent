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
