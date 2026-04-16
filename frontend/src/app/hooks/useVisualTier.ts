/**
 * useVisualTier — adaptive visual quality system with 3 tiers.
 *
 * Tier 3 (full):    Desktop with dedicated GPU, 8+ cores
 * Tier 2 (medium):  Laptop/tablet, 4-8 cores, or integrated GPU
 * Tier 1 (low):     Mobile, <4 cores, reduced-motion, battery saver, or user override
 *
 * Features:
 *  - Static detection (cores, viewport, GPU renderer, memory, battery)
 *  - Runtime frame-budget monitor: auto-degrades if FPS drops below threshold
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
const FRAME_BUDGET_MS = 25 // ~40 fps threshold
const DEGRADE_WINDOW_FRAMES = 150 // ~2.5s at 60fps
const DEGRADE_THRESHOLD_RATIO = 0.4 // 40% of frames over budget → degrade
const HTML_ATTR = 'data-visual-tier'

// ---------------------------------------------------------------------------
// Static detection (runs once)
// ---------------------------------------------------------------------------

interface StaticSignals {
  cores: number
  isNarrow: boolean
  reducedMotion: boolean
  lowMemory: boolean
  gpuTier: 'low' | 'mid' | 'high' | 'unknown'
  dpr: number
}

function detectGpuTier(): 'low' | 'mid' | 'high' | 'unknown' {
  if (typeof document === 'undefined') return 'unknown'
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')
    if (!gl || !(gl instanceof WebGLRenderingContext)) return 'unknown'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (!ext) return 'unknown'
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string
    const lower = renderer.toLowerCase()

    // Known low-end indicators
    if (/swiftshader|llvmpipe|softpipe|mesa/.test(lower)) return 'low'
    if (/intel.*hd|intel.*uhd|intel.*iris|mali-[gt]|adreno\s?[1-5]\d\d/i.test(lower)) return 'mid'
    if (/nvidia|radeon|geforce|apple\s?gpu|apple\s?m[1-9]/i.test(lower)) return 'high'

    return 'mid'
  } catch {
    return 'unknown'
  }
}

function detectStatic(): StaticSignals {
  if (typeof window === 'undefined') {
    return { cores: 4, isNarrow: false, reducedMotion: false, lowMemory: false, gpuTier: 'unknown', dpr: 1 }
  }

  const cores = navigator.hardwareConcurrency ?? 4
  const isNarrow = window.innerWidth < 768
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const mem = (navigator as { deviceMemory?: number }).deviceMemory
  const lowMemory = mem != null && mem < 4
  const gpuTier = detectGpuTier()
  const dpr = window.devicePixelRatio ?? 1

  return { cores, isNarrow, reducedMotion, lowMemory, gpuTier, dpr }
}

function computeTierFromSignals(signals: StaticSignals): VisualTierLevel {
  // Reduced motion always forces tier 1
  if (signals.reducedMotion) return 1

  // Score-based approach
  let score = 0

  // CPU
  if (signals.cores >= 8) score += 3
  else if (signals.cores >= 4) score += 1

  // GPU
  if (signals.gpuTier === 'high') score += 3
  else if (signals.gpuTier === 'mid') score += 1
  else if (signals.gpuTier === 'low') score -= 2

  // Viewport
  if (signals.isNarrow) score -= 2

  // Memory
  if (signals.lowMemory) score -= 1

  if (score >= 5) return 3
  if (score >= 1) return 2
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
// Frame budget monitor
// ---------------------------------------------------------------------------

function useFrameBudgetMonitor(
  enabled: boolean,
  onDegrade: () => void,
) {
  const rafRef = useRef<number | null>(null)
  const prevTimeRef = useRef(0)
  const overBudgetCount = useRef(0)
  const frameCount = useRef(0)
  const degradedRef = useRef(false)

  useEffect(() => {
    if (!enabled || degradedRef.current) return

    function tick(now: number) {
      if (prevTimeRef.current > 0) {
        const delta = now - prevTimeRef.current
        frameCount.current++
        if (delta > FRAME_BUDGET_MS) overBudgetCount.current++

        if (frameCount.current >= DEGRADE_WINDOW_FRAMES) {
          const ratio = overBudgetCount.current / frameCount.current
          if (ratio >= DEGRADE_THRESHOLD_RATIO && !degradedRef.current) {
            degradedRef.current = true
            onDegrade()
            return // stop monitoring
          }
          // reset window
          overBudgetCount.current = 0
          frameCount.current = 0
        }
      }
      prevTimeRef.current = now
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [enabled, onDegrade])
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
  const [autoDegraded, setAutoDegraded] = useState(false)

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
    // Auto-degrade drops one level
    if (autoDegraded) return Math.max(1, staticTier - 1) as VisualTierLevel
    return staticTier
  })()

  // Sync HTML attribute
  useEffect(() => {
    syncHtmlAttribute(effectiveTier)
  }, [effectiveTier])

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

  // Frame budget monitor — only on auto at tier 2+
  const onDegrade = useCallback(() => setAutoDegraded(true), [])
  useFrameBudgetMonitor(
    preference === 'auto' && effectiveTier >= 2,
    onDegrade,
  )

  // DPR cap
  const dprCap = effectiveTier === 1 ? 1 : effectiveTier === 2 ? Math.min(liveSignals.dpr, 1.5) : Math.min(liveSignals.dpr, 2)

  const setPreference = useCallback((pref: VisualTierPreference) => {
    setPreferenceValue(pref)
    if (pref !== 'auto') setAutoDegraded(false)
  }, [])

  return {
    tier: effectiveTier,
    autoDegraded,
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
