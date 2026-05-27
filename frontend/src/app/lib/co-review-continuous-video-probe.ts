import { isCoReviewVideoProbeEnabled } from "./co-review-flags"
import { stopArtifactVisualSource, type ArtifactVisualSource } from "./co-review-capture"
import { encodeArtifactStillFrame, type ArtifactFrameDimensions } from "./co-review-frame"
import type { ArtifactFrameSender } from "./co-review-still-frame-transport"

export const COREVIEW_REPEATED_FRAME_PROBE_LABEL = "repeated-frame probe"
export const DEFAULT_COREVIEW_REPEATED_FRAME_PROBE_MAX_FRAMES = 5
export const DEFAULT_COREVIEW_REPEATED_FRAME_PROBE_INTERVAL_MS = 1000

export type CoreviewContinuousVideoUnsupportedReason =
  | "canvas_unavailable"
  | "canvas_capture_stream_unavailable"
  | "canvas_capture_stream_failed"
  | "canvas_capture_stream_no_video_track"
  | "video_track_transport_unavailable"
  | "video_track_attach_failed"

export interface CoreviewCanvasCaptureStreamProbeResult {
  ok: boolean
  captureStreamSupported: boolean
  streamCreated: boolean
  videoTrackAvailable: boolean
  trackKind: string | null
  trackReadyState: MediaStreamTrackState | null
  unsupportedReason: CoreviewContinuousVideoUnsupportedReason | null
  error: string | null
}

export interface CoreviewContinuousVideoTransportProbeResult extends CoreviewCanvasCaptureStreamProbeResult {
  transportKind: string
  transportAttachSupported: boolean
  transportAttachAttempted: boolean
  transportAttachSucceeded: boolean
}

export interface ProbeCoreviewContinuousVideoCapabilityOptions {
  canvas: HTMLCanvasElement | null
  transport: {
    kind?: string
    attachVideoTrack?: (track: MediaStreamTrack) => Promise<void> | void
  }
  frameRate?: number
  attemptAttach?: boolean
}

interface CanvasCaptureResult {
  ok: boolean
  stream: MediaStream | null
  track: MediaStreamTrack | null
  result: CoreviewCanvasCaptureStreamProbeResult
}

export function probeCanvasCaptureStream(
  canvas: HTMLCanvasElement | null,
  frameRate = 1,
): CoreviewCanvasCaptureStreamProbeResult {
  const capture = captureCanvasVideoTrack(canvas, frameRate)
  stopMediaStream(capture.stream)
  return capture.result
}

export async function probeCoreviewContinuousVideoCapability({
  canvas,
  transport,
  frameRate = 1,
  attemptAttach = true,
}: ProbeCoreviewContinuousVideoCapabilityOptions): Promise<CoreviewContinuousVideoTransportProbeResult> {
  const capture = captureCanvasVideoTrack(canvas, frameRate)
  const base = {
    ...capture.result,
    transportKind: transport.kind ?? "unknown",
    transportAttachSupported: typeof transport.attachVideoTrack === "function",
    transportAttachAttempted: false,
    transportAttachSucceeded: false,
  }

  try {
    if (!capture.ok || !capture.track) {
      return base
    }

    if (typeof transport.attachVideoTrack !== "function") {
      return {
        ...base,
        ok: false,
        unsupportedReason: "video_track_transport_unavailable",
      }
    }

    if (!attemptAttach) {
      return base
    }

    try {
      await transport.attachVideoTrack(capture.track)
    } catch (error) {
      return {
        ...base,
        ok: false,
        transportAttachAttempted: true,
        unsupportedReason: "video_track_attach_failed",
        error: sanitizeError(error),
      }
    }

    return {
      ...base,
      ok: true,
      transportAttachAttempted: true,
      transportAttachSucceeded: true,
      unsupportedReason: null,
      error: null,
    }
  } finally {
    stopMediaStream(capture.stream)
  }
}

export type CoreviewRepeatedFrameProbeStopReason =
  | "disabled"
  | "completed"
  | "cancelled"
  | "encode_error"
  | "send_error"
  | "websocket_not_open"
  | "websocket_closed"

export interface CoreviewRepeatedFrameProbeFrameTelemetry {
  index: number
  ok: boolean
  frameBytes: number | null
  frameDimensions: ArtifactFrameDimensions | null
  frameSendLatencyMs: number | null
  websocketClosedAfterFrameSend: boolean
  imageCountAfterFrame: number | null
  videoDurationSecondsAfterFrame: number | null
  audioDurationSecondsAfterFrame: number | null
  error: string | null
  rawFrameExcluded: true
}

