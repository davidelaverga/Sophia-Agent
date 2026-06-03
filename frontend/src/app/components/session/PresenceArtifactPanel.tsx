"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useArtifactCoReview } from "../../hooks/useArtifactCoReview"
import { haptic } from "../../hooks/useHaptics"
import { coreviewFlagDiagnostics, isCoreviewStillFrameReviewEnabled } from "../../lib/co-review-flags"
import type { CoReviewMediaTransport } from "../../lib/co-review-transport"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import { isRealReflection } from "../../session/artifacts"
import { usePresenceStore } from "../../stores/presence-store"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { RitualArtifacts } from "../../types/session"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import { ArtifactStage } from "./ArtifactStage"
import { buildCoreviewRealArtifactId, CoreviewRealArtifactCanvas } from "./CoreviewRealArtifactCanvas"
import {
  buildStageBuilderArtifact,
  COREVIEW_COMPANION_ARTIFACT_ID,
  getStagePrimaryFileWithMime,
  PresenceArtifactSecondarySurfaces,
  stageUsesMarkdownArtifactPreview,
} from "./PresenceArtifactSecondarySurfaces"
import { VoiceArtifactStage } from "./VoiceArtifactStage"

interface PresenceArtifactPanelProps {
  artifacts: RitualArtifacts | null | undefined
  builderArtifact?: BuilderArtifactV1 | null
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  selectedBuilderArtifactPath?: string | null
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
  sessionId?: string | null
  normalSessionId?: string | null
  threadId?: string
  isVisible: boolean
  onDismiss: () => void
  isVoiceMode: boolean
  coReviewTransport?: CoReviewMediaTransport
  pendingBuilderArtifactReview?: boolean
  onStartVoiceBuilderArtifactReview?: () => void
  onPendingBuilderArtifactReviewConsumed?: () => void
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
}

