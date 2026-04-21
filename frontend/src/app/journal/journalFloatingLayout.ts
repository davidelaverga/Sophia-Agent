type FloatingBoxLayoutArgs = {
  anchorX: number
  anchorY: number
  boxWidth: number
  boxHeight: number
  viewportWidth: number
  viewportHeight: number
  margin?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function clampHorizontalPosition(anchorX: number, boxWidth: number, viewportWidth: number, margin: number): number {
  const maxLeft = Math.max(margin, viewportWidth - margin - boxWidth)
  return clamp(anchorX - boxWidth / 2, margin, maxLeft)
}

export function getHoverLabelPosition({
  anchorX,
  anchorY,
  boxWidth,
  boxHeight,
  viewportWidth,
  viewportHeight,
  margin = 12,
}: FloatingBoxLayoutArgs): { left: number; top: number } {
  const maxTop = Math.max(margin, viewportHeight - margin - boxHeight)
  const preferredTop = anchorY - boxHeight - 14
  const fallbackTop = anchorY + 20
  const top = clamp(preferredTop < margin ? fallbackTop : preferredTop, margin, maxTop)

  return {
    left: clampHorizontalPosition(anchorX, boxWidth, viewportWidth, margin),
    top,
  }
}

export function getDetailPanelPosition({
  anchorX,
  anchorY,
  boxWidth,
  boxHeight,
  viewportWidth,
  viewportHeight,
  margin = 12,
}: FloatingBoxLayoutArgs): { left: number; top: number } {
  const maxTop = Math.max(margin, viewportHeight - margin - boxHeight)
  const preferredTop = anchorY - boxHeight - 28
  const fallbackTop = anchorY + 32
  const top = preferredTop < margin
    ? clamp(fallbackTop, margin, maxTop)
    : clamp(preferredTop, margin, maxTop)

  return {
    left: clampHorizontalPosition(anchorX, boxWidth, viewportWidth, margin),
    top,
  }
}