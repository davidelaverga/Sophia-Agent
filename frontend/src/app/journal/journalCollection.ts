type JournalCollectionEntry = {
  id: string
  metadata?: Record<string, unknown> | null
}

type BuildConstellationEntriesOptions = {
  maxCount: number
  selectedId?: string | null
  highlightIds?: ReadonlySet<string>
  favoriteCap?: number
}

export function isFavoriteMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.favorite === true
}

export function buildConstellationEntries<T extends JournalCollectionEntry>(
  entries: readonly T[],
  {
    maxCount,
    selectedId = null,
    highlightIds,
    favoriteCap = 8,
  }: BuildConstellationEntriesOptions,
): T[] {
  if (maxCount <= 0 || entries.length === 0) {
    return []
  }

  if (entries.length <= maxCount) {
    return [...entries]
  }

  const selectedSet = new Set<string>()
  const result: T[] = []

  const take = (entry: T | undefined) => {
    if (!entry || selectedSet.has(entry.id) || result.length >= maxCount) {
      return
    }

    selectedSet.add(entry.id)
    result.push(entry)
  }

  if (selectedId) {
    take(entries.find((entry) => entry.id === selectedId))
  }

  if (highlightIds && highlightIds.size > 0) {
    for (const entry of entries) {
      if (highlightIds.has(entry.id)) {
        take(entry)
      }
    }
  }

  let favoritesAdded = 0
  for (const entry of entries) {
    if (!isFavoriteMetadata(entry.metadata)) {
      continue
    }

    take(entry)
    favoritesAdded += 1
    if (favoritesAdded >= favoriteCap || result.length >= maxCount) {
      break
    }
  }

  const remainingEntries = entries.filter((entry) => !selectedSet.has(entry.id))
  const remainingSlots = maxCount - result.length
  if (remainingSlots <= 0 || remainingEntries.length === 0) {
    return result
  }

  if (remainingEntries.length <= remainingSlots) {
    remainingEntries.forEach((entry) => take(entry))
    return result
  }

  const stride = remainingEntries.length / remainingSlots
  for (let index = 0; index < remainingSlots; index += 1) {
    const candidate = remainingEntries[Math.min(remainingEntries.length - 1, Math.floor(index * stride))]
    take(candidate)
  }

  if (result.length < maxCount) {
    remainingEntries.forEach((entry) => take(entry))
  }

  return result
}