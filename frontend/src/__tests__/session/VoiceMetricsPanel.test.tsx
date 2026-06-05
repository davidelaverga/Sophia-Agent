import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceMetricsPanel } from '../../app/components/session/VoiceMetricsPanel';
import type { SophiaCaptureBundle, SophiaCaptureSnapshot } from '../../app/lib/session-capture';
import type { VoiceRuntimeTelemetry, VoiceStateProps } from '../../app/lib/voice-types';

type TestCaptureBridge = {
  enable: () => void;
  snapshot: () => SophiaCaptureSnapshot;
  getEvents: () => SophiaCaptureBundle['events'];
  export: () => SophiaCaptureBundle;
};

function buildDirtyCaptureBundle({
  detectedAudio = true,
  maxRms = 0.02,
  streamCount = 1,
}: {
  detectedAudio?: boolean;
  maxRms?: number | null;
  streamCount?: number;
} = {}): SophiaCaptureBundle {
  const snapshot: SophiaCaptureSnapshot = {
    capturedAt: '2026-05-20T12:00:03.000Z',
    location: {
      href: 'http://localhost:3000/session',
      pathname: '/session',
      title: 'Sophia',
      theme: 'dark',
    },
    debug: {},
    session: {
      sessionId: 'gemini-session-dev',
      threadId: 'thread-dev',
      status: 'active',
      isActive: true,
      presetType: 'voice',
      contextMode: 'life',
      voiceMode: true,
      startedAt: '2026-05-20T12:00:00.000Z',
      endedAt: null,
      lastActivityAt: '2026-05-20T12:00:02.000Z',
      messageCount: 1,
    },
    transcript: {
      chatMessages: [
        {
          id: 'old-chat',
          role: 'user',
          content: 'old persisted session message should not export',
          createdAt: 1,
          source: null,
          status: null,
          incomplete: false,
          audioUrl: null,
        },
      ],
      voiceMessages: [
        {
          id: 'old-voice',
          content: 'old persisted voice message should not export',
          timestamp: 1,
        },
      ],
      dom: {
        articleCount: 1,
        articles: [{ label: 'old', text: 'old rendered transcript should not export' }],
      },
    },
    artifacts: {
      sessionArtifacts: { takeaway: 'old session artifact should not export' },
      recapArtifacts: { takeaway: 'old persisted recap should not export' },
      recapCommitStatus: 'pending',
      dom: {
        railLabel: 'Artifacts: ready',
        takeawayText: 'old rendered takeaway should not export',
        reflectionText: null,
        memoriesText: null,
        panelVisible: true,
      },
    },
    harness: {
      microphone: {
        audioTrackCount: 1,
        detectedAudio,
        errors: [],
        firstAudioAt: detectedAudio ? '2026-05-20T12:00:01.000Z' : null,
        firstStreamAt: '2026-05-20T12:00:00.500Z',
        lastAudioAt: detectedAudio ? '2026-05-20T12:00:02.000Z' : null,
        maxAbsPeak: 0.2,
        maxRms,
        nonSilentSampleWindows: detectedAudio ? 2 : 0,
        patchInstalled: true,
        streamCount,
        streams: [],
        totalSampleWindows: 4,
        tracks: [],
      },
    },
    metadata: {
      currentSessionId: 'gemini-session-dev',
      currentThreadId: 'thread-dev',
      currentRunId: 'run-dev',
      emotionalWeather: null,
    },
    presence: {
      labels: [],
    },
    storage: {
      'sophia-session-store': { messages: ['old persisted storage message should not export'] },
      'sophia-recap': { artifacts: ['old recap storage should not export'] },
    },
  };

  return {
    startedAt: '2026-05-20T12:00:00.000Z',
    exportedAt: '2026-05-20T12:00:03.000Z',
    eventCount: 4,
    events: [
      {
        seq: 1,
        recordedAt: '2026-05-20T11:50:00.000Z',
        category: 'voice-sse',
        name: 'sophia.transcript',
        payload: { data: { text: 'old event should not export', sessionId: 'old-session' } },
      },
      {
        seq: 2,
        recordedAt: '2026-05-20T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'gemini-session-dev' },
      },
      {
        seq: 3,
        recordedAt: '2026-05-20T12:00:01.000Z',
        category: 'voice-session',
        name: 'gemini-tool-call-ledger',
        payload: { entry: { toolCallId: 'tool-call-dev', finalState: 'responded' } },
      },
      {
        seq: 4,
        recordedAt: '2026-05-20T12:00:02.000Z',
        category: 'voice-session',
        name: 'artifact-review-voice-command',
        payload: {
          reviewVoiceCommandKind: 'fit_width',
          reviewVoiceCommandApplied: true,
          reviewVoiceCommandRefreshResult: 'success',
          reviewVoiceCommandDidHardIntercept: false,
          reviewVoiceCommandWaitedForViewReady: true,
          lastReviewVoiceCommandUiMode: 'voice',
          rawTranscriptExcluded: true,
        },
      },
    ],
    snapshot,
  };
}

