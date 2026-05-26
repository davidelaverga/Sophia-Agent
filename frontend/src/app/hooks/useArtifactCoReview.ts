'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  captureArtifactRegion,
  createCoReviewTelemetry,
  sanitizeCoReviewTelemetry,
  stopCoReviewStream,
  type CoReviewCaptureMethod,
  type CoReviewCaptureTelemetry,
  type CoReviewState,
} from '../lib/co-review-capture';

type CoReviewVideoTrackAttachResult = {
  attached: boolean;
  error?: string | null;
};

type UseArtifactCoReviewOptions = {
  enabled: boolean;
  artifactId: string;
  sessionId: string;
  captureTargetRef: RefObject<HTMLElement | null>;
  frameRate?: number;
  attachVideoTrack?: (track: MediaStreamTrack, telemetry: CoReviewCaptureTelemetry) => Promise<CoReviewVideoTrackAttachResult>;
  onTelemetry?: (telemetry: CoReviewCaptureTelemetry) => void;
};

export type UseArtifactCoReviewResult = {
  state: CoReviewState;
  error: string | null;
  captureMethod: CoReviewCaptureMethod | null;
  videoTrackAttached: boolean;
  startCoReview: () => Promise<void>;
  stopCoReview: (reason?: string) => void;
};

export function useArtifactCoReview({
  enabled,
  artifactId,
  sessionId,
  captureTargetRef,
  frameRate = 5,
  attachVideoTrack = audioOnlyGeminiAttachStub,
  onTelemetry,
}: UseArtifactCoReviewOptions): UseArtifactCoReviewResult {
  const [state, setState] = useState<CoReviewState>('inactive');
  const [error, setError] = useState<string | null>(null);
  const [captureMethod, setCaptureMethod] = useState<CoReviewCaptureMethod | null>(null);
  const [videoTrackAttached, setVideoTrackAttached] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const emitTelemetry = useCallback(
    (telemetry: Partial<CoReviewCaptureTelemetry> & { coReviewState: CoReviewState }) => {
      onTelemetry?.(
        sanitizeCoReviewTelemetry(
          createCoReviewTelemetry({
            coReviewEnabled: enabled,
            artifactId,
            sessionId,
            shareStartedAt: startedAtRef.current ? new Date(startedAtRef.current).toISOString() : null,
            ...telemetry,
          }),
        ),
      );
    },
    [artifactId, enabled, onTelemetry, sessionId],
  );

  const stopCoReview = useCallback(
    (reason = 'user_exit') => {
      if (state === 'inactive') return;
      setState('stopping');
      const shareDurationMs = startedAtRef.current ? Date.now() - startedAtRef.current : null;
      stopCoReviewStream(streamRef.current);
      streamRef.current = null;
      startedAtRef.current = null;
      setVideoTrackAttached(false);
      setCaptureMethod(null);
      setError(null);
      emitTelemetry({
        coReviewState: 'inactive',
        captureMethod: captureMethod ?? 'unsupported',
        shareDurationMs,
        modeExitReason: reason,
        videoTrackAttached: false,
      });
      setState('inactive');
    },
    [captureMethod, emitTelemetry, state],
  );

  const startCoReview = useCallback(async () => {
    if (!enabled) {
      setError('co_review_feature_flag_off');
      emitTelemetry({ coReviewState: 'inactive', captureMethod: 'unsupported', videoTrackAttachError: 'feature_flag_off' });
      return;
    }
    if (state === 'starting' || state === 'live') return;

    setState('starting');
    setError(null);
    setVideoTrackAttached(false);
    emitTelemetry({ coReviewState: 'starting', captureMethod: 'unsupported' });

    const capture = await captureArtifactRegion(captureTargetRef.current, { frameRate });
    setCaptureMethod(capture.method);

    if (capture.ok === false) {
      setError(capture.safeReason);
      emitTelemetry({
        coReviewState: 'error',
        captureMethod: 'unsupported',
        videoTrackAttachError: capture.safeReason,
      });
      setState('error');
      return;
    }

    streamRef.current = capture.stream;
    startedAtRef.current = capture.startedAt;
    const baseTelemetry = createCoReviewTelemetry({
      coReviewEnabled: enabled,
      coReviewState: 'live',
      artifactId,
      sessionId,
      shareStartedAt: new Date(capture.startedAt).toISOString(),
      captureMethod: capture.method,
      frameRate: capture.frameRate,
      resolution: capture.resolution,
    });
    const attachResult = await attachVideoTrack(capture.videoTrack, baseTelemetry);
    setVideoTrackAttached(attachResult.attached);
    if (!attachResult.attached) {
      stopCoReviewStream(capture.stream);
      streamRef.current = null;
      startedAtRef.current = null;
      setError(attachResult.error ?? 'video_track_adapter_unavailable');
    }
    emitTelemetry({
      coReviewState: attachResult.attached ? 'live' : 'error',
      shareStartedAt: new Date(capture.startedAt).toISOString(),
      captureMethod: capture.method,
      frameRate: capture.frameRate,
      resolution: capture.resolution,
      videoTrackAttached: attachResult.attached,
      videoTrackAttachError: attachResult.error ?? null,
    });
    setState(attachResult.attached ? 'live' : 'error');
  }, [
    artifactId,
    attachVideoTrack,
    captureTargetRef,
    emitTelemetry,
    enabled,
    frameRate,
    sessionId,
    state,
  ]);

  useEffect(() => {
    return () => {
      stopCoReviewStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state === 'live' || state === 'error') {
      stopCoReview('scope_changed');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId, sessionId]);

  return {
    state,
    error,
    captureMethod,
    videoTrackAttached,
    startCoReview,
    stopCoReview,
  };
}

async function audioOnlyGeminiAttachStub(): Promise<CoReviewVideoTrackAttachResult> {
  return {
    attached: false,
    error: 'gemini_browser_websocket_audio_only_no_video_track_adapter',
  };
}
