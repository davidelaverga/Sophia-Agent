"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "../../lib/utils"
import type { RitualArtifacts } from "../../types/session"
import { usePresenceStore } from "../../stores/presence-store"
import { haptic } from "../../hooks/useHaptics"

interface PresenceArtifactPanelProps {
  artifacts: RitualArtifacts | null | undefined
  isVisible: boolean
  onDismiss: () => void
  isVoiceMode: boolean
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
}

/**
 * Cosmic artifact panel — part of the presence field.
 *
 * No card. No border. No solid background. The artifacts emerge from
 * the nebula like constellations becoming visible — text materialises
 * at ultra-low opacity, gains presence through gentle bloom, and the
 * nebula shows through everything.
 *
 * Voice: floats above mic, translucent veil. Text: inline above composer.
 * Dismiss via tap on the whisper-thin close zone or swipe-down.
 */
export function PresenceArtifactPanel({
  artifacts,
  isVisible,
  onDismiss,
  isVoiceMode,
  onReflectionTap,
  onMemoryApprove,
  onMemoryReject,
}: PresenceArtifactPanelProps) {
  const [phase, setPhase] = useState<"hidden" | "entering" | "visible" | "exiting">("hidden")
  const [revealStep, setRevealStep] = useState(0)
  const [reflectionTapped, setReflectionTapped] = useState(false)
  const autoCollapseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const staggerRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const status = usePresenceStore((s) => s.status)

  // Phase lifecycle
  useEffect(() => {
    if (isVisible && artifacts) {
      setPhase("entering")
      setRevealStep(0)
      setReflectionTapped(false)
      requestAnimationFrame(() => setPhase("visible"))
    } else if (phase !== "hidden") {
      setPhase("exiting")
      const t = setTimeout(() => setPhase("hidden"), 800)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, artifacts])

  // Staggered reveal — each piece fades in like a star brightening
  useEffect(() => {
    staggerRef.current.forEach(clearTimeout)
    staggerRef.current = []

    if (phase === "visible") {
      const delays = [100, 800, 1600, 2800]
      delays.forEach((d, i) => {
        staggerRef.current.push(setTimeout(() => setRevealStep(i + 1), d))
      })
    } else if (phase === "hidden") {
      setRevealStep(0)
    }

    return () => staggerRef.current.forEach(clearTimeout)
  }, [phase])

  // Voice mode: auto-dismiss after 18s (long enough to read)
  useEffect(() => {
    if (autoCollapseRef.current) {
      clearTimeout(autoCollapseRef.current)
      autoCollapseRef.current = null
    }
    if (phase === "visible" && isVoiceMode) {
      autoCollapseRef.current = setTimeout(() => {
        autoCollapseRef.current = null
        onDismiss()
      }, 18000)
    }
    return () => {
      if (autoCollapseRef.current) clearTimeout(autoCollapseRef.current)
    }
  }, [phase, isVoiceMode, onDismiss])

  const handleDismiss = useCallback(() => {
    haptic("light")
    onDismiss()
  }, [onDismiss])

  const handleReflectionTap = useCallback(() => {
    if (!artifacts?.reflection_candidate || reflectionTapped) return
    haptic("medium")
    setReflectionTapped(true)
    onReflectionTap?.({
      prompt: artifacts.reflection_candidate.prompt,
      why: artifacts.reflection_candidate.why,
    })
  }, [artifacts?.reflection_candidate, reflectionTapped, onReflectionTap])

  if (!artifacts || phase === "hidden") return null

  const { takeaway, reflection_candidate, memory_candidates } = artifacts
  const hasReflection = !!reflection_candidate?.prompt
  const hasMemories = memory_candidates && memory_candidates.length > 0
  const hasTakeaway = !!takeaway?.trim()
  const hasContent = hasTakeaway || hasReflection || hasMemories

  if (!hasContent) return null

  const isActive = phase === "visible"

  // Presence-reactive bloom color
  const bloomColor =
    status === "speaking"
      ? "var(--sophia-glow)"
      : status === "listening"
        ? "rgba(120, 180, 255, 0.5)"
        : "var(--sophia-purple)"

  return (
    <div
      className={cn(
        "pointer-events-none select-none",
        "transition-all duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        isVoiceMode
          ? "fixed left-1/2 -translate-x-1/2 bottom-[155px] z-25 w-full max-w-[440px] px-6"
          : "relative z-10 w-full max-w-2xl mx-auto px-6 mb-3",
        isActive ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      )}
      role="complementary"
      aria-label="Session artifacts"
    >
      {/* Bloom halo — the nebula glow behind the content */}
      <div
        className="absolute inset-0 -inset-x-8 -inset-y-4 rounded-full pointer-events-none transition-opacity duration-[2000ms]"
        style={{
          background: `radial-gradient(ellipse 80% 70% at 50% 40%, color-mix(in srgb, ${bloomColor} 8%, transparent) 0%, transparent 70%)`,
          filter: "blur(30px)",
          opacity: isActive ? 1 : 0,
        }}
      />

      {/* Dismiss zone — entire panel, tap to dismiss in voice mode */}
      <div
        className={cn(
          "relative pointer-events-auto",
          isVoiceMode && "cursor-pointer"
        )}
        onClick={isVoiceMode ? handleDismiss : undefined}
      >
        {/* Dismiss hint — whisper-thin, top-right */}
        <button
          onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
          className={cn(
            "absolute -top-1 -right-1 z-10 w-6 h-6 flex items-center justify-center",
            "text-white/[0.08] hover:text-white/25 transition-all duration-700",
            "pointer-events-auto cursor-pointer",
            revealStep >= 1 ? "opacity-100" : "opacity-0"
          )}
          aria-label="Dismiss"
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2 2l8 8M10 2l-8 8" strokeLinecap="round" />
          </svg>
        </button>

        {/* === TAKEAWAY === emerges like a fading-in constellation */}
        {hasTakeaway && (
          <div
            className={cn(
              "transition-all duration-[1400ms] ease-out",
              revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            <p
              className="font-cormorant text-[17px] leading-[1.75] font-light text-center"
              style={{
                color: `rgba(232, 228, 239, ${revealStep >= 1 ? 0.50 : 0})`,
                textShadow: isActive
                  ? `0 0 20px color-mix(in srgb, ${bloomColor} 15%, transparent)`
                  : "none",
                transition: "color 1.4s ease, text-shadow 2s ease",
              }}
            >
              {takeaway}
            </p>
          </div>
        )}

        {/* === DIVIDER === thin luminous line, like a nebula filament */}
        {hasTakeaway && (hasReflection || hasMemories) && (
          <div
            className={cn(
              "mx-auto my-4 transition-all duration-[1200ms] ease-out",
              revealStep >= 2 ? "opacity-100 scale-x-100" : "opacity-0 scale-x-0"
            )}
            style={{
              width: "32px",
              height: "1px",
              background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${bloomColor} 25%, rgba(232,228,239,0.12)), transparent)`,
              transformOrigin: "center",
            }}
          />
        )}

        {/* === REFLECTION === the invitation, slightly brighter, interactive */}
        {hasReflection && (
          <div
            className={cn(
              "transition-all duration-[1400ms] ease-out",
              revealStep >= 3 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleReflectionTap()
              }}
              disabled={reflectionTapped || !onReflectionTap}
              className={cn(
                "w-full text-center transition-all duration-700",
                !reflectionTapped && onReflectionTap
                  ? "cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
                  : "cursor-default",
                reflectionTapped && "opacity-40"
              )}
            >
              <p
                className="font-cormorant text-[15px] italic leading-[1.7] font-light"
                style={{
                  color: `rgba(232, 228, 239, ${reflectionTapped ? 0.20 : 0.35})`,
                  textShadow: !reflectionTapped && isActive
                    ? `0 0 16px color-mix(in srgb, ${bloomColor} 12%, transparent)`
                    : "none",
                  transition: "color 0.7s ease, text-shadow 1s ease",
                }}
              >
                {reflection_candidate!.prompt}
              </p>
              {reflection_candidate!.why && !reflectionTapped && (
                <p className="mt-1.5 text-[10px] tracking-[0.08em] text-white/[0.12] font-light">
                  {reflection_candidate!.why}
                </p>
              )}
              {!reflectionTapped && onReflectionTap && (
                <span
                  className="inline-block mt-2.5 text-[9px] tracking-[0.14em] uppercase transition-colors duration-700"
                  style={{ color: `color-mix(in srgb, ${bloomColor} 40%, rgba(232,228,239,0.15))` }}
                >
                  tap to reflect
                </span>
              )}
              {reflectionTapped && (
                <span className="inline-block mt-1.5 text-[9px] tracking-[0.14em] uppercase text-white/[0.10]">
                  sent
                </span>
              )}
            </button>
          </div>
        )}

        {/* === MEMORY CONSTELLATION === tiny stars, each a memory */}
        {hasMemories && (
          <div
            className={cn(
              "mt-4 flex justify-center gap-2 flex-wrap transition-all duration-[1200ms] ease-out",
              revealStep >= 4 ? "opacity-100" : "opacity-0"
            )}
          >
            {memory_candidates!.slice(0, 5).map((mem, i) => (
              <span
                key={i}
                className={cn(
                  "group/mem relative text-[9px] tracking-[0.12em] lowercase px-2 py-[3px]",
                  "transition-all duration-[800ms] cursor-default",
                )}
                style={{
                  color: `rgba(232, 228, 239, 0.18)`,
                  animationDelay: `${i * 200}ms`,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {mem.memory || mem.category}
                {/* Approve/reject on hover — tiny cosmic dust */}
                {(onMemoryApprove || onMemoryReject) && (
                  <span className="hidden group-hover/mem:inline-flex items-center gap-0.5 ml-1">
                    {onMemoryApprove && (
                      <button
                        onClick={() => { haptic("light"); onMemoryApprove(i) }}
                        className="text-white/[0.15] hover:text-white/40 transition-colors"
                        aria-label="Save memory"
                      >
                        ✓
                      </button>
                    )}
                    {onMemoryReject && (
                      <button
                        onClick={() => { haptic("light"); onMemoryReject(i) }}
                        className="text-white/[0.10] hover:text-white/30 transition-colors"
                        aria-label="Skip memory"
                      >
                        ×
                      </button>
                    )}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Cosmic toggle — a faint constellation marker that glows when tapped.
 * Shows when artifacts are dismissed but available.
 * Matches the whisper-indicator aesthetic: near-invisible, part of the field.
 */
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
      onClick={() => { haptic("light"); onClick() }}
      className={cn(
        "group flex items-center gap-1.5",
        "text-white/[0.10] hover:text-white/[0.25]",
        "transition-all duration-700 cursor-pointer",
      )}
      aria-label="Show insights"
    >
      {/* Tiny bloom dot */}
      <span
        className="w-1.5 h-1.5 rounded-full transition-all duration-700 group-hover:shadow-[0_0_8px_rgba(184,164,232,0.25)]"
        style={{
          background: "color-mix(in srgb, var(--sophia-purple) 30%, rgba(232,228,239,0.15))",
        }}
      />
      <span className="text-[9px] tracking-[0.14em] lowercase">
        insights
      </span>
    </button>
  )
}
