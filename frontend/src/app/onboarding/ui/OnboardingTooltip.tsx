"use client"

import { ChevronLeft, ChevronRight, Sparkles, Volume2, VolumeX } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { cn } from "../../lib/utils"
import type { OnboardingTargetRect, OnboardingTooltipPosition } from "../types"

import {
  TOOLTIP_DEFAULT_HEIGHT,
  TOOLTIP_MAX_WIDTH,
  TOOLTIP_MIN_WIDTH,
  TOOLTIP_TARGET_GAP,
  resolveTooltipLayout,
} from "./tooltip-layout"
import { useOnboardingReducedMotion } from "./useOnboardingReducedMotion"
import { useViewportSize } from "./useViewportSize"

type OnboardingTooltipProps = {
  open?: boolean
  title: string
  body: string
  voiceLabel?: string | null
  preferredPosition?: OnboardingTooltipPosition
  targetRect: OnboardingTargetRect | null
  primaryActionLabel?: string
  onPrimaryAction?: () => void
  backLabel?: string
  onBack?: () => void
  skipLabel?: string
  onSkip?: () => void
  canGoBack?: boolean
  showStepDots?: boolean
  currentStepIndex?: number
  totalSteps?: number
  children?: ReactNode
  reducedMotion?: boolean
  className?: string
  showVoiceToggle?: boolean
  isVoiceMuted?: boolean
  isVoicePlaying?: boolean
  onToggleVoice?: () => void
  ariaModal?: boolean
  manageFocus?: boolean
}

function getArrowStyle(side: "top" | "bottom" | "left" | "right", offset: number) {
  const commonStyle = {
    width: 14,
    height: 14,
    transform: "rotate(45deg)",
    background: "var(--cosmic-tooltip-arrow-bg)",
    borderColor: "var(--cosmic-tooltip-arrow-border)",
  }

  switch (side) {
    case "top":
      return {
        ...commonStyle,
        top: -7,
        left: offset - 7,
        borderTopWidth: 1,
        borderLeftWidth: 1,
      }
    case "bottom":
      return {
        ...commonStyle,
        bottom: -7,
        left: offset - 7,
        borderBottomWidth: 1,
        borderRightWidth: 1,
      }
    case "left":
      return {
        ...commonStyle,
        left: -7,
        top: offset - 7,
        borderLeftWidth: 1,
        borderBottomWidth: 1,
      }
    default:
      return {
        ...commonStyle,
        right: -7,
        top: offset - 7,
        borderTopWidth: 1,
        borderRightWidth: 1,
      }
  }
}

