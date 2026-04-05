"use client"

import { useCallback, useEffect, useRef, useState } from "react"

interface CaptionState {
  /** Current displayed text */
  text: string
  /** 0 = invisible, 1 = fully visible */
  opacity: number
  /** Whether any caption is currently displayed */
  isVisible: boolean
}

interface UseCaptionQueueOptions {
  /** How long the caption stays at full opacity (ms). Default 4000 */
  holdMs?: number
  /** Fade-in duration (ms). Default 800 */
  fadeInMs?: number
  /** Fade-out duration (ms). Default 2000 */
  fadeOutMs?: number
}

/**
 * Manages ephemeral voice caption lifecycle.
 *
 * - New text → cancel any active fade-out → set opacity to 1 → hold for holdMs → fade out.
 * - Rapid updates replace the text immediately.
 * - flush() clears the queue (used on mode switch voice→text).
 */
export function useCaptionQueue(options: UseCaptionQueueOptions = {}) {
  const { holdMs = 4000, fadeInMs = 800, fadeOutMs = 2000 } = options

  const [state, setState] = useState<CaptionState>({
    text: "",
    opacity: 0,
    isVisible: false,
  })

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const phase = useRef<"idle" | "visible" | "fading">("idle")

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }, [])

  const showCaption = useCallback(
    (text: string) => {
      if (!text.trim()) return

      clearHoldTimer()
      phase.current = "visible"

      setState({ text, opacity: 1, isVisible: true })

      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null
        phase.current = "fading"
        setState((prev) => ({ ...prev, opacity: 0 }))

        // After fade-out completes, mark invisible
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null
          phase.current = "idle"
          setState({ text: "", opacity: 0, isVisible: false })
        }, fadeOutMs)
      }, holdMs)
    },
    [clearHoldTimer, holdMs, fadeOutMs]
  )

  const flush = useCallback(() => {
    clearHoldTimer()
    phase.current = "idle"
    setState({ text: "", opacity: 0, isVisible: false })
  }, [clearHoldTimer])

  // Cleanup on unmount
  useEffect(() => {
    return () => clearHoldTimer()
  }, [clearHoldTimer])

  return {
    ...state,
    showCaption,
    flush,
    /** CSS transition string for the caption container */
    transition:
      phase.current === "fading"
        ? `color ${fadeOutMs}ms ease, opacity ${fadeOutMs}ms ease`
        : `color ${fadeInMs}ms ease, opacity ${fadeInMs}ms ease`,
  }
}
