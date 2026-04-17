export const JOURNAL_CATEGORIES = [
  'decision',
  'pattern',
  'lesson',
  'feeling',
  'relationship',
  'commitment',
  'preference',
  'fact',
  'ritual_context',
] as const

export type JournalCategory = (typeof JOURNAL_CATEGORIES)[number]

export type JournalPeriod = 'all' | 'month' | 'week' | 'today'

export type JournalViewMode = 'pool' | 'list'

export type JournalImportance = 'structural' | 'potential' | 'contextual'

export interface JournalEntry {
  id: string
  content: string
  category: string | null
  metadata: Record<string, unknown> | null
  created_at: string | null
}

export interface JournalResponse {
  entries: JournalEntry[]
  count: number
}

export interface JournalEntryPresentation {
  label: string
  shortLabel: string
  color: string
  colorRgb: string
  pillBackground: string
}

export interface JournalImportancePresentation {
  label: string
  color: string
  glow: string
}

export const JOURNAL_CATEGORY_PRESENTATION: Record<JournalCategory, JournalEntryPresentation> = {
  decision: {
    label: 'Decisions',
    shortLabel: 'decision',
    color: 'var(--journal-decision)',
    colorRgb: '89,190,173',
    pillBackground: 'var(--journal-decision-bg)',
  },
  pattern: {
    label: 'Patterns',
    shortLabel: 'pattern',
    color: 'var(--journal-pattern)',
    colorRgb: '139,126,200',
    pillBackground: 'var(--journal-pattern-bg)',
  },
  lesson: {
    label: 'Lessons',
    shortLabel: 'lesson',
    color: 'var(--journal-lesson)',
    colorRgb: '212,176,136',
    pillBackground: 'var(--journal-lesson-bg)',
  },
  feeling: {
    label: 'Feelings',
    shortLabel: 'feeling',
    color: 'var(--journal-feeling)',
    colorRgb: '212,144,176',
    pillBackground: 'var(--journal-feeling-bg)',
  },
  relationship: {
    label: 'Relationships',
    shortLabel: 'relationship',
    color: 'var(--journal-relationship)',
    colorRgb: '136,170,208',
    pillBackground: 'var(--journal-relationship-bg)',
  },
  commitment: {
    label: 'Commitments',
    shortLabel: 'commitment',
    color: 'var(--journal-commitment)',
    colorRgb: '136,208,176',
    pillBackground: 'var(--journal-commitment-bg)',
  },
  preference: {
    label: 'Preferences',
    shortLabel: 'preference',
    color: 'var(--journal-preference)',
    colorRgb: '176,160,200',
    pillBackground: 'var(--journal-preference-bg)',
  },
  fact: {
    label: 'Facts',
    shortLabel: 'fact',
    color: 'var(--journal-fact)',
    colorRgb: '160,180,200',
    pillBackground: 'var(--journal-fact-bg)',
  },
  ritual_context: {
    label: 'Rituals',
    shortLabel: 'ritual_context',
    color: 'var(--journal-ritual)',
    colorRgb: '175,155,190',
    pillBackground: 'var(--journal-ritual-bg)',
  },
}

export const JOURNAL_IMPORTANCE_PRESENTATION: Record<JournalImportance, JournalImportancePresentation> = {
  structural: {
    label: 'Core',
    color: 'var(--journal-structural)',
    glow: 'var(--journal-structural-glow)',
  },
  potential: {
    label: 'Growing',
    color: 'var(--journal-potential)',
    glow: 'var(--journal-potential-glow)',
  },
  contextual: {
    label: 'Passing',
    color: 'var(--journal-contextual)',
    glow: 'var(--journal-contextual-glow)',
  },
}

export const JOURNAL_PATTERN_LABELS = [
  'Rest & recovery',
  'Work boundaries',
  'Creative flow',
  'Relationships',
]

export function normalizeJournalCategory(value: string | null | undefined): JournalCategory | null {
  if (!value) {
    return null
  }

  return JOURNAL_CATEGORIES.includes(value as JournalCategory) ? (value as JournalCategory) : null
}