let captureBundleFactory = () => buildDirtyCaptureBundle();

vi.mock('../../app/lib/session-capture', () => ({
  registerSophiaCaptureBridge: vi.fn(() => {
    const bundle = captureBundleFactory();
    const bridge: TestCaptureBridge = {
      enable: vi.fn(),
      snapshot: () => bundle.snapshot,
      getEvents: () => bundle.events,
      export: () => captureBundleFactory(),
    };
    window.__sophiaCapture = bridge as unknown as NonNullable<Window['__sophiaCapture']>;
  }),
}));

const legacyTelemetry: VoiceRuntimeTelemetry = {
  runtime: 'legacy_cascade',
  source: 'voice-connect',
  sessionId: 'session-dev',
  threadId: 'thread-dev',
  callId: 'call-dev',
  voiceAgentSessionId: 'voice-agent-dev',
  streamUrl: '/voice/stream/voice-agent-dev',
};

const geminiTelemetry: VoiceRuntimeTelemetry = {
  runtime: 'gemini_live',
  source: 'voice-connect',
  sessionId: 'gemini-session-dev',
  streamUrl: '/voice/gemini/stream/gemini-session-dev',
  websocketUrl: 'wss://generativelanguage.googleapis.com/ws',
  relayUrl: '/voice/gemini/relay/gemini-session-dev',
  transport: 'browser_live_websocket',
  publicEventBoundary: '/voice/gemini/stream/gemini-session-dev',
  connectionState: 'connected',
  stage: 'connected',
  websocketState: 'setup_complete',
  relayStatus: 'active',
  publicSseState: 'connected',
  microphoneState: 'connected',
  remoteAudioState: 'active',
  setupComplete: true,
  providerEventCount: 3,
  lastProviderEventAt: '2026-04-07T12:00:00.200Z',
  lastProviderEventType: 'serverContent',
  providerCategoryCounts: {},
  outputAudioEventCount: 1,
  lastOutputAudioAt: '2026-04-07T12:00:00.500Z',
  staleAssistantAudioDroppedCount: 0,
  staleAssistantTranscriptDroppedCount: 0,
  staleAssistantOutputSuppressionCount: 0,
  playbackGeneration: 1,
  assistantUserOverlapMs: 0,
  interruptedResponseIds: [],
  interruptionCount: 1,
  playbackFlushCount: 1,
  lastInterruptionAt: '2026-04-07T12:00:00.420Z',
  lastPlaybackFlushAt: '2026-04-07T12:00:00.420Z',
  relayDiagnosticCount: 1,
  lastRelayDiagnosticAt: '2026-04-07T12:00:00.320Z',
  lastRelayEventType: 'serverContent',
  relayAttemptCount: 1,
  relaySuccessCount: 1,
  relayFailureCount: 0,
  relayTraceCount: 1,
  relayClassificationCounts: {
    critical: { count: 1, lastAt: '2026-04-07T12:00:00.320Z' },
    summary: { count: 0, lastAt: null },
    skip: { count: 2, lastAt: '2026-04-07T12:00:00.500Z' },
  },
  lastRelayTraceAt: '2026-04-07T12:00:00.320Z',
  lastRelayCorrelationId: 'gemini-event-1',
  lastRelayResponseKind: 'neither',
  lastRelayDurationMs: 12,
  maxRelayDurationMs: 12,
  lastCriticalRelayDurationMs: 12,
  lastTranscriptionRelayDurationMs: 12,
  lastToolCallRelayDurationMs: null,
  orderedRelayQueueDepth: 0,
  oldestQueuedAgeMs: null,
  transcriptPartialsCoalesced: 0,
  transcriptPartialsSent: 2,
  transcriptPartialsDropped: 0,
  transcriptCoalescingDisabledReason: 'provider_output_transcription_is_delta_like',
  finalTranscriptEventsSent: 1,
  nonDroppableCriticalEventsSent: 2,
  lastTranscriptRelayLatencyMs: 140,
  maxTranscriptRelayLatencyMs: 180,
  p95TranscriptRelayLatencyMs: 180,
  coalescedBySegment: {},
  consecutiveRelayFailures: 0,
  lastRelayErrorText: null,
  websocketDiagnosticCount: 0,
  lastWebSocketDiagnosticAt: null,
  lastWebSocketErrorText: null,
  toolCallCount: 1,
  toolResponseCount: 1,
  toolRejectionCount: 0,
  toolCancellationCount: 0,
  artifactToolCallCount: 1,
  artifactToolCallUnknownCount: 0,
  builderToolCallCount: 0,
  unresolvedToolCallCount: 0,
  oldestUnresolvedToolCallAgeMs: null,
  lastToolPhase: 'tool_response_sent',
  lastToolName: 'emit_artifact',
  lastToolAt: '2026-04-07T12:00:00.360Z',
  toolCallLedger: [],
};

