'use client'

import {
  AlertCircle,
  Check,
  ChevronDown,
  Home,
  LayoutGrid,
  Loader2,
  Pencil,
  Search,
  Star,
  Trash2,
} from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { haptic } from '../hooks/useHaptics'
import { useVisualTier } from '../hooks/useVisualTier'
import { logger } from '../lib/error-logger'
import {
  buildHighlightSet,
  formatJournalDateLabel,
  formatTimelineLabel,
  getHighlightSourceId,
  getJournalCategoryPresentation,
  getJournalImportance,
  getJournalImportancePresentation,
  getJournalStatus,
  getDaysAgo,
  isJournalFavorite,
  journalPeriodAllowsEntry,
  JOURNAL_CATEGORIES,
  matchJournalSearch,
  normalizeJournalCategory,
  type JournalCategory,
  type JournalEntry,
  type JournalPeriod,
  type JournalResponse,
} from '../lib/journal'
import { useUiStore } from '../stores/ui-store'

import {
  JOURNAL_POOL_FRAGMENT_SHADER,
  JOURNAL_POOL_VERTEX_SHADER,
} from './journalPoolShaders'
import {
  getDetailPanelPosition,
  getHoverLabelPosition,
} from './journalFloatingLayout'
import { buildConstellationEntries } from './journalCollection'

import styles from './journal.module.css'

const MAX_TIMELINE_DAYS = 180
const HIT_RADIUS = 28
const MAX_SHADER_MEMORIES = 16
const MAX_COMETS = 4
const CAMERA_POSITION = [0, 1.05, -1.4] as const
const CAMERA_TARGET = [0, -0.05, 0.15] as const
const CAMERA_FOV = 1.7
const JOURNAL_CACHE_KEY = 'sophia-journal-cache-v1'
const JOURNAL_CACHE_TTL_MS = 5 * 60 * 1000
const INITIAL_TIMELINE_POSITION = -1

const PROTOTYPE_LAYOUT_SEEDS: Array<[number, number, number, number]> = [
  [-0.55, 0.35, 0.75, 0.65],
  [0.7, 0.5, 0.7, 0.55],
  [0.05, 0.2, 0.8, 0.6],
  [-1.2, 0.55, 0.9, 0.8],
  [1.45, 0.3, 0.55, 0.5],
  [0.3, 0.75, 0.45, 0.42],
  [-0.2, 0.95, 0.8, 0.7],
  [-1.65, 0.25, 0.4, 0.38],
  [1.7, 0.65, 0.55, 0.48],
  [0.5, 1.25, 0.35, 0.35],
  [-0.85, 1.1, 0.38, 0.4],
  [1.15, 0.1, 0.6, 0.55],
  [-1.5, 0.9, 0.3, 0.32],
  [0.1, 0.55, 0.5, 0.45],
  [1.5, 1.05, 0.28, 0.3],
  [-0.4, 0.15, 0.42, 0.4],
  [0.8, 1.5, 0.25, 0.3],
  [-1.4, 1.35, 0.35, 0.35],
  [-0.15, 1.55, 0.22, 0.28],
  [1.55, 1.4, 0.3, 0.32],
  [-1.75, 0.6, 0.4, 0.38],
  [0.45, 1.75, 0.2, 0.25],
  [-0.7, 1.8, 0.18, 0.25],
  [1.2, 1.7, 0.15, 0.22],
]

type Vec3 = readonly [number, number, number]

type SceneEntry = JournalEntry & {
  daysAgo: number
  timelinePosition: number
  displayDate: string
  presentation: ReturnType<typeof getJournalCategoryPresentation>
  seed: number
  worldX: number
  worldZ: number
  brightness: number
  orbSize: number
  phase: number
  dist: number
  colorTriplet: readonly [number, number, number]
  originalMemoryId: string | null
}

type MonthMarker = {
  label: string
  daysAgo: number
  timelinePosition: number
}

type ScreenPosition = {
  x: number
  y: number
  radius: number
  scale: number
  visible: boolean
}

type Particle = {
  x: number
  y: number
  sz: number
  al: number
  ph: number
  sp: number
  dr: number
  layer: 0 | 1 | 2
  cr: number
  cg: number
  cb: number
}

type Comet = {
  x: number
  z: number
  dx: number
  dz: number
  angle: number
  life: number
  maxLife: number
  peak: number
}

const vectorMath = {
  sub(left: Vec3, right: Vec3): [number, number, number] {
    return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
  },
  norm(vector: Vec3): [number, number, number] {
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1
    return [vector[0] / length, vector[1] / length, vector[2] / length]
  },
  cross(left: Vec3, right: Vec3): [number, number, number] {
    return [
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0],
    ]
  },
  dot(left: Vec3, right: Vec3): number {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
  },
}

const cameraForward = vectorMath.norm(vectorMath.sub(CAMERA_TARGET, CAMERA_POSITION))
const cameraRight = vectorMath.norm(vectorMath.cross([0, 1, 0], cameraForward))
const cameraUp = vectorMath.cross(cameraRight, cameraForward)

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function createSeedFromString(value: string): number {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function mulberry32(seed: number) {
  let next = seed
  return () => {
    next += 0x6d2b79f5
    let value = next
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function buildMonthMarkers(entries: Pick<SceneEntry, 'created_at'>[], maxTimelineDays: number): MonthMarker[] {
  if (entries.length === 0) {
    return []
  }

  const now = new Date()
  const markers: MonthMarker[] = []
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1)
  const oldestEntry = entries.reduce<Date | null>((oldest, entry) => {
    const createdAt = entry.created_at ? new Date(entry.created_at) : null

    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return oldest
    }

    if (!oldest || createdAt.getTime() < oldest.getTime()) {
      return createdAt
    }

    return oldest
  }, null)

  if (!oldestEntry) {
    return []
  }

  const oldestMonthStart = new Date(oldestEntry.getFullYear(), oldestEntry.getMonth(), 1)

  while (cursor.getTime() >= oldestMonthStart.getTime()) {
    const markerDate = new Date(cursor)

    const daysAgo = clamp(getDaysAgo(markerDate.toISOString(), now), 0, maxTimelineDays)
    markers.push({
      label: markerDate.toLocaleDateString([], { month: 'short' }),
      daysAgo,
      timelinePosition: maxTimelineDays - daysAgo,
    })

    cursor.setMonth(cursor.getMonth() - 1)
  }

  return markers.reverse()
}

function parseRgbTriplet(value: string): readonly [number, number, number] {
  const parts = value.split(',').map((part) => Number(part.trim()))
  return [parts[0] ?? 184, parts[1] ?? 168, parts[2] ?? 232]
}

function createSpiralLayoutSeed(index: number, seed: number): [number, number, number, number] {
  const random = mulberry32(seed)
  const ring = Math.floor(index / 6) + 1
  const angle = index * 2.399963229728653 + random() * 0.5
  const radius = 1.25 + ring * 0.22 + random() * 0.16
  const worldX = clamp(Math.cos(angle) * radius, -1.9, 1.9)
  const worldZ = clamp(0.45 + Math.sin(angle) * 0.28 + ring * 0.22 + random() * 0.18, 0.18, 1.95)
  const brightness = clamp(0.22 + random() * 0.35, 0.15, 0.85)
  const orbSize = clamp(0.24 + random() * 0.28, 0.2, 0.8)
  return [worldX, worldZ, brightness, orbSize]
}

function getLayoutSeed(index: number, seed: number): [number, number, number, number] {
  return PROTOTYPE_LAYOUT_SEEDS[index] ?? createSpiralLayoutSeed(index, seed)
}

function poolToScreen(worldX: number, worldZ: number, width: number, height: number) {
  const translated: Vec3 = [worldX - CAMERA_POSITION[0], -CAMERA_POSITION[1], worldZ - CAMERA_POSITION[2]]
  const forwardDistance = vectorMath.dot(translated, cameraForward)
  if (forwardDistance <= 0) {
    return null
  }

  const rightDistance = vectorMath.dot(translated, cameraRight)
  const upDistance = vectorMath.dot(translated, cameraUp)
  const aspect = width / height

  return {
    x: (rightDistance / (forwardDistance * CAMERA_FOV * aspect) + 0.5) * width,
    y: (-upDistance / (forwardDistance * CAMERA_FOV) + 0.5) * height,
    scale: 1 / forwardDistance,
  }
}

function worldToShaderPoint(worldX: number, worldZ: number, width: number, height: number): readonly [number, number] {
  const projected = poolToScreen(worldX, worldZ, width, height)
  if (!projected) {
    return [worldX, worldZ]
  }

  const aspect = width / height
  const screenX = (projected.x / width - 0.5) * aspect
  const screenY = projected.y / height - 0.5
  const rayX = cameraForward[0] + cameraRight[0] * screenX * CAMERA_FOV + cameraUp[0] * screenY * CAMERA_FOV
  const rayY = cameraForward[1] + cameraRight[1] * screenX * CAMERA_FOV + cameraUp[1] * screenY * CAMERA_FOV
  const rayZ = cameraForward[2] + cameraRight[2] * screenX * CAMERA_FOV + cameraUp[2] * screenY * CAMERA_FOV

  if (rayY >= 0) {
    return [worldX, worldZ]
  }

  const timeToPlane = -CAMERA_POSITION[1] / rayY
  return [CAMERA_POSITION[0] + rayX * timeToPlane, CAMERA_POSITION[2] + rayZ * timeToPlane]
}

function createShader(gl: WebGLRenderingContext, shaderType: number, source: string) {
  const shader = gl.createShader(shaderType)
  if (!shader) {
    return null
  }

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Journal shader compile failed', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }

  return shader
}

function createProgram(gl: WebGLRenderingContext) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, JOURNAL_POOL_VERTEX_SHADER)
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, JOURNAL_POOL_FRAGMENT_SHADER)
  if (!vertexShader || !fragmentShader) {
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    return null
  }

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Journal shader link failed', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }

  return program
}

