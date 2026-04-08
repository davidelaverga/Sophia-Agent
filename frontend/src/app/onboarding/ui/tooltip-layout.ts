import type { OnboardingTargetRect, OnboardingTooltipPosition } from "../types"

export const TOOLTIP_MIN_WIDTH = 340
export const TOOLTIP_MAX_WIDTH = 520
export const TOOLTIP_DEFAULT_HEIGHT = 600
export const TOOLTIP_EDGE_PADDING = 16
export const TOOLTIP_TARGET_GAP = 16
export const TOOLTIP_BOTTOM_SHEET_BREAKPOINT = 360
export const TOOLTIP_ARROW_SIZE = 8
const TOOLTIP_CORNER_PADDING = 24

export type TooltipPlacement = OnboardingTooltipPosition | "bottom-sheet"

export type TooltipArrowLayout = {
  side: "top" | "bottom" | "left" | "right"
  offset: number
}

export type TooltipLayoutInput = {
  preferredPosition: OnboardingTooltipPosition
  targetRect: OnboardingTargetRect | null
  viewportWidth: number
  viewportHeight: number
  tooltipWidth: number
  tooltipHeight: number
  edgePadding?: number
  gap?: number
  bottomSheetBreakpoint?: number
}

export type TooltipLayoutResult = {
  placement: TooltipPlacement
  top: number
  left: number
  width: number
  maxWidth: number
  maxHeight: number
  arrow: TooltipArrowLayout | null
  isBottomSheet: boolean
  transformOrigin: string
}

type CandidatePlacement = Exclude<TooltipPlacement, "bottom-sheet">

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function getOppositePlacement(placement: CandidatePlacement): CandidatePlacement {
  switch (placement) {
    case "top":
      return "bottom"
    case "bottom":
      return "top"
    case "left":
      return "right"
    case "right":
      return "left"
    default:
      return "center"
  }
}

function getPlacementOrder(preferredPosition: CandidatePlacement, hasTarget: boolean): CandidatePlacement[] {
  if (!hasTarget || preferredPosition === "center") {
    return ["center"]
  }

  const oppositePlacement = getOppositePlacement(preferredPosition)
  const fallbackPlacements: CandidatePlacement[] = ["top", "bottom", "left", "right", "center"]

  return [preferredPosition, oppositePlacement, ...fallbackPlacements.filter((placement) => placement !== preferredPosition && placement !== oppositePlacement)]
}

function createCenteredLayout(
  viewportWidth: number,
  viewportHeight: number,
  tooltipWidth: number,
  tooltipHeight: number,
  edgePadding: number,
): TooltipLayoutResult {
  const width = Math.min(tooltipWidth, viewportWidth - edgePadding * 2)
  const height = Math.min(tooltipHeight, viewportHeight - edgePadding * 2)

  return {
    placement: "center",
    top: clamp((viewportHeight - height) / 2, edgePadding, Math.max(edgePadding, viewportHeight - height - edgePadding)),
    left: clamp((viewportWidth - width) / 2, edgePadding, Math.max(edgePadding, viewportWidth - width - edgePadding)),
    width,
    maxWidth: width,
    maxHeight: height,
    arrow: null,
    isBottomSheet: false,
    transformOrigin: "center center",
  }
}

function createBottomSheetLayout(
  viewportWidth: number,
  viewportHeight: number,
  tooltipHeight: number,
  edgePadding: number,
): TooltipLayoutResult {
  const width = Math.max(0, viewportWidth - edgePadding * 2)
  const maxHeight = Math.min(Math.max(tooltipHeight, 180), Math.round(viewportHeight * 0.7))

  return {
    placement: "bottom-sheet",
    top: Math.max(edgePadding, viewportHeight - maxHeight - edgePadding),
    left: edgePadding,
    width,
    maxWidth: width,
    maxHeight,
    arrow: null,
    isBottomSheet: true,
    transformOrigin: "center bottom",
  }
}

