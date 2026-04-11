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
    color: '#59bead',
    colorRgb: '89,190,173',
    pillBackground: 'rgba(89,190,173,0.10)',
  },
  pattern: {
    label: 'Patterns',
    shortLabel: 'pattern',
    color: '#8b7ec8',
    colorRgb: '139,126,200',
    pillBackground: 'rgba(139,126,200,0.12)',
  },
  lesson: {
    label: 'Lessons',
    shortLabel: 'lesson',
    color: '#d4b088',
    colorRgb: '212,176,136',
    pillBackground: 'rgba(200,165,120,0.10)',
  },
  feeling: {
    label: 'Feelings',
    shortLabel: 'feeling',
    color: '#d490b0',
    colorRgb: '212,144,176',
    pillBackground: 'rgba(200,120,160,0.10)',
  },
  relationship: {
    label: 'Relationships',
    shortLabel: 'relationship',
    color: '#88aad0',
    colorRgb: '136,170,208',
    pillBackground: 'rgba(120,155,200,0.10)',
  },
  commitment: {
    label: 'Commitments',
    shortLabel: 'commitment',
    color: '#88d0b0',
    colorRgb: '136,208,176',
    pillBackground: 'rgba(120,200,165,0.10)',
  },
  preference: {
    label: 'Preferences',
    shortLabel: 'preference',
    color: '#b0a0c8',
    colorRgb: '176,160,200',
    pillBackground: 'rgba(180,160,200,0.10)',
  },
  fact: {
    label: 'Facts',
    shortLabel: 'fact',
    color: '#a0b4c8',
    colorRgb: '160,180,200',
    pillBackground: 'rgba(170,185,200,0.10)',
  },
  ritual_context: {
    label: 'Rituals',
    shortLabel: 'ritual_context',
    color: '#af9bbe',
    colorRgb: '175,155,190',
    pillBackground: 'rgba(175,155,190,0.10)',
  },
}

export const JOURNAL_IMPORTANCE_PRESENTATION: Record<JournalImportance, JournalImportancePresentation> = {
  structural: {
    label: 'Core',
    color: '#f0b97a',
    glow: 'rgba(240,185,122,0.42)',
  },
  potential: {
    label: 'Growing',
    color: '#7fd3c6',
    glow: 'rgba(127,211,198,0.40)',
  },
  contextual: {
    label: 'Passing',
    color: '#8c87a6',
    glow: 'rgba(140,135,166,0.28)',
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
      color: '#b8a8e8',
      colorRgb: '184,168,232',
      pillBackground: 'rgba(184,164,232,0.10)',
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