import { describe, expect, it } from 'vitest';

import type {
  SophiaCaptureSnapshot,
  SophiaCaptureWebRTCSummary,
} from '../../app/lib/session-capture';
import {
  buildVoiceDeveloperMetrics,
  buildVoiceTelemetrySummary,
  sliceVoiceCaptureEventsToActiveRun,
  type VoiceCaptureEvent,
  type VoiceTelemetryBaselineEntry,
} from '../../app/lib/voice-runtime-metrics';

function buildEvent({
  seq,
  at,
  category,
  name,
  payload,
}: {
  seq: number;
  at: string;
  category: string;
  name: string;
  payload?: Record<string, unknown>;
}): VoiceCaptureEvent {
  return {
    seq,
    recordedAt: at,
    category,
    name,
    payload,
  };
}

function buildSnapshot({
  detectedAudio = true,
  error = null,
  webrtc,
}: {
  detectedAudio?: boolean;
  error?: string | null;
  webrtc?: SophiaCaptureWebRTCSummary;
} = {}): SophiaCaptureSnapshot {
  return {
    capturedAt: '2026-04-07T12:00:03.250Z',
    location: {
      href: 'http://localhost:3000/session/dev',
      pathname: '/session/dev',
      title: 'Sophia',
      theme: 'dark',
    },
    debug: {} as SophiaCaptureSnapshot['debug'],
    session: null,
    transcript: {
      chatMessages: [],
      voiceMessages: [],
      dom: {
        articleCount: 0,
        articles: [],
      },
    },
    artifacts: {
      sessionArtifacts: null,
      recapArtifacts: null,
      recapCommitStatus: null,
      dom: {
        railLabel: null,
        takeawayText: null,
        reflectionText: null,
        memoriesText: null,
        panelVisible: false,
      },
    },
    harness: {
      microphone: {
        audioTrackCount: 1,
        detectedAudio,
        errors: error ? [error] : [],
        firstAudioAt: detectedAudio ? '2026-04-07T12:00:01.100Z' : null,
        firstStreamAt: '2026-04-07T12:00:00.260Z',
        lastAudioAt: detectedAudio ? '2026-04-07T12:00:01.300Z' : null,
        maxAbsPeak: detectedAudio ? 0.66 : null,
        maxRms: detectedAudio ? 0.084 : null,
        nonSilentSampleWindows: detectedAudio ? 12 : 0,
        patchInstalled: true,
        streamCount: 1,
        streams: [],
        totalSampleWindows: 16,
        tracks: [],
      },
      webrtc: webrtc ?? {
        activeCallId: 'call-dev',
        voiceAgentSessionId: 'voice-agent-dev',
        datacenter: null,
        sampleCount: 0,
        firstSampleAt: null,
        lastSampleAt: null,
        recentSamples: [],
        publisher: {
          sampleCount: 0,
          lastRecordedAt: null,
          averageRoundTripTimeMs: null,
          lastRoundTripTimeMs: null,
          maxRoundTripTimeMs: null,
          lastJitterMs: null,
          averageJitterMs: null,
          maxJitterMs: null,
          lastPacketLossPct: null,
          averagePacketLossPct: null,
          maxPacketLossPct: null,
          lastPacketsLost: null,
          lastPacketsReceived: null,
          totalBytesSent: null,
          totalBytesReceived: null,
          codec: null,
        },
        subscriber: {
          sampleCount: 0,
          lastRecordedAt: null,
          averageRoundTripTimeMs: null,
          lastRoundTripTimeMs: null,
          maxRoundTripTimeMs: null,
          lastJitterMs: null,
          averageJitterMs: null,
          maxJitterMs: null,
          lastPacketLossPct: null,
          averagePacketLossPct: null,
          maxPacketLossPct: null,
          lastPacketsLost: null,
          lastPacketsReceived: null,
          totalBytesSent: null,
          totalBytesReceived: null,
          codec: null,
        },
      },
    },
    metadata: {
      currentSessionId: 'session-dev',
      currentThreadId: 'thread-dev',
      currentRunId: 'run-dev',
      emotionalWeather: null,
    },
    presence: {
      labels: [],
    },
    storage: {},
  };
}

