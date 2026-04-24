"use client"

import {
  Activity,
  AlertTriangle,
  AudioLines,
  Clipboard,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  Ear,
  Gauge,
  GripVertical,
  Mic,
  Radio,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react"
import { startTransition, useEffect, useMemo, useRef, useState } from "react"

import { registerSophiaCaptureBridge, type SophiaCaptureBundle } from "../../lib/session-capture"
import { cn } from "../../lib/utils"
import {
  buildVoiceDeveloperMetrics,
  buildVoiceTelemetrySummary,
  sliceVoiceCaptureEventsToActiveRun,
  type VoiceBaselineRegression,
  type VoiceDeveloperMetrics,
  type VoiceRegressionMarker,
} from "../../lib/voice-runtime-metrics"
import {
  createVoiceTelemetryBaselineEntry,
  readVoiceTelemetryBaselineEntries,
  upsertVoiceTelemetryBaselineEntry,
} from "../../lib/voice-telemetry-baseline"
import type { VoiceStateProps } from "../../lib/voice-types"
import { useUiStore } from "../../stores/ui-store"

type VoiceMetricsPanelProps = {
  voiceState: VoiceStateProps
  defaultExpanded?: boolean
  layout?: "inline" | "floating"
}

type FloatingPanelBounds = {
  left: number
  top: number
  width: number
  height: number
}

type PointerInteraction = {
  pointerId: number
  startX: number
  startY: number
  origin: FloatingPanelBounds
}

const FLOATING_PANEL_STORAGE_KEY = "sophia.voiceTelemetryPanel.layout.v1"
const FLOATING_PANEL_COMPACT_MIN_WIDTH = 240
const FLOATING_PANEL_COMPACT_MIN_HEIGHT = 220
const FLOATING_PANEL_MIN_WIDTH = 320
const FLOATING_PANEL_MAX_WIDTH = 720
const FLOATING_PANEL_MIN_HEIGHT = 260
const FLOATING_PANEL_MAX_HEIGHT = 760
const FLOATING_PANEL_EDGE_PADDING = 12
const FLOATING_PANEL_TOP_PADDING = 76
const FLOATING_PANEL_HEADER_OFFSET = 164

function getFloatingWidthRange(viewportWidth: number): { minWidth: number; maxWidth: number } {
  const maxWidth = Math.min(
    FLOATING_PANEL_MAX_WIDTH,
    Math.max(FLOATING_PANEL_COMPACT_MIN_WIDTH, viewportWidth - (FLOATING_PANEL_EDGE_PADDING * 2)),
  )

  return {
    minWidth: Math.min(FLOATING_PANEL_MIN_WIDTH, maxWidth),
    maxWidth,
  }
}

function getFloatingHeightRange(viewportHeight: number): { minHeight: number; maxHeight: number } {
  const availableHeight = viewportHeight - FLOATING_PANEL_TOP_PADDING - FLOATING_PANEL_EDGE_PADDING
  const maxHeight = Math.min(
    FLOATING_PANEL_MAX_HEIGHT,
    Math.max(FLOATING_PANEL_COMPACT_MIN_HEIGHT, availableHeight),
  )

  return {
    minHeight: Math.min(FLOATING_PANEL_MIN_HEIGHT, maxHeight),
    maxHeight,
  }
}

function getDefaultFloatingBounds(viewportWidth: number, viewportHeight: number): FloatingPanelBounds {
  const { maxWidth } = getFloatingWidthRange(viewportWidth)
  const { minHeight, maxHeight } = getFloatingHeightRange(viewportHeight)
  const width = viewportWidth < 768
    ? maxWidth
    : Math.min(460, Math.max(360, Math.round(viewportWidth * 0.3)))
  const height = viewportHeight < 760
    ? Math.max(minHeight, viewportHeight - 140)
    : Math.min(560, maxHeight)

  return clampFloatingBounds({
    left: viewportWidth - width - 24,
    top: viewportWidth < 640 ? FLOATING_PANEL_TOP_PADDING : 88,
    width,
    height,
  }, viewportWidth, viewportHeight)
}

function clampFloatingBounds(
  bounds: FloatingPanelBounds,
  viewportWidth: number,
  viewportHeight: number,
): FloatingPanelBounds {
  const { minWidth, maxWidth } = getFloatingWidthRange(viewportWidth)
  const { minHeight, maxHeight } = getFloatingHeightRange(viewportHeight)
  const width = Math.min(Math.max(bounds.width, minWidth), maxWidth)
  const height = Math.min(Math.max(bounds.height, minHeight), maxHeight)
  const maxLeft = Math.max(FLOATING_PANEL_EDGE_PADDING, viewportWidth - width - FLOATING_PANEL_EDGE_PADDING)
  const maxTop = Math.max(FLOATING_PANEL_TOP_PADDING, viewportHeight - height - FLOATING_PANEL_EDGE_PADDING)

  return {
    left: Math.min(Math.max(bounds.left, FLOATING_PANEL_EDGE_PADDING), maxLeft),
    top: Math.min(Math.max(bounds.top, FLOATING_PANEL_TOP_PADDING), maxTop),
    width,
    height,
  }
}

function readPersistedFloatingBounds(defaultExpanded: boolean): {
  bounds: FloatingPanelBounds
  expanded: boolean
  hidden: boolean
} | null {
  if (typeof window === "undefined") return null

  try {
    const raw = window.localStorage.getItem(FLOATING_PANEL_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<FloatingPanelBounds> & { expanded?: boolean; hidden?: boolean }
    if (
      typeof parsed.left !== "number"
      || typeof parsed.top !== "number"
      || typeof parsed.width !== "number"
      || typeof parsed.height !== "number"
    ) {
      return null
    }

    return {
      bounds: {
        left: parsed.left,
        top: parsed.top,
        width: parsed.width,
        height: parsed.height,
      },
      expanded: typeof parsed.expanded === "boolean" ? parsed.expanded : defaultExpanded,
      hidden: typeof parsed.hidden === "boolean" ? parsed.hidden : false,
    }
  } catch {
    return null
  }
}

function scopeCaptureBundleToActiveRun(bundle: SophiaCaptureBundle): SophiaCaptureBundle {
  const activeRunEvents = sliceVoiceCaptureEventsToActiveRun(bundle.events)

  return {
    ...bundle,
    startedAt: activeRunEvents[0]?.recordedAt ?? bundle.startedAt,
    eventCount: activeRunEvents.length,
    events: activeRunEvents,
  }
}

export function VoiceMetricsPanel({
  voiceState,
  defaultExpanded = true,
  layout = "inline",
}: VoiceMetricsPanelProps) {
  const showToast = useUiStore((state) => state.showToast)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [hidden, setHidden] = useState(false)
  const [floatingBounds, setFloatingBounds] = useState<FloatingPanelBounds>({
    left: 24,
    top: 88,
    width: 420,
    height: 560,
  })
  const [hasHydratedFloatingState, setHasHydratedFloatingState] = useState(layout !== "floating")
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<PointerInteraction | null>(null)
  const resizeRef = useRef<PointerInteraction | null>(null)
  const baselinePersistFingerprintRef = useRef<string | null>(null)
  const [metrics, setMetrics] = useState<VoiceDeveloperMetrics>(() =>
    buildVoiceDeveloperMetrics({
      stage: voiceState.stage,
      events: [],
      snapshot: null,
      runtimeError: voiceState.error,
    }),
  )

  useEffect(() => {
    if (typeof window === "undefined") return

    registerSophiaCaptureBridge()

    const sync = () => {
      const capture = window.__sophiaCapture
      capture?.enable()

      const snapshot = capture?.snapshot() ?? null
      const events = capture?.getEvents() ?? []
      const baselineEntries = readVoiceTelemetryBaselineEntries()

      startTransition(() => {
        setMetrics(
          buildVoiceDeveloperMetrics({
            stage: voiceState.stage,
            events,
            snapshot,
            baselineEntries,
            runtimeError: voiceState.error,
          }),
        )
      })
    }

    sync()
    const intervalId = window.setInterval(sync, 250)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [voiceState.error, voiceState.stage])

  useEffect(() => {
    const persistenceFingerprint = [
      metrics.baseline.runKey ?? "no-run",
      metrics.timings.sessionReadyMs ?? "na",
      metrics.timings.joinLatencyMs ?? "na",
      metrics.pipeline.requestStartToFirstTextMs ?? "na",
      metrics.startup.bindToPlaybackStartMs ?? "na",
      metrics.transport.webrtc.subscriber.averageRoundTripTimeMs ?? metrics.transport.webrtc.subscriber.lastRoundTripTimeMs ?? "na",
      metrics.transport.webrtc.subscriber.averageJitterMs ?? metrics.transport.webrtc.subscriber.lastJitterMs ?? "na",
      metrics.transport.webrtc.subscriber.averagePacketLossPct ?? metrics.transport.webrtc.subscriber.lastPacketLossPct ?? "na",
    ].join("::")

    if (baselinePersistFingerprintRef.current === persistenceFingerprint) {
      return
    }

    const entry = createVoiceTelemetryBaselineEntry(metrics)
    if (!entry) {
      return
    }

    baselinePersistFingerprintRef.current = persistenceFingerprint
    upsertVoiceTelemetryBaselineEntry(entry)
  }, [metrics])

  const panelTone = useMemo(() => {
    if (metrics.baseline.regressions.some((regression) => regression.level === "bad")) {
      return "bad" as const
    }

    if (metrics.regressions.some((marker) => marker.level === "bad")) {
      return "bad" as const
    }

    if (metrics.baseline.regressions.some((regression) => regression.level === "warn")) {
      return "warn" as const
    }

    if (metrics.regressions.some((marker) => marker.level === "warn")) {
      return "warn" as const
    }

    return metrics.health.level
  }, [metrics.baseline.regressions, metrics.health.level, metrics.regressions])

  const isFloatingExpanded = layout === "floating" && expanded
  const floatingWide = layout === "floating" && floatingBounds.width >= 560

  const summaryCards = useMemo(
    () => [
      {
        label: "Session ready",
        value: metrics.timings.sessionReadyMs,
        hint: "start -> Sophia ready",
        icon: Sparkles,
        tone: metrics.thresholds.sessionReady.status,
      },
      {
        label: "Join latency",
        value: metrics.timings.joinLatencyMs,
        hint: "credentials -> joined",
        icon: Radio,
        tone: metrics.thresholds.joinLatency.status,
      },
      {
        label: "Committed response",
        value: metrics.pipeline.committedTurnCloseMs ?? metrics.pipeline.userEndedToFirstTextMs ?? metrics.pipeline.userEndedToAgentStartMs,
        hint: metrics.pipeline.committedTurnCloseMs !== null
          ? "committed transcript -> agent start"
          : "public turn -> first visible response",
        icon: Clock3,
        tone: metrics.thresholds.committedResponse.status,
      },
      {
        label: "Raw first text",
        value: metrics.lastTurn.firstTextMs,
        hint: "diagnostic raw speech end -> first text",
        icon: AudioLines,
        tone: metrics.thresholds.firstText.status,
      },
      {
        label: "Raw first audio",
        value: metrics.lastTurn.firstAudioMs,
        hint: "diagnostic raw speech end -> first audio",
        icon: AudioLines,
        tone: metrics.thresholds.firstAudio.status,
      },
      {
        label: "Raw backend done",
        value: metrics.lastTurn.backendCompleteMs,
        hint: "diagnostic raw speech end -> backend complete",
        icon: Gauge,
        tone: metrics.thresholds.backendComplete.status,
      },
      {
        label: metrics.thresholds.responseWindow.label,
        value: metrics.stage === "thinking"
          ? metrics.timings.currentThinkingMs
          : metrics.lastTurn.responseDurationMs,
        hint: metrics.stage === "thinking" ? "live thinking timer" : "agent started -> ended",
        icon: Activity,
        tone: metrics.thresholds.responseWindow.status,
      },
    ],
    [metrics],
  )

  const compactSummaryCards = useMemo(
    () => summaryCards.filter((card) => ["Session ready", "Committed response", "Raw first text"].includes(card.label)),
    [summaryCards],
  )

  const displayedSummaryCards = layout === "floating" && !expanded ? compactSummaryCards : summaryCards

  useEffect(() => {
    if (layout !== "floating" || typeof window === "undefined") return

    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const persisted = readPersistedFloatingBounds(defaultExpanded)
    const nextBounds = persisted?.bounds ?? getDefaultFloatingBounds(viewportWidth, viewportHeight)

    setFloatingBounds(clampFloatingBounds(nextBounds, viewportWidth, viewportHeight))
    setExpanded(persisted?.expanded ?? defaultExpanded)
    setHidden(persisted?.hidden ?? false)
    setHasHydratedFloatingState(true)
  }, [defaultExpanded, layout])

  useEffect(() => {
    if (layout !== "floating" || typeof window === "undefined" || !hasHydratedFloatingState) return

    window.localStorage.setItem(
      FLOATING_PANEL_STORAGE_KEY,
      JSON.stringify({ ...floatingBounds, expanded, hidden }),
    )
  }, [expanded, floatingBounds, hasHydratedFloatingState, hidden, layout])

  useEffect(() => {
    if (layout !== "floating" || typeof window === "undefined") return

    const handleResize = () => {
      setFloatingBounds((current) => clampFloatingBounds(current, window.innerWidth, window.innerHeight))
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [layout])

  useEffect(() => {
    if (layout !== "floating") return

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragRef.current
      if (event.pointerId === dragState?.pointerId) {
        const { origin, startX, startY } = dragState
        setFloatingBounds(
          clampFloatingBounds({
            ...origin,
            left: origin.left + (event.clientX - startX),
            top: origin.top + (event.clientY - startY),
          }, window.innerWidth, window.innerHeight),
        )
        return
      }

      const resizeState = resizeRef.current
      if (event.pointerId === resizeState?.pointerId) {
        const { origin, startX, startY } = resizeState
        setFloatingBounds(
          clampFloatingBounds({
            ...origin,
            width: origin.width + (event.clientX - startX),
            height: origin.height + (event.clientY - startY),
          }, window.innerWidth, window.innerHeight),
        )
      }
    }

    const stopInteraction = (event: PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) {
        dragRef.current = null
        setIsDragging(false)
      }

      if (event.pointerId === resizeRef.current?.pointerId) {
        resizeRef.current = null
        setIsResizing(false)
      }
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", stopInteraction)
    window.addEventListener("pointercancel", stopInteraction)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", stopInteraction)
      window.removeEventListener("pointercancel", stopInteraction)
    }
  }, [layout])

  const serializeSessionJson = () => {
    if (typeof window === "undefined") {
      return null
    }

    const capture = window.__sophiaCapture
    if (!capture) {
      return null
    }

    const rawCaptureBundle = capture.export()
    const captureBundle = scopeCaptureBundleToActiveRun(rawCaptureBundle)
    const summary = buildVoiceTelemetrySummary(metrics)

    return JSON.stringify(
      {
        reportType: "voice-telemetry-report",
        version: 1,
        source: "session-ui",
        exportedAt: new Date().toISOString(),
        highlights: {
          bottleneckHint: summary.bottleneckHint,
          topHotspots: summary.topHotspots,
          baselineRegressions: metrics.baseline.regressions.slice(0, 3),
          webrtc: {
            datacenter: metrics.transport.webrtc.datacenter,
            sampleCount: metrics.transport.webrtc.sampleCount,
            subscriberRoundTripTimeMs: metrics.transport.webrtc.subscriber.averageRoundTripTimeMs ?? metrics.transport.webrtc.subscriber.lastRoundTripTimeMs,
            subscriberJitterMs: metrics.transport.webrtc.subscriber.averageJitterMs ?? metrics.transport.webrtc.subscriber.lastJitterMs,
            subscriberPacketLossPct: metrics.transport.webrtc.subscriber.averagePacketLossPct ?? metrics.transport.webrtc.subscriber.lastPacketLossPct,
          },
        },
        summary,
        metrics,
        captureWindow: {
          scope: "active-run",
          exportedEventCount: captureBundle.eventCount,
          rawEventCount: rawCaptureBundle.eventCount,
          trimmedEventCount: Math.max(0, rawCaptureBundle.eventCount - captureBundle.eventCount),
        },
        captureBundle,
        rawCaptureBundle,
      },
      null,
      2,
    )
  }

  const clearSessionCapture = () => {
    if (typeof window === "undefined") {
      return
    }

    const capture = window.__sophiaCapture
    if (!capture) {
      showToast({ message: "Capture is unavailable right now", variant: "warning", durationMs: 2200 })
      return
    }

    capture.clear()

    startTransition(() => {
      setMetrics(
        buildVoiceDeveloperMetrics({
          stage: voiceState.stage,
          events: [],
          snapshot: capture.snapshot() ?? null,
          baselineEntries: readVoiceTelemetryBaselineEntries(),
          runtimeError: voiceState.error,
        }),
      )
    })

    showToast({ message: "Capture cleared for a fresh bottleneck trace", variant: "success", durationMs: 1800 })
  }

  const copySessionJson = async () => {
    try {
      const payload = serializeSessionJson()
      if (!payload || typeof navigator?.clipboard?.writeText !== "function") {
        showToast({ message: "Session JSON is unavailable right now", variant: "warning", durationMs: 2200 })
        return
      }

      await navigator.clipboard.writeText(payload)
      showToast({ message: "Voice telemetry report copied", variant: "success", durationMs: 1800 })
    } catch {
      showToast({ message: "Could not copy session JSON", variant: "error", durationMs: 2200 })
    }
  }

  const exportSessionJson = () => {
    try {
      const payload = serializeSessionJson()
      if (!payload || typeof document === "undefined") {
        showToast({ message: "Session JSON is unavailable right now", variant: "warning", durationMs: 2200 })
        return
      }

      const blob = new Blob([payload], { type: "application/json" })
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")

      anchor.href = href
      anchor.download = `sophia-voice-telemetry-report-${stamp}.json`
      anchor.click()
      URL.revokeObjectURL(href)
      showToast({ message: "Voice telemetry report exported", variant: "success", durationMs: 1800 })
    } catch {
      showToast({ message: "Could not export session JSON", variant: "error", durationMs: 2200 })
    }
  }

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (layout !== "floating") return

    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: floatingBounds,
    }
    setIsDragging(true)
  }

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (layout !== "floating") return

    event.preventDefault()
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: floatingBounds,
    }
    setIsResizing(true)
  }

  const resetFloatingPanel = () => {
    if (typeof window === "undefined") return

    setFloatingBounds(getDefaultFloatingBounds(window.innerWidth, window.innerHeight))
    setExpanded(defaultExpanded)
    setHidden(false)
  }

  const hideFloatingPanel = () => {
    dragRef.current = null
    resizeRef.current = null
    setIsDragging(false)
    setIsResizing(false)
    setHidden(true)
  }

  const floatingContainerStyle = layout === "floating"
    ? {
        left: floatingBounds.left,
        top: floatingBounds.top,
        width: floatingBounds.width,
        maxWidth: `calc(100vw - ${FLOATING_PANEL_EDGE_PADDING * 2}px)`,
      }
    : undefined

  const panelStyle = isFloatingExpanded
    ? { height: floatingBounds.height }
    : undefined

  const latestFalseEndsDisplay = Math.max((metrics.lastTurn.falseUserEndedCount ?? 1) - 1, 0)
  const builderTone = metrics.builder.phase === "failed" || metrics.builder.phase === "timed_out"
    ? "bad"
    : metrics.builder.stuck
      ? "warn"
      : metrics.builder.phase === "completed"
        ? "good"
        : metrics.builder.phase === "running"
          ? "neutral"
          : "neutral"
  const connectSourceTone = metrics.startup.credentialsSource === "prefetched"
    ? "good"
    : metrics.startup.credentialsSource === "fresh"
      ? "neutral"
      : "warn"
  const warmupTone = metrics.startup.backendWarmupStatus === "completed"
    ? "good"
    : metrics.startup.backendWarmupStatus === "failed"
      ? "warn"
      : "neutral"

  const panel = (
    <section className={cn(
      "relative overflow-hidden rounded-[28px] border text-sophia-text shadow-soft transition-colors duration-300",
      panelToneClass(panelTone),
      layout === "floating" && "flex max-h-[calc(100vh-88px)] flex-col backdrop-blur-md",
      isDragging && "select-none",
      isResizing && "select-none",
    )} style={panelStyle}>
      <div className={cn(
        "flex gap-4 border-b border-white/8 px-5 py-5",
        layout === "floating"
          ? "flex-col"
          : "flex-col sm:flex-row sm:items-start sm:justify-between",
      )}>
        <div className="flex min-w-0 flex-1 gap-3">
          {layout === "floating" && (
            <button
              type="button"
              onPointerDown={beginDrag}
              title="Drag telemetry panel"
              className={cn(
                "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-sophia-text2 transition-colors hover:bg-white/10 hover:text-sophia-text",
                isDragging && "cursor-grabbing bg-white/10 text-sophia-text",
                !isDragging && "cursor-grab",
              )}
              style={{ touchAction: "none" }}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}

          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.32em] text-sophia-text2/70">
              <Activity className="h-3.5 w-3.5" />
              Voice runtime telemetry
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ToneBadge label={metrics.health.title} tone={metrics.health.level} />
              <ToneBadge label={`Stage: ${metrics.stage}`} tone="neutral" />
              <ToneBadge
                label={`Transport: ${metrics.transport.activeSource.toUpperCase()}`}
                tone={metrics.transport.activeSource === "custom" ? "warn" : "good"}
              />
              <ToneBadge
                label={`Connect: ${formatCredentialsSource(metrics.startup.credentialsSource)}`}
                tone={connectSourceTone}
              />
              {metrics.transport.playback.currentState !== "pending" && (
                <ToneBadge
                  label={`Playback: ${formatPlaybackState(metrics.transport.playback.currentState)}`}
                  tone={metrics.transport.playback.timeoutCount > 0 || metrics.transport.playback.errorCount > 0
                    ? "bad"
                    : metrics.transport.playback.bindToPlayingMs !== null && metrics.transport.playback.bindToPlayingMs >= 1500
                      ? "warn"
                      : metrics.transport.playback.currentState === "playing"
                        ? "good"
                        : "neutral"}
                />
              )}
              {metrics.transport.reconnect.count > 0 && (
                <ToneBadge
                  label={`Reconnects: ${metrics.transport.reconnect.count}`}
                  tone={metrics.transport.reconnect.failed > 0 || metrics.transport.reconnect.activeDowntimeMs !== null ? "bad" : "warn"}
                />
              )}
              {metrics.startup.backendWarmupStatus !== "idle" && (
                <ToneBadge
                  label={`Warmup: ${formatWarmupStatus(metrics.startup.backendWarmupStatus)}`}
                  tone={warmupTone}
                />
              )}
              <ToneBadge
                label={metrics.microphone.detectedAudio ? "Mic signal detected" : "No mic signal yet"}
                tone={metrics.microphone.detectedAudio ? "good" : "warn"}
              />
              {metrics.builder.phase && (
                <ToneBadge
                  label={`Builder: ${metrics.builder.phase}${typeof metrics.builder.progressPercent === "number" ? ` ${metrics.builder.progressPercent}%` : ""}`}
                  tone={builderTone}
                />
              )}
              {metrics.regressions.length > 0 && (
                <ToneBadge
                  label={`${metrics.regressions.length} regression ${metrics.regressions.length === 1 ? "marker" : "markers"}`}
                  tone={panelTone === "bad" ? "bad" : "warn"}
                />
              )}
            </div>
            <p className={cn(
              "leading-relaxed text-sophia-text2",
              layout === "floating" && !expanded ? "max-w-none text-xs" : "max-w-3xl text-sm",
            )}>
              {metrics.health.detail}
            </p>
          </div>
        </div>

        <div className={cn(
          "flex flex-wrap items-center gap-2 self-start",
          layout === "floating" && "w-full",
        )}>
          {(layout === "inline" || expanded) && (
            <>
              <button
                type="button"
                onClick={() => {
                  void copySessionJson()
                }}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sophia-text2 transition-colors hover:bg-white/10 hover:text-sophia-text"
              >
                <Clipboard className="h-3.5 w-3.5" />
                Copy JSON
              </button>
              <button
                type="button"
                onClick={clearSessionCapture}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sophia-text2 transition-colors hover:bg-white/10 hover:text-sophia-text"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Clear capture
              </button>
              <button
                type="button"
                onClick={exportSessionJson}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sophia-text2 transition-colors hover:bg-white/10 hover:text-sophia-text"
              >
                <Download className="h-3.5 w-3.5" />
                Export JSON
              </button>
            </>
          )}
          {layout === "floating" && (
            <button
              type="button"
              onClick={resetFloatingPanel}
              title="Reset panel position and size"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sophia-text2 transition-colors hover:bg-white/10 hover:text-sophia-text"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset panel
            </button>
          )}
          {layout === "floating" && (
            <button
              type="button"
              onClick={hideFloatingPanel}
              title="Hide telemetry panel"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sophia-text2 transition-colors hover:bg-white/10 hover:text-sophia-text"
            >
              <X className="h-3.5 w-3.5" />
              Hide panel
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sophia-text2 transition-colors hover:bg-white/10 hover:text-sophia-text"
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {expanded ? "Collapse metrics" : layout === "floating" ? "Expand panel" : "Expand metrics"}
          </button>
        </div>
      </div>

      <div
        className={cn(
          isFloatingExpanded && "flex-1 min-h-0 overflow-y-auto pr-1",
        )}
        style={isFloatingExpanded ? { maxHeight: floatingBounds.height - FLOATING_PANEL_HEADER_OFFSET } : undefined}
      >
        <div className={cn(
          "grid gap-3 px-5 py-5",
          layout === "floating"
            ? expanded
              ? floatingWide
                ? "grid-cols-2"
                : "grid-cols-1"
              : "grid-cols-1"
            : "sm:grid-cols-2 xl:grid-cols-3",
        )}>
          {displayedSummaryCards.map((card) => (
            <MetricCard
              key={card.label}
              icon={card.icon}
              label={card.label}
              hint={withThresholdHint(card.hint, metrics.thresholds[thresholdKeyForLabel(card.label)])}
              value={formatMs(card.value)}
              tone={card.tone}
              emphasize={card.label === "Current wait" && metrics.timings.currentThinkingMs !== null && metrics.timings.currentThinkingMs > 4000}
              compact={layout === "floating" && !expanded}
            />
          ))}
        </div>

        {expanded && (
          <>
            <div className={cn(
              "grid gap-4 border-t border-white/8 px-5 py-5",
              layout === "floating" ? "grid-cols-1" : "lg:grid-cols-[1.1fr_0.9fr]",
            )}>
              <BottleneckCard metrics={metrics} />
              <InfoCard
                icon={Sparkles}
                title="Startup path"
                rows={[
                  ["connect source", formatCredentialsSource(metrics.startup.credentialsSource)],
                  ["preconnect fetch", formatMs(metrics.startup.preconnectFetchMs)],
                  ["prepared age", formatMs(metrics.startup.preparedCredentialAgeMs)],
                  ["warmup status", formatWarmupStatus(metrics.startup.backendWarmupStatus)],
                  ["warmup duration", formatMs(metrics.startup.backendWarmupDurationMs)],
                  ["request -> credentials", formatMs(metrics.startup.requestToCredentialsMs)],
                  ["credentials -> join", formatMs(metrics.startup.credentialsToJoinMs)],
                  ["join -> ready", formatMs(metrics.startup.joinToReadyMs)],
                  ["join -> audio bound", formatMs(metrics.startup.joinToRemoteAudioMs)],
                  ["join -> playback", formatMs(metrics.startup.joinToPlaybackStartMs)],
                  ["bind -> playback", formatMs(metrics.startup.bindToPlaybackStartMs)],
                  ["start -> mic audio", formatMs(metrics.startup.startToMicAudioMs)],
                  ["start -> first transcript", formatMs(metrics.startup.startToFirstUserTranscriptMs)],
                ]}
                footer={buildStartupFooter(metrics)}
                tone={startupCardTone(metrics)}
              />
            </div>

            <div className={cn(
              "grid gap-3 border-t border-white/8 px-5 py-5",
              layout === "floating" ? "grid-cols-1" : "md:grid-cols-3",
            )}>
              {metrics.regressions.length === 0 && metrics.baseline.regressions.length === 0 && (
                <div className="md:col-span-3 rounded-3xl border border-emerald-300/15 bg-emerald-300/6 px-4 py-4 text-sm text-emerald-100/90">
                  No active regression markers. The latest thresholds are within target ranges for this voice turn.
                </div>
              )}
              {metrics.regressions.map((marker) => (
                <RegressionCard key={marker.key} marker={marker} />
              ))}
              {metrics.baseline.regressions.map((regression) => (
                <BaselineRegressionCard key={regression.key} regression={regression} />
              ))}
            </div>

            <div className={cn(
              "grid gap-4 border-t border-white/8 px-5 py-5",
              layout === "floating" ? "grid-cols-1" : "xl:grid-cols-[1.2fr_0.8fr]",
            )}>
              <div className="space-y-4">
                <div className={cn(
                  "grid gap-4",
                  layout === "floating" ? "grid-cols-1" : "lg:grid-cols-2",
                )}>
                  <InfoCard
                    icon={Mic}
                    title="Microphone"
                    rows={[
                      ["Streams", String(metrics.microphone.streamCount)],
                      ["Tracks", String(metrics.microphone.audioTrackCount)],
                      ["Detected audio", metrics.microphone.detectedAudio ? "yes" : "no"],
                      ["First audio", formatIsoAge(metrics.microphone.firstAudioAt)],
                      ["Last audio", formatIsoAge(metrics.microphone.lastAudioAt)],
                      ["Peak RMS", formatDecimal(metrics.microphone.maxRms)],
                      ["Peak abs", formatDecimal(metrics.microphone.maxAbsPeak)],
                      ["Sample windows", String(metrics.microphone.totalSampleWindows)],
                      ["Probe errors", String(metrics.microphone.errorCount)],
                    ]}
                    footer={metrics.microphone.lastError ?? "Browser probe installed and listening for non-silent windows."}
                    tone={metrics.regressions.some((marker) => marker.key === "microphone" && marker.level === "bad")
                      ? "bad"
                      : metrics.regressions.some((marker) => marker.key === "microphone")
                        ? "warn"
                        : metrics.microphone.detectedAudio
                          ? "good"
                          : "warn"}
                  />
                  <InfoCard
                    icon={Ear}
                    title="Turn flow"
                    rows={[
                      ["Turns", String(metrics.counts.turns)],
                      ["User transcripts", String(metrics.counts.userTranscripts)],
                      ["Assistant transcripts", String(metrics.counts.assistantTranscripts)],
                      ["Artifacts", String(metrics.counts.artifacts)],
                      ["Diagnostics", String(metrics.counts.diagnostics)],
                      ["Committed transcript -> agent start", formatMs(metrics.pipeline.committedTurnCloseMs)],
                      ["User end -> agent start", formatMs(metrics.pipeline.userEndedToAgentStartMs)],
                      ["transcript -> user ended", formatMs(metrics.pipeline.transcriptToUserEndedMs)],
                    ]}
                    footer={buildTurnFlowFooter(metrics)}
                    tone={metrics.regressions.some((marker) => marker.key === "turn-segmentation" && marker.level === "bad")
                      ? "bad"
                      : metrics.regressions.some((marker) => marker.key === "turn-segmentation")
                        ? "warn"
                        : metrics.lastTurn.status === "failed"
                          ? "bad"
                          : "neutral"}
                  />
                </div>

                <InfoCard
                  icon={Gauge}
                  title="Response pipeline"
                  rows={[
                    ["mic -> transcript", formatMs(metrics.pipeline.micToUserTranscriptMs)],
                    ["committed transcript -> agent start", formatMs(metrics.pipeline.committedTurnCloseMs)],
                    ["user end -> first visible text", formatMs(metrics.pipeline.userEndedToFirstTextMs)],
                    ["user end -> agent start", formatMs(metrics.pipeline.userEndedToAgentStartMs)],
                    ["user end -> request", formatMs(metrics.pipeline.userEndedToRequestStartMs)],
                    ["pre-request stabilization", formatMs(metrics.pipeline.submissionStabilizationMs)],
                    ["request -> first backend event", formatMs(metrics.pipeline.requestStartToFirstBackendEventMs)],
                    ["first backend event -> raw first text", formatMs(metrics.pipeline.firstBackendEventToFirstTextMs)],
                    ["request -> raw first text", formatMs(metrics.pipeline.requestStartToFirstTextMs)],
                    ["raw speech end -> first text", formatMs(metrics.pipeline.rawSpeechEndToFirstTextMs)],
                    ["raw first text -> backend done", formatMs(metrics.pipeline.firstTextToBackendCompleteMs)],
                    ["raw speech end -> backend done", formatMs(metrics.pipeline.rawSpeechEndToBackendCompleteMs)],
                    ["raw backend done -> first audio", formatMs(metrics.pipeline.backendToFirstAudioMs)],
                    ["raw first text -> first audio", formatMs(metrics.pipeline.textToFirstAudioMs)],
                    ["raw speech end -> first audio", formatMs(metrics.pipeline.rawSpeechEndToFirstAudioMs)],
                    ["response window", formatMs(metrics.lastTurn.responseDurationMs)],
                  ]}
                  footer="Committed turn-close, pre-request stabilization, and raw diagnostic latency are shown separately so transcript settling does not look like a pure backend stall."
                  tone={metrics.bottleneck.kind === "backend" || metrics.bottleneck.kind === "tts" || metrics.bottleneck.kind === "commit-boundary"
                    ? metrics.bottleneck.level
                    : "neutral"}
                />
              </div>

              <div className="space-y-4">
                <InfoCard
                  icon={Radio}
                  title="Transport + session"
                  rows={[
                    ["Session", metrics.sessionIds.sessionId ?? "pending"],
                    ["Thread", metrics.sessionIds.threadId ?? "pending"],
                    ["Call", metrics.sessionIds.callId ?? "pending"],
                    ["Voice agent", metrics.sessionIds.voiceAgentSessionId ?? "pending"],
                    ["Run", metrics.sessionIds.runId ?? "pending"],
                    ["Transport", metrics.transport.activeSource.toUpperCase()],
                    ["Remote participants", metrics.transport.remoteParticipantCount?.toString() ?? "pending"],
                    ["Playback state", formatPlaybackState(metrics.transport.playback.currentState)],
                    ["bind -> can play", formatMs(metrics.transport.playback.bindToCanPlayMs)],
                    ["bind -> playback", formatMs(metrics.transport.playback.bindToPlayingMs)],
                    ...(metrics.transport.playback.lastTimeoutDurationMs !== null
                      ? [["playback timeout", formatMs(metrics.transport.playback.lastTimeoutDurationMs)] as [string, string]]
                      : []),
                    ["Reconnects", String(metrics.transport.reconnect.count)],
                    ["Last downtime", formatMs(metrics.transport.reconnect.lastDowntimeMs)],
                    ["Active downtime", formatMs(metrics.transport.reconnect.activeDowntimeMs)],
                    ["SSE open", formatMs(metrics.timings.sseOpenMs)],
                    ["Last event age", formatMs(metrics.timings.lastEventAgeMs)],
                    ["Connection", formatNetworkConnection(metrics.transport.network)],
                    ["Network RTT", formatMs(metrics.transport.network.rttMs)],
                    ["Downlink", formatDownlink(metrics.transport.network.downlinkMbps)],
                    ["Save-data", formatBooleanValue(metrics.transport.network.saveData)],
                    ["Datacenter", metrics.transport.webrtc.datacenter ?? "pending"],
                    ["WebRTC samples", String(metrics.transport.webrtc.sampleCount)],
                    ["Sub RTT", formatMs(metrics.transport.webrtc.subscriber.averageRoundTripTimeMs ?? metrics.transport.webrtc.subscriber.lastRoundTripTimeMs)],
                    ["Sub jitter", formatMs(metrics.transport.webrtc.subscriber.averageJitterMs ?? metrics.transport.webrtc.subscriber.lastJitterMs)],
                    ["Sub loss", formatPercentCompact(metrics.transport.webrtc.subscriber.averagePacketLossPct ?? metrics.transport.webrtc.subscriber.lastPacketLossPct)],
                  ]}
                  footer={buildTransportFooter(metrics)}
                  tone={transportCardTone(metrics)}
                />

                <BaselineComparisonCard metrics={metrics} />

                <InfoCard
                  icon={Activity}
                  title="Event counters"
                  rows={[
                    ["Total events", String(metrics.events.total)],
                    ["voice-sse", String(metrics.events.voiceSse)],
                    ["stream-custom", String(metrics.events.streamCustom)],
                    ["voice-runtime", String(metrics.events.voiceRuntime)],
                    ["voice-session", String(metrics.events.voiceSession)],
                    ["harness-input", String(metrics.events.harnessInput)],
                    ["builder", String(metrics.events.builder)],
                    ["Start ignored", String(metrics.events.startIgnored)],
                    ["Startup timeouts", String(metrics.events.startupTimeouts)],
                    ["Stale connect", String(metrics.events.staleConnectResponses)],
                    ["Playback bound", String(metrics.events.playbackBound)],
                    ["Playback can play", String(metrics.events.playbackCanPlay)],
                    ["Playback started", String(metrics.events.playbackStarted)],
                    ["Playback waiting", String(metrics.events.playbackWaiting)],
                    ["Playback stalled", String(metrics.events.playbackStalled)],
                    ["Playback errors", String(metrics.events.playbackErrors)],
                    ["Playback timeouts", String(metrics.events.playbackTimeouts)],
                    ["Preconnect ready", String(metrics.events.preconnectReady)],
                    ["Preconnect reused", String(metrics.events.preconnectReused)],
                    ["Preconnect failed", String(metrics.events.preconnectFailed)],
                    ["Warmup completed", String(metrics.events.warmupCompleted)],
                    ["Warmup failed", String(metrics.events.warmupFailed)],
                    ["Reconnect started", String(metrics.events.reconnectStarted)],
                    ["Reconnect recovered", String(metrics.events.reconnectRecovered)],
                    ["Reconnect failed", String(metrics.events.reconnectFailed)],
                    ["SSE errors", String(metrics.events.sseErrors)],
                    ["Invalid payloads", String(metrics.events.invalidPayloads)],
                    ["Duplicate transcripts", String(metrics.events.duplicateUserTranscriptIgnored)],
                  ]}
                  footer="These counters separate transport noise from startup retries, browser playback stalls, and reconnect churn."
                  tone={metrics.bottleneck.kind === "transport" ? metrics.bottleneck.level : "neutral"}
                />

                <InfoCard
                  icon={AlertTriangle}
                  title="Latest diagnostic"
                  rows={[
                    ["Turn ID", metrics.lastTurn.turnId ?? "pending"],
                    ["Status", metrics.lastTurn.status ?? "pending"],
                    ["Reason", metrics.lastTurn.reason ?? "pending"],
                    ["Extra false ends", latestFalseEndsDisplay.toString()],
                    ["Last user", metrics.lastTurn.lastUserTranscript ? truncate(metrics.lastTurn.lastUserTranscript, 34) : "pending"],
                    ["Last Sophia", metrics.lastTurn.lastAssistantTranscript ? truncate(metrics.lastTurn.lastAssistantTranscript, 34) : "pending"],
                  ]}
                  footer={formatDuplicatePhaseFooter(metrics.lastTurn.duplicatePhaseCounts)}
                  tone={metrics.regressions.some((marker) => (marker.key === "backend-stall" || marker.key === "commit-boundary") && marker.level === "bad")
                    ? "bad"
                    : metrics.regressions.some((marker) => marker.key === "backend-stall" || marker.key === "commit-boundary")
                      ? "warn"
                      : metrics.lastTurn.status === "failed"
                        ? "bad"
                        : metrics.lastTurn.reason && metrics.lastTurn.reason !== "completed"
                          ? "warn"
                          : "neutral"}
                />

                <InfoCard
                  icon={Activity}
                  title="Builder workflow"
                  rows={[
                    ["Phase", metrics.builder.phase ?? "inactive"],
                    ["Progress", formatPercent(metrics.builder.progressPercent)],
                    ["Steps", metrics.builder.totalSteps !== null ? `${metrics.builder.completedSteps ?? 0}/${metrics.builder.totalSteps}` : "pending"],
                    ["Active step", metrics.builder.activeStepTitle ?? "pending"],
                    ["Idle", formatMs(metrics.builder.idleMs)],
                    ["Last update", formatIsoAge(metrics.builder.lastUpdateAt)],
                    ["Last progress", formatIsoAge(metrics.builder.lastProgressAt)],
                  ]}
                  footer={metrics.builder.stuckReason
                    ?? metrics.builder.detail
                    ?? (metrics.builder.phase === "running"
                      ? "Builder heartbeats and todo completion are recorded here while the deliverable is assembled."
                      : "Builder telemetry appears once a companion turn delegates to the builder.")}
                  tone={builderTone}
                />

                <RecentTurnsCard turns={metrics.recentTurns} />

                <div className="rounded-3xl border border-white/8 bg-white/4 p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-sophia-text">
                    <Sparkles className="h-4 w-4 text-sophia-text2/80" />
                    Recent timeline
                  </div>
                  <div className="space-y-2.5">
                    {metrics.timeline.length === 0 && (
                      <p className="text-sm text-sophia-text2">
                        Waiting for capture events from the current voice turn.
                      </p>
                    )}
                    {metrics.timeline.map((item) => (
                      <div key={item.id} className="rounded-2xl border border-white/6 bg-black/15 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <div className="flex items-center gap-2 text-sophia-text">
                            <span className={timelineToneClass(item.tone)} />
                            <span className="font-medium">{item.label}</span>
                          </div>
                          <span className="text-sophia-text2/70">{item.sinceStartMs === null ? "--" : `+${formatMsCompact(item.sinceStartMs)}`}</span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-sophia-text2">
                          {item.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {layout === "floating" && expanded && (
        <button
          type="button"
          aria-label="Resize telemetry panel"
          onPointerDown={beginResize}
          className={cn(
            "absolute bottom-3 right-3 h-6 w-6 cursor-se-resize rounded-sm border-r-2 border-b-2 border-white/35 opacity-80 transition-opacity hover:opacity-100",
            isResizing && "opacity-100",
          )}
          style={{ touchAction: "none" }}
        />
      )}
    </section>
  )

  if (layout === "floating") {
    if (!hasHydratedFloatingState) {
      return null
    }

    if (hidden) {
      return (
        <div className="pointer-events-none fixed bottom-4 right-4 z-40">
          <button
            type="button"
            onClick={() => setHidden(false)}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-[color:color-mix(in_srgb,var(--cosmic-panel-strong)_88%,black_12%)] px-4 py-2.5 text-xs font-medium text-sophia-text shadow-[var(--cosmic-shadow-md)] backdrop-blur-md transition-colors hover:bg-[color:color-mix(in_srgb,var(--cosmic-panel-strong)_96%,black_4%)]"
          >
            <Activity className="h-3.5 w-3.5" />
            Show telemetry
          </button>
        </div>
      )
    }

    return (
      <div className="pointer-events-auto fixed z-40" style={floatingContainerStyle}>
        {panel}
      </div>
    )
  }

  return panel
}

function BottleneckCard({ metrics }: { metrics: VoiceDeveloperMetrics }) {
  return (
    <div className={cn(
      "rounded-3xl border p-5",
      metrics.bottleneck.level === "bad"
        ? "border-rose-300/20 bg-rose-300/8"
        : metrics.bottleneck.level === "warn"
          ? "border-amber-300/20 bg-amber-300/8"
          : metrics.bottleneck.level === "good"
            ? "border-emerald-300/15 bg-emerald-300/6"
            : "border-white/8 bg-white/4",
    )}>
      <div className="flex items-center gap-2 text-sm font-semibold text-sophia-text">
        <Activity className="h-4 w-4" />
        Primary bottleneck
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ToneBadge label={metrics.bottleneck.title} tone={metrics.bottleneck.level} />
        <ToneBadge label={`kind: ${metrics.bottleneck.kind}`} tone="neutral" />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-sophia-text2">
        {metrics.bottleneck.detail}
      </p>
      <div className="mt-4 space-y-2">
        {metrics.bottleneck.evidence.length === 0 && (
          <p className="text-xs text-sophia-text2/80">No supporting evidence yet for this turn.</p>
        )}
        {metrics.bottleneck.evidence.map((item) => (
          <div key={item} className="rounded-2xl border border-white/8 bg-black/15 px-3 py-2 text-xs text-sophia-text2">
            {item}
          </div>
        ))}
      </div>
      {metrics.topHotspots.length > 0 && (
        <div className="mt-4 border-t border-white/8 pt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-sophia-text2/70">
            Top timing hotspots
          </div>
          <div className="space-y-2">
            {metrics.topHotspots.map((hotspot) => (
              <div key={hotspot.key} className="rounded-2xl border border-white/8 bg-black/15 px-3 py-2 text-xs text-sophia-text2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-sophia-text">{hotspot.label}</span>
                  <ToneBadge label={`${formatMs(hotspot.valueMs)} · ${hotspot.area}`} tone={hotspot.level} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  hint,
  value,
  tone,
  emphasize = false,
  compact = false,
}: {
  icon: typeof Activity
  label: string
  hint: string
  value: string
  tone: "good" | "warn" | "bad" | "neutral"
  emphasize?: boolean
  compact?: boolean
}) {
  return (
    <div className={cn(
      compact ? "rounded-3xl border px-3 py-3" : "rounded-3xl border px-4 py-4",
      metricCardToneClass(tone, emphasize),
    )}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-sophia-text2/65">{label}</p>
          <p className={cn(
            "mt-2 font-semibold tracking-tight text-sophia-text",
            compact ? "text-xl" : "text-2xl",
          )}>{value}</p>
        </div>
        <div className={cn(
          "flex items-center justify-center rounded-2xl bg-black/20 text-sophia-text2",
          compact ? "h-9 w-9" : "h-10 w-10",
        )}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className={cn("text-xs text-sophia-text2/75", compact ? "mt-2" : "mt-3")}>{hint}</p>
    </div>
  )
}

function RegressionCard({ marker }: { marker: VoiceRegressionMarker }) {
  return (
    <div className={cn(
      "rounded-3xl border px-4 py-4",
      marker.level === "bad"
        ? "border-rose-300/20 bg-rose-300/8"
        : "border-amber-300/20 bg-amber-300/8",
    )}>
      <div className="flex items-center gap-2 text-sm font-semibold text-sophia-text">
        {marker.key === "microphone" ? (
          <Mic className="h-4 w-4" />
        ) : marker.key === "turn-segmentation" ? (
          <AlertTriangle className="h-4 w-4" />
        ) : (
          <Activity className="h-4 w-4" />
        )}
        {marker.title}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-sophia-text2">{marker.detail}</p>
    </div>
  )
}

function BaselineRegressionCard({ regression }: { regression: VoiceBaselineRegression }) {
  return (
    <div className={cn(
      "rounded-3xl border px-4 py-4",
      regression.level === "bad"
        ? "border-rose-300/20 bg-rose-300/8"
        : "border-amber-300/20 bg-amber-300/8",
    )}>
      <div className="flex items-center gap-2 text-sm font-semibold text-sophia-text">
        <Gauge className="h-4 w-4" />
        {regression.title}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-sophia-text2">{regression.detail}</p>
    </div>
  )
}

function BaselineComparisonCard({ metrics }: { metrics: VoiceDeveloperMetrics }) {
  return (
    <div className="rounded-3xl border border-white/8 bg-white/4 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-sophia-text">
        <Gauge className="h-4 w-4 text-sophia-text2/80" />
        Rolling baseline
        <span className={tonePillClass(baselineCardTone(metrics))} />
      </div>
      <div className="space-y-2">
        {[
          ["Previous runs", String(metrics.baseline.sampleSize)],
          ["Median session ready", formatMs(metrics.baseline.medians.sessionReadyMs)],
          ["Median join latency", formatMs(metrics.baseline.medians.joinLatencyMs)],
          ["Median request -> first text", formatMs(metrics.baseline.medians.requestStartToFirstTextMs)],
          ["Median bind -> playback", formatMs(metrics.baseline.medians.bindToPlaybackStartMs)],
          ["Median sub RTT", formatMs(metrics.baseline.medians.subscriberRoundTripTimeMs)],
          ["Median sub jitter", formatMs(metrics.baseline.medians.subscriberJitterMs)],
          ["Median sub loss", formatPercentCompact(metrics.baseline.medians.subscriberPacketLossPct)],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-sophia-text2/75">{label}</span>
            <span className="truncate text-right font-medium text-sophia-text">{value}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-sophia-text2/75">{buildBaselineFooter(metrics)}</p>
      {metrics.baseline.regressions.length > 0 && (
        <div className="mt-4 border-t border-white/8 pt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-sophia-text2/70">
            Slower than recent sessions
          </div>
          <div className="space-y-2">
            {metrics.baseline.regressions.map((regression) => (
              <div key={regression.key} className="rounded-2xl border border-white/8 bg-black/15 px-3 py-2 text-xs text-sophia-text2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-sophia-text">{regression.title}</span>
                  <ToneBadge label={formatBaselineRegressionDelta(regression)} tone={regression.level} />
                </div>
                <p className="mt-1 leading-relaxed">{regression.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RecentTurnsCard({ turns }: { turns: VoiceDeveloperMetrics["recentTurns"] }) {
  return (
    <div className="rounded-3xl border border-white/8 bg-white/4 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-sophia-text">
        <Clock3 className="h-4 w-4 text-sophia-text2/80" />
        Recent turn diagnostics
      </div>
      <div className="space-y-2.5">
        {turns.length === 0 && (
          <p className="text-sm text-sophia-text2">No completed diagnostics yet in this voice session.</p>
        )}
        {turns.map((turn, index) => (
          <div key={`${turn.turnId ?? "turn"}-${index}`} className="rounded-2xl border border-white/8 bg-black/15 px-3 py-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-sophia-text">{turn.turnId ?? `turn ${index + 1}`}</span>
              <span className="text-sophia-text2/75">{turn.status ?? "pending"}</span>
            </div>
            <div className="mt-2 grid gap-1 text-xs text-sophia-text2 sm:grid-cols-2">
              <span>reason: {turn.reason ?? "pending"}</span>
              <span>committed turn close: {formatMs(turn.committedTurnCloseMs)}</span>
              <span>committed to agent start: {formatMs(turn.committedTranscriptToAgentStartMs)}</span>
              <span>request to first backend event: {formatMs(turn.requestStartToFirstBackendEventMs)}</span>
              <span>raw first text: {formatMs(turn.firstTextMs)}</span>
              <span>raw backend done: {formatMs(turn.backendCompleteMs)}</span>
              <span>raw first audio: {formatMs(turn.firstAudioMs)}</span>
              <span>extra false ends: {Math.max((turn.falseUserEndedCount ?? 1) - 1, 0)}</span>
              <span>duplicate phases: {turn.duplicatePhaseTotal}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function InfoCard({
  icon: Icon,
  title,
  rows,
  footer,
  tone,
}: {
  icon: typeof Activity
  title: string
  rows: Array<[string, string]>
  footer: string
  tone: "good" | "warn" | "bad" | "neutral"
}) {
  return (
    <div className="rounded-3xl border border-white/8 bg-white/4 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-sophia-text">
        <Icon className="h-4 w-4 text-sophia-text2/80" />
        {title}
        <span className={tonePillClass(tone)} />
      </div>
      <div className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-sophia-text2/75">{label}</span>
            <span className="truncate text-right font-medium text-sophia-text">{value}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-sophia-text2/75">{footer}</p>
    </div>
  )
}

function ToneBadge({ label, tone }: { label: string; tone: "good" | "warn" | "bad" | "neutral" }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${toneBadgeClass(tone)}`}>
      <span className={timelineToneClass(tone)} />
      {label}
    </span>
  )
}

function buildTurnFlowFooter(metrics: VoiceDeveloperMetrics): string {
  if (metrics.stage === "thinking" && metrics.timings.currentThinkingMs !== null) {
    return `Sophia is currently waiting ${formatMs(metrics.timings.currentThinkingMs)} after the latest user-end event.`
  }

  if (metrics.lastTurn.responseDurationMs !== null) {
    return `The latest spoken response lasted ${formatMs(metrics.lastTurn.responseDurationMs)} from agent start to agent end.`
  }

  return "Turn metrics will fill in once the backend emits user-end, agent start, and diagnostic events."
}

function buildStartupFooter(metrics: VoiceDeveloperMetrics): string {
  if (metrics.events.startupTimeouts > 0) {
    return "Sophia hit a startup-ready timeout in this session. Investigate preconnect reuse, call join, and ready signaling before focusing on model latency."
  }

  if (metrics.transport.playback.timeoutCount > 0 || metrics.transport.playback.errorCount > 0) {
    return metrics.transport.playback.lastError
      ? `Remote audio bound, but browser playback failed: ${metrics.transport.playback.lastError}`
      : "Remote audio bound, but browser playback never started cleanly."
  }

  if (metrics.startup.bindToPlaybackStartMs !== null && metrics.startup.bindToPlaybackStartMs >= 1500) {
    return `Join and ready completed, but browser playback still needed ${formatMs(metrics.startup.bindToPlaybackStartMs)} after bind before audio actually started.`
  }

  if (metrics.startup.backendWarmupStatus === "failed") {
    return metrics.startup.backendWarmupError
      ? `Backend warmup failed: ${metrics.startup.backendWarmupError}`
      : "Backend warmup failed before the session became ready."
  }

  if (metrics.startup.preconnectError) {
    return `Preconnect fell back to a fresh connect: ${metrics.startup.preconnectError}`
  }

  if (metrics.startup.credentialsSource === "prefetched") {
    return "This start reused prefetched credentials, so the remaining latency is mostly join, ready, and first-turn behavior."
  }

  return "This isolates the cold-start path before Sophia can even begin to answer your turn."
}

function buildTransportFooter(metrics: VoiceDeveloperMetrics): string {
  const subscriberRoundTripTimeMs = metrics.transport.webrtc.subscriber.averageRoundTripTimeMs
    ?? metrics.transport.webrtc.subscriber.lastRoundTripTimeMs
  const subscriberJitterMs = metrics.transport.webrtc.subscriber.averageJitterMs
    ?? metrics.transport.webrtc.subscriber.lastJitterMs
  const subscriberPacketLossPct = metrics.transport.webrtc.subscriber.averagePacketLossPct
    ?? metrics.transport.webrtc.subscriber.lastPacketLossPct

  if (metrics.transport.reconnect.activeDowntimeMs !== null) {
    return `Reconnect is still in progress after ${formatMs(metrics.transport.reconnect.activeDowntimeMs)}.`
  }

  if (metrics.transport.reconnect.failed > 0) {
    return metrics.transport.reconnect.lastDowntimeMs !== null
      ? `At least one reconnect failed after ${formatMs(metrics.transport.reconnect.lastDowntimeMs)} of downtime.`
      : "At least one reconnect failed before the session recovered."
  }

  if ((metrics.transport.reconnect.totalDowntimeMs ?? 0) > 0) {
    return `Recovered reconnects added ${formatMs(metrics.transport.reconnect.totalDowntimeMs)} of total transport downtime.`
  }

  if (metrics.transport.playback.timeoutCount > 0 || metrics.transport.playback.errorCount > 0) {
    return metrics.transport.playback.lastError
      ? `Browser playback failed after bind: ${metrics.transport.playback.lastError}`
      : "Remote audio bound, but browser playback timed out or errored before sound started."
  }

  if (metrics.transport.playback.bindToPlayingMs !== null && metrics.transport.playback.bindToPlayingMs >= 1500) {
    return `Remote audio took ${formatMs(metrics.transport.playback.bindToPlayingMs)} to start after bind. Transport is alive, but the media element took time to become audible.`
  }

  if (metrics.transport.network.online === false) {
    return "The browser currently reports the client as offline, so transport timing is not trustworthy until connectivity returns."
  }

  if (
    metrics.transport.webrtc.sampleCount > 0
    && (
      (subscriberRoundTripTimeMs !== null && subscriberRoundTripTimeMs >= 400)
      || (subscriberJitterMs !== null && subscriberJitterMs >= 80)
      || (subscriberPacketLossPct !== null && subscriberPacketLossPct >= 5)
    )
  ) {
    return `Stream stats show unstable subscriber transport: RTT ${formatMs(subscriberRoundTripTimeMs)}, jitter ${formatMs(subscriberJitterMs)}, packet loss ${formatPercentCompact(subscriberPacketLossPct)}.`
  }

  if (metrics.transport.streamOpen) {
    const connection = formatNetworkConnection(metrics.transport.network)
    return connection === "pending"
      ? "Browser SSE bridge is open for voice events."
      : `Browser SSE bridge is open for voice events. Client network: ${connection}.`
  }

  if (metrics.transport.activeSource === "custom") {
    return "Fallback transport is Stream custom events."
  }

  return "Waiting for event transport to come online."
}

function buildBaselineFooter(metrics: VoiceDeveloperMetrics): string {
  if (metrics.baseline.sampleSize === 0) {
    return "No previous completed runs are stored locally yet. This panel will start flagging regressions after a few voice sessions." 
  }

  if (metrics.baseline.regressions.length === 0) {
    return `Compared against ${metrics.baseline.sampleSize} recent runs, the current session is within the local baseline envelope.`
  }

  return `Compared against ${metrics.baseline.sampleSize} recent runs, this session is slower on ${metrics.baseline.regressions.length} baseline metric${metrics.baseline.regressions.length === 1 ? "" : "s"}.`
}

function formatDuplicatePhaseFooter(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) {
    return "No duplicate turn phases were recorded in the latest diagnostic."
  }

  return entries.map(([key, value]) => `${key}: ${value}`).join(" | ")
}

function formatMs(value: number | null): string {
  if (value === null) return "--"
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(2)} s`
}

function formatIsoAge(value: string | null): string {
  if (!value) return "--"

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value

  const ageMs = Date.now() - timestamp
  return ageMs < 1000 ? `${Math.max(ageMs, 0)}ms ago` : `${(Math.max(ageMs, 0) / 1000).toFixed(2)}s ago`
}

function formatMsCompact(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(2)}s`
}

function formatDecimal(value: number | null): string {
  return value === null ? "--" : value.toFixed(3)
}

function formatPercent(value: number | null): string {
  return value === null ? "--" : `${value}%`
}

function formatPercentCompact(value: number | null): string {
  return value === null ? "--" : `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function formatBaselineRegressionDelta(regression: VoiceBaselineRegression): string {
  return `${regression.deltaPercent >= 0 ? "+" : ""}${Math.round(regression.deltaPercent)}%`
}

function formatCredentialsSource(source: VoiceDeveloperMetrics["startup"]["credentialsSource"]): string {
  switch (source) {
    case "prefetched":
      return "prefetched"
    case "fresh":
      return "fresh"
    default:
      return "pending"
  }
}

function formatWarmupStatus(status: VoiceDeveloperMetrics["startup"]["backendWarmupStatus"]): string {
  switch (status) {
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "pending":
      return "pending"
    default:
      return "idle"
  }
}

function formatPlaybackState(state: VoiceDeveloperMetrics["transport"]["playback"]["currentState"]): string {
  switch (state) {
    case "canplay":
      return "can play"
    case "timed_out":
      return "timed out"
    default:
      return state
  }
}

function formatNetworkConnection(network: VoiceDeveloperMetrics["transport"]["network"]): string {
  const onlineLabel = network.online === null ? null : network.online ? "online" : "offline"
  const effectiveType = network.effectiveType ? network.effectiveType.toLowerCase() : null

  if (onlineLabel && effectiveType) {
    return `${onlineLabel} / ${effectiveType}`
  }

  return onlineLabel ?? effectiveType ?? "pending"
}

function formatDownlink(value: number | null): string {
  return value === null ? "--" : `${value.toFixed(1)} Mbps`
}

function formatBooleanValue(value: boolean | null): string {
  return value === null ? "--" : value ? "yes" : "no"
}

function startupCardTone(metrics: VoiceDeveloperMetrics): "good" | "warn" | "bad" | "neutral" {
  if (metrics.events.startupTimeouts > 0) {
    return "bad"
  }

  if (metrics.transport.playback.timeoutCount > 0 || metrics.transport.playback.errorCount > 0) {
    return "bad"
  }

  if (metrics.startup.bindToPlaybackStartMs !== null && metrics.startup.bindToPlaybackStartMs >= 1500) {
    return metrics.startup.bindToPlaybackStartMs >= 3000 ? "bad" : "warn"
  }

  if (metrics.startup.backendWarmupStatus === "failed" || metrics.startup.preconnectError) {
    return "warn"
  }

  return metrics.bottleneck.kind === "startup" ? metrics.bottleneck.level : metrics.thresholds.sessionReady.status
}

function transportCardTone(metrics: VoiceDeveloperMetrics): "good" | "warn" | "bad" | "neutral" {
  const subscriberRoundTripTimeMs = metrics.transport.webrtc.subscriber.averageRoundTripTimeMs
    ?? metrics.transport.webrtc.subscriber.lastRoundTripTimeMs
  const subscriberJitterMs = metrics.transport.webrtc.subscriber.averageJitterMs
    ?? metrics.transport.webrtc.subscriber.lastJitterMs
  const subscriberPacketLossPct = metrics.transport.webrtc.subscriber.averagePacketLossPct
    ?? metrics.transport.webrtc.subscriber.lastPacketLossPct

  if (
    metrics.transport.reconnect.failed > 0
    || metrics.transport.reconnect.activeDowntimeMs !== null
    || metrics.transport.playback.timeoutCount > 0
    || metrics.transport.playback.errorCount > 0
    || (subscriberRoundTripTimeMs !== null && subscriberRoundTripTimeMs >= 600)
    || (subscriberJitterMs !== null && subscriberJitterMs >= 120)
    || (subscriberPacketLossPct !== null && subscriberPacketLossPct >= 8)
  ) {
    return "bad"
  }

  if (
    metrics.bottleneck.kind === "transport"
    || metrics.transport.activeSource === "custom"
    || ((metrics.transport.reconnect.totalDowntimeMs ?? 0) >= 3000 && metrics.transport.reconnect.count > 0)
    || (metrics.transport.playback.bindToPlayingMs !== null && metrics.transport.playback.bindToPlayingMs >= 1500)
    || (subscriberRoundTripTimeMs !== null && subscriberRoundTripTimeMs >= 400)
    || (subscriberJitterMs !== null && subscriberJitterMs >= 80)
    || (subscriberPacketLossPct !== null && subscriberPacketLossPct >= 5)
  ) {
    return metrics.bottleneck.kind === "transport" ? metrics.bottleneck.level : "warn"
  }

  return "neutral"
}

function baselineCardTone(metrics: VoiceDeveloperMetrics): "good" | "warn" | "bad" | "neutral" {
  if (metrics.baseline.regressions.some((regression) => regression.level === "bad")) {
    return "bad"
  }

  if (metrics.baseline.regressions.some((regression) => regression.level === "warn")) {
    return "warn"
  }

  if (metrics.baseline.sampleSize > 0) {
    return "good"
  }

  return "neutral"
}

function thresholdKeyForLabel(label: string): keyof VoiceDeveloperMetrics["thresholds"] {
  switch (label) {
    case "Session ready":
      return "sessionReady"
    case "Join latency":
      return "joinLatency"
    case "Committed response":
      return "committedResponse"
    case "Raw first text":
      return "firstText"
    case "Raw first audio":
      return "firstAudio"
    case "Raw backend done":
      return "backendComplete"
    default:
      return "responseWindow"
  }
}

function withThresholdHint(
  hint: string,
  threshold: VoiceDeveloperMetrics["thresholds"][keyof VoiceDeveloperMetrics["thresholds"]],
): string {
  return `${hint} | warn ${formatMsCompact(threshold.warnAtMs)} | bad ${formatMsCompact(threshold.badAtMs)}`
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}

function toneBadgeClass(tone: "good" | "warn" | "bad" | "neutral"): string {
  switch (tone) {
    case "good":
      return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
    case "warn":
      return "border-amber-300/20 bg-amber-300/10 text-amber-100"
    case "bad":
      return "border-rose-300/20 bg-rose-300/10 text-rose-100"
    default:
      return "border-white/10 bg-white/6 text-sophia-text2"
  }
}

function metricCardToneClass(
  tone: "good" | "warn" | "bad" | "neutral",
  emphasize: boolean,
): string {
  if (tone === "bad") {
    return "border-rose-300/20 bg-rose-300/8"
  }

  if (tone === "warn" || emphasize) {
    return "border-amber-300/20 bg-amber-400/8"
  }

  if (tone === "good") {
    return "border-emerald-300/15 bg-emerald-300/6"
  }

  return "border-white/8 bg-white/4"
}

function panelToneClass(tone: "good" | "warn" | "bad" | "neutral"): string {
  switch (tone) {
    case "good":
      return "border-emerald-300/20 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_35%),linear-gradient(135deg,rgba(17,24,24,0.98),rgba(10,15,20,0.92))]"
    case "warn":
      return "border-amber-300/20 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.18),transparent_35%),linear-gradient(135deg,rgba(26,21,17,0.98),rgba(16,13,10,0.92))]"
    case "bad":
      return "border-rose-300/20 bg-[radial-gradient(circle_at_top_left,rgba(251,113,133,0.18),transparent_35%),linear-gradient(135deg,rgba(28,18,20,0.98),rgba(18,12,14,0.92))]"
    default:
      return "border-sophia-surface-border/70 bg-[radial-gradient(circle_at_top_left,rgba(151,118,255,0.14),transparent_35%),linear-gradient(135deg,rgba(21,24,34,0.98),rgba(13,15,24,0.92))]"
  }
}

function tonePillClass(tone: "good" | "warn" | "bad" | "neutral"): string {
  switch (tone) {
    case "good":
      return "ml-auto h-2.5 w-2.5 rounded-full bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,0.7)]"
    case "warn":
      return "ml-auto h-2.5 w-2.5 rounded-full bg-amber-300 shadow-[0_0_16px_rgba(252,211,77,0.7)]"
    case "bad":
      return "ml-auto h-2.5 w-2.5 rounded-full bg-rose-300 shadow-[0_0_16px_rgba(253,164,175,0.7)]"
    default:
      return "ml-auto h-2.5 w-2.5 rounded-full bg-sophia-text2/40"
  }
}

function timelineToneClass(tone: "good" | "warn" | "bad" | "neutral"): string {
  switch (tone) {
    case "good":
      return "h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.8)]"
    case "warn":
      return "h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.8)]"
    case "bad":
      return "h-2 w-2 rounded-full bg-rose-300 shadow-[0_0_10px_rgba(253,164,175,0.8)]"
    default:
      return "h-2 w-2 rounded-full bg-sophia-text2/50"
  }
}