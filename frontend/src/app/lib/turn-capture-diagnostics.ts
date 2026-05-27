import type { SophiaCaptureBundle } from './session-capture';
import type { VoiceDeveloperMetrics } from './voice-runtime-metrics';

type CaptureEvent = SophiaCaptureBundle['events'][number];

export type TurnCaptureDiagnosticFamily =
  | 'user_input_activity'
  | 'provider_input_transcription'
  | 'barge_in_transcript_handoff'
  | 'public_user_transcript'
  | 'assistant_output'
  | 'turn_boundary'
  | 'tool_artifact'
  | 'session_stage'
  | 'public_event';

export type TurnCaptureDiagnosticEvent = {
  timelineSequence: number;
  captureSeq: number | null;
  timestamp: string;
  family: TurnCaptureDiagnosticFamily;
  eventType: string;
  source: string;
  localSequence?: number | null;
  providerReceiveSequence?: number | null;
  providerRelaySequence?: number | null;
  relayCorrelationId?: string | null;
  publicEventSequence?: number | null;
  utteranceId?: string | null;
  responseId?: string | null;
  segmentId?: string | null;
  textPreview?: string | null;
  captured?: boolean | null;
  promoted?: boolean | null;
  newTurnDispatched?: boolean | null;
  blockedReason?: string | null;
  isFinal?: boolean | null;
  audioChunkCount?: number | null;
  frameByteLength?: number | null;
  frameDurationMs?: number | null;
  micState?: string | null;
  assistantAudioActive?: boolean | null;
  userInputActive?: boolean | null;
  previousStage?: string | null;
  nextStage?: string | null;
  stageTrigger?: string | null;
  publicSseState?: string | null;
  remoteAudioState?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  receivedAt?: string | null;
  cancelledAt?: string | null;
  responsePreparedAt?: string | null;
  responseSentAt?: string | null;
  suppressionReason?: string | null;
  finalState?: string | null;
  cancellationAfterUserInput?: boolean | null;
  cancellationAfterInterruption?: boolean | null;
  cancellationBeforeResponsePrepared?: boolean | null;
  cancellationBeforeResponseSent?: boolean | null;
  playbackFlushed?: boolean | null;
  staleOutputType?: string | null;
  playbackGeneration?: number | null;
  assistantUserOverlapMs?: number | null;
  rawAssistantUserOverlapMs?: number | null;
  confirmedAssistantUserOverlapMs?: number | null;
};

export type TurnCaptureTranscriptPreview = {
  captureSeq: number | null;
  timestamp: string;
  providerReceiveSequence?: number | null;
  publicEventSequence?: number | null;
  relayCorrelationId?: string | null;
  utteranceId?: string | null;
  textPreview: string;
};

export type TurnCaptureToolEvidence = {
  toolCallId: string;
  toolName: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  responsePreparedAt: string | null;
  responseSentAt: string | null;
  suppressionReason: string | null;
  finalState: string | null;
  cancellationAfterUserInput: boolean | null;
  cancellationAfterInterruption: boolean | null;
  cancellationBeforeResponsePrepared: boolean | null;
  cancellationBeforeResponseSent: boolean | null;
  publicArtifactObserved: boolean;
};

export type TurnCaptureAssistantTranscriptEvidenceWindow = {
  windowId: string;
  startedAt: string | null;
  lastEventAt: string | null;
  endedAt: string | null;
  responseId: string | null;
  segmentId: string | null;
  providerStartSequence: number | null;
  providerEndSequence: number | null;
  assistantAudioChunkEvents: number;
  providerOutputTranscriptionFragmentCount: number;
  providerOutputTranscriptionTextLength: number;
  publicAssistantTranscriptEventCount: number;
  publicAssistantTranscriptFinalSeen: boolean;
  publicAssistantTranscriptMaxTextLength: number;
  publicAssistantTranscriptLatestTextLength: number;
  providerToPublicTranscriptRatio: number | null;
  latestProviderOutputTranscriptionPreview: string | null;
  latestPublicAssistantTranscriptPreview: string | null;
  interrupted: boolean;
  playbackFlush: boolean;
  userInputOverlappedAudio: boolean;
  assistantUserOverlapMs: number;
  rawAssistantUserOverlapMs: number;
  confirmedAssistantUserOverlapMs: number;
  publicTranscriptMissingSourceSequence: boolean;
  publicTranscriptMissingResponseId: boolean;
  assistantTranscriptMissingWhileAudioPresent: boolean;
  assistantTranscriptInterruptedBeforeFinal: boolean;
  warnings: string[];
};

export type TurnCaptureAssistantTranscriptEvidence = {
  schema: 'assistant_transcript_evidence_v1';
  sourceProviderEventCorrelationCount: number;
  reportedProviderEventCount: number | null;
  captureMayOmitEarlierProviderEvents: boolean;
  assistantAudioChunkCount: number;
  providerOutputTranscriptionFragmentCount: number;
  providerOutputTranscriptionTextLength: number;
  publicAssistantTranscriptEventCount: number;
  publicAssistantTranscriptMaxTextLength: number;
  publicAssistantTranscriptLatestTextLength: number;
  staleAssistantAudioDroppedCount: number;
  staleAssistantTranscriptDroppedCount: number;
  maxAssistantUserOverlapMs: number;
  maxRawAssistantUserOverlapMs: number;
  maxConfirmedAssistantUserOverlapMs: number;
  publicTranscriptFinalSeen: boolean;
  providerToPublicTranscriptRatio: number | null;
  latestProviderOutputTranscriptionPreview: string | null;
  latestPublicAssistantTranscriptPreview: string | null;
  windows: TurnCaptureAssistantTranscriptEvidenceWindow[];
  warnings: string[];
};

