"use client"

import { useRef, useCallback } from "react"
import type { PresenceState } from "../stores/presence-store"
import type { EmotionColor } from "./useEmotionColor"

// ─── Expression parameters ───────────────────────────────────────────────────
// These 7 values define Sophia's visual expression. They are smoothly
// interpolated each animation frame so transitions feel organic.

export interface ExpressionParams {
  coreIntensity: number   // brightness of Sophia's core (0–1)
  flowEnergy: number      // energy-band activity in the shader (0–1)
  breathRate: number      // breathing cycle speed (radians/sec-ish)
  ribbonSpeed: number     // ribbon wave speed multiplier
  ribbonAmplitude: number // ribbon wave height multiplier
  particleAlpha: number   // particle visibility (0–1)
  particleDrift: number   // +1 outward, -1 inward, ~0 swirl
}

// ─── State targets ───────────────────────────────────────────────────────────

const STATE_TARGETS: Record<PresenceState, ExpressionParams> = {
  speaking:   { coreIntensity: 0.95, flowEnergy: 0.8,  breathRate: 1.4, ribbonSpeed: 1.0,  ribbonAmplitude: 1.0, particleAlpha: 0.85, particleDrift: 1.0  },
  listening:  { coreIntensity: 0.45, flowEnergy: 0.35, breathRate: 0.7, ribbonSpeed: 0.45, ribbonAmplitude: 0.6, particleAlpha: 0.5,  particleDrift: -0.4 },
  thinking:   { coreIntensity: 0.6,  flowEnergy: 0.2,  breathRate: 0.5, ribbonSpeed: 0.3,  ribbonAmplitude: 0.4, particleAlpha: 0.4,  particleDrift: 0.0  },
  reflecting: { coreIntensity: 0.55, flowEnergy: 0.15, breathRate: 0.4, ribbonSpeed: 0.25, ribbonAmplitude: 0.35, particleAlpha: 0.35, particleDrift: 0.0  },
  resting:    { coreIntensity: 0.3,  flowEnergy: 0.1,  breathRate: 0.3, ribbonSpeed: 0.2,  ribbonAmplitude: 0.3, particleAlpha: 0.25, particleDrift: 0.0  },
}

// ─── Emotion modifiers ───────────────────────────────────────────────────────
// These scale the motion quality on top of the state-driven targets.

export type EmotionBand = "WARM" | "CALM" | "ENERGETIC" | "INTENSE" | "TENDER"

interface EmotionModifier {
  breathMult: number
  speedMult: number
  ampMult: number
}

const EMOTION_MODIFIERS: Record<EmotionBand, EmotionModifier> = {
  WARM:      { breathMult: 1.0, speedMult: 1.0, ampMult: 1.0 },
  CALM:      { breathMult: 0.7, speedMult: 0.7, ampMult: 0.8 },
  ENERGETIC: { breathMult: 1.6, speedMult: 1.4, ampMult: 1.3 },
  INTENSE:   { breathMult: 1.3, speedMult: 1.2, ampMult: 1.5 },
  TENDER:    { breathMult: 0.5, speedMult: 0.6, ampMult: 0.7 },
}

// ─── Palette system ──────────────────────────────────────────────────────────
// 3-color palettes [primary, secondary, accent] in normalized 0–1 RGB.
// useEmotionColor provides a single color in 0–255; we derive full palettes.

export type NormalizedRGB = [number, number, number]
export type Palette = [NormalizedRGB, NormalizedRGB, NormalizedRGB]

const PALETTES: Record<EmotionBand, Palette> = {
  WARM:      [[0.55, 0.35, 0.75], [0.75, 0.38, 0.58], [0.95, 0.72, 0.45]],
  CALM:      [[0.30, 0.52, 0.68], [0.40, 0.60, 0.78], [0.70, 0.82, 0.90]],
  ENERGETIC: [[0.80, 0.58, 0.28], [0.92, 0.70, 0.35], [1.00, 0.58, 0.45]],
  INTENSE:   [[0.75, 0.28, 0.28], [0.90, 0.38, 0.28], [1.00, 0.58, 0.32]],
  TENDER:    [[0.58, 0.38, 0.75], [0.72, 0.48, 0.78], [0.90, 0.58, 0.75]],
}

// Map EmotionColor.rgb → band name
const RGB_TO_BAND: Record<string, EmotionBand> = {
  "124,92,170": "WARM",
  "92,138,170": "CALM",
  "170,138,92": "ENERGETIC",
  "170,92,92":  "INTENSE",
  "138,92,170": "TENDER",
}

export function emotionColorToBand(ec: EmotionColor): EmotionBand {
  return RGB_TO_BAND[ec.rgb.join(",")] ?? "WARM"
}

