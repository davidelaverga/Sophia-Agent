"use client"

import { useEffect, useRef } from "react"

import {
  formatBuilderArtifactTypeLabel,
  getBuilderArtifactFiles,
  normalizeBuilderArtifactPath,
} from "../../lib/builder-artifacts"
import {
  buildCoreviewBuilderMetadataText,
  registerCoreviewArtifactText,
} from "../../lib/coreview-artifact-text"
import type { BuilderArtifactV1 } from "../../types/builder-artifact"

const CANVAS_WIDTH = 960
const CANVAS_HEIGHT = 640
const MAX_DECISIONS = 4
const MAX_FILES = 4
const MAX_SOURCES = 4

interface CoreviewRealArtifactCanvasProps {
  artifactId: string
  builderArtifact: BuilderArtifactV1
  sessionId?: string | null
  normalSessionId?: string | null
  voiceAgentSessionId?: string | null
  threadId?: string | null
  artifactStableIdentity?: string | null
}

export function CoreviewRealArtifactCanvas({
  artifactId,
  builderArtifact,
  sessionId = null,
  normalSessionId = null,
  voiceAgentSessionId = null,
  threadId = null,
  artifactStableIdentity = null,
}: CoreviewRealArtifactCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => registerCoreviewArtifactText({
    artifactId,
    source: "builder_metadata",
    text: buildCoreviewBuilderMetadataText(builderArtifact),
    sessionIds: [sessionId, normalSessionId, voiceAgentSessionId],
    threadId,
    artifactStableIdentity,
  }), [artifactId, artifactStableIdentity, builderArtifact, normalSessionId, sessionId, threadId, voiceAgentSessionId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = getCanvasContext(canvas)
    if (!context) return

    drawBuilderArtifactOverview(context, canvas.width, canvas.height, builderArtifact)
  }, [builderArtifact])

  return (
    <div
      aria-hidden="true"
      data-coreview-artifact-region="true"
      data-artifact-region="true"
      data-coreview-session-id={sessionId ?? undefined}
      data-coreview-normal-session-id={normalSessionId ?? undefined}
      data-coreview-voice-session-id={voiceAgentSessionId ?? undefined}
      data-coreview-artifact-stable-identity={artifactStableIdentity ?? undefined}
      data-testid="coreview-real-artifact-canvas"
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
        data-coreview-voice-session-id={voiceAgentSessionId ?? undefined}
        data-coreview-artifact-stable-identity={artifactStableIdentity ?? undefined}
        aria-label="Builder artifact metadata overview canvas"
      />
    </div>
  )
}

export function buildCoreviewRealArtifactId(builderArtifact: BuilderArtifactV1): string {
  const normalizedPath = normalizeBuilderArtifactPath(builderArtifact.artifactPath)
  const source = normalizedPath || builderArtifact.artifactTitle || builderArtifact.artifactType || "builder-artifact"
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)

  return `coreview-real-artifact-${slug || "builder-artifact"}`
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d")
  } catch {
    return null
  }
}

function drawBuilderArtifactOverview(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  builderArtifact: BuilderArtifactV1,
) {
  const files = getBuilderArtifactFiles(builderArtifact).slice(0, MAX_FILES)
  const decisions = builderArtifact.decisionsMade.slice(0, MAX_DECISIONS)
  const sources = (builderArtifact.sourcesUsed ?? []).slice(0, MAX_SOURCES)
  const summary = sanitizeText(builderArtifact.companionSummary) || "Builder artifact metadata overview."
  const nextAction = sanitizeText(builderArtifact.userNextAction) || "Open the primary deliverable for exact content."
  const title = sanitizeText(builderArtifact.artifactTitle) || "Builder deliverable"
  const typeLabel = formatBuilderArtifactTypeLabel(builderArtifact.artifactType)

  context.clearRect(0, 0, width, height)

  const background = context.createLinearGradient(0, 0, width, height)
  background.addColorStop(0, "#140f24")
  background.addColorStop(0.58, "#1c1733")
  background.addColorStop(1, "#101a24")
  context.fillStyle = background
  context.fillRect(0, 0, width, height)

  context.fillStyle = "rgba(255, 255, 255, 0.05)"
  fillRoundedRect(context, 28, 28, width - 56, height - 56, 28)

  drawEyebrow(context, "Generated artifact", 56, 72)
  drawBadge(context, typeLabel, 56, 92)

  context.fillStyle = "#f7f2ff"
  context.font = "600 32px system-ui, sans-serif"
  drawWrappedText(context, title, 56, 154, 480, 40, 2)

  drawMetricCard(context, 710, 70, 182, 86, "Files", String(files.length))
  drawMetricCard(
    context,
    710,
    170,
    182,
    86,
    "Confidence",
    formatConfidence(builderArtifact.confidence),
  )
  drawMetricCard(
    context,
    710,
    270,
    182,
    86,
    "Steps",
    formatStepsCompleted(builderArtifact.stepsCompleted),
  )

  drawSection(context, {
    x: 56,
    y: 228,
    width: 600,
    height: 154,
    title: "What Sophia can see",
    body: summary,
    maxLines: 5,
  })

  drawSection(context, {
    x: 56,
    y: 400,
    width: 600,
    height: 120,
    title: "Next action",
    body: nextAction,
    maxLines: 3,
  })

  drawListSection(context, {
    x: 680,
    y: 382,
    width: 224,
    height: 116,
    title: "Decisions",
    items: decisions,
    emptyText: "No builder decisions recorded.",
  })

  drawListSection(context, {
    x: 56,
    y: 538,
    width: 404,
    height: 62,
    title: "Files",
    items: files.map((file) => file.label),
    emptyText: "No builder files attached.",
    compact: true,
  })

  drawListSection(context, {
    x: 480,
    y: 538,
    width: 424,
    height: 62,
    title: "Sources",
    items: sources,
    emptyText: "No sources listed.",
    compact: true,
  })

  context.fillStyle = "rgba(235, 228, 247, 0.58)"
  context.font = "12px system-ui, sans-serif"
  context.fillText("Metadata-only canvas. Builder file contents are intentionally excluded.", 56, 620)
}

