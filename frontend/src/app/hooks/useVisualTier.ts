/**
 * useVisualTier — adaptive visual quality system with 3 tiers.
 *
 * Tier 3 (full):    Desktop with dedicated GPU, 8+ cores
 * Tier 2 (medium):  Laptop/tablet, 4-8 cores, or integrated GPU
 * Tier 1 (low):     Phones, software GPUs, <4 cores, reduced-motion,
 *                   battery saver, or user override
 *
 * Features:
 *  - Static detection (cores, viewport, pointer/hover, UA, GPU renderer, memory)
 *  - Phones are pinned to tier 1 in auto mode (modern phones can score high on
 *    cores/GPU and still stutter at tier 2 — user can opt up explicitly)
 *  - Runtime frame-budget monitor with tighter thresholds on phones, can
 *    degrade multiple steps (3 → 2 → 1) if frame budget keeps failing
 *  - Lower dprCap on phones, plus an extra shave when tier 1 auto-degrades
 *  - User preference override persisted in localStorage
 *  - Sets `data-visual-tier` on <html> for CSS-only adaptations
 *  - Backward-compatible: re-exports DeviceFidelity fields
 */

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VisualTierLevel = 1 | 2 | 3

export type VisualTierPreference = 'auto' | 'full' | 'balanced' | 'low'

export interface VisualTier {
  /** Current effective tier (1 = low, 2 = medium, 3 = full) */
  tier: VisualTierLevel
  /** Whether the tier was auto-degraded at runtime due to frame drops */
  autoDegraded: boolean
  /** User preference if set, otherwise 'auto' */
  preference: VisualTierPreference
  /** True when tier ≤ 2 (convenience for existing consumers) */
  reducedFidelity: boolean
  /** True when user OS prefers reduced motion */
  reducedMotion: boolean
  /** Device pixel ratio cap based on tier */
  dprCap: number
  /** Update the user preference (persists to localStorage) */
  setPreference: (pref: VisualTierPreference) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'sophia-visual-tier-pref'
const RUNTIME_KEY = 'sophia-visual-tier-runtime'
const RUNTIME_TTL_MS = 24 * 60 * 60 * 1000 // 24 h
const FRAME_BUDGET_MS = 22 // ~45 fps threshold — phones can coast at 40 fps and feel fine
const DEGRADE_WINDOW_FRAMES = 90 // ~1.5s at 60 fps — react faster
const DEGRADE_WINDOW_FRAMES_PHONE = 60 // ~1s at 60 fps — react even faster on phones
const DEGRADE_THRESHOLD_RATIO = 0.3 // 30% over budget → degrade (was 40%)
const DEGRADE_THRESHOLD_RATIO_PHONE = 0.22 // 22% over budget → degrade on phones
const PROMOTE_CLEAN_WINDOWS = 3 // consecutive clean windows before promoting
const PROMOTE_MAX_OVER_BUDGET_RATIO = 0.05 // ≤5% over-budget frames = "clean"
const TIER_TRANSITION_COOLDOWN_MS = 5000 // 5s between any two tier transitions
const MAX_DEGRADE_STEPS = 2 // tier 3 → 2 → 1 in two successive drops
const HTML_ATTR = 'data-visual-tier'

// ---------------------------------------------------------------------------
// Static detection (runs once)
// ---------------------------------------------------------------------------

interface StaticSignals {
  cores: number
  isNarrow: boolean
  isPhone: boolean
  reducedMotion: boolean
  lowMemory: boolean
  gpuTier: 'low' | 'mid' | 'high' | 'unknown'
  dpr: number
  /** `navigator.connection.saveData` — explicit data-saver opt-in. */
  saveData: boolean
  /** `navigator.connection.effectiveType` ∈ {'slow-2g','2g','3g'} → slow. */
  slowNetwork: boolean
}

let _cachedGpuTier: StaticSignals['gpuTier'] | null = null

function detectGpuTier(): 'low' | 'mid' | 'high' | 'unknown' {
  if (_cachedGpuTier != null) return _cachedGpuTier
  if (typeof document === 'undefined') return 'unknown'

  let gl: WebGLRenderingContext | null = null

  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    gl = (canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
      stencil: false,
    }) ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl || !(gl instanceof WebGLRenderingContext)) return 'unknown'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (!ext) return 'unknown'
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string
    const lower = renderer.toLowerCase()

    // Known low-end indicators
    if (/swiftshader|llvmpipe|softpipe|google\s?swiftshader|mesa/.test(lower)) {
      _cachedGpuTier = 'low'
      return _cachedGpuTier
    }
    if (/intel.*hd|intel.*uhd|intel.*iris|mali-[gt][1-5]\d\d|adreno\s?[1-5]\d\d/i.test(lower)) {
      _cachedGpuTier = 'mid'
      return _cachedGpuTier
    }
    if (/nvidia|radeon|geforce|apple\s?gpu|apple\s?m[1-9]|intel\s?arc|adreno\s?[67]\d\d|mali-g[67]\d\d/i.test(lower)) {
      _cachedGpuTier = 'high'
      return _cachedGpuTier
    }

    _cachedGpuTier = 'mid'
    return _cachedGpuTier
  } catch {
    _cachedGpuTier = 'unknown'
    return _cachedGpuTier
  } finally {
    const loseContext = gl?.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null
    loseContext?.loseContext()
  }
}

