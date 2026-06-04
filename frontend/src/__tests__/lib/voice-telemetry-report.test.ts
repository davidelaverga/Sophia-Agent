import { describe, expect, it } from 'vitest';

import type { SophiaCaptureBundle, SophiaCaptureSnapshot } from '../../app/lib/session-capture';
import type { VoiceDeveloperMetrics, VoiceTelemetrySummary } from '../../app/lib/voice-runtime-metrics';
import { buildVoiceTelemetryReport } from '../../app/lib/voice-telemetry-report';

function buildSnapshot(): SophiaCaptureSnapshot {
  return {
    capturedAt: '2026-05-20T12:00:03.000Z',
    location: {
      href: 'http://localhost:3000/session?access_token=page-secret',
      pathname: '/session',
      title: 'Sophia',
      theme: 'dark',
    },
    debug: {
      session_id: 'current-session',
      thread_id: 'current-thread',
      streamStatus: 'connected',
    },
    session: {
      sessionId: 'current-session',
      threadId: 'current-thread',
      status: 'active',
      isActive: true,
      presetType: 'voice',
      contextMode: 'life',
      voiceMode: true,
      startedAt: '2026-05-20T12:00:00.000Z',
      endedAt: null,
      lastActivityAt: '2026-05-20T12:00:02.000Z',
      messageCount: 2,
    },
    transcript: {
      chatMessages: [
        {
          id: 'old-chat-message',
          role: 'user',
          content: 'old private chat store text',
          createdAt: 1,
          source: null,
          status: null,
          incomplete: false,
          audioUrl: null,
        },
      ],
      voiceMessages: [
        {
          id: 'old-voice-message',
          content: 'old private voice store text',
          timestamp: 1,
        },
      ],
      dom: {
        articleCount: 2,
        articles: [{ label: 'old article', text: 'old private rendered transcript' }],
      },
    },
    artifacts: {
      sessionArtifacts: { takeaway: 'old private session artifact' },
      recapArtifacts: { takeaway: 'persisted recap artifact text' },
      recapCommitStatus: 'pending',
      dom: {
        railLabel: 'Artifacts: ready',
        takeawayText: 'rendered private takeaway',
        reflectionText: 'rendered private reflection',
        memoriesText: 'rendered private memories',
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
        lastAudioAt: '2026-05-20T12:00:02.500Z',
        maxAbsPeak: 0.4,
        maxRms: 0.03,
        nonSilentSampleWindows: 4,
        patchInstalled: true,
        streamCount: 1,
        streams: [],
        totalSampleWindows: 8,
        tracks: [],
      },
    },
    metadata: {
      currentSessionId: 'current-session',
      currentThreadId: 'current-thread',
      currentRunId: 'current-run',
      emotionalWeather: { private: 'old emotional weather' },
    },
    presence: {
      labels: ['Sophia is listening'],
    },
    storage: {
      'sophia-session-store': {
        state: {
          sessions: [{ id: 'archived-session', messages: ['old archived session message'] }],
        },
      },
      'sophia-recap': {
        state: {
          artifacts: { archived: 'persisted sophia-recap history' },
        },
      },
      'sophia-session-history': {
        state: {
          sessions: [{ id: 'older-history-record' }],
        },
      },
    },
  };
}

function buildCaptureBundle(events: SophiaCaptureBundle['events']): SophiaCaptureBundle {
  return {
    startedAt: '2026-05-20T11:59:00.000Z',
    exportedAt: '2026-05-20T12:00:04.000Z',
    eventCount: events.length,
    events,
    snapshot: buildSnapshot(),
  };
}