describe('buildVoiceDeveloperMetrics', () => {
  it('scopes raw capture events to the latest active run while keeping contiguous preconnect preparation', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-16T09:59:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'session-old' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-16T09:59:00.150Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { sessionId: 'session-old' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-16T10:00:00.000Z',
        category: 'voice-session',
        name: 'preconnect-started',
        payload: { sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-16T10:00:00.250Z',
        category: 'voice-session',
        name: 'preconnect-ready',
        payload: { sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-16T10:00:00.300Z',
        category: 'voice-session',
        name: 'backend-warmup-started',
        payload: { sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-16T10:00:00.500Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-16T10:00:00.700Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { sessionId: 'session-dev' },
      }),
    ];

    const activeRunEvents = sliceVoiceCaptureEventsToActiveRun(events);

    expect(activeRunEvents.map((event) => event.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  it('falls back to the most recent capture window when no explicit start event exists', () => {
    const events: VoiceCaptureEvent[] = Array.from({ length: 130 }, (_, index) => buildEvent({
      seq: index + 1,
      at: `2026-04-16T10:00:${String(index).padStart(2, '0')}.000Z`,
      category: 'voice-runtime',
      name: 'heartbeat',
      payload: { index },
    }));

    const activeRunEvents = sliceVoiceCaptureEventsToActiveRun(events);

    expect(activeRunEvents).toHaveLength(120);
    expect(activeRunEvents[0]?.seq).toBe(11);
    expect(activeRunEvents.at(-1)?.seq).toBe(130);
  });

  it('summarizes a healthy voice turn with latency breakdowns', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.200Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { callId: 'call-dev', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.250Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:00.550Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:00.600Z',
        category: 'voice-sse',
        name: 'stream-open',
        payload: { sessionId: 'session-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:00.800Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-07T12:00:01.100Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.084 },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-07T12:00:01.300Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'can you hear me now' } },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-07T12:00:01.600Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
      buildEvent({
        seq: 10,
        at: '2026-04-07T12:00:02.000Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_started' } },
      }),
      buildEvent({
        seq: 11,
        at: '2026-04-07T12:00:02.500Z',
        category: 'voice-sse',
        name: 'sophia.transcript',
        payload: { data: { text: 'Yes, I hear you clearly.', is_final: true } },
      }),
      buildEvent({
        seq: 12,
        at: '2026-04-07T12:00:02.800Z',
        category: 'voice-sse',
        name: 'sophia.artifact',
        payload: { data: { takeaway: 'Healthy turn.' } },
      }),
      buildEvent({
        seq: 13,
        at: '2026-04-07T12:00:03.200Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_ended' } },
      }),
      buildEvent({
        seq: 14,
        at: '2026-04-07T12:00:03.250Z',
        category: 'voice-sse',
        name: 'sophia.turn_diagnostic',
        payload: {
          data: {
            turn_id: 'turn-dev',
            status: 'completed',
            reason: 'completed',
            raw_false_end_count: 1,
            duplicate_phase_counts: {},
            submission_stabilization_ms: 180,
            backend_request_start_ms: 350,
            backend_first_event_ms: 500,
            first_text_ms: 900,
            backend_complete_ms: 1000,
            first_audio_ms: 1100,
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:03.500Z'),
    });

    expect(metrics.timings.sessionReadyMs).toBe(800);
    expect(metrics.timings.joinLatencyMs).toBe(300);
    expect(metrics.timings.sseOpenMs).toBe(400);
    expect(metrics.lastTurn.backendRequestStartMs).toBe(350);
    expect(metrics.lastTurn.backendFirstEventMs).toBe(500);
    expect(metrics.lastTurn.firstTextMs).toBe(900);
    expect(metrics.lastTurn.firstAudioMs).toBe(1100);
    expect(metrics.lastTurn.backendCompleteMs).toBe(1000);
    expect(metrics.lastTurn.agentStartLatencyMs).toBe(400);
    expect(metrics.lastTurn.responseDurationMs).toBe(1200);
    expect(metrics.transport.activeSource).toBe('sse');
    expect(metrics.counts.turns).toBe(1);
    expect(metrics.lastTurn.lastUserTranscript).toBe('can you hear me now');
    expect(metrics.lastTurn.lastAssistantTranscript).toBe('Yes, I hear you clearly.');
    expect(metrics.health.level).toBe('good');
    expect(metrics.startup.requestToCredentialsMs).toBe(200);
    expect(metrics.startup.joinToReadyMs).toBe(250);
    expect(metrics.pipeline.userEndedToRequestStartMs).toBe(350);
    expect(metrics.pipeline.submissionStabilizationMs).toBe(180);
    expect(metrics.pipeline.requestStartToFirstBackendEventMs).toBe(150);
    expect(metrics.pipeline.firstBackendEventToFirstTextMs).toBe(400);
    expect(metrics.pipeline.requestStartToFirstTextMs).toBe(550);
    expect(metrics.pipeline.committedTurnCloseMs).toBe(700);
    expect(metrics.pipeline.userEndedToFirstTextMs).toBe(900);
    expect(metrics.pipeline.rawSpeechEndToFirstTextMs).toBe(900);
    expect(metrics.pipeline.textToFirstAudioMs).toBe(200);
    expect(metrics.latencyBreakdown.startup.requestToCredentialsMs).toBe(200);
    expect(metrics.latencyBreakdown.turn.committedTurnCloseMs).toBe(700);
    expect(metrics.latencyBreakdown.backend.firstBackendEventToFirstTextMs).toBe(400);
    expect(metrics.topHotspots).toEqual([
      expect.objectContaining({ key: 'committed-turn-close', area: 'turn', valueMs: 700, level: 'good' }),
      expect.objectContaining({ key: 'first-backend-event-to-first-text', area: 'backend', valueMs: 400, level: 'good' }),
      expect.objectContaining({ key: 'user-ended-to-request', area: 'turn', valueMs: 350, level: 'good' }),
    ]);
    expect(metrics.recentTurns[0]?.committedTurnCloseMs).toBe(300);
    expect(metrics.recentTurns[0]?.committedTranscriptToAgentStartMs).toBe(700);
    expect(metrics.recentTurns[0]?.requestStartToFirstBackendEventMs).toBe(150);
    // Clean turn: one user_ended fires, raw count = 1, baseline-adjusted = 0.
    expect(metrics.recentTurns[0]?.falseUserEndedCount).toBe(1);
    expect(metrics.recentTurns[0]?.extraFalseUserEndedCount).toBe(0);
    expect(metrics.lastTurn.falseUserEndedCount).toBe(1);
    expect(metrics.lastTurn.extraFalseUserEndedCount).toBe(0);
    expect(metrics.bottleneck.kind).toBe('healthy');
    expect(metrics.thresholds.firstAudio.status).toBe('good');
    expect(metrics.regressions).toHaveLength(0);
    expect(metrics.timeline.at(-1)?.label).toBe('Turn diagnostic');

    const summary = buildVoiceTelemetrySummary(metrics);

    expect(summary.bottleneckHint).toBe('No single dominant bottleneck. Slowest measured segment: committed transcript -> agent start (700ms).');
    expect(summary.latencyBreakdownMs.backend.firstBackendEventToFirstTextMs).toBe(400);
    expect(summary.topHotspots[0]).toEqual(
      expect.objectContaining({ key: 'committed-turn-close', valueMs: 700 }),
    );
  });

  it('includes builder progress and stall diagnostics in telemetry', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:20.000Z',
        category: 'builder',
        name: 'task-running',
        payload: {
          phase: 'running',
          taskId: 'builder-1',
          detail: 'Still drafting the deliverable.',
          progressPercent: 25,
          totalSteps: 4,
          completedSteps: 1,
          activeStepTitle: 'Draft outline',
          idleMs: 260000,
          stuck: true,
          stuckReason: 'No visible builder progress for 4m 20s. It may be blocked on a tool or looping without advancing the deliverable.',
          lastUpdateAt: '2026-04-07T12:00:20.000Z',
          lastProgressAt: '2026-04-07T11:59:20.000Z',
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'thinking',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:01:20.000Z'),
    });

    expect(metrics.builder.phase).toBe('running');
    expect(metrics.builder.progressPercent).toBe(25);
    expect(metrics.builder.stuck).toBe(true);
    expect(metrics.events.builder).toBe(1);
    expect(metrics.counts.builderEvents).toBe(1);
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'builder-stall', level: 'bad' }),
      ]),
    );
    expect(metrics.timeline.some((item) => item.label === 'Builder stalled')).toBe(true);
    expect(metrics.health.title).toBe('Builder appears stalled');
  });

  it('ages a stale builder snapshot into a stall even when the last payload said running', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-15T04:43:54.399Z',
        category: 'voice-sse',
        name: 'sophia.builder_task',
        payload: {
          data: {
            type: 'task_running',
            task_id: 'ede8eb7f',
            description: "Builder: one-page brief document about Liu Cixin's Three Body Problem sci-fi book series....",
            started_at: '2026-04-15T04:43:30.559766Z',
            last_update_at: '2026-04-15T04:43:32.866153Z',
            last_progress_at: '2026-04-15T04:43:32.864136Z',
            heartbeat_ms: 21209,
            idle_ms: 21211,
            is_stuck: false,
            progress_source: 'none',
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-15T04:46:30.000Z'),
    });

    expect(metrics.builder.phase).toBe('running');
    expect(metrics.builder.stuck).toBe(true);
    expect(metrics.builder.idleMs).toBeGreaterThanOrEqual(150000);
    expect(metrics.builder.stuckReason).toMatch(/No visible builder progress for \d+(m|m \d+s|s)/i);
    expect(metrics.events.builder).toBe(1);
    expect(metrics.counts.builderEvents).toBe(1);
    expect(metrics.timeline.some((item) => item.label === 'Builder stalled')).toBe(true);
    expect(metrics.health.title).toBe('Builder appears stalled');
  });

  it('uses builder debug blocker detail when the payload omits detail text', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-15T04:43:54.399Z',
        category: 'voice-sse',
        name: 'sophia.builder_task',
        payload: {
          data: {
            type: 'task_timed_out',
            task_id: 'builder-debug-1',
            progress_percent: 50,
            debug: {
              suspected_blocker_detail: 'Builder timed out after calling bash before emit_builder_artifact.',
              last_shell_command: {
                status: 'shell_unavailable',
                requested_command: 'ls /mnt/user-data/workspace',
                error: 'No suitable shell executable found.',
              },
            },
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'thinking',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-15T04:44:38.597Z'),
    });

    expect(metrics.builder.phase).toBe('timed_out');
    expect(metrics.builder.detail).toBe('Builder timed out after calling bash before emit_builder_artifact.');
    expect(metrics.health.detail).toContain('Builder timed out after calling bash before emit_builder_artifact.');
    expect(metrics.timeline.some((item) => item.detail.includes('Builder timed out after calling bash before emit_builder_artifact.'))).toBe(true);
  });

  it('flags sessions where the mic has signal but no transcript arrives', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.200Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { callId: 'call-dev', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.250Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:00.550Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:00.800Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:01.100Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.072 },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:02.000Z'),
    });

    expect(metrics.health.level).toBe('warn');
    expect(metrics.health.title).toBe('Audio detected, transcript missing');
    expect(metrics.counts.userTranscripts).toBe(0);
    expect(metrics.bottleneck.kind).toBe('microphone');
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'microphone', level: 'warn' }),
      ]),
    );
  });

  it('marks turn segmentation noise and backend stalls as regressions', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.200Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { callId: 'call-dev', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.800Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:01.100Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'this is getting weird' } },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:01.400Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:09.800Z',
        category: 'voice-sse',
        name: 'sophia.turn_diagnostic',
        payload: {
          data: {
            turn_id: 'turn-stall',
            status: 'failed',
            reason: 'backend_stall',
            raw_false_end_count: 5,
            duplicate_phase_counts: { agent_started: 2 },
            backend_request_start_ms: 700,
            backend_first_event_ms: 1500,
            first_text_ms: 6200,
            backend_complete_ms: 7100,
            first_audio_ms: null,
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'thinking',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:11.500Z'),
    });

    expect(metrics.thresholds.firstText.status).toBe('bad');
    expect(metrics.thresholds.responseWindow.status).toBe('bad');
    expect(metrics.pipeline.userEndedToRequestStartMs).toBe(700);
    expect(metrics.pipeline.requestStartToFirstBackendEventMs).toBe(800);
    expect(metrics.pipeline.firstBackendEventToFirstTextMs).toBe(4700);
    expect(metrics.pipeline.requestStartToFirstTextMs).toBe(5500);
    expect(metrics.pipeline.firstTextToBackendCompleteMs).toBe(900);
    expect(metrics.bottleneck.kind).toBe('turn-segmentation');
    // Raw count=5, baseline-adjusted=4 (genuine false-ends).
    expect(metrics.lastTurn.falseUserEndedCount).toBe(5);
    expect(metrics.lastTurn.extraFalseUserEndedCount).toBe(4);
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'turn-segmentation', level: 'bad' }),
        expect.objectContaining({ key: 'backend-stall', level: 'bad' }),
      ]),
    );
  });

  it('treats completed streamed turns with lifecycle repeats as backend lag, not segmentation drift', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-12T23:32:28.028Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-12T23:32:29.648Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { callId: 'call-dev', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-12T23:32:29.661Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-12T23:32:30.769Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-12T23:32:31.586Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-12T23:33:48.740Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'planning a trip overseas' } },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-12T23:33:51.643Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-12T23:33:51.747Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_started' } },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-12T23:33:53.006Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_ended' } },
      }),
      buildEvent({
        seq: 10,
        at: '2026-04-12T23:33:55.143Z',
        category: 'voice-sse',
        name: 'sophia.transcript',
        payload: { data: { text: 'What kind of help are you actually looking for?', is_final: true } },
      }),
      buildEvent({
        seq: 11,
        at: '2026-04-12T23:33:56.711Z',
        category: 'voice-sse',
        name: 'sophia.turn_diagnostic',
        payload: {
          data: {
            turn_id: 'turn-late-audio',
            status: 'completed',
            reason: 'completed',
            raw_false_end_count: 1,
            duplicate_phase_counts: { agent_started: 4, agent_ended: 3 },
            first_text_ms: 3107,
            backend_complete_ms: 6608,
            first_audio_ms: 4478,
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'idle',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-12T23:35:17.786Z'),
    });

    expect(metrics.health.level).toBe('warn');
    expect(metrics.health.title).toBe('Backend felt slow');
    expect(metrics.bottleneck.kind).toBe('backend');
    expect(metrics.regressions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'turn-segmentation' }),
      ]),
    );
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'backend-stall', level: 'warn' }),
      ]),
    );
  });

  it('separates committed response latency from raw diagnostic latency', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-13T04:20:03.600Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-13T04:20:04.620Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-13T04:20:04.691Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-13T04:24:09.195Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'I think you are right.' } },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-13T04:24:19.379Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'I think you are right. Thank you, Sofia. You always help me when it comes to figuring out how I truly feel. Thank you.' } },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-13T04:24:21.396Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-13T04:24:22.026Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_started' } },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-13T04:24:22.037Z',
        category: 'voice-sse',
        name: 'sophia.transcript',
        payload: { data: { text: 'You', is_final: false } },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-13T04:24:25.193Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_ended' } },
      }),
      buildEvent({
        seq: 10,
        at: '2026-04-13T04:24:25.818Z',
        category: 'voice-sse',
        name: 'sophia.turn_diagnostic',
        payload: {
          data: {
            turn_id: 'turn-drift',
            status: 'completed',
            reason: 'completed',
            raw_false_end_count: 1,
            duplicate_phase_counts: {},
            backend_request_start_ms: 29.46,
            backend_first_event_ms: 12410.68,
            first_text_ms: 12410.89,
            backend_complete_ms: 15573.03,
            first_audio_ms: 14983.29,
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'idle',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-13T04:24:40.934Z'),
    });

    expect(metrics.pipeline.committedTurnCloseMs).toBe(2647);
    expect(metrics.pipeline.userEndedToAgentStartMs).toBe(630);
    expect(metrics.pipeline.userEndedToFirstTextMs).toBe(641);
    expect(metrics.pipeline.rawSpeechEndToFirstTextMs).toBe(12410.89);
    expect(metrics.health.title).toBe('Committed response was fast');
    expect(metrics.bottleneck.kind).toBe('commit-boundary');
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'commit-boundary', level: 'warn' }),
      ]),
    );
    expect(metrics.regressions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'backend-stall' }),
      ]),
    );
  });

  it('surfaces warm-start preparation and network diagnostics', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-16T10:00:00.000Z',
        category: 'voice-session',
        name: 'preconnect-started',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-16T10:00:00.420Z',
        category: 'voice-session',
        name: 'preconnect-ready',
        payload: {
          callId: 'call-dev',
          durationMs: 420,
          sessionId: 'session-dev',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-16T10:00:00.430Z',
        category: 'voice-session',
        name: 'backend-warmup-started',
        payload: {
          callId: 'call-dev',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-16T10:00:00.580Z',
        category: 'voice-session',
        name: 'backend-warmup-completed',
        payload: {
          callId: 'call-dev',
          durationMs: 150,
          sessionId: 'session-dev',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-16T10:00:02.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-16T10:00:02.005Z',
        category: 'voice-session',
        name: 'preconnect-reused',
        payload: {
          callId: 'call-dev',
          preparedCredentialAgeMs: 1585,
          sessionId: 'session-dev',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-16T10:00:02.010Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: {
          callId: 'call-dev',
          sessionId: 'session-dev',
          source: 'prefetched',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-16T10:00:02.040Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-16T10:00:02.240Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 10,
        at: '2026-04-16T10:00:02.400Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: {
        ...buildSnapshot(),
        network: {
          online: true,
          effectiveType: '4g',
          rttMs: 45,
          downlinkMbps: 12.5,
          saveData: false,
        },
      },
      nowMs: Date.parse('2026-04-16T10:00:02.500Z'),
    });

    expect(metrics.startup.credentialsSource).toBe('prefetched');
    expect(metrics.startup.preconnectFetchMs).toBe(420);
    expect(metrics.startup.preparedCredentialAgeMs).toBe(1585);
    expect(metrics.startup.backendWarmupStatus).toBe('completed');
    expect(metrics.startup.backendWarmupDurationMs).toBe(150);
    expect(metrics.events.preconnectReady).toBe(1);
    expect(metrics.events.preconnectReused).toBe(1);
    expect(metrics.events.warmupCompleted).toBe(1);
    expect(metrics.transport.network.effectiveType).toBe('4g');
    expect(metrics.transport.network.downlinkMbps).toBe(12.5);
    expect(metrics.timeline.some((item) => item.label === 'Preconnect ready')).toBe(true);
    expect(metrics.timeline.some((item) => item.label === 'Warmup complete')).toBe(true);
  });

  it('tracks startup retries and preparation failures', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-16T11:00:00.000Z',
        category: 'voice-session',
        name: 'preconnect-started',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-16T11:00:00.350Z',
        category: 'voice-session',
        name: 'preconnect-failed',
        payload: {
          durationMs: 350,
          error: 'gateway timeout',
          sessionId: 'session-dev',
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-16T11:00:01.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-16T11:00:01.050Z',
        category: 'voice-session',
        name: 'start-talking-ignored',
        payload: { reason: 'duplicate-connect', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-16T11:00:01.400Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: {
          callId: 'call-dev',
          sessionId: 'session-dev',
          source: 'fresh',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-16T11:00:01.410Z',
        category: 'voice-session',
        name: 'backend-warmup-started',
        payload: {
          callId: 'call-dev',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-16T11:00:01.560Z',
        category: 'voice-session',
        name: 'backend-warmup-failed',
        payload: {
          callId: 'call-dev',
          durationMs: 150,
          error: 'warmup 503',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'voice-agent-dev',
        },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-16T11:00:01.700Z',
        category: 'voice-session',
        name: 'stale-connect-response',
        payload: { requestVersion: 1, sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-16T11:00:05.000Z',
        category: 'voice-session',
        name: 'startup-ready-timeout',
        payload: { sessionId: 'session-dev' },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'error',
      events,
      snapshot: buildSnapshot({ detectedAudio: false }),
      nowMs: Date.parse('2026-04-16T11:00:05.500Z'),
      runtimeError: 'Startup timeout',
    });

    expect(metrics.events.startIgnored).toBe(1);
    expect(metrics.events.startupTimeouts).toBe(1);
    expect(metrics.events.staleConnectResponses).toBe(1);
    expect(metrics.events.preconnectFailed).toBe(1);
    expect(metrics.events.warmupFailed).toBe(1);
    expect(metrics.startup.credentialsSource).toBe('fresh');
    expect(metrics.startup.preconnectError).toBe('gateway timeout');
    expect(metrics.startup.backendWarmupStatus).toBe('failed');
    expect(metrics.startup.backendWarmupError).toBe('warmup 503');
    expect(metrics.timeline.some((item) => item.label === 'Startup timeout')).toBe(true);
  });

  it('derives remote playback lifecycle timings after audio bind', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-16T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-16T12:00:00.200Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { callId: 'call-dev', sessionId: 'session-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-16T12:00:00.250Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-16T12:00:00.500Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-16T12:00:00.700Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-16T12:00:00.850Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'hello there' } },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-16T12:00:01.050Z',
        category: 'voice-runtime',
        name: 'remote-participant-audio-bound',
        payload: { participantSessionId: 'voice-agent-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-16T12:00:01.400Z',
        category: 'voice-runtime',
        name: 'remote-audio-canplay',
        payload: { durationMs: 350, participantSessionId: 'voice-agent-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-16T12:00:01.600Z',
        category: 'voice-runtime',
        name: 'remote-audio-playing',
        payload: { durationMs: 550, participantSessionId: 'voice-agent-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-16T12:00:01.800Z'),
    });

    expect(metrics.startup.joinToRemoteAudioMs).toBe(550);
    expect(metrics.startup.joinToPlaybackStartMs).toBe(1100);
    expect(metrics.startup.bindToPlaybackStartMs).toBe(550);
    expect(metrics.transport.playback.currentState).toBe('playing');
    expect(metrics.transport.playback.participantSessionId).toBe('voice-agent-dev');
    expect(metrics.transport.playback.bindToCanPlayMs).toBe(350);
    expect(metrics.transport.playback.bindToPlayingMs).toBe(550);
    expect(metrics.events.playbackBound).toBe(1);
    expect(metrics.events.playbackCanPlay).toBe(1);
    expect(metrics.events.playbackStarted).toBe(1);
    expect(metrics.timeline.some((item) => item.label === 'Audio playing')).toBe(true);
  });

  it('marks browser playback timeouts as playback regressions', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-16T12:10:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-16T12:10:00.200Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { callId: 'call-dev', sessionId: 'session-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-16T12:10:00.250Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-16T12:10:00.500Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-16T12:10:00.700Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-16T12:10:00.850Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'say something back' } },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-16T12:10:01.000Z',
        category: 'voice-runtime',
        name: 'remote-participant-audio-bound',
        payload: { participantSessionId: 'voice-agent-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-16T12:10:03.600Z',
        category: 'voice-runtime',
        name: 'remote-audio-playback-timeout',
        payload: { durationMs: 2600, participantSessionId: 'voice-agent-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-16T12:10:03.800Z'),
    });

    expect(metrics.transport.playback.currentState).toBe('timed_out');
    expect(metrics.transport.playback.lastTimeoutDurationMs).toBe(2600);
    expect(metrics.events.playbackTimeouts).toBe(1);
    expect(metrics.health.title).toBe('Remote audio did not start cleanly');
    expect(metrics.bottleneck.kind).toBe('tts');
    expect(metrics.topHotspots[0]).toEqual(
      expect.objectContaining({ key: 'playback-timeout', area: 'playback', valueMs: 2600, level: 'bad' }),
    );
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'playback', level: 'bad' }),
      ]),
    );
    expect(metrics.timeline.some((item) => item.label === 'Playback timeout')).toBe(true);
  });

  it('accounts for recovered and active reconnect downtime', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-16T12:20:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-16T12:20:00.200Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { callId: 'call-dev', sessionId: 'session-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-16T12:20:00.500Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', callingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-16T12:20:00.700Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'remote-participant', remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-16T12:20:00.850Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'keep going' } },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-16T12:20:02.000Z',
        category: 'voice-session',
        name: 'reconnect-started',
        payload: { previousCallingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-16T12:20:03.400Z',
        category: 'voice-session',
        name: 'reconnect-recovered',
        payload: { durationMs: 1400, remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-16T12:20:05.000Z',
        category: 'voice-session',
        name: 'reconnect-started',
        payload: { previousCallingState: 'joined', voiceAgentSessionId: 'voice-agent-dev' },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-16T12:20:06.800Z'),
    });

    expect(metrics.transport.reconnect.count).toBe(2);
    expect(metrics.transport.reconnect.recovered).toBe(1);
    expect(metrics.transport.reconnect.failed).toBe(0);
    expect(metrics.transport.reconnect.totalDowntimeMs).toBe(1400);
    expect(metrics.transport.reconnect.activeDowntimeMs).toBe(1800);
    expect(metrics.transport.reconnect.lastDowntimeMs).toBe(1800);
    expect(metrics.events.reconnectStarted).toBe(2);
    expect(metrics.events.reconnectRecovered).toBe(1);
    expect(metrics.health.title).toBe('Reconnect in progress');
    expect(metrics.bottleneck.kind).toBe('transport');
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'reconnect' }),
      ]),
    );
    expect(metrics.timeline.some((item) => item.label === 'Reconnect recovered')).toBe(true);
  });

  it('surfaces degraded WebRTC transport stats from the capture snapshot', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-17T08:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'session-dev', platform: 'voice' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-17T08:00:00.200Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { sessionId: 'session-dev', callId: 'call-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-17T08:00:00.250Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-17T08:00:00.550Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-17T08:00:00.600Z',
        category: 'voice-sse',
        name: 'stream-open',
        payload: { sessionId: 'session-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-17T08:00:00.900Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-17T08:00:01.100Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.09 },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-17T08:00:01.350Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'testing transport quality' } },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot({
        webrtc: {
          activeCallId: 'call-dev',
          voiceAgentSessionId: 'voice-agent-dev',
          datacenter: 'iad',
          sampleCount: 6,
          firstSampleAt: '2026-04-17T08:00:00.700Z',
          lastSampleAt: '2026-04-17T08:00:01.800Z',
          recentSamples: [],
          publisher: {
            sampleCount: 6,
            lastRecordedAt: '2026-04-17T08:00:01.800Z',
            averageRoundTripTimeMs: 110,
            lastRoundTripTimeMs: 120,
            maxRoundTripTimeMs: 140,
            lastJitterMs: 12,
            averageJitterMs: 14,
            maxJitterMs: 18,
            lastPacketLossPct: 0.2,
            averagePacketLossPct: 0.3,
            maxPacketLossPct: 0.7,
            lastPacketsLost: 1,
            lastPacketsReceived: 340,
            totalBytesSent: 920000,
            totalBytesReceived: 120000,
            codec: 'opus',
          },
          subscriber: {
            sampleCount: 6,
            lastRecordedAt: '2026-04-17T08:00:01.800Z',
            averageRoundTripTimeMs: 540,
            lastRoundTripTimeMs: 520,
            maxRoundTripTimeMs: 710,
            lastJitterMs: 96,
            averageJitterMs: 92,
            maxJitterMs: 130,
            lastPacketLossPct: 6.1,
            averagePacketLossPct: 6.4,
            maxPacketLossPct: 9.2,
            lastPacketsLost: 42,
            lastPacketsReceived: 650,
            totalBytesSent: 0,
            totalBytesReceived: 1880000,
            codec: 'opus',
          },
        },
      }),
      nowMs: Date.parse('2026-04-17T08:00:02.000Z'),
    });
    const summary = buildVoiceTelemetrySummary(metrics);

    expect(metrics.transport.webrtc.datacenter).toBe('iad');
    expect(metrics.transport.webrtc.sampleCount).toBe(6);
    expect(metrics.bottleneck.kind).toBe('transport');
    expect(metrics.bottleneck.title).toBe('WebRTC transport is unstable');
    expect(metrics.health.title).toBe('WebRTC transport looks unstable');
    expect(summary.webrtcDatacenter).toBe('iad');
    expect(summary.webrtcSampleCount).toBe(6);
    expect(summary.webrtcSubscriberRoundTripTimeMs).toBe(540);
    expect(summary.webrtcSubscriberJitterMs).toBe(92);
    expect(summary.webrtcSubscriberPacketLossPct).toBe(6.4);
  });

  it('flags sessions that are slower than the rolling local baseline', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-17T09:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'session-dev', platform: 'voice' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-17T09:00:00.220Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { sessionId: 'session-dev', callId: 'call-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-17T09:00:00.300Z',
        category: 'voice-runtime',
        name: 'call-join-requested',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-17T09:00:00.760Z',
        category: 'voice-runtime',
        name: 'call-joined',
        payload: { callId: 'call-dev', voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-17T09:00:01.050Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { remoteParticipantCount: 1, voiceAgentSessionId: 'voice-agent-dev' },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-17T09:00:01.200Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.08 },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-17T09:00:01.450Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'compare this run to recent sessions' } },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-17T09:00:01.700Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-17T09:00:02.050Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_started' } },
      }),
      buildEvent({
        seq: 10,
        at: '2026-04-17T09:00:02.850Z',
        category: 'voice-sse',
        name: 'sophia.transcript',
        payload: { data: { text: 'This run is slower than usual.', is_final: true } },
      }),
      buildEvent({
        seq: 11,
        at: '2026-04-17T09:00:03.150Z',
        category: 'voice-runtime',
        name: 'remote-audio-playing',
        payload: { durationMs: 380 },
      }),
      buildEvent({
        seq: 12,
        at: '2026-04-17T09:00:03.250Z',
        category: 'voice-sse',
        name: 'sophia.turn_diagnostic',
        payload: {
          data: {
            turn_id: 'turn-baseline',
            status: 'completed',
            reason: 'completed',
            backend_request_start_ms: 1800,
            backend_first_event_ms: 2200,
            first_text_ms: 2600,
            backend_complete_ms: 2950,
            first_audio_ms: 3100,
            submission_stabilization_ms: 140,
          },
        },
      }),
    ];

    const baselineEntries: VoiceTelemetryBaselineEntry[] = [
      {
        runKey: 'session-1::run-1::2026-04-17T08:10:00.000Z',
        recordedAt: '2026-04-17T08:10:04.000Z',
        sessionId: 'session-1',
        runId: 'run-1',
        activeRunStartedAt: '2026-04-17T08:10:00.000Z',
        metrics: {
          sessionReadyMs: 340,
          joinLatencyMs: 220,
          requestStartToFirstTextMs: 240,
          bindToPlaybackStartMs: 190,
          subscriberRoundTripTimeMs: 130,
          subscriberJitterMs: 18,
          subscriberPacketLossPct: 0.2,
        },
      },
      {
        runKey: 'session-2::run-2::2026-04-17T08:20:00.000Z',
        recordedAt: '2026-04-17T08:20:04.000Z',
        sessionId: 'session-2',
        runId: 'run-2',
        activeRunStartedAt: '2026-04-17T08:20:00.000Z',
        metrics: {
          sessionReadyMs: 360,
          joinLatencyMs: 240,
          requestStartToFirstTextMs: 260,
          bindToPlaybackStartMs: 210,
          subscriberRoundTripTimeMs: 140,
          subscriberJitterMs: 20,
          subscriberPacketLossPct: 0.3,
        },
      },
      {
        runKey: 'session-3::run-3::2026-04-17T08:30:00.000Z',
        recordedAt: '2026-04-17T08:30:04.000Z',
        sessionId: 'session-3',
        runId: 'run-3',
        activeRunStartedAt: '2026-04-17T08:30:00.000Z',
        metrics: {
          sessionReadyMs: 320,
          joinLatencyMs: 210,
          requestStartToFirstTextMs: 250,
          bindToPlaybackStartMs: 180,
          subscriberRoundTripTimeMs: 135,
          subscriberJitterMs: 19,
          subscriberPacketLossPct: 0.4,
        },
      },
      {
        runKey: 'session-4::run-4::2026-04-17T08:40:00.000Z',
        recordedAt: '2026-04-17T08:40:04.000Z',
        sessionId: 'session-4',
        runId: 'run-4',
        activeRunStartedAt: '2026-04-17T08:40:00.000Z',
        metrics: {
          sessionReadyMs: 350,
          joinLatencyMs: 235,
          requestStartToFirstTextMs: 255,
          bindToPlaybackStartMs: 205,
          subscriberRoundTripTimeMs: 145,
          subscriberJitterMs: 21,
          subscriberPacketLossPct: 0.3,
        },
      },
      {
        runKey: 'session-dev::run-dev::2026-04-17T09:00:00.000Z',
        recordedAt: '2026-04-17T08:50:04.000Z',
        sessionId: 'session-dev',
        runId: 'run-dev',
        activeRunStartedAt: '2026-04-17T09:00:00.000Z',
        metrics: {
          sessionReadyMs: 9999,
          joinLatencyMs: 9999,
          requestStartToFirstTextMs: 9999,
          bindToPlaybackStartMs: 9999,
          subscriberRoundTripTimeMs: 999,
          subscriberJitterMs: 99,
          subscriberPacketLossPct: 9.9,
        },
      },
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'thinking',
      events,
      snapshot: buildSnapshot({
        webrtc: {
          activeCallId: 'call-dev',
          voiceAgentSessionId: 'voice-agent-dev',
          datacenter: 'iad',
          sampleCount: 4,
          firstSampleAt: '2026-04-17T09:00:01.100Z',
          lastSampleAt: '2026-04-17T09:00:03.100Z',
          recentSamples: [],
          publisher: {
            sampleCount: 4,
            lastRecordedAt: '2026-04-17T09:00:03.100Z',
            averageRoundTripTimeMs: 150,
            lastRoundTripTimeMs: 145,
            maxRoundTripTimeMs: 180,
            lastJitterMs: 18,
            averageJitterMs: 17,
            maxJitterMs: 22,
            lastPacketLossPct: 0.4,
            averagePacketLossPct: 0.5,
            maxPacketLossPct: 0.7,
            lastPacketsLost: 2,
            lastPacketsReceived: 420,
            totalBytesSent: 1010000,
            totalBytesReceived: 130000,
            codec: 'opus',
          },
          subscriber: {
            sampleCount: 4,
            lastRecordedAt: '2026-04-17T09:00:03.100Z',
            averageRoundTripTimeMs: 420,
            lastRoundTripTimeMs: 390,
            maxRoundTripTimeMs: 500,
            lastJitterMs: 39,
            averageJitterMs: 36,
            maxJitterMs: 44,
            lastPacketLossPct: 1.8,
            averagePacketLossPct: 1.6,
            maxPacketLossPct: 2.1,
            lastPacketsLost: 12,
            lastPacketsReceived: 510,
            totalBytesSent: 0,
            totalBytesReceived: 1740000,
            codec: 'opus',
          },
        },
      }),
      baselineEntries,
      nowMs: Date.parse('2026-04-17T09:00:03.300Z'),
    });
    const summary = buildVoiceTelemetrySummary(metrics);

    expect(metrics.baseline.sampleSize).toBe(4);
    expect(metrics.baseline.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'session-ready', level: 'bad' }),
        expect.objectContaining({ key: 'backend-first-text', level: 'bad' }),
        expect.objectContaining({ key: 'transport-rtt', level: 'bad' }),
      ]),
    );
    expect(summary.baselineSampleSize).toBe(4);
    expect(summary.baselineRegressionKeys).toEqual(
      expect.arrayContaining(['session-ready', 'backend-first-text', 'transport-rtt']),
    );
    expect(metrics.baseline.runKey).toBe('session-dev::run-dev::2026-04-17T09:00:00.000Z');
  });

  it('nulls mic -> transcript when the user idles past the sanity ceiling before the first utterance', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-21T04:39:46.696Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-idle' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-21T04:39:48.011Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.12 },
      }),
      // User sits silent for ~22 s before actually speaking.
      buildEvent({
        seq: 3,
        at: '2026-04-21T04:40:09.907Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'ok now I am ready' } },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-21T04:40:10.200Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-21T04:40:10.500Z'),
    });

    // Raw gap is ~21.9 s; sanity ceiling (5000 ms) nulls it so the hotspot
    // does not flash "bad" on a healthy-but-idle session.
    expect(metrics.pipeline.micToUserTranscriptMs).toBeNull();
    expect(metrics.startup.startToFirstUserTranscriptMs).toBeGreaterThan(20000);
  });

  it('uses the previous agent_ended as the mic -> transcript anchor for turns beyond the first', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-turns' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.100Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.2 },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.400Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'hi' } },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:01.000Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_ended' } },
      }),
      // User waits 8 s after Sophia finishes, then speaks — session-wide
      // mic -> transcript would balloon, but per-turn anchor resets.
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:09.200Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'thanks for that' } },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:09.500Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:10.000Z'),
    });

    // Per-turn anchor: last agent_ended (12:00:01.000) -> last user transcript
    // (12:00:09.200) = 8200 ms, which exceeds the sanity ceiling and is nulled.
    expect(metrics.pipeline.micToUserTranscriptMs).toBeNull();
  });

  it('reports a realistic per-turn mic -> transcript when the user responds promptly', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-prompt' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.100Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.2 },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.400Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'hi' } },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:01.000Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'agent_ended' } },
      }),
      // User speaks 1.8 s after Sophia finishes — a realistic responsive gap.
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:02.800Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'thanks for that' } },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:03.100Z',
        category: 'voice-sse',
        name: 'sophia.turn',
        payload: { data: { phase: 'user_ended' } },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:03.500Z'),
    });

    // Per-turn anchor: last agent_ended -> last user transcript = 1800 ms.
    expect(metrics.pipeline.micToUserTranscriptMs).toBe(1800);
  });
});