"use client"

import { useMemo } from "react"

import { useEmotionStore } from "../stores/emotion-store"

// ─── Color bands ─────────────────────────────────────────────────────────────
// Each band maps a cluster of Cartesia emotions to a primary/glow color pair.

export interface EmotionColor {
  /** CSS color for primary fills / strokes */
  primary: string
  /** CSS color for glows / shadows */
  glow: string
  /** Numeric RGBA parts for canvas drawing: [r, g, b] */
  rgb: [number, number, number]
}

const WARM: EmotionColor = { primary: "#7c5caa", glow: "#9d7cc9", rgb: [124, 92, 170] }
const CALM: EmotionColor = { primary: "#5c8aaa", glow: "#7caac9", rgb: [92, 138, 170] }
const ENERGETIC: EmotionColor = { primary: "#aa8a5c", glow: "#c9aa7c", rgb: [170, 138, 92] }
const INTENSE: EmotionColor = { primary: "#aa5c5c", glow: "#c97c7c", rgb: [170, 92, 92] }
const TENDER: EmotionColor = { primary: "#8a5caa", glow: "#aa7cc9", rgb: [138, 92, 170] }

/** Emotion → color band lookup. */
const EMOTION_COLOR_MAP: Record<string, EmotionColor> = {
  // Warm (default purple — neutral / content / curious)
  neutral: WARM,
  content: WARM,
  curious: WARM,
  contemplative: WARM,
  anticipation: WARM,
  mysterious: WARM,
  confident: WARM,
  proud: WARM,
  flirtatious: WARM,

  // Calm (blue-teal — peaceful / calm / serene)
  calm: CALM,
  peaceful: CALM,
  serene: CALM,
  grateful: CALM,
  trust: CALM,
  resigned: CALM,
  tired: CALM,
  bored: CALM,
  nostalgic: CALM,
  wistful: CALM,
  apologetic: CALM,
  hesitant: CALM,

  // Energetic (gold-amber — excited / happy / enthusiastic)
  happy: ENERGETIC,
  excited: ENERGETIC,
  enthusiastic: ENERGETIC,
  elated: ENERGETIC,
  euphoric: ENERGETIC,
  triumphant: ENERGETIC,
  amazed: ENERGETIC,
  surprised: ENERGETIC,

  // Intense (warm-red — angry / determined / frustrated)
  angry: INTENSE,
  mad: INTENSE,
  outraged: INTENSE,
  frustrated: INTENSE,
  agitated: INTENSE,
  threatened: INTENSE,
  disgusted: INTENSE,
  contempt: INTENSE,
  envious: INTENSE,
  sarcastic: INTENSE,
  ironic: INTENSE,
  determined: INTENSE,
  skeptical: INTENSE,
  distant: INTENSE,
  anxious: INTENSE,
  panicked: INTENSE,
  alarmed: INTENSE,
  scared: INTENSE,

  // Tender (soft-violet — sympathetic / affectionate / sad)
  sympathetic: TENDER,
  affectionate: TENDER,
  sad: TENDER,
  dejected: TENDER,
  melancholic: TENDER,
  disappointed: TENDER,
  hurt: TENDER,
  guilty: TENDER,
  rejected: TENDER,
  insecure: TENDER,
  confused: TENDER,
}

/**
 * Returns the current emotion color band based on the latest artifact.
 * Defaults to WARM (Sophia's standard purple) when no emotion is set.
 */
export function useEmotionColor(): EmotionColor {
  const emotion = useEmotionStore((s) => s.emotion)

  return useMemo(() => {
    if (!emotion) return WARM
    return EMOTION_COLOR_MAP[emotion] ?? WARM
  }, [emotion])
}

/** Non-hook version for imperative use (e.g. canvas). */
export function getEmotionColor(emotion: string | null): EmotionColor {
  if (!emotion) return WARM
  return EMOTION_COLOR_MAP[emotion] ?? WARM
}
