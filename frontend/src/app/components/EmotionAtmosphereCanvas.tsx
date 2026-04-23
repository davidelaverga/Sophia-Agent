"use client"

import { useRef, useEffect, useCallback } from "react"

import { useEmotionColor, getEmotionColor } from "../hooks/useEmotionColor"
import { useVisualTier } from "../hooks/useVisualTier"

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
  const isAnimatingRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Active emotion from store (live during sessions)
  const emotionColor = useEmotionColor()
  const { reducedMotion, dprCap } = useVisualTier()

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

  const drawCurrent = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!ctx) {
      return
    }

    drawGradient(ctx, currentRgbRef.current)
  }, [drawGradient])

  const stopAnimation = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }
    isAnimatingRef.current = false
  }, [])

  const isDocumentHidden = useCallback(() => {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }, [])

  const tick = useCallback((frameTime: number) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!ctx) {
      stopAnimation()
      return
    }

    if (!isTransitioningRef.current) {
      stopAnimation()
      return
    }

    const elapsed = frameTime - transitionStartRef.current
    const t = Math.min(elapsed / TRANSITION_MS, 1)
    const eased = easeInOutCubic(t)

    currentRgbRef.current = lerpRgb(transitionFromRef.current, targetRgbRef.current, eased)
    drawGradient(ctx, currentRgbRef.current)

    if (t >= 1) {
      isTransitioningRef.current = false
      currentRgbRef.current = [...targetRgbRef.current]
      stopAnimation()
      return
    }

    animFrameRef.current = requestAnimationFrame(tick)
  }, [drawGradient, stopAnimation])

  const ensureAnimation = useCallback(() => {
    if (reducedMotion) {
      isTransitioningRef.current = false
      stopAnimation()
      drawCurrent()
      return
    }

    if (isDocumentHidden()) {
      stopAnimation()
      return
    }

    if (isAnimatingRef.current) {
      return
    }

    isAnimatingRef.current = true
    animFrameRef.current = requestAnimationFrame(tick)
  }, [drawCurrent, isDocumentHidden, reducedMotion, stopAnimation, tick])

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
    ensureAnimation()
  }, [ensureAnimation])

  // Canvas setup and resize handling
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Resize observer
    const resizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap)
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      // Redraw immediately after resize
      drawGradient(ctx, currentRgbRef.current)
    }

    const observer = new ResizeObserver(resizeCanvas)
    observer.observe(canvas)
    resizeCanvas()

    // Initial draw
    drawGradient(ctx, currentRgbRef.current)

    return () => {
      stopAnimation()
      observer.disconnect()
    }
  }, [dprCap, drawGradient, stopAnimation])

  useEffect(() => {
    if (!reducedMotion) {
      return
    }

    isTransitioningRef.current = false
    currentRgbRef.current = [...targetRgbRef.current]
    stopAnimation()
    drawCurrent()
  }, [drawCurrent, reducedMotion, stopAnimation])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopAnimation()
        return
      }

      if (isTransitioningRef.current) {
        ensureAnimation()
        return
      }

      drawCurrent()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [drawCurrent, ensureAnimation, stopAnimation])

  // React to emotion color changes
  useEffect(() => {
    const newRgb = emotionColor.rgb

    // Clear any idle timer when live emotion arrives
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }

    if (reducedMotion) {
      // No animation — update immediately
      currentRgbRef.current = newRgb
      targetRgbRef.current = newRgb
      const canvas = canvasRef.current
      const ctx = canvas?.getContext("2d")
      if (ctx) drawGradient(ctx, newRgb)
    } else {
      startTransition(newRgb)
    }
  }, [drawGradient, emotionColor.rgb, reducedMotion, startTransition])

  // Dashboard: apply last session emotion, then fade to WARM after idle
  useEffect(() => {
    if (!lastSessionEmotion) return

    const lastColor = getEmotionColor(lastSessionEmotion)
    currentRgbRef.current = lastColor.rgb
    targetRgbRef.current = lastColor.rgb
    isTransitioningRef.current = false
    stopAnimation()

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
  }, [drawGradient, lastSessionEmotion, startTransition, stopAnimation])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ width: "100%", height: "100%" }}
    />
  )
}