function decorateEntries(entries: JournalEntry[]): { sceneEntries: SceneEntry[]; maxTimelineDays: number } {
  const sortedEntries = [...entries].sort((left, right) => {
    const leftTs = left.created_at ? Date.parse(left.created_at) : 0
    const rightTs = right.created_at ? Date.parse(right.created_at) : 0
    return rightTs - leftTs
  })

  const oldestAge = sortedEntries.reduce((maxAge, entry) => Math.max(maxAge, getDaysAgo(entry.created_at)), 0)
  const maxTimelineDays = clamp(oldestAge, 0, MAX_TIMELINE_DAYS)

  const sceneEntries = sortedEntries.map((entry, index) => {
    const seed = createSeedFromString(`${entry.id}:${entry.created_at ?? 'none'}:${entry.category ?? 'memory'}`)
    const daysAgo = clamp(getDaysAgo(entry.created_at), 0, maxTimelineDays)
    const [worldX, worldZ, brightness, orbSize] = getLayoutSeed(index, seed)
    const phase = index * 2.09 + 0.7
    const presentation = getJournalCategoryPresentation(entry.category)

    return {
      ...entry,
      daysAgo,
      timelinePosition: maxTimelineDays - daysAgo,
      displayDate: formatJournalDateLabel(entry.created_at),
      presentation,
      seed,
      worldX,
      worldZ,
      brightness,
      orbSize,
      phase,
      dist: Math.hypot(worldX, worldZ),
      colorTriplet: parseRgbTriplet(presentation.colorRgb),
      originalMemoryId: getHighlightSourceId(entry),
    }
  })

  return { sceneEntries, maxTimelineDays }
}

function getPeriodLabel(period: JournalPeriod): string {
  if (period === 'today') {
    return 'Today'
  }
  if (period === 'week') {
    return 'This week'
  }
  if (period === 'month') {
    return 'This month'
  }
  return 'All time'
}

function buildTimelineCount(count: number): string {
  return `${count} ${count === 1 ? 'memory' : 'memories'}`
}

function truncateJournalDeleteLabel(text: string, maxLength = 44): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function formatJournalDeleteLabel(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'memory'
  }

  return `"${truncateJournalDeleteLabel(normalized)}"`
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

type PendingEntryAction = {
  id: string
  kind: 'save' | 'delete' | 'favorite'
}

type JournalCollectionScope = 'all' | 'favorites'

type TimelineResolution<T> = {
  entries: T[]
  anchoredToNearest: boolean
}

type CachedJournalPayload = {
  savedAt: number
  entries: JournalEntry[]
}

function readJournalCache(): JournalEntry[] | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.sessionStorage.getItem(JOURNAL_CACHE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<CachedJournalPayload>
    if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.savedAt !== 'number') {
      window.sessionStorage.removeItem(JOURNAL_CACHE_KEY)
      return null
    }

    if (Date.now() - parsed.savedAt > JOURNAL_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(JOURNAL_CACHE_KEY)
      return null
    }

    return parsed.entries
  } catch {
    window.sessionStorage.removeItem(JOURNAL_CACHE_KEY)
    return null
  }
}

function writeJournalCache(entries: JournalEntry[]): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const payload: CachedJournalPayload = {
      savedAt: Date.now(),
      entries,
    }
    window.sessionStorage.setItem(JOURNAL_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore cache write failures in the journal shell.
  }
}

function resolveTimelineEntries<T extends { timelinePosition: number }>(
  entries: T[],
  timelinePosition: number,
): TimelineResolution<T> {
  return {
    entries: entries.filter((entry) => entry.timelinePosition <= timelinePosition),
    anchoredToNearest: false,
  }
}

