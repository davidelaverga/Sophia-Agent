export type VoiceTranscriptReconciliation = {
  text: string
  changed: boolean
  incremental: boolean
}

function normalizeTranscript(text: string | null | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ")
}

function toLowerTokens(text: string): string[] {
  return text.split(" ").map((token) => token.toLowerCase())
}

function startsWithTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false
  }

  return needle.every((token, index) => haystack[index] === token)
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false
  }

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    const matches = needle.every((token, index) => haystack[start + index] === token)
    if (matches) {
      return true
    }
  }

  return false
}

function mergeByTokenOverlap(previous: string, incoming: string): string | null {
  const previousTokens = previous.split(" ")
  const incomingTokens = incoming.split(" ")
  const previousTokensLower = toLowerTokens(previous)
  const incomingTokensLower = toLowerTokens(incoming)
  const maxOverlap = Math.min(previousTokensLower.length, incomingTokensLower.length)

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const previousSlice = previousTokensLower.slice(-overlap)
    const incomingSlice = incomingTokensLower.slice(0, overlap)
    const matches = previousSlice.every((token, index) => token === incomingSlice[index])

    if (matches) {
      return [...previousTokens, ...incomingTokens.slice(overlap)].join(" ")
    }
  }

  return null
}

export function reconcileVoiceTranscript(
  previousText: string | null | undefined,
  incomingText: string,
): VoiceTranscriptReconciliation {
  const previous = normalizeTranscript(previousText)
  const incoming = normalizeTranscript(incomingText)

  if (!previous) {
    return {
      text: incoming,
      changed: incoming.length > 0,
      incremental: false,
    }
  }

  if (!incoming) {
    return {
      text: previous,
      changed: false,
      incremental: true,
    }
  }

  const previousTokensLower = toLowerTokens(previous)
  const incomingTokensLower = toLowerTokens(incoming)

  if (
    previousTokensLower.length === incomingTokensLower.length
    && previousTokensLower.every((token, index) => token === incomingTokensLower[index])
  ) {
    return {
      text: previous,
      changed: false,
      incremental: true,
    }
  }

  if (
    startsWithTokenSequence(incomingTokensLower, previousTokensLower)
    || containsTokenSequence(incomingTokensLower, previousTokensLower)
  ) {
    return {
      text: incoming,
      changed: incoming !== previous,
      incremental: true,
    }
  }

  if (
    startsWithTokenSequence(previousTokensLower, incomingTokensLower)
    || containsTokenSequence(previousTokensLower, incomingTokensLower)
  ) {
    return {
      text: previous,
      changed: false,
      incremental: true,
    }
  }

  const overlapMerged = mergeByTokenOverlap(previous, incoming)
  if (overlapMerged) {
    return {
      text: overlapMerged,
      changed: overlapMerged !== previous,
      incremental: true,
    }
  }

  return {
    text: incoming,
    changed: incoming !== previous,
    incremental: false,
  }
}