export interface CoreviewRepeatedFrameProbeResult {
  label: typeof COREVIEW_REPEATED_FRAME_PROBE_LABEL
  enabled: boolean
  ok: boolean
  startedAt: string
  completedAt: string
  requestedFrames: number
  maxFrames: number
  intervalMs: number
  framesAttempted: number
  framesSent: number
  stoppedReason: CoreviewRepeatedFrameProbeStopReason
  firstError: string | null
  websocketClosed: boolean
  maxFrameSendLatencyMs: number | null
  providerUsageImageCount: number | null
  providerUsageVideoDurationSeconds: number | null
  providerUsageAudioDurationSeconds: number | null
  frameResults: CoreviewRepeatedFrameProbeFrameTelemetry[]
  rawFrameExcluded: true
}

export interface RunCoreviewRepeatedFrameProbeOptions {
  visualSource: ArtifactVisualSource
  sender: ArtifactFrameSender
  enabled?: boolean
  maxFrames?: number
  intervalMs?: number
  initialDelayMs?: number
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => string
}

export async function runCoreviewRepeatedFrameProbe({
  visualSource,
  sender,
  enabled = isCoReviewVideoProbeEnabled(),
  maxFrames = DEFAULT_COREVIEW_REPEATED_FRAME_PROBE_MAX_FRAMES,
  intervalMs = DEFAULT_COREVIEW_REPEATED_FRAME_PROBE_INTERVAL_MS,
  initialDelayMs = intervalMs,
  signal,
  sleep = sleepWithAbort,
  now = () => new Date().toISOString(),
}: RunCoreviewRepeatedFrameProbeOptions): Promise<CoreviewRepeatedFrameProbeResult> {
  const requestedFrames = Number.isFinite(maxFrames) ? Math.max(0, Math.floor(maxFrames)) : 0
  const cappedFrames = Math.min(requestedFrames, DEFAULT_COREVIEW_REPEATED_FRAME_PROBE_MAX_FRAMES)
  const safeIntervalMs = Number.isFinite(intervalMs) ? Math.max(1000, Math.round(intervalMs)) : DEFAULT_COREVIEW_REPEATED_FRAME_PROBE_INTERVAL_MS
  const safeInitialDelayMs = Number.isFinite(initialDelayMs) ? Math.max(0, Math.round(initialDelayMs)) : safeIntervalMs
  const startedAt = now()

  if (!enabled) {
    return buildRepeatedFrameProbeResult({
      enabled: false,
      startedAt,
      completedAt: now(),
      requestedFrames,
      maxFrames: cappedFrames,
      intervalMs: safeIntervalMs,
      stoppedReason: "disabled",
      frameResults: [],
    })
  }

  const frameResults: CoreviewRepeatedFrameProbeFrameTelemetry[] = []
  let stoppedReason: CoreviewRepeatedFrameProbeStopReason = "completed"

  if (safeInitialDelayMs > 0) {
    await sleep(safeInitialDelayMs, signal)
  }

  for (let index = 0; index < cappedFrames; index += 1) {
    if (signal?.aborted) {
      stoppedReason = "cancelled"
      break
    }

    const status = sender.getStatus?.()
    if (status && !status.websocketOpen) {
      stoppedReason = "websocket_not_open"
      break
    }

    const encoded = await encodeArtifactStillFrame(visualSource)
    if (encoded.ok === false) {
      stoppedReason = "encode_error"
      frameResults.push({
        index,
        ok: false,
        frameBytes: null,
        frameDimensions: null,
        frameSendLatencyMs: encoded.encodeLatencyMs,
        websocketClosedAfterFrameSend: false,
        imageCountAfterFrame: null,
        videoDurationSecondsAfterFrame: null,
        audioDurationSecondsAfterFrame: null,
        error: encoded.reason,
        rawFrameExcluded: true,
      })
      break
    }

    const sent = await sender.sendArtifactFrame(encoded.payload, { coreviewSendStage: "repeated_probe" })
    frameResults.push({
      index,
      ok: sent.ok,
      frameBytes: sent.frameBytes,
      frameDimensions: sent.frameDimensions,
      frameSendLatencyMs: sent.frameSendLatencyMs,
      websocketClosedAfterFrameSend: sent.websocketClosedAfterFrameSend ?? false,
      imageCountAfterFrame: sent.imageCountAfterFrame ?? null,
      videoDurationSecondsAfterFrame: readUsageDurationSeconds(sent.usageMetadataAfterFrame ?? null, "video"),
      audioDurationSecondsAfterFrame: readUsageDurationSeconds(sent.usageMetadataAfterFrame ?? null, "audio"),
      error: sent.error,
      rawFrameExcluded: true,
    })

    if (!sent.ok) {
      stoppedReason = sent.websocketClosedAfterFrameSend ? "websocket_closed" : "send_error"
      break
    }
    if (sent.websocketClosedAfterFrameSend) {
      stoppedReason = "websocket_closed"
      break
    }

    if (index < cappedFrames - 1) {
      await sleep(safeIntervalMs, signal)
    }
  }

  if (signal?.aborted && stoppedReason === "completed" && frameResults.length < cappedFrames) {
    stoppedReason = "cancelled"
  }

  stopArtifactVisualSource(visualSource)
  return buildRepeatedFrameProbeResult({
    enabled: true,
    startedAt,
    completedAt: now(),
    requestedFrames,
    maxFrames: cappedFrames,
    intervalMs: safeIntervalMs,
    stoppedReason,
    frameResults,
  })
}