function getCandidateLayout(
  placement: CandidatePlacement,
  targetRect: OnboardingTargetRect,
  viewportWidth: number,
  viewportHeight: number,
  tooltipWidth: number,
  tooltipHeight: number,
  edgePadding: number,
  gap: number,
): TooltipLayoutResult {
  const targetCenterX = targetRect.left + targetRect.width / 2
  const targetCenterY = targetRect.top + targetRect.height / 2
  const constrainedWidth = Math.min(tooltipWidth, viewportWidth - edgePadding * 2)
  const constrainedHeight = Math.min(tooltipHeight, viewportHeight - edgePadding * 2)

  if (placement === "center") {
    return createCenteredLayout(viewportWidth, viewportHeight, tooltipWidth, tooltipHeight, edgePadding)
  }

  if (placement === "top" || placement === "bottom") {
    const top = placement === "top"
      ? targetRect.top - constrainedHeight - gap
      : targetRect.bottom + gap
    const left = clamp(
      targetCenterX - constrainedWidth / 2,
      edgePadding,
      Math.max(edgePadding, viewportWidth - constrainedWidth - edgePadding),
    )
    const offset = clamp(targetCenterX - left, TOOLTIP_CORNER_PADDING, constrainedWidth - TOOLTIP_CORNER_PADDING)

    return {
      placement,
      top,
      left,
      width: constrainedWidth,
      maxWidth: constrainedWidth,
      maxHeight: constrainedHeight,
      arrow: {
        side: placement === "top" ? "bottom" : "top",
        offset,
      },
      isBottomSheet: false,
      transformOrigin: `${offset}px ${placement === "top" ? `${constrainedHeight}px` : "0px"}`,
    }
  }

  const left = placement === "left"
    ? targetRect.left - constrainedWidth - gap
    : targetRect.right + gap
  const top = clamp(
    targetCenterY - constrainedHeight / 2,
    edgePadding,
    Math.max(edgePadding, viewportHeight - constrainedHeight - edgePadding),
  )
  const offset = clamp(targetCenterY - top, TOOLTIP_CORNER_PADDING, constrainedHeight - TOOLTIP_CORNER_PADDING)

  return {
    placement,
    top,
    left,
    width: constrainedWidth,
    maxWidth: constrainedWidth,
    maxHeight: constrainedHeight,
    arrow: {
      side: placement === "left" ? "right" : "left",
      offset,
    },
    isBottomSheet: false,
    transformOrigin: `${placement === "left" ? `${constrainedWidth}px` : "0px"} ${offset}px`,
  }
}

function getOverflowScore(layout: TooltipLayoutResult, viewportWidth: number, viewportHeight: number, edgePadding: number): number {
  const right = layout.left + layout.width
  const bottom = layout.top + layout.maxHeight

  const leftOverflow = Math.max(0, edgePadding - layout.left)
  const rightOverflow = Math.max(0, right - (viewportWidth - edgePadding))
  const topOverflow = Math.max(0, edgePadding - layout.top)
  const bottomOverflow = Math.max(0, bottom - (viewportHeight - edgePadding))

  return leftOverflow + rightOverflow + topOverflow + bottomOverflow
}

export function resolveTooltipLayout({
  preferredPosition,
  targetRect,
  viewportWidth,
  viewportHeight,
  tooltipWidth,
  tooltipHeight,
  edgePadding = TOOLTIP_EDGE_PADDING,
  gap = TOOLTIP_TARGET_GAP,
  bottomSheetBreakpoint = TOOLTIP_BOTTOM_SHEET_BREAKPOINT,
}: TooltipLayoutInput): TooltipLayoutResult {
  if (viewportWidth <= bottomSheetBreakpoint) {
    return createBottomSheetLayout(viewportWidth, viewportHeight, tooltipHeight, edgePadding)
  }

  if (!targetRect) {
    return createCenteredLayout(viewportWidth, viewportHeight, tooltipWidth, tooltipHeight, edgePadding)
  }

  const placements = getPlacementOrder(preferredPosition, Boolean(targetRect))

  let bestLayout = createCenteredLayout(viewportWidth, viewportHeight, tooltipWidth, tooltipHeight, edgePadding)
  let bestScore = Number.POSITIVE_INFINITY

  for (const placement of placements) {
    const candidate = getCandidateLayout(
      placement,
      targetRect,
      viewportWidth,
      viewportHeight,
      tooltipWidth,
      tooltipHeight,
      edgePadding,
      gap,
    )

    const score = getOverflowScore(candidate, viewportWidth, viewportHeight, edgePadding)
    if (score === 0) {
      return candidate
    }

    if (score < bestScore) {
      bestLayout = candidate
      bestScore = score
    }
  }

  return {
    ...bestLayout,
    top: clamp(bestLayout.top, edgePadding, Math.max(edgePadding, viewportHeight - bestLayout.maxHeight - edgePadding)),
    left: clamp(bestLayout.left, edgePadding, Math.max(edgePadding, viewportWidth - bestLayout.width - edgePadding)),
  }
}