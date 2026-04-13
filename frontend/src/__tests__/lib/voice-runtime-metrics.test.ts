import { describe, expect, it } from 'vitest';

import type { SophiaCaptureSnapshot } from '../../app/lib/session-capture';
import {
  buildVoiceDeveloperMetrics,
  type VoiceCaptureEvent,
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
}: {
  detectedAudio?: boolean;
  error?: string | null;
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
    expect(metrics.pipeline.requestStartToFirstBackendEventMs).toBe(150);
    expect(metrics.pipeline.firstBackendEventToFirstTextMs).toBe(400);
    expect(metrics.pipeline.requestStartToFirstTextMs).toBe(550);
    expect(metrics.pipeline.textToFirstAudioMs).toBe(200);
    expect(metrics.bottleneck.kind).toBe('healthy');
    expect(metrics.thresholds.firstAudio.status).toBe('good');
    expect(metrics.regressions).toHaveLength(0);
    expect(metrics.timeline.at(-1)?.label).toBe('Turn diagnostic');
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
});