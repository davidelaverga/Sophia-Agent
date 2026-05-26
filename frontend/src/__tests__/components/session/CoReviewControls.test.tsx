import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoReviewControls } from '../../../app/components/session/CoReviewControls';
import { useArtifactCoReview } from '../../../app/hooks/useArtifactCoReview';
import type { CoReviewCaptureTelemetry } from '../../../app/lib/co-review-capture';
import { isSophiaCoReviewEnabled } from '../../../app/lib/co-review-flags';

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

type HarnessProps = {
  artifactId?: string;
  sessionId?: string;
  enabled?: boolean;
  attach?: (track: MediaStreamTrack, telemetry: CoReviewCaptureTelemetry) => Promise<{ attached: boolean; error?: string | null }>;
  onTelemetry?: (telemetry: CoReviewCaptureTelemetry) => void;
};

function CoReviewHarness({
  artifactId = 'artifact-a',
  sessionId = 'session-a',
  enabled = true,
  attach = async () => ({ attached: true }),
  onTelemetry,
}: HarnessProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const coReview = useArtifactCoReview({
    enabled,
    artifactId,
    sessionId,
    captureTargetRef: ref,
    attachVideoTrack: attach,
    onTelemetry,
  });

  return (
    <div>
      <canvas ref={ref} width={240} height={120} aria-label="Synthetic artifact" />
      <CoReviewControls
        enabled={enabled}
        state={coReview.state}
        error={coReview.error}
        onStart={() => void coReview.startCoReview()}
        onStop={() => coReview.stopCoReview('user_exit')}
      />
    </div>
  );
}

describe('co-review controls', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED = 'false';
  });

  it('hides Review together when the feature flag is off', () => {
    expect(isSophiaCoReviewEnabled()).toBe(false);

    render(
      <CoReviewControls
        enabled={isSophiaCoReviewEnabled()}
        state="inactive"
        error={null}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.queryByText('Review together')).not.toBeInTheDocument();
  });

  it('shows Review together for an eligible artifact when the feature flag is on', () => {
    process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED = 'true';

    render(
      <CoReviewControls
        enabled={isSophiaCoReviewEnabled()}
        state="inactive"
        error={null}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByText('Review together')).toBeInTheDocument();
  });

  it('enters live state and shows the text looking indicator', async () => {
    const { stream } = fakeStream();
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => stream);

    render(<CoReviewHarness />);

    await userEvent.click(screen.getByText('Review together'));

    expect(await screen.findByText('Sophia is looking at this artifact')).toBeInTheDocument();
  });

  it('exits co-review by stopping the track and clearing the indicator', async () => {
    const { stream, track } = fakeStream();
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => stream);

    render(<CoReviewHarness />);

    await userEvent.click(screen.getByText('Review together'));
    await screen.findByText('Sophia is looking at this artifact');
    await userEvent.click(screen.getByText('Stop looking'));

    await waitFor(() => {
      expect(screen.queryByText('Sophia is looking at this artifact')).not.toBeInTheDocument();
    });
    expect(track.stopped).toBe(true);
  });

  it('keeps the persistent text indicator when reduced motion is requested', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(
      <CoReviewControls
        enabled
        state="live"
        error={null}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByText('Sophia is looking at this artifact')).toBeInTheDocument();
  });

  it('scopes live state to artifact and session changes', async () => {
    const { stream, track } = fakeStream();
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => stream);

    const { rerender } = render(<CoReviewHarness artifactId="artifact-a" sessionId="session-a" />);

    await userEvent.click(screen.getByText('Review together'));
    await screen.findByText('Sophia is looking at this artifact');

    rerender(<CoReviewHarness artifactId="artifact-b" sessionId="session-a" />);

    await waitFor(() => {
      expect(screen.queryByText('Sophia is looking at this artifact')).not.toBeInTheDocument();
    });
    expect(track.stopped).toBe(true);
  });

  it('records safe telemetry without raw frames or artifact text', async () => {
    const { stream } = fakeStream();
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => stream);
    const events: CoReviewCaptureTelemetry[] = [];

    render(<CoReviewHarness onTelemetry={(event) => events.push(event)} />);

    await userEvent.click(screen.getByText('Review together'));
    await screen.findByText('Sophia is looking at this artifact');

    const serialized = JSON.stringify(events);
    expect(serialized).toContain('artifact-a');
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('tiny fine print');
    expect(Object.keys(events.at(-1) ?? {})).not.toContain('frame');
  });
});
