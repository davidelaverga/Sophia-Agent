"use client"

import { useRef, useCallback } from "react"

import type { ExpressionParams, Palette, NormalizedRGB } from "../../hooks/useExpression"

// ─── Ribbon data ─────────────────────────────────────────────────────────────

interface Ribbon {
  pts: { x: number; y: number }[]
  phase: number
  speed: number
  amplitude: number
  width: number
  opacity: number
}

const RIBBON_COUNT = 5
const SEGMENTS = 80
const SEGMENTS_MOBILE = 50

function createRibbons(w: number, h: number, segments: number): Ribbon[] {
  const ribbons: Ribbon[] = []
  for (let i = 0; i < RIBBON_COUNT; i++) {
    const pts = []
    const baseY = (0.25 + i * 0.12) * h
    for (let j = 0; j < segments; j++) {
      pts.push({ x: (j / segments) * w * 1.4 - w * 0.2, y: baseY })
    }
    ribbons.push({
      pts,
      phase: i * 1.3,
      speed: 0.15 + i * 0.04,
      amplitude: 35 + i * 12,
      width: 1.5 + i * 0.3,
      opacity: 0.15 - i * 0.02,
    })
  }
  return ribbons
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useRibbonCanvas({ reducedFidelity = false }: { reducedFidelity?: boolean } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ribbonsRef = useRef<Ribbon[]>([])

  const segments = reducedFidelity ? SEGMENTS_MOBILE : SEGMENTS

  const init = useCallback((w: number, h: number) => {
    ribbonsRef.current = createRibbons(w, h, segments)
  }, [segments])

  const resize = useCallback((w: number, h: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = w
    canvas.height = h
    ribbonsRef.current = createRibbons(w, h, segments)
  }, [segments])

  const render = useCallback(
    (
      time: number,
      params: ExpressionParams,
      palette: Palette,
      mouseX: number,
      mouseY: number
    ) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext("2d")
      if (!ctx) return

      const w = canvas.width
      const h = canvas.height
      const ribbons = ribbonsRef.current

      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = "screen"

      const pal = palette

      for (let ri = 0; ri < ribbons.length; ri++) {
        const r = ribbons[ri]
        const seg = r.pts.length

        // Update ribbon points
        for (let j = 0; j < seg; j++) {
          const t = j / seg
          const baseY = (0.3 + ri * 0.1) * h

          const speedMod = params.ribbonSpeed
          const ampMod = params.ribbonAmplitude
          const wave1 =
            Math.sin(t * 4 + time * r.speed * speedMod + r.phase) *
            r.amplitude *
            ampMod
          const wave2 =
            Math.sin(t * 7 - time * r.speed * 0.7 * speedMod + r.phase * 2) *
            r.amplitude *
            0.4 *
            ampMod
          const wave3 =
            Math.sin(t * 2.5 + time * r.speed * 0.3 * speedMod) *
            r.amplitude *
            0.6 *
            ampMod
          const mouseInfluence =
            Math.exp(-(((t - mouseX) * 3) ** 2)) * (mouseY - 0.5) * 40

          r.pts[j].x = (t * 1.4 - 0.2) * w
          r.pts[j].y = baseY + wave1 + wave2 + wave3 + mouseInfluence
        }

        const ribbonIntensity = params.flowEnergy * r.opacity

        // Helper to draw the bezier path
        const drawPath = () => {
          ctx.beginPath()
          ctx.moveTo(r.pts[0].x, r.pts[0].y)
          for (let j = 1; j < seg - 2; j++) {
            const xc = (r.pts[j].x + r.pts[j + 1].x) / 2
            const yc = (r.pts[j].y + r.pts[j + 1].y) / 2
            ctx.quadraticCurveTo(r.pts[j].x, r.pts[j].y, xc, yc)
          }
        }

        const toRgba = (c: NormalizedRGB, a: number) =>
          `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`

        // Outer glow
        drawPath()
        ctx.strokeStyle = toRgba(pal[2], ribbonIntensity * 0.25)
        ctx.lineWidth = r.width * 10
        ctx.shadowColor = toRgba(pal[2], ribbonIntensity * 0.35)
        ctx.shadowBlur = 25
        ctx.stroke()

        // Mid glow
        drawPath()
        ctx.strokeStyle = toRgba(pal[1], ribbonIntensity * 0.5)
        ctx.lineWidth = r.width * 4
        ctx.shadowBlur = 12
        ctx.stroke()

        // Hot core line
        drawPath()
        ctx.strokeStyle = `rgba(255,248,240,${ribbonIntensity * 0.6})`
        ctx.lineWidth = r.width * 0.8
        ctx.shadowColor = `rgba(255,248,240,${ribbonIntensity * 0.5})`
        ctx.shadowBlur = 4
        ctx.stroke()
      }

      // Core mask — fade ribbons near Sophia's center
      ctx.globalCompositeOperation = "destination-out"
      const coreX = w * 0.5
      const coreY = h * 0.5
      const maskRadius = Math.min(w, h) * 0.18
      const coreMask = ctx.createRadialGradient(coreX, coreY, 0, coreX, coreY, maskRadius)
      coreMask.addColorStop(0, "rgba(0,0,0,0.7)")
      coreMask.addColorStop(0.6, "rgba(0,0,0,0.2)")
      coreMask.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = coreMask
      ctx.fillRect(0, 0, w, h)

      ctx.shadowBlur = 0
      ctx.globalCompositeOperation = "source-over"
    },
    []
  )

  return { canvasRef, init, resize, render }
}