export type TurnCaptureDiagnostics = {
  version: 2;
  eventLimit: number;
  sourceEventCount: number;
  eventCount: number;
  omittedEventCount: number;
  events: TurnCaptureDiagnosticEvent[];
  summary: {
    counts: {
      inputAudioFrameSent: number;
      inputAudioStreamPaused: number;
      audioStreamEnd: number;
      manualMute: number;
      providerInputTranscription: number;
      publicUserTranscript: number;
      bargeInTranscriptCaptured: number;
      bargeInTranscriptPromoted: number;
      bargeInNewTurnDispatch: number;
      providerOutputTranscription: number;
      publicAssistantTranscript: number;
      assistantAudioChunkEvents: number;
      interruptions: number;
      playbackFlush: number;
      staleAssistantAudioDropped: number;
      staleAssistantTranscriptDropped: number;
      turnBoundary: number;
      toolCall: number;
      toolCancellation: number;
      artifactToolCall: number;
      artifactCancellation: number;
      publicArtifact: number;
      sessionStageTransition: number;
      publicSophiaEvent: number;
    };
    recentProviderInputTranscripts: TurnCaptureTranscriptPreview[];
    recentPublicUserTranscripts: TurnCaptureTranscriptPreview[];
    assistantTranscriptEvidence: TurnCaptureAssistantTranscriptEvidence;
    toolEvidence: TurnCaptureToolEvidence[];
    finalUiState: {
      stage: string | null;
      micState: string | null;
      remoteAudioState: string | null;
      publicSseState: string | null;
      artifactCount: number | null;
      artifactPublicEventCount: number | null;
      artifactRenderedCount: number | null;
      artifactCountSource: string | null;
    };
  };
};

const MAX_TURN_CAPTURE_EVENTS = 220;
const MAX_RECENT_TRANSCRIPTS = 3;
const MAX_ASSISTANT_TRANSCRIPT_EVIDENCE_WINDOWS = 8;
const MAX_TOOL_EVIDENCE = 20;
const TEXT_PREVIEW_CHARS = 160;
const MIN_TEXT_LENGTH_FOR_RATIO_WARNING = 24;
const MIN_PROVIDER_TO_PUBLIC_TRANSCRIPT_RATIO = 0.35;
const REDACTED = '[redacted]';