export function JournalPageClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const showToast = useUiStore((state) => state.showToast)
  const highlightSet = useMemo(() => buildHighlightSet(searchParams.get('highlight')), [searchParams])

  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeCollection, setActiveCollection] = useState<JournalCollectionScope>('all')
  const [activeFilter, setActiveFilter] = useState<'all' | JournalCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [activePeriod, setActivePeriod] = useState<JournalPeriod>('all')
  const [timelinePosition, setTimelinePosition] = useState(INITIAL_TIMELINE_POSITION)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false)
  const [typeMenuOpen, setTypeMenuOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [entryActionError, setEntryActionError] = useState<string | null>(null)
  const [pendingEntryAction, setPendingEntryAction] = useState<PendingEntryAction | null>(null)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const periodButtonRef = useRef<HTMLButtonElement>(null)
  const periodMenuRef = useRef<HTMLDivElement>(null)
  const typeButtonRef = useRef<HTMLButtonElement>(null)
  const typeMenuRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const hoverLabelRef = useRef<HTMLDivElement>(null)
  const poolCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const hitCanvasRef = useRef<HTMLCanvasElement>(null)

  const { tier: visualTier, dprCap, reducedMotion: prefersReducedMotion } = useVisualTier()
  const tierRef = useRef(visualTier)
  const dprCapRef = useRef(dprCap)
  tierRef.current = visualTier
  dprCapRef.current = dprCap

  const positionsRef = useRef<Record<string, ScreenPosition>>({})
  const constellationEntriesRef = useRef<SceneEntry[]>([])
  const visibleIdsRef = useRef<Set<string>>(new Set())
  const selectedIdRef = useRef<string | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const highlightIdsRef = useRef<Set<string>>(new Set())
  const staticSceneRenderRef = useRef<(() => void) | null>(null)

  const { sceneEntries, maxTimelineDays } = useMemo(() => decorateEntries(entries), [entries])

  const maxConstellationEntries = visualTier === 1 ? 14 : visualTier === 2 ? 24 : 36

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    hoveredIdRef.current = hoveredId
  }, [hoveredId])

  useEffect(() => {
    highlightIdsRef.current = highlightSet
  }, [highlightSet])

  useEffect(() => {
    setTimelinePosition((current) => {
      if (current === INITIAL_TIMELINE_POSITION) {
        return maxTimelineDays
      }

      return clamp(current, 0, maxTimelineDays)
    })
  }, [maxTimelineDays])

  useEffect(() => {
    const controller = new AbortController()
    const cachedEntries = readJournalCache()

    if (cachedEntries) {
      setEntries(cachedEntries)
      setIsLoading(false)
      setIsRefreshing(true)
    } else {
      setIsLoading(true)
    }

    async function loadJournal() {
      setError(null)

      try {
        const response = await fetch('/api/journal', {
          method: 'GET',
          signal: controller.signal,
          cache: 'no-store',
        })

        if (!response.ok) {
          throw new Error(`Journal request failed: ${response.status}`)
        }

        const payload = (await response.json()) as JournalResponse
        const nextEntries = Array.isArray(payload.entries) ? payload.entries : []
        setEntries(nextEntries)
        writeJournalCache(nextEntries)
      } catch (loadError) {
        if (controller.signal.aborted) {
          return
        }

        logger.logError(loadError, { component: 'Journal', action: 'load_journal' })
        if (!cachedEntries) {
          setError('Could not load your journal right now.')
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
          setIsRefreshing(false)
        }
      }
    }

    void loadJournal()

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (isLoading || error) {
      return
    }

    writeJournalCache(entries)
  }, [entries, error, isLoading])

  useEffect(() => {
    if (sceneEntries.length === 0 || highlightSet.size === 0) {
      return
    }

    const match = sceneEntries.find((entry) => highlightSet.has(entry.id) || (entry.originalMemoryId ? highlightSet.has(entry.originalMemoryId) : false))
    if (!match) {
      return
    }

    startTransition(() => {
      setSelectedId(match.id)
      setTimelinePosition((current) => Math.max(current, match.timelinePosition))
    })
  }, [highlightSet, sceneEntries])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      }

      if (event.key === 'Escape') {
        if (periodMenuOpen) {
          setPeriodMenuOpen(false)
          return
        }

        if (typeMenuOpen) {
          setTypeMenuOpen(false)
          return
        }

        if (deleteConfirmId) {
          setDeleteConfirmId(null)
          setEntryActionError(null)
          return
        }

        if (selectedIdRef.current) {
          setSelectedId(null)
          return
        }

        if (searchInputRef.current?.value) {
          setSearchQuery('')
          searchInputRef.current.blur()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deleteConfirmId, periodMenuOpen, typeMenuOpen])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null

      if (periodMenuOpen) {
        if (!periodMenuRef.current?.contains(target) && !periodButtonRef.current?.contains(target)) {
          setPeriodMenuOpen(false)
        }
      }

      if (typeMenuOpen) {
        if (!typeMenuRef.current?.contains(target) && !typeButtonRef.current?.contains(target)) {
          setTypeMenuOpen(false)
        }
      }
    }

    if (!periodMenuOpen && !typeMenuOpen) {
      return
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [periodMenuOpen, typeMenuOpen])

  const filteredEntries = useMemo(() => {
    return sceneEntries.filter((entry) => {
      if (activeCollection === 'favorites' && !isJournalFavorite(entry)) {
        return false
      }

      const category = normalizeJournalCategory(entry.category)
      if (activeFilter !== 'all' && category !== activeFilter) {
        return false
      }

      if (!matchJournalSearch(entry, deferredSearchQuery)) {
        return false
      }

      if (!journalPeriodAllowsEntry(entry.daysAgo, activePeriod)) {
        return false
      }

      return true
    })

  }, [activeCollection, activeFilter, activePeriod, deferredSearchQuery, sceneEntries])

  const effectiveTimelinePosition = timelinePosition === INITIAL_TIMELINE_POSITION
    ? maxTimelineDays
    : clamp(timelinePosition, 0, maxTimelineDays)

  const {
    entries: visibleEntries,
    anchoredToNearest: timelineAnchoredToNearest,
  } = useMemo(
    () => resolveTimelineEntries(filteredEntries, effectiveTimelinePosition),
    [effectiveTimelinePosition, filteredEntries],
  )

  useEffect(() => {
    visibleIdsRef.current = new Set(visibleEntries.map((entry) => entry.id))
  }, [visibleEntries])

  const showInteractiveScene = !isLoading && !error && visibleEntries.length > 0

  const constellationEntries = useMemo(() => buildConstellationEntries(visibleEntries, {
    maxCount: maxConstellationEntries,
    selectedId,
    highlightIds: highlightSet,
  }), [highlightSet, maxConstellationEntries, selectedId, visibleEntries])

  useEffect(() => {
    constellationEntriesRef.current = constellationEntries
  }, [constellationEntries])

  const selectedEntry = useMemo(
    () => visibleEntries.find((entry) => entry.id === selectedId) ?? sceneEntries.find((entry) => entry.id === selectedId) ?? null,
    [sceneEntries, selectedId, visibleEntries],
  )
  const selectedImportance = selectedEntry ? getJournalImportancePresentation(getJournalImportance(selectedEntry)) : null
  const selectedIsFavorite = selectedEntry ? isJournalFavorite(selectedEntry) : false
  const showDetailPanel = Boolean(selectedEntry)

  const activeTimelineDaysAgo = maxTimelineDays - effectiveTimelinePosition
  const timelineLabel = formatTimelineLabel(activeTimelineDaysAgo)
  const monthMarkers = useMemo(() => buildMonthMarkers(sceneEntries, maxTimelineDays), [maxTimelineDays, sceneEntries])
  const favoriteCount = useMemo(() => entries.filter(isJournalFavorite).length, [entries])

  useEffect(() => {
    if (!selectedEntry) {
      return
    }

    if (!visibleEntries.some((entry) => entry.id === selectedEntry.id)) {
      setSelectedId(null)
      setHoveredId(null)
      setEditingId(null)
      setDraftText('')
      setDeleteConfirmId(null)
    }
  }, [selectedEntry, visibleEntries])

  useEffect(() => {
    if (editingId && !entries.some((entry) => entry.id === editingId)) {
      setEditingId(null)
      setDraftText('')
      setEntryActionError(null)
    }

    if (deleteConfirmId && !entries.some((entry) => entry.id === deleteConfirmId)) {
      setDeleteConfirmId(null)
      setEntryActionError(null)
    }
  }, [deleteConfirmId, editingId, entries])

  useEffect(() => {
    if (deleteConfirmId && selectedId !== deleteConfirmId) {
      setDeleteConfirmId(null)
      setEntryActionError(null)
    }
  }, [deleteConfirmId, selectedId])

  const beginEditingEntry = useCallback((entry: SceneEntry) => {
    haptic('light')
    setSelectedId(entry.id)
    setEditingId(entry.id)
    setDeleteConfirmId(null)
    setDraftText(entry.content)
    setEntryActionError(null)
  }, [])

  const cancelEditingEntry = useCallback(() => {
    setEditingId(null)
    setDraftText('')
    setEntryActionError(null)
  }, [])

  const requestDeleteEntry = useCallback((entry: SceneEntry) => {
    haptic('medium')
    setSelectedId(entry.id)
    setDeleteConfirmId(entry.id)
    setEntryActionError(null)
  }, [])

  const cancelDeleteEntry = useCallback(() => {
    haptic('light')
    setDeleteConfirmId(null)
    setEntryActionError(null)
  }, [])

  const toggleFavoriteEntry = useCallback(async (entry: SceneEntry) => {
    const nextFavorite = !isJournalFavorite(entry)
    const nextMetadata = {
      ...(entry.metadata ?? {}),
      favorite: nextFavorite,
    }

    setPendingEntryAction({ id: entry.id, kind: 'favorite' })
    setEntryActionError(null)

    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ metadata: nextMetadata }),
      })

      if (!response.ok) {
        throw new Error(`Journal favorite update failed: ${response.status}`)
      }

      const payload = (await response.json()) as Partial<JournalEntry>
      setEntries((current) => current.map((existing) => {
        if (existing.id !== entry.id) {
          return existing
        }

        return {
          ...existing,
          category: typeof payload.category === 'string' ? payload.category : existing.category,
          metadata: payload.metadata ?? nextMetadata,
          created_at: payload.created_at ?? existing.created_at,
        }
      }))

      haptic('success')
      showToast({
        message: nextFavorite ? 'Added to favorites.' : 'Removed from favorites.',
        variant: 'success',
        durationMs: 2400,
      })
    } catch (error) {
      logger.logError(error, { component: 'Journal', action: 'toggle_favorite' })
      setEntryActionError("Couldn't update this memory right now.")
      haptic('error')
    } finally {
      setPendingEntryAction((current) => (
        current?.id === entry.id && current.kind === 'favorite' ? null : current
      ))
    }
  }, [showToast])

  const persistEntryEdit = useCallback(async (entry: SceneEntry) => {
    const nextText = draftText.trim()
    if (!nextText) {
      setEntryActionError('Memory text cannot be empty.')
      return
    }

    setPendingEntryAction({ id: entry.id, kind: 'save' })
    setEntryActionError(null)

    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: nextText }),
      })

      if (!response.ok) {
        throw new Error(`Journal memory update failed: ${response.status}`)
      }

      const payload = (await response.json()) as Partial<JournalEntry>
      setEntries((current) => current.map((existing) => {
        if (existing.id !== entry.id) {
          return existing
        }

        return {
          ...existing,
          content: typeof payload.content === 'string' && payload.content.trim() ? payload.content : nextText,
          category: typeof payload.category === 'string' ? payload.category : existing.category,
          metadata: payload.metadata ?? existing.metadata,
          created_at: payload.created_at ?? existing.created_at,
        }
      }))
      setEditingId(null)
      setDraftText('')
      haptic('success')
    } catch (error) {
      logger.logError(error, { component: 'Journal', action: 'update_memory' })
      setEntryActionError("Couldn't update this memory right now.")
      haptic('error')
    } finally {
      setPendingEntryAction((current) => (
        current?.id === entry.id && current.kind === 'save' ? null : current
      ))
    }
  }, [draftText])

  const deleteEntry = useCallback(async (entry: SceneEntry) => {
    setPendingEntryAction({ id: entry.id, kind: 'delete' })
    setEntryActionError(null)

    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(`Journal memory delete failed: ${response.status}`)
      }

      setEntries((current) => current.filter((existing) => existing.id !== entry.id))
      if (selectedId === entry.id) {
        setSelectedId(null)
      }
      if (editingId === entry.id) {
        setEditingId(null)
        setDraftText('')
      }
      setDeleteConfirmId((current) => (current === entry.id ? null : current))
      haptic('success')
      showToast({
        message: `Deleted ${formatJournalDeleteLabel(entry.content)}.`,
        variant: 'success',
        durationMs: 3200,
      })
    } catch (error) {
      logger.logError(error, { component: 'Journal', action: 'delete_memory' })
      setEntryActionError("Couldn't delete this memory right now.")
      haptic('error')
    } finally {
      setPendingEntryAction((current) => (
        current?.id === entry.id && current.kind === 'delete' ? null : current
      ))
    }
  }, [editingId, selectedId, showToast])

  const renderDeleteConfirm = useCallback((entry: SceneEntry) => {
    if (deleteConfirmId !== entry.id) {
      return null
    }

    const isDeleting = pendingEntryAction?.id === entry.id && pendingEntryAction.kind === 'delete'

    return (
      <div
        className={styles.deleteConfirmCard}
        role="alertdialog"
        aria-modal="false"
        aria-labelledby={`journal-delete-title-${entry.id}`}
      >
        <div className={styles.deleteConfirmHeader}>
          <AlertCircle className={styles.deleteConfirmIcon} />
          <p id={`journal-delete-title-${entry.id}`} className={styles.deleteConfirmTitle}>Delete this memory?</p>
        </div>
        <div className={styles.deleteConfirmActions}>
          <button
            type="button"
            className={styles.deleteConfirmCancel}
            onClick={cancelDeleteEntry}
            disabled={isDeleting}
          >
            Keep memory
          </button>
          <button
            type="button"
            className={styles.deleteConfirmDanger}
            onClick={() => void deleteEntry(entry)}
            disabled={isDeleting}
          >
            {isDeleting ? <Loader2 className={styles.actionSpinner} /> : <Trash2 className={styles.actionIcon} />}
            Delete memory
          </button>
        </div>
      </div>
    )
  }, [cancelDeleteEntry, deleteConfirmId, deleteEntry, pendingEntryAction])

  useEffect(() => {
    if (!showInteractiveScene) {
      return
    }

    const poolCanvas = poolCanvasRef.current
    const overlayCanvas = overlayCanvasRef.current
    const hitCanvas = hitCanvasRef.current
    if (!poolCanvas || !overlayCanvas || !hitCanvas) {
      return
    }

    const gl = poolCanvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    })
    const overlayContext = overlayCanvas.getContext('2d')
    const hitContext = hitCanvas.getContext('2d')
    if (!gl || !overlayContext || !hitContext) {
      return
    }

    const program = createProgram(gl)
    if (!program) {
      return
    }

    const positionAttribute = gl.getAttribLocation(program, 'p')
    const quadBuffer = gl.createBuffer()
    if (!quadBuffer || positionAttribute < 0) {
      gl.deleteProgram(program)
      return
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    const uTimeLocation = gl.getUniformLocation(program, 'uTime')
    const uResolutionLocation = gl.getUniformLocation(program, 'uRes')
    const uMouseLocation = gl.getUniformLocation(program, 'uMouse')
    const uCameraLocation = gl.getUniformLocation(program, 'uCam')
    const uTargetLocation = gl.getUniformLocation(program, 'uTgt')
    const uFovLocation = gl.getUniformLocation(program, 'uFov')
    const uMemLocation = gl.getUniformLocation(program, 'uMem[0]')
    const uMemColorLocation = gl.getUniformLocation(program, 'uMemCol[0]')
    const uCometLocation = gl.getUniformLocation(program, 'uComet[0]')

    const memUniformData = new Float32Array(MAX_SHADER_MEMORIES * 4)
    const memColorUniformData = new Float32Array(MAX_SHADER_MEMORIES * 3)
    const cometUniformData = new Float32Array(MAX_COMETS * 4)

    let viewportWidth = window.innerWidth
    let viewportHeight = window.innerHeight
    let pointerX = 0.5
    let pointerY = 0.5
    let smoothPointerX = 0.5
    let smoothPointerY = 0.5
    let animationFrame = 0
    let lastFrameTime = 0
    let nextCometSpawn = 1.5 + Math.random() * 2

    const particles: Particle[] = []
    const comets: Comet[] = []

    function resetParticles(width: number, height: number) {
      particles.length = 0
      const aspect = width / Math.max(height, 1)
      const t = tierRef.current

      if (t === 1) return

      const layer0Count = t === 2 ? 50 : 110
      for (let index = 0; index < layer0Count; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const radius = Math.pow(Math.random(), 0.42) * 0.55
        particles.push({
          x: 0.5 + Math.cos(angle) * radius * aspect,
          y: 0.50 + Math.sin(angle) * radius * 0.65,
          sz: Math.random() * 1 + 0.35,
          al: Math.random() * 0.35 + 0.10,
          ph: Math.random() * Math.PI * 2,
          sp: Math.random() * 0.10 + 0.03,
          dr: Math.random() * 0.000025 + 0.000008,
          layer: 0,
          cr: 210 + Math.random() * 40,
          cg: 195 + Math.random() * 40,
          cb: 230 + Math.random() * 20,
        })
      }

      const layer1Count = t === 2 ? 80 : 160
      for (let index = 0; index < layer1Count; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const radius = Math.pow(Math.random(), 0.35) * 0.70
        particles.push({
          x: 0.5 + Math.cos(angle) * radius * aspect,
          y: 0.54 + Math.sin(angle) * radius * 0.55,
          sz: Math.random() * 0.55 + 0.15,
          al: Math.random() * 0.20 + 0.05,
          ph: Math.random() * Math.PI * 2,
          sp: Math.random() * 0.07 + 0.02,
          dr: Math.random() * 0.000014 + 0.000003,
          layer: 1,
          cr: 200 + Math.random() * 35,
          cg: 175 + Math.random() * 30,
          cb: 220 + Math.random() * 25,
        })
      }

      const layer2Count = t === 2 ? 60 : 130
      for (let index = 0; index < layer2Count; index += 1) {
        particles.push({
          x: Math.random(),
          y: Math.random() * 0.60 + 0.15,
          sz: Math.random() * 0.28 + 0.06,
          al: Math.random() * 0.06 + 0.01,
          ph: Math.random() * Math.PI * 2,
          sp: Math.random() * 0.05 + 0.01,
          dr: Math.random() * 0.000007 + 0.000002,
          layer: 2,
          cr: 160 + Math.random() * 30,
          cg: 145 + Math.random() * 20,
          cb: 200 + Math.random() * 30,
        })
      }
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, dprCapRef.current)
      viewportWidth = window.innerWidth
      viewportHeight = window.innerHeight

      poolCanvas.width = Math.round(viewportWidth * dpr)
      poolCanvas.height = Math.round(viewportHeight * dpr)
      poolCanvas.style.width = `${viewportWidth}px`
      poolCanvas.style.height = `${viewportHeight}px`

      overlayCanvas.width = Math.round(viewportWidth * dpr)
      overlayCanvas.height = Math.round(viewportHeight * dpr)
      overlayCanvas.style.width = `${viewportWidth}px`
      overlayCanvas.style.height = `${viewportHeight}px`

      hitCanvas.width = Math.round(viewportWidth * dpr)
      hitCanvas.height = Math.round(viewportHeight * dpr)
      hitCanvas.style.width = `${viewportWidth}px`
      hitCanvas.style.height = `${viewportHeight}px`

      overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      hitContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      gl.viewport(0, 0, poolCanvas.width, poolCanvas.height)

      resetParticles(viewportWidth, viewportHeight)
    }

    function spawnComet() {
      const enterAngle = Math.random() * Math.PI * 2
      const enterRadius = 3 + Math.random() * 1.5
      const worldX = Math.cos(enterAngle) * enterRadius
      const worldZ = Math.sin(enterAngle) * enterRadius
      const crossAngle = enterAngle + Math.PI + (Math.random() - 0.5) * 0.7
      const speed = 1.8 + Math.random() * 3.0
      const peak = 0.45 + Math.random() * 0.55

      comets.push({
        x: worldX,
        z: worldZ,
        dx: Math.cos(crossAngle) * speed,
        dz: Math.sin(crossAngle) * speed,
        angle: crossAngle,
        life: 0,
        maxLife: 1.4 + Math.random() * 1.8,
        peak,
      })

      while (comets.length > MAX_COMETS) {
        comets.shift()
      }
    }

    function updateComets(deltaSeconds: number) {
      for (let index = comets.length - 1; index >= 0; index -= 1) {
        const comet = comets[index]
        comet.life += deltaSeconds
        comet.x += comet.dx * deltaSeconds
        comet.z += comet.dz * deltaSeconds
        if (comet.life > comet.maxLife) {
          comets.splice(index, 1)
        }
      }

      cometUniformData.fill(0)
      for (let index = 0; index < Math.min(comets.length, MAX_COMETS); index += 1) {
        const comet = comets[index]
        const phase = comet.life / comet.maxLife
        const envelope = phase < 0.08 ? phase / 0.08 : Math.pow(1 - phase, 2.2)
        cometUniformData[index * 4] = comet.x
        cometUniformData[index * 4 + 1] = comet.z
        cometUniformData[index * 4 + 2] = envelope * comet.peak
        cometUniformData[index * 4 + 3] = comet.angle
      }
    }

    function updateMemoryUniforms() {
      memUniformData.fill(0)
      memColorUniformData.fill(0)

      const candidates = constellationEntriesRef.current
        .filter((entry) => positionsRef.current[entry.id]?.visible)
        .map((entry) => {
          let priority = 0
          let strength = entry.brightness * 0.30 + 0.10
          if (entry.id === selectedIdRef.current) {
            priority = 2
            strength = 0.70
          } else if (entry.id === hoveredIdRef.current) {
            priority = 1
            strength = 0.50
          }

          return {
            entry,
            priority,
            strength,
          }
        })
        .sort((left, right) => right.priority - left.priority || right.strength - left.strength)

      for (let slot = 0; slot < Math.min(MAX_SHADER_MEMORIES, candidates.length); slot += 1) {
        const { entry, strength } = candidates[slot]
        const shaderPoint = worldToShaderPoint(entry.worldX, entry.worldZ, viewportWidth, viewportHeight)
        memUniformData[slot * 4] = shaderPoint[0]
        memUniformData[slot * 4 + 1] = shaderPoint[1]
        memUniformData[slot * 4 + 2] = strength
        memUniformData[slot * 4 + 3] = entry.phase
        memColorUniformData[slot * 3] = entry.colorTriplet[0] / 255
        memColorUniformData[slot * 3 + 1] = entry.colorTriplet[1] / 255
        memColorUniformData[slot * 3 + 2] = entry.colorTriplet[2] / 255
      }
    }

    function drawOverlay(time: number) {
      overlayContext.clearRect(0, 0, viewportWidth, viewportHeight)

      const visibleEntriesNow = constellationEntriesRef.current
      const positions: Record<string, ScreenPosition> = {}

      for (const entry of visibleEntriesNow) {
        const projected = poolToScreen(entry.worldX, entry.worldZ, viewportWidth, viewportHeight)
        if (!projected || projected.x < -60 || projected.x > viewportWidth + 60 || projected.y < -60 || projected.y > viewportHeight + 60) {
          positions[entry.id] = { x: 0, y: 0, radius: 0, scale: 0, visible: false }
          continue
        }

        const waveDecay = Math.exp(-entry.dist * 0.42)
        const waveHeight = 0.018 * Math.sin(entry.dist * 14 - time * 1.5) * waveDecay
          + 0.010 * Math.sin(entry.dist * 24 - time * 2.2 + 0.5) * waveDecay * 0.70
        const radius = Math.max(7, (10 + entry.orbSize * 5) * Math.min(2.5, projected.scale * 3.5) * 0.70)

        positions[entry.id] = {
          x: projected.x,
          y: projected.y + waveHeight * projected.scale * viewportHeight * 0.45,
          radius,
          scale: projected.scale,
          visible: true,
        }
      }

      positionsRef.current = positions

      for (const particle of particles) {
        const layerSpeed = [1.0, 0.60, 0.28][particle.layer]
        particle.x += particle.dr * Math.cos(time * 0.08 + particle.ph) * layerSpeed
        particle.y += particle.dr * Math.sin(time * 0.06 + particle.ph) * 0.4 * layerSpeed

        if (particle.x < -0.04) particle.x = 1.04
        if (particle.x > 1.04) particle.x = -0.04
        if (particle.y < -0.04) particle.y = 1.04
        if (particle.y > 1.04) particle.y = -0.04

        const pulse = Math.sin(time * particle.sp + particle.ph) * 0.35 + 0.65
        const twinkle = Math.max(0, Math.sin(time * particle.sp * 3.7 + particle.ph * 2.1)) ** 4
        const alpha = particle.al * pulse
        if (alpha < 0.003) {
          continue
        }

        const screenX = particle.x * viewportWidth
        const screenY = particle.y * viewportHeight
        const distanceFromCenter = Math.hypot(particle.x - 0.5, particle.y - 0.52)
        const boost = Math.max(0, 1 - distanceFromCenter * 1.8) * 0.55 + 1

        let red = Math.round(particle.cr)
        let green = Math.round(particle.cg)
        let blue = Math.round(particle.cb)
        let closestDistance = Number.POSITIVE_INFINITY
        let closestEntry: SceneEntry | null = null

        for (const entry of visibleEntriesNow) {
          const position = positions[entry.id]
          if (!position?.visible) {
            continue
          }

          const distance = Math.hypot(screenX - position.x, screenY - position.y)
          if (distance < closestDistance) {
            closestDistance = distance
            closestEntry = entry
          }
        }

        if (closestEntry && closestDistance < 120) {
          const blend = Math.max(0, 1 - closestDistance / 120) * 0.6
          red = Math.round(red * (1 - blend) + closestEntry.colorTriplet[0] * blend)
          green = Math.round(green * (1 - blend) + closestEntry.colorTriplet[1] * blend)
          blue = Math.round(blue * (1 - blend) + closestEntry.colorTriplet[2] * blend)

          const closestPosition = positions[closestEntry.id]
          if (closestPosition) {
            const dx = closestPosition.x / viewportWidth - particle.x
            const dy = closestPosition.y / viewportHeight - particle.y
            particle.x += dx * 0.0003 * blend
            particle.y += dy * 0.0003 * blend
          }
        }

        const glowRadius = particle.sz * 12.0
        if (glowRadius > 2) {
          const glow = overlayContext.createRadialGradient(screenX, screenY, 0, screenX, screenY, glowRadius)
          glow.addColorStop(0, `rgba(${red},${green},${blue},${Math.min(1, alpha * 0.45 * boost)})`)
          glow.addColorStop(0.4, `rgba(${red},${green},${blue},${Math.min(1, alpha * 0.15 * boost)})`)
          glow.addColorStop(1, `rgba(${red},${green},${blue},0)`)
          overlayContext.beginPath()
          overlayContext.arc(screenX, screenY, glowRadius, 0, Math.PI * 2)
          overlayContext.fillStyle = glow
          overlayContext.fill()
        }

        const coreRadius = Math.max(0.8, particle.sz * 1.2)
        const coreAlpha = Math.min(1, alpha * 1.2 * boost + twinkle * 0.4)
        overlayContext.beginPath()
        overlayContext.arc(screenX, screenY, coreRadius, 0, Math.PI * 2)
        overlayContext.fillStyle = `rgba(${Math.min(255, red + 40)},${Math.min(255, green + 40)},${Math.min(255, blue + 20)},${coreAlpha})`
        overlayContext.fill()
      }

      const visibleGems = visibleEntriesNow
        .map((entry) => {
          const position = positions[entry.id]
          if (!position?.visible || position.scale <= 0.05) {
            return null
          }

          return {
            entry,
            position,
          }
        })
        .filter((value): value is { entry: SceneEntry; position: ScreenPosition } => Boolean(value))

      const linkCount = new Map<string, number>()
      for (let index = 0; index < visibleGems.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < visibleGems.length; otherIndex += 1) {
          const left = visibleGems[index]
          const right = visibleGems[otherIndex]
          if ((linkCount.get(left.entry.id) ?? 0) >= 2 || (linkCount.get(right.entry.id) ?? 0) >= 2) {
            continue
          }

          const worldDistance = Math.hypot(left.entry.worldX - right.entry.worldX, left.entry.worldZ - right.entry.worldZ)
          if (worldDistance > 0.95) {
            continue
          }

          linkCount.set(left.entry.id, (linkCount.get(left.entry.id) ?? 0) + 1)
          linkCount.set(right.entry.id, (linkCount.get(right.entry.id) ?? 0) + 1)

          const distanceFade = 1 - worldDistance / 0.95
          const depthAlpha = Math.min(1.0, left.position.scale * 3.0)
          const depthBeta = Math.min(1.0, right.position.scale * 3.0)
          const lineAlpha = distanceFade * distanceFade * Math.min(depthAlpha, depthBeta) * 0.65
          if (lineAlpha < 0.003) {
            continue
          }

          const gradient = overlayContext.createLinearGradient(left.position.x, left.position.y, right.position.x, right.position.y)
          gradient.addColorStop(0, 'rgba(200,185,235,0)')
          gradient.addColorStop(0.08, `rgba(200,185,235,${lineAlpha * 0.6})`)
          gradient.addColorStop(0.5, `rgba(220,205,245,${lineAlpha})`)
          gradient.addColorStop(0.92, `rgba(200,185,235,${lineAlpha * 0.6})`)
          gradient.addColorStop(1, 'rgba(200,185,235,0)')

          const dx = right.position.x - left.position.x
          const dy = right.position.y - left.position.y
          const length = Math.hypot(dx, dy) || 1
          const normalX = -dy / length
          const normalY = dx / length
          const curvature = Math.sin(index * 1.7 + otherIndex * 0.9 + time * 0.08) * 12 + Math.cos(index * 0.5 - otherIndex * 1.3) * 6
          const controlX = (left.position.x + right.position.x) * 0.5 + normalX * curvature
          const controlY = (left.position.y + right.position.y) * 0.5 + normalY * curvature

          overlayContext.beginPath()
          overlayContext.moveTo(left.position.x, left.position.y)
          overlayContext.quadraticCurveTo(controlX, controlY, right.position.x, right.position.y)
          overlayContext.strokeStyle = `rgba(190,175,230,${lineAlpha * 0.25})`
          overlayContext.lineWidth = 4.5
          overlayContext.stroke()

          overlayContext.beginPath()
          overlayContext.moveTo(left.position.x, left.position.y)
          overlayContext.quadraticCurveTo(controlX, controlY, right.position.x, right.position.y)
          overlayContext.strokeStyle = gradient
          overlayContext.lineWidth = 1.4
          overlayContext.stroke()
        }
      }

      for (const { entry, position } of visibleGems) {
        const isSelected = entry.id === selectedIdRef.current
        const isHovered = entry.id === hoveredIdRef.current
        const [red, green, blue] = entry.colorTriplet

        const breathe = Math.sin(time * 0.25 + entry.phase) * 0.08 + Math.sin(time * 0.13 + entry.phase * 1.7) * 0.04
        const depthFade = Math.min(1, Math.pow(Math.min(position.scale * 3.0, 1.0), 0.55))
        const orbRadius = position.radius
        let alpha = (0.65 + entry.brightness * 0.30 + breathe) * depthFade
        if (isSelected) {
          alpha = Math.min(1, alpha * 2)
        } else if (isHovered) {
          alpha = Math.min(0.95, alpha * 1.7)
        }

        const x = position.x
        const y = position.y
        const glowAlpha = isSelected ? 3.5 : isHovered ? 2.2 : 1

        if (depthFade > 0.10) {
          const ringCount = isSelected ? 5 : isHovered ? 4 : 3
          for (let ringIndex = 0; ringIndex < ringCount; ringIndex += 1) {
            const ripplePhase = ((time * 0.28 + entry.phase + ringIndex * 1.2) % 5.0) / 5.0
            const rippleRadius = orbRadius * 0.8 + ripplePhase * (isSelected ? 45 : isHovered ? 32 : 22)
            const rippleAlpha = (1 - ripplePhase) * (isSelected ? 0.22 : isHovered ? 0.14 : 0.07) * depthFade
            if (rippleAlpha < 0.004) {
              continue
            }

            const warmth = Math.max(0, 1 - ripplePhase)
            const rippleRed = Math.round(red * 0.4 + 120 * 0.6 + warmth * 40)
            const rippleGreen = Math.round(green * 0.4 + 100 * 0.6 + warmth * 35)
            const rippleBlue = Math.round(blue * 0.4 + 155 * 0.6 - warmth * 30)
            overlayContext.beginPath()
            overlayContext.arc(x, y, rippleRadius, 0, Math.PI * 2)
            overlayContext.strokeStyle = `rgba(${rippleRed},${rippleGreen},${rippleBlue},${rippleAlpha})`
            overlayContext.lineWidth = isSelected ? 1.2 : isHovered ? 0.9 : 0.5
            overlayContext.stroke()
          }
        }

        const haloRadius = orbRadius * 4.0 + (isSelected ? 35 : isHovered ? 25 : 16 + entry.brightness * 10)
        const haloOpacity = (0.22 + breathe * 0.04) * depthFade * (0.6 + entry.brightness * 0.4) * glowAlpha
        const halo = overlayContext.createRadialGradient(x, y, 0, x, y, haloRadius)
        halo.addColorStop(0, `rgba(${Math.round(red * 0.5 + 185 * 0.5)},${Math.round(green * 0.5 + 165 * 0.5)},${Math.round(blue * 0.5 + 190 * 0.5)},${Math.min(0.55, haloOpacity * 1.5)})`)
        halo.addColorStop(0.25, `rgba(${Math.round(red * 0.4 + 170 * 0.6)},${Math.round(green * 0.4 + 150 * 0.6)},${Math.round(blue * 0.4 + 180 * 0.6)},${Math.min(0.30, haloOpacity * 0.8)})`)
        halo.addColorStop(0.6, `rgba(${Math.round(red * 0.35 + 150 * 0.65)},${Math.round(green * 0.35 + 130 * 0.65)},${Math.round(blue * 0.35 + 170 * 0.65)},${Math.min(0.12, haloOpacity * 0.3)})`)
        halo.addColorStop(1, 'rgba(160,145,185,0)')
        overlayContext.beginPath()
        overlayContext.arc(x, y, haloRadius, 0, Math.PI * 2)
        overlayContext.fillStyle = halo
        overlayContext.fill()

        const anchorY = y + orbRadius * 1.1
        const anchorRadiusX = orbRadius * 4.5
        const anchorRadiusY = anchorRadiusX * 0.32
        const anchorOpacity = 0.22 * depthFade * Math.min(1, alpha * 1.2)
        if (anchorOpacity > 0.004) {
          overlayContext.save()
          overlayContext.translate(x, anchorY)
          overlayContext.scale(1, anchorRadiusY / anchorRadiusX)
          const anchor = overlayContext.createRadialGradient(0, 0, 0, 0, 0, anchorRadiusX)
          anchor.addColorStop(0, `rgba(${red},${green},${blue},${Math.min(0.38, anchorOpacity * 1.2)})`)
          anchor.addColorStop(0.35, `rgba(${red},${green},${blue},${Math.min(0.18, anchorOpacity * 0.55)})`)
          anchor.addColorStop(0.7, `rgba(${Math.floor(red * 0.4)},${Math.floor(green * 0.4)},${Math.floor(blue * 0.5)},${anchorOpacity * 0.15})`)
          anchor.addColorStop(1, 'rgba(6,5,12,0)')
          overlayContext.beginPath()
          overlayContext.arc(0, 0, anchorRadiusX, 0, Math.PI * 2)
          overlayContext.fillStyle = anchor
          overlayContext.fill()
          overlayContext.restore()
        }

        if (depthFade > 0.08) {
          const ringY = y + orbRadius * 0.55
          const ringRadiusX = orbRadius * 1.3
          const ringRadiusY = ringRadiusX * 0.35
          const ringOpacity = Math.min(0.45, alpha * 0.50) * depthFade
          overlayContext.save()
          overlayContext.translate(x, ringY)
          overlayContext.scale(1, ringRadiusY / ringRadiusX)
          overlayContext.beginPath()
          overlayContext.arc(0, 0, ringRadiusX, 0, Math.PI * 2)
          overlayContext.strokeStyle = `rgba(${Math.min(255, red + 60)},${Math.min(255, green + 50)},${Math.min(255, blue + 40)},${ringOpacity})`
          overlayContext.lineWidth = 1.2
          overlayContext.stroke()
          overlayContext.beginPath()
          overlayContext.arc(0, 0, ringRadiusX + 2, 0, Math.PI * 2)
          overlayContext.strokeStyle = `rgba(${red},${green},${blue},${ringOpacity * 0.3})`
          overlayContext.lineWidth = 3.0
          overlayContext.stroke()
          overlayContext.restore()
        }

        const shadowRadius = orbRadius * 1.15
        const shadowY = y + orbRadius * 0.35
        const shadow = overlayContext.createRadialGradient(x, shadowY, orbRadius * 0.3, x, shadowY, shadowRadius)
        shadow.addColorStop(0, `rgba(4,3,10,${Math.min(0.40, alpha * 0.45)})`)
        shadow.addColorStop(0.5, `rgba(6,4,14,${Math.min(0.18, alpha * 0.20)})`)
        shadow.addColorStop(1, 'rgba(8,6,16,0)')
        overlayContext.beginPath()
        overlayContext.ellipse(x, shadowY, shadowRadius, shadowRadius * 0.45, 0, 0, Math.PI * 2)
        overlayContext.fillStyle = shadow
        overlayContext.fill()

        overlayContext.save()
        overlayContext.beginPath()
        overlayContext.arc(x, y, orbRadius, 0, Math.PI * 2)
        overlayContext.closePath()
        overlayContext.clip()

        const baseFill = overlayContext.createRadialGradient(x, y, 0, x, y, orbRadius)
        baseFill.addColorStop(0, `rgba(${Math.min(255, Math.floor(red * 0.45 + 180 * 0.55))},${Math.min(255, Math.floor(green * 0.45 + 170 * 0.55))},${Math.min(255, Math.floor(blue * 0.45 + 210 * 0.55))},${Math.min(0.70, alpha * 0.72)})`)
        baseFill.addColorStop(0.7, `rgba(${Math.floor(red * 0.6 + 80 * 0.4)},${Math.floor(green * 0.6 + 70 * 0.4)},${Math.floor(blue * 0.6 + 120 * 0.4)},${Math.min(0.55, alpha * 0.58)})`)
        baseFill.addColorStop(1, `rgba(${Math.floor(red * 0.45 + 30 * 0.55)},${Math.floor(green * 0.45 + 20 * 0.55)},${Math.floor(blue * 0.45 + 50 * 0.55)},${Math.min(0.38, alpha * 0.40)})`)
        overlayContext.fillStyle = baseFill
        overlayContext.fill()

        const innerGlow = overlayContext.createRadialGradient(x - orbRadius * 0.20, y - orbRadius * 0.25, 0, x, y, orbRadius * 0.95)
        innerGlow.addColorStop(0, `rgba(255,250,245,${Math.min(0.85, alpha * 0.90)})`)
        innerGlow.addColorStop(0.20, `rgba(245,230,240,${Math.min(0.55, alpha * 0.60)})`)
        innerGlow.addColorStop(0.50, `rgba(${Math.floor(red * 0.4 + 200 * 0.6)},${Math.floor(green * 0.4 + 185 * 0.6)},${Math.floor(blue * 0.4 + 220 * 0.6)},${Math.min(0.28, alpha * 0.30)})`)
        innerGlow.addColorStop(1, 'rgba(120,105,165,0)')
        overlayContext.fillStyle = innerGlow
        overlayContext.fillRect(x - orbRadius, y - orbRadius, orbRadius * 2, orbRadius * 2)

        const bottomShadow = overlayContext.createRadialGradient(x + orbRadius * 0.10, y + orbRadius * 0.35, 0, x, y, orbRadius)
        bottomShadow.addColorStop(0, `rgba(12,8,28,${Math.min(0.50, alpha * 0.52)})`)
        bottomShadow.addColorStop(0.4, `rgba(18,12,38,${Math.min(0.25, alpha * 0.28)})`)
        bottomShadow.addColorStop(0.75, `rgba(25,18,50,${Math.min(0.10, alpha * 0.12)})`)
        bottomShadow.addColorStop(1, 'rgba(30,22,55,0)')
        overlayContext.fillStyle = bottomShadow
        overlayContext.fillRect(x - orbRadius, y - orbRadius, orbRadius * 2, orbRadius * 2)

        const secondaryShadow = overlayContext.createRadialGradient(x + orbRadius * 0.25, y + orbRadius * 0.40, 0, x + orbRadius * 0.15, y + orbRadius * 0.25, orbRadius * 0.9)
        secondaryShadow.addColorStop(0, `rgba(8,5,20,${Math.min(0.30, alpha * 0.32)})`)
        secondaryShadow.addColorStop(0.6, `rgba(15,10,30,${Math.min(0.10, alpha * 0.12)})`)
        secondaryShadow.addColorStop(1, 'rgba(20,15,35,0)')
        overlayContext.fillStyle = secondaryShadow
        overlayContext.fillRect(x - orbRadius, y - orbRadius, orbRadius * 2, orbRadius * 2)

        const rimLight = overlayContext.createRadialGradient(x - orbRadius * 0.55, y - orbRadius * 0.45, orbRadius * 0.15, x - orbRadius * 0.55, y - orbRadius * 0.45, orbRadius * 0.85)
        rimLight.addColorStop(0, `rgba(240,235,255,${Math.min(0.35, alpha * 0.38)})`)
        rimLight.addColorStop(0.4, `rgba(210,200,240,${Math.min(0.14, alpha * 0.16)})`)
        rimLight.addColorStop(1, 'rgba(180,170,220,0)')
        overlayContext.fillStyle = rimLight
        overlayContext.fillRect(x - orbRadius, y - orbRadius, orbRadius * 2, orbRadius * 2)

        const bottomRim = overlayContext.createRadialGradient(x + orbRadius * 0.30, y + orbRadius * 0.50, orbRadius * 0.05, x + orbRadius * 0.30, y + orbRadius * 0.50, orbRadius * 0.65)
        bottomRim.addColorStop(0, `rgba(${Math.min(255, red + 80)},${Math.min(255, green + 60)},${Math.min(255, blue + 40)},${Math.min(0.18, alpha * 0.20)})`)
        bottomRim.addColorStop(0.5, `rgba(${Math.min(255, red + 40)},${Math.min(255, green + 30)},${Math.min(255, blue + 20)},${Math.min(0.06, alpha * 0.07)})`)
        bottomRim.addColorStop(1, 'rgba(120,100,80,0)')
        overlayContext.fillStyle = bottomRim
        overlayContext.fillRect(x - orbRadius, y - orbRadius, orbRadius * 2, orbRadius * 2)

        overlayContext.restore()

        overlayContext.beginPath()
        overlayContext.arc(x, y, orbRadius + 2, 0, Math.PI * 2)
        overlayContext.strokeStyle = `rgba(${Math.min(255, Math.floor(red * 0.5 + 180 * 0.5))},${Math.min(255, Math.floor(green * 0.5 + 170 * 0.5))},${Math.min(255, Math.floor(blue * 0.5 + 210 * 0.5))},${Math.min(0.22, alpha * 0.25)})`
        overlayContext.lineWidth = 2.5
        overlayContext.stroke()

        overlayContext.beginPath()
        overlayContext.arc(x, y, orbRadius, 0, Math.PI * 2)
        overlayContext.strokeStyle = `rgba(235,228,255,${Math.min(0.35, alpha * 0.38)})`
        overlayContext.lineWidth = 0.8
        overlayContext.stroke()

        const highlight = overlayContext.createRadialGradient(x - orbRadius * 0.28, y - orbRadius * 0.32, 0, x - orbRadius * 0.28, y - orbRadius * 0.32, orbRadius * 0.38)
        highlight.addColorStop(0, `rgba(255,253,250,${Math.min(0.65, alpha * 0.70)})`)
        highlight.addColorStop(0.30, `rgba(248,242,252,${Math.min(0.30, alpha * 0.33)})`)
        highlight.addColorStop(0.65, `rgba(235,228,248,${Math.min(0.08, alpha * 0.10)})`)
        highlight.addColorStop(1, 'rgba(220,215,240,0)')
        overlayContext.beginPath()
        overlayContext.arc(x - orbRadius * 0.28, y - orbRadius * 0.32, orbRadius * 0.38, 0, Math.PI * 2)
        overlayContext.fillStyle = highlight
        overlayContext.fill()

        const sparkle = overlayContext.createRadialGradient(x - orbRadius * 0.18, y - orbRadius * 0.22, 0, x - orbRadius * 0.18, y - orbRadius * 0.22, orbRadius * 0.12)
        sparkle.addColorStop(0, `rgba(255,255,255,${Math.min(0.80, alpha * 0.85)})`)
        sparkle.addColorStop(0.5, `rgba(255,252,255,${Math.min(0.25, alpha * 0.28)})`)
        sparkle.addColorStop(1, 'rgba(240,235,250,0)')
        overlayContext.beginPath()
        overlayContext.arc(x - orbRadius * 0.18, y - orbRadius * 0.22, orbRadius * 0.12, 0, Math.PI * 2)
        overlayContext.fillStyle = sparkle
        overlayContext.fill()
      }

      const hazeA = overlayContext.createRadialGradient(viewportWidth * 0.5, viewportHeight * 0.48, 0, viewportWidth * 0.5, viewportHeight * 0.48, viewportWidth * 0.5)
      hazeA.addColorStop(0, 'rgba(45,35,48,0.018)')
      hazeA.addColorStop(0.35, 'rgba(35,28,38,0.010)')
      hazeA.addColorStop(0.7, 'rgba(22,18,28,0.004)')
      hazeA.addColorStop(1, 'rgba(12,10,16,0)')
      overlayContext.beginPath()
      overlayContext.rect(0, 0, viewportWidth, viewportHeight)
      overlayContext.fillStyle = hazeA
      overlayContext.fill()

      const midY = viewportHeight * 0.52
      const hazeB = overlayContext.createLinearGradient(0, midY - viewportHeight * 0.12, 0, midY + viewportHeight * 0.12)
      hazeB.addColorStop(0, 'rgba(18,16,24,0)')
      hazeB.addColorStop(0.3, 'rgba(28,22,30,0.008)')
      hazeB.addColorStop(0.5, 'rgba(32,26,34,0.012)')
      hazeB.addColorStop(0.7, 'rgba(28,22,30,0.008)')
      hazeB.addColorStop(1, 'rgba(18,16,24,0)')
      overlayContext.beginPath()
      overlayContext.rect(0, midY - viewportHeight * 0.12, viewportWidth, viewportHeight * 0.24)
      overlayContext.fillStyle = hazeB
      overlayContext.fill()

      const hazeC = overlayContext.createLinearGradient(0, viewportHeight * 0.65, 0, viewportHeight)
      hazeC.addColorStop(0, 'rgba(6,5,10,0)')
      hazeC.addColorStop(0.6, 'rgba(6,5,10,0.008)')
      hazeC.addColorStop(1, 'rgba(6,5,10,0.016)')
      overlayContext.beginPath()
      overlayContext.rect(0, viewportHeight * 0.65, viewportWidth, viewportHeight * 0.35)
      overlayContext.fillStyle = hazeC
      overlayContext.fill()

      const hazeD = overlayContext.createLinearGradient(0, 0, 0, viewportHeight * 0.30)
      hazeD.addColorStop(0, 'rgba(5,4,8,0.012)')
      hazeD.addColorStop(0.5, 'rgba(5,4,8,0.005)')
      hazeD.addColorStop(1, 'rgba(5,4,8,0)')
      overlayContext.beginPath()
      overlayContext.rect(0, 0, viewportWidth, viewportHeight * 0.30)
      overlayContext.fillStyle = hazeD
      overlayContext.fill()

      const pulse = Math.sin(time * 0.15) * 0.002 + 0.012
      const hazeE = overlayContext.createRadialGradient(viewportWidth * 0.5, viewportHeight * 0.52, 0, viewportWidth * 0.5, viewportHeight * 0.52, viewportWidth * 0.22)
      hazeE.addColorStop(0, `rgba(55,40,50,${pulse})`)
      hazeE.addColorStop(0.5, `rgba(50,32,85,${pulse * 0.4})`)
      hazeE.addColorStop(1, 'rgba(30,20,55,0)')
      overlayContext.beginPath()
      overlayContext.rect(0, 0, viewportWidth, viewportHeight)
      overlayContext.fillStyle = hazeE
      overlayContext.fill()

      const detailElement = detailRef.current
      const selectedPosition = selectedIdRef.current ? positions[selectedIdRef.current] : null
      if (detailElement && selectedPosition?.visible) {
        const { left, top } = getDetailPanelPosition({
          anchorX: selectedPosition.x,
          anchorY: selectedPosition.y,
          boxWidth: detailElement.offsetWidth || 260,
          boxHeight: detailElement.offsetHeight || 140,
          viewportWidth,
          viewportHeight,
        })

        detailElement.style.left = `${left}px`
        detailElement.style.top = `${top}px`
      }

      const hoverElement = hoverLabelRef.current
      const hoveredPosition = hoveredIdRef.current ? positions[hoveredIdRef.current] : null
      if (hoverElement && hoveredPosition?.visible && hoveredIdRef.current !== selectedIdRef.current) {
        const { left, top } = getHoverLabelPosition({
          anchorX: hoveredPosition.x,
          anchorY: hoveredPosition.y,
          boxWidth: hoverElement.offsetWidth || 220,
          boxHeight: hoverElement.offsetHeight || 54,
          viewportWidth,
          viewportHeight,
        })

        hoverElement.style.left = `${left}px`
        hoverElement.style.top = `${top}px`
      }
    }

    let staticMode = false

    function renderFrame(now: number) {
      const time = now / 1000
      smoothPointerX += (pointerX - smoothPointerX) * 0.025
      smoothPointerY += (pointerY - smoothPointerY) * 0.025

      const deltaSeconds = Math.min(0.05, lastFrameTime > 0 ? (now - lastFrameTime) * 0.001 : 0.016)
      lastFrameTime = now
      nextCometSpawn -= deltaSeconds
      const maxCometsForTier = tierRef.current === 1 ? 0 : tierRef.current === 2 ? 2 : MAX_COMETS
      if (nextCometSpawn <= 0 && comets.length < maxCometsForTier) {
        spawnComet()
        nextCometSpawn = 2.5 + Math.random() * 5
      }
      updateComets(deltaSeconds)
      updateMemoryUniforms()

      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
      gl.enableVertexAttribArray(positionAttribute)
      gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0)

      if (uTimeLocation !== null) gl.uniform1f(uTimeLocation, time)
      if (uResolutionLocation !== null) gl.uniform2f(uResolutionLocation, poolCanvas.width, poolCanvas.height)
      if (uMouseLocation !== null) gl.uniform2f(uMouseLocation, smoothPointerX, smoothPointerY)
      if (uCameraLocation !== null) gl.uniform3f(uCameraLocation, CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2])
      if (uTargetLocation !== null) gl.uniform3f(uTargetLocation, CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2])
      if (uFovLocation !== null) gl.uniform1f(uFovLocation, CAMERA_FOV)
      if (uMemLocation !== null) gl.uniform4fv(uMemLocation, memUniformData)
      if (uMemColorLocation !== null) gl.uniform3fv(uMemColorLocation, memColorUniformData)
      if (uCometLocation !== null) gl.uniform4fv(uCometLocation, cometUniformData)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      drawOverlay(time)
      if (!staticMode) {
        animationFrame = window.requestAnimationFrame(renderFrame)
      }
    }

    staticSceneRenderRef.current = null

    function handlePointerMove(event: PointerEvent) {
      pointerX = clamp(event.clientX / Math.max(viewportWidth, 1), 0, 1)
      pointerY = clamp(event.clientY / Math.max(viewportHeight, 1), 0, 1)
    }

    resize()

    if (prefersReducedMotion || tierRef.current === 1) {
      staticMode = true
      staticSceneRenderRef.current = () => renderFrame(performance.now())
      renderFrame(performance.now())
    } else {
      animationFrame = window.requestAnimationFrame(renderFrame)
    }

    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', handlePointerMove)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', handlePointerMove)
      positionsRef.current = {}
      staticSceneRenderRef.current = null
      gl.deleteBuffer(quadBuffer)
      gl.deleteProgram(program)
    }
  }, [showInteractiveScene, prefersReducedMotion])

  useEffect(() => {
    if (!showInteractiveScene || (!prefersReducedMotion && visualTier !== 1)) {
      return
    }

    staticSceneRenderRef.current?.()
  }, [constellationEntries, hoveredId, prefersReducedMotion, selectedId, showInteractiveScene, visualTier])

  useEffect(() => {
    if (!showInteractiveScene) {
      return
    }

    const hitCanvas = hitCanvasRef.current
    if (!hitCanvas) {
      return
    }

    function resolveHoveredEntry(clientX: number, clientY: number): string | null {
      let hoveredEntryId: string | null = null

      for (const [entryId, position] of Object.entries(positionsRef.current)) {
        if (!position.visible) {
          continue
        }

        const dx = clientX - position.x
        const dy = clientY - position.y
        if (dx * dx + dy * dy <= Math.max(HIT_RADIUS, position.radius + 10) ** 2) {
          hoveredEntryId = entryId
          break
        }
      }

      return hoveredEntryId
    }

    const handlePointerMove = (event: PointerEvent) => {
      const hoveredEntryId = resolveHoveredEntry(event.clientX, event.clientY)
      hitCanvas.style.cursor = hoveredEntryId ? 'pointer' : 'default'
      if (hoveredIdRef.current === hoveredEntryId) {
        return
      }

      hoveredIdRef.current = hoveredEntryId
      setHoveredId(hoveredEntryId)
    }

    const handlePointerLeave = () => {
      hitCanvas.style.cursor = 'default'
      hoveredIdRef.current = null
      setHoveredId(null)
    }

    const handleClick = (event: PointerEvent) => {
      const hoveredEntryId = resolveHoveredEntry(event.clientX, event.clientY)
      if (!hoveredEntryId) {
        setSelectedId(null)
        return
      }

      haptic('light')
      setSelectedId(hoveredEntryId)
    }

    hitCanvas.addEventListener('pointermove', handlePointerMove)
    hitCanvas.addEventListener('pointerleave', handlePointerLeave)
    hitCanvas.addEventListener('click', handleClick)

    return () => {
      hitCanvas.removeEventListener('pointermove', handlePointerMove)
      hitCanvas.removeEventListener('pointerleave', handlePointerLeave)
      hitCanvas.removeEventListener('click', handleClick)
      hitCanvas.style.cursor = 'default'
    }
  }, [showInteractiveScene])

  const hoveredEntry = hoveredId
    ? constellationEntries.find((entry) => entry.id === hoveredId) ?? null
    : null

  const visibleCount = visibleEntries.length
  const totalCount = sceneEntries.length
  const showOrbHint =
    !selectedId && !hoveredId && constellationEntries.length > 0 && visibleCount > 0
  const hasActiveNarrowing = activeFilter !== 'all' || activePeriod !== 'all' || deferredSearchQuery.trim().length > 0

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.overlayState}>
          <div className={styles.stateAtmosphere} aria-hidden="true">
            <span className={classNames(styles.stateAtmosphereOrb, styles.stateAtmosphereOrbA)} />
            <span className={classNames(styles.stateAtmosphereOrb, styles.stateAtmosphereOrbB)} />
            <span className={classNames(styles.stateAtmosphereOrb, styles.stateAtmosphereOrbC)} />
          </div>
          <div className={styles.stateIcon}><Loader2 className={styles.spinner} /></div>
          <h1 className={styles.stateTitle}>Loading journal</h1>
          <p className={styles.stateText}>Bringing Sophia&apos;s memory pool into view.</p>
          <div className={styles.stateSkeleton} aria-hidden="true">
            <span className={classNames(styles.stateSkeletonLine, styles.stateSkeletonLineWide)} />
            <span className={styles.stateSkeletonLine} />
            <span className={classNames(styles.stateSkeletonLine, styles.stateSkeletonLineShort)} />
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.overlayState}>
          <div className={styles.stateIcon}><Home className={styles.stateGlyph} /></div>
          <h1 className={styles.stateTitle}>Journal unavailable</h1>
          <p className={styles.stateText}>{error}</p>
          <div className={styles.overlayActions}>
            <button className={styles.primaryAction} onClick={() => window.location.reload()}>
              Try again
            </button>
            <button className={styles.secondaryAction} onClick={() => router.push('/')}>
              Return home
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (totalCount === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.overlayState}>
          <div className={styles.stateIcon}><LayoutGrid className={styles.stateGlyph} /></div>
          <h1 className={styles.stateTitle}>No saved memories yet</h1>
          <p className={styles.stateText}>After a session recap, the memories you keep will appear here.</p>
          <div className={styles.overlayActions}>
            <button className={styles.primaryAction} onClick={() => router.push('/')}>
              Start a session
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <canvas ref={poolCanvasRef} className={classNames(styles.canvasLayer, styles.canvasLayerIntro, styles.poolCanvas)} />
      <canvas ref={overlayCanvasRef} className={classNames(styles.canvasLayer, styles.canvasLayerIntro, styles.overlayCanvas)} />
      <canvas ref={hitCanvasRef} className={classNames(styles.canvasLayer, styles.canvasLayerIntro, styles.hitCanvas)} />

      <div className={classNames(styles.uiLayer, styles.uiLayerIntro)}>
        <header className={styles.header}>
          <button type="button" className={styles.homeButton} onClick={() => router.push('/')} aria-label="Go home">
            <Home className={styles.homeIcon} />
          </button>

          <div className={styles.titleBlock}>
            <h1 className={styles.title}>Journal</h1>
            <p className={styles.titleSub}>
              <span className={styles.titleDot} />
              {buildTimelineCount(totalCount)}
              {favoriteCount > 0 ? ` · ${favoriteCount} favorites` : ''}
              {isRefreshing ? <span className={styles.refreshBadge}>syncing</span> : null}
            </p>
          </div>

          <div className={styles.searchBar}>
            <Search className={styles.searchIcon} />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className={styles.searchInput}
              placeholder="Search memories..."
              spellCheck={false}
            />
            <span className={styles.keyboardHint}>Ctrl K</span>
          </div>

          <div className={styles.collectionToggle}>
            <button
              type="button"
              className={classNames(styles.collectionButton, activeCollection === 'all' && styles.collectionButtonActive)}
              onClick={() => {
                haptic('selection')
                setActiveCollection('all')
              }}
            >
              All
            </button>
            <button
              type="button"
              className={classNames(styles.collectionButton, activeCollection === 'favorites' && styles.collectionButtonActive)}
              onClick={() => {
                haptic('selection')
                setActiveCollection('favorites')
              }}
            >
              Favorites
            </button>
          </div>

          <div className={styles.menuControl}>
            <button
              ref={typeButtonRef}
              type="button"
              className={classNames(styles.menuButton, activeFilter !== 'all' && styles.menuButtonActive)}
              onClick={() => setTypeMenuOpen((current) => !current)}
              aria-haspopup="listbox"
              aria-expanded={typeMenuOpen}
            >
              <span className={styles.menuButtonLabel}>Type</span>
              <span className={styles.menuButtonValue}>
                {activeFilter === 'all' ? 'All' : getJournalCategoryPresentation(activeFilter).label}
              </span>
              <ChevronDown className={styles.menuChevron} />
            </button>
            <div
              ref={typeMenuRef}
              role="listbox"
              className={classNames(styles.menuDropdown, typeMenuOpen && styles.menuDropdownOpen)}
            >
              <button
                type="button"
                role="option"
                aria-selected={activeFilter === 'all'}
                className={classNames(styles.menuOption, activeFilter === 'all' && styles.menuOptionActive)}
                onClick={() => {
                  haptic('selection')
                  setActiveFilter('all')
                  setTypeMenuOpen(false)
                }}
              >
                All types
              </button>
              {JOURNAL_CATEGORIES.map((category) => {
                const presentation = getJournalCategoryPresentation(category)
                const selected = activeFilter === category
                return (
                  <button
                    key={category}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={classNames(styles.menuOption, selected && styles.menuOptionActive)}
                    onClick={() => {
                      haptic('selection')
                      setActiveFilter(category)
                      setTypeMenuOpen(false)
                    }}
                  >
                    <span className={styles.menuOptionDot} style={{ background: presentation.color }} />
                    {presentation.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className={styles.menuControl}>
            <button
              ref={periodButtonRef}
              type="button"
              className={classNames(styles.menuButton, activePeriod !== 'all' && styles.menuButtonActive)}
              onClick={() => setPeriodMenuOpen((current) => !current)}
              aria-haspopup="listbox"
              aria-expanded={periodMenuOpen}
            >
              <span className={styles.menuButtonLabel}>Period</span>
              <span className={styles.menuButtonValue}>{getPeriodLabel(activePeriod)}</span>
              <ChevronDown className={styles.menuChevron} />
            </button>
            <div
              ref={periodMenuRef}
              role="listbox"
              className={classNames(styles.menuDropdown, periodMenuOpen && styles.menuDropdownOpen)}
            >
              {(['all', 'month', 'week', 'today'] as JournalPeriod[]).map((period) => (
                <button
                  key={period}
                  type="button"
                  role="option"
                  aria-selected={activePeriod === period}
                  className={classNames(styles.menuOption, activePeriod === period && styles.menuOptionActive)}
                  onClick={() => {
                    haptic('selection')
                    setActivePeriod(period)
                    setPeriodMenuOpen(false)
                  }}
                >
                  {getPeriodLabel(period)}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.filterMeta}>{buildTimelineCount(visibleCount)}</div>
        </header>

          <div className={styles.timeline}>
            <div className={styles.timelineHeader}>
              <span className={styles.timelineEyebrow}>Timeline</span>
              <div className={styles.timelineDate}>
                <span>{timelineLabel}</span>
                <span className={styles.timelineCount}>{buildTimelineCount(visibleCount)}</span>
                <span
                  className={classNames(
                    styles.timelineHint,
                    timelineAnchoredToNearest && styles.timelineHintActive,
                    effectiveTimelinePosition !== maxTimelineDays && !timelineAnchoredToNearest && styles.timelineHintMuted,
                  )}
                >
                  {timelineAnchoredToNearest ? 'anchored to nearest memories' : 'drag to explore'}
                </span>
              </div>
          </div>
          <div className={styles.timelineTrack}>
            <div className={styles.timelineBar} />
            <div className={styles.timelineFill} style={{ width: `${maxTimelineDays === 0 ? 100 : (effectiveTimelinePosition / maxTimelineDays) * 100}%` }} />
            {sceneEntries.map((entry) => {
              const visible = visibleIdsRef.current.has(entry.id)
              return (
                <span
                  key={entry.id}
                  className={classNames(styles.timelineDot, visible && styles.timelineDotVisible)}
                  style={{ left: `${maxTimelineDays === 0 ? 100 : (entry.timelinePosition / maxTimelineDays) * 100}%` }}
                />
              )
            })}
            <input
              className={styles.timelineRange}
              type="range"
              min={0}
              max={maxTimelineDays}
              value={effectiveTimelinePosition}
              onChange={(event) => setTimelinePosition(Number(event.target.value))}
              aria-label="Journal timeline"
            />
            <div className={styles.timelineHandle} style={{ left: `${maxTimelineDays === 0 ? 100 : (effectiveTimelinePosition / maxTimelineDays) * 100}%` }} />
          </div>
          <div className={styles.timelineMonths}>
            {monthMarkers.map((marker) => (
              <button
                key={`${marker.label}-${marker.daysAgo}`}
                type="button"
                className={classNames(styles.timelineMonth, Math.abs(marker.timelinePosition - effectiveTimelinePosition) < 14 && styles.timelineMonthActive)}
                onClick={() => setTimelinePosition(marker.timelinePosition)}
              >
                {marker.label}
              </button>
            ))}
          </div>
        </div>

        <div className={classNames(styles.orbHint, !showOrbHint && styles.orbHintHidden)}>Click a memory to explore</div>

        {totalCount > 0 && visibleCount === 0 && (
          <div className={styles.sceneEmptyHint}>
            {activeCollection === 'favorites'
              ? 'No favorites yet. Star a memory to keep it close.'
              : hasActiveNarrowing
                ? 'No memories match these filters.'
                : 'No memories at this point in time.'}
          </div>
        )}

        <div
          ref={hoverLabelRef}
          className={classNames(styles.hoverLabel, hoveredEntry && hoveredEntry.id !== selectedId && styles.hoverLabelVisible)}
        >
          {hoveredEntry && hoveredEntry.id !== selectedId && (
            <>
              <span
                className={styles.hoverLabelCategory}
                style={{ background: hoveredEntry.presentation.pillBackground, color: hoveredEntry.presentation.color }}
              >
                {hoveredEntry.presentation.shortLabel}
              </span>
              {hoveredEntry.content}
            </>
          )}
        </div>

        <div
          ref={detailRef}
          className={classNames(styles.detailPanel, showDetailPanel && styles.detailPanelVisible, editingId === selectedEntry?.id && styles.detailPanelEditing)}
          style={selectedEntry ? { ['--detail-accent' as string]: selectedEntry.presentation.color } : undefined}
        >
          {selectedEntry && (
            <>
              <div className={styles.detailHeader}>
                <div className={styles.detailHeaderMeta}>
                  <span
                    className={styles.detailBadge}
                    style={{ background: selectedEntry.presentation.pillBackground, color: selectedEntry.presentation.color }}
                  >
                    {selectedEntry.presentation.shortLabel}
                  </span>
                  {selectedIsFavorite && (
                    <span className={styles.favoriteBadge}>
                      <Star className={styles.favoriteBadgeIcon} fill="currentColor" />
                      Favorite
                    </span>
                  )}
                  {selectedImportance && (
                    <span className={styles.importanceBadge}>
                      <span className={styles.importanceDot} style={{ background: selectedImportance.color, boxShadow: `0 0 10px ${selectedImportance.glow}` }} />
                      {selectedImportance.label}
                    </span>
                  )}
                </div>
                <button type="button" className={styles.detailClose} onClick={() => setSelectedId(null)} aria-label="Close memory detail">
                  ×
                </button>
              </div>
              <div className={styles.detailDate}>{selectedEntry.displayDate}</div>
              {editingId === selectedEntry.id ? (
                <textarea
                  className={styles.detailTextarea}
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  rows={5}
                  aria-label="Edit memory"
                />
              ) : (
                <div className={styles.detailText}>{selectedEntry.content}</div>
              )}
              <div className={styles.detailActions}>
                {editingId === selectedEntry.id ? (
                  <>
                    <button
                      type="button"
                      className={classNames(styles.detailActionButton, styles.detailActionSecondary)}
                      onClick={cancelEditingEntry}
                      disabled={pendingEntryAction?.id === selectedEntry.id}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={classNames(styles.detailActionButton, styles.detailActionPrimary)}
                      onClick={() => void persistEntryEdit(selectedEntry)}
                      disabled={pendingEntryAction?.id === selectedEntry.id || draftText.trim().length === 0}
                    >
                      {pendingEntryAction?.id === selectedEntry.id && pendingEntryAction.kind === 'save' ? <Loader2 className={styles.actionSpinner} /> : <Check className={styles.actionIcon} />}
                      Save
                    </button>
                  </>
                ) : deleteConfirmId === selectedEntry.id ? (
                  renderDeleteConfirm(selectedEntry)
                ) : (
                  <>
                    <button
                      type="button"
                      className={classNames(
                        styles.detailActionButton,
                        styles.detailActionFavorite,
                        selectedIsFavorite && styles.detailActionFavoriteActive,
                      )}
                      onClick={() => void toggleFavoriteEntry(selectedEntry)}
                      disabled={pendingEntryAction?.id === selectedEntry.id}
                      aria-pressed={selectedIsFavorite}
                    >
                      {pendingEntryAction?.id === selectedEntry.id && pendingEntryAction.kind === 'favorite'
                        ? <Loader2 className={styles.actionSpinner} />
                        : <Star className={styles.actionIcon} fill={selectedIsFavorite ? 'currentColor' : 'none'} />}
                      {selectedIsFavorite ? 'Favorited' : 'Favorite'}
                    </button>
                    <button
                      type="button"
                      className={classNames(styles.detailActionButton, styles.detailActionSecondary)}
                      onClick={() => beginEditingEntry(selectedEntry)}
                      disabled={pendingEntryAction?.id === selectedEntry.id}
                    >
                      <Pencil className={styles.actionIcon} />
                      Edit
                    </button>
                    <button
                      type="button"
                      className={classNames(styles.detailActionButton, styles.detailActionDanger)}
                      onClick={() => requestDeleteEntry(selectedEntry)}
                      disabled={pendingEntryAction?.id === selectedEntry.id}
                    >
                      {pendingEntryAction?.id === selectedEntry.id && pendingEntryAction.kind === 'delete' ? <Loader2 className={styles.actionSpinner} /> : <Trash2 className={styles.actionIcon} />}
                      Delete
                    </button>
                  </>
                )}
              </div>
              {entryActionError && (editingId === selectedEntry.id || deleteConfirmId === selectedEntry.id) && (
                <div className={styles.detailError}>
                  <AlertCircle className={styles.detailErrorIcon} />
                  {entryActionError}
                </div>
              )}
              <div className={styles.detailDivider} />
              <div className={styles.detailTags}>
                <span className={styles.detailTag}>{selectedEntry.presentation.label}</span>
                {selectedIsFavorite && <span className={styles.detailTag}>Favorite</span>}
                {selectedEntry.originalMemoryId && <span className={styles.detailTag}>Saved from recap</span>}
                {selectedImportance && <span className={styles.detailTag}>{selectedImportance.label}</span>}
                {getJournalStatus(selectedEntry) && <span className={styles.detailTag}>{getJournalStatus(selectedEntry)}</span>}
              </div>
              <div className={styles.detailSession}>
                {typeof selectedEntry.metadata?.session_type === 'string'
                  ? `From ${selectedEntry.metadata.session_type} session`
                  : 'Stored in Sophia journal'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}