"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { haptic } from "../../hooks/useHaptics"
import { buildThreadArtifactHref, formatBuilderArtifactFileSize, getBuilderArtifactFiles } from "../../lib/builder-artifacts"
import { cn } from "../../lib/utils"
import { usePresenceStore } from "../../stores/presence-store"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { RitualArtifacts } from "../../types/session"

interface PresenceArtifactPanelProps {
  artifacts: RitualArtifacts | null | undefined
  builderArtifact?: BuilderArtifactV1 | null
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  threadId?: string
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
  builderArtifact,
  builderArtifactLibrary = [],
  threadId,
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
  const hasBuilderLibrary = builderArtifactLibrary.length > 0

  // Phase lifecycle
  useEffect(() => {
    if (isVisible && (artifacts || builderArtifact || hasBuilderLibrary)) {
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
  }, [isVisible, artifacts, builderArtifact, hasBuilderLibrary])

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

  // Voice mode: auto-dismiss after 18s — BUT NOT when builder deliverable is present
  // Builder results are high-value; user needs time to act on them
  useEffect(() => {
    if (autoCollapseRef.current) {
      clearTimeout(autoCollapseRef.current)
      autoCollapseRef.current = null
    }
    if (phase === "visible" && isVoiceMode && !builderArtifact && !hasBuilderLibrary) {
      autoCollapseRef.current = setTimeout(() => {
        autoCollapseRef.current = null
        onDismiss()
      }, 18000)
    }
    return () => {
      if (autoCollapseRef.current) clearTimeout(autoCollapseRef.current)
    }
  }, [phase, isVoiceMode, onDismiss, builderArtifact, hasBuilderLibrary])

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

  if ((!artifacts && !builderArtifact && !hasBuilderLibrary) || phase === "hidden") return null

  const takeaway = artifacts?.takeaway
  const reflection_candidate = artifacts?.reflection_candidate
  const memory_candidates = artifacts?.memory_candidates
  const builderFiles = getBuilderArtifactFiles(builderArtifact)
  const hasBuilder = !!builderArtifact
  const hasReflection = !!reflection_candidate?.prompt
  const hasMemories = memory_candidates && memory_candidates.length > 0
  const hasTakeaway = !!takeaway?.trim()
  const hasContent = hasBuilder || hasBuilderLibrary || hasTakeaway || hasReflection || hasMemories

  if (!hasContent) return null

  const isActive = phase === "visible"

  // Presence-reactive bloom color
  const bloomColor =
    status === "speaking"
      ? "var(--sophia-glow)"
      : status === "listening"
        ? "var(--cosmic-teal)"
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
          isVoiceMode && "cursor-pointer",
          !isVoiceMode && "rounded-2xl px-5 py-4"
        )}
        style={!isVoiceMode ? {
          background: 'var(--cosmic-panel)',
          borderRadius: '16px',
          border: '1px solid var(--cosmic-border-soft)',
          backdropFilter: 'blur(20px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
        } : undefined}
        onClick={isVoiceMode ? handleDismiss : undefined}
      >
        {/* Dismiss hint — whisper-thin, top-right */}
        <button
          onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
          className={cn(
            "absolute -top-1 -right-1 z-10 w-6 h-6 flex items-center justify-center",
            "transition-all duration-700",
            "pointer-events-auto cursor-pointer",
            revealStep >= 1 ? "opacity-100" : "opacity-0"
          )}
          style={{ color: 'var(--cosmic-text-faint)' }}
          aria-label="Dismiss"
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2 2l8 8M10 2l-8 8" strokeLinecap="round" />
          </svg>
        </button>

        {hasBuilder && builderArtifact && (
          <div
            className={cn(
              "mb-4 transition-all duration-[1400ms] ease-out",
              revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            {/* Type badge — centered */}
            <div className="text-center mb-3">
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] tracking-[0.14em] uppercase"
                style={{
                  borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
                  color: 'var(--sophia-purple)',
                  background: 'color-mix(in srgb, var(--sophia-purple) 6%, transparent)',
                }}
              >
                ✦ {builderArtifact.artifactType?.replace(/_/g, ' ') ?? 'deliverable'}
              </span>
            </div>

            {/* Title */}
            <p
              className="font-cormorant text-[20px] leading-[1.35] font-light text-center"
              style={{
                color: 'var(--cosmic-text-strong)',
                textShadow: isActive
                  ? `0 0 20px color-mix(in srgb, ${bloomColor} 18%, transparent)`
                  : 'none',
              }}
            >
              {builderArtifact.artifactTitle}
            </p>

            {/* Summary */}
            {builderArtifact.companionSummary && (
              <p
                className="mt-2 font-cormorant text-[14px] leading-[1.65] font-light text-center"
                style={{ color: 'var(--cosmic-text-whisper)' }}
              >
                {builderArtifact.companionSummary}
              </p>
            )}

            {/* Next action */}
            {builderArtifact.userNextAction && (
              <p
                className="mt-2.5 text-center text-[10px] tracking-[0.06em]"
                style={{ color: 'var(--cosmic-text-faint)' }}
              >
                Next → {builderArtifact.userNextAction}
              </p>
            )}

            {/* File actions — pill buttons with proper tap targets */}
            {builderFiles.length > 0 && (
              <div className="mt-4 flex flex-col items-center gap-2">
                {builderFiles.map((file) => {
                  const downloadHref = buildThreadArtifactHref(threadId, file.path, { download: true })
                  const openHref = buildThreadArtifactHref(threadId, file.path)

                  return (
                    <div
                      key={file.path}
                      className="flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="text-[10px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                        {file.label}
                      </span>
                      <div className="flex gap-1.5">
                        {openHref && (
                          <a
                            href={openHref}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${file.label}`}
                            className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
                            style={{
                              borderColor: 'var(--cosmic-border-soft)',
                              color: 'var(--cosmic-text-whisper)',
                            }}
                            onClick={() => haptic('light')}
                          >
                            open
                          </a>
                        )}
                        {downloadHref && (
                          <a
                            href={downloadHref}
                            aria-label={`Download ${file.label}`}
                            className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
                            style={{
                              borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
                              color: 'var(--sophia-purple)',
                              background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
                            }}
                            onClick={() => haptic('medium')}
                          >
                            download
                          </a>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {hasBuilderLibrary && (
          <div
            className={cn(
              "mb-4 transition-all duration-[1400ms] ease-out",
              revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            <p
              className="mb-2 text-center text-[9px] tracking-[0.18em] uppercase"
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              Session files
            </p>

            <div className="flex flex-col items-center gap-2">
              {builderArtifactLibrary.map((file) => {
                const downloadHref = buildThreadArtifactHref(threadId, file.path, { download: true })
                const openHref = buildThreadArtifactHref(threadId, file.path)
                const meta = [formatBuilderArtifactFileSize(file.sizeBytes), file.mimeType]
                  .filter(Boolean)
                  .join(' • ')

                return (
                  <div
                    key={file.path}
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="text-center">
                      <span className="block text-[10px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                        {file.name}
                      </span>
                      {meta && (
                        <span className="block text-[9px]" style={{ color: 'var(--cosmic-text-faint)' }}>
                          {meta}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      {openHref && (
                        <a
                          href={openHref}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${file.name}`}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
                          style={{
                            borderColor: 'var(--cosmic-border-soft)',
                            color: 'var(--cosmic-text-whisper)',
                          }}
                          onClick={() => haptic('light')}
                        >
                          open
                        </a>
                      )}
                      {downloadHref && (
                        <a
                          href={downloadHref}
                          aria-label={`Download ${file.name}`}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[10px] transition-colors"
                          style={{
                            borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--cosmic-border-soft))',
                            color: 'var(--sophia-purple)',
                            background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
                          }}
                          onClick={() => haptic('medium')}
                        >
                          download
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

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
                color: revealStep >= 1 ? 'var(--cosmic-text-strong)' : 'transparent',
                textShadow: isActive
                  ? `0 0 24px color-mix(in srgb, ${bloomColor} 22%, transparent)`
                  : "none",
                transition: 'color 1.4s ease, text-shadow 2s ease',
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
              background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${bloomColor} 25%, var(--cosmic-text-faint)), transparent)`,
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
                  color: reflectionTapped ? 'var(--cosmic-text-whisper)' : 'var(--cosmic-text-strong)',
                  textShadow: !reflectionTapped && isActive
                    ? `0 0 20px color-mix(in srgb, ${bloomColor} 18%, transparent)`
                    : "none",
                  transition: "color 0.7s ease, text-shadow 1s ease",
                }}
              >
                {reflection_candidate.prompt}
              </p>
              {reflection_candidate.why && !reflectionTapped && (
                <p className="mt-1.5 text-[10px] tracking-[0.08em] font-light" style={{ color: 'var(--cosmic-text-faint)' }}>
                  {reflection_candidate.why}
                </p>
              )}
              {!reflectionTapped && onReflectionTap && (
                <span
                  className="inline-block mt-2.5 text-[9px] tracking-[0.14em] uppercase transition-colors duration-700"
                  style={{ color: `color-mix(in srgb, ${bloomColor} 40%, var(--cosmic-text-faint))` }}
                >
                  tap to reflect
                </span>
              )}
              {reflectionTapped && (
                <span className="inline-block mt-1.5 text-[9px] tracking-[0.14em] uppercase" style={{ color: 'var(--cosmic-text-faint)' }}>
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
            {memory_candidates.slice(0, 5).map((mem, i) => (
              <span
                key={i}
                className={cn(
                  "group/mem relative text-[9px] tracking-[0.12em] lowercase px-2 py-[3px]",
                  "transition-all duration-[800ms] cursor-default",
                )}
                style={{
                  color: 'var(--cosmic-text-muted)',
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
                        className="transition-colors hover:text-[var(--cosmic-text)]"
                        style={{ color: 'var(--cosmic-text-faint)' }}
                        aria-label="Save memory"
                      >
                        ✓
                      </button>
                    )}
                    {onMemoryReject && (
                      <button
                        onClick={() => { haptic("light"); onMemoryReject(i) }}
                        className="transition-colors hover:text-[var(--cosmic-text-muted)]"
                        style={{ color: 'var(--cosmic-text-faint)' }}
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
  isNew,
}: {
  hasArtifacts: boolean
  onClick: () => void
  /** True when new/unseen insights are available */
  isNew?: boolean
}) {
  if (!hasArtifacts) return null

  return (
    <button
      onClick={() => { haptic("light"); onClick() }}
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 rounded-full",
        "transition-all duration-500 cursor-pointer",
        isNew && "animate-[insightPulse_2.5s_ease-in-out_infinite]",
      )}
      style={{
        color: isNew ? 'var(--cosmic-text-strong)' : 'var(--cosmic-text)',
        background: isNew
          ? 'color-mix(in srgb, var(--sophia-purple) 18%, var(--cosmic-panel))'
          : 'var(--cosmic-panel-soft)',
        border: isNew
          ? '1px solid color-mix(in srgb, var(--sophia-purple) 35%, transparent)'
          : '1px solid var(--cosmic-border-soft)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      aria-label={isNew ? "New insights available" : "Show insights"}
    >
      {/* Bloom dot */}
      <span
        className={cn(
          "w-2 h-2 rounded-full transition-all duration-700",
          isNew && "shadow-[0_0_10px_var(--sophia-glow)]",
        )}
        style={{
          background: isNew
            ? 'var(--sophia-glow)'
            : 'color-mix(in srgb, var(--sophia-purple) 50%, var(--cosmic-panel-soft))',
        }}
      />
      <span className={cn(
        "text-[11px] tracking-[0.1em] lowercase font-medium",
        isNew && "text-[12px]",
      )}>
        {isNew ? 'new insight' : 'insights'}
      </span>
    </button>
  )
}