function detectStatic(): StaticSignals {
  if (typeof window === 'undefined') {
    return {
      cores: 4, isNarrow: false, isPhone: false, reducedMotion: false, lowMemory: false,
      gpuTier: 'unknown', dpr: 1, saveData: false, slowNetwork: false,
    }
  }

  const cores = navigator.hardwareConcurrency ?? 4
  const isNarrow = window.innerWidth < 768
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  const noHover = window.matchMedia('(hover: none)').matches
  const uaMobile = /android|iphone|ipod|iemobile|blackberry|bb10|mini|windows\sce|palm/i.test(navigator.userAgent ?? '')
  // Treat as phone when at least two mobile signals agree, OR UA is explicitly mobile,
  // OR viewport is narrow AND input is touch-only. This catches modern 8-core phones
  // that would otherwise score into tier 2 purely on CPU count.
  const mobileSignals = (isNarrow ? 1 : 0) + (coarsePointer ? 1 : 0) + (noHover ? 1 : 0)
  const isPhone = uaMobile || mobileSignals >= 2
  const mem = (navigator as { deviceMemory?: number }).deviceMemory
  const lowMemory = mem != null && mem < 4
  const gpuTier = detectGpuTier()
  const dpr = window.devicePixelRatio ?? 1

  // Network Information API — supported on Chromium/Android/desktop Chrome,
  // gracefully absent on Safari/Firefox. Treat as neutral when missing.
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  const saveData = conn?.saveData === true
  const effective = conn?.effectiveType
  const slowNetwork = effective === 'slow-2g' || effective === '2g' || effective === '3g'

  return { cores, isNarrow, isPhone, reducedMotion, lowMemory, gpuTier, dpr, saveData, slowNetwork }
}

function computeTierFromSignals(signals: StaticSignals): VisualTierLevel {
  // Reduced motion always forces tier 1
  if (signals.reducedMotion) return 1

  // Explicit data-saver almost always means "give me the lightest thing".
  if (signals.saveData) return 1

  // Any low-end GPU (software raster, etc.) locks tier 1 regardless of CPU.
  if (signals.gpuTier === 'low') return 1

  // Score-based approach. Phones are penalized but not hard-pinned — a modern
  // phone (≥8 cores AND high GPU) can reach Tier 2. The frame-budget monitor
  // runs with tighter thresholds on phones, so a device that lied about its
  // specs degrades in ≤ 1s of sustained jank.
  let score = 0

  // CPU
  if (signals.cores >= 8) score += 3
  else if (signals.cores >= 4) score += 1

  // GPU
  if (signals.gpuTier === 'high') score += 3
  else if (signals.gpuTier === 'mid') score += 1

  // Phone penalty — strong enough that a mid-GPU / 4-core phone can't score
  // into Tier 2, but leaves a path up for an 8-core + high-GPU flagship.
  if (signals.isPhone) score -= 2

  // Viewport (narrow tablets / small laptops still get a penalty)
  if (signals.isNarrow) score -= 2

  // Memory
  if (signals.lowMemory) score -= 2

  // Slow network is a weak signal that the device is also likely budget-class.
  if (signals.slowNetwork) score -= 1

  // Unknown GPU on a narrow viewport is suspicious — bias down.
  if (signals.gpuTier === 'unknown' && signals.isNarrow) score -= 1

  if (score >= 5) return 3
  if (score >= 2) return 2
  return 1
}

// ---------------------------------------------------------------------------
// Preference store (external store for useSyncExternalStore)
// ---------------------------------------------------------------------------

type Listener = () => void

let _preference: VisualTierPreference = 'auto'
const _listeners = new Set<Listener>()

function readPreference(): VisualTierPreference {
  return _preference
}

function subscribePreference(listener: Listener): () => void {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

function setPreferenceValue(pref: VisualTierPreference) {
  _preference = pref
  _listeners.forEach(l => l())
  if (typeof window !== 'undefined') {
    try {
      if (pref === 'auto') {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, pref)
      }
    } catch { /* quota / private browsing */ }
  }
}

function initPreference() {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'full' || raw === 'balanced' || raw === 'low') {
      _preference = raw
    }
  } catch { /* private browsing */ }
}