function buildVoiceState(runtimeTelemetry: VoiceRuntimeTelemetry): VoiceStateProps {
  return {
    stage: 'listening',
    runtime: runtimeTelemetry.runtime,
    runtimeTelemetry,
    partialReply: '',
    finalReply: '',
    error: undefined,
    stopTalking: vi.fn(),
    bargeIn: vi.fn(),
    softBargeIn: vi.fn(),
  };
}

function setViewport(width: number, height = 900) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  });

  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 767px)' ? width < 768 : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('VoiceMetricsPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewport(1440, 960);
    captureBundleFactory = () => buildDirtyCaptureBundle();
  });

  it('labels the legacy runtime and keeps legacy latency cards visible', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(legacyTelemetry)}
        defaultExpanded
        layout="inline"
      />
    );

    expect(screen.getByText('Runtime: Legacy Cascade')).toBeInTheDocument();
    expect(screen.getByText('Join latency')).toBeInTheDocument();
    expect(screen.getByText('Response pipeline')).toBeInTheDocument();
  });

  it('labels Gemini Live and hides legacy-only pipeline labels', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="inline"
      />
    );

    expect(screen.getByText('Runtime: Gemini Live')).toBeInTheDocument();
    expect(screen.getByText('Gemini transport + session')).toBeInTheDocument();
    expect(screen.getByText('Gemini live activity')).toBeInTheDocument();
    expect(screen.getByText('Barge-in transcript captured')).toBeInTheDocument();
    expect(screen.getByText('Barge-in dispatches')).toBeInTheDocument();
    expect(screen.getByText('Tool loop')).toBeInTheDocument();
    expect(screen.queryByText('Join latency')).not.toBeInTheDocument();
    expect(screen.queryByText('Raw backend done')).not.toBeInTheDocument();
    expect(screen.queryByText('Response pipeline')).not.toBeInTheDocument();
  });

  it('surfaces a warning when the mic stream is connected but no audio signal is detected', () => {
    captureBundleFactory = () => buildDirtyCaptureBundle({
      detectedAudio: false,
      maxRms: 0.0004,
      streamCount: 1,
    });

    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="inline"
      />
    );

    expect(screen.getByText('Mic connected, no signal')).toBeInTheDocument();
    expect(screen.getByText('Browser microphone stream is connected, but the local probe has not observed non-silent audio yet.')).toBeInTheDocument();
  });

  it('keeps floating telemetry hidden by default', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded={false}
        layout="floating"
      />
    );

    expect(screen.queryByRole('heading', { name: /voice runtime telemetry/i })).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /telemetry/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('positions the telemetry toggle away from the top-right session controls', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded={false}
        layout="floating"
      />
    );

    const toggle = screen.getByTestId('voice-metrics-toggle');
    expect(toggle.className).toContain('bottom-[calc(env(safe-area-inset-bottom,0px)+7rem)]');
    expect(toggle.className).toContain('md:top-24');
    expect(toggle.className).toContain('md:right-6');
  });

  it('opens the floating telemetry drawer from the toggle and keeps controls visible', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="floating"
      />
    );

    const toggle = screen.getByRole('button', { name: /telemetry/i });

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: /voice runtime telemetry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy json/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export json/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    expect(screen.getByText('Runtime: Gemini Live')).toBeInTheDocument();
  });

  it('uses a responsive desktop drawer shell when opened on wider layouts', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="floating"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /telemetry/i }));

    const drawer = screen.getByTestId('voice-metrics-floating-container');
    const panel = screen.getByTestId('voice-metrics-panel');

    expect(drawer.className).toContain('md:right-4');
    expect(drawer.className).toContain('md:top-[calc(env(safe-area-inset-top,0px)+6rem)]');
    expect(panel.className).toContain('max-w-[calc(100vw-2rem)]');
  });

  it('switches to a bottom-sheet style drawer on smaller layouts', () => {
    setViewport(390, 844);

    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="floating"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /telemetry/i }));

    const drawer = screen.getByTestId('voice-metrics-floating-container');
    const panel = screen.getByTestId('voice-metrics-panel');

    expect(drawer.className).toContain('bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]');
    expect(panel.className).toContain('w-[calc(100vw-1rem)]');
    expect(screen.queryByTestId('voice-metrics-resize-handle')).not.toBeInTheDocument();
  });

  it('closes the floating telemetry drawer from the close control', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="floating"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /telemetry/i }));
    expect(screen.getByRole('heading', { name: /voice runtime telemetry/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close telemetry panel/i }));

    expect(screen.queryByRole('heading', { name: /voice runtime telemetry/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /telemetry/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the floating telemetry drawer with Escape', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="floating"
      />
    );

    const toggle = screen.getByRole('button', { name: /telemetry/i });

    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: /voice runtime telemetry/i })).not.toBeInTheDocument();
  });

  it('shows the desktop resize handle when the telemetry drawer is open and expanded', () => {
    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="floating"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /telemetry/i }));

    expect(screen.getByTestId('voice-metrics-resize-handle')).toBeInTheDocument();
  });

  it('copies the clean scoped telemetry report by default', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="inline"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /copy json/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const report = JSON.parse(writeText.mock.calls[0][0] as string) as {
      reportType: string;
      version: number;
      coreview: {
        visual: {
          telemetryExportAfterCommandSucceeded: boolean;
          lastReviewVoiceCommandKind: string | null;
          lastReviewVoiceCommands: Array<Record<string, unknown>>;
        };
      };
      captureBundle: {
        scope: { strategy: string };
        snapshot: { storage: Record<string, unknown> };
      };
    };
    const serialized = JSON.stringify(report);

    expect(report.reportType).toBe('voice-telemetry-report');
    expect(report.version).toBe(2);
    expect(report.captureBundle.scope.strategy).toBe('last-start-event');
    expect(report.coreview.visual.telemetryExportAfterCommandSucceeded).toBe(true);
    expect(report.coreview.visual.lastReviewVoiceCommandKind).toBe('fit_width');
    expect(report.coreview.visual.lastReviewVoiceCommands.at(-1)).toMatchObject({
      kind: 'fit_width',
      applied: true,
      rawTranscriptExcluded: true,
    });
    expect(serialized).toContain('gemini-tool-call-ledger');
    expect(serialized).toContain('tool-call-dev');
    expect(serialized).not.toContain('old persisted session message should not export');
    expect(serialized).not.toContain('old persisted storage message should not export');
    expect(serialized).not.toContain('old persisted recap should not export');
    expect(serialized).not.toContain('old event should not export');
    expect(report.captureBundle.snapshot.storage).toEqual({});
  });

  it('shows a safe inline error when telemetry export fails', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('blob url failed');
      }),
    });

    render(
      <VoiceMetricsPanel
        voiceState={buildVoiceState(geminiTelemetry)}
        defaultExpanded
        layout="inline"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /export json/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not export session JSON.');
  });
});