export function buildTurnCaptureDiagnostics(
  sourceEvents: CaptureEvent[],
  metrics?: VoiceDeveloperMetrics,
): TurnCaptureDiagnostics {
  const timeline: Omit<TurnCaptureDiagnosticEvent, 'timelineSequence'>[] = [];
  const recentProviderInputTranscripts: TurnCaptureTranscriptPreview[] = [];
  const recentPublicUserTranscripts: TurnCaptureTranscriptPreview[] = [];
  const latestToolLedger = new Map<string, TurnCaptureToolEvidence>();
  const publicArtifactToolNames = new Set<string>();
  const counts = createEmptyCounts();

  let currentStage: string | null = null;
  let micState: string | null = null;
  let remoteAudioState: string | null = null;
  let publicSseState: string | null = null;
  let assistantAudioActive = false;
  let userInputActive = false;
  let lastUserInputAt: string | null = null;
  let lastInterruptionAt: string | null = null;

  const pushTimeline = (event: Omit<TurnCaptureDiagnosticEvent, 'timelineSequence'>) => {
    timeline.push(event);
  };

  const pushStageTransition = (
    captureEvent: CaptureEvent,
    nextStage: string | null,
    trigger: string,
    source: string,
    extras: Partial<TurnCaptureDiagnosticEvent> = {},
  ) => {
    if (!nextStage || nextStage === currentStage) {
      return;
    }
    const previousStage = currentStage;
    currentStage = nextStage;
    counts.sessionStageTransition += 1;
    pushTimeline({
      captureSeq: numericValue(captureEvent.seq),
      timestamp: captureEvent.recordedAt,
      family: 'session_stage',
      eventType: 'session_stage_transition',
      source,
      previousStage,
      nextStage,
      stageTrigger: trigger,
      micState,
      remoteAudioState,
      publicSseState,
      assistantAudioActive,
      userInputActive,
      ...extras,
    });
  };

  for (const captureEvent of sourceEvents) {
    const payload = recordValue(captureEvent.payload);
    if (captureEvent.name.startsWith('sophia.')) {
      counts.publicSophiaEvent += 1;
    }

    if (captureEvent.name === 'gemini-input-audio-activity') {
      const diagnostic = recordValue(payload?.diagnostic);
      const eventType = stringValue(diagnostic?.eventType) ?? 'input_audio_activity';
      micState = stringValue(diagnostic?.micState) ?? micState;
      userInputActive = eventType === 'input_audio_frame_sent' || eventType === 'manual_mute_off';
      if (eventType === 'input_audio_stream_paused' || eventType === 'manual_mute_on') {
        userInputActive = false;
      }
      if (eventType === 'input_audio_frame_sent') {
        counts.inputAudioFrameSent += numericValue(diagnostic?.framesRepresented) ?? 1;
        lastUserInputAt = captureEvent.recordedAt;
      }
      if (eventType === 'input_audio_stream_paused') {
        counts.inputAudioStreamPaused += 1;
      }
      if (eventType === 'input_audio_stream_end_sent') {
        counts.audioStreamEnd += 1;
      }
      if (eventType === 'manual_mute_on' || eventType === 'manual_mute_off') {
        counts.manualMute += 1;
      }
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'user_input_activity',
        eventType,
        source: 'gemini_browser_audio_pipeline',
        localSequence: numericValue(diagnostic?.localSequence),
        frameByteLength: numericValue(diagnostic?.frameByteLength),
        frameDurationMs: numericValue(diagnostic?.frameDurationMs),
        micState,
        assistantUserOverlapMs: numericValue(diagnostic?.rawAssistantUserOverlapMs),
        rawAssistantUserOverlapMs: numericValue(diagnostic?.rawAssistantUserOverlapMs),
        confirmedAssistantUserOverlapMs: numericValue(diagnostic?.confirmedAssistantUserOverlapMs),
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'gemini-provider-event-correlation') {
      const telemetry = recordValue(payload?.telemetry);
      const providerReceiveSequence = numericValue(telemetry?.providerReceiveSequence);
      const providerRelaySequence = numericValue(telemetry?.providerRelaySequence);
      const relayCorrelationId = stringValue(telemetry?.correlationId);
      const responseId = stringValue(telemetry?.responseId);
      const categories = stringArray(telemetry?.categories);
      const base = {
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        providerReceiveSequence,
        providerRelaySequence,
        relayCorrelationId,
        responseId,
      };

      if (categories.includes('inputTranscription')) {
        const textPreview = previewText(telemetry?.inputTranscriptionTextPreview);
        counts.providerInputTranscription += 1;
        lastUserInputAt = captureEvent.recordedAt;
        pushRecent(recentProviderInputTranscripts, {
          captureSeq: base.captureSeq,
          timestamp: captureEvent.recordedAt,
          providerReceiveSequence,
          relayCorrelationId,
          textPreview: textPreview ?? '',
        });
        pushTimeline({
          ...base,
          family: 'provider_input_transcription',
          eventType: 'provider_input_transcription',
          source: 'gemini_provider_event',
          textPreview,
          isFinal: null,
          assistantAudioActive,
          userInputActive,
        });
      }

      if (categories.includes('outputTranscription')) {
        counts.providerOutputTranscription += 1;
        pushTimeline({
          ...base,
          family: 'assistant_output',
          eventType: 'provider_output_transcription',
          source: 'gemini_provider_event',
          textPreview: previewText(telemetry?.outputTranscriptionTextPreview),
          isFinal: null,
          assistantAudioActive,
          userInputActive,
        });
      }

      if (categories.includes('modelTurnAudio')) {
        assistantAudioActive = true;
        const audioChunkCount = numericValue(telemetry?.outputAudioChunkCount) ?? 0;
        counts.assistantAudioChunkEvents += audioChunkCount || 1;
        pushTimeline({
          ...base,
          family: 'assistant_output',
          eventType: 'assistant_audio_chunk',
          source: 'gemini_provider_event',
          audioChunkCount,
          assistantAudioActive,
          userInputActive,
        });
      }

      if (categories.includes('toolCall')) {
        for (const toolCallId of stringArray(telemetry?.toolCallIds)) {
          counts.toolCall += 1;
          pushTimeline({
            ...base,
            family: 'tool_artifact',
            eventType: 'provider_tool_call',
            source: 'gemini_provider_event',
            toolCallId,
            assistantAudioActive,
            userInputActive,
          });
        }
      }

      if (categories.includes('toolCallCancellation')) {
        const ids = stringArray(telemetry?.toolCancellationIds);
        const cancellationIds = ids.length ? ids : [null];
        for (const toolCallId of cancellationIds) {
          pushTimeline({
            ...base,
            family: 'tool_artifact',
            eventType: 'toolCallCancellation',
            source: 'gemini_provider_event',
            toolCallId,
            cancellationAfterUserInput: isAfter(captureEvent.recordedAt, lastUserInputAt),
            cancellationAfterInterruption: isAfter(captureEvent.recordedAt, lastInterruptionAt),
            assistantAudioActive,
            userInputActive,
          });
        }
      }

      if (booleanValue(telemetry?.serverContentInterrupted)) {
        counts.interruptions += 1;
        lastInterruptionAt = captureEvent.recordedAt;
        assistantAudioActive = false;
        pushTimeline({
          ...base,
          family: 'turn_boundary',
          eventType: 'interrupted',
          source: 'gemini_provider_event',
          assistantAudioActive,
          userInputActive,
        });
      }
      if (booleanValue(telemetry?.generationComplete)) {
        counts.turnBoundary += 1;
        pushTimeline({
          ...base,
          family: 'turn_boundary',
          eventType: 'generationComplete',
          source: 'gemini_provider_event',
          assistantAudioActive,
          userInputActive,
        });
      }
      if (booleanValue(telemetry?.turnComplete)) {
        counts.turnBoundary += 1;
        assistantAudioActive = false;
        pushTimeline({
          ...base,
          family: 'turn_boundary',
          eventType: 'turnComplete',
          source: 'gemini_provider_event',
          assistantAudioActive,
          userInputActive,
        });
      }
      continue;
    }

    if (captureEvent.name === 'gemini-output-audio-chunk') {
      const diagnostic = recordValue(payload?.diagnostic);
      counts.assistantAudioChunkEvents += 1;
      assistantAudioActive = true;
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'assistant_output',
        eventType: 'assistant_audio_chunk_scheduled',
        source: 'browser_pcm_scheduler',
        providerReceiveSequence: numericValue(diagnostic?.providerReceiveSequence),
        providerRelaySequence: numericValue(diagnostic?.providerRelaySequence),
        relayCorrelationId: stringValue(diagnostic?.relayCorrelationId),
        audioChunkCount: 1,
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'gemini-output-audio-started') {
      remoteAudioState = 'active';
      assistantAudioActive = true;
      pushStageTransition(captureEvent, 'speaking', 'assistant_audio', 'gemini_output_audio');
      continue;
    }

    if (captureEvent.name === 'gemini-stale-output-suppressed') {
      const diagnostic = recordValue(payload?.diagnostic);
      const outputType = stringValue(diagnostic?.outputType);
      if (outputType === 'audio') {
        counts.staleAssistantAudioDropped += 1;
      } else if (outputType === 'transcript') {
        counts.staleAssistantTranscriptDropped += 1;
      }
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'assistant_output',
        eventType: 'stale_assistant_output_suppressed',
        source: 'gemini_browser_stale_output_guard',
        providerReceiveSequence: numericValue(diagnostic?.providerReceiveSequence),
        relayCorrelationId: stringValue(diagnostic?.relayCorrelationId),
        responseId: stringValue(diagnostic?.responseId),
        staleOutputType: outputType,
        suppressionReason: stringValue(diagnostic?.reason),
        playbackGeneration: numericValue(diagnostic?.playbackGeneration),
        assistantUserOverlapMs: numericValue(diagnostic?.rawAssistantUserOverlapMs),
        rawAssistantUserOverlapMs: numericValue(diagnostic?.rawAssistantUserOverlapMs),
        confirmedAssistantUserOverlapMs: numericValue(diagnostic?.confirmedAssistantUserOverlapMs),
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'stale-assistant-transcript-ignored') {
      counts.staleAssistantTranscriptDropped += 1;
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'assistant_output',
        eventType: 'stale_assistant_transcript_ignored',
        source: 'frontend_transcript_stale_guard',
        providerReceiveSequence: numericValue(payload?.sourceSequence),
        responseId: stringValue(payload?.responseId),
        segmentId: stringValue(payload?.segmentId),
        suppressionReason: stringValue(payload?.reason),
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'gemini-interruption') {
      const diagnostic = recordValue(payload?.diagnostic);
      counts.interruptions += 1;
      if (booleanValue(diagnostic?.playbackFlushed)) {
        counts.playbackFlush += 1;
      }
      lastInterruptionAt = captureEvent.recordedAt;
      remoteAudioState = 'idle';
      assistantAudioActive = false;
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'turn_boundary',
        eventType: 'interrupted',
        source: 'gemini_browser_interruption',
        playbackFlushed: booleanValue(diagnostic?.playbackFlushed),
        playbackGeneration: numericValue(diagnostic?.playbackGeneration),
        assistantUserOverlapMs: numericValue(diagnostic?.assistantUserOverlapMs),
        rawAssistantUserOverlapMs: numericValue(diagnostic?.rawAssistantUserOverlapMs),
        confirmedAssistantUserOverlapMs: numericValue(diagnostic?.confirmedAssistantUserOverlapMs),
        assistantAudioActive,
        userInputActive,
      });
      pushStageTransition(captureEvent, micState === 'muted' ? 'idle' : 'listening', 'interruption', 'gemini_browser_interruption');
      continue;
    }

    if (captureEvent.name === 'gemini-tool-call-ledger') {
      const entry = recordValue(payload?.entry);
      const toolCallId = stringValue(entry?.toolCallId);
      if (!toolCallId) {
        continue;
      }
      const toolName = stringValue(entry?.toolName);
      const cancelledAt = stringValue(entry?.cancelledAt);
      const responsePreparedAt = stringValue(entry?.toolResponsePreparedAt);
      const responseSentAt = stringValue(entry?.toolResponseSentAt);
      const evidence: TurnCaptureToolEvidence = {
        toolCallId,
        toolName,
        receivedAt: stringValue(entry?.receivedAt),
        cancelledAt,
        responsePreparedAt,
        responseSentAt,
        suppressionReason: stringValue(entry?.suppressionReason),
        finalState: stringValue(entry?.finalState),
        cancellationAfterUserInput: cancelledAt ? isAfter(cancelledAt, lastUserInputAt) : null,
        cancellationAfterInterruption: cancelledAt ? isAfter(cancelledAt, lastInterruptionAt) : null,
        cancellationBeforeResponsePrepared: cancelledAt && responsePreparedAt ? isBefore(cancelledAt, responsePreparedAt) : null,
        cancellationBeforeResponseSent: cancelledAt && responseSentAt ? isBefore(cancelledAt, responseSentAt) : null,
        publicArtifactObserved: toolName === 'emit_artifact' && publicArtifactToolNames.has(toolCallId),
      };
      latestToolLedger.set(toolCallId, evidence);
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'tool_artifact',
        eventType: 'tool_ledger_update',
        source: 'gemini_tool_call_ledger',
        toolCallId,
        toolName,
        receivedAt: evidence.receivedAt,
        cancelledAt: evidence.cancelledAt,
        responsePreparedAt,
        responseSentAt,
        suppressionReason: evidence.suppressionReason,
        finalState: evidence.finalState,
        cancellationAfterUserInput: evidence.cancellationAfterUserInput,
        cancellationAfterInterruption: evidence.cancellationAfterInterruption,
        cancellationBeforeResponsePrepared: evidence.cancellationBeforeResponsePrepared,
        cancellationBeforeResponseSent: evidence.cancellationBeforeResponseSent,
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'gemini-stage-changed') {
      const stage = stringValue(payload?.stage);
      const stageTelemetry = payload ?? {};
      micState = stringValue(stageTelemetry.microphoneState) ?? micState;
      remoteAudioState = stringValue(stageTelemetry.remoteAudioState) ?? remoteAudioState;
      pushStageTransition(
        captureEvent,
        voiceStageFromGeminiStage(stage),
        stage ?? 'gemini_stage',
        'gemini_connector_stage',
        { micState, remoteAudioState },
      );
      continue;
    }

    if (captureEvent.name === 'stream-open') {
      publicSseState = 'connected';
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'session_stage',
        eventType: 'public_sse_connected',
        source: 'public_sse',
        previousStage: currentStage,
        nextStage: currentStage,
        publicSseState,
      });
      continue;
    }

    if (captureEvent.name === 'stream-error') {
      publicSseState = 'error';
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'session_stage',
        eventType: 'public_sse_error',
        source: 'public_sse',
        previousStage: currentStage,
        nextStage: currentStage,
        publicSseState,
      });
      continue;
    }

    if (captureEvent.name === 'mic-muted' || captureEvent.name === 'mic-unmuted') {
      micState = captureEvent.name === 'mic-muted' ? 'muted' : 'unmuted';
      pushStageTransition(
        captureEvent,
        captureEvent.name === 'mic-muted' ? 'idle' : 'listening',
        captureEvent.name,
        'manual_control',
        { micState },
      );
      continue;
    }

    if (captureEvent.name === 'gemini-barge-in-transcript-handoff') {
      const diagnostic = recordValue(payload?.diagnostic);
      const captured = booleanValue(diagnostic?.captured) === true;
      const promoted = booleanValue(diagnostic?.promoted) === true;
      const newTurnDispatched = booleanValue(diagnostic?.newTurnDispatched) === true;
      if (captured) counts.bargeInTranscriptCaptured += 1;
      if (promoted) counts.bargeInTranscriptPromoted += 1;
      if (newTurnDispatched) counts.bargeInNewTurnDispatch += 1;
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'barge_in_transcript_handoff',
        eventType: 'barge_in_transcript_handoff',
        source: 'gemini_browser_transcript_handoff',
        providerReceiveSequence: numericValue(diagnostic?.providerReceiveSequence),
        relayCorrelationId: stringValue(diagnostic?.relayCorrelationId),
        textPreview: previewText(diagnostic?.transcriptPreview),
        captured,
        promoted,
        newTurnDispatched,
        blockedReason: stringValue(diagnostic?.bargeInNewTurnDispatchBlockedReason)
          ?? stringValue(diagnostic?.newTurnDispatchBlockedReason),
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'sophia.user_transcript') {
      const data = recordValue(payload?.data);
      const textPreview = previewText(data?.text);
      counts.publicUserTranscript += 1;
      lastUserInputAt = captureEvent.recordedAt;
      userInputActive = false;
      pushRecent(recentPublicUserTranscripts, {
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        providerReceiveSequence: numericValue(data?.source_sequence),
        publicEventSequence: numericValue(captureEvent.seq),
        relayCorrelationId: stringValue(data?.relay_correlation_id),
        utteranceId: stringValue(data?.utterance_id),
        textPreview: textPreview ?? '',
      });
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'public_user_transcript',
        eventType: 'public_user_transcript',
        source: 'public_sophia_event',
        publicEventSequence: numericValue(captureEvent.seq),
        providerReceiveSequence: numericValue(data?.source_sequence),
        relayCorrelationId: stringValue(data?.relay_correlation_id),
        utteranceId: stringValue(data?.utterance_id),
        textPreview,
        isFinal: true,
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'sophia.transcript') {
      const data = recordValue(payload?.data);
      counts.publicAssistantTranscript += 1;
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'assistant_output',
        eventType: 'public_assistant_transcript',
        source: 'public_sophia_event',
        publicEventSequence: numericValue(captureEvent.seq),
        providerReceiveSequence: numericValue(data?.source_sequence),
        relayCorrelationId: stringValue(data?.relay_correlation_id),
        responseId: stringValue(data?.response_id),
        segmentId: stringValue(data?.segment_id),
        textPreview: previewText(data?.text),
        isFinal: booleanValue(data?.is_final),
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'sophia.artifact') {
      counts.publicArtifact += 1;
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'tool_artifact',
        eventType: 'public_artifact',
        source: 'public_sophia_event',
        publicEventSequence: numericValue(captureEvent.seq),
        assistantAudioActive,
        userInputActive,
      });
      continue;
    }

    if (captureEvent.name === 'sophia.turn') {
      const data = recordValue(payload?.data);
      const phase = stringValue(data?.phase);
      counts.turnBoundary += 1;
      if (phase === 'agent_ended') {
        assistantAudioActive = false;
        remoteAudioState = 'idle';
      }
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'turn_boundary',
        eventType: phase ?? 'public_turn',
        source: 'public_sophia_turn',
        publicEventSequence: numericValue(captureEvent.seq),
        assistantAudioActive,
        userInputActive,
      });
      pushStageTransition(captureEvent, voiceStageFromSophiaTurnPhase(phase), phase ?? 'public_turn', 'public_sophia_turn');
      continue;
    }

    if (captureEvent.name === 'sophia.turn_diagnostic') {
      const data = recordValue(payload?.data);
      const reason = stringValue(data?.reason);
      pushTimeline({
        captureSeq: numericValue(captureEvent.seq),
        timestamp: captureEvent.recordedAt,
        family: 'public_event',
        eventType: reason ?? 'public_turn_diagnostic',
        source: 'public_sophia_event',
        publicEventSequence: numericValue(captureEvent.seq),
        providerReceiveSequence: numericValue(data?.source_sequence),
        responseId: stringValue(data?.response_id),
        assistantAudioActive,
        userInputActive,
      });
    }
  }

  counts.toolCall = Math.max(counts.toolCall, latestToolLedger.size);
  for (const evidence of latestToolLedger.values()) {
    if (evidence.toolName === 'emit_artifact') {
      counts.artifactToolCall += 1;
    }
    if (isToolCancelled(evidence)) {
      counts.toolCancellation += 1;
      if (evidence.toolName === 'emit_artifact') {
        counts.artifactCancellation += 1;
      }
    }
  }

  const timelineOffset = boundedEventOffset(timeline.length);
  const boundedEvents = timeline.slice(-MAX_TURN_CAPTURE_EVENTS).map((event, index) => ({
    ...event,
    timelineSequence: timelineOffset + index + 1,
  }));

  const geminiTelemetry = recordValue(recordValue(metrics?.sessionTelemetry)?.gemini);
  const metricCounts = recordValue(metrics?.counts);
  const assistantTranscriptEvidence = buildAssistantTranscriptEvidence(timeline, sourceEvents, metrics);
  return {
    version: 2,
    eventLimit: MAX_TURN_CAPTURE_EVENTS,
    sourceEventCount: sourceEvents.length,
    eventCount: boundedEvents.length,
    omittedEventCount: Math.max(timeline.length - boundedEvents.length, 0),
    events: boundedEvents,
    summary: {
      counts,
      recentProviderInputTranscripts,
      recentPublicUserTranscripts,
      assistantTranscriptEvidence,
      toolEvidence: [...latestToolLedger.values()].slice(-MAX_TOOL_EVIDENCE),
      finalUiState: {
        stage: stringValue(metrics?.stage) ?? currentStage,
        micState: stringValue(geminiTelemetry?.microphoneState) ?? micState,
        remoteAudioState: stringValue(geminiTelemetry?.remoteAudioState) ?? remoteAudioState,
        publicSseState: stringValue(geminiTelemetry?.publicSseState) ?? publicSseState,
        artifactCount: numericValue(metricCounts?.artifacts),
        artifactPublicEventCount: numericValue(metricCounts?.artifactPublicEventCount),
        artifactRenderedCount: numericValue(metricCounts?.artifactRenderedCount),
        artifactCountSource: stringValue(metricCounts?.artifactCountSource),
      },
    },
  };
}

