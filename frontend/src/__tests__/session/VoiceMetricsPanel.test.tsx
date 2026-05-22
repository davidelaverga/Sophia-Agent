import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { VoiceMetricsPanel } from '../../app/components/session/VoiceMetricsPanel';
import type { SophiaCaptureBundle, SophiaCaptureSnapshot } from '../../app/lib/session-capture';
import type { VoiceRuntimeTelemetry, VoiceStateProps } from '../../app/lib/voice-types';

type TestCaptureBridge = {
  enable: () => void;
  snapshot: () => null;
  getEvents: () => [];
  export: () => SophiaCaptureBundle;
};

function buildDirtyCaptureBundle(): SophiaCaptureBundle {
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
        detectedAudio: true,
        errors: [],
        firstAudioAt: '2026-05-20T12:00:01.000Z',
        firstStreamAt: '2026-05-20T12:00:00.500Z',
        lastAudioAt: '2026-05-20T12:00:02.000Z',
        maxAbsPeak: 0.2,
        maxRms: 0.02,
        nonSilentSampleWindows: 2,
        patchInstalled: true,
        streamCount: 1,
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
    eventCount: 3,
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
    ],
    snapshot,
  };
}

vi.mock('../../app/lib/session-capture', () => ({
  registerSophiaCaptureBridge: vi.fn(() => {
    const bridge: TestCaptureBridge = {
      enable: vi.fn(),
      snapshot: () => null,
      getEvents: () => [],
      export: () => buildDirtyCaptureBundle(),
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
  builderToolCallCount: 0,
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

describe('VoiceMetricsPanel', () => {
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
    expect(screen.getByText('Tool loop')).toBeInTheDocument();
    expect(screen.queryByText('Join latency')).not.toBeInTheDocument();
    expect(screen.queryByText('Raw backend done')).not.toBeInTheDocument();
    expect(screen.queryByText('Response pipeline')).not.toBeInTheDocument();
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
      captureBundle: {
        scope: { strategy: string };
        snapshot: { storage: Record<string, unknown> };
      };
    };
    const serialized = JSON.stringify(report);

    expect(report.reportType).toBe('voice-telemetry-report');
    expect(report.version).toBe(2);
    expect(report.captureBundle.scope.strategy).toBe('last-start-event');
    expect(serialized).toContain('gemini-tool-call-ledger');
    expect(serialized).toContain('tool-call-dev');
    expect(serialized).not.toContain('old persisted session message should not export');
    expect(serialized).not.toContain('old persisted storage message should not export');
    expect(serialized).not.toContain('old persisted recap should not export');
    expect(serialized).not.toContain('old event should not export');
    expect(report.captureBundle.snapshot.storage).toEqual({});
  });
});