function preferenceToTier(pref: VisualTierPreference): VisualTierLevel | null {
  switch (pref) {
    case 'full': return 3
    case 'balanced': return 2
    case 'low': return 1
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Runtime tier persistence — remember auto-degrade outcomes across reloads
// so a device known to stutter doesn't burn the full shader every page load.
// ---------------------------------------------------------------------------

interface RuntimeRecord {
  /** `autoDegradeSteps` that was active when we saved. */
  steps: number
  /** Timestamp (ms since epoch) — record expires after RUNTIME_TTL_MS. */
  savedAt: number
}

function readRuntimeRecord(): RuntimeRecord | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(RUNTIME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RuntimeRecord>
    if (typeof parsed.steps !== 'number' || typeof parsed.savedAt !== 'number') return null
    if (parsed.steps < 0 || parsed.steps > MAX_DEGRADE_STEPS) return null
    if (Date.now() - parsed.savedAt > RUNTIME_TTL_MS) return null
    return { steps: parsed.steps, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

function writeRuntimeRecord(steps: number): void {
  if (typeof window === 'undefined') return
  try {
    if (steps <= 0) {
      window.localStorage.removeItem(RUNTIME_KEY)
      return
    }
    const record: RuntimeRecord = { steps, savedAt: Date.now() }
    window.localStorage.setItem(RUNTIME_KEY, JSON.stringify(record))
  } catch { /* quota / private browsing */ }
}

// ---------------------------------------------------------------------------
// Frame budget monitor — bidirectional with cooldown
// ---------------------------------------------------------------------------

interface FrameBudgetCallbacks {
  /** Fired when a window exceeds the over-budget ratio; request a tier drop. */
  onDegrade: () => void
  /** Fired after PROMOTE_CLEAN_WINDOWS consecutive clean windows. */
  onPromote: () => void
}

function useFrameBudgetMonitor(
  enabled: boolean,
  isPhone: boolean,
  canDegrade: boolean,
  canPromote: boolean,
  callbacks: FrameBudgetCallbacks,
) {
  const rafRef = useRef<number | null>(null)
  const prevTimeRef = useRef(0)
  const overBudgetCount = useRef(0)
  const frameCount = useRef(0)
  const cleanWindows = useRef(0)
  const lastTransitionAt = useRef(0)

  const { onDegrade, onPromote } = callbacks

  useEffect(() => {
    if (!enabled) return

    const windowSize = isPhone ? DEGRADE_WINDOW_FRAMES_PHONE : DEGRADE_WINDOW_FRAMES
    const degradeThreshold = isPhone ? DEGRADE_THRESHOLD_RATIO_PHONE : DEGRADE_THRESHOLD_RATIO
    let stopped = false

    const resetWindow = () => {
      prevTimeRef.current = 0
      overBudgetCount.current = 0
      frameCount.current = 0
      cleanWindows.current = 0
    }

    const isDocumentHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

    const stopLoop = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      resetWindow()
    }

    function tick(now: number) {
      if (stopped) return
      if (isDocumentHidden()) {
        stopLoop()
        return
      }
      if (prevTimeRef.current > 0) {
        const delta = now - prevTimeRef.current
        frameCount.current++
        if (delta > FRAME_BUDGET_MS) overBudgetCount.current++

        if (frameCount.current >= windowSize) {
          const ratio = overBudgetCount.current / frameCount.current
          overBudgetCount.current = 0
          frameCount.current = 0

          const cooledDown = now - lastTransitionAt.current >= TIER_TRANSITION_COOLDOWN_MS

          if (ratio >= degradeThreshold) {
            cleanWindows.current = 0
            if (canDegrade && cooledDown) {
              lastTransitionAt.current = now
              // Continue the loop — the hook will re-run the effect with a
              // fresh `canDegrade` value reflecting the new steps count.
              onDegrade()
            }
          } else if (ratio <= PROMOTE_MAX_OVER_BUDGET_RATIO) {
            cleanWindows.current++
            if (cleanWindows.current >= PROMOTE_CLEAN_WINDOWS && canPromote && cooledDown) {
              cleanWindows.current = 0
              lastTransitionAt.current = now
              onPromote()
            }
          } else {
            // "Middle zone": above promote threshold, below degrade threshold.
            // Reset clean streak but don't act.
            cleanWindows.current = 0
          }
        }
      }
      prevTimeRef.current = now
      rafRef.current = requestAnimationFrame(tick)
    }

    const startLoop = () => {
      if (stopped || rafRef.current != null || isDocumentHidden()) return
      rafRef.current = requestAnimationFrame(tick)
    }

    const handleVisibilityChange = () => {
      if (stopped) return
      if (isDocumentHidden()) {
        // Hidden tabs can queue a very large resume delta; reset the monitor so
        // auto-degrade reacts only to visible frame pressure.
        stopLoop()
        return
      }

      startLoop()
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    startLoop()
    return () => {
      stopped = true
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      stopLoop()
    }
  }, [enabled, isPhone, canDegrade, canPromote, onDegrade, onPromote])
}

// ---------------------------------------------------------------------------
// HTML attribute sync
// ---------------------------------------------------------------------------

function syncHtmlAttribute(tier: VisualTierLevel) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute(HTML_ATTR, String(tier))
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

export function useVisualTier(): VisualTier {
  // One-time static detection
  const [signals] = useState(detectStatic)
  // Seed autoDegradeSteps from a prior session (within RUNTIME_TTL_MS) so a
  // device that had to degrade yesterday doesn't re-test the heavy shader on
  // every page load. Auto-promote can still lift it back up.
  const [autoDegradeSteps, setAutoDegradeSteps] = useState<number>(() => {
    const record = readRuntimeRecord()
    return record?.steps ?? 0
  })

  // Init preference from localStorage on mount
  useEffect(() => { initPreference() }, [])

  const preference = useSyncExternalStore(subscribePreference, readPreference, () => 'auto' as const)

  // Compute effective tier
  const staticTier = computeTierFromSignals(signals)

  const effectiveTier: VisualTierLevel = (() => {
    // User preference wins (unless reduced-motion forces tier 1)
    if (signals.reducedMotion) return 1
    const prefTier = preferenceToTier(preference)
    if (prefTier != null) return prefTier
    // Auto-degrade can drop up to MAX_DEGRADE_STEPS levels (e.g. 3 → 2 → 1).
    const steps = Math.min(autoDegradeSteps, MAX_DEGRADE_STEPS)
    return Math.max(1, staticTier - steps) as VisualTierLevel
  })()

  // Sync HTML attribute
  useEffect(() => {
    syncHtmlAttribute(effectiveTier)
  }, [effectiveTier])

  // Persist auto-degrade outcome so reloads start at the learned tier.
  useEffect(() => {
    // Only persist while in auto mode — user-set preferences are their own key.
    if (preference === 'auto') {
      writeRuntimeRecord(autoDegradeSteps)
    }
  }, [autoDegradeSteps, preference])

  // Re-detect on resize + reduced-motion changes
  const [liveSignals, setLiveSignals] = useState(signals)

  useEffect(() => {
    const onResize = () => setLiveSignals(detectStatic())
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotionChange = () => setLiveSignals(detectStatic())

    window.addEventListener('resize', onResize)
    mql.addEventListener('change', onMotionChange)
    return () => {
      window.removeEventListener('resize', onResize)
      mql.removeEventListener('change', onMotionChange)
    }
  }, [])

  // Bidirectional frame-budget monitor — can degrade (up to MAX_DEGRADE_STEPS)
  // or promote back up (never above the static tier baseline).
  const onDegrade = useCallback(() => {
    setAutoDegradeSteps(prev => Math.min(prev + 1, MAX_DEGRADE_STEPS))
  }, [])
  const onPromote = useCallback(() => {
    setAutoDegradeSteps(prev => Math.max(prev - 1, 0))
  }, [])
  useFrameBudgetMonitor(
    preference === 'auto',
    liveSignals.isPhone,
    /* canDegrade */ autoDegradeSteps < MAX_DEGRADE_STEPS,
    /* canPromote */ autoDegradeSteps > 0,
    { onDegrade, onPromote },
  )

  // DPR cap — phones get tighter caps. At Tier 1 phones default to 0.75 (not
  // 1.0) because fragment cost is the bottleneck on integrated mobile GPUs;
  // 0.75× backing store saves ~44% of per-pixel work with minimal visible
  // quality loss on phone pixel densities.
  const dprCap = (() => {
    if (effectiveTier === 3) return Math.min(liveSignals.dpr, 2)
    if (effectiveTier === 2) return Math.min(liveSignals.dpr, liveSignals.isPhone ? 1.25 : 1.5)
    // tier 1
    if (liveSignals.isPhone && autoDegradeSteps >= 2) return Math.min(liveSignals.dpr, 0.5)
    if (liveSignals.isPhone) return Math.min(liveSignals.dpr, 0.75)
    return 1
  })()

  const setPreference = useCallback((pref: VisualTierPreference) => {
    setPreferenceValue(pref)
    if (pref !== 'auto') {
      setAutoDegradeSteps(0)
      // Clear the runtime record — user made an explicit choice.
      writeRuntimeRecord(0)
    }
  }, [])

  return {
    tier: effectiveTier,
    autoDegraded: autoDegradeSteps > 0,
    preference,
    reducedFidelity: effectiveTier <= 2,
    reducedMotion: liveSignals.reducedMotion,
    dprCap,
    setPreference,
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible re-export
// ---------------------------------------------------------------------------

export type { DeviceFidelity } from './useDeviceFidelity'
export { useDeviceFidelity } from './useDeviceFidelity'