function createEmptyCounts(): TurnCaptureDiagnostics['summary']['counts'] {
  return {
    inputAudioFrameSent: 0,
    inputAudioStreamPaused: 0,
    audioStreamEnd: 0,
    manualMute: 0,
    providerInputTranscription: 0,
    publicUserTranscript: 0,
    bargeInTranscriptCaptured: 0,
    bargeInTranscriptPromoted: 0,
    bargeInNewTurnDispatch: 0,
    providerOutputTranscription: 0,
    publicAssistantTranscript: 0,
    assistantAudioChunkEvents: 0,
    interruptions: 0,
    playbackFlush: 0,
    staleAssistantAudioDropped: 0,
    staleAssistantTranscriptDropped: 0,
    turnBoundary: 0,
    toolCall: 0,
    toolCancellation: 0,
    artifactToolCall: 0,
    artifactCancellation: 0,
    publicArtifact: 0,
    sessionStageTransition: 0,
    publicSophiaEvent: 0,
  };
}

function buildAssistantTranscriptEvidence(
  timeline: Omit<TurnCaptureDiagnosticEvent, 'timelineSequence'>[],
  sourceEvents: CaptureEvent[],
  metrics?: VoiceDeveloperMetrics,
): TurnCaptureAssistantTranscriptEvidence {
  const windows: MutableAssistantTranscriptEvidenceWindow[] = [];
  let current: MutableAssistantTranscriptEvidenceWindow | null = null;

  const startWindow = (event: Omit<TurnCaptureDiagnosticEvent, 'timelineSequence'>) => {
    if (!current) {
      current = {
        windowId: `assistant-window-${windows.length + 1}`,
        startedAt: event.timestamp,
        lastEventAt: event.timestamp,
        endedAt: null,
        responseId: event.responseId ?? null,
        segmentId: event.segmentId ?? null,
        providerStartSequence: event.providerReceiveSequence ?? null,
        providerEndSequence: event.providerReceiveSequence ?? null,
        assistantAudioChunkEvents: 0,
        providerOutputTranscriptionFragmentCount: 0,
        providerOutputTranscriptionTextLength: 0,
        publicAssistantTranscriptEventCount: 0,
        publicAssistantTranscriptFinalSeen: false,
        publicAssistantTranscriptMaxTextLength: 0,
        publicAssistantTranscriptLatestTextLength: 0,
        latestProviderOutputTranscriptionPreview: null,
        latestPublicAssistantTranscriptPreview: null,
        interrupted: false,
        playbackFlush: false,
        userInputOverlappedAudio: false,
        assistantUserOverlapMs: 0,
        rawAssistantUserOverlapMs: 0,
        confirmedAssistantUserOverlapMs: 0,
        publicTranscriptMissingSourceSequence: false,
        publicTranscriptMissingResponseId: false,
      };
      windows.push(current);
    }

    current.lastEventAt = event.timestamp;
    current.responseId ??= event.responseId ?? null;
    current.segmentId ??= event.segmentId ?? null;
    if (event.providerReceiveSequence != null) {
      current.providerStartSequence = current.providerStartSequence == null
        ? event.providerReceiveSequence
        : Math.min(current.providerStartSequence, event.providerReceiveSequence);
      current.providerEndSequence = current.providerEndSequence == null
        ? event.providerReceiveSequence
        : Math.max(current.providerEndSequence, event.providerReceiveSequence);
    }
    if (event.userInputActive && (current.assistantAudioChunkEvents > 0 || event.assistantAudioActive)) {
      current.userInputOverlappedAudio = true;
    }
    return current;
  };

  const closeWindow = (event: Omit<TurnCaptureDiagnosticEvent, 'timelineSequence'>, interrupted = false) => {
    if (!current) {
      return;
    }
    current.lastEventAt = event.timestamp;
    current.endedAt = event.timestamp;
    current.interrupted = current.interrupted || interrupted;
    current.playbackFlush = current.playbackFlush || event.playbackFlushed === true;
    if (event.assistantUserOverlapMs != null) {
      current.assistantUserOverlapMs = Math.max(current.assistantUserOverlapMs, event.assistantUserOverlapMs);
    }
    if (event.rawAssistantUserOverlapMs != null) {
      current.rawAssistantUserOverlapMs = Math.max(current.rawAssistantUserOverlapMs, event.rawAssistantUserOverlapMs);
    }
    if (event.confirmedAssistantUserOverlapMs != null) {
      current.confirmedAssistantUserOverlapMs = Math.max(current.confirmedAssistantUserOverlapMs, event.confirmedAssistantUserOverlapMs);
    }
    current = null;
  };

  for (const event of timeline) {
    if (event.eventType === 'provider_output_transcription') {
      const window = startWindow(event);
      window.providerOutputTranscriptionFragmentCount += 1;
      const preview = event.textPreview ?? '';
      window.providerOutputTranscriptionTextLength += preview.length;
      window.latestProviderOutputTranscriptionPreview = event.textPreview ?? window.latestProviderOutputTranscriptionPreview;
      continue;
    }

    if (event.eventType === 'assistant_audio_chunk' || event.eventType === 'assistant_audio_chunk_scheduled') {
      const window = startWindow(event);
      window.assistantAudioChunkEvents += event.audioChunkCount && event.audioChunkCount > 0 ? event.audioChunkCount : 1;
      if (event.userInputActive) {
        window.userInputOverlappedAudio = true;
      }
      continue;
    }

    if (event.eventType === 'public_assistant_transcript') {
      const window = startWindow(event);
      const textLength = event.textPreview?.length ?? 0;
      window.publicAssistantTranscriptEventCount += 1;
      window.publicAssistantTranscriptLatestTextLength = textLength;
      window.publicAssistantTranscriptMaxTextLength = Math.max(window.publicAssistantTranscriptMaxTextLength, textLength);
      window.publicAssistantTranscriptFinalSeen = window.publicAssistantTranscriptFinalSeen || event.isFinal === true;
      window.latestPublicAssistantTranscriptPreview = event.textPreview ?? window.latestPublicAssistantTranscriptPreview;
      window.publicTranscriptMissingSourceSequence = window.publicTranscriptMissingSourceSequence || event.providerReceiveSequence == null;
      window.publicTranscriptMissingResponseId = window.publicTranscriptMissingResponseId || !event.responseId;
      if (event.userInputActive && (window.assistantAudioChunkEvents > 0 || event.assistantAudioActive)) {
        window.userInputOverlappedAudio = true;
      }
      continue;
    }

    if (event.eventType === 'agent_started') {
      startWindow(event);
      continue;
    }

    if (event.eventType === 'provider_input_transcription' || event.eventType === 'public_user_transcript') {
      if (current && (event.assistantAudioActive || current.assistantAudioChunkEvents > 0)) {
        current.userInputOverlappedAudio = true;
      }
      continue;
    }

    if (event.eventType === 'interrupted') {
      closeWindow(event, true);
      continue;
    }

    if (event.eventType === 'turnComplete' || event.eventType === 'agent_ended') {
      closeWindow(event, false);
    }
  }

  const finalizedWindows = windows.map(finalizeAssistantTranscriptEvidenceWindow);
  const assistantAudioChunkCount = finalizedWindows.reduce((sum, window) => sum + window.assistantAudioChunkEvents, 0);
  const providerOutputTranscriptionFragmentCount = finalizedWindows.reduce((sum, window) => sum + window.providerOutputTranscriptionFragmentCount, 0);
  const providerOutputTranscriptionTextLength = finalizedWindows.reduce((sum, window) => sum + window.providerOutputTranscriptionTextLength, 0);
  const publicAssistantTranscriptEventCount = finalizedWindows.reduce((sum, window) => sum + window.publicAssistantTranscriptEventCount, 0);
  const staleAssistantAudioDroppedCount = sourceEvents.filter((event) => {
    if (event.name !== 'gemini-stale-output-suppressed') return false;
    return stringValue(recordValue(recordValue(event.payload)?.diagnostic)?.outputType) === 'audio';
  }).length;
  const staleAssistantTranscriptDroppedCount = sourceEvents.filter((event) => {
    if (event.name === 'stale-assistant-transcript-ignored') return true;
    if (event.name !== 'gemini-stale-output-suppressed') return false;
    return stringValue(recordValue(recordValue(event.payload)?.diagnostic)?.outputType) === 'transcript';
  }).length;
  const publicAssistantTranscriptMaxTextLength = finalizedWindows.reduce(
    (max, window) => Math.max(max, window.publicAssistantTranscriptMaxTextLength),
    0,
  );
  const latestPublicWindow = findLast(finalizedWindows, (window) => Boolean(window.latestPublicAssistantTranscriptPreview));
  const latestProviderWindow = findLast(finalizedWindows, (window) => Boolean(window.latestProviderOutputTranscriptionPreview));
  const reportedProviderEventCount = numericValue(recordValue(recordValue(metrics?.sessionTelemetry)?.gemini)?.providerEventCount);
  const metricGemini = recordValue(recordValue(metrics?.sessionTelemetry)?.gemini);
  const maxAssistantUserOverlapMs = Math.max(
    finalizedWindows.reduce((max, window) => Math.max(max, window.assistantUserOverlapMs), 0),
    numericValue(metricGemini?.maxAssistantUserOverlapMs) ?? 0,
    numericValue(metricGemini?.assistantUserOverlapMs) ?? 0,
  );
  const maxRawAssistantUserOverlapMs = Math.max(
    finalizedWindows.reduce((max, window) => Math.max(max, window.rawAssistantUserOverlapMs), 0),
    numericValue(metricGemini?.maxRawAssistantUserOverlapMs) ?? 0,
    numericValue(metricGemini?.rawAssistantUserOverlapMs) ?? 0,
    maxAssistantUserOverlapMs,
  );
  const maxConfirmedAssistantUserOverlapMs = Math.max(
    finalizedWindows.reduce((max, window) => Math.max(max, window.confirmedAssistantUserOverlapMs), 0),
    numericValue(metricGemini?.maxConfirmedAssistantUserOverlapMs) ?? 0,
    numericValue(metricGemini?.confirmedAssistantUserOverlapMs) ?? 0,
  );
  const sourceProviderEventCorrelationCount = sourceEvents.filter((event) => event.name === 'gemini-provider-event-correlation').length;
  const warnings = uniqueStrings(finalizedWindows.flatMap((window) => window.warnings));
  const captureMayOmitEarlierProviderEvents = reportedProviderEventCount != null
    && sourceProviderEventCorrelationCount > 0
    && reportedProviderEventCount > sourceProviderEventCorrelationCount;
  if (captureMayOmitEarlierProviderEvents) {
    warnings.push('capture_scope_may_omit_earlier_provider_events');
  }
  if (assistantAudioChunkCount > 0 && providerOutputTranscriptionFragmentCount === 0) {
    warnings.push('assistant_audio_present_without_provider_output_transcription');
  }
  if (assistantAudioChunkCount > 0 && publicAssistantTranscriptEventCount === 0) {
    warnings.push('assistant_audio_present_without_public_transcript');
  }
  if (staleAssistantAudioDroppedCount > 0 || staleAssistantTranscriptDroppedCount > 0) {
    warnings.push('stale_assistant_output_suppressed');
  }
  if (maxAssistantUserOverlapMs >= 1500) {
    warnings.push('assistant_audio_overlapped_user_input');
  }

  return {
    schema: 'assistant_transcript_evidence_v1',
    sourceProviderEventCorrelationCount,
    reportedProviderEventCount,
    captureMayOmitEarlierProviderEvents,
    assistantAudioChunkCount,
    providerOutputTranscriptionFragmentCount,
    providerOutputTranscriptionTextLength,
    publicAssistantTranscriptEventCount,
    publicAssistantTranscriptMaxTextLength,
    publicAssistantTranscriptLatestTextLength: latestPublicWindow?.publicAssistantTranscriptLatestTextLength ?? 0,
    staleAssistantAudioDroppedCount,
    staleAssistantTranscriptDroppedCount,
    maxAssistantUserOverlapMs,
    maxRawAssistantUserOverlapMs,
    maxConfirmedAssistantUserOverlapMs,
    publicTranscriptFinalSeen: finalizedWindows.some((window) => window.publicAssistantTranscriptFinalSeen),
    providerToPublicTranscriptRatio: transcriptRatio(publicAssistantTranscriptMaxTextLength, providerOutputTranscriptionTextLength),
    latestProviderOutputTranscriptionPreview: latestProviderWindow?.latestProviderOutputTranscriptionPreview ?? null,
    latestPublicAssistantTranscriptPreview: latestPublicWindow?.latestPublicAssistantTranscriptPreview ?? null,
    windows: finalizedWindows.slice(-MAX_ASSISTANT_TRANSCRIPT_EVIDENCE_WINDOWS),
    warnings: uniqueStrings(warnings),
  };
}