export function OnboardingTooltip({
  open = true,
  title,
  body,
  voiceLabel,
  preferredPosition = "center",
  targetRect,
  primaryActionLabel = "Next",
  onPrimaryAction,
  backLabel = "Back",
  onBack,
  skipLabel = "Skip tour",
  onSkip,
  canGoBack = false,
  showStepDots = false,
  currentStepIndex = 0,
  totalSteps = 0,
  children,
  reducedMotion,
  className,
  showVoiceToggle = false,
  isVoiceMuted = false,
  isVoicePlaying = false,
  onToggleVoice,
  ariaModal = true,
  manageFocus = false,
}: OnboardingTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const previousFocusedElementRef = useRef<HTMLElement | null>(null)
  const primaryActionRef = useRef<HTMLButtonElement | null>(null)
  const viewport = useViewportSize()
  const motionPreference = useOnboardingReducedMotion()
  const isReducedMotion = reducedMotion ?? motionPreference
  const titleId = useId()
  const bodyId = useId()
  const [measuredSize, setMeasuredSize] = useState({
    width: TOOLTIP_MAX_WIDTH,
    height: TOOLTIP_DEFAULT_HEIGHT, // generous initial so content isn't clipped
  })

  useEffect(() => {
    if (!open || !manageFocus) {
      return undefined
    }

    previousFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null

    const timer = window.setTimeout(() => {
      primaryActionRef.current?.focus()
    }, 50)

    return () => {
      window.clearTimeout(timer)

      const previousFocusedElement = previousFocusedElementRef.current
      previousFocusedElementRef.current = null

      if (previousFocusedElement && document.contains(previousFocusedElement)) {
        window.setTimeout(() => {
          previousFocusedElement.focus()
        }, 0)
      }
    }
  }, [manageFocus, open, title, body, primaryActionLabel])

  useLayoutEffect(() => {
    if (!open || !tooltipRef.current) {
      return
    }

    const element = tooltipRef.current
    element.scrollTop = 0

    const nextRect = element.getBoundingClientRect()
    const nextWidth = Math.max(TOOLTIP_MIN_WIDTH, Math.round(nextRect.width))
    const nextHeight = Math.max(220, Math.round(element.scrollHeight))

    setMeasuredSize((previousSize) => {
      if (previousSize.width === nextWidth && previousSize.height === nextHeight) {
        return previousSize
      }

      return {
        width: nextWidth,
        height: nextHeight,
      }
    })
  }, [body, children, open, primaryActionLabel, title, voiceLabel, viewport.height, viewport.width])

  useEffect(() => {
    if (!open) {
      return
    }

    const element = tooltipRef.current
    if (!element || typeof ResizeObserver === "undefined") {
      return undefined
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }

      const nextWidth = Math.max(260, Math.round(entry.contentRect.width))
      const nextHeight = Math.max(220, Math.round(element.scrollHeight))
      setMeasuredSize((previousSize) => previousSize.width === nextWidth && previousSize.height === nextHeight
        ? previousSize
        : { width: Math.max(TOOLTIP_MIN_WIDTH, nextWidth), height: nextHeight })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  const layout = useMemo(() => resolveTooltipLayout({
    preferredPosition,
    targetRect,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    tooltipWidth: measuredSize.width,
    tooltipHeight: measuredSize.height,
    gap: TOOLTIP_TARGET_GAP,
  }), [measuredSize.height, measuredSize.width, preferredPosition, targetRect, viewport.height, viewport.width])

  if (!open || viewport.width === 0 || viewport.height === 0) {
    return null
  }

  const transition = isReducedMotion
    ? "opacity 0ms linear"
    : "opacity 350ms ease-out, transform 350ms ease-out"
  const initialTransform = layout.isBottomSheet
    ? "translateY(0)"
    : layout.placement === "top"
      ? "translateY(-12px)"
      : layout.placement === "bottom"
        ? "translateY(12px)"
        : layout.placement === "left"
          ? "translateX(-12px)"
          : layout.placement === "right"
            ? "translateX(12px)"
            : "translateY(0)"

  return (
    <div className="pointer-events-none fixed inset-0 z-[80]" aria-hidden={!open}>
      <div
        ref={tooltipRef}
        role="dialog"
        aria-modal={ariaModal}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={cn(
          "pointer-events-auto fixed border text-sophia-text",
          layout.isBottomSheet
            ? "rounded-t-[28px] rounded-b-none px-6 pb-6 pt-5"
            : "rounded-[24px] px-6 pb-5 pt-5",
          className,
        )}
        style={{
          top: layout.top,
          left: layout.left,
          width: layout.width,
          minWidth: layout.isBottomSheet ? undefined : Math.min(TOOLTIP_MIN_WIDTH, Math.max(280, viewport.width - 32)),
          maxWidth: layout.maxWidth,
          maxHeight: Math.min(viewport.height - 32, layout.maxHeight),
          background: "var(--cosmic-tooltip-bg)",
          borderColor: "var(--cosmic-tooltip-border)",
          boxShadow: "var(--cosmic-tooltip-shadow)",
          transition,
          transform: isReducedMotion ? "translate3d(0,0,0)" : initialTransform,
          opacity: 1,
          overflowY: measuredSize.height > Math.min(viewport.height - 32, layout.maxHeight) ? "auto" : "visible",
          transformOrigin: layout.transformOrigin,
        }}
      >
        {!layout.isBottomSheet && layout.arrow && (
          <span
            aria-hidden="true"
            className="absolute border"
            style={getArrowStyle(layout.arrow.side, layout.arrow.offset)}
          />
        )}

        {layout.isBottomSheet && (
          <div className="mb-3 flex justify-center">
            <div className="h-1 w-10 rounded-full bg-sophia-text2/20" />
          </div>
        )}

        <div className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h2 id={titleId} className="text-lg font-semibold leading-tight tracking-[-0.02em] text-sophia-text">{title}</h2>
              {showVoiceToggle && onToggleVoice && (
                <button
                  type="button"
                  onClick={onToggleVoice}
                  aria-label={isVoiceMuted ? 'Enable onboarding voice-over' : 'Mute onboarding voice-over'}
                  aria-pressed={!isVoiceMuted}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sophia-surface-border/80 bg-sophia-surface/40 text-sophia-text2 transition-colors duration-150 hover:text-sophia-text"
                >
                  {isVoiceMuted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className={`h-4 w-4 ${isVoicePlaying ? 'text-sophia-purple' : ''}`} />
                  )}
                </button>
              )}
            </div>
            <p id={bodyId} className="text-[15px] leading-relaxed text-sophia-text2">{body}</p>
            {voiceLabel && (
              <p className="text-sm italic leading-6 text-sophia-purple/90">{voiceLabel}</p>
            )}
          </div>

          {children ? <div>{children}</div> : null}

          {showStepDots && totalSteps > 0 && (
            <div className="flex items-center gap-2" aria-label={`Step ${currentStepIndex + 1} of ${totalSteps}`}>
              {Array.from({ length: totalSteps }).map((_, index) => (
                <span
                  key={`step-dot-${index}`}
                  className="h-1.5 rounded-full transition-all duration-200"
                  style={{
                    width: index === currentStepIndex ? 20 : 6,
                    background: index === currentStepIndex ? "var(--sophia-purple)" : "rgba(255, 255, 255, 0.2)",
                  }}
                />
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-white/6 pt-3">
            <div>
              {canGoBack && onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="inline-flex h-10 items-center gap-1 rounded-full px-4 text-sm text-sophia-text2 transition-colors duration-150 hover:text-sophia-text"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {backLabel}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {onSkip && (
                <button
                  type="button"
                  onClick={onSkip}
                  className="inline-flex h-9 items-center rounded-full px-4 text-sm text-sophia-text2/80 transition-colors duration-150 hover:text-sophia-text"
                >
                  {skipLabel}
                </button>
              )}
              <button
                ref={primaryActionRef}
                type="button"
                onClick={onPrimaryAction}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-sophia-purple px-5 text-sm font-medium text-white shadow-[0_10px_24px_rgba(124,92,170,0.28)] transition duration-150 hover:brightness-105"
              >
                <span>{primaryActionLabel}</span>
                {primaryActionLabel.toLowerCase() === "start" ? <Sparkles className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}