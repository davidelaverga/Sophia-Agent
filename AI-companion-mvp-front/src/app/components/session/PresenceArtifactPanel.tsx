"use client"

import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { cn } from "../../lib/utils"
import type { RitualArtifacts } from "../../types/session"
import { usePresenceStore } from "../../stores/presence-store"
import { useUiStore } from "../../stores/ui-store"

interface PresenceArtifactPanelProps {
  artifacts: RitualArtifacts | null | undefined
  isVisible: boolean
  onDismiss: () => void
  /** Voice mode: auto-dismiss after 12s. Text mode: persistent */
  isVoiceMode: boolean
}

/**
 * Atmospheric bottom-sheet artifact panel.
 *
 * Slides up from bottom-center, max-width 480px.
 * Frosted glass: bg-[rgba(8,8,18,0.78)] backdrop-blur-[28px].
 * Staggered reveal: takeaway → divider → reflection → memory tags.
 * Palette-reactive glow edge at top.
 * Voice mode: auto-dismiss after 12s. Text mode: persistent.
 */
export function PresenceArtifactPanel({
  artifacts,
  isVisible,
  onDismiss,
  isVoiceMode,
}: PresenceArtifactPanelProps) {
  const [show, setShow] = useState(false)
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Slide-up on visible change
  useEffect(() => {
    if (isVisible && artifacts) {
      // Small delay for paint before animation
      requestAnimationFrame(() => setShow(true))
    } else {
      setShow(false)
    }
  }, [isVisible, artifacts])

  // Auto-dismiss in voice mode after 12s
  useEffect(() => {
    if (autoDismissRef.current) {
      clearTimeout(autoDismissRef.current)
      autoDismissRef.current = null
    }

    if (show && isVoiceMode) {
      autoDismissRef.current = setTimeout(() => {
        autoDismissRef.current = null
        onDismiss()
      }, 12000)
    }

    return () => {
      if (autoDismissRef.current) {
        clearTimeout(autoDismissRef.current)
      }
    }
  }, [show, isVoiceMode, onDismiss])

  if (!artifacts) return null

  const { takeaway, reflection_candidate, memory_candidates } = artifacts
  const hasReflection = reflection_candidate?.prompt
  const hasMemories = memory_candidates && memory_candidates.length > 0

  return (
    <div
      className={cn(
        "fixed left-1/2 -translate-x-1/2 z-35 w-full max-w-[480px] pointer-events-none",
        "transition-transform duration-[800ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        isVoiceMode ? "bottom-0" : "bottom-[68px]",
        show ? "translate-y-0 pointer-events-auto" : "translate-y-full"
      )}
      role="complementary"
      aria-label="Session artifact"
    >
      <div className="relative px-8 py-6 pb-7 bg-[rgba(8,8,18,0.78)] backdrop-blur-[28px] rounded-t-[20px] border-t border-white/[0.03] max-h-[180px] overflow-hidden">
        {/* Palette-reactive glow edge */}
        <GlowEdge />

        {/* Pull handle — visual affordance for dismiss */}
        <button
          onClick={onDismiss}
          className="absolute top-0 left-1/2 -translate-x-1/2 py-2 px-6 cursor-pointer group z-10"
          aria-label="Dismiss artifact"
        >
          <div className="w-8 h-[3px] rounded-full bg-white/[0.12] group-hover:bg-white/[0.30] transition-colors duration-300" />
        </button>

        {/* Dismiss X button — visible and tappable */}
        <button
          onClick={onDismiss}
          className="absolute top-3 right-4 w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.04] text-white/25 hover:text-white/50 hover:bg-white/[0.08] transition-all duration-300 z-10"
          aria-label="Dismiss artifact"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Takeaway — Cormorant 18px, stagger 0ms */}
        {takeaway && (
          <p
            className={cn(
              "font-cormorant text-lg font-light leading-[1.65] tracking-[0.01em]",
              "transition-colors duration-[1200ms] ease-out",
              show ? "text-[rgba(232,228,239,0.65)]" : "text-transparent"
            )}
          >
            {takeaway}
          </p>
        )}

        {/* Divider — stagger 600ms */}
        {takeaway && hasReflection && (
          <div
            className={cn(
              "w-7 h-px my-3",
              "transition-[background] duration-1000 delay-[600ms] ease-out",
              show ? "bg-[rgba(232,228,239,0.1)]" : "bg-transparent"
            )}
          />
        )}

        {/* Reflection — Cormorant italic 14px, stagger 800ms */}
        {hasReflection && (
          <p
            className={cn(
              "font-cormorant text-sm font-light italic leading-[1.7] tracking-[0.01em]",
              "transition-colors duration-[1200ms] delay-[800ms] ease-out",
              show ? "text-[rgba(232,228,239,0.35)]" : "text-transparent"
            )}
          >
            {reflection_candidate!.prompt}
          </p>
        )}

        {/* Memory tags — Inter 9px, stagger 1400ms */}
        {hasMemories && (
          <div
            className={cn(
              "flex gap-2 flex-wrap mt-3.5",
              "transition-opacity duration-[1200ms] delay-[1400ms] ease-out",
              show ? "opacity-100" : "opacity-0"
            )}
          >
            {memory_candidates!.slice(0, 5).map((mem, i) => (
              <span
                key={i}
                className="font-sans text-[9px] tracking-[0.12em] lowercase text-[rgba(232,228,239,0.2)] px-2.5 py-[3px] border border-[rgba(232,228,239,0.04)] rounded-xl hover:border-[rgba(232,228,239,0.1)] hover:text-[rgba(232,228,239,0.35)] transition-[border-color,color] duration-[800ms]"
              >
                {mem.memory || mem.category}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Palette-reactive glow — reads emotion palette from presence store */
function GlowEdge() {
  // Use the palette accent color from presence store if available
  const status = usePresenceStore((s) => s.status)
  const mode = useUiStore((s) => s.mode)

  // Map presence states to accent colors
  const accentColor =
    status === "speaking"
      ? "rgba(168, 148, 240, 0.25)"  // soft purple
      : status === "listening"
        ? "rgba(120, 180, 255, 0.25)"  // soft blue
        : status === "reflecting"
          ? "rgba(200, 160, 255, 0.25)" // lavender
          : "rgba(160, 160, 200, 0.15)" // neutral

  return (
    <div
      className="absolute -top-px left-[10%] right-[10%] h-px rounded-full pointer-events-none"
      style={{
        background: accentColor,
        opacity: 0.25,
        filter: "blur(6px)",
        transition: "background 3s ease, opacity 1s ease",
      }}
    />
  )
}

/** Ghost toggle icon for text mode — shows at screen edge when panel is hidden */
export function ArtifactToggleIcon({
  hasArtifacts,
  onClick,
}: {
  hasArtifacts: boolean
  onClick: () => void
}) {
  if (!hasArtifacts) return null

  return (
    <button
      onClick={onClick}
      className={cn(
        "fixed right-0 top-1/2 -translate-y-1/2 z-30",
        "w-8 h-8 flex items-center justify-center",
        "rounded-l-lg",
        "bg-white/[0.03] hover:bg-white/[0.06]",
        "border border-r-0 border-white/[0.04]",
        "transition-all duration-300",
        "text-white/15 hover:text-white/30"
      )}
      aria-label="Show artifacts"
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 3v18M3 12h18" strokeLinecap="round" />
      </svg>
    </button>
  )
}