type MutableAssistantTranscriptEvidenceWindow = Omit<
  TurnCaptureAssistantTranscriptEvidenceWindow,
  | 'providerToPublicTranscriptRatio'
  | 'assistantTranscriptMissingWhileAudioPresent'
  | 'assistantTranscriptInterruptedBeforeFinal'
  | 'warnings'
>;

function finalizeAssistantTranscriptEvidenceWindow(
  window: MutableAssistantTranscriptEvidenceWindow,
): TurnCaptureAssistantTranscriptEvidenceWindow {
  const warnings: string[] = [];
  const assistantTranscriptMissingWhileAudioPresent = window.assistantAudioChunkEvents > 0
    && window.publicAssistantTranscriptEventCount === 0;
  const assistantTranscriptInterruptedBeforeFinal = window.interrupted && !window.publicAssistantTranscriptFinalSeen;
  const providerToPublicTranscriptRatio = transcriptRatio(
    window.publicAssistantTranscriptMaxTextLength,
    window.providerOutputTranscriptionTextLength,
  );

  if (window.assistantAudioChunkEvents > 0 && window.providerOutputTranscriptionFragmentCount === 0) {
    warnings.push('assistant_audio_without_provider_output_transcription');
  }
  if (assistantTranscriptMissingWhileAudioPresent) {
    warnings.push('assistant_audio_without_public_assistant_transcript');
  }
  if (
    window.assistantAudioChunkEvents > 0
    && window.providerOutputTranscriptionTextLength >= MIN_TEXT_LENGTH_FOR_RATIO_WARNING
    && (providerToPublicTranscriptRatio ?? 0) < MIN_PROVIDER_TO_PUBLIC_TRANSCRIPT_RATIO
  ) {
    warnings.push('public_assistant_transcript_shorter_than_provider_output');
  }
  if (assistantTranscriptInterruptedBeforeFinal) {
    warnings.push('assistant_transcript_interrupted_before_final');
  }
  if (window.playbackFlush && !window.publicAssistantTranscriptFinalSeen) {
    warnings.push('assistant_transcript_flushed_before_final');
  }
  if (window.userInputOverlappedAudio) {
    warnings.push('assistant_audio_overlapped_user_input');
  }
  if (window.assistantUserOverlapMs >= 1500) {
    warnings.push('assistant_user_overlap_duration_exceeded');
  }
  if (window.publicTranscriptMissingSourceSequence) {
    warnings.push('public_assistant_transcript_missing_source_sequence');
  }
  if (window.publicTranscriptMissingResponseId) {
    warnings.push('public_assistant_transcript_missing_response_id');
  }

  return {
    ...window,
    providerToPublicTranscriptRatio,
    assistantTranscriptMissingWhileAudioPresent,
    assistantTranscriptInterruptedBeforeFinal,
    warnings,
  };
}

