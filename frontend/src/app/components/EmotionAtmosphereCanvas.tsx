"use client"

import { useRef, useEffect, useCallback } from "react"
import { useEmotionColor, getEmotionColor, type EmotionColor } from "../hooks/useEmotionColor"

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default color when no emotion / dashboard idle — WARM (Sophia's purple) */
const DEFAULT_RGB: [number, number, number] = [124, 92, 170]

/** Transition duration in milliseconds */
const TRANSITION_MS = 1500

/** Dashboard idle timeout — fade to WARM after 5 minutes */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Center alpha for the radial gradient */
const CENTER_ALPHA = 0.15

/** Edge alpha for the radial gradient */
const EDGE_ALPHA = 0.03

// ─── Types ───────────────────────────────────────────────────────────────────

interface EmotionAtmosphereCanvasProps {
  /** Last session emotion string for dashboard — fades to WARM after idle timeout */
  lastSessionEmotion?: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpRgb(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)]
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

// ─── Component ───────────────────────────────────────────────────────────────

export function EmotionAtmosphereCanvas({ lastSessionEmotion }: EmotionAtmosphereCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const currentRgbRef = useRef<[number, number, number]>(DEFAULT_RGB)
  const targetRgbRef = useRef<[number, number, number]>(DEFAULT_RGB)
  const transitionStartRef = useRef<number>(0)
  const transitionFromRef = useRef<[number, number, number]>(DEFAULT_RGB)
  const isTransitioningRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reducedMotionRef = useRef(false)

  // Active emotion from store (live during sessions)
  const emotionColor = useEmotionColor()

  // Check prefers-reduced-motion on mount
  useEffect(() => {
    if (typeof window === "undefined") return
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)")
    reducedMotionRef.current = mql.matches
    const handler = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches
    }
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [])

  // Draw the radial gradient on canvas
  const drawGradient = useCallback((ctx: CanvasRenderingContext2D, rgb: [number, number, number]) => {
    const w = ctx.canvas.width
    const h = ctx.canvas.height

    ctx.clearRect(0, 0, w, h)

    // Primary radial gradient from center
    const centerX = w * 0.5
    const centerY = h * 0.4
    const radius = Math.max(w, h) * 0.8

    const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius)
    grad.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${CENTER_ALPHA})`)
    grad.addColorStop(0.5, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(CENTER_ALPHA + EDGE_ALPHA) / 2})`)
    grad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${EDGE_ALPHA})`)

    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    // Secondary subtle wash from bottom-right for depth
    const r2 = Math.min(rgb[0] + 30, 255)
    const g2 = Math.min(rgb[1] + 20, 255)
    const b2 = Math.min(rgb[2] + 40, 255)

    const grad2 = ctx.createRadialGradient(w * 0.8, h * 0.7, 0, w * 0.8, h * 0.7, radius * 0.6)
    grad2.addColorStop(0, `rgba(${r2}, ${g2}, ${b2}, ${EDGE_ALPHA * 2})`)
    grad2.addColorStop(1, `rgba(${r2}, ${g2}, ${b2}, 0)`)

    ctx.fillStyle = grad2
    ctx.fillRect(0, 0, w, h)
  }, [])

  // Start a color transition
  const startTransition = useCallback((newRgb: [number, number, number]) => {
    if (
      currentRgbRef.current[0] === newRgb[0] &&
      currentRgbRef.current[1] === newRgb[1] &&
      currentRgbRef.current[2] === newRgb[2]
    ) {
      return // Already at target
    }

    transitionFromRef.current = [...currentRgbRef.current]
    targetRgbRef.current = newRgb
    transitionStartRef.current = performance.now()
    isTransitioningRef.current = true
  }, [])

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Resize observer
    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      // Redraw immediately after resize
      drawGradient(ctx, currentRgbRef.current)
    }

    const observer = new ResizeObserver(resizeCanvas)
    observer.observe(canvas)
    resizeCanvas()

    // For reduced motion: just draw once, no loop
    if (reducedMotionRef.current) {
      drawGradient(ctx, currentRgbRef.current)
      return () => observer.disconnect()
    }

    // Animation frame loop
    const tick = () => {
      if (isTransitioningRef.current) {
        const elapsed = performance.now() - transitionStartRef.current
        const t = Math.min(elapsed / TRANSITION_MS, 1)
        const eased = easeInOutCubic(t)

        currentRgbRef.current = lerpRgb(transitionFromRef.current, targetRgbRef.current, eased)
        drawGradient(ctx, currentRgbRef.current)

        if (t >= 1) {
          isTransitioningRef.current = false
          currentRgbRef.current = [...targetRgbRef.current]
        }
      }

      animFrameRef.current = requestAnimationFrame(tick)
    }

    // Initial draw
    drawGradient(ctx, currentRgbRef.current)
    animFrameRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      observer.disconnect()
    }
  }, [drawGradient])

  // React to emotion color changes
  useEffect(() => {
    const newRgb = emotionColor.rgb

    // Clear any idle timer when live emotion arrives
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }

    if (reducedMotionRef.current) {
      // No animation — update immediately
      currentRgbRef.current = newRgb
      const canvas = canvasRef.current
      const ctx = canvas?.getContext("2d")
      if (ctx) drawGradient(ctx, newRgb)
    } else {
      startTransition(newRgb)
    }
  }, [emotionColor.rgb, startTransition, drawGradient])

  // Dashboard: apply last session emotion, then fade to WARM after idle
  useEffect(() => {
    if (!lastSessionEmotion) return

    const lastColor = getEmotionColor(lastSessionEmotion)
    currentRgbRef.current = lastColor.rgb
    targetRgbRef.current = lastColor.rgb

    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (ctx) drawGradient(ctx, lastColor.rgb)

    // After idle timeout, transition to WARM
    idleTimerRef.current = setTimeout(() => {
      startTransition(DEFAULT_RGB)
    }, IDLE_TIMEOUT_MS)

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }
  }, [lastSessionEmotion, startTransition, drawGradient])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ width: "100%", height: "100%" }}
    />
  )
}