function drawEyebrow(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  context.fillStyle = "rgba(214, 201, 244, 0.72)"
  context.font = "600 13px system-ui, sans-serif"
  context.fillText(text.toUpperCase(), x, y)
}

function drawBadge(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  const paddingX = 14
  const paddingY = 10
  const textWidth = measureTextWidth(context, text, "600 13px system-ui, sans-serif")
  const badgeWidth = textWidth + paddingX * 2

  context.fillStyle = "rgba(166, 129, 255, 0.14)"
  fillRoundedRect(context, x, y, badgeWidth, 34, 17)

  context.fillStyle = "#d9c8ff"
  context.font = "600 13px system-ui, sans-serif"
  context.fillText(text, x + paddingX, y + paddingY + 9)
}

function drawMetricCard(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
) {
  context.fillStyle = "rgba(255, 255, 255, 0.065)"
  fillRoundedRect(context, x, y, width, height, 20)

  context.fillStyle = "rgba(214, 201, 244, 0.7)"
  context.font = "600 12px system-ui, sans-serif"
  context.fillText(label.toUpperCase(), x + 18, y + 24)

  context.fillStyle = "#f7f2ff"
  context.font = "600 30px system-ui, sans-serif"
  context.fillText(value, x + 18, y + 62)
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
  context.fillStyle = "rgba(255, 255, 255, 0.06)"
  fillRoundedRect(context, section.x, section.y, section.width, section.height, 22)

  context.fillStyle = "#f7f2ff"
  context.font = "600 18px system-ui, sans-serif"
  context.fillText(section.title, section.x + 22, section.y + 30)

  context.fillStyle = "rgba(244, 239, 255, 0.85)"
  context.font = "15px system-ui, sans-serif"
  drawWrappedText(
    context,
    section.body,
    section.x + 22,
    section.y + 62,
    section.width - 44,
    22,
    section.maxLines,
  )
}

function drawListSection(
  context: CanvasRenderingContext2D,
  section: {
    x: number
    y: number
    width: number
    height: number
    title: string
    items: string[]
    emptyText: string
    compact?: boolean
  },
) {
  context.fillStyle = "rgba(255, 255, 255, 0.06)"
  fillRoundedRect(context, section.x, section.y, section.width, section.height, 20)

  context.fillStyle = "#f7f2ff"
  context.font = "600 16px system-ui, sans-serif"
  context.fillText(section.title, section.x + 18, section.y + 26)

  const items = section.items.length > 0 ? section.items : [section.emptyText]
  const baseY = section.y + 48
  const lineHeight = section.compact ? 18 : 20

  context.fillStyle = "rgba(244, 239, 255, 0.82)"
  context.font = `${section.compact ? "13px" : "14px"} system-ui, sans-serif`

  items.slice(0, section.compact ? 2 : 4).forEach((item, index) => {
    const prefix = section.items.length > 0 ? "- " : ""
    const text = prefix + sanitizeText(item)
    drawSingleLineText(context, text, section.x + 18, baseY + index * lineHeight, section.width - 36)
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
  const lines = wrapText(context, text, maxWidth)
  const clampedLines = lines.slice(0, maxLines)

  clampedLines.forEach((line, index) => {
    const isLastVisibleLine = index === maxLines - 1 && lines.length > maxLines
    const value = isLastVisibleLine ? truncateLine(context, line, maxWidth) : line
    context.fillText(value, x, y + index * lineHeight)
  })
}

function drawSingleLineText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
) {
  context.fillText(truncateLine(context, text, maxWidth, false), x, y)
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = sanitizeText(text).split(/\s+/u).filter(Boolean)
  if (words.length === 0) {
    return [""]
  }

  const lines: string[] = []
  let currentLine = ""

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word
    if (measureTextWidth(context, candidate) <= maxWidth) {
      currentLine = candidate
      continue
    }

    if (currentLine) {
      lines.push(currentLine)
      currentLine = word
      continue
    }

    lines.push(truncateLine(context, word, maxWidth, false))
    currentLine = ""
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines
}

function truncateLine(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  includeEllipsis = true,
): string {
  const suffix = includeEllipsis ? "..." : ""
  if (measureTextWidth(context, text) <= maxWidth) {
    return text
  }

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

function formatConfidence(confidence: number | undefined): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return "--"
  }
  return `${Math.round(confidence * 100)}%`
}

function formatStepsCompleted(stepsCompleted: number | undefined): string {
  if (typeof stepsCompleted !== "number" || !Number.isFinite(stepsCompleted)) {
    return "--"
  }
  return String(Math.max(0, Math.round(stepsCompleted)))
}

function measureTextWidth(
  context: CanvasRenderingContext2D,
  text: string,
  font?: string,
): number {
  const previousFont = context.font
  if (font) {
    context.font = font
  }

  const width = typeof context.measureText === "function"
    ? context.measureText(text).width
    : text.length * 8

  if (font) {
    context.font = previousFont
  }

  return width
}
