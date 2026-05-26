import { describe, expect, it, vi } from 'vitest';

import {
  captureArtifactRegion,
  createCoReviewTelemetry,
  sanitizeCoReviewTelemetry,
  stopCoReviewStream,
} from '../../app/lib/co-review-capture';

function fakeStream() {
  const track = {
    kind: 'video',
    stopped: false,
    stop() {
      this.stopped = true;
    },
  } as unknown as MediaStreamTrack & { stopped: boolean };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

describe('co-review artifact capture', () => {
  it('captures an artifact canvas with captureStream', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const { stream, track } = fakeStream();
    canvas.captureStream = vi.fn(() => stream);

    const result = await captureArtifactRegion(canvas, { frameRate: 7 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('canvas_capture_stream');
      expect(result.frameRate).toBe(7);
      expect(result.resolution).toEqual({ width: 320, height: 180 });
      expect(result.videoTrack).toBe(track);
    }
  });

  it('reports unsupported for DOM regions instead of calling whole-screen capture', async () => {
    const getDisplayMedia = vi.fn();
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });

    const result = await captureArtifactRegion(document.createElement('section'));

    expect(result).toMatchObject({
      ok: false,
      method: 'unsupported',
      safeReason: 'dom_region_capture_requires_clean_canvas_rerender',
    });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('stops every captured track on exit', () => {
    const { stream, track } = fakeStream();

    stopCoReviewStream(stream);

    expect(track.stopped).toBe(true);
  });

  it('keeps telemetry free of frames and raw artifact text', () => {
    const telemetry = sanitizeCoReviewTelemetry(
      createCoReviewTelemetry({
        coReviewEnabled: true,
        coReviewState: 'live',
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        captureMethod: 'canvas_capture_stream',
        resolution: { width: 320, height: 180 },
        frameRate: 5,
        videoTrackAttached: true,
      }),
    );

    expect(Object.keys(telemetry)).not.toContain('text');
    expect(Object.keys(telemetry)).not.toContain('frame');
    expect(JSON.stringify(telemetry)).not.toContain('tiny fine print');
  });
});