function captureCanvasVideoTrack(canvas: HTMLCanvasElement | null, frameRate: number): CanvasCaptureResult {
  if (!canvas) {
    return captureFailure("canvas_unavailable", {
      captureStreamSupported: false,
      streamCreated: false,
    })
  }

  const captureStream = canvas.captureStream
  if (typeof captureStream !== "function") {
    return captureFailure("canvas_capture_stream_unavailable", {
      captureStreamSupported: false,
      streamCreated: false,
    })
  }

  let stream: MediaStream
  try {
    stream = captureStream.call(canvas, frameRate)
  } catch (error) {
    return captureFailure("canvas_capture_stream_failed", {
      captureStreamSupported: true,
      streamCreated: false,
      error: sanitizeError(error),
    })
  }

  const [track] = stream.getVideoTracks()
  if (!track) {
    stopMediaStream(stream)
    return captureFailure("canvas_capture_stream_no_video_track", {
      captureStreamSupported: true,
      streamCreated: true,
    })
  }

  return {
    ok: true,
    stream,
    track,
    result: {
      ok: true,
      captureStreamSupported: true,
      streamCreated: true,
      videoTrackAvailable: true,
      trackKind: track.kind || null,
      trackReadyState: track.readyState ?? null,
      unsupportedReason: null,
      error: null,
    },
  }
}

function captureFailure(
  unsupportedReason: CoreviewContinuousVideoUnsupportedReason,
  overrides: Partial<CoreviewCanvasCaptureStreamProbeResult> = {},
): CanvasCaptureResult {
  return {
    ok: false,
    stream: null,
    track: null,
    result: {
      ok: false,
      captureStreamSupported: overrides.captureStreamSupported ?? false,
      streamCreated: overrides.streamCreated ?? false,
      videoTrackAvailable: false,
      trackKind: null,
      trackReadyState: null,
      unsupportedReason,
      error: overrides.error ?? null,
    },
  }
}

function buildRepeatedFrameProbeResult({
  enabled,
  startedAt,
  completedAt,
  requestedFrames,
  maxFrames,
  intervalMs,
  stoppedReason,
  frameResults,
}: {
  enabled: boolean
  startedAt: string
  completedAt: string
  requestedFrames: number
  maxFrames: number
  intervalMs: number
  stoppedReason: CoreviewRepeatedFrameProbeStopReason
  frameResults: CoreviewRepeatedFrameProbeFrameTelemetry[]
}): CoreviewRepeatedFrameProbeResult {
  const successfulFrames = frameResults.filter((frame) => frame.ok)
  const firstError = frameResults.find((frame) => frame.error)?.error ?? null
  return {
    label: COREVIEW_REPEATED_FRAME_PROBE_LABEL,
    enabled,
    ok: enabled && (stoppedReason === "completed" || stoppedReason === "cancelled"),
    startedAt,
    completedAt,
    requestedFrames,
    maxFrames,
    intervalMs,
    framesAttempted: frameResults.length,
    framesSent: successfulFrames.length,
    stoppedReason,
    firstError,
    websocketClosed: frameResults.some((frame) => frame.websocketClosedAfterFrameSend),
    maxFrameSendLatencyMs: maxNullable(frameResults.map((frame) => frame.frameSendLatencyMs)),
    providerUsageImageCount: lastNumber(frameResults.map((frame) => frame.imageCountAfterFrame)),
    providerUsageVideoDurationSeconds: lastNumber(frameResults.map((frame) => frame.videoDurationSecondsAfterFrame)),
    providerUsageAudioDurationSeconds: lastNumber(frameResults.map((frame) => frame.audioDurationSecondsAfterFrame)),
    frameResults,
    rawFrameExcluded: true,
  }
}

function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop())
}

function readUsageDurationSeconds(
  metadata: { videoDurationSeconds?: number | null; video_duration_seconds?: number | null; audioDurationSeconds?: number | null; audio_duration_seconds?: number | null } | null,
  kind: "audio" | "video",
): number | null {
  if (!metadata) return null
  const camelValue = kind === "audio" ? metadata.audioDurationSeconds : metadata.videoDurationSeconds
  if (typeof camelValue === "number" && Number.isFinite(camelValue)) return camelValue
  const snakeValue = kind === "audio" ? metadata.audio_duration_seconds : metadata.video_duration_seconds
  return typeof snakeValue === "number" && Number.isFinite(snakeValue) ? snakeValue : null
}

function maxNullable(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return finite.length > 0 ? Math.max(...finite) : null
}

function lastNumber(values: Array<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }
  return null
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error || "unknown_error")
}