export function getJournalCategoryPresentation(value: string | null | undefined): JournalEntryPresentation {
  const category = normalizeJournalCategory(value)
  if (!category) {
    return {
      label: 'Memories',
      shortLabel: 'memory',
      color: 'var(--journal-default)',
      colorRgb: '184,168,232',
      pillBackground: 'var(--journal-default-bg)',
    }
  }

  return JOURNAL_CATEGORY_PRESENTATION[category]
}

export function getJournalImportance(entry: JournalEntry): JournalImportance | null {
  const importance = entry.metadata && typeof entry.metadata.importance === 'string'
    ? entry.metadata.importance
    : null

  if (importance === 'structural' || importance === 'potential' || importance === 'contextual') {
    return importance
  }

  return null
}

export function getJournalImportancePresentation(
  value: JournalImportance | string | null | undefined,
): JournalImportancePresentation | null {
  if (value === 'structural' || value === 'potential' || value === 'contextual') {
    return JOURNAL_IMPORTANCE_PRESENTATION[value]
  }

  return null
}

export function parseJournalDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function getJournalStatus(entry: JournalEntry): string | null {
  const status = entry.metadata && typeof entry.metadata.status === 'string'
    ? entry.metadata.status
    : null

  return status
}

export function isSavedJournalEntry(entry: JournalEntry): boolean {
  const status = getJournalStatus(entry)
  return status !== 'pending_review' && status !== 'discarded'
}

export function getHighlightSourceId(entry: JournalEntry): string | null {
  if (!entry.metadata || typeof entry.metadata.original_memory_id !== 'string') {
    return null
  }

  return entry.metadata.original_memory_id
}

export function formatJournalDateLabel(value: string | null | undefined): string {
  const date = parseJournalDate(value)
  if (!date) {
    return 'Unknown date'
  }

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfInput = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const timeLabel = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  if (startOfInput.getTime() === startOfToday.getTime()) {
    return `Today · ${timeLabel}`
  }

  if (startOfInput.getTime() === startOfYesterday.getTime()) {
    return `Yesterday · ${timeLabel}`
  }

  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${timeLabel}`
}

export function getDaysAgo(value: string | null | undefined, now = new Date()): number {
  const date = parseJournalDate(value)
  if (!date) {
    return 180
  }

  const msPerDay = 24 * 60 * 60 * 1000
  const diff = now.getTime() - date.getTime()
  return Math.max(0, Math.min(180, Math.round(diff / msPerDay)))
}

export function formatTimelineLabel(daysAgo: number): string {
  if (daysAgo <= 0) {
    return 'Today'
  }

  if (daysAgo === 1) {
    return 'Yesterday'
  }

  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function journalPeriodAllowsEntry(daysAgo: number, period: JournalPeriod): boolean {
  if (period === 'today') {
    return daysAgo <= 0
  }

  if (period === 'week') {
    return daysAgo <= 7
  }

  if (period === 'month') {
    return daysAgo <= 30
  }

  return true
}

export function matchJournalSearch(entry: JournalEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return true
  }

  const category = normalizeJournalCategory(entry.category)
  const haystack = [
    entry.content,
    entry.category ?? '',
    category ? JOURNAL_CATEGORY_PRESENTATION[category].label : '',
  ]

  return haystack.some((value) => value.toLowerCase().includes(normalizedQuery))
}

export function summarizePatterns(entries: JournalEntry[]): string[] {
  const categoryCounts = new Map<string, number>()

  for (const entry of entries) {
    const category = normalizeJournalCategory(entry.category)
    if (!category) {
      continue
    }

    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  }

  const ordered = Array.from(categoryCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([category]) => {
      switch (category) {
        case 'pattern':
        case 'feeling':
          return 'Rest & recovery'
        case 'decision':
        case 'commitment':
          return 'Work boundaries'
        case 'lesson':
        case 'preference':
          return 'Creative flow'
        case 'relationship':
          return 'Relationships'
        case 'fact':
          return 'Identity anchors'
        case 'ritual_context':
          return 'Ritual memory'
        default:
          return 'Pattern'
      }
    })

  return ordered.length > 0 ? ordered : JOURNAL_PATTERN_LABELS
}

export function buildHighlightSet(value: string | null | undefined): Set<string> {
  if (!value) {
    return new Set()
  }

  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
}