function unavailableCaptureStatus(reason: ArtifactVisualCaptureStatus["reason"]): ArtifactVisualCaptureStatus {
  return {
    ready: false,
    reason,
    source: "none",
    exactTextAvailable: false,
  }
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
  selectedBuilderArtifactPath,
  onSelectedBuilderArtifactPathChange,
  sessionId,
  normalSessionId,
  threadId,
  isVisible,
  onDismiss,
  isVoiceMode,
  coReviewTransport,
  pendingBuilderArtifactReview = false,
  onStartVoiceBuilderArtifactReview,
  onPendingBuilderArtifactReviewConsumed,
  onReflectionTap,
  onMemoryApprove,
  onMemoryReject,
}: PresenceArtifactPanelProps) {
  const [phase, setPhase] = useState<"hidden" | "entering" | "visible" | "exiting">("hidden")
  const [revealStep, setRevealStep] = useState(0)
  const [reflectionTapped, setReflectionTapped] = useState(false)
  const autoCollapseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const staggerRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const selectedStageCaptureSignatureRef = useRef<string | null>(null)
  const [builderArtifactRoot, setBuilderArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [domArtifactRoot, setDomArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [builderVisualCaptureStatus, setBuilderVisualCaptureStatus] = useState<ArtifactVisualCaptureStatus>(
    () => unavailableCaptureStatus("no_selected_artifact"),
  )
  const status = usePresenceStore((s) => s.status)
  const hasBuilderLibrary = builderArtifactLibrary.length > 0
  const selectedBuilderLibraryItem = useMemo(
    () => builderArtifactLibrary.find((file) => file.path === selectedBuilderArtifactPath) ?? null,
    [builderArtifactLibrary, selectedBuilderArtifactPath],
  )
  const stageBuilderArtifact = useMemo(
    () => buildStageBuilderArtifact({
      builderArtifact,
      selectedBuilderArtifactPath,
      selectedLibraryItem: selectedBuilderLibraryItem,
      latestLibraryItem: builderArtifactLibrary[0] ?? null,
    }),
    [builderArtifact, builderArtifactLibrary, selectedBuilderArtifactPath, selectedBuilderLibraryItem],
  )
  const takeaway = artifacts?.takeaway
  const reflection_candidate = artifacts?.reflection_candidate
  const memory_candidates = artifacts?.memory_candidates
  const hasBuilder = !!stageBuilderArtifact
  const hasReflection = isRealReflection(reflection_candidate?.prompt)
  const hasMemories = memory_candidates && memory_candidates.length > 0
  const hasTakeaway = !!takeaway?.trim()
  const coreviewReviewEnabled = isCoreviewStillFrameReviewEnabled()
  const coreviewDiagnostics = useMemo(() => coreviewFlagDiagnostics(), [])
  const builderArtifactId = stageBuilderArtifact
    ? buildCoreviewRealArtifactId(stageBuilderArtifact)
    : null
  const builderReviewEnabled = Boolean(coreviewReviewEnabled && builderArtifactId)
  const stagePrimaryFile = useMemo(() => {
    return getStagePrimaryFileWithMime(stageBuilderArtifact, builderArtifactLibrary)
  }, [builderArtifactLibrary, stageBuilderArtifact])
  const stageUsesMarkdownPreview = stageUsesMarkdownArtifactPreview(stagePrimaryFile)
  const effectiveBuilderVisualCaptureStatus = useMemo<ArtifactVisualCaptureStatus>(() => {
    if (!builderArtifactId) {
      return unavailableCaptureStatus("no_selected_artifact")
    }

    if (!stageUsesMarkdownPreview) {
      return {
        ready: true,
        reason: null,
        source: "metadata_canvas",
        exactTextAvailable: true,
      }
    }

    return builderVisualCaptureStatus
  }, [builderArtifactId, builderVisualCaptureStatus, stageUsesMarkdownPreview])
  const builderVisualSourceReady = Boolean(
    builderArtifactId
    && effectiveBuilderVisualCaptureStatus.ready,
  )
  const builderVisualUnavailableReason = builderArtifactId
    ? effectiveBuilderVisualCaptureStatus.reason
    : "no_selected_artifact"
  const builderExactTextAvailable = Boolean(
    builderArtifactId && effectiveBuilderVisualCaptureStatus.exactTextAvailable,
  )
  const showDomArtifactCoReview = Boolean(
    coreviewReviewEnabled
    && !builderArtifactId
    && (hasTakeaway || hasReflection || hasMemories),
  )
  const builderArtifactCoReview = useArtifactCoReview({
    sessionId: sessionId ?? null,
    normalSessionId: normalSessionId ?? null,
    threadId: threadId ?? null,
    artifactId: builderArtifactId,
    artifactRoot: builderArtifactRoot,
    featureEnabled: builderReviewEnabled,
    exactTextAvailable: builderExactTextAvailable,
    transport: coReviewTransport,
    missingCanvasReason: builderVisualUnavailableReason ?? "capture_target_missing",
    visualSourceReady: builderVisualSourceReady,
    visualSourceUnavailableReason: builderVisualUnavailableReason,
  })
  const domArtifactCoReview = useArtifactCoReview({
    sessionId: sessionId ?? null,
    normalSessionId: normalSessionId ?? null,
    threadId: threadId ?? null,
    artifactId: showDomArtifactCoReview ? COREVIEW_COMPANION_ARTIFACT_ID : null,
    artifactRoot: domArtifactRoot,
    featureEnabled: showDomArtifactCoReview,
    exactTextAvailable: showDomArtifactCoReview,
    transport: coReviewTransport,
    missingCanvasReason: "artifact_canvas_not_found",
  })
  const builderReviewCanStart = builderArtifactCoReview.canStart
  const builderReviewStateName = builderArtifactCoReview.state.state
  const startBuilderArtifactReview = builderArtifactCoReview.startReview
  const transportNeedsVoice = Boolean(
    builderArtifactId
    && builderExactTextAvailable
    && builderVisualSourceReady
    && builderArtifactCoReview.transportStatus.stillFramesSupported
    && !builderArtifactCoReview.transportStatus.visualTransportSupported
    && builderArtifactCoReview.state.state !== "co_review_error"
    && builderArtifactCoReview.state.frameSendFailureCount === 0
  )
  const visualReviewRequiresVoice = Boolean(
    transportNeedsVoice
    && !isVoiceMode
  )
  const visualReviewPreparing = Boolean(
    transportNeedsVoice
    && isVoiceMode
  )

  useEffect(() => {
    if (!isVisible || !stageBuilderArtifact || !builderArtifactId) {
      selectedStageCaptureSignatureRef.current = null
      return
    }

    const signature = [
      sessionId ?? "",
      normalSessionId ?? "",
      threadId ?? "",
      builderArtifactId,
      stagePrimaryFile?.path ?? stageBuilderArtifact.artifactPath ?? "",
      stageUsesMarkdownPreview ? "markdown" : "metadata",
      effectiveBuilderVisualCaptureStatus.ready ? "ready" : "not-ready",
      builderExactTextAvailable ? "exact" : "no-exact",
    ].join("|")

    if (selectedStageCaptureSignatureRef.current === signature) {
      return
    }
    selectedStageCaptureSignatureRef.current = signature

    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "select-stage-artifact",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        artifactId: builderArtifactId,
        coreviewArtifactId: builderArtifactId,
        artifactPath: stagePrimaryFile?.path ?? stageBuilderArtifact.artifactPath ?? null,
        artifactTitle: stageBuilderArtifact.artifactTitle,
        artifactType: stageBuilderArtifact.artifactType,
        artifactKind: "builder_file",
        selectedBuilderArtifactPath: selectedBuilderArtifactPath ?? null,
        source: selectedBuilderArtifactPath ? "selected_builder_artifact" : "latest_builder_artifact",
        reviewFeatureEnabled: coreviewReviewEnabled,
        ...coreviewDiagnostics,
        exactTextSource: stageUsesMarkdownPreview ? "builder_file" : "builder_metadata",
        exactTextAvailable: builderExactTextAvailable,
        visualCaptureSource: effectiveBuilderVisualCaptureStatus.source,
        visualCaptureReady: effectiveBuilderVisualCaptureStatus.ready,
        visualCaptureReason: effectiveBuilderVisualCaptureStatus.reason,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    builderArtifactId,
    builderExactTextAvailable,
    coreviewReviewEnabled,
    coreviewDiagnostics,
    effectiveBuilderVisualCaptureStatus.reason,
    effectiveBuilderVisualCaptureStatus.ready,
    effectiveBuilderVisualCaptureStatus.source,
    isVisible,
    normalSessionId,
    selectedBuilderArtifactPath,
    sessionId,
    stageBuilderArtifact,
    stagePrimaryFile?.path,
    stageUsesMarkdownPreview,
    threadId,
  ])

  // Phase lifecycle
  useEffect(() => {
    if (isVisible && (artifacts || stageBuilderArtifact || hasBuilderLibrary)) {
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
  }, [isVisible, artifacts, stageBuilderArtifact, hasBuilderLibrary])

  useEffect(() => {
    if (!builderArtifactId) {
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("no_selected_artifact"))
      return
    }

    if (!stageUsesMarkdownPreview) {
      setBuilderVisualCaptureStatus({
        ready: true,
        reason: null,
        source: "metadata_canvas",
        exactTextAvailable: true,
      })
      return
    }

    setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
  }, [builderArtifactId, stageUsesMarkdownPreview])

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
    if (phase === "visible" && isVoiceMode && !stageBuilderArtifact && !hasBuilderLibrary && !showDomArtifactCoReview) {
      autoCollapseRef.current = setTimeout(() => {
        autoCollapseRef.current = null
        onDismiss()
      }, 18000)
    }
    return () => {
      if (autoCollapseRef.current) clearTimeout(autoCollapseRef.current)
    }
  }, [phase, isVoiceMode, onDismiss, stageBuilderArtifact, hasBuilderLibrary, showDomArtifactCoReview])

  useEffect(() => {
    if (!pendingBuilderArtifactReview || !hasBuilder || !stageBuilderArtifact) {
      return
    }

    if (builderReviewStateName === "co_review_live" || builderReviewStateName === "co_review_starting") {
      onPendingBuilderArtifactReviewConsumed?.()
      return
    }

    if (!builderReviewCanStart) {
      return
    }

    onPendingBuilderArtifactReviewConsumed?.()
    void startBuilderArtifactReview()
  }, [
    builderReviewCanStart,
    builderReviewStateName,
    hasBuilder,
    onPendingBuilderArtifactReviewConsumed,
    pendingBuilderArtifactReview,
    stageBuilderArtifact,
    startBuilderArtifactReview,
  ])

  const handleDismiss = useCallback(() => {
    haptic("light")
    onDismiss()
  }, [onDismiss])

  const handleReflectionTap = useCallback(() => {
    if (!artifacts?.reflection_candidate || !isRealReflection(artifacts.reflection_candidate.prompt) || reflectionTapped) return
    haptic("medium")
    setReflectionTapped(true)
    onReflectionTap?.({
      prompt: artifacts.reflection_candidate.prompt,
      why: artifacts.reflection_candidate.why,
    })
  }, [artifacts?.reflection_candidate, reflectionTapped, onReflectionTap])

  if ((!artifacts && !stageBuilderArtifact && !hasBuilderLibrary) || phase === "hidden") return null

  const hasContent = hasBuilder || hasBuilderLibrary || hasTakeaway || hasReflection || hasMemories

  if (!hasContent) return null

  const isActive = phase === "visible"
  const isTextModeBuilderStage = !isVoiceMode && hasBuilder
  const builderStageActive = hasBuilder && Boolean(stageBuilderArtifact)
  const showSecondaryArtifactSurfaces = !builderStageActive

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
          ? hasBuilder
            ? "fixed inset-x-0 top-[72px] bottom-[calc(8.75rem+env(safe-area-inset-bottom,0px))] z-25 flex min-h-0 items-center justify-center overflow-hidden px-3 sm:px-6"
            : "fixed left-1/2 -translate-x-1/2 bottom-[155px] z-25 w-full max-w-[720px] px-4 sm:px-6"
          : isTextModeBuilderStage
            ? "relative z-10 h-full min-h-0 w-full max-w-none px-0"
          : cn(
              "relative z-10 w-full mx-auto px-6 mb-3",
              hasBuilder ? "max-w-4xl" : "max-w-2xl",
            ),
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
          isVoiceMode
            ? hasBuilder
              ? "flex h-full min-h-0 w-full max-w-[1120px] flex-col overflow-hidden rounded-xl px-0 py-0"
              : "max-h-[68vh] overflow-y-auto rounded-2xl px-4 py-4"
            : isTextModeBuilderStage
              ? "flex h-full min-h-0 flex-col overflow-hidden rounded-xl"
              : "rounded-2xl px-5 py-4"
        )}
        style={isTextModeBuilderStage || (isVoiceMode && hasBuilder)
          ? undefined
          : {
              background: 'var(--cosmic-panel)',
              borderRadius: '16px',
              border: '1px solid var(--cosmic-border-soft)',
              backdropFilter: 'blur(20px) saturate(1.2)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
            }}
        onClick={isVoiceMode && !hasBuilder ? handleDismiss : undefined}
      >
        {/* Dismiss hint — whisper-thin, top-right */}
        <button
          onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
          className={cn(
            "absolute right-2 top-2 z-10 w-6 h-6 flex items-center justify-center",
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

        {hasBuilder && stageBuilderArtifact && (
          <div
            ref={setBuilderArtifactRoot}
            className={cn(
              "relative transition-all duration-[1400ms] ease-out",
              isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
              isVoiceMode && "flex h-full min-h-0 w-full flex-col overflow-hidden",
              revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            {builderArtifactId && !stageUsesMarkdownPreview && (
              <CoreviewRealArtifactCanvas
                artifactId={builderArtifactId}
                builderArtifact={stageBuilderArtifact}
                sessionId={sessionId}
                normalSessionId={normalSessionId}
                threadId={threadId}
              />
            )}

            <div
              className={cn(
                isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
                isVoiceMode && "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              {isVoiceMode ? (
                <VoiceArtifactStage
                  builderArtifact={stageBuilderArtifact}
                  builderArtifactLibrary={builderArtifactLibrary}
                  threadId={threadId}
                  artifactId={builderArtifactId}
                  sessionId={sessionId}
                  normalSessionId={normalSessionId}
                  reviewState={builderArtifactCoReview.state}
                  transportStatus={builderArtifactCoReview.transportStatus}
                  exactTextAvailable={builderExactTextAvailable}
                  canStartReview={builderArtifactCoReview.canStart}
                  reviewEnabled={builderArtifactCoReview.enabled}
                  visualReviewPreparing={visualReviewPreparing}
                  pendingStartVoiceReview={pendingBuilderArtifactReview}
                  visualCaptureStatus={stageUsesMarkdownPreview ? builderVisualCaptureStatus : null}
                  onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
                  onStartReview={() => { void builderArtifactCoReview.startReview() }}
                  onStopReview={() => { void builderArtifactCoReview.stopReview() }}
                />
              ) : (
                <ArtifactStage
                  builderArtifact={stageBuilderArtifact}
                  builderArtifactLibrary={builderArtifactLibrary}
                  threadId={threadId}
                  artifactId={builderArtifactId}
                  sessionId={sessionId}
                  normalSessionId={normalSessionId}
                  reviewState={builderArtifactCoReview.state}
                  transportStatus={builderArtifactCoReview.transportStatus}
                  exactTextAvailable={builderExactTextAvailable}
                  canStartReview={builderArtifactCoReview.canStart}
                  reviewEnabled={builderArtifactCoReview.enabled}
                  visualReviewRequiresVoice={visualReviewRequiresVoice}
                  pendingStartVoiceReview={pendingBuilderArtifactReview}
                  visualCaptureStatus={stageUsesMarkdownPreview ? builderVisualCaptureStatus : null}
                  onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
                  onStartVoiceReview={onStartVoiceBuilderArtifactReview}
                  onStartReview={() => { void builderArtifactCoReview.startReview() }}
                  onStopReview={() => { void builderArtifactCoReview.stopReview() }}
                  fillAvailable={isTextModeBuilderStage}
                  className={cn(isTextModeBuilderStage && "min-h-0 flex-1")}
                />
              )}
            </div>
          </div>
        )}

        <PresenceArtifactSecondarySurfaces
          artifacts={artifacts}
          builderArtifactLibrary={builderArtifactLibrary}
          stageBuilderArtifact={stageBuilderArtifact}
          showSecondaryArtifactSurfaces={showSecondaryArtifactSurfaces}
          showDomArtifactCoReview={showDomArtifactCoReview}
          threadId={threadId}
          sessionId={sessionId}
          normalSessionId={normalSessionId}
          revealStep={revealStep}
          isActive={isActive}
          bloomColor={bloomColor}
          reflectionTapped={reflectionTapped}
          domArtifactCoReview={domArtifactCoReview}
          onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
          onHandleReflectionTap={handleReflectionTap}
          onReflectionTap={onReflectionTap}
          onMemoryApprove={onMemoryApprove}
          onMemoryReject={onMemoryReject}
          onDomArtifactRootChange={setDomArtifactRoot}
        />
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
