"use client"

import { useEffect, useRef } from "react"
import { usePresenceStore } from "../stores/presence-store"
import { useUiStore } from "../stores/ui-store"

const FADE_DELAY_MS = 500
const DARK_FADED_OPACITY = 0.08
const LIGHT_FADED_OPACITY = 0.12

/** Presence states that trigger chrome fade */
const ACTIVE_STATES = new Set(["listening", "thinking", "reflecting", "speaking"])

function isDarkMode(): boolean {
  if (typeof document === "undefined") return true
  return document.documentElement.classList.contains("dark")
}

/**
 * Manages session chrome fade based on Sophia's presence state.
 *
 * When presence enters an active state (listening/thinking/reflecting/speaking),
 * fades chrome after 500ms. When resting, restores immediately.
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
    ? isDarkMode() ? DARK_FADED_OPACITY : LIGHT_FADED_OPACITY
    : 1.0

  return { chromeFaded, chromeOpacity }
}
