"use client"

import { useId } from "react"
import type { OnboardingTargetRect, OnboardingTargetShape } from "../types"
import { cn } from "../../lib/utils"
import { useOnboardingReducedMotion } from "./useOnboardingReducedMotion"
import { useViewportSize } from "./useViewportSize"

type SpotlightOverlayProps = {
  open?: boolean
  targetRect: OnboardingTargetRect | null
  targetRects?: OnboardingTargetRect[]
  shape?: OnboardingTargetShape
  padding?: number
  reducedMotion?: boolean
  className?: string
}

function getExpandedRect(targetRect: OnboardingTargetRect, padding: number): OnboardingTargetRect {
  return {
    x: targetRect.x - padding,
    y: targetRect.y - padding,
    width: targetRect.width + padding * 2,
    height: targetRect.height + padding * 2,
    top: targetRect.top - padding,
    right: targetRect.right + padding,
    bottom: targetRect.bottom + padding,
    left: targetRect.left - padding,
  }
}

export function SpotlightOverlay({
  open = true,
  targetRect,
  targetRects,
  shape = "rounded-rect",
  padding = 12,
  reducedMotion,
  className,
}: SpotlightOverlayProps) {
  const maskId = useId()
  const motionPreference = useOnboardingReducedMotion()
  const isReducedMotion = reducedMotion ?? motionPreference
  const viewport = useViewportSize()

  if (!open || viewport.width === 0 || viewport.height === 0) {
    return null
  }

  const spotlightRects = (targetRects?.length ? targetRects : targetRect ? [targetRect] : [])
    .map((rect) => getExpandedRect(rect, padding))
  const transition = isReducedMotion ? "none" : "all 500ms cubic-bezier(0.4, 0, 0.2, 1)"

  return (
    <div className={cn("pointer-events-none fixed inset-0 z-[70] overflow-hidden", className)} aria-hidden="true">
      <div
        className="absolute inset-0"
        style={{
          background: "rgba(8, 5, 16, 0.10)",
          transition: isReducedMotion ? "opacity 0ms linear" : "opacity 400ms ease-out",
          opacity: 1,
        }}
      />

      <svg
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <mask id={maskId}>
            <rect x="0" y="0" width={viewport.width} height={viewport.height} fill="white" />
            {spotlightRects.map((spotlightRect, index) => {
              const cutoutRadius = Math.max(20, Math.min(24, spotlightRect.height / 2, spotlightRect.width / 2))

              if (shape === "circle") {
                return (
                  <circle
                    key={`mask-circle-${index}`}
                    cx={spotlightRect.left + spotlightRect.width / 2}
                    cy={spotlightRect.top + spotlightRect.height / 2}
                    r={Math.max(spotlightRect.width, spotlightRect.height) / 2}
                    fill="black"
                    style={{ transition }}
                  />
                )
              }

              return (
                <rect
                  key={`mask-rect-${index}`}
                  x={spotlightRect.left}
                  y={spotlightRect.top}
                  width={spotlightRect.width}
                  height={spotlightRect.height}
                  rx={cutoutRadius}
                  ry={cutoutRadius}
                  fill="black"
                  style={{ transition }}
                />
              )
            })}
          </mask>
        </defs>

        <rect
          x="0"
          y="0"
          width={viewport.width}
          height={viewport.height}
          fill="rgba(6, 4, 12, 0.60)"
          mask={`url(#${maskId})`}
          style={{
            transition: isReducedMotion ? "opacity 0ms linear" : "opacity 400ms ease-out",
          }}
        />

        {spotlightRects.map((spotlightRect, index) => {
          const cutoutRadius = Math.max(20, Math.min(24, spotlightRect.height / 2, spotlightRect.width / 2))

          if (shape === "circle") {
            return (
              <circle
                key={`ring-circle-${index}`}
                cx={spotlightRect.left + spotlightRect.width / 2}
                cy={spotlightRect.top + spotlightRect.height / 2}
                r={Math.max(spotlightRect.width, spotlightRect.height) / 2}
                fill="none"
                stroke="rgba(255,255,255,0.9)"
                strokeWidth="2"
                style={{ transition }}
              />
            )
          }

          return (
            <rect
              key={`ring-rect-${index}`}
              x={spotlightRect.left}
              y={spotlightRect.top}
              width={spotlightRect.width}
              height={spotlightRect.height}
              rx={cutoutRadius}
              ry={cutoutRadius}
              fill="none"
              stroke="rgba(255,255,255,0.88)"
              strokeWidth="2"
              style={{ transition }}
            />
          )
        })}
      </svg>
    </div>
  )
}