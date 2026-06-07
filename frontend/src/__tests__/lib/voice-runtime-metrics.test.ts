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
    expect(metrics.sessionTelemetry.gemini?.reviewVoiceReady).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.reviewPublicTranscriptObserved).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.publicUserTranscriptCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.providerToPublicTranscriptGap).toBe(0);
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

  it('warns when mic audio is detected but Gemini has not produced input transcription', () => {
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
        name: 'gemini-stage-changed',
        payload: {
          runtime: 'gemini_live',
          stage: 'streaming_audio',
          connectionState: 'connected',
          websocketState: 'connected',
          microphoneState: 'connected',
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:00.300Z',
        category: 'harness-input',
        name: 'microphone-audio-detected',
        payload: { rms: 0.07 },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot({ detectedAudio: true }),
      nowMs: Date.parse('2026-04-07T12:00:01.000Z'),
    });

    expect(metrics.health.title).toBe('Audio detected, transcript missing');
    expect(metrics.sessionTelemetry.gemini?.reviewVoiceReady).toBe(false);
    expect(metrics.sessionTelemetry.gemini?.reviewMicAudioDetected).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.reviewUserSpeechDetected).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.reviewProviderTranscriptObserved).toBe(false);
    expect(metrics.sessionTelemetry.gemini?.reviewTranscriptPromotionBlockedReason).toBe('voice_input_detected_waiting_for_transcript');
  });

  it('warns when provider input transcription is not surfaced publicly', () => {
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
        name: 'gemini-stage-changed',
        payload: {
          runtime: 'gemini_live',
          stage: 'streaming_audio',
          connectionState: 'connected',
          websocketState: 'connected',
          microphoneState: 'connected',
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:00.400Z',
        category: 'voice-session',
        name: 'gemini-provider-event-correlation',
        payload: {
          runtime: 'gemini_live',
          telemetry: {
            timestamp: '2026-04-07T12:00:00.400Z',
            hasInputTranscriptionText: true,
            categoryCounts: {
              inputTranscription: { count: 1, lastAt: '2026-04-07T12:00:00.400Z' },
            },
          },
        },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:00.420Z',
        category: 'voice-session',
        name: 'coreview-state',
        payload: {
          coreview: {
            coreviewEnabled: true,
            coreviewSessionActive: true,
            coreviewArtifactId: 'artifact-1',
            frameSentCount: 1,
            initialFrameSent: true,
            visualFresh: true,
            visualFreshForTurn: true,
            rawFrameExcluded: true,
            rawProviderPayloadExcluded: true,
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot({ detectedAudio: true }),
      nowMs: Date.parse('2026-04-07T12:00:01.000Z'),
    });

    expect(metrics.health.title).toBe('Provider transcript not surfaced');
    expect(metrics.sessionTelemetry.gemini?.reviewVoiceReady).toBe(false);
    expect(metrics.sessionTelemetry.gemini?.reviewProviderTranscriptObserved).toBe(true);
    expect(metrics.sessionTelemetry.gemini?.reviewPublicTranscriptObserved).toBe(false);
    expect(metrics.sessionTelemetry.gemini?.reviewTranscriptPromotionBlockedReason).toBe('provider_transcript_not_surfaced');
    expect(metrics.sessionTelemetry.gemini?.providerInputTranscriptCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.publicUserTranscriptCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.providerToPublicTranscriptGap).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.firstProviderTranscriptAt).toBe('2026-04-07T12:00:00.400Z');
    expect(metrics.sessionTelemetry.gemini?.firstPublicUserTranscriptAt).toBeNull();
    expect(metrics.sessionTelemetry.gemini?.transcriptPromotionLatencyMs).toBeNull();
    expect(metrics.coreview.visual.initialFrameSent).toBe(true);
    expect(metrics.coreview.visual.frameSentCount).toBe(1);
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
    expect(metrics.counts.artifactSelectedStageCount).toBe(0);
    expect(metrics.counts.artifactRenderedCount).toBe(1);
    expect(metrics.counts.artifactCountSource).toBe('runtime_ingest');
    expect(metrics.counts.artifactCountMismatch).toBe(true);
    expect(metrics.counts.artifactCountMismatchReason).toBe('runtime_ingest_not_public_event');
    expect(metrics.sessionTelemetry.gemini?.artifactCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactPublicEventCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.artifactRuntimeIngestCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactSelectedStageCount).toBe(0);
    expect(metrics.sessionTelemetry.gemini?.artifactRenderedCount).toBe(1);
    expect(metrics.sessionTelemetry.gemini?.artifactCountMismatch).toBe(true);
  });

  it('counts selected stage artifacts as safe runtime ingest evidence', () => {
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
        name: 'select-stage-artifact',
        payload: {
          sessionId: 'session-dev',
          threadId: 'thread-dev',
          artifactId: 'coreview-real-artifact-launch-brief',
          artifactPath: 'mnt/user-data/outputs/launch-brief.md',
          artifactTitle: 'Launch brief',
          artifactStableIdentity: 'user:unknown|thread:thread-dev|path:mnt/user-data/outputs/launch-brief.md|renderer:markdown',
          artifactRebindAttempted: true,
          artifactRebindResult: 'success',
          artifactRebindReason: 'voice_connect_visible_artifact',
          artifactReboundFromRenderedState: true,
          artifactRebindSource: 'voice_connect',
          exactTextRehydrated: true,
          exactTextRehydrateResult: 'not_pdf_exact_text_available',
          currentRunSelectedStageEvents: 1,
          longLivedSelectedStageState: true,
          telemetryScopeMode: 'current_run_rebind',
          exactTextSource: 'builder_file',
          exactTextAvailable: true,
          rawArtifactTextExcluded: true,
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.900Z',
        category: 'artifacts-runtime',
        name: 'select-stage-artifact',
        payload: {
          sessionId: 'session-dev',
          threadId: 'thread-dev',
          artifactId: 'coreview-real-artifact-launch-brief',
          artifactPath: 'mnt/user-data/outputs/launch-brief.md',
          artifactTitle: 'Launch brief',
          exactTextSource: 'builder_file',
          exactTextAvailable: true,
          rawArtifactTextExcluded: true,
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot({
        artifactDom: { panelVisible: true, takeawayText: 'Visible rendered text.' },
      }),
      nowMs: Date.parse('2026-04-07T12:00:01.500Z'),
    });

    expect(metrics.counts.artifacts).toBe(1);
    expect(metrics.counts.artifactPublicEventCount).toBe(0);
    expect(metrics.counts.artifactRuntimeIngestCount).toBe(1);
    expect(metrics.counts.artifactSelectedStageCount).toBe(1);
    expect(metrics.counts.artifactRenderedCount).toBe(1);
    expect(metrics.counts.artifactCountSource).toBe('selected_stage_artifact');
    expect(metrics.counts.artifactCountMismatchReason).toBe('selected_stage_artifact_not_public_event');
    expect(metrics.sessionTelemetry.gemini?.artifactSelectedStageCount).toBe(1);
    expect(metrics.coreview.visual.coreviewEnabled).toBe(false);
    expect(metrics.coreview.visual.coreviewSessionActive).toBe(false);
    expect(metrics.coreview.visual.coreviewArtifactId).toBe('coreview-real-artifact-launch-brief');
    expect(metrics.coreview.visual.artifactStableIdentity).toBe(
      'user:unknown|thread:thread-dev|path:mnt/user-data/outputs/launch-brief.md|renderer:markdown',
    );
    expect(metrics.coreview.visual.artifactRebindAttempted).toBe(true);
    expect(metrics.coreview.visual.artifactRebindResult).toBe('success');
    expect(metrics.coreview.visual.artifactRebindReason).toBe('voice_connect_visible_artifact');
    expect(metrics.coreview.visual.artifactReboundFromRenderedState).toBe(true);
    expect(metrics.coreview.visual.artifactRebindSource).toBe('voice_connect');
    expect(metrics.coreview.visual.exactTextRehydrated).toBe(true);
    expect(metrics.coreview.visual.exactTextRehydrateResult).toBe('not_pdf_exact_text_available');
    expect(metrics.coreview.visual.currentRunSelectedStageEvents).toBe(2);
    expect(metrics.coreview.visual.longLivedSelectedStageState).toBe(true);
    expect(metrics.coreview.visual.telemetryScopeMode).toBe('current_run_rebind');
    expect(metrics.coreview.visual.frameSentCount).toBe(0);
    expect(metrics.coreview.visual.exactTextAvailable).toBe(true);
  });

  it('summarizes HTML capture target registration and retry telemetry safely', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'artifacts-runtime',
        name: 'capture_target_registered',
        payload: {
          artifactId: 'coreview-real-artifact-landing-html',
          rendererKind: 'html',
          htmlCaptureTargetRegistered: true,
          htmlCaptureTargetRegistrationResult: 'registered',
          htmlCaptureTargetArtifactPathHash: 'pathhash123',
          htmlCaptureTargetStableIdentityHash: 'stablehash456',
          htmlCaptureTargetVersionAware: true,
          htmlCaptureTargetRebindCount: 1,
          htmlCaptureTargetReadyLatencyMs: 42,
          htmlFrameCaptureSourceKind: 'html_preview_canvas',
          htmlFrameCaptureSucceeded: true,
          htmlFrameCaptureFailureReason: null,
          htmlReviewStatusResolved: true,
          htmlReviewStatusReason: 'capture_ready',
          rawArtifactTextExcluded: true,
          rawHtmlExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.200Z',
        category: 'artifacts-runtime',
        name: 'capture_target_retry_success',
        payload: {
          artifactId: 'coreview-real-artifact-landing-html',
          rendererKind: 'html',
          reviewStartWaitedForHtmlCaptureTarget: true,
          reviewStartHtmlCaptureTargetResult: 'success',
          htmlCaptureTargetMissingBeforeRetry: true,
          htmlCaptureTargetRetryAttempted: true,
          htmlCaptureTargetRetryResult: 'success',
          htmlCaptureTargetReadyLatencyMs: 120,
          htmlFrameCaptureSourceKind: 'html_preview_canvas',
          htmlFrameCaptureSucceeded: true,
          htmlFrameCaptureFailureReason: null,
          rawArtifactTextExcluded: true,
          rawHtmlExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:00.250Z',
        category: 'artifacts-runtime',
        name: 'html-visible-preview-layout',
        payload: {
          artifactId: 'coreview-real-artifact-landing-html',
          rendererKind: 'html',
          htmlCaptureTargetArtifactPathHash: 'pathhash123',
          htmlVisiblePreviewResponsive: true,
          htmlVisiblePreviewUsesCaptureDimensions: false,
          htmlVisiblePreviewWidth: 1184,
          htmlVisiblePreviewHeight: 720,
          htmlVisiblePreviewScrollMode: 'iframe',
          htmlVisibleRendererKind: 'iframe',
          htmlVisibleRendererInteractive: true,
          htmlVisibleIframePointerEvents: 'auto',
          htmlOverlayPointerEventsMode: 'passthrough',
          htmlOffscreenCaptureAffectsLayout: false,
          htmlBrowserInteractionEnabled: true,
          htmlAnnotationOverlayCapturing: false,
          htmlPageRailHidden: true,
          htmlThumbnailRailHidden: true,
          htmlCoreviewCommandModel: 'scroll_document',
          htmlFitModeApplied: 'width',
          htmlZoomScale: 1,
          rawArtifactTextExcluded: true,
          rawHtmlExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-04-07T12:00:00.320Z',
        category: 'artifacts-runtime',
        name: 'html-focus-anchor-command',
        payload: {
          artifactId: 'coreview-real-artifact-landing-html',
          rendererKind: 'html',
          htmlFocusAnchorAttempted: true,
          htmlFocusAnchorResult: 'success',
          htmlFocusAnchorMethod: 'heading',
          htmlFocusAnchorScrolled: true,
          htmlScrollMode: 'iframe_document',
          htmlScrollContainerResolved: true,
          htmlScrollTop: 320,
          htmlScrollHeight: 1800,
          htmlViewportHeight: 720,
          htmlCoreviewCommandModel: 'scroll_document',
          rawArtifactTextExcluded: true,
          rawHtmlExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 5,
        at: '2026-04-07T12:00:00.360Z',
        category: 'artifacts-runtime',
        name: 'html-scroll-command',
        payload: {
          artifactId: 'coreview-real-artifact-landing-html',
          rendererKind: 'html',
          htmlScrollAttempted: true,
          htmlScrollResult: 'success',
          htmlScrollMode: 'iframe_document',
          htmlScrollContainerResolved: true,
          htmlScrollTop: 320,
          htmlScrollHeight: 1800,
          htmlViewportHeight: 720,
          htmlCoreviewCommandModel: 'scroll_document',
          rawArtifactTextExcluded: true,
          rawHtmlExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 6,
        at: '2026-04-07T12:00:00.390Z',
        category: 'artifacts-runtime',
        name: 'html-internal-navigation',
        payload: {
          artifactId: 'coreview-real-artifact-landing-html',
          rendererKind: 'html',
          htmlInternalNavigationAttempted: true,
          htmlInternalNavigationResult: 'success',
          htmlInternalNavigationTargetKind: 'id',
          htmlInternalNavigationPreventedDefault: true,
          htmlInternalNavigationBlockedExternal: false,
          htmlInternalNavigationScrolled: true,
          htmlInternalNavigationFailureReason: null,
          htmlVoiceNavigationUsedSameResolver: true,
          htmlPostMessageNavigationReceived: true,
          htmlNavigationPreservedCaptureTarget: true,
          htmlScrollMode: 'iframe_document',
          htmlScrollContainerResolved: true,
          htmlScrollTop: 360,
          htmlScrollHeight: 1800,
          htmlViewportHeight: 720,
          rawArtifactTextExcluded: true,
          rawHtmlExcluded: true,
          rawFrameExcluded: true,
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:01.500Z'),
    });

    expect(metrics.coreview.visual.htmlCaptureTargetRegistered).toBe(true);
    expect(metrics.coreview.visual.htmlCaptureTargetRegistrationResult).toBe('registered');
    expect(metrics.coreview.visual.htmlCaptureTargetArtifactPathHash).toBe('pathhash123');
    expect(metrics.coreview.visual.htmlCaptureTargetStableIdentityHash).toBe('stablehash456');
    expect(metrics.coreview.visual.htmlCaptureTargetVersionAware).toBe(true);
    expect(metrics.coreview.visual.htmlCaptureTargetRebindCount).toBe(1);
    expect(metrics.coreview.visual.htmlCaptureTargetMissingBeforeRetry).toBe(true);
    expect(metrics.coreview.visual.htmlCaptureTargetRetryAttempted).toBe(true);
    expect(metrics.coreview.visual.htmlCaptureTargetRetryResult).toBe('success');
    expect(metrics.coreview.visual.htmlCaptureTargetReadyLatencyMs).toBe(120);
    expect(metrics.coreview.visual.htmlFrameCaptureSourceKind).toBe('html_preview_canvas');
    expect(metrics.coreview.visual.htmlFrameCaptureSucceeded).toBe(true);
    expect(metrics.coreview.visual.htmlFrameCaptureFailureReason).toBeNull();
    expect(metrics.coreview.visual.htmlVisiblePreviewResponsive).toBe(true);
    expect(metrics.coreview.visual.htmlVisiblePreviewUsesCaptureDimensions).toBe(false);
    expect(metrics.coreview.visual.htmlVisiblePreviewWidth).toBe(1184);
    expect(metrics.coreview.visual.htmlVisiblePreviewHeight).toBe(720);
    expect(metrics.coreview.visual.htmlVisiblePreviewScrollMode).toBe('iframe');
    expect(metrics.coreview.visual.htmlVisibleRendererKind).toBe('iframe');
    expect(metrics.coreview.visual.htmlVisibleRendererInteractive).toBe(true);
    expect(metrics.coreview.visual.htmlVisibleIframePointerEvents).toBe('auto');
    expect(metrics.coreview.visual.htmlOverlayPointerEventsMode).toBe('passthrough');
    expect(metrics.coreview.visual.htmlOffscreenCaptureAffectsLayout).toBe(false);
    expect(metrics.coreview.visual.htmlScrollMode).toBe('iframe_document');
    expect(metrics.coreview.visual.htmlScrollContainerResolved).toBe(true);
    expect(metrics.coreview.visual.htmlScrollTop).toBe(360);
    expect(metrics.coreview.visual.htmlScrollHeight).toBe(1800);
    expect(metrics.coreview.visual.htmlViewportHeight).toBe(720);
    expect(metrics.coreview.visual.htmlScrollAttempted).toBe(true);
    expect(metrics.coreview.visual.htmlScrollResult).toBe('success');
    expect(metrics.coreview.visual.htmlFocusAnchorAttempted).toBe(true);
    expect(metrics.coreview.visual.htmlFocusAnchorResult).toBe('success');
    expect(metrics.coreview.visual.htmlFocusAnchorMethod).toBe('heading');
    expect(metrics.coreview.visual.htmlFocusAnchorScrolled).toBe(true);
    expect(metrics.coreview.visual.htmlInternalNavigationAttempted).toBe(true);
    expect(metrics.coreview.visual.htmlInternalNavigationResult).toBe('success');
    expect(metrics.coreview.visual.htmlInternalNavigationTargetKind).toBe('id');
    expect(metrics.coreview.visual.htmlInternalNavigationPreventedDefault).toBe(true);
    expect(metrics.coreview.visual.htmlInternalNavigationBlockedExternal).toBe(false);
    expect(metrics.coreview.visual.htmlInternalNavigationScrolled).toBe(true);
    expect(metrics.coreview.visual.htmlInternalNavigationFailureReason).toBeNull();
    expect(metrics.coreview.visual.htmlVoiceNavigationUsedSameResolver).toBe(true);
    expect(metrics.coreview.visual.htmlPostMessageNavigationReceived).toBe(true);
    expect(metrics.coreview.visual.htmlNavigationPreservedCaptureTarget).toBe(true);
    expect(metrics.coreview.visual.htmlAnnotationOverlayCapturing).toBe(false);
    expect(metrics.coreview.visual.htmlBrowserInteractionEnabled).toBe(true);
    expect(metrics.coreview.visual.htmlPageRailHidden).toBe(true);
    expect(metrics.coreview.visual.htmlThumbnailRailHidden).toBe(true);
    expect(metrics.coreview.visual.htmlCoreviewCommandModel).toBe('scroll_document');
    expect(metrics.coreview.visual.htmlFitModeApplied).toBe('width');
    expect(metrics.coreview.visual.htmlZoomScale).toBe(1);
    expect(metrics.coreview.visual.htmlReviewStatusResolved).toBe(true);
    expect(metrics.coreview.visual.htmlReviewStatusReason).toBe('capture_ready');
    expect(metrics.coreview.visual.reviewStartWaitedForHtmlCaptureTarget).toBe(true);
    expect(metrics.coreview.visual.reviewStartHtmlCaptureTargetResult).toBe('success');
  });

  it('counts coreviewArtifactId state as selected artifact evidence when stage-selection events are absent', () => {
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
        at: '2026-04-07T12:00:00.900Z',
        category: 'voice-session',
        name: 'coreview-state',
        payload: {
          data: {
            coreview: {
              coreviewEnabled: true,
              coreviewSessionActive: true,
              coreviewArtifactId: 'coreview-real-artifact-launch-brief',
              visualSourceKind: 'offscreen_render',
              frameSentCount: 1,
              initialFrameSent: true,
              exactTextAvailable: true,
            },
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot({
        artifactDom: { panelVisible: true, takeawayText: 'Visible rendered text.' },
      }),
      nowMs: Date.parse('2026-04-07T12:00:01.500Z'),
    });

    expect(metrics.counts.artifacts).toBe(1);
    expect(metrics.counts.artifactPublicEventCount).toBe(0);
    expect(metrics.counts.artifactRuntimeIngestCount).toBe(1);
    expect(metrics.counts.artifactSelectedStageCount).toBe(1);
    expect(metrics.counts.artifactCountSource).toBe('selected_stage_artifact');
    expect(metrics.counts.artifactCountMismatchReason).toBe('selected_stage_artifact_not_public_event');
    expect(metrics.sessionTelemetry.gemini?.artifactSelectedStageCount).toBe(1);
    expect(metrics.coreview.visual.coreviewArtifactId).toBe('coreview-real-artifact-launch-brief');
    expect(metrics.coreview.visual.frameSentCount).toBe(1);
  });

  it('reports Coreview enabled from parsed frontend flags even before a frame is sent', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:00.000Z',
        category: 'voice-session',
        name: 'coreview-flag-diagnostics',
        payload: {
          runtime: 'gemini_live',
          frontendCoreviewFlagParsed: true,
          frontendStillFrameFlagParsed: true,
          backendCoreviewFlagParsed: true,
          backendStillFrameFlagParsed: true,
          coreviewDisabledReason: null,
        },
      }),
      buildEvent({
        seq: 2,
        at: '2026-04-07T12:00:00.800Z',
        category: 'artifacts-runtime',
        name: 'select-stage-artifact',
        payload: {
          sessionId: 'session-dev',
          threadId: 'thread-dev',
          artifactId: 'coreview-real-artifact-launch-brief',
          coreviewArtifactId: 'coreview-real-artifact-launch-brief',
          reviewFeatureEnabled: true,
          frontendCoreviewFlagParsed: true,
          frontendStillFrameFlagParsed: true,
          exactTextSource: 'builder_file',
          exactTextAvailable: true,
          rawArtifactTextExcluded: true,
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:00:01.500Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      coreviewEnabled: true,
      coreviewSessionActive: false,
      coreviewArtifactId: 'coreview-real-artifact-launch-brief',
      frameSentCount: 0,
      exactTextAvailable: true,
      frontendCoreviewFlagParsed: true,
      frontendStillFrameFlagParsed: true,
      backendCoreviewFlagParsed: true,
      backendStillFrameFlagParsed: true,
      coreviewDisabledReason: null,
    });
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
    expect(metrics.counts.artifactCountMismatchReason).toBeNull();
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
      buildEvent({
        seq: 3,
        at: '2026-04-07T12:00:22.000Z',
        category: 'builder-ui',
        name: 'builder-surface-resolved',
        payload: {
          builderSurfaceMode: 'active_build_steps',
          canonicalBuilderSurface: 'active_build_steps',
          legacyBuilderSurfaceHidden: true,
          builderReadyPillSuppressed: true,
          duplicateBuilderSurfaceSuppressed: true,
          resumedBuilderSurfaceResolved: false,
          completedBuilderEntryPlacement: 'hidden',
          completedBuilderEntryOverlapsControls: false,
          completedBuilderEntryHiddenForStage: false,
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
    expect(metrics.builder.builderSurfaceMode).toBe('active_build_steps');
    expect(metrics.builder.canonicalBuilderSurface).toBe('active_build_steps');
    expect(metrics.builder.legacyBuilderSurfaceHidden).toBe(true);
    expect(metrics.builder.builderReadyPillSuppressed).toBe(true);
    expect(metrics.builder.duplicateBuilderSurfaceSuppressed).toBe(true);
    expect(metrics.builder.resumedBuilderSurfaceResolved).toBe(false);
    expect(metrics.builder.completedBuilderEntryPlacement).toBe('hidden');
    expect(metrics.builder.completedBuilderEntryOverlapsControls).toBe(false);
    expect(metrics.builder.completedBuilderEntryHiddenForStage).toBe(false);
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

  it('normalizes legacy completed artifact entry telemetry to the canonical completed builder surface', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-04-07T12:00:22.000Z',
        category: 'builder-ui',
        name: 'builder-surface-resolved',
        payload: {
          builderSurfaceMode: 'completed_artifact_entry',
          canonicalBuilderSurface: 'completed_artifact_entry',
          legacyBuilderSurfaceHidden: true,
          builderReadyPillSuppressed: true,
          duplicateBuilderSurfaceSuppressed: true,
          resumedBuilderSurfaceResolved: true,
          completedBuilderEntryPlacement: 'corner',
          completedBuilderEntryOverlapsControls: false,
          completedBuilderEntryHiddenForStage: false,
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-04-07T12:01:20.000Z'),
    });

    expect(metrics.builder.builderSurfaceMode).toBe('canonical_completed_builder');
    expect(metrics.builder.canonicalBuilderSurface).toBe('canonical_completed_builder');
    expect(metrics.builder.builderReadyPillSuppressed).toBe(true);
    expect(metrics.builder.duplicateBuilderSurfaceSuppressed).toBe(true);
    expect(metrics.builder.completedBuilderEntryPlacement).toBe('corner');
    expect(metrics.builder.completedBuilderEntryOverlapsControls).toBe(false);
    expect(metrics.builder.completedBuilderEntryHiddenForStage).toBe(false);
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

  it('surfaces a safe no-signal warning when the microphone stream is connected but silent', () => {
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
        at: '2026-04-07T12:00:00.120Z',
        category: 'voice-session',
        name: 'gemini-stage-changed',
        payload: {
          runtime: 'gemini_live',
          stage: 'streaming_audio',
          connectionState: 'connected',
          websocketState: 'connected',
          microphoneState: 'connected',
          remoteAudioState: 'idle',
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot({ detectedAudio: false }),
      nowMs: Date.parse('2026-04-07T12:00:02.000Z'),
    });

    expect(metrics.bottleneck.kind).toBe('microphone');
    expect(metrics.bottleneck.title).toBe('Input capture is the bottleneck');
    expect(metrics.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'microphone',
          title: 'Mic stream without signal',
          level: 'bad',
        }),
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

  it('summarizes safe Coreview visual and exact-text telemetry from current-run events', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-05-27T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-05-27T12:00:01.000Z',
        category: 'voice-session',
        name: 'gemini-setup-tools',
        payload: {
          runtime: 'gemini_live',
          reviewToolsExposed: ['read_artifact_text', 'coreview_get_current_view'],
          emitArtifactExposedDuringReview: false,
          rawArtifactTextExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-05-27T12:00:01.000Z',
        category: 'voice-session',
        name: 'gemini-artifact-frame-send',
        payload: {
          runtime: 'gemini_live',
          result: {
            coreviewSendStage: 'start',
            artifactId: 'artifact-1',
            ok: true,
            websocketSendAccepted: true,
            frameBytes: 1024,
            frameDimensions: { width: 640, height: 360 },
            visualSourceKind: 'canvas_element',
            frameSendLatencyMs: 12,
            imageCountAfterFrame: 1,
            videoDurationSecondsAfterFrame: 0.25,
            audioDurationSecondsAfterFrame: 2,
            visualResponseObserved: true,
            rawFrameExcluded: true,
          },
        },
      }),
      buildEvent({
        seq: 4,
        at: '2026-05-27T12:00:02.000Z',
        category: 'voice-session',
        name: 'gemini-artifact-frame-send',
        payload: {
          runtime: 'gemini_live',
          result: {
            coreviewSendStage: 'refresh',
            artifactId: 'artifact-1',
            ok: true,
            websocketSendAccepted: true,
            frameBytes: 2048,
            frameDimensions: { width: 800, height: 450 },
            visualSourceKind: 'canvas_element',
            frameSendLatencyMs: 18,
            rawFrameExcluded: true,
          },
        },
      }),
      buildEvent({
        seq: 5,
        at: '2026-05-27T12:00:03.000Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          runtime: 'gemini_live',
          phase: 'tool_call_received',
          toolName: 'read_artifact_text',
          success: true,
          diagnostic: {
            toolCall: { name: 'read_artifact_text', args: null },
          },
        },
      }),
      buildEvent({
        seq: 6,
        at: '2026-05-27T12:00:03.050Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          runtime: 'gemini_live',
          phase: 'tool_response_sent',
          toolName: 'read_artifact_text',
          success: true,
          diagnostic: {
            toolCall: { name: 'read_artifact_text', args: null },
            backendResponse: {
              ok: true,
              source: 'builder_metadata',
              status: 'success',
              char_count: 77,
              truncated: false,
              latency_ms: 4,
              raw_artifact_text_excluded: true,
            },
          },
        },
      }),
      buildEvent({
        seq: 7,
        at: '2026-05-27T12:00:03.100Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          runtime: 'gemini_live',
          phase: 'tool_response_sent',
          toolName: 'coreview_get_current_view',
          success: true,
          diagnostic: {
            toolCall: { name: 'coreview_get_current_view', args: null },
            backendResponse: {
              ok: true,
              action: 'get_current_view',
              current_view_summary: 'Current view is page 1 of 4.',
              page_number: 1,
              page_count: 4,
              visual_fresh: true,
              frame_sent: true,
              raw_artifact_text_excluded: true,
              raw_frame_excluded: true,
            },
          },
        },
      }),
      buildEvent({
        seq: 8,
        at: '2026-05-27T12:00:03.180Z',
        category: 'voice-session',
        name: 'coreview-tool-call',
        payload: {
          coreviewToolName: 'coreview_add_annotation',
          coreviewToolResult: 'success',
          coreviewToolLastResult: 'success',
          coreviewAnnotationToolCount: 1,
          coreviewAnnotationFallbackCount: 1,
          coreviewAnnotationCommandSource: 'frontend_fallback',
          coreviewAnnotationToolResult: 'success',
          coreviewAnnotationFallbackResult: 'success',
          coreviewAnnotationKind: 'comment',
          coreviewAnnotationAnchorType: 'current_title',
          coreviewAnnotationColor: 'yellow',
          coreviewAnnotationPageIndex: 0,
          coreviewAnnotationBlockedReason: null,
          annotationIntentDetectedCount: 1,
          annotationIntentSource: 'artifact_review_voice_command',
          annotationFallbackAttempted: true,
          annotationFallbackResult: 'success',
          annotationFallbackBlockedReason: null,
          annotationFallbackUtteranceKind: 'annotation_comment',
          recentAnnotationActionSucceeded: true,
          annotationCommitAttempted: true,
          annotationCommitResult: 'success',
          annotationCommitCountBefore: 1,
          annotationCommitCountAfter: 2,
          annotationCommitVerified: true,
          annotationCommandPreventedNavigation: true,
          annotationCommandKeptArtifactMounted: true,
          annotationViewReadyTimedOut: false,
          annotationPartialSuccess: false,
          sessionLeaveGuardSuppressedForAnnotation: true,
          annotationOverlayCaptured: true,
          annotationCount: 2,
          highlightCount: 1,
          commentCount: 1,
          annotationActionSource: 'sophia',
          rawCommentTextExcluded: true,
          rawArtifactTextExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 9,
        at: '2026-05-27T12:00:03.220Z',
        category: 'voice-session',
        name: 'assistant-annotation-claim-suppressed',
        payload: {
          reason: 'annotation_fallback_owns_acknowledgement',
          reviewVoiceCommandKind: 'add_annotation',
          annotationKind: 'comment',
          rawTranscriptExcluded: true,
          rawCommentTextExcluded: true,
          rawArtifactTextExcluded: true,
          rawFrameExcluded: true,
        },
      }),
      buildEvent({
        seq: 10,
        at: '2026-05-27T12:00:03.250Z',
        category: 'voice-session',
        name: 'artifact-review-voice-command',
        payload: {
          reviewVoiceCommandKind: 'zoom_in',
          reviewVoiceCommandApplied: true,
          reviewVoiceCommandRefreshResult: 'success',
          reviewVoiceCommandTransportStateBefore: 'ready',
          reviewVoiceCommandTransportStateAfter: 'ready',
          reviewVoiceCommandDidHardIntercept: false,
          reviewVoiceCommandWaitedForViewReady: true,
          reviewVoiceCommandAutoRefreshTiming: 'after_view_ready:24ms',
          reviewVoiceCommandAutoRefreshBlockedReason: null,
          reviewCommandStaleAfterViewChange: false,
          lastReviewVoiceCommandUiMode: 'voice',
          artifactCurrentPageIndex: 0,
          artifactCurrentPageCount: 3,
          rawTranscriptExcluded: true,
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      coreviewEnabled: true,
      frameSentCount: 2,
      initialFrameSent: true,
      visualFresh: true,
      visualFreshForTurn: true,
      exactTextAvailable: true,
      refreshFrameCount: 1,
      lastFrameBytes: 2048,
      lastFrameDimensions: { width: 800, height: 450 },
      totalFrameBytes: 3072,
      maxFrameSendLatencyMs: 18,
      providerUsageImageCount: 1,
      providerUsageVideoDurationSeconds: 0.25,
      providerUsageAudioDurationSeconds: 2,
      visualResponseObserved: true,
      toolCallAfterFrameObserved: true,
      reviewVoiceCommandTransportStateBefore: 'ready',
      reviewVoiceCommandTransportStateAfter: 'ready',
      reviewVoiceCommandDidHardIntercept: false,
      reviewVoiceCommandWaitedForViewReady: true,
      reviewVoiceCommandAutoRefreshTiming: 'after_view_ready:24ms',
      reviewToolsExposed: ['read_artifact_text', 'coreview_get_current_view'],
      emitArtifactExposedDuringReview: false,
      coreviewGetCurrentViewCount: 1,
      coreviewGetCurrentViewResult: 'Current view is page 1 of 4.',
      coreviewAnnotationToolCount: 1,
      coreviewAnnotationFallbackCount: 1,
      coreviewAnnotationCommandSource: 'frontend_fallback',
      coreviewAnnotationToolResult: 'success',
      coreviewAnnotationFallbackResult: 'success',
      coreviewAnnotationKind: 'comment',
      coreviewAnnotationAnchorType: 'current_title',
      coreviewAnnotationColor: 'yellow',
      coreviewAnnotationPageIndex: 0,
      annotationOverlayCaptured: true,
      annotationCount: 2,
      highlightCount: 1,
      commentCount: 1,
      annotationActionSource: 'sophia',
      annotationCommitAttempted: true,
      annotationCommitResult: 'success',
      annotationCommitCountBefore: 1,
      annotationCommitCountAfter: 2,
      annotationCommitVerified: true,
      annotationCommandPreventedNavigation: true,
      annotationCommandKeptArtifactMounted: true,
      annotationViewReadyTimedOut: false,
      annotationPartialSuccess: false,
      sessionLeaveGuardSuppressedForAnnotation: true,
      assistantAnnotationClaimSuppressedCount: 1,
      lastReviewVoiceCommandKind: 'zoom_in',
      lastReviewVoiceCommandApplied: true,
      lastReviewVoiceCommandUiMode: 'voice',
      lastReviewVoiceCommands: [
        expect.objectContaining({
          kind: 'zoom_in',
          applied: true,
          uiMode: 'voice',
          waitedForViewReady: true,
          didHardIntercept: false,
          rawTranscriptExcluded: true,
        }),
      ],
      rawFrameExcluded: true,
      rawProviderPayloadExcluded: true,
    });
    expect(metrics.coreview.exactText).toMatchObject({
      exactTextCallCount: 1,
      readArtifactTextCallCount: 1,
      exactTextSuccessCount: 1,
      exactTextFailureCount: 0,
      exactTextSources: expect.objectContaining({ builder_metadata: 1 }),
      lastExactTextStatus: 'success',
      lastExactTextSource: 'builder_metadata',
      lastExactTextCharCount: 77,
      lastExactTextTruncated: false,
      lastExactTextLatencyMs: 4,
      readArtifactTextResolvedCount: 1,
      readArtifactTextUnresolvedCount: 0,
      readArtifactTextLastStatus: 'success',
      exactTextRegistrySource: 'builder_metadata',
      rawArtifactTextExcluded: true,
      rawQueryExcluded: true,
    });
  });

  it('downgrades annotation success telemetry when committed counts did not change', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-05-27T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'session-dev' },
        }),
        buildEvent({
          seq: 2,
          at: '2026-05-27T12:00:01.000Z',
          category: 'voice-session',
          name: 'coreview-tool-call',
          payload: {
            coreviewToolName: 'coreview_add_annotation',
            coreviewToolResult: 'success',
            coreviewAnnotationToolCount: 1,
            coreviewAnnotationFallbackCount: 1,
            coreviewAnnotationCommandSource: 'frontend_fallback',
            coreviewAnnotationToolResult: 'success',
            coreviewAnnotationFallbackResult: 'success',
            annotationFallbackAttempted: true,
            annotationFallbackResult: 'success',
            recentAnnotationActionSucceeded: true,
            annotationCommitAttempted: true,
            annotationCommitResult: 'success',
            annotationCommitCountBefore: 0,
            annotationCommitCountAfter: 0,
            annotationCommitVerified: false,
            annotationCount: 0,
            highlightCount: 0,
            commentCount: 0,
            rawCommentTextExcluded: true,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:02.000Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      coreviewAnnotationToolResult: 'annotation_commit_failed',
      coreviewAnnotationFallbackResult: 'annotation_commit_failed',
      annotationFallbackResult: 'annotation_commit_failed',
      recentAnnotationActionSucceeded: false,
      annotationCommitAttempted: true,
      annotationCommitResult: 'annotation_commit_failed',
      annotationCommitCountBefore: 0,
      annotationCommitCountAfter: 0,
      annotationCommitVerified: false,
      annotationCount: 0,
      highlightCount: 0,
      commentCount: 0,
    });
  });

  it('counts successful PDF extraction as an exact-text registry source before a text-read tool call', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-05-27T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'session-dev' },
        }),
        buildEvent({
          seq: 2,
          at: '2026-05-27T12:00:01.000Z',
          category: 'artifacts-runtime',
          name: 'pdf-text-extraction',
          payload: {
            artifactId: 'artifact-1',
            pdfTextExtractionStatus: 'success',
            pdfTextExtractionSource: 'pdf_text_extraction',
            pdfTextExtractionPageCount: 4,
            pdfTextExtractionCharCount: 1297,
            pdfTextExtractionTruncated: false,
            rawArtifactTextExcluded: true,
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual.exactTextAvailable).toBe(true);
    expect(metrics.coreview.exactText.exactTextSuccessCount).toBe(1);
    expect(metrics.coreview.exactText.exactTextSources.pdf_text_extraction).toBe(1);
    expect(metrics.coreview.exactText.exactTextRegistrySource).toBe('pdf_text_extraction');
    expect(metrics.coreview.exactText.readArtifactTextResolvedCount).toBe(0);
    expect(metrics.coreview.exactText.readArtifactTextUnresolvedCount).toBe(0);
  });

  it('reports Pan mode state and successful pan gestures without raw artifact content', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-05-27T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'session-dev' },
        }),
        buildEvent({
          seq: 2,
          at: '2026-05-27T12:00:01.000Z',
          category: 'artifacts-runtime',
          name: 'artifact-annotation-state',
          payload: {
            artifactId: 'artifact-1',
            artifactRendererKind: 'pdf',
            artifactToolMode: 'pan',
            panModeActive: true,
            annotationOverlayCaptured: false,
            annotationCount: 0,
            highlightCount: 0,
            commentCount: 0,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
        buildEvent({
          seq: 3,
          at: '2026-05-27T12:00:01.500Z',
          category: 'artifacts-runtime',
          name: 'artifact-pan-gesture',
          payload: {
            artifactId: 'artifact-1',
            artifactRendererKind: 'pdf',
            artifactPageIndex: 1,
            artifactPageNumber: 2,
            artifactZoom: 1.8,
            artifactFitMode: 'custom',
            artifactToolMode: 'pan',
            panModeActive: true,
            panGestureCount: 1,
            panGestureResult: 'success',
            panScrollDeltaX: 60,
            panScrollDeltaY: 40,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
            rawCommentTextExcluded: true,
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual.panModeActive).toBe(true);
    expect(metrics.coreview.visual.panGestureCount).toBe(1);
    expect(metrics.coreview.visual.panGestureResult).toBe('success');
    expect(metrics.coreview.visual.panScrollDeltaX).toBe(60);
    expect(metrics.coreview.visual.panScrollDeltaY).toBe(40);
    expect(JSON.stringify(metrics.coreview.visual)).not.toContain('raw artifact body');
  });

  it('reports annotation restore, sticky tool mode, and canvas restore telemetry safely', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-05-27T12:00:00.000Z',
          category: 'artifacts-runtime',
          name: 'artifact-canvas-restore',
          payload: {
            canvasRestoreAttempted: true,
            canvasRestoreResult: 'restored',
            canvasRestoreSource: 'page_mount',
            canvasRestoredArtifactIdentityHash: 'artifact-hash',
            canvasRestoreStorageKeyHash: 'canvas-key-hash',
            canvasRestoreStorageVersion: 1,
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
        buildEvent({
          seq: 2,
          at: '2026-05-27T12:00:01.000Z',
          category: 'artifacts-runtime',
          name: 'artifact-annotation-state',
          payload: {
            artifactId: 'artifact-1',
            artifactRendererKind: 'pdf',
            artifactToolMode: 'highlight',
            annotationOverlayCaptured: true,
            annotationCount: 4,
            highlightCount: 1,
            commentCount: 1,
            underlineCount: 1,
            arrowCount: 1,
            annotationRestoreAttempted: true,
            annotationRestoreResult: 'restored',
            annotationRestoreCount: 4,
            annotationRestoreSource: 'stage_mount',
            annotationPersistenceStatus: 'restored',
            annotationPersistAttempted: true,
            annotationPersistResult: 'saved',
            annotationPersistCount: 4,
            annotationPersistedCount: 4,
            annotationStorageVersion: 1,
            annotationStorageKeyHash: 'annotation-key-hash',
            annotationIdentityWriteHash: 'annotation-key-hash',
            annotationIdentityReadHash: 'annotation-key-hash',
            annotationRestoreOverwrittenCount: 0,
            annotationStateClearedReason: null,
            stickyToolModeEnabled: true,
            lastToolModeBeforeAction: 'highlight',
            lastToolModeAfterAction: 'highlight',
            toolModeResetReason: null,
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      canvasRestoreAttempted: true,
      canvasRestoreResult: 'restored',
      canvasRestoreSource: 'page_mount',
      canvasRestoredArtifactIdentityHash: 'artifact-hash',
      annotationRestoreAttempted: true,
      annotationRestoreResult: 'restored',
      annotationRestoreCount: 4,
      annotationRestoreSource: 'stage_mount',
      annotationPersistAttempted: true,
      annotationPersistResult: 'saved',
      annotationPersistCount: 4,
      annotationStorageKeyHash: 'annotation-key-hash',
      annotationStorageVersion: 1,
      annotationIdentityWriteHash: 'annotation-key-hash',
      annotationIdentityReadHash: 'annotation-key-hash',
      annotationRestoreOverwrittenCount: 0,
      annotationStateClearedReason: null,
      stickyToolModeEnabled: true,
      lastToolModeBeforeAction: 'highlight',
      lastToolModeAfterAction: 'highlight',
      toolModeResetReason: null,
    });
    expect(JSON.stringify(metrics.coreview.visual)).not.toContain('raw artifact body');
  });

  it('summarizes Coreview workspace event log telemetry without raw payload content', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-06-05T12:00:00.000Z',
          category: 'artifacts-runtime',
          name: 'coreview-workspace-event',
          payload: {
            workspaceEventType: 'annotation.created',
            workspaceEventPayloadExcluded: true,
            coreviewWorkspaceEventLogActive: true,
            coreviewWorkspaceContractVersion: 1,
            coreviewWorkspaceEventCount: 3,
            coreviewWorkspaceLastEventType: 'annotation.created',
            coreviewWorkspaceActorKind: 'sophia',
            coreviewWorkspaceHasShareReadyMetadata: true,
            coreviewShareStatus: 'unavailable',
            workspaceEventLogPersistResult: 'saved',
            workspaceEventLogRestoreCount: 2,
            annotationEventsCreatedCount: 1,
            viewChangedEventCount: 1,
            commentText: 'change the font',
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-06-05T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      coreviewWorkspaceEventLogActive: true,
      coreviewWorkspaceContractVersion: 1,
      coreviewWorkspaceEventCount: 3,
      coreviewWorkspaceLastEventType: 'annotation.created',
      coreviewWorkspaceActorKind: 'sophia',
      coreviewWorkspaceHasShareReadyMetadata: true,
      coreviewShareStatus: 'unavailable',
      workspaceEventLogPersistResult: 'saved',
      workspaceEventLogRestoreCount: 2,
      annotationEventsCreatedCount: 1,
      viewChangedEventCount: 1,
    });
    expect(JSON.stringify(metrics.coreview.visual)).not.toContain('change the font');
  });

  it('reports Coreview builder availability and safe generic async rejection telemetry', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-06-06T12:00:00.000Z',
          category: 'voice-session',
          name: 'gemini-setup-tools',
          payload: {
            reviewToolsExposed: [
              'coreview_request_artifact_update',
              'coreview_cancel_builder_task',
              'coreview_get_builder_status',
            ],
            coreviewBuilderToolsExposed: true,
            coreviewBuilderGenericToolsSuppressed: true,
          },
        }),
        buildEvent({
          seq: 2,
          at: '2026-06-06T12:00:01.000Z',
          category: 'voice-session',
          name: 'coreview-builder-action',
          payload: {
            coreviewBuilderActionsEnabled: true,
            coreviewBuilderActionsBlockedReason: null,
            coreviewBuilderActiveTaskState: 'starting',
            coreviewBuilderStatusResult: 'starting',
            coreviewBuilderStatusToolResult: 'status',
            editBuilderArtifactInterceptedByCoreview: true,
            editBuilderArtifactDirectCallResult: 'routed_to_coreview_update',
            coreviewUpdateStateCreatedFromDirectEditTool: true,
            coreviewUpdateCardVisible: true,
            coreviewHtmlLiveUpdateEnabled: true,
            coreviewArtifactVersioningEnabled: true,
            coreviewArtifactLogicalId: 'logical-html-artifact',
            coreviewArtifactOriginalVersionIdPresent: true,
            coreviewArtifactCurrentVersionIdPresent: true,
            coreviewArtifactVersionCount: 2,
            coreviewHtmlUpdateMatchedBy: 'revision_of_artifact_path',
            coreviewHtmlUpdateAutoApplyAttempted: true,
            coreviewHtmlUpdateAutoApplied: true,
            coreviewHtmlUpdateAutoApplyResult: 'success',
            coreviewHtmlUpdateRenderConfirmed: true,
            coreviewHtmlUpdatePreviewRefreshFailed: false,
            coreviewHtmlUpdatePreviousPathHash: 'old-path-hash',
            coreviewHtmlUpdateCurrentPathHash: 'new-path-hash',
            coreviewHtmlUpdateRestoreAvailable: true,
            coreviewHtmlUpdateNoViewClickRequired: true,
            coreviewHtmlUpdateSuppressedCompletedBuilderSurface: true,
            coreviewHtmlUpdateSuppressedDuplicateReplyCount: 1,
            coreviewHtmlUpdateSuccessClaimBlockedUntilRender: false,
            coreviewHtmlUpdateSelectedPathChanged: true,
            coreviewHtmlUpdatePreservedReview: true,
            coreviewHtmlUpdatePreservedMic: true,
            coreviewHtmlQuickPatchEligible: true,
            coreviewHtmlQuickPatchAttempted: true,
            coreviewHtmlQuickPatchResult: 'patched',
            coreviewHtmlQuickPatchKind: 'title',
            coreviewHtmlQuickPatchFallbackReason: null,
            coreviewHtmlQuickPatchLatencyMs: 418,
            coreviewHtmlQuickPatchRevisionPathHash: 'quick-revision-hash',
            coreviewHtmlQuickPatchUsedFullBuilder: false,
            coreviewHtmlQuickPatchRenderConfirmed: true,
            coreviewHtmlQuickPatchPreservedOriginal: true,
            coreviewHtmlQuickPatchRestoreAvailable: true,
            coreviewHtmlQuickPatchTypeErrorPrevented: false,
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
        buildEvent({
          seq: 3,
          at: '2026-06-06T12:00:02.000Z',
          category: 'voice-session',
          name: 'gemini-tool-loop-diagnostic',
          payload: {
            runtime: 'gemini_live',
            phase: 'tool_response_sent',
            toolName: 'check_async_task',
            diagnostic: {
              phase: 'tool_response_sent',
              toolCall: { name: 'check_async_task' },
              response: {
                ok: false,
                rejection_reason: 'artifact_review_generic_async_status_redirected',
                generic_async_tool_blocked_reason: 'use_coreview_get_builder_status',
                generic_async_tool_responded_safely: true,
                raw_task_id_excluded: true,
              },
            },
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-06-06T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      coreviewBuilderActionsEnabled: true,
      coreviewBuilderActionsBlockedReason: null,
      coreviewBuilderToolsExposed: true,
      coreviewBuilderGenericToolsSuppressed: true,
      coreviewBuilderActiveTaskState: 'starting',
      coreviewBuilderStatusResult: 'starting',
      coreviewBuilderStatusToolResult: 'status',
      editBuilderArtifactInterceptedByCoreview: true,
      editBuilderArtifactDirectCallResult: 'routed_to_coreview_update',
      coreviewUpdateStateCreatedFromDirectEditTool: true,
      coreviewUpdateCardVisible: true,
      coreviewHtmlLiveUpdateEnabled: true,
      coreviewArtifactVersioningEnabled: true,
      coreviewArtifactLogicalId: 'logical-html-artifact',
      coreviewArtifactOriginalVersionIdPresent: true,
      coreviewArtifactCurrentVersionIdPresent: true,
      coreviewArtifactVersionCount: 2,
      coreviewHtmlUpdateMatchedBy: 'revision_of_artifact_path',
      coreviewHtmlUpdateAutoApplyAttempted: true,
      coreviewHtmlUpdateAutoApplied: true,
      coreviewHtmlUpdateAutoApplyResult: 'success',
      coreviewHtmlUpdateRenderConfirmed: true,
      coreviewHtmlUpdatePreviewRefreshFailed: false,
      coreviewHtmlUpdatePreviousPathHash: 'old-path-hash',
      coreviewHtmlUpdateCurrentPathHash: 'new-path-hash',
      coreviewHtmlUpdateRestoreAvailable: true,
      coreviewHtmlUpdateNoViewClickRequired: true,
      coreviewHtmlUpdateSuppressedCompletedBuilderSurface: true,
      coreviewHtmlUpdateSuppressedDuplicateReplyCount: 1,
      coreviewHtmlUpdateSuccessClaimBlockedUntilRender: false,
      coreviewHtmlUpdateSelectedPathChanged: true,
      coreviewHtmlUpdatePreservedReview: true,
      coreviewHtmlUpdatePreservedMic: true,
      coreviewHtmlQuickPatchEligible: true,
      coreviewHtmlQuickPatchAttempted: true,
      coreviewHtmlQuickPatchResult: 'patched',
      coreviewHtmlQuickPatchKind: 'title',
      coreviewHtmlQuickPatchFallbackReason: null,
      coreviewHtmlQuickPatchLatencyMs: 418,
      coreviewHtmlQuickPatchRevisionPathHash: 'quick-revision-hash',
      coreviewHtmlQuickPatchUsedFullBuilder: false,
      coreviewHtmlQuickPatchRenderConfirmed: true,
      coreviewHtmlQuickPatchPreservedOriginal: true,
      coreviewHtmlQuickPatchRestoreAvailable: true,
      coreviewHtmlQuickPatchTypeErrorPrevented: false,
      genericAsyncToolBlockedReason: 'use_coreview_get_builder_status',
      genericAsyncToolRespondedSafely: true,
    });
  });

  it('reports Coreview action feedback and HTML annotation telemetry without raw comments', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-06-06T12:00:00.000Z',
          category: 'voice-session',
          name: 'coreview-action-feedback',
          payload: {
            coreviewActionFeedbackEmitted: true,
            coreviewActionFeedbackKind: 'quick_patch',
            coreviewActionFeedbackStatus: 'applied',
            coreviewActionFeedbackSpoken: false,
            coreviewActionFeedbackAudioAttempted: true,
            coreviewActionFeedbackAudioResult: 'unavailable',
            coreviewActionFeedbackDedupeSuppressedCount: 0,
            coreviewActionFeedbackRawContentExcluded: true,
            voiceAudioAckUnavailable: true,
            rawCommentTextExcluded: true,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
        buildEvent({
          seq: 2,
          at: '2026-06-06T12:00:01.000Z',
          category: 'voice-session',
          name: 'coreview-action-feedback',
          payload: {
            coreviewActionFeedbackEmitted: false,
            coreviewActionFeedbackKind: 'quick_patch',
            coreviewActionFeedbackStatus: 'applied',
            coreviewActionFeedbackSpoken: false,
            coreviewActionFeedbackAudioAttempted: false,
            coreviewActionFeedbackAudioResult: 'not_attempted',
            coreviewActionFeedbackDedupeSuppressedCount: 1,
            coreviewActionFeedbackRawContentExcluded: true,
            rawCommentTextExcluded: true,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
        buildEvent({
          seq: 3,
          at: '2026-06-06T12:00:02.000Z',
          category: 'voice-session',
          name: 'coreview-tool-call',
          payload: {
            rendererKind: 'html',
            action: 'add_annotation',
            coreviewAnnotationToolCount: 1,
            coreviewAnnotationToolResult: 'committed',
            coreviewAnnotationKind: 'comment',
            coreviewAnnotationAnchorType: 'text_quote',
            coreviewHtmlAnnotationsEnabled: true,
            coreviewHtmlAnnotationKind: 'comment',
            coreviewHtmlAnnotationAnchorType: 'text_quote',
            coreviewHtmlAnnotationResult: 'committed',
            coreviewHtmlAnnotationPersisted: true,
            rawCommentTextExcluded: true,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-06-06T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      coreviewActionFeedbackEmitted: true,
      coreviewActionFeedbackKind: 'quick_patch',
      coreviewActionFeedbackStatus: 'applied',
      coreviewActionFeedbackSpoken: false,
      coreviewActionFeedbackAudioAttempted: true,
      coreviewActionFeedbackAudioResult: 'not_attempted',
      coreviewActionFeedbackDedupeSuppressedCount: 1,
      coreviewActionFeedbackRawContentExcluded: true,
      voiceAudioAckUnavailable: true,
      coreviewHtmlAnnotationsEnabled: true,
      coreviewHtmlAnnotationKind: 'comment',
      coreviewHtmlAnnotationAnchorType: 'text_quote',
      coreviewHtmlAnnotationResult: 'committed',
      coreviewHtmlAnnotationPersisted: true,
      rawCommentTextExcluded: true,
    });
    expect(JSON.stringify(metrics.coreview.visual)).not.toContain('tighten this');
  });

  it('reports builder snapshot protection and thumbnail annotation indicators', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-05-27T12:00:00.000Z',
          category: 'builder-ui',
          name: 'builder-canvas-snapshot-hydration',
          payload: {
            builderSnapshotEmptyPassive: true,
            builderSnapshotIgnoredForActiveArtifact: true,
            artifactStageProtectedFromSnapshot: true,
            artifactStageUnmountPrevented: true,
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
        buildEvent({
          seq: 2,
          at: '2026-05-27T12:00:01.000Z',
          category: 'artifacts-runtime',
          name: 'artifact-thumbnail-annotation-state',
          payload: {
            thumbnailAnnotationIndicatorMode: 'badge',
            thumbnailAnnotationPageCounts: [
              { annotationPageIndex: 0, annotationCount: 1 },
              { annotationPageIndex: 1, annotationCount: 2 },
            ],
            thumbnailAnnotationRefreshCount: 3,
            canvasPointerBlockedAfterAnnotation: false,
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual).toMatchObject({
      builderSnapshotEmptyPassive: true,
      builderSnapshotIgnoredForActiveArtifact: true,
      artifactStageProtectedFromSnapshot: true,
      artifactStageUnmountPrevented: true,
      thumbnailAnnotationIndicatorMode: 'badge',
      thumbnailAnnotationRefreshCount: 3,
      canvasPointerBlockedAfterAnnotation: false,
    });
    expect(metrics.coreview.visual.thumbnailAnnotationPageCounts).toEqual([
      { annotationPageIndex: 0, annotationCount: 1 },
      { annotationPageIndex: 1, annotationCount: 2 },
    ]);
  });

  it('reports review tool timeouts as resolved safe tool results', () => {
    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events: [
        buildEvent({
          seq: 1,
          at: '2026-05-27T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'session-dev' },
        }),
        buildEvent({
          seq: 2,
          at: '2026-05-27T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-tool-loop-diagnostic',
          payload: {
            runtime: 'gemini_live',
            phase: 'tool_call_received',
            toolName: 'read_artifact_text',
            diagnostic: { toolCall: { name: 'read_artifact_text', args: null } },
          },
        }),
        buildEvent({
          seq: 3,
          at: '2026-05-27T12:00:01.900Z',
          category: 'voice-session',
          name: 'gemini-tool-loop-diagnostic',
          payload: {
            runtime: 'gemini_live',
            phase: 'tool_response_sent',
            toolName: 'read_artifact_text',
            success: false,
            diagnostic: {
              toolCall: { name: 'read_artifact_text', args: null },
              reviewToolTimedOut: true,
              reviewToolTimeoutName: 'read_artifact_text',
              reviewToolTimeoutResultSent: true,
              backendResponse: {
                ok: false,
                status: 'timeout',
                safe_reason: 'Trusted artifact text read timed out before the voice response deadline.',
                review_tool_timed_out: true,
                review_tool_timeout_name: 'read_artifact_text',
                review_tool_timeout_result_sent: true,
                raw_artifact_text_excluded: true,
              },
            },
          },
        }),
      ],
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:04.000Z'),
    });

    expect(metrics.coreview.visual.reviewToolTimedOut).toBe(true);
    expect(metrics.coreview.visual.reviewToolTimeoutName).toBe('read_artifact_text');
    expect(metrics.coreview.visual.reviewToolTimeoutResultSent).toBe(true);
    expect(metrics.coreview.exactText.readArtifactTextTimeoutCount).toBe(1);
    expect(metrics.coreview.exactText.readArtifactTextLastStatus).toBe('timeout');
    expect(metrics.coreview.exactText.readArtifactTextResolvedCount).toBe(1);
    expect(metrics.coreview.exactText.readArtifactTextUnresolvedCount).toBe(0);
  });

  it('counts Coreview frame and exact-text failures without raw payloads', () => {
    const events: VoiceCaptureEvent[] = [
      buildEvent({
        seq: 1,
        at: '2026-05-27T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'session-dev' },
      }),
      buildEvent({
        seq: 2,
        at: '2026-05-27T12:00:01.000Z',
        category: 'voice-session',
        name: 'gemini-artifact-frame-send',
        payload: {
          runtime: 'gemini_live',
          result: {
            coreviewSendStage: 'start',
            artifactId: 'artifact-1',
            ok: false,
            websocketSendAccepted: true,
            websocketClosedAfterFrameSend: true,
            frameBytes: 1024,
            frameDimensions: { width: 640, height: 360 },
            frameSendLatencyMs: 9,
            error: 'frame_send_closed_gemini_websocket',
            rawFrameExcluded: true,
          },
        },
      }),
      buildEvent({
        seq: 3,
        at: '2026-05-27T12:00:02.000Z',
        category: 'voice-session',
        name: 'gemini-tool-loop-diagnostic',
        payload: {
          runtime: 'gemini_live',
          phase: 'tool_response_sent',
          toolName: 'read_artifact_text',
          success: false,
          diagnostic: {
            toolCall: { name: 'read_artifact_text', args: null },
            backendResponse: {
              ok: false,
              status: 'forbidden',
              safe_reason: 'The artifact text source is registered for a different session or thread.',
              char_count: 0,
              latency_ms: 3,
              raw_artifact_text_excluded: true,
            },
          },
        },
      }),
    ];

    const metrics = buildVoiceDeveloperMetrics({
      stage: 'listening',
      events,
      snapshot: buildSnapshot(),
      nowMs: Date.parse('2026-05-27T12:00:04.000Z'),
    });
    const serialized = JSON.stringify(metrics.coreview);

    expect(metrics.coreview.visual.frameSendFailureCount).toBe(1);
    expect(metrics.coreview.visual.lastFrameSendFailureReason).toBe('frame_send_closed_gemini_websocket');
    expect(metrics.coreview.visual.websocketClosedAfterFrameCount).toBe(1);
    expect(metrics.coreview.visual.exactTextAvailable).toBe(false);
    expect(metrics.coreview.exactText.exactTextFailureCount).toBe(1);
    expect(metrics.coreview.exactText.readArtifactTextCallCount).toBe(1);
    expect(metrics.coreview.exactText.exactTextSources.unsupported).toBe(1);
    expect(metrics.coreview.exactText.lastExactTextStatus).toBe('forbidden');
    expect(serialized).not.toContain('base64');
    expect(serialized).not.toContain('raw artifact body');
  });
});