function buildMetrics(): VoiceDeveloperMetrics {
  return {
    stage: 'listening',
    sessionTelemetry: {
      runtime: 'gemini_live',
      runtimeLabel: 'Gemini Live',
      source: 'voice-connect',
      legacy: null,
      gemini: {
        sessionId: 'gemini-session',
        streamUrl: '/api/sophia/voice/gemini/events/gemini-session',
        websocketUrl: 'wss://generativelanguage.googleapis.com/ws?access_token=auth_tokens/sensitive-gemini-token&alt=sse',
        relayUrl: '/api/sophia/voice/gemini/relay/gemini-session',
        transport: 'browser_live_websocket',
        publicEventBoundary: '/api/sophia/voice/gemini/events/gemini-session',
        connectionState: 'connected',
        stage: 'connected',
        websocketState: 'setup_complete',
        relayStatus: 'active',
        publicSseState: 'connected',
        microphoneState: 'connected',
        remoteAudioState: 'active',
        setupComplete: true,
        providerEventCount: 3,
        lastProviderEventAt: '2026-05-20T12:00:02.000Z',
        lastProviderEventType: 'serverContent',
        providerCategoryCounts: {
          toolCall: { count: 1, lastAt: '2026-05-20T12:00:02.000Z' },
        },
        outputAudioEventCount: 1,
        lastOutputAudioAt: '2026-05-20T12:00:02.500Z',
        staleAssistantAudioDroppedCount: 0,
        staleAssistantTranscriptDroppedCount: 0,
        staleAssistantOutputSuppressionCount: 0,
        playbackGeneration: 0,
        assistantUserOverlapMs: 0,
        maxAssistantUserOverlapMs: 0,
        rawAssistantUserOverlapMs: 0,
        maxRawAssistantUserOverlapMs: 0,
        confirmedAssistantUserOverlapMs: 0,
        maxConfirmedAssistantUserOverlapMs: 0,
        userInputActiveAgeMs: null,
        bargeInConfirmed: false,
        bargeInConfirmationSource: 'none',
        bargeInConfirmationReason: null,
        bargeInCandidateFrameCount: 0,
        inputFrameOnlyNotBargeInCount: 0,
        candidateFramesDidNotConfirmCount: 0,
        candidateExpiredCount: 0,
        suppressionBlockedBecauseNoIntentCount: 0,
        staleSuppressionArmedAt: null,
        staleSuppressionArmedBy: null,
        assistantAudioDropReason: null,
        interruptedResponseIds: [],
        interruptionCount: 0,
        playbackFlushCount: 0,
        lastInterruptionAt: null,
        lastPlaybackFlushAt: null,
        relayDiagnosticCount: 1,
        lastRelayDiagnosticAt: '2026-05-20T12:00:02.100Z',
        lastRelayEventType: 'toolCall',
        relayAttemptCount: 1,
        relaySuccessCount: 1,
        relayFailureCount: 0,
        relayTraceCount: 1,
        lastRelayTraceAt: '2026-05-20T12:00:02.100Z',
        lastRelayCorrelationId: 'gemini-event-1',
        lastRelayResponseKind: 'client_actions',
        lastRelayDurationMs: 12,
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
        lastToolAt: '2026-05-20T12:00:02.100Z',
        toolCallLedger: [
          {
            toolCallId: 'tool-call-1',
            toolName: 'emit_artifact',
            receivedAt: '2026-05-20T12:00:02.000Z',
            cancelledAt: null,
            relayStartedAt: '2026-05-20T12:00:02.010Z',
            relayCompletedAt: '2026-05-20T12:00:02.100Z',
            backendAcceptedAt: '2026-05-20T12:00:02.030Z',
            toolResponsePreparedAt: '2026-05-20T12:00:02.100Z',
            toolResponseSentAt: '2026-05-20T12:00:02.110Z',
            sendSuppressedAt: null,
            suppressionReason: null,
            finalState: 'responded',
          },
        ],
        publicTurnCount: 1,
        artifactCount: 1,
        publicDiagnosticCount: 1,
        lastUserTranscriptAt: '2026-05-20T12:00:01.500Z',
        lastAssistantTranscriptAt: '2026-05-20T12:00:02.500Z',
        lastEventAgeMs: 100,
      },
    },
    sessionIds: {
      sessionId: 'current-session',
      threadId: 'current-thread',
      callId: null,
      voiceAgentSessionId: 'gemini-session',
      runId: 'current-run',
    },
    counts: {
      turns: 1,
      userTranscripts: 1,
      assistantTranscripts: 1,
      artifacts: 1,
      diagnostics: 1,
      builderEvents: 0,
    },
    coreview: {
      visual: {
        coreviewEnabled: true,
        coreviewSessionActive: true,
        coreviewArtifactId: 'artifact-1',
        visualSourceKind: 'canvas_element',
        frameSentCount: 1,
        initialFrameSent: true,
        visualFresh: true,
        visualFreshForTurn: true,
        exactTextAvailable: true,
        refreshFrameCount: 0,
        lastFrameBytes: 1024,
        lastFrameDimensions: { width: 640, height: 360 },
        totalFrameBytes: 1024,
        lastFrameSendLatencyMs: 12,
        maxFrameSendLatencyMs: 12,
        frameSendFailureCount: 0,
        lastFrameSendFailureReason: null,
        websocketClosedAfterFrameCount: 0,
        providerUsageImageCount: 1,
        providerUsageVideoDurationSeconds: 0.25,
        providerUsageAudioDurationSeconds: 2,
        visualResponseObserved: true,
        toolCallAfterFrameObserved: true,
        coreviewToolCompletedCount: 1,
        coreviewToolUnresolvedCount: 0,
        coreviewToolLastResult: 'success',
        coreviewToolRefreshResult: 'success',
        coreviewToolVisualFreshAfterResult: true,
        providerToPublicTranscriptGapAfterCoreviewTool: 0,
        followUpTurnDispatchedAfterCoreviewTool: true,
        emitArtifactBlockedDuringReviewCount: 0,
        rawFrameExcluded: true,
        rawProviderPayloadExcluded: true,
      },
      exactText: {
        exactTextCallCount: 1,
        readArtifactTextCallCount: 1,
        exactTextSuccessCount: 1,
        exactTextFailureCount: 0,
        exactTextSources: {
          fixture: 0,
          builder_metadata: 1,
          artifact_store: 0,
          unsupported: 0,
        },
        lastExactTextStatus: 'success',
        lastExactTextSource: 'builder_metadata',
        lastExactTextCharCount: 77,
        lastExactTextTruncated: false,
        lastExactTextLatencyMs: 4,
        readArtifactTextResolvedCount: 1,
        readArtifactTextUnresolvedCount: 0,
        readArtifactTextPdfExtractionStatus: null,
        rawArtifactTextExcluded: true,
        rawQueryExcluded: true,
      },
    },
  } as unknown as VoiceDeveloperMetrics;
}

function buildSummary(): VoiceTelemetrySummary {
  return {
    runtime: 'gemini_live',
    runtimeLabel: 'Gemini Live',
    stage: 'listening',
    healthLevel: 'good',
    healthTitle: 'Healthy',
    bottleneckKind: 'healthy',
    bottleneckLevel: 'good',
    transportSource: 'sse',
    regressionKeys: [],
    sessionReadyMs: 1200,
    joinLatencyMs: null,
    committedResponseMs: 400,
    committedResponseSource: 'public_turn_event',
    publicTurnCloseMs: 400,
    submissionStabilizationMs: null,
    committedFirstTextMs: 500,
    rawFirstTextMs: null,
    rawBackendCompleteMs: null,
    rawFirstAudioMs: null,
    responseWindowMs: 1000,
    builderPhase: null,
    builderProgressPercent: null,
    builderStuck: false,
  };
}

