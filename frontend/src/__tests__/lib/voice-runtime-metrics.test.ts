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
  sessionArtifacts = null,
  artifactDom = {},
}: {
  detectedAudio?: boolean;
  error?: string | null;
  sessionArtifacts?: SophiaCaptureSnapshot['artifacts']['sessionArtifacts'];
  artifactDom?: Partial<SophiaCaptureSnapshot['artifacts']['dom']>;
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
      sessionArtifacts,
      recapArtifacts: null,
      recapCommitStatus: null,
      dom: {
        railLabel: artifactDom.railLabel ?? null,
        takeawayText: artifactDom.takeawayText ?? null,
        reflectionText: artifactDom.reflectionText ?? null,
        memoriesText: artifactDom.memoriesText ?? null,
        panelVisible: artifactDom.panelVisible ?? false,
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
    expect(metrics.recentTurns[0]?.committedTurnCloseMs).toBe(300);
    expect(metrics.recentTurns[0]?.committedTranscriptToAgentStartMs).toBe(700);
    expect(metrics.recentTurns[0]?.requestStartToFirstBackendEventMs).toBe(150);
    expect(metrics.bottleneck.kind).toBe('healthy');
    expect(metrics.thresholds.firstAudio.status).toBe('good');
    expect(metrics.regressions).toHaveLength(0);
    expect(metrics.timeline.at(-1)?.label).toBe('Turn diagnostic');
    expect(metrics.sessionTelemetry.runtime).toBe('legacy_cascade');
    expect(metrics.sessionTelemetry.runtimeLabel).toBe('Legacy Cascade');
    expect(metrics.sessionTelemetry.legacy?.joinLatencyMs).toBe(300);
    expect(metrics.sessionTelemetry.gemini).toBeNull();
  });

  it('summarizes Gemini Live production telemetry without legacy join assumptions', () => {
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
        at: '2026-04-07T12:00:00.100Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: {
          callId: 'gemini-session-dev',
          callType: 'gemini_live',
          runtime: 'gemini_live',
          sessionId: 'session-dev',
          streamUrl: '/voice/gemini/stream/gemini-session-dev',
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.160Z',
        category: 'voice-session',
        name: 'gemini-stage-changed',
        payload: {
          runtime: 'gemini_live',
          stage: 'connected',
          connectionState: 'connected',
          websocketState: 'connected',
          microphoneState: 'connected',
          remoteAudioState: 'expected',
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:00.200Z',
        category: 'voice-session',
        name: 'gemini-provider-event',
        payload: {
          runtime: 'gemini_live',
          eventType: 'setupComplete',
          setupComplete: true,
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:00.220Z',
        category: 'voice-session',
        name: 'gemini-relay-status',
        payload: { runtime: 'gemini_live', relayStatus: 'active', voiceAgentSessionId: 'gemini-session-dev' },
      }),
      buildEvent({
        seq: 51,
        at: '2026-04-07T12:00:00.225Z',
        category: 'voice-session',
        name: 'gemini-provider-event-correlation',
        payload: {
          runtime: 'gemini_live',
          telemetry: {
            timestamp: '2026-04-07T12:00:00.225Z',
            correlationId: 'artifact-call-1',
            primaryCategory: 'toolCall',
            categories: ['toolCall'],
            categoryCounts: {
              toolCall: { count: 1, lastAt: '2026-04-07T12:00:00.225Z' },
              outputTranscription: { count: 1, lastAt: '2026-04-07T12:00:00.200Z' },
            },
          },
        },
      }),
      buildEvent({
        seq: 52,
        at: '2026-04-07T12:00:00.230Z',
        category: 'voice-session',
        name: 'gemini-relay-trace',
        payload: {
          runtime: 'gemini_live',
          trace: {
            timestamp: '2026-04-07T12:00:00.230Z',
            correlationId: 'artifact-call-1',
            eventCategory: 'toolCall',
            attemptCount: 2,
            successCount: 2,
            failureCount: 0,
            success: true,
            statusCode: 202,
            responseKind: 'client_actions_and_tool_diagnostics',
            durationMs: 18,
          },
        },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:00.250Z',
        category: 'voice-session',
        name: 'sophia-ready',
        payload: { reason: 'gemini-live-setup-complete', runtime: 'gemini_live', voiceAgentSessionId: 'gemini-session-dev' },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-07T12:00:00.300Z',
        category: 'voice-sse',
        name: 'stream-open',
        payload: {
          runtime: 'gemini_live',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'gemini-session-dev',
          streamUrl: '/voice/gemini/stream/gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-07T12:00:00.320Z',
        category: 'voice-session',
        name: 'gemini-relay-diagnostic',
        payload: {
          runtime: 'gemini_live',
          diagnostic: {
            timestamp: '2026-04-07T12:00:00.320Z',
            eventType: 'serverContent',
            consecutiveFailures: 0,
            errorText: '',
          },
        },
      }),
      buildEvent({
        seq: 9,
        at: '2026-04-07T12:00:00.340Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          runtime: 'gemini_live',
          phase: 'tool_call_received',
          toolName: 'emit_artifact',
          diagnostic: {
            timestamp: '2026-04-07T12:00:00.340Z',
            phase: 'tool_call_received',
            toolCall: { name: 'emit_artifact' },
          },
        },
      }),
      buildEvent({
        seq: 10,
        at: '2026-04-07T12:00:00.360Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          runtime: 'gemini_live',
          phase: 'tool_response_sent',
          toolName: 'emit_artifact',
          diagnostic: {
            timestamp: '2026-04-07T12:00:00.360Z',
            phase: 'tool_response_sent',
            toolCall: { name: 'emit_artifact' },
          },
        },
      }),
      buildEvent({
        seq: 100,
        at: '2026-04-07T12:00:00.370Z',
        category: 'voice-session',
        name: 'gemini-tool-call-ledger',
        payload: {
          runtime: 'gemini_live',
          entry: {
            toolCallId: 'artifact-call-1',
            toolName: 'emit_artifact',
            receivedAt: '2026-04-07T12:00:00.340Z',
            relayStartedAt: '2026-04-07T12:00:00.345Z',
            relayCompletedAt: '2026-04-07T12:00:00.360Z',
            toolResponseSentAt: '2026-04-07T12:00:00.370Z',
            finalState: 'responded',
          },
        },
      }),
      buildEvent({
        seq: 101,
        at: '2026-04-07T12:00:00.380Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          runtime: 'gemini_live',
          phase: 'tool_call_cancelled',
          diagnostic: {
            timestamp: '2026-04-07T12:00:00.380Z',
            phase: 'tool_call_cancelled',
            toolCall: { id: 'cancelled-call-1', name: null },
          },
        },
      }),
      buildEvent({
        seq: 102,
        at: '2026-04-07T12:00:00.420Z',
        category: 'voice-session',
        name: 'gemini-interruption',
        payload: {
          runtime: 'gemini_live',
          diagnostic: {
            timestamp: '2026-04-07T12:00:00.420Z',
            reason: 'server_interrupted',
            playbackFlushed: true,
          },
        },
      }),
      buildEvent({
        seq: 11,
        at: '2026-04-07T12:00:00.500Z',
        category: 'voice-session',
        name: 'gemini-output-audio-started',
        payload: { runtime: 'gemini_live', voiceAgentSessionId: 'gemini-session-dev' },
      }),
      buildEvent({
        seq: 12,
        at: '2026-04-07T12:00:00.700Z',
        category: 'voice-sse',
        name: 'sophia.user_transcript',
        payload: { data: { text: 'hello Sophia' } },
      }),
      buildEvent({
        seq: 13,
        at: '2026-04-07T12:00:00.900Z',
        category: 'voice-sse',
        name: 'sophia.transcript',
        payload: { data: { text: 'I am here.', is_final: true } },
      }),
      buildEvent({
        seq: 14,
        at: '2026-04-07T12:00:01.000Z',
        category: 'voice-sse',
        name: 'sophia.artifact',
        payload: { data: { takeaway: 'Gemini path.' } },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:01.500Z'),
    });

    expect(metrics.sessionTelemetry.runtime).toBe('gemini_live');
    expect(metrics.sessionTelemetry.runtimeLabel).toBe('Gemini Live');
    expect(metrics.sessionTelemetry.legacy).toBeNull();
    expect(metrics.timings.joinLatencyMs).toBeNull();
    expect(metrics.timings.sessionReadyMs).toBe(250);
    expect(metrics.timings.sseOpenMs).toBe(200);
    expect(metrics.sessionTelemetry.gemini?.publicSseState).toBe('connected');
    expect(metrics.sessionTelemetry.gemini?.websocketState).toBe('connected');
    expect(metrics.sessionTelemetry.gemini?.relayStatus).toBe('active');
    expect(metrics.sessionTelemetry.gemini?.setupComplete).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.providerEventCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.providerCategoryCounts.toolCall.count).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.relayDiagnosticCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.relayTraceCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.relayAttemptCount).toBe(2);
    expect(metrics.sessionTelemetry.gemini?.relaySuccessCount).toBe(2);
    expect(metrics.sessionTelemetry.gemini?.lastRelayResponseKind).toBe('client_actions_and_tool_diagnostics');
    expect(metrics.sessionTelemetry.gemini?.lastRelayDurationMs).toBe(18);
    expect(metrics.sessionTelemetry.gemini?.toolCallCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.toolResponseCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.toolRejectionCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.toolCancellationCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.toolCallLedger).toEqual([
      expect.objectContaining({ toolCallId: 'artifact-call-1', finalState: 'responded' }),
    ]);
    expect(metrics.sessionTelemetry.gemini?.artifactToolCallCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.builderToolCallCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.outputAudioEventCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.interruptionCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.playbackFlushCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactPublicEventCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactRuntimeIngestCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.artifactRenderedCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.artifactCountSource).toBe('public_event');
  });

  it('summarizes voice preconnect hit telemetry', () => {
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
        at: '2026-04-07T12:00:00.020Z',
        category: 'voice-session',
        name: 'preconnect-reused',
        payload: {
          runtime: 'gemini_live',
          preconnectStatus: 'hit',
          preconnectAgeMs: 420,
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.030Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: {
          callId: 'gemini-session-dev',
          callType: 'gemini_live',
          runtime: 'gemini_live',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'connecting',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:00.050Z'),
    });

    expect(metrics.startup.preconnectAttempted).toBe(true);
    expect(metrics.startup.preconnectStatus).toBe('hit');
    expect(metrics.startup.preconnectAgeMs).toBe(420);
    expect(metrics.startup.requestToCredentialsMs).toBe(30);
  });

  it('reports skipped active-session preconnect without marking it as a failed warmup', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'preconnect-skipped',
        payload: {
          runtime: 'gemini_live',
          preconnectStatus: 'skipped',
          preconnectSkippedReason: 'already_active',
          activeVoiceSessionExists: true,
          sessionId: 'session-dev',
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'idle',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:00.050Z'),
    });

    expect(metrics.startup.preconnectAttempted).toBe(true);
    expect(metrics.startup.preconnectStatus).toBe('skipped');
    expect(metrics.startup.preconnectSkippedReason).toBe('already_active');
    expect(metrics.startup.activeVoiceSessionExists).toBe(true);
  });

  it('keeps Gemini runtime telemetry from capture after the hook returns to idle default legacy state', () => {
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
        at: '2026-04-07T12:00:00.100Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: {
          callId: 'gemini-session-dev',
          callType: 'gemini_live',
          runtime: 'gemini_live',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.200Z',
        category: 'voice-session',
        name: 'gemini-provider-event',
        payload: {
          runtime: 'gemini_live',
          eventType: 'setupComplete',
          setupComplete: true,
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:00.400Z',
        category: 'voice-sse',
        name: 'sophia.transcript',
        payload: {
          runtime: 'gemini_live',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'gemini-session-dev',
          data: {
            text: 'I remember your name is Luis.',
            is_final: true,
            assistant_transcript_source: 'provider_output_transcription',
            assistant_transcript_approximate: true,
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'idle',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:02.000Z'),
      runtimeTelemetry: {
        runtime: 'legacy_cascade',
        source: 'default',
        sessionId: 'session-dev',
        threadId: 'thread-dev',
        callId: null,
        voiceAgentSessionId: null,
        streamUrl: null,
      },
    });

    expect(metrics.sessionTelemetry.runtime).toBe('gemini_live');
    expect(metrics.sessionTelemetry.source).toBe('capture');
    expect(metrics.sessionTelemetry.gemini).not.toBeNull();
    expect(metrics.sessionTelemetry.gemini?.assistantTranscriptSource).toBe('provider_output_transcription');
    expect(metrics.sessionTelemetry.gemini?.assistantTranscriptFinalSeen).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.assistantTranscriptApproximate).toBe(true);
    expect(metrics.counts.assistantTranscripts).toBe(1);
  });

  it('summarizes Gemini stale-output suppression and unresolved tool diagnostics', () => {
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
        at: '2026-04-07T12:00:00.100Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: { runtime: 'gemini_live', callType: 'gemini_live', voiceAgentSessionId: 'gemini-session-dev' },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:01.000Z',
        category: 'voice-session',
        name: 'gemini-interruption',
        payload: {
          diagnostic: {
            timestamp: '2026-04-07T12:00:01.000Z',
            playbackFlushed: true,
            playbackGeneration: 4,
            assistantUserOverlapMs: 2450,
            rawAssistantUserOverlapMs: 2450,
            confirmedAssistantUserOverlapMs: 2450,
            bargeInConfirmationSource: 'provider_interruption',
            bargeInConfirmationReason: 'gemini_server_interrupted_event',
            interruptedResponseIds: ['response-stale'],
          },
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:01.100Z',
        category: 'voice-session',
        name: 'gemini-stale-output-suppressed',
        payload: {
          diagnostic: {
            outputType: 'audio',
            reason: 'interrupted_response_id',
            playbackGeneration: 4,
            interruptedResponseIds: ['response-stale'],
            userInputActiveAgeMs: 350,
            bargeInConfirmed: true,
            bargeInConfirmationSource: 'provider_interruption',
            bargeInConfirmationReason: 'gemini_server_interrupted_event',
            bargeInCandidateFrameCount: 4,
            staleSuppressionArmedAt: '2026-04-07T12:00:01.000Z',
            staleSuppressionArmedBy: 'provider_interruption',
            assistantAudioDropReason: 'interrupted_response_id',
            inputFrameOnlyNotBargeInCount: 1,
            candidateFramesDidNotConfirmCount: 1,
            candidateExpiredCount: 0,
            suppressionBlockedBecauseNoIntentCount: 0,
            rawAssistantUserOverlapMs: 2450,
            confirmedAssistantUserOverlapMs: 2450,
          },
        },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:01.150Z',
        category: 'voice-session',
        name: 'gemini-input-audio-activity',
        payload: {
          diagnostic: {
            eventType: 'input_audio_frame_sent',
            suppressionDeferredReason: 'input_frame_only_not_barge_in',
            bargeInConfirmed: false,
            bargeInCandidateFrameCount: 1,
            inputFrameOnlyNotBargeInCount: 1,
          },
        },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:01.180Z',
        category: 'voice-session',
        name: 'gemini-barge-in-transcript-handoff',
        payload: {
          diagnostic: {
            transcriptPreview: 'Actually pause there',
            captured: true,
            promoted: true,
            ignored: false,
            duplicateSuppressed: false,
            promotionLatencyMs: 90,
            newTurnDispatched: true,
            newTurnDispatchBlockedReason: 'none',
            bargeInTranscriptCapturedCount: 1,
            bargeInTranscriptPromotedCount: 1,
            bargeInTranscriptPromotionLatencyMs: 90,
            bargeInTranscriptIgnoredCount: 0,
            bargeInTranscriptDuplicateSuppressedCount: 0,
            lastBargeInTranscriptPreview: 'Actually pause there',
            bargeInNewTurnDispatchCount: 1,
            bargeInNewTurnDispatchBlockedReason: 'none',
          },
        },
      }),
      buildEvent({
        seq: 7,
        at: '2026-04-07T12:00:01.200Z',
        category: 'voice-session',
        name: 'stale-assistant-transcript-ignored',
        payload: { reason: 'interrupted_or_pre_barge_in_assistant_transcript' },
      }),
      buildEvent({
        seq: 8,
        at: '2026-04-07T12:00:01.300Z',
        category: 'voice-session',
        name: 'gemini-tool-call-ledger',
        payload: {
          entry: {
            toolCallId: 'artifact-call-unknown',
            toolName: 'emit_artifact',
            receivedAt: '2026-04-07T12:00:00.300Z',
            finalState: 'unknown',
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:05.300Z'),
    });

    expect(metrics.sessionTelemetry.runtime).toBe('gemini_live');
    expect(metrics.sessionTelemetry.gemini?.staleAssistantAudioDroppedCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.staleAssistantTranscriptDroppedCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.staleAssistantOutputSuppressionCount).toBe(2);
    expect(metrics.sessionTelemetry.gemini?.playbackGeneration).toBe(4);
    expect(metrics.sessionTelemetry.gemini?.maxAssistantUserOverlapMs).toBe(2450);
    expect(metrics.sessionTelemetry.gemini?.maxRawAssistantUserOverlapMs).toBe(2450);
    expect(metrics.sessionTelemetry.gemini?.maxConfirmedAssistantUserOverlapMs).toBe(2450);
    expect(metrics.sessionTelemetry.gemini?.bargeInConfirmed).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.bargeInConfirmationSource).toBe('provider_interruption');
    expect(metrics.sessionTelemetry.gemini?.bargeInCandidateFrameCount).toBe(4);
    expect(metrics.sessionTelemetry.gemini?.inputFrameOnlyNotBargeInCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.candidateFramesDidNotConfirmCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.suppressionBlockedBecauseNoIntentCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.bargeInTranscriptCapturedCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.bargeInTranscriptPromotedCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.bargeInTranscriptPromotionLatencyMs).toBe(90);
    expect(metrics.sessionTelemetry.gemini?.bargeInTranscriptIgnoredCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.bargeInTranscriptDuplicateSuppressedCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.lastBargeInTranscriptPreview).toBe('Actually pause there');
    expect(metrics.sessionTelemetry.gemini?.bargeInNewTurnDispatchCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.bargeInNewTurnDispatchBlockedReason).toBe('none');
    expect(metrics.sessionTelemetry.gemini?.staleSuppressionArmedAt).toBe('2026-04-07T12:00:01.000Z');
    expect(metrics.sessionTelemetry.gemini?.staleSuppressionArmedBy).toBe('provider_interruption');
    expect(metrics.sessionTelemetry.gemini?.assistantAudioDropReason).toBe('interrupted_response_id');
    expect(metrics.sessionTelemetry.gemini?.interruptedResponseIds).toEqual(['response-stale']);
    expect(metrics.sessionTelemetry.gemini?.unresolvedToolCallCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactToolCallUnknownCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.oldestUnresolvedToolCallAgeMs).toBe(5000);
  });

  it('separates raw assistant-user overlap from confirmed barge-in overlap', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev', runtime: 'gemini_live' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.500Z',
        category: 'voice-session',
        name: 'gemini-input-audio-activity',
        payload: {
          diagnostic: {
            eventType: 'input_audio_frame_sent',
            userInputActiveAgeMs: 2100,
            bargeInConfirmed: false,
            bargeInConfirmationSource: 'none',
            bargeInCandidateFrameCount: 12,
            inputFrameOnlyNotBargeInCount: 12,
            candidateFramesDidNotConfirmCount: 12,
            suppressionBlockedBecauseNoIntentCount: 3,
            rawAssistantUserOverlapMs: 2450,
            confirmedAssistantUserOverlapMs: 0,
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'speaking',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:03.000Z'),
    });

    expect(metrics.sessionTelemetry.runtime).toBe('gemini_live');
    expect(metrics.sessionTelemetry.gemini?.maxRawAssistantUserOverlapMs).toBe(2450);
    expect(metrics.sessionTelemetry.gemini?.maxConfirmedAssistantUserOverlapMs).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.bargeInConfirmed).toBe(false);
    expect(metrics.sessionTelemetry.gemini?.bargeInConfirmationSource).toBe('none');
    expect(metrics.sessionTelemetry.gemini?.suppressionBlockedBecauseNoIntentCount).toBe(3);
  });

  it('counts rendered session artifacts when the public artifact event is absent from the active slice', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev', runtime: 'gemini_live' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.800Z',
        category: 'artifacts-runtime',
        name: 'ingest-artifacts',
        payload: {
          sessionId: 'session-dev',
          source: 'voice',
          incoming: {
            takeaway: 'Rendered artifact reached the UI.',
            reflection_candidate: { prompt: 'What changed after it landed?' },
          },
          merged: {
            takeaway: 'Rendered artifact reached the UI.',
            reflection_candidate: { prompt: 'What changed after it landed?' },
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot({
        sessionArtifacts: {
          takeaway: 'Rendered artifact reached the UI.',
          reflection_candidate: { prompt: 'What changed after it landed?' },
        },
      }),
      nowMs: Date.parse('2026-04-07T12:00:01.500Z'),
    });

    expect(metrics.counts.artifacts).toBe(1);
    expect(metrics.counts.artifactPublicEventCount).toBe(0);
    expect(metrics.counts.artifactRuntimeIngestCount).toBe(1);
    expect(metrics.counts.artifactRenderedCount).toBe(1);
    expect(metrics.counts.artifactCountSource).toBe('runtime_ingest');
    expect(metrics.counts.artifactCountMismatch).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.artifactCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactPublicEventCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.artifactRuntimeIngestCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactRenderedCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactCountMismatch).toBe(true);
  });

  it('does not count emit_artifact tool calls as artifacts without validated artifact evidence', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev', runtime: 'gemini_live' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.400Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          data: {
            phase: 'tool_call_received',
            diagnostic: {
              toolCall: { id: 'artifact-call-1', name: 'emit_artifact' },
            },
          },
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.700Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          data: {
            phase: 'tool_response_sent',
            diagnostic: {
              toolCall: { id: 'artifact-call-1', name: 'emit_artifact' },
            },
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:01.500Z'),
    });

    expect(metrics.sessionTelemetry.gemini?.artifactToolCallCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.toolResponseCount).toBe(1);
    expect(metrics.counts.artifacts).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.artifactCount).toBe(0);
    expect(metrics.counts.artifactCountSource).toBe('none');
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

  it('flags Gemini provider transcripts that never surface as public user transcripts', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-05-20T04:43:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { platform: 'voice', sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-05-20T04:43:00.100Z',
        category: 'voice-session',
        name: 'credentials-received',
        payload: {
          callId: 'gemini-session-dev',
          callType: 'gemini_live',
          runtime: 'gemini_live',
          sessionId: 'session-dev',
          voiceAgentSessionId: 'gemini-session-dev',
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-05-20T04:43:00.400Z',
        category: 'voice-sse',
        name: 'stream-open',
        payload: { runtime: 'gemini_live', voiceAgentSessionId: 'gemini-session-dev' },
      }),
      buildEvent({
        seq: 4,
        at: '2026-05-20T04:43:01.000Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.072 },
      }),
      buildEvent({
        seq: 5,
        at: '2026-05-20T04:43:01.200Z',
        category: 'voice-session',
        name: 'gemini-provider-event-correlation',
        payload: {
          runtime: 'gemini_live',
          telemetry: {
            timestamp: '2026-05-20T04:43:01.200Z',
            primaryCategory: 'inputTranscription',
            categories: ['inputTranscription'],
            categoryCounts: {
              inputTranscription: { count: 12, lastAt: '2026-05-20T04:43:01.200Z' },
            },
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-20T04:43:02.000Z'),
    });

    expect(metrics.counts.userTranscripts).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.providerCategoryCounts.inputTranscription.count).toBe(12);
    expect(metrics.health.title).toBe('Provider transcript not surfaced');
    expect(metrics.bottleneck.kind).toBe('transport');
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'public-continuity', level: 'warn' }),
      ]),
    );
    expect(metrics.regressions.some((marker) => marker.key === 'microphone')).toBe(false);
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
});