export function getBandPalette(band: EmotionBand): Palette {
  return PALETTES[band]
}

// ─── Lerp helpers ────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpColor(a: NormalizedRGB, b: NormalizedRGB, t: number): NormalizedRGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

// ─── Hook ────────────────────────────────────────────────────────────────────

const LERP_SPEED = 0.012       // ~2-3s transition per frame at 60fps
const PALETTE_SPEED = 0.0018   // ~9s full crossfade

export interface ExpressionState {
  params: ExpressionParams
  palette: Palette
  band: EmotionBand
}

/**
 * Returns a stable ref containing expression parameters and palette that are
 * updated each animation frame. Call `tick(presenceState, emotionColor, time)`
 * inside your rAF loop.
 */
export function useExpression() {
  const stateRef = useRef<ExpressionState>({
    params: { ...STATE_TARGETS.resting },
    palette: PALETTES.WARM.map(c => [...c]) as unknown as Palette,
    band: "WARM",
  })

  const paletteMixRef = useRef(1.0)
  const frozenPaletteRef = useRef<Palette>(
    PALETTES.WARM.map(c => [...c]) as unknown as Palette
  )
  const currentBandRef = useRef<EmotionBand>("WARM")

  // ─── Impulse system ─────────────────────────────────────────────────────
  // Additive spikes that decay linearly over time. Multiple impulses on
  // different params are independent.

  interface Impulse {
    param: keyof ExpressionParams
    delta: number
    decayMs: number
    startTime: number
  }

  const impulsesRef = useRef<Impulse[]>([])

  /** Spike a parameter by `delta`, decaying to zero over `decayMs`. */
  const fireImpulse = useCallback(
    (param: keyof ExpressionParams, delta: number, decayMs: number) => {
      impulsesRef.current.push({
        param,
        delta,
        decayMs,
        startTime: performance.now(),
      })
    },
    []
  )

  const tick = useCallback(
    (presenceState: PresenceState, emotionColor: EmotionColor, time: number) => {
      const st = stateRef.current
      const band = emotionColorToBand(emotionColor)

      // Palette crossfade — freeze snapshot on band change
      if (band !== currentBandRef.current) {
        frozenPaletteRef.current = st.palette.map(c => [...c]) as Palette
        paletteMixRef.current = 0
        currentBandRef.current = band
      }

      if (paletteMixRef.current < 1) {
        paletteMixRef.current = Math.min(1, paletteMixRef.current + PALETTE_SPEED)
      }
      const easedMix = easeInOutQuad(paletteMixRef.current)
      const targetPalette = PALETTES[band]
      st.palette = frozenPaletteRef.current.map((c, i) =>
        lerpColor(c, targetPalette[i], easedMix)
      ) as Palette
      st.band = band

      // Expression parameter lerp
      const target = STATE_TARGETS[presenceState] ?? STATE_TARGETS.resting
      const mod = EMOTION_MODIFIERS[band]

      st.params.coreIntensity += (target.coreIntensity - st.params.coreIntensity) * LERP_SPEED
      st.params.flowEnergy += (target.flowEnergy - st.params.flowEnergy) * LERP_SPEED
      st.params.breathRate += (target.breathRate * mod.breathMult - st.params.breathRate) * LERP_SPEED
      st.params.ribbonSpeed += (target.ribbonSpeed * mod.speedMult - st.params.ribbonSpeed) * LERP_SPEED
      st.params.ribbonAmplitude += (target.ribbonAmplitude * mod.ampMult - st.params.ribbonAmplitude) * LERP_SPEED
      st.params.particleAlpha += (target.particleAlpha - st.params.particleAlpha) * LERP_SPEED
      st.params.particleDrift += (target.particleDrift - st.params.particleDrift) * LERP_SPEED

      // Per-state micro-modulations
      let ci = st.params.coreIntensity
      if (presenceState === "speaking") ci += Math.sin(time * 1.5) * 0.08
      if (presenceState === "thinking") ci += Math.sin(time * 3.0) * 0.04 + Math.sin(time * 0.7) * 0.05

      // Apply active impulses (additive, decay linearly)
      const now = performance.now()
      const finalParams = { ...st.params, coreIntensity: ci }
      impulsesRef.current = impulsesRef.current.filter((imp) => {
        const elapsed = now - imp.startTime
        if (elapsed >= imp.decayMs) return false
        const t = 1 - elapsed / imp.decayMs
        finalParams[imp.param] += imp.delta * t
        return true
      })

      return finalParams
    },
    []
  )

  return { expressionRef: stateRef, tick, fireImpulse }
}
