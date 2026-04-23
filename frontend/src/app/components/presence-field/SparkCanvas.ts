"use client"

import { useRef, useCallback } from "react"

import type { ExpressionParams, Palette } from "../../hooks/useExpression"

// ─── Particle data ───────────────────────────────────────────────────────────

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  alpha: number
  phase: number
  twinkleSpeed: number
  depth: number
}

const DEFAULT_SPARK_COUNT = 200
const DEFAULT_SPEAKING_BURST_COUNT = 4

function createSparks(w: number, h: number, count: number): Spark[] {
  const sparks: Spark[] = []
  for (let i = 0; i < count; i++) {
    sparks.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.08,
      vy: (Math.random() - 0.5) * 0.06 - 0.025,
      size: Math.random() * 1.8 + 0.3,
      alpha: Math.random() * 0.6 + 0.1,
      phase: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.25 + Math.random() * 1,
      depth: Math.random(),
    })
  }
  return sparks
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSparkCanvas({
  sparkCount = DEFAULT_SPARK_COUNT,
  speakingBurstCount = DEFAULT_SPEAKING_BURST_COUNT,
}: {
  sparkCount?: number
  speakingBurstCount?: number
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sparksRef = useRef<Spark[]>([])
  const lastBurstRef = useRef(0)

  const init = useCallback((w: number, h: number) => {
    sparksRef.current = createSparks(w, h, sparkCount)
  }, [sparkCount])

  const resize = useCallback((w: number, h: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = w
    canvas.height = h
    // Keep existing sparks but rescatter any outside bounds
    for (const s of sparksRef.current) {
      if (s.x > w) s.x = Math.random() * w
      if (s.y > h) s.y = Math.random() * h
    }
    if (sparksRef.current.length === 0) {
      sparksRef.current = createSparks(w, h, sparkCount)
    }
  }, [sparkCount])

  const render = useCallback(
    (
      time: number,
      params: ExpressionParams,
      palette: Palette,
      mouseX: number,
      mouseY: number,
      isSpeaking: boolean
    ) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext("2d")
      if (!ctx) return

      const w = canvas.width
      const h = canvas.height
      const sparks = sparksRef.current
      const pal = palette

      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = "screen"

      // Speaking rhythm — periodic spark bursts near center
      if (isSpeaking && time - lastBurstRef.current > 0.6) {
        lastBurstRef.current = time
        for (let i = 0; i < speakingBurstCount; i++) {
          const idx = Math.floor(Math.random() * sparks.length)
          const s = sparks[idx]
          s.x = w * 0.5 + (Math.random() - 0.5) * w * 0.3
          s.y = h * 0.4 + (Math.random() - 0.5) * h * 0.2
          s.alpha = 0.5 + Math.random() * 0.4
          s.size = 1.5 + Math.random() * 1.5
          s.vx = (Math.random() - 0.5) * 0.35
          s.vy = (Math.random() - 0.5) * 0.2 - 0.05
        }
      }

      for (const s of sparks) {
        const parallax = 0.3 + s.depth * 0.7
        const drift = params.particleDrift
        const cx = w * 0.5
        const cy = h * 0.4
        const dxc = s.x - cx
        const dyc = s.y - cy
        const distFromCenter = Math.sqrt(dxc * dxc + dyc * dyc) + 0.001
        const driftX = (dxc / distFromCenter) * drift * 0.15
        const driftY = (dyc / distFromCenter) * drift * 0.1

        // Thinking swirl
        const swirlAmount = (1 - Math.abs(drift)) * 0.08
        const swirlX = (-dyc / distFromCenter) * swirlAmount
        const swirlY = (dxc / distFromCenter) * swirlAmount

        s.x += s.vx + (mouseX - 0.5) * 0.3 * parallax + driftX + swirlX
        s.y += s.vy + driftY + swirlY

        // Wrap
        if (s.x < -10) s.x = w + 10
        if (s.x > w + 10) s.x = -10
        if (s.y < -10) s.y = h + 10
        if (s.y > h + 10) s.y = -10

        // Twinkle
        const twinkle = (Math.sin(time * s.twinkleSpeed + s.phase) * 0.5 + 0.5) ** 3
        const alpha = s.alpha * twinkle * params.particleAlpha
        if (alpha < 0.01) continue

        // Color
        const colorMix = s.depth
        const r = lerp(pal[2][0], 1, colorMix) * 255
        const g = lerp(pal[2][1], 0.95, colorMix) * 255
        const b = lerp(pal[2][2], 0.9, colorMix) * 255
        const size = s.size * (0.8 + twinkle * 0.5)

        // Mouse repulsion
        const dxm = s.x - mouseX * w
        const dym = s.y - mouseY * h
        const distSq = dxm * dxm + dym * dym
        const repelRadius = 70
        if (distSq < repelRadius * repelRadius && distSq > 1) {
          const dist = Math.sqrt(distSq)
          const force = (1 - dist / repelRadius) * 0.5
          s.x += (dxm / dist) * force
          s.y += (dym / dist) * force
        }

        // Glow
        const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, size * 4)
        grad.addColorStop(
          0,
          `rgba(${r | 0},${g | 0},${b | 0},${alpha * 0.6})`
        )
        grad.addColorStop(1, `rgba(${r | 0},${g | 0},${b | 0},0)`)
        ctx.fillStyle = grad
        ctx.fillRect(s.x - size * 4, s.y - size * 4, size * 8, size * 8)

        // Core
        ctx.beginPath()
        ctx.arc(s.x, s.y, size * 0.5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,250,245,${alpha})`
        ctx.fill()

        // Cross sparkle for brighter particles
        if (alpha > 0.2 && s.size > 1.2) {
          ctx.strokeStyle = `rgba(255,250,245,${alpha * 0.4})`
          ctx.lineWidth = 0.5
          const len = size * 3
          ctx.beginPath()
          ctx.moveTo(s.x - len, s.y)
          ctx.lineTo(s.x + len, s.y)
          ctx.moveTo(s.x, s.y - len)
          ctx.lineTo(s.x, s.y + len)
          ctx.stroke()
        }
      }

      ctx.globalCompositeOperation = "source-over"
    },
    [speakingBurstCount]
  )

  return { canvasRef, init, resize, render }
}