function transcriptRatio(publicLength: number, providerLength: number): number | null {
  if (providerLength <= 0) {
    return null;
  }
  return Math.round((publicLength / providerLength) * 100) / 100;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function findLast<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) {
      return value;
    }
  }
  return undefined;
}

function boundedEventOffset(totalLength: number): number {
  return Math.max(totalLength - MAX_TURN_CAPTURE_EVENTS, 0);
}

function pushRecent<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > MAX_RECENT_TRANSCRIPTS) {
    values.splice(0, values.length - MAX_RECENT_TRANSCRIPTS);
  }
}

function previewText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value
    .replace(/(access_token=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/(auth_tokens\/)[^&#/\s]+/gi, `$1${REDACTED}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, `$1${REDACTED}`)
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= TEXT_PREVIEW_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, TEXT_PREVIEW_CHARS - 3)}...`;
}

function voiceStageFromGeminiStage(stage: string | null): string | null {
  switch (stage) {
    case 'starting_backend_session':
    case 'requesting_microphone':
    case 'opening_websocket':
    case 'sending_setup':
    case 'waiting_setup_complete':
      return 'connecting';
    case 'connected':
    case 'streaming_audio':
      return 'listening';
    case 'closing':
    case 'closed':
      return 'idle';
    default:
      return null;
  }
}

function voiceStageFromSophiaTurnPhase(phase: string | null): string | null {
  switch (phase) {
    case 'user_ended':
      return 'thinking';
    case 'agent_started':
      return 'speaking';
    case 'agent_ended':
      return 'listening';
    default:
      return null;
  }
}

function isToolCancelled(evidence: TurnCaptureToolEvidence): boolean {
  const finalState = evidence.finalState ?? '';
  return Boolean(
    evidence.cancelledAt
      || finalState.includes('cancelled')
      || finalState === 'suppressed'
      || evidence.suppressionReason,
  );
}

function isBefore(left: string | null, right: string | null): boolean | null {
  if (!left || !right) {
    return null;
  }
  return Date.parse(left) < Date.parse(right);
}

function isAfter(left: string | null, right: string | null): boolean | null {
  if (!left || !right) {
    return null;
  }
  return Date.parse(left) > Date.parse(right);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}