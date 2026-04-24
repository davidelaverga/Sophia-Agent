"use client"

import { useEffect, useRef } from "react"

import { usePresenceStore } from "../stores/presence-store"
import { useUiStore } from "../stores/ui-store"

const FADE_DELAY_MS = 500
const FADED_OPACITY_DARK = 0.08
const FADED_OPACITY_LIGHT = 0.12
const RESTING_OPACITY = 1.0

/** Presence states that trigger chrome fade */
const ACTIVE_STATES = new Set(["listening", "thinking", "reflecting", "speaking"])

/**
 * Manages session chrome fade based on Sophia's presence state.
 *
 * When presence enters an active state (listening/thinking/reflecting/speaking),
 * fades chrome after 500ms. When resting, restores to 0.7 (not fully opaque).
 * Respects kill switch and text mode.
 *
 * Returns { chromeFaded, chromeOpacity } for consumers.
 */
export function useChromeFade() {
  const presenceStatus = usePresenceStore((s) => s.status)
  const chromeFaded = useUiStore((s) => s.chromeFaded)
  const setChromeFaded = useUiStore((s) => s.setChromeFaded)
  const disableChromeFade = useUiStore((s) => s.disableChromeFade)
  const mode = useUiStore((s) => s.mode)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Kill switch or text mode → never fade
    if (disableChromeFade || mode === "text") {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setChromeFaded(false)
      return
    }

    if (ACTIVE_STATES.has(presenceStatus)) {
      // Active → start fade timer (if not already faded)
      if (!chromeFaded && !timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setChromeFaded(true)
        }, FADE_DELAY_MS)
      }
    } else {
      // Resting → cancel any pending timer and unfade immediately
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (chromeFaded) {
        setChromeFaded(false)
      }
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [presenceStatus, disableChromeFade, mode, chromeFaded, setChromeFaded])

  const chromeOpacity = chromeFaded
    ? (typeof document !== "undefined" && document.documentElement.classList.contains("dark")
        ? FADED_OPACITY_DARK
        : FADED_OPACITY_LIGHT)
    : RESTING_OPACITY

  return { chromeFaded, chromeOpacity }
}
