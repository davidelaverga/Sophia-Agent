"use client"

import { useRef, useEffect, useCallback, useImperativeHandle, useMemo, type Ref } from "react"

import { useEmotionColor } from "../../hooks/useEmotionColor"
import { useExpression, type ExpressionParams } from "../../hooks/useExpression"
import { useVisualTier } from "../../hooks/useVisualTier"
import { getPresenceFieldProfile, shouldSkipTierFrame } from "../../lib/visual-tier-profiles"
import { usePresenceStore } from "../../stores/presence-store"

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
export function PresenceField({ ref }: { ref?: Ref<PresenceFieldHandle> }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const mouseRef = useRef({ x: 0.5, y: 0.5 })

  // Device fidelity (R43, R44, R45)
  const { reducedMotion, dprCap, tier } = useVisualTier()
  const renderProfile = useMemo(() => getPresenceFieldProfile(tier), [tier])

  // Stores
  const presenceState = usePresenceStore((s) => s.status)
  const emotionColor = useEmotionColor()

  // Expression system (smooth lerp engine)
  const { expressionRef, tick, fireImpulse } = useExpression()

  // Expose impulse to parent via ref
  useImperativeHandle(ref, () => ({ fireImpulse }), [fireImpulse])

  // Canvas layers — pass fidelity for count adjustments
  const nebula = useNebulaCanvas({ octaves: renderProfile.nebulaOctaves })
  const ribbon = useRibbonCanvas({
    ribbonCount: renderProfile.ribbonCount,
    segments: renderProfile.ribbonSegments,
  })
  const spark = useSparkCanvas({
    sparkCount: renderProfile.sparkCount,
    speakingBurstCount: renderProfile.speakingBurstCount,
  })

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
    let lastFrameTime = 0

    const stopLoop = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      lastFrameTime = 0
    }

    const isDocumentHidden = () => document.visibilityState === "hidden"

    // Set data attribute for CSS targeting (R45)
    if (reducedMotion) {
      document.documentElement.setAttribute("data-reduced-motion", "")
    }

    const frame = (ts: number) => {
      if (!reducedMotion && shouldSkipTierFrame(ts, lastFrameTime, renderProfile.frameIntervalMs)) {
        rafRef.current = requestAnimationFrame(frame)
        return
      }

      lastFrameTime = ts
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

    const startLoop = () => {
      if (reducedMotion || rafRef.current || isDocumentHidden()) {
        return
      }

      rafRef.current = requestAnimationFrame(frame)
    }

    const handleVisibilityChange = () => {
      if (reducedMotion) {
        return
      }

      if (isDocumentHidden()) {
        stopLoop()
        return
      }

      startLoop()
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    if (reducedMotion) {
      frame(0)
    } else {
      startLoop()
    }

    return () => {
      stopLoop()
      window.removeEventListener("resize", handleResize)
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      document.documentElement.removeAttribute("data-reduced-motion")
    }
    // Stable refs only — no reactive deps needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, dprCap, renderProfile])

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
}
