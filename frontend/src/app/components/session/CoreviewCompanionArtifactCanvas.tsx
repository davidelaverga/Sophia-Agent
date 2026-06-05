"use client"

import { useEffect, useRef } from "react"

import {
  buildCoreviewCompanionArtifactText,
  registerCoreviewArtifactText,
} from "../../lib/coreview-artifact-text"
import type { RitualArtifacts } from "../../types/session"

export const COREVIEW_COMPANION_ARTIFACT_ID = "coreview-companion-artifact-panel"

const CANVAS_WIDTH = 900
const CANVAS_HEIGHT = 560

interface CoreviewCompanionArtifactCanvasProps {
  artifacts: RitualArtifacts
  artifactId?: string
  sessionId?: string | null
  normalSessionId?: string | null
  threadId?: string | null
}

export function CoreviewCompanionArtifactCanvas({
  artifacts,
  artifactId = COREVIEW_COMPANION_ARTIFACT_ID,
  sessionId = null,
  normalSessionId = null,
  threadId = null,
}: CoreviewCompanionArtifactCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const text = buildCoreviewCompanionArtifactText(artifacts)
    if (!text) return undefined

    return registerCoreviewArtifactText({
      artifactId,
      source: "artifact_store",
      text,
      sessionIds: [sessionId, normalSessionId],
      threadId,
    })
  }, [artifactId, artifacts, normalSessionId, sessionId, threadId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = getCanvasContext(canvas)
    if (!context) return

    drawCompanionArtifactOverview(context, canvas.width, canvas.height, artifacts)
  }, [artifacts])

  return (
    <div
      aria-hidden="true"
      data-coreview-artifact-region="true"
      data-artifact-region="true"
      data-coreview-session-id={sessionId ?? undefined}
      data-coreview-normal-session-id={normalSessionId ?? undefined}
      data-testid="coreview-companion-artifact-canvas"
      className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
      style={{ inset: 0 }}
    >
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        data-artifact-id={artifactId}
        data-coreview-artifact-id={artifactId}
        data-artifact-canvas="true"
        data-coreview-artifact-canvas="true"
        data-coreview-offscreen-render="true"
        data-coreview-session-id={sessionId ?? undefined}
        data-coreview-normal-session-id={normalSessionId ?? undefined}
        aria-label="Companion artifact overview canvas"
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

function drawCompanionArtifactOverview(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  artifacts: RitualArtifacts,
) {
  const takeaway = sanitizeText(artifacts.takeaway)
  const reflection = sanitizeText(artifacts.reflection_candidate?.prompt)
  const reflectionWhy = sanitizeText(artifacts.reflection_candidate?.why)
  const memories = (artifacts.memory_candidates ?? [])
    .map((candidate) => sanitizeText(candidate.memory || candidate.category))
    .filter(Boolean)
    .slice(0, 5)

  context.clearRect(0, 0, width, height)

  const background = context.createLinearGradient(0, 0, width, height)
  background.addColorStop(0, "#111827")
  background.addColorStop(0.55, "#1d1930")
  background.addColorStop(1, "#0f1f22")
  context.fillStyle = background
  context.fillRect(0, 0, width, height)

  context.fillStyle = "rgba(255, 255, 255, 0.055)"
  fillRoundedRect(context, 28, 28, width - 56, height - 56, 24)

  context.fillStyle = "rgba(214, 201, 244, 0.75)"
  context.font = "600 13px system-ui, sans-serif"
  context.fillText("SESSION ARTIFACT", 52, 70)

  context.fillStyle = "#f7f2ff"
  context.font = "600 34px system-ui, sans-serif"
  context.fillText("Sophia artifact review", 52, 116)

  drawSection(context, {
    x: 52,
    y: 154,
    width: 560,
    height: 128,
    title: "Takeaway",
    body: takeaway || "No takeaway recorded.",
    maxLines: 4,
  })

  drawSection(context, {
    x: 52,
    y: 304,
    width: 560,
    height: 126,
    title: "Reflection",
    body: [reflection, reflectionWhy].filter(Boolean).join(" - ") || "No reflection prompt recorded.",
    maxLines: 4,
  })

  drawMetric(context, 650, 154, "Memories", String(memories.length))
  drawMetric(context, 650, 256, "Exact text", "available")

  drawList(context, {
    x: 650,
    y: 354,
    width: 240,
    height: 138,
    title: "Memory candidates",
    items: memories,
    emptyText: "No memory candidates recorded.",
  })

  context.fillStyle = "rgba(235, 228, 247, 0.58)"
  context.font = "12px system-ui, sans-serif"
  context.fillText("Artifact-scoped still frame. Exact words are read from the trusted text sideband.", 52, height - 36)
}

function drawSection(
  context: CanvasRenderingContext2D,
  section: {
    x: number
    y: number
    width: number
    height: number
    title: string
    body: string
    maxLines: number
  },
) {
  context.fillStyle = "rgba(255, 255, 255, 0.07)"
  fillRoundedRect(context, section.x, section.y, section.width, section.height, 20)

  context.fillStyle = "#f7f2ff"
  context.font = "600 17px system-ui, sans-serif"
  context.fillText(section.title, section.x + 20, section.y + 30)

  context.fillStyle = "rgba(244, 239, 255, 0.84)"
  context.font = "15px system-ui, sans-serif"
  drawWrappedText(context, section.body, section.x + 20, section.y + 62, section.width - 40, 22, section.maxLines)
}

function drawMetric(context: CanvasRenderingContext2D, x: number, y: number, label: string, value: string) {
  context.fillStyle = "rgba(255, 255, 255, 0.07)"
  fillRoundedRect(context, x, y, 220, 78, 20)
  context.fillStyle = "rgba(214, 201, 244, 0.72)"
  context.font = "600 12px system-ui, sans-serif"
  context.fillText(label.toUpperCase(), x + 18, y + 24)
  context.fillStyle = "#f7f2ff"
  context.font = "600 24px system-ui, sans-serif"
  context.fillText(value, x + 18, y + 56)
}

function drawList(
  context: CanvasRenderingContext2D,
  section: {
    x: number
    y: number
    width: number
    height: number
    title: string
    items: string[]
    emptyText: string
  },
) {
  context.fillStyle = "rgba(255, 255, 255, 0.07)"
  fillRoundedRect(context, section.x, section.y, section.width, section.height, 20)

  context.fillStyle = "#f7f2ff"
  context.font = "600 15px system-ui, sans-serif"
  context.fillText(section.title, section.x + 18, section.y + 27)

  context.fillStyle = "rgba(244, 239, 255, 0.82)"
  context.font = "13px system-ui, sans-serif"
  const items = section.items.length > 0 ? section.items : [section.emptyText]
  items.slice(0, 4).forEach((item, index) => {
    drawSingleLineText(context, `${section.items.length > 0 ? "- " : ""}${item}`, section.x + 18, section.y + 54 + index * 20, section.width - 36)
  })
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  wrapText(context, text, maxWidth).slice(0, maxLines).forEach((line, index) => {
    context.fillText(index === maxLines - 1 ? truncateLine(context, line, maxWidth) : line, x, y + index * lineHeight)
  })
}

function drawSingleLineText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number) {
  context.fillText(truncateLine(context, text, maxWidth, false), x, y)
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = sanitizeText(text).split(/\s+/u).filter(Boolean)
  const lines: string[] = []
  let line = ""

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (measureTextWidth(context, candidate) <= maxWidth) {
      line = candidate
    } else {
      if (line) lines.push(line)
      line = word
    }
  }

  if (line) lines.push(line)
  return lines.length ? lines : [""]
}

function truncateLine(context: CanvasRenderingContext2D, text: string, maxWidth: number, includeEllipsis = true): string {
  const suffix = includeEllipsis ? "..." : ""
  if (measureTextWidth(context, text) <= maxWidth) return text

  let result = text
  while (result.length > 0 && measureTextWidth(context, `${result}${suffix}`) > maxWidth) {
    result = result.slice(0, -1)
  }
  return `${result.trimEnd()}${suffix}`
}

function fillRoundedRect(
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
  context.fill()
}

function sanitizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function measureTextWidth(context: CanvasRenderingContext2D, text: string): number {
  return typeof context.measureText === "function" ? context.measureText(text).width : text.length * 8
}