describe('buildVoiceTelemetryReport', () => {
  it('keeps current-run telemetry and excludes persisted history snapshots', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T11:50:00.000Z',
          category: 'voice-sse',
          name: 'sophia.transcript',
          payload: { data: { text: 'old archived event text', sessionId: 'archived-session' } },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 3,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-provider-event-correlation',
          payload: { telemetry: { categories: ['toolCall'], correlationId: 'gemini-event-1' } },
        },
        {
          seq: 4,
          recordedAt: '2026-05-20T12:00:02.000Z',
          category: 'voice-session',
          name: 'gemini-relay-trace',
          payload: {
            trace: {
              correlationId: 'gemini-event-1',
              responseKind: 'client_actions',
              throughput: {
                orderedRelayQueueDepth: 2,
                oldestQueuedAgeMs: 180,
                transcriptPartialsCoalesced: 0,
                transcriptPartialsSent: 5,
                transcriptPartialsDropped: 0,
                transcriptCoalescingDisabledReason: 'provider_output_transcription_is_delta_like',
                finalTranscriptEventsSent: 1,
                nonDroppableCriticalEventsSent: 4,
                lastTranscriptRelayLatencyMs: 120,
                maxTranscriptRelayLatencyMs: 240,
                p95TranscriptRelayLatencyMs: 220,
                coalescedBySegment: {},
              },
              backendDiagnostics: {
                session_id: 'gemini-session',
                raw_provider_events_accepted: 100,
                provider_category_counts: { serverContent: 90, toolCall: 2, sessionResumptionUpdate: 8 },
                function_calls_extracted: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`tool-${index}`, 'emit_artifact'])),
                cancellation_ids_observed: Array.from({ length: 12 }, (_, index) => `cancel-${index}`),
                tool_execution_counts: { started: 2, finished: 2 },
                tool_execution_recent: Array.from({ length: 12 }, (_, index) => ({ phase: 'finished', tool_call_id: `tool-${index}`, tool_name: 'emit_artifact' })),
                provider_events_pushed_into_mapper: 100,
                provider_event_mapping_outputs: { assistant_text_delta: 9, artifact_payload: 2 },
                public_sophia_emitted_counts: { 'sophia.transcript': 9, 'sophia.artifact': 2 },
              },
            },
          },
        },
        {
          seq: 5,
          recordedAt: '2026-05-20T12:00:03.000Z',
          category: 'voice-session',
          name: 'gemini-tool-call-ledger',
          payload: { entry: { toolCallId: 'tool-call-1', finalState: 'responded' } },
        },
      ]),
    });

    expect(report.reportType).toBe('voice-telemetry-report');
    expect(report.version).toBe(2);
    expect(report.source).toBe('session-ui');
    expect(report.captureBundle.scope.strategy).toBe('last-start-event');
    expect(report.captureBundle.eventCount).toBe(4);
    expect(report.captureBundle.events.map((event) => event.name)).toEqual([
      'start-talking-requested',
      'gemini-provider-event-correlation',
      'gemini-relay-trace',
      'gemini-tool-call-ledger',
    ]);

    const serialized = JSON.stringify(report);
    expect(serialized).toContain('gemini-provider-event-correlation');
    expect(serialized).toContain('gemini-relay-trace');
    expect(serialized).toContain('gemini-tool-call-ledger');
    expect(serialized).toContain('tool-call-1');
    expect(report.diagnosticsSummary.geminiRelayBackend).toMatchObject({
      schema: 'gemini_relay_backend_summary_v1',
      maxRawProviderEventsAccepted: 100,
      maxFunctionCallsExtractedCount: 20,
      maxCancellationIdsObservedCount: 12,
    });
    expect(report.diagnosticsSummary.geminiRelayThroughput).toMatchObject({
      schema: 'gemini_relay_throughput_summary_v1',
      warnings: [],
      relayTraceCountWithThroughput: 1,
      maxOrderedRelayQueueDepth: 2,
      maxOldestQueuedAgeMs: 180,
      transcriptPartialsCoalesced: 0,
      transcriptPartialsDropped: 0,
      transcriptCoalescingDisabledReason: 'provider_output_transcription_is_delta_like',
      p95TranscriptRelayLatencyMs: 220,
    });
    expect(report.diagnosticsSummary.artifactReview).toMatchObject({
      schema: 'artifact_review_summary_v1',
      warnings: expect.arrayContaining(['artifact_count_mismatch', 'review_emit_artifact_tool_churn_detected']),
      artifactCount: 1,
      artifactRuntimeIngestCount: 0,
      artifactRenderedCount: 1,
      artifactCountMismatchReason: 'rendered_state_without_runtime_ingest',
      emitArtifactToolCallCount: 1,
      emitArtifactBlockedDuringReviewCount: 0,
      rawArtifactTextExcluded: true,
    });
    expect(report.diagnosticsSummary.coreviewStillFrame).toMatchObject({
      schema: 'coreview_still_frame_summary_v1',
      coreviewEnabled: true,
      coreviewSessionActive: true,
      coreviewArtifactId: 'artifact-1',
      visualSourceKind: 'canvas_element',
      frameSentCount: 1,
      initialFrameSent: true,
      visualFresh: true,
      visualFreshForTurn: true,
      exactTextAvailable: true,
      exactTextCallCount: 1,
      exactTextSuccessCount: 1,
      readArtifactTextCallCount: 1,
      coreviewToolCompletedCount: 1,
      coreviewToolUnresolvedCount: 0,
      coreviewToolRefreshResult: 'success',
      coreviewToolVisualFreshAfterResult: true,
      readArtifactTextResolvedCount: 1,
      readArtifactTextUnresolvedCount: 0,
      rawFrameExcluded: true,
      rawProviderPayloadExcluded: true,
      rawArtifactTextExcluded: true,
    });
    const relayTrace = report.captureBundle.events.find((event) => event.name === 'gemini-relay-trace')?.payload as { trace?: { backendDiagnostics?: Record<string, unknown> } };
    expect(relayTrace?.trace?.backendDiagnostics).toMatchObject({
      schema: 'gemini_backend_diagnostics_compact_v1',
      function_calls_extracted_count: 20,
      cancellation_ids_observed_count: 12,
    });
    expect(relayTrace?.trace?.backendDiagnostics).not.toHaveProperty('function_calls_extracted');
    expect(relayTrace?.trace?.backendDiagnostics).not.toHaveProperty('cancellation_ids_observed');
    expect(relayTrace?.trace?.backendDiagnostics).not.toHaveProperty('tool_execution_recent');
    expect(report.turnCaptureDiagnostics.version).toBe(2);
    expect(report.turnCaptureDiagnostics.sourceEventCount).toBe(4);
    expect(serialized).not.toContain('old archived event text');
    expect(serialized).not.toContain('old private chat store text');
    expect(serialized).not.toContain('old private voice store text');
    expect(serialized).not.toContain('persisted sophia-recap history');
    expect(serialized).not.toContain('older-history-record');
    expect(report.captureBundle.snapshot.storage).toEqual({});
    expect(report.captureBundle.snapshot.transcript.chatMessages).toEqual([]);
    expect(report.captureBundle.snapshot.transcript.voiceMessages).toEqual([]);
    expect(report.captureBundle.snapshot.artifacts.sessionArtifacts).toBeNull();
    expect(report.captureBundle.snapshot.artifacts.recapArtifacts).toBeNull();
  });

  it('does not flag review emit churn when emit_artifact was explicitly suppressed by the review guard', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:04.000Z',
      metrics: buildMetrics(),
      summary: buildSummary(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-tool-loop-diagnostic',
          payload: {
            data: {
              phase: 'tool_execution_rejected',
              toolName: 'emit_artifact',
              diagnostic: {
                toolCall: { id: 'artifact-call-1', name: 'emit_artifact' },
                rejection_reason: 'artifact_review_emit_artifact_suppressed',
              },
            },
          },
        },
      ]),
    });

    const warnings = report.diagnosticsSummary.artifactReview.warnings as string[];

    expect(warnings).not.toContain('review_emit_artifact_tool_churn_detected');
    expect(warnings).not.toContain('review_tool_churn_suppressed');
  });

  it('adds compact warnings for Gemini stale output, relay backlog, overlap, and unresolved tools', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:04.000Z',
      metrics: buildMetrics(),
      summary: buildSummary(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-interruption',
          payload: {
            diagnostic: {
              timestamp: '2026-05-20T12:00:01.000Z',
              assistantUserOverlapMs: 3100,
              rawAssistantUserOverlapMs: 3100,
              confirmedAssistantUserOverlapMs: 3100,
              bargeInConfirmationSource: 'provider_interruption',
              bargeInConfirmationReason: 'gemini_server_interrupted_event',
              interruptedResponseIds: ['response-stale'],
            },
          },
        },
        {
          seq: 3,
          recordedAt: '2026-05-20T12:00:01.100Z',
          category: 'voice-session',
          name: 'gemini-stale-output-suppressed',
          payload: {
            diagnostic: {
              outputType: 'audio',
              reason: 'interrupted_response_id',
              userInputActiveAgeMs: 350,
              bargeInConfirmed: true,
              bargeInConfirmationSource: 'provider_interruption',
              bargeInConfirmationReason: 'gemini_server_interrupted_event',
              bargeInCandidateFrameCount: 4,
              staleSuppressionArmedAt: '2026-05-20T12:00:01.000Z',
              staleSuppressionArmedBy: 'provider_interruption',
              assistantAudioDropReason: 'interrupted_response_id',
              inputFrameOnlyNotBargeInCount: 2,
              candidateFramesDidNotConfirmCount: 2,
              candidateExpiredCount: 0,
              suppressionBlockedBecauseNoIntentCount: 0,
              rawAssistantUserOverlapMs: 3100,
              confirmedAssistantUserOverlapMs: 3100,
            },
          },
        },
        {
          seq: 4,
          recordedAt: '2026-05-20T12:00:01.150Z',
          category: 'voice-session',
          name: 'gemini-barge-in-transcript-handoff',
          payload: {
            diagnostic: {
              transcriptPreview: 'Actually pause there',
              captured: true,
              promoted: true,
              ignored: false,
              duplicateSuppressed: false,
              promotionLatencyMs: 80,
              newTurnDispatched: true,
              newTurnDispatchBlockedReason: 'none',
              bargeInTranscriptCapturedCount: 1,
              bargeInTranscriptPromotedCount: 1,
              bargeInTranscriptPromotionLatencyMs: 80,
              bargeInTranscriptIgnoredCount: 0,
              bargeInTranscriptDuplicateSuppressedCount: 0,
              lastBargeInTranscriptPreview: 'Actually pause there',
              bargeInNewTurnDispatchCount: 1,
              bargeInNewTurnDispatchBlockedReason: 'none',
            },
          },
        },
        {
          seq: 5,
          recordedAt: '2026-05-20T12:00:01.200Z',
          category: 'voice-session',
          name: 'stale-assistant-transcript-ignored',
          payload: { reason: 'interrupted_or_pre_barge_in_assistant_transcript' },
        },
        {
          seq: 6,
          recordedAt: '2026-05-20T12:00:02.000Z',
          category: 'voice-session',
          name: 'gemini-relay-trace',
          payload: {
            trace: {
              throughput: {
                orderedRelayQueueDepth: 105,
                oldestQueuedAgeMs: 109707,
                transcriptPartialsCoalesced: 0,
                transcriptPartialsSent: 18,
                transcriptPartialsDropped: 0,
                transcriptCoalescingDisabledReason: 'provider_output_transcription_is_delta_like',
                finalTranscriptEventsSent: 0,
                nonDroppableCriticalEventsSent: 4,
                lastTranscriptRelayLatencyMs: 109931,
                maxTranscriptRelayLatencyMs: 109931,
                p95TranscriptRelayLatencyMs: 106203,
                coalescedBySegment: {},
              },
            },
          },
        },
        {
          seq: 7,
          recordedAt: '2026-05-20T12:00:03.000Z',
          category: 'voice-session',
          name: 'gemini-tool-call-ledger',
          payload: {
            entry: {
              toolCallId: 'artifact-call-unknown',
              toolName: 'emit_artifact',
              finalState: 'unknown',
            },
          },
        },
      ]),
    });

    expect(report.diagnosticsSummary.geminiStaleOutput).toMatchObject({
      schema: 'gemini_stale_output_diagnostics_summary_v1',
      warnings: expect.arrayContaining([
        'stale_assistant_output_suppressed',
        'transcript_relay_backlog_exceeded',
        'unresolved_gemini_tool_calls',
        'assistant_audio_overlapped_user_input',
      ]),
      staleAssistantAudioDroppedCount: 1,
      staleAssistantTranscriptDroppedCount: 1,
      maxAssistantUserOverlapMs: 3100,
      maxRawAssistantUserOverlapMs: 3100,
      maxConfirmedAssistantUserOverlapMs: 3100,
      userInputActiveAgeMs: 350,
      bargeInConfirmed: true,
      bargeInConfirmationSource: 'provider_interruption',
      bargeInCandidateFrameCount: 4,
      staleSuppressionArmedAt: '2026-05-20T12:00:01.000Z',
      staleSuppressionArmedBy: 'provider_interruption',
      assistantAudioDropReason: 'interrupted_response_id',
      inputFrameOnlyNotBargeInCount: 2,
      candidateFramesDidNotConfirmCount: 2,
      suppressionBlockedBecauseNoIntentCount: 0,
      bargeInTranscriptCapturedCount: 1,
      bargeInTranscriptPromotedCount: 1,
      bargeInTranscriptPromotionLatencyMs: 80,
      bargeInTranscriptIgnoredCount: 0,
      bargeInTranscriptDuplicateSuppressedCount: 0,
      lastBargeInTranscriptPreview: 'Actually pause there',
      bargeInNewTurnDispatchCount: 1,
      bargeInNewTurnDispatchBlockedReason: 'none',
      maxOldestQueuedAgeMs: 109707,
      maxTranscriptRelayLatencyMs: 109931,
      unresolvedToolCallCount: 1,
      artifactToolCallUnknownCount: 1,
    });
    expect(report.diagnosticsSummary.geminiRelayThroughput).toMatchObject({
      warnings: expect.arrayContaining([
        'public_transcript_relay_latency_high',
        'relay_queue_depth_high',
      ]),
      maxOrderedRelayQueueDepth: 105,
      maxTranscriptRelayLatencyMs: 109931,
      p95TranscriptRelayLatencyMs: 106203,
    });
  });

  it('reconciles rendered artifact state into exported artifact counts', () => {
    const staleMetrics = buildMetrics();
    staleMetrics.counts.artifacts = 0;
    if (staleMetrics.sessionTelemetry.runtime === 'gemini_live') {
      staleMetrics.sessionTelemetry.gemini.artifactCount = 0;
    }

    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: staleMetrics,
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:00.800Z',
          category: 'voice-session',
          name: 'coreview-state',
          payload: {
            data: {
              coreview: {
                coreviewEnabled: true,
                coreviewSessionActive: true,
                coreviewArtifactId: 'artifact-1',
                visualSourceKind: 'offscreen_render',
                frameSentCount: 1,
                initialFrameSent: true,
                exactTextAvailable: true,
              },
            },
          },
        },
        {
          seq: 3,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-tool-call-ledger',
          payload: { entry: { toolCallId: 'tool-call-1', finalState: 'responded' } },
        },
      ]),
    });

    expect(report.metrics.counts.artifacts).toBe(1);
    expect(report.metrics.counts.artifactPublicEventCount).toBe(0);
    expect(report.metrics.counts.artifactRenderedCount).toBe(1);
    expect(report.metrics.counts.artifactSelectedStageCount).toBe(1);
    expect(report.metrics.counts.artifactCountSource).toBe('selected_stage_artifact');
    expect(report.metrics.counts.artifactCountMismatch).toBe(true);
    expect(report.metrics.counts.artifactCountMismatchReason).toBe('selected_stage_artifact_not_public_event');
    expect(report.metrics.sessionTelemetry.gemini?.artifactCount).toBe(1);
    expect(report.metrics.sessionTelemetry.gemini?.artifactPublicEventCount).toBe(0);
    expect(report.metrics.sessionTelemetry.gemini?.artifactRuntimeIngestCount).toBe(1);
    expect(report.metrics.sessionTelemetry.gemini?.artifactSelectedStageCount).toBe(1);
    expect(report.metrics.sessionTelemetry.gemini?.artifactRenderedCount).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.finalUiState.artifactCount).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.finalUiState.artifactCountSource).toBe('selected_stage_artifact');
    expect(report.turnCaptureDiagnostics.summary.finalUiState.artifactCountMismatchReason).toBe('selected_stage_artifact_not_public_event');
    expect(report.diagnosticsSummary.artifactReview).toMatchObject({
      warnings: expect.arrayContaining(['artifact_count_mismatch']),
      artifactCountMismatchReason: 'selected_stage_artifact_not_public_event',
    });
  });

  it('redacts auth-bearing transport material while keeping transport diagnostics readable', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-websocket-diagnostic',
          payload: {
            websocketUrl: 'wss://generativelanguage.googleapis.com/ws?access_token=auth_tokens/event-secret-token',
            ephemeral_token: { value: 'ephemeral-secret-token' },
            authorization: 'Bearer bearer-secret-token',
          },
        },
      ]),
    });

    const serialized = JSON.stringify(report);
    const websocketUrl = report.metrics.sessionTelemetry.gemini?.websocketUrl ?? '';

    expect(websocketUrl).toContain('wss://generativelanguage.googleapis.com/ws');
    expect(websocketUrl).toContain('access_token=');
    expect(websocketUrl.toLowerCase()).toContain('redacted');
    expect(serialized).not.toContain('sensitive-gemini-token');
    expect(serialized).not.toContain('event-secret-token');
    expect(serialized).not.toContain('ephemeral-secret-token');
    expect(serialized).not.toContain('bearer-secret-token');
    expect(serialized).not.toContain('page-secret');
  });

  it('keeps safe retrieve_memories attribution in compact backend diagnostics', () => {
    const rawMemoryText = 'Luis said his favorite childhood movie was The Lord of the Rings.';
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:02.000Z',
          category: 'voice-session',
          name: 'gemini-relay-trace',
          payload: {
            trace: {
              backendDiagnostics: {
                session_id: 'gemini-session',
                raw_provider_events_accepted: 1,
                provider_category_counts: { toolCall: 1 },
                function_calls_extracted_count: 1,
                tool_execution_counts: { finished: 1 },
                tool_execution_recent: [
                  {
                    phase: 'finished',
                    tool_call_id: 'memory-call-1',
                    tool_name: 'retrieve_memories',
                    recorded_at: 1770000000,
                    status: 'success',
                    count: 1,
                    has_results: true,
                    query_fingerprint: 'sha256:query1234567890',
                    query_length: 35,
                    query_term_count: 5,
                    raw_query_excluded: true,
                    result_fingerprints: [
                      {
                        rank: 1,
                        text_fingerprint: 'sha256:memory123456789',
                        text_length: rawMemoryText.length,
                        query_terms_matched_count: 5,
                        query_term_count: 5,
                        exact_query_terms_present: true,
                        unsafe_preview: rawMemoryText,
                      },
                    ],
                    result_text_lengths: [rawMemoryText.length],
                    result_preview_included: false,
                    raw_memory_text_excluded: true,
                    unsafe_preview: rawMemoryText,
                  },
                ],
                provider_events_pushed_into_mapper: 1,
                provider_event_mapping_outputs: {},
                public_sophia_emitted_counts: {},
              },
            },
          },
        },
      ]),
    });

    const latestToolExecution = report.diagnosticsSummary.geminiRelayBackend?.latestToolExecution;
    const relayTrace = report.captureBundle.events.find((event) => event.name === 'gemini-relay-trace')?.payload as { trace?: { backendDiagnostics?: Record<string, unknown> } };
    const compactLatest = relayTrace?.trace?.backendDiagnostics?.latest_tool_execution as Record<string, unknown> | undefined;
    const serialized = JSON.stringify(report);

    expect(latestToolExecution).toMatchObject({
      tool_name: 'retrieve_memories',
      status: 'success',
      count: 1,
      has_results: true,
      query_fingerprint: 'sha256:query1234567890',
      raw_query_excluded: true,
      raw_memory_text_excluded: true,
      result_fingerprints: [
        {
          rank: 1,
          text_fingerprint: 'sha256:memory123456789',
          text_length: rawMemoryText.length,
          query_terms_matched_count: 5,
          query_term_count: 5,
          exact_query_terms_present: true,
        },
      ],
    });
    expect(compactLatest).toMatchObject({
      tool_name: 'retrieve_memories',
      result_preview_included: false,
      result_text_lengths: [rawMemoryText.length],
    });
    expect(serialized).not.toContain(rawMemoryText);
    expect(serialized).not.toContain('unsafe_preview');
  });

  it('falls back to current session id scoping when no start event is present', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T11:50:00.000Z',
          category: 'voice-sse',
          name: 'sophia.transcript',
          payload: { data: { text: 'old event for another session', sessionId: 'archived-session' } },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-sse',
          name: 'sophia.transcript',
          payload: { data: { text: 'current run text', sessionId: 'current-session' } },
        },
      ]),
    });

    expect(report.captureBundle.scope.strategy).toBe('current-session-id');
    expect(report.captureBundle.events).toHaveLength(1);
    expect(JSON.stringify(report)).toContain('current run text');
    expect(JSON.stringify(report)).not.toContain('old event for another session');
  });

  it('adds compact current-run turn capture evidence without raw audio payloads', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:00.100Z',
          category: 'voice-session',
          name: 'gemini-stage-changed',
          payload: { stage: 'streaming_audio', microphoneState: 'connected', remoteAudioState: 'idle' },
        },
        {
          seq: 3,
          recordedAt: '2026-05-20T12:00:00.250Z',
          category: 'voice-session',
          name: 'gemini-input-audio-activity',
          payload: {
            diagnostic: {
              eventType: 'input_audio_frame_sent',
              localSequence: 1,
              audioFrameSequence: 1,
              framesRepresented: 1,
              micState: 'unmuted',
              frameByteLength: 2730,
              frameDurationMs: 85,
              rawAudioData: 'do-not-export-raw-audio',
            },
          },
        },
        {
          seq: 4,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-provider-event-correlation',
          payload: {
            telemetry: {
              categories: ['inputTranscription'],
              providerReceiveSequence: 11,
              correlationId: 'relay-11',
              inputTranscriptionTextPreview: 'Quick question before I go. Reflect briefly on what I just said.',
            },
          },
        },
        {
          seq: 5,
          recordedAt: '2026-05-20T12:00:01.100Z',
          category: 'voice-session',
          name: 'gemini-barge-in-transcript-handoff',
          payload: {
            diagnostic: {
              providerReceiveSequence: 11,
              relayCorrelationId: 'relay-11',
              transcriptPreview: 'Quick question before I go. Reflect briefly on what I just said.',
              captured: true,
              promoted: true,
              newTurnDispatched: true,
              bargeInNewTurnDispatchBlockedReason: 'none',
            },
          },
        },
        {
          seq: 6,
          recordedAt: '2026-05-20T12:00:01.200Z',
          category: 'voice-sse',
          name: 'sophia.user_transcript',
          payload: {
            data: {
              text: 'Quick question before I go. Reflect briefly on what I just said.',
              utterance_id: 'utt-1',
              source_sequence: 11,
              relay_correlation_id: 'relay-11',
            },
          },
        },
        {
          seq: 7,
          recordedAt: '2026-05-20T12:00:01.400Z',
          category: 'voice-session',
          name: 'gemini-interruption',
          payload: { diagnostic: { playbackFlushed: true } },
        },
        {
          seq: 8,
          recordedAt: '2026-05-20T12:00:01.450Z',
          category: 'voice-session',
          name: 'gemini-tool-call-ledger',
          payload: {
            entry: {
              toolCallId: 'artifact-call-1',
              toolName: 'emit_artifact',
              receivedAt: '2026-05-20T12:00:01.300Z',
              cancelledAt: '2026-05-20T12:00:01.420Z',
              toolResponsePreparedAt: '2026-05-20T12:00:01.500Z',
              toolResponseSentAt: null,
              suppressionReason: 'cancelled_before_send',
              finalState: 'suppressed',
            },
          },
        },
        {
          seq: 9,
          recordedAt: '2026-05-20T12:00:01.600Z',
          category: 'voice-session',
          name: 'gemini-input-audio-activity',
          payload: {
            diagnostic: {
              eventType: 'manual_mute_on',
              localSequence: 2,
              audioFrameSequence: 1,
              micState: 'muted',
            },
          },
        },
        {
          seq: 10,
          recordedAt: '2026-05-20T12:00:01.610Z',
          category: 'voice-session',
          name: 'gemini-input-audio-activity',
          payload: {
            diagnostic: {
              eventType: 'input_audio_stream_end_sent',
              localSequence: 3,
              audioFrameSequence: 1,
              micState: 'muted',
            },
          },
        },
      ]),
    });

    expect(report.turnCaptureDiagnostics.summary.counts.inputAudioFrameSent).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.providerInputTranscription).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.publicUserTranscript).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.bargeInTranscriptCaptured).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.bargeInTranscriptPromoted).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.bargeInNewTurnDispatch).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.interruptions).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.playbackFlush).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.toolCancellation).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.artifactCancellation).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.manualMute).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.audioStreamEnd).toBe(1);
    expect(report.turnCaptureDiagnostics.summary.counts.sessionStageTransition).toBeGreaterThan(0);
    expect(report.turnCaptureDiagnostics.summary.recentProviderInputTranscripts.at(-1)).toMatchObject({
      providerReceiveSequence: 11,
      relayCorrelationId: 'relay-11',
      textPreview: 'Quick question before I go. Reflect briefly on what I just said.',
    });
    expect(report.turnCaptureDiagnostics.summary.recentPublicUserTranscripts.at(-1)).toMatchObject({
      providerReceiveSequence: 11,
      relayCorrelationId: 'relay-11',
      utteranceId: 'utt-1',
    });
    expect(report.turnCaptureDiagnostics.summary.toolEvidence.at(-1)).toMatchObject({
      toolCallId: 'artifact-call-1',
      toolName: 'emit_artifact',
      cancellationAfterInterruption: true,
      cancellationBeforeResponsePrepared: true,
    });
    expect(JSON.stringify(report.turnCaptureDiagnostics)).not.toContain('do-not-export-raw-audio');
  });

  it('flags assistant audio when provider and public transcript evidence is missing', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-provider-event-correlation',
          payload: {
            telemetry: {
              categories: ['serverContent', 'modelTurnAudio'],
              responseId: 'provider-response-1',
              providerReceiveSequence: 21,
              correlationId: 'gemini-event-21',
              outputAudioChunkCount: 4,
            },
          },
        },
      ]),
    });

    const evidence = report.turnCaptureDiagnostics.summary.assistantTranscriptEvidence;

    expect(evidence.assistantAudioChunkCount).toBe(4);
    expect(evidence.providerOutputTranscriptionFragmentCount).toBe(0);
    expect(evidence.publicAssistantTranscriptEventCount).toBe(0);
    expect(evidence.warnings).toEqual(expect.arrayContaining([
      'assistant_audio_present_without_provider_output_transcription',
      'assistant_audio_present_without_public_transcript',
    ]));
    expect(evidence.windows.at(-1)).toMatchObject({
      responseId: 'provider-response-1',
      assistantTranscriptMissingWhileAudioPresent: true,
      warnings: expect.arrayContaining([
        'assistant_audio_without_provider_output_transcription',
        'assistant_audio_without_public_assistant_transcript',
      ]),
    });
  });

  it('compares provider output transcription with public assistant transcript evidence', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-provider-event-correlation',
          payload: {
            telemetry: {
              categories: ['serverContent', 'outputTranscription', 'modelTurnAudio'],
              responseId: 'provider-response-2',
              providerReceiveSequence: 31,
              correlationId: 'gemini-event-31',
              outputAudioChunkCount: 2,
              outputTranscriptionTextPreview: 'Please contact emergency services now.',
            },
          },
        },
        {
          seq: 3,
          recordedAt: '2026-05-20T12:00:01.300Z',
          category: 'voice-sse',
          name: 'sophia.transcript',
          payload: { data: { text: 'now.', is_final: false } },
        },
        {
          seq: 4,
          recordedAt: '2026-05-20T12:00:01.500Z',
          category: 'voice-session',
          name: 'gemini-interruption',
          payload: { diagnostic: { playbackFlushed: true } },
        },
      ]),
    });

    const evidence = report.turnCaptureDiagnostics.summary.assistantTranscriptEvidence;
    const window = evidence.windows.at(-1);

    expect(evidence.latestProviderOutputTranscriptionPreview).toBe('Please contact emergency services now.');
    expect(evidence.latestPublicAssistantTranscriptPreview).toBe('now.');
    expect(evidence.publicAssistantTranscriptLatestTextLength).toBe(4);
    expect(evidence.publicTranscriptFinalSeen).toBe(false);
    expect(window).toMatchObject({
      responseId: 'provider-response-2',
      assistantAudioChunkEvents: 2,
      providerOutputTranscriptionFragmentCount: 1,
      publicAssistantTranscriptEventCount: 1,
      publicAssistantTranscriptLatestTextLength: 4,
      interrupted: true,
      playbackFlush: true,
      assistantTranscriptInterruptedBeforeFinal: true,
      warnings: expect.arrayContaining([
        'public_assistant_transcript_shorter_than_provider_output',
        'assistant_transcript_interrupted_before_final',
        'assistant_transcript_flushed_before_final',
        'public_assistant_transcript_missing_source_sequence',
        'public_assistant_transcript_missing_response_id',
      ]),
    });
    expect(window?.providerToPublicTranscriptRatio).toBeLessThan(0.35);
  });

  it('bounds turn capture diagnostics to the most recent compact evidence', () => {
    const events: SophiaCaptureBundle['events'] = [
      {
        seq: 1,
        recordedAt: '2026-05-20T12:00:00.000Z',
        category: 'voice-session',
        name: 'start-talking-requested',
        payload: { sessionId: 'current-session', runtime: 'gemini_live' },
      },
      ...Array.from({ length: 260 }, (_, index) => ({
        seq: index + 2,
        recordedAt: `2026-05-20T12:00:${String(Math.floor(index / 10)).padStart(2, '0')}.${String(index % 10).padEnd(3, '0')}Z`,
        category: 'voice-session' as const,
        name: 'gemini-input-audio-activity',
        payload: {
          diagnostic: {
            eventType: 'input_audio_frame_sent',
            localSequence: index + 1,
            audioFrameSequence: index + 1,
            framesRepresented: 1,
            micState: 'unmuted',
            frameByteLength: 2730,
            frameDurationMs: 85,
          },
        },
      })),
    ];

    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:30.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle(events),
    });

    expect(report.turnCaptureDiagnostics.eventLimit).toBe(220);
    expect(report.turnCaptureDiagnostics.eventCount).toBe(220);
    expect(report.turnCaptureDiagnostics.omittedEventCount).toBe(40);
    expect(report.turnCaptureDiagnostics.events[0]?.timelineSequence).toBe(41);
    expect(report.turnCaptureDiagnostics.summary.counts.inputAudioFrameSent).toBe(260);
  });

  it('exports safe Coreview telemetry and strips raw frame or artifact text fields', () => {
    const report = buildVoiceTelemetryReport({
      exportedAt: '2026-05-20T12:00:05.000Z',
      summary: buildSummary(),
      metrics: buildMetrics(),
      captureBundle: buildCaptureBundle([
        {
          seq: 1,
          recordedAt: '2026-05-20T12:00:00.000Z',
          category: 'voice-session',
          name: 'start-talking-requested',
          payload: { sessionId: 'current-session', runtime: 'gemini_live' },
        },
        {
          seq: 2,
          recordedAt: '2026-05-20T12:00:01.000Z',
          category: 'voice-session',
          name: 'gemini-artifact-frame-send',
          payload: {
            runtime: 'gemini_live',
            result: {
              ok: true,
              websocketSendAccepted: true,
              frameBytes: 1024,
              frameDimensions: { width: 640, height: 360 },
              data: 'base64-raw-frame',
              rawFrameData: 'raw-frame-bytes',
              rawFrameExcluded: true,
            },
          },
        },
        {
          seq: 3,
          recordedAt: '2026-05-20T12:00:02.000Z',
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
                char_count: 77,
                status: 'success',
                raw_artifact_text_excluded: true,
              },
            },
          },
        },
        {
          seq: 4,
          recordedAt: '2026-05-20T12:00:03.000Z',
          category: 'voice-session',
          name: 'artifact-review-voice-command',
          payload: {
            reviewVoiceCommandKind: 'go_to_page',
            reviewVoiceCommandPageTarget: 2,
            reviewVoiceCommandApplied: true,
            reviewVoiceCommandRefreshResult: 'success',
            reviewVoiceCommandDidHardIntercept: false,
            reviewVoiceCommandWaitedForViewReady: true,
            reviewVoiceCommandAutoRefreshTiming: 'after_view_ready:18ms',
            lastReviewVoiceCommandUiMode: 'voice',
            artifactCurrentPageIndex: 1,
            artifactCurrentPageCount: 3,
            rawTranscriptExcluded: true,
          },
        },
      ]),
    });
    const serialized = JSON.stringify(report);

    expect(report.coreview.visual.frameSentCount).toBe(1);
    expect(report.coreview.visual.initialFrameSent).toBe(true);
    expect(report.coreview.visual.rawProviderPayloadExcluded).toBe(true);
    expect(report.coreview.exactText.exactTextSuccessCount).toBe(1);
    expect(report.coreview.exactText.readArtifactTextCallCount).toBe(1);
    expect(report.coreview.exactText.lastExactTextSource).toBe('builder_metadata');
    expect(report.diagnosticsSummary.coreviewStillFrame.rawProviderPayloadExcluded).toBe(true);
    expect(report.diagnosticsSummary.coreviewStillFrame.rawArtifactTextExcluded).toBe(true);
    expect(report.diagnosticsSummary.coreviewStillFrame).toMatchObject({
      lastReviewVoiceCommandKind: 'go_to_page',
      lastReviewVoiceCommandApplied: true,
      lastReviewVoiceCommandUiMode: 'voice',
      reviewVoiceCommandDidHardIntercept: false,
      reviewVoiceCommandWaitedForViewReady: true,
      reviewVoiceCommandAutoRefreshTiming: 'after_view_ready:18ms',
      lastReviewVoiceCommands: [
        expect.objectContaining({
          kind: 'go_to_page',
          applied: true,
          rawTranscriptExcluded: true,
        }),
      ],
    });
    expect(serialized).not.toContain('base64-raw-frame');
    expect(serialized).not.toContain('raw-frame-bytes');
    expect(serialized).not.toContain('raw artifact body');
    expect(serialized).not.toContain('What exact text');
  });

});
