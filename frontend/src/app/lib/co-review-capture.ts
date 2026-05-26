'use client';

export type CoReviewState = 'inactive' | 'starting' | 'live' | 'stopping' | 'error';

export type CoReviewCaptureMethod =
  | 'canvas_capture_stream'
  | 'nested_canvas_capture_stream'
  | 'periodic_still_frame'
  | 'unsupported';

export type CoReviewCaptureTelemetry = {
  coReviewEnabled: boolean;
  coReviewState: CoReviewState;
  artifactId: string;
  sessionId: string;
  shareStartedAt: string | null;
  shareDurationMs: number | null;
  captureMethod: CoReviewCaptureMethod;
  frameRate: number | null;
  resolution: { width: number; height: number } | null;
  videoTrackAttached: boolean;
  videoTrackAttachError: string | null;
  voiceLatencyBefore: number | null;
  voiceLatencyAfter: number | null;
  droppedFrameEstimate: number | null;
  modeExitReason: string | null;
};

export type CoReviewCaptureSuccess = {
  ok: true;
  method: Exclude<CoReviewCaptureMethod, 'unsupported'>;
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  resolution: { width: number; height: number } | null;
  frameRate: number | null;
  startedAt: number;
};

export type CoReviewCaptureUnsupported = {
  ok: false;
  method: 'unsupported';
  status: 'unsupported';
  safeReason: string;
};

export type CoReviewCaptureResult = CoReviewCaptureSuccess | CoReviewCaptureUnsupported;

type CaptureStreamCanvas = HTMLCanvasElement & {
  captureStream?: (frameRate?: number) => MediaStream;
};

export function createCoReviewTelemetry(
  input: Partial<CoReviewCaptureTelemetry> & {
    coReviewEnabled: boolean;
    coReviewState: CoReviewState;
    artifactId: string;
    sessionId: string;
  },
): CoReviewCaptureTelemetry {
  return {
    coReviewEnabled: input.coReviewEnabled,
    coReviewState: input.coReviewState,
    artifactId: input.artifactId,
    sessionId: input.sessionId,
    shareStartedAt: input.shareStartedAt ?? null,
    shareDurationMs: input.shareDurationMs ?? null,
    captureMethod: input.captureMethod ?? 'unsupported',
    frameRate: input.frameRate ?? null,
    resolution: input.resolution ?? null,
    videoTrackAttached: input.videoTrackAttached ?? false,
    videoTrackAttachError: input.videoTrackAttachError ?? null,
    voiceLatencyBefore: input.voiceLatencyBefore ?? null,
    voiceLatencyAfter: input.voiceLatencyAfter ?? null,
    droppedFrameEstimate: input.droppedFrameEstimate ?? null,
    modeExitReason: input.modeExitReason ?? null,
  };
}

export function sanitizeCoReviewTelemetry(
  telemetry: CoReviewCaptureTelemetry,
): CoReviewCaptureTelemetry {
  return {
    ...telemetry,
    artifactId: telemetry.artifactId.slice(0, 160),
  };
}

export async function captureArtifactRegion(
  element: HTMLElement | null,
  options: { frameRate?: number } = {},
): Promise<CoReviewCaptureResult> {
  if (!element) {
    return unsupported('artifact_region_missing');
  }

  const frameRate = options.frameRate ?? 5;
  const directCanvas = asCaptureStreamCanvas(element);
  if (directCanvas) {
    return captureCanvas(directCanvas, 'canvas_capture_stream', frameRate);
  }

  const nestedCanvas = element.querySelector('canvas');
  const captureCanvasElement = nestedCanvas ? asCaptureStreamCanvas(nestedCanvas) : null;
  if (captureCanvasElement) {
    return captureCanvas(captureCanvasElement, 'nested_canvas_capture_stream', frameRate);
  }

  return unsupported('dom_region_capture_requires_clean_canvas_rerender');
}

export function stopCoReviewStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function captureCanvas(
  canvas: CaptureStreamCanvas,
  method: Exclude<CoReviewCaptureMethod, 'periodic_still_frame' | 'unsupported'>,
  frameRate: number,
): CoReviewCaptureResult {
  if (typeof canvas.captureStream !== 'function') {
    return unsupported('canvas_capture_stream_unavailable');
  }
  const stream = canvas.captureStream(frameRate);
  const [videoTrack] = stream.getVideoTracks();
  if (!videoTrack) {
    stopCoReviewStream(stream);
    return unsupported('canvas_capture_stream_returned_no_video_track');
  }
  return {
    ok: true,
    method,
    stream,
    videoTrack,
    frameRate,
    resolution: canvas.width && canvas.height ? { width: canvas.width, height: canvas.height } : null,
    startedAt: Date.now(),
  };
}

function asCaptureStreamCanvas(element: Element): CaptureStreamCanvas | null {
  if (element instanceof HTMLCanvasElement) {
    return element as CaptureStreamCanvas;
  }
  return null;
}

function unsupported(safeReason: string): CoReviewCaptureUnsupported {
  return {
    ok: false,
    method: 'unsupported',
    status: 'unsupported',
    safeReason,
  };
}
