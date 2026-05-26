"use client"

import { useEffect, useRef } from "react"

export const COREVIEW_FIXTURE_ARTIFACT_ID = "coreview-fixture-q3-launch-review"

interface CoreviewFixtureArtifactProps {
  sessionId?: string | null
  normalSessionId?: string | null
}

export function CoreviewFixtureArtifact({
  sessionId = null,
  normalSessionId = null,
}: CoreviewFixtureArtifactProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = getCanvasContext(canvas)
    if (!context) return

    drawQ3LaunchFixture(context, canvas.width, canvas.height)
  }, [])

  return (
    <div
      data-coreview-artifact-region="true"
      data-artifact-region="true"
      data-coreview-session-id={sessionId ?? undefined}
      data-coreview-normal-session-id={normalSessionId ?? undefined}
      data-testid="coreview-fixture-artifact"
      className="mx-auto w-full max-w-[360px] overflow-hidden rounded-2xl border"
      style={{
        borderColor: "color-mix(in srgb, var(--sophia-purple) 24%, var(--cosmic-border-soft))",
        background: "color-mix(in srgb, var(--cosmic-panel) 88%, transparent)",
      }}
    >
      <canvas
        ref={canvasRef}
        width={720}
        height={460}
        data-artifact-id={COREVIEW_FIXTURE_ARTIFACT_ID}
        data-coreview-artifact-id={COREVIEW_FIXTURE_ARTIFACT_ID}
        data-coreview-session-id={sessionId ?? undefined}
        data-coreview-normal-session-id={normalSessionId ?? undefined}
        data-artifact-canvas="true"
        data-coreview-artifact-canvas="true"
        aria-label="Q3 Launch Review fixture artifact"
        className="block h-auto w-full"
      />
    </div>
  )
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d")
  } catch {
    return null
  }
}

function drawQ3LaunchFixture(context: CanvasRenderingContext2D, width: number, height: number) {
  context.clearRect(0, 0, width, height)

  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, "#18142a")
  gradient.addColorStop(0.55, "#221b37")
  gradient.addColorStop(1, "#101820")
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)

  context.fillStyle = "rgba(216, 196, 255, 0.08)"
  context.fillRect(24, 24, width - 48, height - 48)

  context.fillStyle = "#f5f1ff"
  context.font = "600 34px system-ui, sans-serif"
  context.fillText("Q3 Launch Review", 48, 72)

  drawBlock(context, 48, 112, 288, 132, "Strengths", [
    "Partner pipeline expanded",
    "North region leads demand",
    "Launch story is crisp",
  ], "#9ee6cf")

  drawBlock(context, 384, 112, 288, 132, "Risks", [
    "Budget delta is 17.4%",
    "Enablement assets lag",
    "QA window is tight",
  ], "#f0b6c6")

  drawBarChart(context, 56, 290)
  drawTinyTable(context, 426, 286)

  context.fillStyle = "rgba(245, 241, 255, 0.58)"
  context.font = "12px system-ui, sans-serif"
  context.fillText("fine print: budget delta is 17.4%", 48, height - 38)
}

function drawBlock(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
  lines: string[],
  accent: string,
) {
  context.fillStyle = "rgba(255, 255, 255, 0.075)"
  roundRect(context, x, y, width, height, 18)
  context.fill()

  context.fillStyle = accent
  context.font = "700 20px system-ui, sans-serif"
  context.fillText(title, x + 22, y + 36)

  context.fillStyle = "rgba(245, 241, 255, 0.84)"
  context.font = "15px system-ui, sans-serif"
  lines.forEach((line, index) => {
    context.fillText(line, x + 22, y + 68 + index * 24)
  })
}

function drawBarChart(context: CanvasRenderingContext2D, x: number, y: number) {
  context.fillStyle = "rgba(255, 255, 255, 0.075)"
  roundRect(context, x - 8, y - 34, 292, 112, 18)
  context.fill()

  context.fillStyle = "#f5f1ff"
  context.font = "700 16px system-ui, sans-serif"
  context.fillText("Launch readiness", x, y - 10)

  const bars = [
    { label: "Brand", value: 82, color: "#b8a4e8" },
    { label: "Sales", value: 68, color: "#9ee6cf" },
    { label: "Ops", value: 54, color: "#f0b6c6" },
  ]

  bars.forEach((bar, index) => {
    const barY = y + index * 26
    context.fillStyle = "rgba(245, 241, 255, 0.6)"
    context.font = "12px system-ui, sans-serif"
    context.fillText(bar.label, x, barY + 12)
    context.fillStyle = "rgba(255, 255, 255, 0.12)"
    context.fillRect(x + 58, barY, 172, 14)
    context.fillStyle = bar.color
    context.fillRect(x + 58, barY, Math.round(172 * (bar.value / 100)), 14)
    context.fillStyle = "rgba(245, 241, 255, 0.74)"
    context.fillText(`${bar.value}%`, x + 240, barY + 12)
  })
}

function drawTinyTable(context: CanvasRenderingContext2D, x: number, y: number) {
  context.fillStyle = "rgba(255, 255, 255, 0.075)"
  roundRect(context, x - 8, y - 34, 232, 112, 18)
  context.fill()

  context.fillStyle = "#f5f1ff"
  context.font = "700 16px system-ui, sans-serif"
  context.fillText("Regional signal", x, y - 10)

  context.strokeStyle = "rgba(245, 241, 255, 0.18)"
  context.strokeRect(x, y + 4, 196, 48)
  context.beginPath()
  context.moveTo(x, y + 28)
  context.lineTo(x + 196, y + 28)
  context.moveTo(x + 110, y + 4)
  context.lineTo(x + 110, y + 52)
  context.stroke()

  context.fillStyle = "rgba(245, 241, 255, 0.72)"
  context.font = "13px system-ui, sans-serif"
  context.fillText("Region", x + 12, y + 22)
  context.fillText("Score", x + 122, y + 22)
  context.fillStyle = "#9ee6cf"
  context.font = "700 14px system-ui, sans-serif"
  context.fillText("North", x + 12, y + 46)
  context.fillText("42", x + 122, y + 46)
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}
