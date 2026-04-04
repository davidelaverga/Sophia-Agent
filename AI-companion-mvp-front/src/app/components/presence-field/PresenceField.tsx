"use client"

import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react"
import { usePresenceStore } from "../../stores/presence-store"
import { useEmotionColor } from "../../hooks/useEmotionColor"
import { useExpression, type ExpressionParams } from "../../hooks/useExpression"
import { useDeviceFidelity } from "../../hooks/useDeviceFidelity"
import { useNebulaCanvas } from "./NebulaCanvas"
import { useRibbonCanvas } from "./RibbonCanvas"
import { useSparkCanvas } from "./SparkCanvas"

// ─── Public ref handle ───────────────────────────────────────────────────────

export interface PresenceFieldHandle {
  fireImpulse: (param: keyof ExpressionParams, delta: number, decayMs: number) => void
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * PresenceField — Sophia's visual presence during a session.
 *
 * Three stacked canvas layers (WebGL nebula + Canvas2D ribbons + Canvas2D sparks)
 * driven by a single rAF loop. Expression parameters and palettes interpolate
 * smoothly based on presence state and emotion color from the stores.
 */
export const PresenceField = forwardRef<PresenceFieldHandle>(function PresenceField(_props, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const mouseRef = useRef({ x: 0.5, y: 0.5 })

  // Device fidelity (R43, R44, R45)
  const { reducedFidelity, reducedMotion, dprCap } = useDeviceFidelity()

  // Stores
  const presenceState = usePresenceStore((s) => s.status)
  const emotionColor = useEmotionColor()

  // Expression system (smooth lerp engine)
  const { expressionRef, tick, fireImpulse } = useExpression()

  // Expose impulse to parent via ref
  useImperativeHandle(ref, () => ({ fireImpulse }), [fireImpulse])

  // Canvas layers — pass fidelity for count adjustments
  const nebula = useNebulaCanvas({ reducedFidelity })
  const ribbon = useRibbonCanvas({ reducedFidelity })
  const spark = useSparkCanvas({ reducedFidelity })

  // ── Resize ──────────────────────────────────────────────────────────────
  const handleResize = useCallback(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    nebula.resize(w, h, dprCap)
    ribbon.resize(w, h)
    spark.resize(w, h)
  }, [nebula, ribbon, spark, dprCap])

  // ── Mouse ───────────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: MouseEvent) => {
    mouseRef.current.x = e.clientX / window.innerWidth
    mouseRef.current.y = e.clientY / window.innerHeight
  }, [])

  // Keep refs synced with latest store values so the rAF loop reads them
  const presenceRef = useRef(presenceState)
  presenceRef.current = presenceState
  const emotionRef = useRef(emotionColor)
  emotionRef.current = emotionColor

  // ── Init + animation loop ───────────────────────────────────────────────
  useEffect(() => {
    const w = window.innerWidth
    const h = window.innerHeight

    nebula.resize(w, h, dprCap)
    const glOk = nebula.init()
    ribbon.resize(w, h)
    ribbon.init(w, h)
    spark.resize(w, h)
    spark.init(w, h)

    window.addEventListener("resize", handleResize)
    document.addEventListener("mousemove", handleMouseMove)

    // Set data attribute for CSS targeting (R45)
    if (reducedMotion) {
      document.documentElement.setAttribute("data-reduced-motion", "")
    }

    const frame = (ts: number) => {
      const time = ts * 0.001
      const params = tick(presenceRef.current, emotionRef.current, time)
      const palette = expressionRef.current.palette
      const mx = mouseRef.current.x
      const my = mouseRef.current.y

      if (glOk) nebula.render(time, params, palette, mx, my)
      ribbon.render(time, params, palette, mx, my)
      spark.render(
        time,
        params,
        palette,
        mx,
        my,
        presenceRef.current === "speaking"
      )

      // Reduced motion: render one static frame then stop (R45)
      if (!reducedMotion) {
        rafRef.current = requestAnimationFrame(frame)
      }
    }
    rafRef.current = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener("resize", handleResize)
      document.removeEventListener("mousemove", handleMouseMove)
      document.documentElement.removeAttribute("data-reduced-motion")
    }
    // Stable refs only — no reactive deps needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, reducedFidelity, dprCap])

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    >
      {/* Layer 1: WebGL nebula */}
      <canvas
        ref={nebula.canvasRef}
        className="fixed inset-0 w-full h-full"
        style={{ zIndex: 0 }}
      />
      {/* Layer 2: Canvas2D ribbons */}
      <canvas
        ref={ribbon.canvasRef}
        className="fixed inset-0 w-full h-full"
        style={{ zIndex: 1 }}
      />
      {/* Layer 3: Canvas2D sparkle dust */}
      <canvas
        ref={spark.canvasRef}
        className="fixed inset-0 w-full h-full"
        style={{ zIndex: 2 }}
      />
    </div>
  )
})
