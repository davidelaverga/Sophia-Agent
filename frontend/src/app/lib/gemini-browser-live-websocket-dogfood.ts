import { isCoReviewStillFrameEnabled } from './co-review-flags';
import {
  COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
  COREVIEW_GET_CURRENT_VIEW_TOOL_NAME,
  COREVIEW_REFRESH_VIEW_TOOL_NAME,
  executeCoreviewToolBridgeCall,
  isCoreviewToolName,
  withCoreviewGeminiToolDeclarations,
  type CoreviewActionResult,
  type CoreviewToolCallInput,
} from './coreview-actions';
import {
  readCoreviewArtifactTextSideband,
} from './coreview-artifact-text';
import {
  COREVIEW_GET_BUILDER_STATUS_TOOL_NAME,
  COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
  coreviewBuilderToolExceptionResult,
  executeCoreviewBuilderToolBridgeCall,
  isCoreviewBuilderToolName,
  type CoreviewBuilderToolCallInput,
} from './coreview-builder-actions';
import {
  isOpaqueVoiceLabProviderCleanupToken,
  VOICE_LAB_PROVIDER_CLEANUP_HEADER,
} from './voice-lab-provider-cleanup';

export type GeminiBrowserLiveDogfoodStage =
  | 'starting_backend_session'
  | 'requesting_microphone'
  | 'opening_websocket'
  | 'sending_setup'
  | 'waiting_setup_complete'
  | 'connected'
  | 'streaming_audio'
  | 'reconnecting'
  | 'connection_lost'
  | 'closing'
  | 'closed';

export type GeminiBrowserLiveDogfoodRelayStatus = 'disconnected' | 'active' | 'degraded' | 'terminal_error';

export type GeminiTranscriptCoalescingDisabledReason = 'provider_output_transcription_is_delta_like';

export type GeminiOutputTranscriptAssemblyDecision =
  | 'seed'
  | 'empty_fragment'
  | 'exact_adjacent_replay'
  | 'cumulative_snapshot'
  | 'stale_adjacent_snapshot'
  | 'suffix_prefix_overlap'
  | 'delta_append';

export interface GeminiOutputTranscriptAssemblyResult {
  text: string;
  changed: boolean;
  decision: GeminiOutputTranscriptAssemblyDecision;
  overlapTokenCount: number;
}

export interface GeminiRepeatedIntentDetection {
  detected: boolean;
  questionCount: number;
  firstQuestionFingerprint: string | null;
  secondQuestionFingerprint: string | null;
  similarityScore: number;
  matchedSignals: string[];
}

export interface GeminiRepeatedIntentGateDiagnostic {
  timestamp: string;
  reason: 'repeated_intent_gate';
  responseId: string | null;
  segmentKey: string;
  providerReceiveSequence: number;
  providerReceivedAt: string;
  questionCount: number;
  firstQuestionFingerprint: string | null;
  secondQuestionFingerprint: string | null;
  similarityScore: number;
  matchedSignals: string[];
  playbackFlushed: boolean;
  playbackStateBefore: GeminiOutputAudioPlaybackState;
  playbackStateAfter: GeminiOutputAudioPlaybackState;
  rawProviderOutputTranscriptionUsed: true;
}

export interface GeminiMicrophoneAudioSettingsDiagnostic {
  timestamp: string;
  requested: {
    echoCancellation: true;
    noiseSuppression: true;
    autoGainControl: true;
  };
  tracks: Array<{
    echoCancellation: boolean | null;
    noiseSuppression: boolean | null;
    autoGainControl: boolean | null;
    sampleRate: number | null;
    channelCount: number | null;
    latency: number | null;
  }>;
}

export type GeminiArtifactReviewUserIntent = 'unknown' | 'analysis' | 'create_update';

export interface GeminiBrowserLiveDogfoodRelayDiagnostic {
  timestamp: string;
  targetPath: string;
  eventType: string;
  requestBodyBytes: number;
  hasHttpResponse: boolean;
  statusCode: number | null;
  statusText: string | null;
  errorText: string;
  fetchErrorName: string | null;
  terminal: boolean;
  consecutiveFailures: number;
  websocketOpen: boolean;
  websocketReadyState: number | null;
  websocketState: string;
  sessionClosing: boolean;
}

export interface GeminiOrderedRelayThroughputMetrics {
  orderedRelayQueueDepth: number;
  oldestQueuedAgeMs: number | null;
  transcriptPartialsCoalesced: number;
  transcriptPartialsSent: number;
  transcriptPartialsDropped: number;
  transcriptCoalescingDisabledReason: GeminiTranscriptCoalescingDisabledReason | null;
  finalTranscriptEventsSent: number;
  nonDroppableCriticalEventsSent: number;
  lastTranscriptRelayLatencyMs: number | null;
  maxTranscriptRelayLatencyMs: number | null;
  p95TranscriptRelayLatencyMs: number | null;
  coalescedBySegment: Record<string, number>;
}

export interface GeminiTranscriptPartialCoalescingDiagnostic {
  timestamp: string;
  reason: 'superseded_pending_assistant_partial';
  segmentKey: string;
  droppedProviderReceiveSequence: number;
  replacementProviderReceiveSequence: number;
  droppedRelayCorrelationId: string;
  replacementRelayCorrelationId: string;
  orderedRelayQueueDepth: number;
  oldestQueuedAgeMs: number | null;
  metrics: GeminiOrderedRelayThroughputMetrics;
}

export interface GeminiBrowserLiveDogfoodWebSocketDiagnostic {
  timestamp: string;
  kind: 'error' | 'close';
  message: string;
  closeCode: number | null;
  closeReason: string | null;
  wasClean: boolean | null;
  relayFailureAlreadyObserved: boolean;
}

export interface GeminiBrowserLiveDogfoodInterruptionDiagnostic {
  timestamp: string;
  reason: 'server_interrupted';
  playbackFlushed: boolean;
  playbackStateBefore: GeminiOutputAudioPlaybackState;
  playbackStateAfter: GeminiOutputAudioPlaybackState;
  playbackGeneration: number;
  interruptedResponseIds: string[];
  assistantUserOverlapMs: number;
  rawAssistantUserOverlapMs: number;
  confirmedAssistantUserOverlapMs: number;
  bargeInConfirmationSource: GeminiBargeInConfirmationSource;
  bargeInConfirmationReason: string | null;
}

export type GeminiStaleOutputSuppressionType = 'audio' | 'transcript';

export type GeminiStaleOutputSuppressionReason =
  | 'interrupted_response_id'
  | 'barge_in_generation_active'
  | 'pre_barge_in_relay_backlog'
  | 'repeated_intent_gate';

export type GeminiBargeInConfirmationSource =
  | 'none'
  | 'provider_interruption'
  | 'provider_input_transcription'
  | 'coreview_tool_follow_up'
  | 'manual_interrupt'
  | 'sustained_speech';

export type GeminiSuppressionDeferredReason =
  | 'input_frame_only_not_barge_in'
  | 'barge_in_confirmation_pending';

export interface GeminiStaleOutputSuppressionDiagnostic {
  timestamp: string;
  outputType: GeminiStaleOutputSuppressionType;
  reason: GeminiStaleOutputSuppressionReason;
  responseId: string | null;
  providerReceiveSequence: number | null;
  providerReceivedAt: string | null;
  relayCorrelationId: string | null;
  playbackGeneration: number | null;
  interruptedResponseIds: string[];
  userInputActiveAgeMs: number | null;
  bargeInConfirmed: boolean;
  bargeInConfirmationSource: GeminiBargeInConfirmationSource;
  bargeInConfirmationReason: string | null;
  bargeInCandidateFrameCount: number;
  suppressionDeferredReason: GeminiSuppressionDeferredReason | null;
  staleSuppressionArmedAt: string | null;
  staleSuppressionArmedBy: GeminiBargeInConfirmationSource | null;
  assistantAudioDropReason: GeminiStaleOutputSuppressionReason | null;
  inputFrameOnlyNotBargeInCount: number;
  candidateFramesDidNotConfirmCount: number;
  candidateExpiredCount: number;
  suppressionBlockedBecauseNoIntentCount: number;
  rawAssistantUserOverlapMs: number;
  confirmedAssistantUserOverlapMs: number;
  repeatedIntentGate?: Pick<GeminiRepeatedIntentGateDiagnostic,
    | 'questionCount'
    | 'firstQuestionFingerprint'
    | 'secondQuestionFingerprint'
    | 'similarityScore'
    | 'matchedSignals'
  >;
}

export type GeminiInputAudioActivityEventType =
  | 'microphone_settings_recorded'
  | 'input_audio_frame_sent'
  | 'input_audio_stream_paused'
  | 'input_audio_stream_end_sent'
  | 'manual_mute_on'
  | 'manual_mute_off';

export interface GeminiInputAudioActivityDiagnostic {
  eventType: GeminiInputAudioActivityEventType;
  recordedAt: string;
  localSequence: number;
  audioFrameSequence: number | null;
  framesRepresented: number | null;
  micState: 'muted' | 'unmuted';
  frameByteLength: number | null;
  frameDurationMs: number | null;
  audioStreamEndSent: boolean;
  trigger: string;
  microphoneAudioSettings?: GeminiMicrophoneAudioSettingsDiagnostic;
  assistantAudioActive?: boolean;
  userInputActiveAgeMs?: number | null;
  bargeInConfirmed?: boolean;
  bargeInConfirmationSource?: GeminiBargeInConfirmationSource;
  bargeInConfirmationReason?: string | null;
  bargeInCandidateFrameCount?: number;
  suppressionDeferredReason?: GeminiSuppressionDeferredReason | null;
  staleSuppressionArmedAt?: string | null;
  assistantAudioDropReason?: GeminiStaleOutputSuppressionReason | null;
  inputFrameOnlyNotBargeInCount?: number;
  candidateFramesDidNotConfirmCount?: number;
  candidateExpiredCount?: number;
  suppressionBlockedBecauseNoIntentCount?: number;
  rawAssistantUserOverlapMs?: number;
  confirmedAssistantUserOverlapMs?: number;
  syntheticInputOperation?: GeminiSyntheticInputOperationBinding | null;
  outgoingPcm?: GeminiSyntheticOutgoingPcmFrameDiagnostic | null;
}

export type GeminiSyntheticInputOperationPhase =
  | 'scheduled'
  | 'started'
  | 'completed'
  | 'interrupted'
  | 'rejected';

export interface GeminiSyntheticInputOperationBinding {
  schema: 'sophia_voice_lab_input_operation_v1';
  phase: GeminiSyntheticInputOperationPhase;
  test_run_id: string;
  operation_id: string;
  utterance_id: string;
  source_sha256: string;
  expected_silence: boolean | null;
  frame_window_id: string;
  provider_input_sequence: number | null;
  public_utterance_id: string | null;
}

export interface GeminiSyntheticToolEvidence {
  schema: 'sophia_synthetic_tool_evidence_v1';
  test_run_id: string;
  scenario_id: string;
  scenario_version: string;
  operation_id: string;
  utterance_id: string;
  provider_input_sequence: number;
  public_utterance_id: string | null;
  tool_call_id: string;
  effect_id: string;
  provider_connection_epoch: number;
  relay_correlation_id: string;
  tool_name: string;
  received_at: string;
}

export interface GeminiSyntheticBuilderJoin {
  schema: 'sophia_synthetic_builder_join_v1';
  test_run_id: string;
  scenario_id: string;
  scenario_version: string;
  operation_id: string;
  utterance_id: string;
  provider_input_sequence: number;
  tool_call_id: string;
  effect_id: string;
  provider_connection_epoch: number;
  relay_correlation_id: string;
  tool_name: string;
  tool_state: string;
  builder_operation_id: string;
  parent_thread_id: string;
  task_id: string;
  thread_id: string;
  run_id: string;
  build_id: string;
  artifact_id: string | null;
  artifact_path_sha256: string | null;
  ui_projection_state: string | null;
  cancel_count: number;
  no_post_cancel_publication: boolean;
  source_tool_received_at: string;
  source_backend_accepted_at: string;
  source_tool_response_sent_at: string | null;
  source_builder_event_id: string | null;
  source_builder_event_at: string | null;
  source_ui_projected_at: string | null;
  scenario_assertions: Record<string, boolean | number | string | null>;
}

export interface GeminiSyntheticOutgoingPcmFrameDiagnostic {
  sample_count: number;
  nonzero_sample_count: number;
  rms: number;
  peak: number;
  byte_length: number;
  raw_audio_excluded: true;
}

export interface GeminiSyntheticInputLegReceipt {
  schema: 'sophia_gemini_input_leg_v1';
  status: 'verified' | 'inconclusive' | 'unavailable';
  reason: string | null;
  synthetic: true;
  test_run_id: string;
  operation_id: string;
  utterance_id: string;
  source_sha256: string;
  expected_silence: boolean | null;
  frame_window_id: string;
  provider_connection_epoch: number;
  first_audio_frame_sequence: number | null;
  last_audio_frame_sequence: number | null;
  frame_count: number;
  sample_count: number;
  nonzero_sample_count: number;
  byte_length: number;
  pcm_rms: number | null;
  pcm_peak: number | null;
  pcm_digest_algorithm: 'sha-256-chain-v1' | null;
  pcm_sha256_chain: string | null;
  started_at: string;
  completed_at: string;
  raw_audio_excluded: true;
}

export interface GeminiSyntheticInputTurnReceipt {
  schema: 'sophia_gemini_input_turn_v1';
  synthetic: true;
  test_run_id: string;
  operation_id: string;
  utterance_id: string;
  frame_window_id: string;
  expected_silence: boolean | null;
  source: 'provider_input_transcription' | 'public_user_turn' | 'settlement';
  outcome:
    | 'provider_input_transcription_observed'
    | 'public_user_turn_accepted'
    | 'no_user_turn_observed'
    | 'unexpected_user_turn_observed'
    | 'user_turn_observed'
    | 'user_turn_unavailable';
  observed_at: string;
  provider_receive_sequence: number | null;
  provider_received_at: string | null;
  public_utterance_id: string | null;
  transcript_length: number | null;
  settlement_window_ms: number;
  raw_audio_excluded: true;
}

export interface GeminiSyntheticInputFaultReceipt {
  schema: 'sophia_gemini_input_fault_v1';
  synthetic: true;
  test_run_id: string;
  code:
    | 'input_operation_signal_malformed'
    | 'input_operation_signal_binding_mismatch'
    | 'input_operation_phase_invalid'
    | 'input_operation_overlap_forbidden'
    | 'input_operation_turn_correlation_ambiguous';
  observed_at: string;
  provider_connection_epoch: number;
  raw_audio_excluded: true;
}

export interface GeminiSyntheticInteractionBinding {
  schema: 'sophia_gemini_interaction_binding_v1';
  synthetic: true;
  test_run_id: string;
  scenario_id: string;
  scenario_version: string;
  interaction_id: string;
  operation_id: string;
  utterance_id: string;
  frame_window_id: string;
  provider_input_sequence: number;
  public_utterance_id: string;
  public_user_turn_accepted_at: string;
  response_id: string;
  assistant_turn_id: string;
  assistant_started_at: string;
  provider_connection_epoch: number;
}

export interface GeminiSyntheticInteractionReceipt extends Omit<GeminiSyntheticInteractionBinding, 'schema'> {
  schema: 'sophia_gemini_interaction_v1';
  phase: 'assistant_response_assigned' | 'assistant_response_completed' | 'assistant_response_interrupted' | 'tool_settled' | 'output_settled';
  assistant_ended_at: string | null;
  response_boundary_reason: 'turn_complete' | 'generation_complete' | 'interrupted' | null;
  provider_first_receive_sequence: number;
  provider_last_receive_sequence: number;
  provider_event_ids: string[];
  relay_correlation_ids: string[];
  tool_call_ids: string[];
  effect_ids: string[];
  tool_final_states: Record<string, GeminiToolCallLedgerFinalState>;
  output_realization_ids: string[];
  output_provider_chunk_sequences: string[];
  output_audio_received_count: number;
  output_audio_playback_scheduled_count: number;
  output_audio_playback_started_count: number;
  output_audio_playback_completed_count: number;
  raw_audio_excluded: true;
  raw_transcript_excluded: true;
  secrets_excluded: true;
}

export interface GeminiSyntheticInteractionFaultReceipt {
  schema: 'sophia_gemini_interaction_fault_v1';
  synthetic: true;
  test_run_id: string;
  code:
    | 'interaction_synthetic_binding_incomplete'
    | 'interaction_public_turn_binding_malformed'
    | 'interaction_pending_input_overlap'
    | 'interaction_response_id_missing'
    | 'interaction_response_overlap'
    | 'interaction_response_rebind'
    | 'interaction_turn_boundary_conflict'
    | 'interaction_provider_epoch_conflict';
  operation_id: string | null;
  utterance_id: string | null;
  response_id: string | null;
  observed_at: string;
  provider_connection_epoch: number;
  raw_audio_excluded: true;
  raw_transcript_excluded: true;
  secrets_excluded: true;
}

export type GeminiBargeInNewTurnDispatchBlockedReason =
  | 'none'
  | 'not_confirmed_barge_in'
  | 'empty_transcript'
  | 'duplicate_transcript'
  | 'already_promoted_for_barge_in'
  | 'websocket_not_open'
  | 'websocket_send_failed';

export interface GeminiBargeInTranscriptHandoffDiagnostic {
  timestamp: string;
  providerReceiveSequence: number | null;
  providerReceivedAt: string | null;
  relayCorrelationId: string | null;
  text: string | null;
  transcriptPreview: string | null;
  transcriptLength: number;
  captured: boolean;
  promoted: boolean;
  ignored: boolean;
  duplicateSuppressed: boolean;
  promotionLatencyMs: number | null;
  newTurnDispatched: boolean;
  newTurnDispatchBlockedReason: GeminiBargeInNewTurnDispatchBlockedReason;
  bargeInConfirmationSource: GeminiBargeInConfirmationSource;
  bargeInConfirmationReason: string | null;
  bargeInTranscriptCapturedCount: number;
  bargeInTranscriptPromotedCount: number;
  bargeInTranscriptPromotionLatencyMs: number | null;
  bargeInTranscriptIgnoredCount: number;
  bargeInTranscriptDuplicateSuppressedCount: number;
  lastBargeInTranscriptPreview: string | null;
  bargeInNewTurnDispatchCount: number;
  bargeInNewTurnDispatchBlockedReason: GeminiBargeInNewTurnDispatchBlockedReason;
}

export type GeminiProviderEventCategory =
  | 'setupComplete'
  | 'serverContent'
  | 'inputTranscription'
  | 'outputTranscription'
  | 'modelTurnAudio'
  | 'modelTurnText'
  | 'toolCall'
  | 'toolCallCancellation'
  | 'goAway'
  | 'sessionResumptionUpdate'
  | 'usageMetadata'
  | 'error';

export type GeminiRelayClassification = 'critical' | 'summary' | 'skip';

export type GeminiRelayPriority = 'immediate' | 'local_summary' | 'local_only';

export interface GeminiProviderEventRelayClassification {
  classification: GeminiRelayClassification;
  priority: GeminiRelayPriority;
  reason: string;
  categories: GeminiProviderEventCategory[];
  shouldRelay: boolean;
}

export interface GeminiProviderReceiveMetadata {
  providerReceiveSequence: number;
  providerRelaySequence?: number;
  providerConnectionEpoch?: number;
  providerReceivedAt: string;
  relayCorrelationId: string;
  providerPrimaryCategory: GeminiProviderEventCategory | 'unknown';
  providerCategories: GeminiProviderEventCategory[];
}

export type GeminiLangSmithTraceStatus = 'available' | 'trace_unavailable';

export type GeminiLangSmithTraceUnavailableReason =
  | 'not_provided'
  | 'invalid'
  | 'governed_synthetic_fault'
  | 'synthetic_isolation_policy';

export interface GeminiLangSmithTraceContext {
  langsmithTraceId: string | null;
  langsmithTraceStatus: GeminiLangSmithTraceStatus;
  langsmithTraceUnavailableReason: GeminiLangSmithTraceUnavailableReason | null;
}

export interface GeminiVoiceLabTraceFaultReceipt {
  schema: 'sophia_voice_lab_trace_fault_v1';
  fault: 'langsmith_unavailable';
  phase: 'applied' | 'restored';
  principal_id: string;
  test_run_id: string;
  scenario_id: string;
  scenario_version: string;
  environment: string;
  expected_deployment: {
    frontend: string;
    backend: string;
    voice: string;
  };
  trace_unavailable: true;
  canonical_behavior_unchanged: true;
  applied_at: string;
  restored_at: string | null;
}

export type GeminiProviderConnectionEpochReceiptPhase =
  | 'bootstrap'
  | 'rotation_pending'
  | 'rotated'
  | 'restored'
  | 'degraded';

export interface GeminiProviderConnectionEpochReceipt extends GeminiLangSmithTraceContext {
  timestamp: string;
  phase: GeminiProviderConnectionEpochReceiptPhase;
  previousProviderConnectionEpoch: number | null;
  providerConnectionEpoch: number;
  continuityState: 'active' | 'rotation_pending' | 'degraded' | 'ended';
  reason: string;
}

export interface GeminiArtifactReviewRelayContext {
  active: true;
  artifact_id: string | null;
  source: 'coreview_still_frame';
  user_intent: GeminiArtifactReviewUserIntent;
  builder_update_intent_detected: boolean;
  selected_artifact_update_context: boolean;
  last_user_intent_at: string | null;
  expires_at: string | null;
  raw_transcript_excluded: true;
  raw_artifact_text_excluded: true;
  raw_comment_text_excluded: true;
}

export type GeminiProviderEventCategoryCounts = Record<GeminiProviderEventCategory, {
  count: number;
  lastAt: string | null;
}>;

export interface GeminiBrowserLiveProviderEventTelemetry {
  timestamp: string;
  correlationId: string;
  responseId: string | null;
  providerReceiveSequence: number | null;
  providerConnectionEpoch: number | null;
  providerReceivedAt: string | null;
  primaryCategory: GeminiProviderEventCategory | 'unknown';
  categories: GeminiProviderEventCategory[];
  categoryCounts: GeminiProviderEventCategoryCounts;
  usageMetadata: GeminiUsageMetadataTelemetry | null;
  relayClassification: GeminiRelayClassification;
  relayClassificationReason: string;
  relayShouldRelay: boolean;
  relayClassificationCounts: GeminiRelayClassificationCounts;
  toolCallIds: string[];
  toolCancellationIds: string[];
  outputAudioChunkCount: number;
  hasInputTranscriptionText: boolean;
  hasOutputTranscriptionText: boolean;
  inputTranscriptionTextPreview: string | null;
  outputTranscriptionTextPreview: string | null;
  serverContentInterrupted: boolean;
  generationComplete: boolean;
  turnComplete: boolean;
  syntheticInputOperation?: GeminiSyntheticInputOperationBinding | null;
}

export interface GeminiOutputAudioChunkDiagnostic {
  timestamp: string;
  realizationId: string;
  responseId: string | null;
  assistantTurnId: string | null;
  providerEventId: string | null;
  providerChunkSequence: string;
  providerReceiveSequence: number | null;
  providerRelaySequence: number | null;
  providerConnectionEpoch: number | null;
  providerReceivedAt: string | null;
  relayCorrelationId: string | null;
  chunkIndex: number | null;
  chunksInEvent: number | null;
  chunkHash: string | null;
  byteLength: number | null;
  base64Length: number;
  duplicateOrdinal: number | null;
  decodeStartedAt: string;
  decodeCompletedAt: string;
  sourceStartIssuedAt: string | null;
  audioContextCurrentTime: number;
  scheduledStartTime: number | null;
  durationSeconds: number;
  nextPlaybackTimeBefore: number;
  nextPlaybackTimeAfter: number;
  activeSourceCountBefore: number;
  activeSourceCountAfter: number;
  playbackGeneration: number;
  audioContextState: AudioContextState | null;
  dropReason: GeminiOutputAudioDropReason | null;
  scheduled: boolean;
  syntheticInteraction?: GeminiSyntheticInteractionBinding;
}

export interface GeminiOutputAudioReceivedDiagnostic {
  timestamp: string;
  realizationId: string;
  providerChunkSequence: string;
  providerReceiveSequence: number;
  providerRelaySequence: number | null;
  providerConnectionEpoch: number | null;
  providerReceivedAt: string;
  relayCorrelationId: string;
  responseId: string | null;
  assistantTurnId: string | null;
  providerEventId: string | null;
  chunkIndex: number;
  chunksInEvent: number;
  chunkHash: string;
  byteLength: number;
  duplicateOrdinal: number;
  playbackGeneration: number;
  syntheticInteraction?: GeminiSyntheticInteractionBinding;
}

export type GeminiOutputAudioPlaybackReceiptPhase =
  | 'scheduled'
  | 'started'
  | 'completed'
  | 'flushed'
  | 'dropped';

export interface GeminiOutputAudioPlaybackReceipt {
  timestamp: string;
  phase: GeminiOutputAudioPlaybackReceiptPhase;
  realizationId: string;
  providerChunkSequence: string;
  responseId: string | null;
  assistantTurnId: string | null;
  providerEventId: string | null;
  providerReceiveSequence: number | null;
  providerRelaySequence: number | null;
  providerConnectionEpoch: number | null;
  providerReceivedAt: string | null;
  relayCorrelationId: string | null;
  chunkIndex: number | null;
  chunksInEvent: number | null;
  chunkHash: string;
  byteLength: number;
  playbackGeneration: number;
  invalidatedByPlaybackGeneration: number | null;
  audioContextCurrentTime: number;
  scheduledStartTime: number | null;
  durationSeconds: number;
  dropReason: GeminiOutputAudioDropReason | null;
  flushReason: string | null;
  syntheticInteraction?: GeminiSyntheticInteractionBinding;
}

export type GeminiOutputLegMonitorStatus = 'verified' | 'inconclusive' | 'unavailable';

export interface GeminiOutputLegMonitorReceipt {
  schema: 'sophia_gemini_output_leg_v1';
  status: GeminiOutputLegMonitorStatus;
  reason: string | null;
  realizationId: string;
  providerChunkFingerprint: string;
  providerConnectionEpoch: number | null;
  playbackGeneration: number;
  monitorKind: 'webaudio-per-realization-final-path-analyser' | 'unavailable';
  monitorDigestAlgorithm: 'sha-256-chain-v1' | null;
  monitorDigestSha256: string | null;
  monitorWindowCount: number;
  monitorFrameCount: number;
  monitorNonSilentFrameCount: number;
  monitorRms: number | null;
  monitorPeak: number | null;
  scheduledAt: string;
  firstSampledAt: string | null;
  firstNonSilentAt: string | null;
  completedAt: string;
  monitorDurationMs: number;
  playbackDurationSeconds: number;
  completionPhase: 'completed' | 'flushed';
  rawAudioExcluded: true;
}

export type GeminiOutputAudioDropReason =
  | GeminiStaleOutputSuppressionReason
  | 'exact_transport_replay'
  | 'playback_queue_full'
  | 'invalid_pcm_payload'
  | 'artifact_review_response_suppressed';

export interface GeminiAudioContextDiagnostic {
  timestamp: string;
  stateBefore: AudioContextState | null;
  stateAfter: AudioContextState | null;
  resumeAttempted: boolean;
  resumeSucceeded: boolean | null;
  resumeError: string | null;
}

export type GeminiRelayClassificationCounts = Record<GeminiRelayClassification, {
  count: number;
  lastAt: string | null;
}>;

export type GeminiRelayResponseKind = 'client_actions' | 'tool_diagnostics' | 'client_actions_and_tool_diagnostics' | 'neither';

export interface GeminiBrowserLiveRelayTrace {
  timestamp: string;
  correlationId: string;
  providerReceiveSequence: number;
  providerConnectionEpoch: number | null;
  providerReceivedAt: string;
  eventCategory: GeminiProviderEventCategory | 'unknown';
  categories: GeminiProviderEventCategory[];
  relayClassification: GeminiRelayClassification;
  relayClassificationReason: string;
  attemptCount: number;
  successCount: number;
  failureCount: number;
  success: boolean;
  statusCode: number | null;
  statusText: string | null;
  durationMs: number;
  responseKind: GeminiRelayResponseKind;
  responseClientActionCount: number;
  responseToolDiagnosticCount: number;
  backendDiagnostics: Record<string, unknown> | null;
  orderedRelayLane: boolean;
  queueDepth: number | null;
  oldestQueuedAgeMs: number | null;
  throughput: GeminiOrderedRelayThroughputMetrics;
  aborted: boolean;
  sessionClosing: boolean;
  errorText: string | null;
}

export type GeminiBrowserLiveDogfoodToolLoopPhase =
  | 'tool_call_received'
  | 'backend_accepted_tool_call'
  | 'tool_execution_rejected'
  | 'tool_response_sent'
  | 'tool_response_send_failed'
  | 'tool_response_send_suppressed'
  | 'tool_call_cancelled';

export interface GeminiBrowserLiveDogfoodToolCallSummary {
  id: string | null;
  name: string | null;
  args: Record<string, unknown> | null;
  argsPreview: string;
}

export interface GeminiBrowserLiveDogfoodToolLoopDiagnostic {
  timestamp: string;
  phase: GeminiBrowserLiveDogfoodToolLoopPhase;
  toolCall: GeminiBrowserLiveDogfoodToolCallSummary;
  success: boolean | null;
  resultSummary: string | null;
  taskId: string | null;
  taskStatus: string | null;
  trackedTaskIds?: string[];
  rejectionReason?: string | null;
  recoveryGuidance?: string | null;
  backendResponse: Record<string, unknown> | null;
  errorText: string | null;
  suppressionReason?: string | null;
  reviewToolTimedOut?: boolean | null;
  reviewToolTimeoutName?: string | null;
  reviewToolTimeoutResultSent?: boolean | null;
}

export type GeminiToolCallLedgerFinalState =
  | 'responded'
  | 'cancelled-before-send'
  | 'cancelled-after-send'
  | 'suppressed'
  | 'rejected'
  | 'unknown';

export interface GeminiBrowserLiveToolCallLedgerEntry {
  toolCallId: string;
  effectId: string;
  providerConnectionEpoch: number;
  toolName: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  relayStartedAt: string | null;
  relayCompletedAt: string | null;
  backendAcceptedAt: string | null;
  toolResponsePreparedAt: string | null;
  toolResponseSentAt: string | null;
  sendSuppressedAt: string | null;
  suppressionReason: string | null;
  finalState: GeminiToolCallLedgerFinalState;
  syntheticToolEvidence: GeminiSyntheticToolEvidence | null;
  syntheticBuilderJoin: GeminiSyntheticBuilderJoin | null;
  syntheticInteraction?: GeminiSyntheticInteractionBinding;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type GetUserMediaLike = (constraints: MediaStreamConstraints) => Promise<MediaStream>;
type WebSocketFactory = (url: string) => WebSocketLike;
type AudioContextFactory = () => AudioContext;

interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface GeminiBrowserLiveDogfoodConnectOptions {
  userId: string;
  sessionId?: string;
  threadId?: string | null;
  bootstrapPayload?: GeminiBrowserLiveSessionBootstrap;
  fetchFn?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  getUserMedia?: GetUserMediaLike;
  audioContextFactory?: AudioContextFactory;
  transcriptRelayCadenceMs?: number;
  outputAudioMaxPlaybackAheadSeconds?: number;
  outputAudioMaxQueuedChunks?: number;
  coreviewStillFrameEnabled?: boolean;
  reviewToolTimeoutMs?: number;
  onStage?: (stage: GeminiBrowserLiveDogfoodStage) => void;
  onProviderEvent?: (event: unknown) => void;
  onOutputAudioReceived?: (diagnostic: GeminiOutputAudioReceivedDiagnostic) => void;
  /** @deprecated This callback reports provider audio accepted for local playback, not realized playback. */
  onOutputAudio?: () => void;
  onOutputAudioChunk?: (diagnostic: GeminiOutputAudioChunkDiagnostic) => void;
  onOutputAudioPlaybackReceipt?: (receipt: GeminiOutputAudioPlaybackReceipt) => void;
  onOutputLegMonitorReceipt?: (receipt: GeminiOutputLegMonitorReceipt) => void;
  onProviderConnectionEpoch?: (receipt: GeminiProviderConnectionEpochReceipt) => void;
  onAudioContextDiagnostics?: (diagnostic: GeminiAudioContextDiagnostic) => void;
  onMicrophoneAudioSettings?: (diagnostic: GeminiMicrophoneAudioSettingsDiagnostic) => void;
  onRepeatedIntentGate?: (diagnostic: GeminiRepeatedIntentGateDiagnostic) => void;
  onRelayStatus?: (status: GeminiBrowserLiveDogfoodRelayStatus) => void;
  onRelayError?: (error: unknown) => void;
  onRelayDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodRelayDiagnostic) => void;
  onRelayCoalescingDiagnostic?: (diagnostic: GeminiTranscriptPartialCoalescingDiagnostic) => void;
  onProviderEventTelemetry?: (telemetry: GeminiBrowserLiveProviderEventTelemetry) => void;
  onRelayTrace?: (trace: GeminiBrowserLiveRelayTrace) => void;
  onToolCallLedgerUpdate?: (entry: GeminiBrowserLiveToolCallLedgerEntry) => void;
  onWebSocketDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodWebSocketDiagnostic) => void;
  onInterruption?: (diagnostic: GeminiBrowserLiveDogfoodInterruptionDiagnostic) => void;
  onStaleOutputSuppression?: (diagnostic: GeminiStaleOutputSuppressionDiagnostic) => void;
  onInputAudioActivity?: (diagnostic: GeminiInputAudioActivityDiagnostic) => void;
  onSyntheticInputLegReceipt?: (receipt: GeminiSyntheticInputLegReceipt) => void;
  onSyntheticInputTurnReceipt?: (receipt: GeminiSyntheticInputTurnReceipt) => void;
  onSyntheticInputFaultReceipt?: (receipt: GeminiSyntheticInputFaultReceipt) => void;
  onSyntheticInteractionReceipt?: (receipt: GeminiSyntheticInteractionReceipt) => void;
  onSyntheticInteractionFaultReceipt?: (receipt: GeminiSyntheticInteractionFaultReceipt) => void;
  onSyntheticTraceFaultReceipt?: (receipt: GeminiVoiceLabTraceFaultReceipt) => void;
  onBargeInTranscriptHandoff?: (diagnostic: GeminiBargeInTranscriptHandoffDiagnostic) => void;
  onToolLoopDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => void;
}

export interface GeminiBrowserLiveProductionConnectOptions extends Omit<GeminiBrowserLiveDogfoodConnectOptions, 'bootstrapPayload'> {
  bootstrap: GeminiBrowserLiveSessionBootstrap;
}

export interface GeminiProviderCleanupControl {
  providerConnectionEpochs: number[];
}

/**
 * The exact canonical browser-terminal arrays echoed by the authenticated
 * Gateway disconnect response.  This deliberately excludes the cleanup token,
 * raw response metadata, and any locally invented success marker.
 */
export interface GeminiProviderCleanupSettlementAcknowledgement {
  browser_provider_close_receipts: Record<string, unknown>[];
  browser_provider_activation_abort_receipts: Record<string, unknown>[];
}

export interface GeminiBrowserLiveDogfoodConnection {
  userId: string;
  sessionId: string;
  streamUrl: string;
  websocketUrl: string;
  relayUrl: string | null;
  publicEventBoundary: string | null;
  transport: string | null;
  setup: Record<string, unknown>;
  setupComplete: true;
  websocket: WebSocketLike;
  localStream: MediaStream;
  microphoneAudioSettings: GeminiMicrophoneAudioSettingsDiagnostic;
  sendText: (text: string) => void;
  sendArtifactFrame: (
    frame: GeminiArtifactFramePayload,
    context?: GeminiArtifactFrameSendContext,
  ) => Promise<GeminiArtifactFrameSendResult>;
  getArtifactFrameTransportStatus: () => GeminiArtifactFrameTransportStatusSnapshot;
  setMicrophoneMuted: (muted: boolean) => void;
  acknowledgeSyntheticPublicUserTurn: (input: {
    publicUtteranceId?: string | null;
    transcriptLength: number;
  }) => void;
  flushOutputAudio: () => GeminiOutputAudioPlaybackState;
  close: (
    control?: GeminiProviderCleanupControl,
  ) => Promise<GeminiProviderCleanupSettlementAcknowledgement | null>;
  readonly providerConnectionEpoch: number;
  getProviderConnectionEpoch: () => number;
  getProviderSocketEpochs: () => number[];
  readonly continuityState: 'active' | 'rotation_pending' | 'degraded' | 'ended';
  readonly langsmithTraceId: string | null;
  readonly langsmithTraceStatus: GeminiLangSmithTraceStatus;
  readonly langsmithTraceUnavailableReason: GeminiLangSmithTraceUnavailableReason | null;
  readonly syntheticTest: GeminiSyntheticTestContext | null;
  readonly syntheticTraceFault: GeminiVoiceLabTraceFaultReceipt | null;
}

export interface GeminiArtifactFrameDimensions {
  width: number;
  height: number;
}

export interface GeminiArtifactFramePayload {
  artifactId?: string | null;
  visualSourceKind?: string | null;
  data: string;
  mimeType: string;
  byteLength: number;
  dimensions: GeminiArtifactFrameDimensions;
  rawFrameExcluded: true;
}

export interface GeminiArtifactFrameSendContext {
  coreviewSendStage?: 'start' | 'refresh' | null;
}

export interface GeminiUsageMetadataTelemetry {
  imageCount: number | null;
  videoDurationSeconds: number | null;
  audioDurationSeconds: number | null;
  totalTokenCount: number | null;
  rawUsageMetadataExcluded: true;
}

export interface GeminiArtifactFrameTransportStatusSnapshot {
  websocketReadyState: number | null;
  websocketState: string;
  websocketOpen: boolean;
  websocketCloseCode: number | null;
  websocketCloseReasonSafe: string | null;
  websocketCloseWasClean: boolean | null;
  websocketCloseAt: string | null;
  error: string | null;
}

export interface GeminiArtifactFrameSendResult {
  coreviewSendStage: 'start' | 'refresh' | null;
  artifactId: string | null;
  ok: boolean;
  supported: boolean;
  providerAcceptedFrame: boolean;
  websocketSendAccepted: boolean;
  websocketReadyStateBefore: number | null;
  websocketReadyStateAfter: number | null;
  websocketOpenBeforeSend: boolean;
  websocketOpenAfterSend: boolean;
  framePayloadSchemaVersion: string;
  frameBytes: number;
  frameDimensions: GeminiArtifactFrameDimensions;
  visualSourceKind: string | null;
  mimeType: string;
  frameSendLatencyMs: number;
  sendStartedAt: string;
  sendCompletedAt: string;
  sendDurationMs: number;
  sendExceptionName: string | null;
  sendExceptionSafeMessage: string | null;
  providerEventCountBefore: number | null;
  providerEventCountAfter: number | null;
  lastProviderEventTypeBefore: string | null;
  lastProviderEventTypeAfter: string | null;
  websocketCloseCode: number | null;
  websocketCloseReasonSafe: string | null;
  websocketCloseWasClean: boolean | null;
  websocketCloseAt: string | null;
  websocketClosedAfterFrameSend: boolean;
  timeFromFrameSendToCloseMs: number | null;
  usageMetadataAfterFrame: GeminiUsageMetadataTelemetry | null;
  imageCountAfterFrame: number | null;
  videoDurationSecondsAfterFrame: number | null;
  audioDurationSecondsAfterFrame: number | null;
  visualResponseObserved: boolean;
  estimatedVisualCost: number | null;
  error: string | null;
  rawFrameExcluded: true;
}

export interface BrowserSessionPayload {
  runtime?: unknown;
  voice_runtime?: unknown;
  production_route?: unknown;
  session_id?: unknown;
  websocket_url?: unknown;
  ephemeral_token?: unknown;
  setup?: unknown;
  stream_url?: unknown;
  event_stream_url?: unknown;
  provider_event_relay_url?: unknown;
  public_event_boundary?: unknown;
  transport?: unknown;
  disconnect_url?: unknown;
  backendCoreviewFlagParsed?: unknown;
  backendStillFrameFlagParsed?: unknown;
  audio_capture_enabled?: unknown;
  continuation_bootstrap_url?: unknown;
  provider_activation_url?: unknown;
  provider_cleanup_token?: unknown;
  provider_cleanup_expires_at?: unknown;
  provider_connection_epoch?: unknown;
  logical_session_id?: unknown;
  voice_runtime_session_id?: unknown;
  langsmith_trace_id?: unknown;
  langsmith_trace_unavailable_reason?: unknown;
  synthetic_test?: unknown;
  trace_fault?: unknown;
}

export type GeminiBrowserLiveSessionBootstrap = BrowserSessionPayload;

export type GeminiSyntheticTestContext = {
  synthetic: true;
  principal_id: string;
  test_run_id: string;
  scenario_id?: string;
  scenario_version?: string;
  voice_lab_run_id_sha256?: string;
  browser_worker_id_sha256?: string;
  browser_lease_epoch?: number;
  browser_context_id_sha256?: string;
  environment: string;
  retention_hours: number;
  cleanup_obligation_id: string;
  provider_expires_at: string;
};

interface EphemeralTokenPayload {
  value?: unknown;
  name?: unknown;
  expireTime?: unknown;
}

interface DogfoodErrorPayload {
  detail?: unknown;
  error?: unknown;
  message?: unknown;
}

interface GeminiRelayClientAction {
  type?: unknown;
  payload?: unknown;
  result_summary?: unknown;
  resultSummary?: unknown;
}

interface GeminiRelayToolDiagnosticPayload {
  id?: unknown;
  name?: unknown;
  success?: unknown;
  cancelled?: unknown;
  task_id?: unknown;
  taskId?: unknown;
  task_status?: unknown;
  taskStatus?: unknown;
  tracked_task_ids?: unknown;
  trackedTaskIds?: unknown;
  execution_rejected?: unknown;
  executionRejected?: unknown;
  rejection_reason?: unknown;
  rejectionReason?: unknown;
  recovery_guidance?: unknown;
  recoveryGuidance?: unknown;
  error_text?: unknown;
  errorText?: unknown;
  result_summary?: unknown;
  resultSummary?: unknown;
  response?: unknown;
}

interface GeminiBrowserLiveDogfoodRelayResponsePayload {
  accepted?: unknown;
  client_actions?: unknown;
  clientActions?: unknown;
  tool_diagnostics?: unknown;
  toolDiagnostics?: unknown;
  diagnostics?: unknown;
}

interface GeminiBrowserLiveDogfoodRelayResponse {
  accepted: boolean;
  clientActions: GeminiRelayClientAction[];
  toolDiagnostics: GeminiRelayToolDiagnosticPayload[];
  statusCode: number | null;
  statusText: string | null;
  responseKind: GeminiRelayResponseKind;
  backendDiagnostics: Record<string, unknown> | null;
}

interface AudioPipeline {
  setMuted: (muted: boolean) => void;
  stop: () => Promise<void>;
}

interface GeminiConversationAudioRecording {
  data: ArrayBuffer;
  mimeType: string;
}

interface GeminiConversationAudioRecorder {
  inputNode: AudioNode;
  outputNode: AudioNode;
  stop: () => Promise<GeminiConversationAudioRecording | null>;
}

type GeminiOutputLegMonitorRealization = {
  realizationId: string;
  providerChunkFingerprint: string;
  providerConnectionEpoch: number | null;
  playbackGeneration: number;
  scheduledAt: string;
  firstSampledAt: string | null;
  firstNonSilentAt: string | null;
  lastSampledAt: string | null;
  windowCount: number;
  frameCount: number;
  nonSilentFrameCount: number;
  squareSum: number;
  peak: number;
  digest: Uint8Array;
  digestSequence: number;
  digestPromise: Promise<void>;
  digestFailed: boolean;
  analyser: AnalyserNode;
  samples: Float32Array;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: string | null;
  samplingBusy: boolean;
  sampleInFlight: Promise<void>;
};

interface GeminiOutputLegMonitor {
  outputNode: AudioNode;
  begin: (metadata: {
    realizationId: string;
    providerChunkFingerprint: string;
    providerConnectionEpoch: number | null;
    playbackGeneration: number;
    scheduledAt: string;
  }, downstreamNode: AudioNode) => AudioNode;
  markStarted: (realizationId: string, startedAt: string) => void;
  finish: (
    realizationId: string,
    phase: 'completed' | 'flushed',
    completedAt: string,
    playbackDurationSeconds: number,
  ) => Promise<GeminiOutputLegMonitorReceipt>;
  stop: () => void;
}

export interface GeminiOutputAudioPlaybackState {
  nextPlaybackTime: number;
  activeSourceCount: number;
  playbackGeneration: number;
  queuedChunkCount: number;
  playbackAheadSeconds: number;
}

export interface GeminiOutputAudioPlaybackController {
  playEvent: (event: Record<string, unknown>, receiveMetadata?: GeminiProviderReceiveMetadata) => number;
  playBase64Chunk: (chunk: string) => boolean;
  dropEvent: (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata | undefined,
    reason: GeminiOutputAudioDropReason,
  ) => number;
  stop: (reason?: string) => void;
  flush: (reason?: string) => GeminiOutputAudioPlaybackState;
  snapshot: () => GeminiOutputAudioPlaybackState;
}

interface GeminiOutputAudioPlaybackControllerOptions {
  maxDiagnostics?: number;
  onChunkReceived?: (diagnostic: GeminiOutputAudioReceivedDiagnostic) => void;
  onChunkDiagnostic?: (diagnostic: GeminiOutputAudioChunkDiagnostic) => void;
  onPlaybackReceipt?: (receipt: GeminiOutputAudioPlaybackReceipt) => void;
  onOutputLegMonitorReceipt?: (receipt: GeminiOutputLegMonitorReceipt) => void;
  outputLegMonitor?: GeminiOutputLegMonitor;
  outputNode?: AudioNode;
  maxPlaybackAheadSeconds?: number;
  maxQueuedChunks?: number;
  duplicateReplayWindowMs?: number;
  nowMs?: () => number;
}

function outputLegUnavailableReceipt(
  realizationId: string,
  phase: 'completed' | 'flushed',
  completedAt: string,
  playbackDurationSeconds: number,
  metadata?: {
    providerChunkFingerprint: string;
    providerConnectionEpoch: number | null;
    playbackGeneration: number;
    scheduledAt: string;
  },
): GeminiOutputLegMonitorReceipt {
  return {
    schema: 'sophia_gemini_output_leg_v1',
    status: 'unavailable',
    reason: 'webaudio_output_monitor_unavailable',
    realizationId,
    providerChunkFingerprint: metadata?.providerChunkFingerprint ?? 'unavailable',
    providerConnectionEpoch: metadata?.providerConnectionEpoch ?? null,
    playbackGeneration: metadata?.playbackGeneration ?? 0,
    monitorKind: 'unavailable',
    monitorDigestAlgorithm: null,
    monitorDigestSha256: null,
    monitorWindowCount: 0,
    monitorFrameCount: 0,
    monitorNonSilentFrameCount: 0,
    monitorRms: null,
    monitorPeak: null,
    scheduledAt: metadata?.scheduledAt ?? completedAt,
    firstSampledAt: null,
    firstNonSilentAt: null,
    completedAt,
    monitorDurationMs: 0,
    playbackDurationSeconds,
    completionPhase: phase,
    rawAudioExcluded: true,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Monitor the actual final WebAudio output bus without retaining PCM bytes.
 * Each bounded analyser window is SHA-256 hashed immediately, then folded into
 * a per-realization SHA-256 chain. Only the chain and derived metrics survive.
 */
export function createGeminiOutputLegMonitor(
  audioContext: AudioContext,
  sampleIntervalMs = 20,
): GeminiOutputLegMonitor {
  const createAnalyser = audioContext.createAnalyser?.bind(audioContext);
  const subtle = globalThis.crypto?.subtle;
  if (!createAnalyser || !subtle) {
    const metadata = new Map<string, {
      providerChunkFingerprint: string;
      providerConnectionEpoch: number | null;
      playbackGeneration: number;
      scheduledAt: string;
    }>();
    return {
      outputNode: audioContext.destination,
      begin: (entry, downstreamNode) => {
        metadata.set(entry.realizationId, entry);
        return downstreamNode;
      },
      markStarted: () => undefined,
      finish: async (realizationId, phase, completedAt, duration) => {
        const entry = metadata.get(realizationId);
        metadata.delete(realizationId);
        return outputLegUnavailableReceipt(realizationId, phase, completedAt, duration, entry);
      },
      stop: () => metadata.clear(),
    };
  }
  const active = new Map<string, GeminiOutputLegMonitorRealization>();
  let stopped = false;

  const sampleRealization = (realization: GeminiOutputLegMonitorRealization) => {
    if (stopped || realization.samplingBusy || realization.startedAt === null) return;
    realization.analyser.getFloatTimeDomainData(
      realization.samples as Float32Array<ArrayBuffer>,
    );
    const sampledAt = new Date().toISOString();
    const canonical = new Uint8Array(realization.samples.length * 2);
    const view = new DataView(canonical.buffer);
    let squareSum = 0;
    let peak = 0;
    let nonSilent = 0;
    for (let index = 0; index < realization.samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, realization.samples[index] ?? 0));
      const absolute = Math.abs(sample);
      squareSum += sample * sample;
      peak = Math.max(peak, absolute);
      if (absolute >= 0.0005) nonSilent += 1;
      const pcm16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(index * 2, pcm16, true);
    }
    realization.windowCount += 1;
    realization.frameCount += realization.samples.length;
    realization.nonSilentFrameCount += nonSilent;
    realization.squareSum += squareSum;
    realization.peak = Math.max(realization.peak, peak);
    realization.firstSampledAt ??= sampledAt;
    realization.lastSampledAt = sampledAt;
    if (nonSilent > 0) realization.firstNonSilentAt ??= sampledAt;

    realization.samplingBusy = true;
    const frameDigest = subtle.digest('SHA-256', canonical.buffer as ArrayBuffer);
    realization.digestSequence += 1;
    const sequence = realization.digestSequence;
    realization.digestPromise = realization.digestPromise.then(async () => {
      try {
        const frame = new Uint8Array(await frameDigest);
        const chained = new Uint8Array(68);
        chained.set(realization.digest, 0);
        chained.set(frame, 32);
        new DataView(chained.buffer).setUint32(64, sequence, false);
        realization.digest = new Uint8Array(
          await subtle.digest('SHA-256', chained.buffer as ArrayBuffer),
        );
      } catch {
        realization.digestFailed = true;
      }
    });
    realization.sampleInFlight = frameDigest
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        realization.samplingBusy = false;
      });
  };

  const finishRealization = async (
    realization: GeminiOutputLegMonitorRealization,
    phase: 'completed' | 'flushed',
    completedAt: string,
    playbackDurationSeconds: number,
  ): Promise<GeminiOutputLegMonitorReceipt> => {
    if (realization.timer !== null) {
      clearInterval(realization.timer);
      realization.timer = null;
    }
    await realization.sampleInFlight;
    if (!stopped && realization.startedAt !== null) {
      sampleRealization(realization);
      await realization.sampleInFlight;
    }
    await realization.digestPromise;
    active.delete(realization.realizationId);
    realization.analyser.disconnect();
    const rms = realization.frameCount > 0
      ? Math.sqrt(realization.squareSum / realization.frameCount)
      : null;
    const startedMs = Date.parse(
      realization.firstNonSilentAt ?? realization.firstSampledAt ?? realization.scheduledAt,
    );
    const endedMs = Date.parse(realization.lastSampledAt ?? completedAt);
    const cryptographicDigest = !realization.digestFailed && realization.digestSequence > 0
      ? bytesToHex(realization.digest)
      : null;
    const verified = phase === 'completed'
      && cryptographicDigest !== null
      && realization.nonSilentFrameCount > 0
      && realization.frameCount > 0
      && playbackDurationSeconds > 0;
    return {
      schema: 'sophia_gemini_output_leg_v1',
      status: verified ? 'verified' : 'inconclusive',
      reason: verified ? null : (
        realization.digestFailed
          ? 'output_monitor_digest_failed'
          : realization.startedAt === null
              ? 'output_monitor_playback_not_started'
            : phase === 'flushed'
              ? 'output_playback_flushed'
              : 'output_monitor_no_non_silent_frames'
      ),
      realizationId: realization.realizationId,
      providerChunkFingerprint: realization.providerChunkFingerprint,
      providerConnectionEpoch: realization.providerConnectionEpoch,
      playbackGeneration: realization.playbackGeneration,
      monitorKind: 'webaudio-per-realization-final-path-analyser',
      monitorDigestAlgorithm: 'sha-256-chain-v1',
      monitorDigestSha256: cryptographicDigest,
      monitorWindowCount: realization.windowCount,
      monitorFrameCount: realization.frameCount,
      monitorNonSilentFrameCount: realization.nonSilentFrameCount,
      monitorRms: rms,
      monitorPeak: realization.peak,
      scheduledAt: realization.scheduledAt,
      firstSampledAt: realization.firstSampledAt,
      firstNonSilentAt: realization.firstNonSilentAt,
      completedAt,
      monitorDurationMs: Number.isFinite(startedMs) && Number.isFinite(endedMs)
        ? Math.max(0, endedMs - startedMs)
        : 0,
      playbackDurationSeconds,
      completionPhase: phase,
      rawAudioExcluded: true,
    };
  };

  return {
    outputNode: audioContext.destination,
    begin: (metadata, downstreamNode) => {
      const analyser = createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      analyser.connect(downstreamNode);
      active.set(metadata.realizationId, {
        ...metadata,
        firstSampledAt: null,
        firstNonSilentAt: null,
        lastSampledAt: null,
        windowCount: 0,
        frameCount: 0,
        nonSilentFrameCount: 0,
        squareSum: 0,
        peak: 0,
        digest: new Uint8Array(32),
        digestSequence: 0,
        digestPromise: Promise.resolve(),
        digestFailed: false,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        timer: null,
        startedAt: null,
        samplingBusy: false,
        sampleInFlight: Promise.resolve(),
      });
      return analyser;
    },
    markStarted: (realizationId, startedAt) => {
      const realization = active.get(realizationId);
      if (!realization || realization.startedAt !== null || stopped) return;
      realization.startedAt = startedAt;
      sampleRealization(realization);
      realization.timer = setInterval(
        () => sampleRealization(realization),
        Math.max(10, sampleIntervalMs),
      );
    },
    finish: async (realizationId, phase, completedAt, playbackDurationSeconds) => {
      const realization = active.get(realizationId);
      if (!realization) {
        return outputLegUnavailableReceipt(
          realizationId,
          phase,
          completedAt,
          playbackDurationSeconds,
        );
      }
      return finishRealization(
        realization,
        phase,
        completedAt,
        playbackDurationSeconds,
      );
    },
    stop: () => {
      stopped = true;
      for (const realization of active.values()) {
        if (realization.timer !== null) clearInterval(realization.timer);
        realization.timer = null;
        realization.analyser.disconnect();
      }
    },
  };
}

export function createGeminiConversationAudioRecorder(
  audioContext: AudioContext,
  outputDestination: AudioNode = audioContext.destination,
): GeminiConversationAudioRecorder | null {
  if (
    typeof MediaRecorder === 'undefined'
    || typeof audioContext.createMediaStreamDestination !== 'function'
    || typeof audioContext.createChannelMerger !== 'function'
    || typeof audioContext.createGain !== 'function'
  ) {
    return null;
  }

  const mimeType = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ].find((candidate) => (
    typeof MediaRecorder.isTypeSupported !== 'function'
      || MediaRecorder.isTypeSupported(candidate)
  )) ?? '';

  const destination = audioContext.createMediaStreamDestination();
  const merger = audioContext.createChannelMerger(2);
  const inputGain = audioContext.createGain();
  const outputGain = audioContext.createGain();
  inputGain.connect(merger, 0, 0);
  outputGain.connect(merger, 0, 1);
  // The recorder is a tee: LangSmith needs the mixed conversation stream,
  // while the user still needs the assistant leg at the speakers. Connecting
  // only to the MediaStreamDestination makes all provider audio measurable
  // but inaudible whenever audio capture is enabled.
  outputGain.connect(outputDestination);
  merger.connect(destination);

  let recorder: MediaRecorder;
  try {
    recorder = mimeType
      ? new MediaRecorder(destination.stream, { mimeType })
      : new MediaRecorder(destination.stream);
  } catch {
    return null;
  }

  const chunks: Blob[] = [];
  let stopPromise: Promise<GeminiConversationAudioRecording | null> | null = null;
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  try {
    recorder.start(1000);
  } catch {
    return null;
  }

  return {
    inputNode: inputGain,
    outputNode: outputGain,
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopPromise = new Promise((resolve) => {
        recorder.onstop = () => {
          if (!chunks.length) {
            resolve(null);
            return;
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
          void blob.arrayBuffer().then((data) => resolve({
            data,
            mimeType: blob.type || mimeType || 'audio/webm',
          })).catch(() => resolve(null));
        };
        recorder.onerror = () => resolve(null);
        if (recorder.state === 'inactive') {
          if (!chunks.length) {
            resolve(null);
            return;
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
          void blob.arrayBuffer().then((data) => resolve({
            data,
            mimeType: blob.type || mimeType || 'audio/webm',
          })).catch(() => resolve(null));
        } else {
          recorder.stop();
        }
      });
      return stopPromise;
    },
  };
}

async function resumeGeminiAudioContext(
  audioContext: AudioContext,
): Promise<GeminiAudioContextDiagnostic> {
  const stateBefore = typeof audioContext.state === 'string' ? audioContext.state : null;
  let resumeAttempted = false;
  let resumeSucceeded: boolean | null = null;
  let resumeError: string | null = null;

  if (stateBefore === 'suspended' && typeof audioContext.resume === 'function') {
    resumeAttempted = true;
    try {
      await audioContext.resume();
      resumeSucceeded = true;
    } catch (error) {
      resumeSucceeded = false;
      resumeError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    stateBefore,
    stateAfter: typeof audioContext.state === 'string' ? audioContext.state : null,
    resumeAttempted,
    resumeSucceeded,
    resumeError,
  };
}

function recordGeminiMicrophoneAudioSettings(
  stream: MediaStream,
): GeminiMicrophoneAudioSettingsDiagnostic {
  const tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
  return {
    timestamp: new Date().toISOString(),
    requested: { ...REQUESTED_MICROPHONE_AUDIO_CONSTRAINTS },
    tracks: tracks.map((track) => {
      const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
      const latency = (settings as MediaTrackSettings & { latency?: number }).latency;
      return {
        echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
        noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
        autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
        sampleRate: typeof settings.sampleRate === 'number' ? settings.sampleRate : null,
        channelCount: typeof settings.channelCount === 'number' ? settings.channelCount : null,
        latency: typeof latency === 'number' ? latency : null,
      };
    }),
  };
}

interface GeminiOutputAudioChunkMetadata {
  receiveMetadata?: GeminiProviderReceiveMetadata;
  responseId: string | null;
  assistantTurnId: string | null;
  providerEventId: string | null;
  chunkIndex: number;
  chunksInEvent: number;
  chunkHash: string;
  byteLength: number;
  duplicateOrdinal: number;
  realizationId: string;
  providerChunkSequence: string;
}

interface GeminiOrderedRelayTask {
  id: number;
  queuedAtMs: number;
  providerReceiveSequence: number;
  relayCorrelationId: string;
  coalescingKey: string | null;
  run: (queueDepth: number | null, oldestQueuedAgeMs: number | null) => Promise<void>;
}

interface GeminiRelayFailureDetail {
  targetPath: string;
  eventType: string;
  requestBodyBytes: number;
  hasHttpResponse: boolean;
  statusCode: number | null;
  statusText: string | null;
  errorText: string;
  fetchErrorName: string | null;
}

class GeminiRelayFetchError extends Error {
  constructor(
    message: string,
    readonly detail: GeminiRelayFailureDetail,
  ) {
    super(message);
    this.name = 'GeminiRelayFetchError';
  }
}

const DEFAULT_GEMINI_LIVE_WEBSOCKET_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const INPUT_AUDIO_RATE_HZ = 16000;
const OUTPUT_AUDIO_RATE_HZ = 24000;
const RELAY_TARGET_PATH = '/api/sophia/voice/dogfood/gemini/relay';
const DISCONNECT_TARGET_PATH = '/api/sophia/voice/dogfood/gemini/disconnect';
const MAX_CONSECUTIVE_RELAY_FAILURES = 3;
const MAX_OUTPUT_AUDIO_CHUNK_DIAGNOSTICS = 160;
const MAX_TRANSCRIPTION_TELEMETRY_PREVIEW_CHARS = 240;
const DEFAULT_OUTPUT_TRANSCRIPT_RELAY_CADENCE_MS = 250;
const DEFAULT_OUTPUT_AUDIO_MAX_PLAYBACK_AHEAD_SECONDS = 0.75;
const DEFAULT_OUTPUT_AUDIO_MAX_QUEUED_CHUNKS = 96;
const DEFAULT_OUTPUT_AUDIO_DUPLICATE_REPLAY_WINDOW_MS = 2_000;
const MAX_RECENT_AUDIO_TRANSPORT_FINGERPRINTS = 128;
const MAX_AUDIO_CHUNK_HASH_COUNTS = 512;
const MAX_REPEATED_INTENT_RESPONSE_STATES = 32;
const GEMINI_RETRIEVE_MEMORIES_TOOL_NAME = 'retrieve_memories';
const REQUESTED_MICROPHONE_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const GEMINI_ARTIFACT_FRAME_PAYLOAD_SCHEMA_VERSION = 'realtimeInput.video.v1';
const ARTIFACT_FRAME_SEND_SETTLE_MS = 125;
const ARTIFACT_REVIEW_RELAY_CONTEXT_TTL_MS = 10 * 60 * 1000;
const GEMINI_REVIEW_TOOL_TIMEOUT_MS = 1_000;
const MAX_SAFE_DIAGNOSTIC_TEXT_CHARS = 180;
const BARGE_IN_CANDIDATE_DECAY_MS = 650;
const PROVIDER_INPUT_TRANSCRIPTION_CONFIRMATION_DELAY_MS = 350;
const COREVIEW_FOLLOW_UP_TRANSCRIPT_WINDOW_MS = 15_000;
const RELAYABLE_GEMINI_PROVIDER_EVENT_KEYS = new Set([
  'setupComplete',
  'setup_complete',
  'serverContent',
  'server_content',
  'toolCall',
  'tool_call',
  'toolCallCancellation',
  'tool_call_cancellation',
  'goAway',
  'go_away',
  'sessionResumptionUpdate',
  'session_resumption_update',
  'usageMetadata',
  'usage_metadata',
  'error',
]);
const ZERO_FIELD_GEMINI_PROVIDER_EVENT_KEYS = new Set(['setupComplete', 'setup_complete']);
const GEMINI_EMIT_ARTIFACT_TOOL_NAME = 'emit_artifact';
const GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME = 'edit_builder_artifact';
const GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME = 'read_artifact_text';
type GeminiReadArtifactTextToolCallInput = {
  id: string | null;
  name: typeof GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME;
  args: Record<string, unknown>;
};
type GeminiSuppressedEmitArtifactToolCallInput = {
  id: string | null;
  name: typeof GEMINI_EMIT_ARTIFACT_TOOL_NAME;
  args: Record<string, unknown>;
};
type GeminiSuppressedGenericBuilderToolCallInput = {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  duplicateOfCoreviewUpdate?: boolean;
};
type GeminiCoreviewRoutedBuilderToolCallInput = {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  routeKind: 'direct_edit_builder_artifact' | 'generic_builder_status';
  coreviewCall: CoreviewBuilderToolCallInput;
};
type GeminiFrontendReviewToolCallInput =
  | CoreviewToolCallInput
  | CoreviewBuilderToolCallInput
  | GeminiReadArtifactTextToolCallInput
  | GeminiCoreviewRoutedBuilderToolCallInput;
const GEMINI_GENERIC_BUILDER_TOOL_NAMES = new Set([
  'start_builder_task',
  GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks',
]);
const GEMINI_SELECTED_ARTIFACT_REVIEW_REDIRECT_BUILDER_TOOL_NAMES = new Set([
  'start_builder_task',
  GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks',
]);
const GEMINI_PROVIDER_EVENT_CATEGORIES: GeminiProviderEventCategory[] = [
  'setupComplete',
  'serverContent',
  'inputTranscription',
  'outputTranscription',
  'modelTurnAudio',
  'modelTurnText',
  'toolCall',
  'toolCallCancellation',
  'goAway',
  'sessionResumptionUpdate',
  'usageMetadata',
  'error',
];

export async function connectGeminiBrowserLiveDogfood(
  options: GeminiBrowserLiveDogfoodConnectOptions,
): Promise<GeminiBrowserLiveDogfoodConnection> {
  const fetchFn = options.fetchFn ?? fetch;
  const webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  const getUserMedia = options.getUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const audioContextFactory = options.audioContextFactory ?? (() => new AudioContext());
  const notifyStage = (stage: GeminiBrowserLiveDogfoodStage) => options.onStage?.(stage);
  const notifyRelayStatus = (status: GeminiBrowserLiveDogfoodRelayStatus) => options.onRelayStatus?.(status);
  const notifyAudioContextDiagnostics = (diagnostic: GeminiAudioContextDiagnostic) => {
    options.onAudioContextDiagnostics?.(diagnostic);
  };

  let websocket: WebSocketLike | null = null;
  const websocketRef: { current: WebSocketLike | null } = { current: null };
  let localStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let audioPipeline: AudioPipeline | null = null;
  let outputAudioPlayer: GeminiOutputAudioPlaybackController | null = null;
  let outputLegMonitor: GeminiOutputLegMonitor | null = null;
  let syntheticInputEvidence: GeminiSyntheticInputEvidenceTracker | null = null;
  let syntheticInteractionEvidence: GeminiSyntheticInteractionEvidenceTracker | null = null;
  let syntheticInputEvidenceFaulted = false;
  let syntheticTestContext: GeminiSyntheticTestContext | null = null;
  let syntheticTraceFault: GeminiVoiceLabTraceFaultReceipt | null = null;
  let conversationAudioRecorder: GeminiConversationAudioRecorder | null = null;
  let microphoneAudioSettings: GeminiMicrophoneAudioSettingsDiagnostic = {
    timestamp: new Date().toISOString(),
    requested: { ...REQUESTED_MICROPHONE_AUDIO_CONSTRAINTS },
    tracks: [],
  };
  let dogfoodSessionId: string | null = null;
  let disconnectTargetPath = DISCONNECT_TARGET_PATH;
  let providerCleanupToken: string | null = null;
  let providerCleanupExpiresAt: string | null = null;
  let cleanupProviderAdmissionId: string | null = null;
  let closed = false;
  let relayConsecutiveFailures = 0;
  let relayFailureObserved = false;
  let relayAttemptCount = 0;
  let relaySuccessCount = 0;
  let relayFailureCount = 0;
  let providerConnectionEpoch = 1;
  let providerExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  const providerSocketEpochs = new WeakMap<WebSocketLike, number>();
  const providerSockets = new Set<WebSocketLike>();
  const unsettledProviderEpochs = new Set<number>();
  const knownProviderCandidateEpochs = new Set<number>();
  const providerCloseReceiptsByEpoch = new Map<number, Record<string, unknown>>();
  const activationAbortReceiptsByEpoch = new Map<number, Record<string, unknown>>();
  const observedProviderSocketCloses = new WeakMap<WebSocketLike, {
    epoch: number;
    event: CloseEvent;
    observedAt: string;
  }>();
  const pendingProviderSocketCloses = new Map<WebSocketLike, {
    socket: WebSocketLike;
    epoch: number;
    resolve: (value: { event: CloseEvent; observedAt: string } | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let cleanupInFlight: Promise<void> | null = null;
  let cleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupRetryAttempt = 0;
  let cleanupTeardownComplete = false;
  let providerCleanupGeneration = 0;
  let cleanupRequestedProviderEpochs: number[] | null = null;
  let pendingContinuationCandidateExpected: number | null = null;
  let cleanupConversationAudio: GeminiConversationAudioRecording | null = null;
  let cleanupBrowserCloseReceipts: Record<string, unknown>[] = [];
  let cleanupActivationAbortReceipts: Record<string, unknown>[] = [];
  let cleanupDisconnectAcknowledged = false;
  let cleanupSettlementAcknowledgement: GeminiProviderCleanupSettlementAcknowledgement | null = null;
  let continuityState: GeminiBrowserLiveDogfoodConnection['continuityState'] = 'active';
  let langsmithTraceContext: GeminiLangSmithTraceContext = {
    langsmithTraceId: null,
    langsmithTraceStatus: 'trace_unavailable',
    langsmithTraceUnavailableReason: 'not_provided',
  };
  let safeResumptionHandle: string | null = null;
  let safeResumptionGeneration = 0;
  let providerReceiveSequence = 0;
  let providerRelaySequence = 0;
  let lastProviderEventType: string | null = null;
  let latestUsageMetadata: Record<string, unknown> | null = null;
  let latestUsageMetadataReceiveSequence: number | null = null;
  let lastWebSocketClose: {
    at: string;
    atMs: number;
    closeCode: number | null;
    closeReasonSafe: string | null;
    wasClean: boolean | null;
  } | null = null;
  let orderedRelayTaskSequence = 0;
  let orderedRelayDraining = false;
  const transcriptRelayCadenceMs = Math.max(
    0,
    options.transcriptRelayCadenceMs ?? DEFAULT_OUTPUT_TRANSCRIPT_RELAY_CADENCE_MS,
  );
  let outputTranscriptRelayTimer: ReturnType<typeof setTimeout> | null = null;
  let outputTranscriptSegmentOrdinal = 0;
  let anonymousResponseOrdinal = 0;
  let anonymousResponseCompleted = false;
  let lastOutputTranscriptRelayAtMs: number | null = null;
  let activeOutputTranscriptSegment: {
    responseId: string | null;
    responseKey: string;
    segmentKey: string;
    text: string;
    lastFragment: string | null;
  } | null = null;
  let pendingOutputTranscriptRelay: {
    event: Record<string, unknown>;
    receiveMetadata: GeminiProviderReceiveMetadata;
    segmentKey: string;
  } | null = null;
  const repeatedIntentResponseStates = new Map<string, {
    text: string;
    lastFragment: string | null;
    gated: boolean;
  }>();
  const repeatedIntentSuppressedResponseKeys = new Set<string>();
  const assembledOutputTranscriptRelayEvents = new WeakSet<Record<string, unknown>>();
  const orderedRelayQueue: GeminiOrderedRelayTask[] = [];
  const transcriptRelayLatencySamples: number[] = [];
  const relayThroughputMetrics: GeminiOrderedRelayThroughputMetrics = {
    orderedRelayQueueDepth: 0,
    oldestQueuedAgeMs: null,
    transcriptPartialsCoalesced: 0,
    transcriptPartialsSent: 0,
    transcriptPartialsDropped: 0,
    transcriptCoalescingDisabledReason: null,
    finalTranscriptEventsSent: 0,
    nonDroppableCriticalEventsSent: 0,
    lastTranscriptRelayLatencyMs: null,
    maxTranscriptRelayLatencyMs: null,
    p95TranscriptRelayLatencyMs: null,
    coalescedBySegment: {},
  };
  const providerCategoryCounts = createGeminiProviderEventCategoryCounts();
  const relayClassificationCounts = createGeminiRelayClassificationCounts();
  const toolCallLedger = new Map<string, GeminiBrowserLiveToolCallLedgerEntry>();
  const interruptedResponseIds = new Set<string>();
  let staleOutputSuppressionActive = false;
  let staleOutputSuppressionStartedAtMs: number | null = null;
  let staleOutputSuppressionArmedAt: string | null = null;
  let staleOutputSuppressionArmedBy: GeminiBargeInConfirmationSource | null = null;
  let bargeInConfirmationReason: string | null = null;
  let staleOutputFenceGeneration = 0;
  let activeBargeInFenceGeneration: number | null = null;
  let promotedBargeInTranscriptFenceGeneration: number | null = null;
  let rawAssistantUserOverlapStartedAtMs: number | null = null;
  let rawAssistantUserOverlapMs = 0;
  let confirmedAssistantUserOverlapStartedAtMs: number | null = null;
  let confirmedAssistantUserOverlapMs = 0;
  let assistantOutputStartedAtMs: number | null = null;
  let latestAssistantOutputTranscriptText: string | null = null;
  let bargeInCandidateStartedAtMs: number | null = null;
  let bargeInCandidateLastFrameAtMs: number | null = null;
  let bargeInCandidateFrameCount = 0;
  let confirmedBargeInCandidateFrameCount = 0;
  let inputFrameOnlyNotBargeInCount = 0;
  let candidateFramesDidNotConfirmCount = 0;
  let candidateExpiredCount = 0;
  let suppressionBlockedBecauseNoIntentCount = 0;
  let bargeInTranscriptCapturedCount = 0;
  let bargeInTranscriptPromotedCount = 0;
  let bargeInTranscriptPromotionLatencyMs: number | null = null;
  let bargeInTranscriptIgnoredCount = 0;
  let bargeInTranscriptDuplicateSuppressedCount = 0;
  let lastBargeInTranscriptPreview: string | null = null;
  let bargeInNewTurnDispatchCount = 0;
  let bargeInNewTurnDispatchBlockedReason: GeminiBargeInNewTurnDispatchBlockedReason = 'none';
  const promotedBargeInTranscriptFingerprints: string[] = [];
  let lastCoreviewToolResponseSentAtMs: number | null = null;
  let artifactReviewArtifactId: string | null = null;
  let artifactReviewExpiresAtMs: number | null = null;
  let artifactReviewUserIntent: GeminiArtifactReviewUserIntent = 'unknown';
  let artifactReviewBuilderUpdateIntentDetected = false;
  let artifactReviewUserIntentAt: string | null = null;
  const artifactReviewSafeResponseIds = new Set<string>();
  const artifactReviewSuppressedResponseIds = new Set<string>();
  const pendingArtifactReviewAudio = new Map<string, Array<{
    event: Record<string, unknown>;
    receiveMetadata: GeminiProviderReceiveMetadata;
  }>>();

  const relayQueueOldestQueuedAgeMs = () => {
    const oldestQueuedAtMs = orderedRelayQueue[0]?.queuedAtMs;
    return oldestQueuedAtMs === undefined ? null : elapsedMs(oldestQueuedAtMs);
  };

  const snapshotRelayThroughputMetrics = (): GeminiOrderedRelayThroughputMetrics => ({
    ...relayThroughputMetrics,
    orderedRelayQueueDepth: orderedRelayQueue.length,
    oldestQueuedAgeMs: relayQueueOldestQueuedAgeMs(),
    coalescedBySegment: { ...relayThroughputMetrics.coalescedBySegment },
  });

  const recordTranscriptRelayLatency = (latencyMs: number | null) => {
    if (latencyMs === null) {
      return;
    }
    relayThroughputMetrics.lastTranscriptRelayLatencyMs = latencyMs;
    relayThroughputMetrics.maxTranscriptRelayLatencyMs = Math.max(
      relayThroughputMetrics.maxTranscriptRelayLatencyMs ?? 0,
      latencyMs,
    );
    transcriptRelayLatencySamples.push(latencyMs);
    if (transcriptRelayLatencySamples.length > 100) {
      transcriptRelayLatencySamples.splice(0, transcriptRelayLatencySamples.length - 100);
    }
    relayThroughputMetrics.p95TranscriptRelayLatencyMs = percentile(transcriptRelayLatencySamples, 95);
  };

  const drainOrderedRelayQueue = () => {
    if (orderedRelayDraining) {
      return;
    }
    orderedRelayDraining = true;
    void (async () => {
      try {
        while (orderedRelayQueue.length > 0) {
          const task = orderedRelayQueue.shift();
          if (!task) {
            continue;
          }
          relayThroughputMetrics.orderedRelayQueueDepth = orderedRelayQueue.length + 1;
          relayThroughputMetrics.oldestQueuedAgeMs = elapsedMs(task.queuedAtMs);
          await task.run(relayThroughputMetrics.orderedRelayQueueDepth, relayThroughputMetrics.oldestQueuedAgeMs);
          relayThroughputMetrics.orderedRelayQueueDepth = orderedRelayQueue.length;
          relayThroughputMetrics.oldestQueuedAgeMs = relayQueueOldestQueuedAgeMs();
        }
      } finally {
        orderedRelayDraining = false;
        if (orderedRelayQueue.length > 0) {
          drainOrderedRelayQueue();
        }
      }
    })();
  };

  const dispatchRelay = (
    run: (queueDepth: number | null, oldestQueuedAgeMs: number | null) => Promise<void>,
    useOrderedLane: boolean,
    metadata?: {
      coalescingKey?: string | null;
      providerReceiveSequence?: number;
      relayCorrelationId?: string;
    },
  ) => {
    if (!useOrderedLane) {
      void run(null, null);
      return;
    }

    const task: GeminiOrderedRelayTask = {
      id: orderedRelayTaskSequence += 1,
      queuedAtMs: monotonicNowMs(),
      providerReceiveSequence: metadata?.providerReceiveSequence ?? 0,
      relayCorrelationId: metadata?.relayCorrelationId ?? '',
      coalescingKey: metadata?.coalescingKey ?? null,
      run,
    };

    if (task.coalescingKey) {
      const existingIndex = orderedRelayQueue.findIndex((candidate) => candidate.coalescingKey === task.coalescingKey);
      if (existingIndex >= 0) {
        const dropped = orderedRelayQueue[existingIndex];
        orderedRelayQueue[existingIndex] = { ...task, queuedAtMs: dropped.queuedAtMs };
        relayThroughputMetrics.transcriptPartialsCoalesced += 1;
        relayThroughputMetrics.transcriptPartialsDropped += 1;
        relayThroughputMetrics.coalescedBySegment[task.coalescingKey] = (
          relayThroughputMetrics.coalescedBySegment[task.coalescingKey] ?? 0
        ) + 1;
        relayThroughputMetrics.orderedRelayQueueDepth = orderedRelayQueue.length;
        relayThroughputMetrics.oldestQueuedAgeMs = relayQueueOldestQueuedAgeMs();
        options.onRelayCoalescingDiagnostic?.({
          timestamp: new Date().toISOString(),
          reason: 'superseded_pending_assistant_partial',
          segmentKey: task.coalescingKey,
          droppedProviderReceiveSequence: dropped.providerReceiveSequence,
          replacementProviderReceiveSequence: task.providerReceiveSequence,
          droppedRelayCorrelationId: dropped.relayCorrelationId,
          replacementRelayCorrelationId: task.relayCorrelationId,
          orderedRelayQueueDepth: orderedRelayQueue.length,
          oldestQueuedAgeMs: relayThroughputMetrics.oldestQueuedAgeMs,
          metrics: snapshotRelayThroughputMetrics(),
        });
        drainOrderedRelayQueue();
        return;
      }
    }

    orderedRelayQueue.push(task);
    relayThroughputMetrics.orderedRelayQueueDepth = orderedRelayQueue.length;
    relayThroughputMetrics.oldestQueuedAgeMs = relayQueueOldestQueuedAgeMs();
    drainOrderedRelayQueue();
  };

  const notifyToolCallLedgerUpdate = (entry: GeminiBrowserLiveToolCallLedgerEntry) => {
    const enriched = syntheticInteractionEvidence?.noteToolLedger(entry) ?? entry;
    options.onToolCallLedgerUpdate?.({ ...enriched });
  };

  const notifyProviderConnectionEpoch = (
    phase: GeminiProviderConnectionEpochReceiptPhase,
    previousProviderConnectionEpoch: number | null,
    reason: string,
  ) => {
    options.onProviderConnectionEpoch?.({
      timestamp: new Date().toISOString(),
      phase,
      previousProviderConnectionEpoch,
      providerConnectionEpoch,
      continuityState,
      reason,
      ...langsmithTraceContext,
    });
  };

  const snapshotArtifactFrameProviderState = () => ({
    providerEventCount: providerReceiveSequence,
    lastProviderEventType,
    usageMetadata: latestUsageMetadata ? { ...latestUsageMetadata } : null,
    usageMetadataReceiveSequence: latestUsageMetadataReceiveSequence,
    imageCount: readGeminiUsageMetadataImageCount(latestUsageMetadata),
  });

  const snapshotArtifactFrameTransportStatus = (): GeminiArtifactFrameTransportStatusSnapshot => {
    const websocketReadyState = typeof websocket?.readyState === 'number' ? websocket.readyState : null;
    const websocketOpen = websocketReadyState === WEBSOCKET_OPEN;
    return {
      websocketReadyState,
      websocketState: websocketReadyStateLabel(websocketReadyState),
      websocketOpen,
      websocketCloseCode: lastWebSocketClose?.closeCode ?? null,
      websocketCloseReasonSafe: lastWebSocketClose?.closeReasonSafe ?? null,
      websocketCloseWasClean: lastWebSocketClose?.wasClean ?? null,
      websocketCloseAt: lastWebSocketClose?.at ?? null,
      error: websocketOpen ? null : 'gemini_live_websocket_not_open',
    };
  };

  const rememberArtifactReviewUserIntent = (text: string | null | undefined) => {
    if (!text) {
      return;
    }
    const nextIntent = classifyArtifactReviewUserIntent(text);
    if (nextIntent === 'unknown') {
      return;
    }
    artifactReviewUserIntent = nextIntent;
    artifactReviewBuilderUpdateIntentDetected = isArtifactReviewSelectedArtifactUpdateIntent(text);
    artifactReviewUserIntentAt = new Date().toISOString();
  };

  const dropPendingArtifactReviewAudio = (
    responseId: string | null,
    reason: GeminiOutputAudioDropReason,
  ) => {
    const responseIds = responseId ? [responseId] : Array.from(pendingArtifactReviewAudio.keys());
    responseIds.forEach((pendingResponseId) => {
      pendingArtifactReviewAudio.get(pendingResponseId)?.forEach(({ event, receiveMetadata }) => {
        outputAudioPlayer?.dropEvent(event, receiveMetadata, reason);
      });
      pendingArtifactReviewAudio.delete(pendingResponseId);
    });
  };

  const snapshotArtifactReviewRelayContext = (): GeminiArtifactReviewRelayContext | null => {
    if (!artifactReviewArtifactId || artifactReviewExpiresAtMs === null) {
      return null;
    }
    if (monotonicNowMs() > artifactReviewExpiresAtMs) {
      artifactReviewArtifactId = null;
      artifactReviewExpiresAtMs = null;
      artifactReviewUserIntent = 'unknown';
      artifactReviewBuilderUpdateIntentDetected = false;
      artifactReviewUserIntentAt = null;
      artifactReviewSafeResponseIds.clear();
      artifactReviewSuppressedResponseIds.clear();
      dropPendingArtifactReviewAudio(null, 'artifact_review_response_suppressed');
      return null;
    }

    return {
      active: true,
      artifact_id: artifactReviewArtifactId,
      source: 'coreview_still_frame',
      user_intent: artifactReviewUserIntent,
      builder_update_intent_detected: artifactReviewBuilderUpdateIntentDetected,
      selected_artifact_update_context: true,
      last_user_intent_at: artifactReviewUserIntentAt,
      expires_at: new Date(Date.now() + Math.max(0, artifactReviewExpiresAtMs - monotonicNowMs())).toISOString(),
      raw_transcript_excluded: true,
      raw_artifact_text_excluded: true,
      raw_comment_text_excluded: true,
    };
  };

  const prunePendingArtifactReviewAudio = () => {
    while (pendingArtifactReviewAudio.size > 25) {
      const oldest = pendingArtifactReviewAudio.keys().next().value;
      if (typeof oldest !== 'string') {
        return;
      }
      dropPendingArtifactReviewAudio(oldest, 'artifact_review_response_suppressed');
    }
  };

  const playGeminiOutputAudio = (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata,
  ) => {
    const audioChunks = readGeminiOutputAudioChunks(event);
    if (!audioChunks.length) {
      return 0;
    }
    options.onOutputAudio?.();
    return outputAudioPlayer?.playEvent(event, receiveMetadata) ?? 0;
  };

  const dropBufferedArtifactReviewAudio = (
    responseId: string | null,
    reason: GeminiOutputAudioDropReason = 'artifact_review_response_suppressed',
  ) => {
    if (!responseId) {
      return;
    }
    dropPendingArtifactReviewAudio(responseId, reason);
    artifactReviewSafeResponseIds.delete(responseId);
  };

  const bufferArtifactReviewAudio = (
    responseId: string,
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata,
  ) => {
    const queued = pendingArtifactReviewAudio.get(responseId) ?? [];
    queued.push({ event, receiveMetadata });
    pendingArtifactReviewAudio.set(responseId, queued);
    prunePendingArtifactReviewAudio();
  };

  const markArtifactReviewResponseSafe = (responseId: string | null) => {
    if (!responseId) {
      return;
    }
    artifactReviewSafeResponseIds.add(responseId);
    pruneStringSet(artifactReviewSafeResponseIds, 50);
    const queued = pendingArtifactReviewAudio.get(responseId);
    if (!queued) {
      return;
    }
    pendingArtifactReviewAudio.delete(responseId);
    if (artifactReviewSuppressedResponseIds.has(responseId)) {
      queued.forEach(({ event, receiveMetadata }) => {
        outputAudioPlayer?.dropEvent(event, receiveMetadata, 'artifact_review_response_suppressed');
      });
      return;
    }
    queued.forEach(({ event, receiveMetadata }) => {
      playGeminiOutputAudio(event, receiveMetadata);
    });
  };

  const recordWebSocketDiagnostic = (
    diagnostic: Omit<GeminiBrowserLiveDogfoodWebSocketDiagnostic, 'relayFailureAlreadyObserved'>,
  ) => {
    if (diagnostic.kind === 'close') {
      lastWebSocketClose = {
        at: diagnostic.timestamp,
        atMs: monotonicNowMs(),
        closeCode: diagnostic.closeCode,
        closeReasonSafe: sanitizeDiagnosticText(diagnostic.closeReason),
        wasClean: diagnostic.wasClean,
      };
    }
    options.onWebSocketDiagnostic?.({
      ...diagnostic,
      closeReason: sanitizeDiagnosticText(diagnostic.closeReason),
      relayFailureAlreadyObserved: relayFailureObserved,
    });
  };

  const noteProviderSocketClosed = (socket: WebSocketLike, event: CloseEvent) => {
    const epoch = providerSocketEpochs.get(socket);
    if (!epoch) return;
    const observedAt = new Date().toISOString();
    observedProviderSocketCloses.set(socket, { epoch, event, observedAt });
    const pending = pendingProviderSocketCloses.get(socket);
    if (pending?.epoch === epoch) {
      clearTimeout(pending.timer);
      pendingProviderSocketCloses.delete(socket);
      pending.resolve({ event, observedAt });
    }
  };

  const waitForProviderSocketClose = (
    socket: WebSocketLike,
    epoch: number,
    timeoutMs = 5_000,
  ): Promise<{ event: CloseEvent; observedAt: string } | null> => {
    const observed = observedProviderSocketCloses.get(socket);
    if (observed?.epoch === epoch) {
      return Promise.resolve({ event: observed.event, observedAt: observed.observedAt });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingProviderSocketCloses.get(socket)?.epoch === epoch) {
          pendingProviderSocketCloses.delete(socket);
        }
        resolve(null);
      }, timeoutMs);
      pendingProviderSocketCloses.set(socket, {
        socket,
        epoch,
        resolve,
        timer,
      });
    });
  };

  const providerCloseReceipt = (
    socket: WebSocketLike,
    epoch: number,
    observed: { event: CloseEvent; observedAt: string },
  ): Record<string, unknown> => {
    const existing = providerCloseReceiptsByEpoch.get(epoch);
    if (existing) return existing;
    if (providerSocketEpochs.get(socket) !== epoch) {
      throw new Error('Synthetic provider close receipt epoch binding is invalid.');
    }
    const receiptId = globalThis.crypto?.randomUUID?.();
    if (!receiptId) {
      throw new Error('Synthetic provider close receipt identity is unavailable.');
    }
    const receipt = {
      schema: 'sophia_gemini_browser_provider_close_v1',
      receipt_id: receiptId,
      session_id: dogfoodSessionId,
      provider_connection_epoch: epoch,
      websocket_close_observed: true,
      websocket_close_code: observed.event.code,
      websocket_closed_at: observed.observedAt,
    };
    providerCloseReceiptsByEpoch.set(epoch, receipt);
    return receipt;
  };

  const defaultPlaybackState = (): GeminiOutputAudioPlaybackState => ({
    nextPlaybackTime: 0,
    activeSourceCount: 0,
    playbackGeneration: outputAudioPlayer?.snapshot().playbackGeneration ?? 0,
    queuedChunkCount: 0,
    playbackAheadSeconds: 0,
  });

  const hasPendingAssistantAudioPlayback = () => {
    const playbackState = outputAudioPlayer?.snapshot();
    if (!playbackState) {
      return false;
    }
    const currentTime = audioContext && Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0;
    return playbackState.activeSourceCount > 0
      || playbackState.queuedChunkCount > 0
      || playbackState.nextPlaybackTime > currentTime;
  };

  const closeRawAssistantUserOverlap = (endedAtMs = monotonicNowMs()) => {
    if (rawAssistantUserOverlapStartedAtMs === null) {
      return;
    }
    rawAssistantUserOverlapMs += Math.max(0, endedAtMs - rawAssistantUserOverlapStartedAtMs);
    rawAssistantUserOverlapStartedAtMs = null;
  };

  const closeConfirmedAssistantUserOverlap = (endedAtMs = monotonicNowMs()) => {
    if (confirmedAssistantUserOverlapStartedAtMs === null) {
      return;
    }
    confirmedAssistantUserOverlapMs += Math.max(0, endedAtMs - confirmedAssistantUserOverlapStartedAtMs);
    confirmedAssistantUserOverlapStartedAtMs = null;
  };

  const rawAssistantUserOverlapTotalMs = (nowMs = monotonicNowMs()) => rawAssistantUserOverlapMs
    + (rawAssistantUserOverlapStartedAtMs === null ? 0 : Math.max(0, nowMs - rawAssistantUserOverlapStartedAtMs));

  const confirmedAssistantUserOverlapTotalMs = (nowMs = monotonicNowMs()) => confirmedAssistantUserOverlapMs
    + (confirmedAssistantUserOverlapStartedAtMs === null ? 0 : Math.max(0, nowMs - confirmedAssistantUserOverlapStartedAtMs));

  const resetBargeInCandidate = () => {
    bargeInCandidateStartedAtMs = null;
    bargeInCandidateLastFrameAtMs = null;
    bargeInCandidateFrameCount = 0;
  };

  const decayBargeInCandidateIfStale = (nowMs: number) => {
    if (
      staleOutputSuppressionActive
      || bargeInCandidateLastFrameAtMs === null
      || nowMs - bargeInCandidateLastFrameAtMs <= BARGE_IN_CANDIDATE_DECAY_MS
    ) {
      return false;
    }
    if (bargeInCandidateFrameCount > 0) {
      candidateExpiredCount += 1;
    }
    closeRawAssistantUserOverlap(bargeInCandidateLastFrameAtMs);
    resetBargeInCandidate();
    return true;
  };

  const userInputActiveAgeMs = (nowMs = monotonicNowMs()) => {
    decayBargeInCandidateIfStale(nowMs);
    if (confirmedAssistantUserOverlapStartedAtMs !== null) {
      return Math.max(0, Math.round(nowMs - confirmedAssistantUserOverlapStartedAtMs));
    }
    if (bargeInCandidateStartedAtMs !== null) {
      return Math.max(0, Math.round(nowMs - bargeInCandidateStartedAtMs));
    }
    return null;
  };

  const currentBargeInConfirmationSource = (): GeminiBargeInConfirmationSource => (
    staleOutputSuppressionActive ? staleOutputSuppressionArmedBy ?? 'none' : 'none'
  );

  const currentBargeInConfirmationReason = () => (
    staleOutputSuppressionActive ? bargeInConfirmationReason : null
  );

  const markStaleOutputFence = (
    timestampIso: string,
    armedBy: GeminiBargeInConfirmationSource,
    reason: string,
    overlapStartedAtMs: number | null,
  ) => {
    if (staleOutputSuppressionActive) {
      return false;
    }
    staleOutputSuppressionActive = true;
    const parsedTimestampMs = Date.parse(timestampIso);
    staleOutputSuppressionStartedAtMs = Number.isFinite(parsedTimestampMs) ? parsedTimestampMs : null;
    staleOutputSuppressionArmedAt = timestampIso;
    staleOutputSuppressionArmedBy = armedBy;
    bargeInConfirmationReason = reason;
    staleOutputFenceGeneration += 1;
    activeBargeInFenceGeneration = staleOutputFenceGeneration;
    promotedBargeInTranscriptFenceGeneration = null;
    confirmedAssistantUserOverlapStartedAtMs = overlapStartedAtMs;
    return true;
  };

  const confirmBargeIn = (
    armedBy: GeminiBargeInConfirmationSource,
    timestampIso: string,
    options: { stopPlayback?: boolean; reason?: string } = {},
  ) => {
    const playbackActive = hasPendingAssistantAudioPlayback();
    const overlapStartedAtMs = playbackActive
      ? bargeInCandidateStartedAtMs ?? rawAssistantUserOverlapStartedAtMs ?? monotonicNowMs()
      : null;
    const armed = markStaleOutputFence(
      timestampIso,
      armedBy,
      options.reason ?? 'confirmed_user_intent',
      overlapStartedAtMs,
    );
    if (armed) {
      confirmedBargeInCandidateFrameCount = bargeInCandidateFrameCount;
    }
    if (options.stopPlayback) {
      outputAudioPlayer?.stop(options.reason ?? 'confirmed_user_intent');
      closeRawAssistantUserOverlap();
    }
    resetBargeInCandidate();
    return armed;
  };

  const clearStaleOutputFence = () => {
    staleOutputSuppressionActive = false;
    staleOutputSuppressionStartedAtMs = null;
    staleOutputSuppressionArmedAt = null;
    staleOutputSuppressionArmedBy = null;
    bargeInConfirmationReason = null;
    activeBargeInFenceGeneration = null;
    promotedBargeInTranscriptFenceGeneration = null;
    closeConfirmedAssistantUserOverlap();
    resetBargeInCandidate();
    confirmedBargeInCandidateFrameCount = 0;
  };

  const clearAssistantOutputState = () => {
    assistantOutputStartedAtMs = null;
    latestAssistantOutputTranscriptText = null;
    closeRawAssistantUserOverlap();
  };

  const markAssistantOutputStarted = (
    event: Record<string, unknown>,
    categories: GeminiProviderEventCategory[],
    receiveMetadata?: GeminiProviderReceiveMetadata,
  ) => {
    if (!isAssistantOutputCategories(categories)) {
      return;
    }
    const timestampIso = receiveMetadata?.providerReceivedAt ?? new Date().toISOString();
    const parsedTimestampMs = Date.parse(timestampIso);
    if (assistantOutputStartedAtMs === null) {
      assistantOutputStartedAtMs = Number.isFinite(parsedTimestampMs) ? parsedTimestampMs : Date.now();
    }
    const outputText = readTranscriptionText(event, 'outputTranscription', 'output_transcription');
    if (outputText) {
      latestAssistantOutputTranscriptText = outputText;
    }
  };

  const providerInputTranscriptionConfirmation = (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata,
  ): { confirmed: boolean; reason: string } => {
    const text = readTranscriptionText(event, 'inputTranscription', 'input_transcription');
    if (!text) {
      return { confirmed: false, reason: 'empty_provider_input_transcription' };
    }
    const coreviewFollowUp = coreviewFollowUpTranscriptionConfirmation(text, receiveMetadata);
    if (coreviewFollowUp.confirmed) {
      return coreviewFollowUp;
    }
    if (assistantOutputStartedAtMs === null) {
      return { confirmed: false, reason: 'provider_input_transcription_before_assistant_output' };
    }
    const providerReceivedAtMs = Date.parse(receiveMetadata.providerReceivedAt);
    if (!Number.isFinite(providerReceivedAtMs)) {
      return { confirmed: false, reason: 'provider_input_transcription_missing_timestamp' };
    }
    if (providerReceivedAtMs < assistantOutputStartedAtMs + PROVIDER_INPUT_TRANSCRIPTION_CONFIRMATION_DELAY_MS) {
      return { confirmed: false, reason: 'provider_input_transcription_too_close_to_assistant_start' };
    }
    if (!isConfirmableProviderInputTranscription(text)) {
      return { confirmed: false, reason: 'provider_input_transcription_trivial_or_noise' };
    }
    if (isLikelyAssistantEcho(text, latestAssistantOutputTranscriptText)) {
      return { confirmed: false, reason: 'provider_input_transcription_likely_echo' };
    }
    return { confirmed: true, reason: 'provider_input_transcription_after_assistant_output_with_text' };
  };

  function coreviewFollowUpTranscriptionConfirmation(
    text: string,
    receiveMetadata: GeminiProviderReceiveMetadata,
  ): { confirmed: boolean; reason: string } {
    if (lastCoreviewToolResponseSentAtMs === null) {
      return { confirmed: false, reason: 'no_recent_coreview_tool_response' };
    }
    const providerReceivedAtMs = Date.parse(receiveMetadata.providerReceivedAt);
    if (!Number.isFinite(providerReceivedAtMs)) {
      return { confirmed: false, reason: 'provider_input_transcription_missing_timestamp' };
    }
    const ageMs = providerReceivedAtMs - lastCoreviewToolResponseSentAtMs;
    if (ageMs < 0 || ageMs > COREVIEW_FOLLOW_UP_TRANSCRIPT_WINDOW_MS) {
      return { confirmed: false, reason: 'provider_input_transcription_outside_coreview_follow_up_window' };
    }
    if (!isConfirmableProviderInputTranscription(text)) {
      return { confirmed: false, reason: 'provider_input_transcription_trivial_or_noise' };
    }
    if (isLikelyAssistantEcho(text, latestAssistantOutputTranscriptText)) {
      return { confirmed: false, reason: 'provider_input_transcription_likely_echo' };
    }
    return { confirmed: true, reason: 'provider_input_transcription_after_coreview_tool' };
  }

  const rememberPromotedBargeInTranscriptFingerprint = (fingerprint: string) => {
    promotedBargeInTranscriptFingerprints.push(fingerprint);
    if (promotedBargeInTranscriptFingerprints.length > 20) {
      promotedBargeInTranscriptFingerprints.splice(0, promotedBargeInTranscriptFingerprints.length - 20);
    }
  };

  const emitBargeInTranscriptHandoff = (
    diagnostic: Omit<GeminiBargeInTranscriptHandoffDiagnostic,
      | 'bargeInTranscriptCapturedCount'
      | 'bargeInTranscriptPromotedCount'
      | 'bargeInTranscriptPromotionLatencyMs'
      | 'bargeInTranscriptIgnoredCount'
      | 'bargeInTranscriptDuplicateSuppressedCount'
      | 'lastBargeInTranscriptPreview'
      | 'bargeInNewTurnDispatchCount'
      | 'bargeInNewTurnDispatchBlockedReason'
    >,
  ) => {
    options.onBargeInTranscriptHandoff?.({
      ...diagnostic,
      bargeInTranscriptCapturedCount,
      bargeInTranscriptPromotedCount,
      bargeInTranscriptPromotionLatencyMs,
      bargeInTranscriptIgnoredCount,
      bargeInTranscriptDuplicateSuppressedCount,
      lastBargeInTranscriptPreview,
      bargeInNewTurnDispatchCount,
      bargeInNewTurnDispatchBlockedReason,
    });
  };

  const promoteBargeInInputTranscription = (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata,
    confirmation: { confirmed: boolean; reason: string },
  ) => {
    const text = readTranscriptionText(event, 'inputTranscription', 'input_transcription');
    const timestamp = new Date().toISOString();
    const transcriptPreview = readTranscriptionTextPreview(event, 'inputTranscription', 'input_transcription');
    const isConfirmedBargeIn = staleOutputSuppressionActive || confirmation.confirmed;
    const inPossibleBargeInWindow = isConfirmedBargeIn || assistantOutputStartedAtMs !== null || bargeInCandidateFrameCount > 0;
    if (!text && !inPossibleBargeInWindow) {
      return;
    }

    if (!text) {
      bargeInTranscriptIgnoredCount += 1;
      bargeInNewTurnDispatchBlockedReason = 'empty_transcript';
      emitBargeInTranscriptHandoff({
        timestamp,
        providerReceiveSequence: receiveMetadata.providerReceiveSequence,
        providerReceivedAt: receiveMetadata.providerReceivedAt,
        relayCorrelationId: receiveMetadata.relayCorrelationId,
        text: null,
        transcriptPreview: null,
        transcriptLength: 0,
        captured: false,
        promoted: false,
        ignored: true,
        duplicateSuppressed: false,
        promotionLatencyMs: null,
        newTurnDispatched: false,
        newTurnDispatchBlockedReason: 'empty_transcript',
        bargeInConfirmationSource: currentBargeInConfirmationSource(),
        bargeInConfirmationReason: currentBargeInConfirmationReason() ?? confirmation.reason,
      });
      return;
    }

    if (!isConfirmedBargeIn) {
      if (inPossibleBargeInWindow) {
        bargeInTranscriptIgnoredCount += 1;
        bargeInNewTurnDispatchBlockedReason = 'not_confirmed_barge_in';
        emitBargeInTranscriptHandoff({
          timestamp,
          providerReceiveSequence: receiveMetadata.providerReceiveSequence,
          providerReceivedAt: receiveMetadata.providerReceivedAt,
          relayCorrelationId: receiveMetadata.relayCorrelationId,
          text,
          transcriptPreview,
          transcriptLength: text.length,
          captured: false,
          promoted: false,
          ignored: true,
          duplicateSuppressed: false,
          promotionLatencyMs: null,
          newTurnDispatched: false,
          newTurnDispatchBlockedReason: 'not_confirmed_barge_in',
          bargeInConfirmationSource: currentBargeInConfirmationSource(),
          bargeInConfirmationReason: confirmation.reason,
        });
      }
      return;
    }

    if (!staleOutputSuppressionActive && confirmation.confirmed) {
      const confirmationSource: GeminiBargeInConfirmationSource = confirmation.reason === 'provider_input_transcription_after_coreview_tool'
        ? 'coreview_tool_follow_up'
        : 'provider_input_transcription';
      confirmBargeIn(confirmationSource, receiveMetadata.providerReceivedAt, {
        stopPlayback: false,
        reason: confirmation.reason,
      });
    }

    bargeInTranscriptCapturedCount += 1;
    lastBargeInTranscriptPreview = transcriptPreview;
    const fingerprint = normalizeTranscriptionForIntent(text);
    const duplicateSuppressed = fingerprint.length > 0 && promotedBargeInTranscriptFingerprints.includes(fingerprint);
    const alreadyPromotedForFence = activeBargeInFenceGeneration !== null
      && promotedBargeInTranscriptFenceGeneration === activeBargeInFenceGeneration;
    if (duplicateSuppressed || alreadyPromotedForFence) {
      bargeInTranscriptDuplicateSuppressedCount += 1;
      const blockedReason = duplicateSuppressed ? 'duplicate_transcript' : 'already_promoted_for_barge_in';
      bargeInNewTurnDispatchBlockedReason = blockedReason;
      emitBargeInTranscriptHandoff({
        timestamp,
        providerReceiveSequence: receiveMetadata.providerReceiveSequence,
        providerReceivedAt: receiveMetadata.providerReceivedAt,
        relayCorrelationId: receiveMetadata.relayCorrelationId,
        text,
        transcriptPreview,
        transcriptLength: text.length,
        captured: true,
        promoted: false,
        ignored: false,
        duplicateSuppressed: true,
        promotionLatencyMs: null,
        newTurnDispatched: false,
        newTurnDispatchBlockedReason: blockedReason,
        bargeInConfirmationSource: currentBargeInConfirmationSource(),
        bargeInConfirmationReason: currentBargeInConfirmationReason() ?? confirmation.reason,
      });
      return;
    }

    const promotionLatencyMs = latencyMsFromIso(receiveMetadata.providerReceivedAt, timestamp);
    bargeInTranscriptPromotedCount += 1;
    bargeInTranscriptPromotionLatencyMs = promotionLatencyMs;
    if (fingerprint) {
      rememberPromotedBargeInTranscriptFingerprint(fingerprint);
    }
    promotedBargeInTranscriptFenceGeneration = activeBargeInFenceGeneration;

    let dispatched = false;
    let blockedReason: GeminiBargeInNewTurnDispatchBlockedReason = 'none';
    if (websocket?.readyState !== WEBSOCKET_OPEN) {
      blockedReason = 'websocket_not_open';
    } else {
      try {
        websocket.send(JSON.stringify({ realtimeInput: { text } }));
        dispatched = true;
        bargeInNewTurnDispatchCount += 1;
      } catch {
        blockedReason = 'websocket_send_failed';
      }
    }
    bargeInNewTurnDispatchBlockedReason = blockedReason;

    emitBargeInTranscriptHandoff({
      timestamp,
      providerReceiveSequence: receiveMetadata.providerReceiveSequence,
      providerReceivedAt: receiveMetadata.providerReceivedAt,
      relayCorrelationId: receiveMetadata.relayCorrelationId,
      text,
      transcriptPreview,
      transcriptLength: text.length,
      captured: true,
      promoted: true,
      ignored: false,
      duplicateSuppressed: false,
      promotionLatencyMs,
      newTurnDispatched: dispatched,
      newTurnDispatchBlockedReason: blockedReason,
      bargeInConfirmationSource: currentBargeInConfirmationSource(),
      bargeInConfirmationReason: currentBargeInConfirmationReason() ?? confirmation.reason,
    });
  };

  const emitStaleOutputSuppression = (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata | undefined,
    outputType: GeminiStaleOutputSuppressionType,
    reason: GeminiStaleOutputSuppressionReason,
    repeatedIntentGate?: GeminiStaleOutputSuppressionDiagnostic['repeatedIntentGate'],
  ) => {
    options.onStaleOutputSuppression?.({
      timestamp: new Date().toISOString(),
      outputType,
      reason,
      responseId: readGeminiResponseId(event),
      providerReceiveSequence: receiveMetadata?.providerReceiveSequence ?? null,
      providerReceivedAt: receiveMetadata?.providerReceivedAt ?? null,
      relayCorrelationId: receiveMetadata?.relayCorrelationId ?? null,
      playbackGeneration: outputAudioPlayer?.snapshot().playbackGeneration ?? null,
      interruptedResponseIds: Array.from(interruptedResponseIds).slice(-12),
      userInputActiveAgeMs: userInputActiveAgeMs(),
      bargeInConfirmed: staleOutputSuppressionActive,
      bargeInConfirmationSource: currentBargeInConfirmationSource(),
      bargeInConfirmationReason: currentBargeInConfirmationReason(),
      bargeInCandidateFrameCount: Math.max(bargeInCandidateFrameCount, confirmedBargeInCandidateFrameCount),
      suppressionDeferredReason: null,
      staleSuppressionArmedAt: staleOutputSuppressionArmedAt,
      staleSuppressionArmedBy: staleOutputSuppressionArmedBy,
      assistantAudioDropReason: outputType === 'audio' ? reason : null,
      inputFrameOnlyNotBargeInCount,
      candidateFramesDidNotConfirmCount,
      candidateExpiredCount,
      suppressionBlockedBecauseNoIntentCount,
      rawAssistantUserOverlapMs: Math.round(rawAssistantUserOverlapTotalMs()),
      confirmedAssistantUserOverlapMs: Math.round(confirmedAssistantUserOverlapTotalMs()),
      ...(repeatedIntentGate ? { repeatedIntentGate } : {}),
    });
  };

  const staleOutputSuppressionReason = (
    event: Record<string, unknown>,
    categories: GeminiProviderEventCategory[],
    receiveMetadata?: GeminiProviderReceiveMetadata,
  ): GeminiStaleOutputSuppressionReason | null => {
    if (!isAssistantOutputCategories(categories) || isGeminiServerInterruptedEvent(event)) {
      return null;
    }
    const responseId = readGeminiResponseId(event);
    if (responseId && interruptedResponseIds.has(responseId)) {
      return 'interrupted_response_id';
    }
    if (!staleOutputSuppressionActive) {
      if (bargeInCandidateFrameCount > 0 || rawAssistantUserOverlapStartedAtMs !== null) {
        suppressionBlockedBecauseNoIntentCount += 1;
      }
      return null;
    }
    const parsedProviderReceivedAtMs = receiveMetadata?.providerReceivedAt ? Date.parse(receiveMetadata.providerReceivedAt) : Number.NaN;
    const providerReceivedAtMs = Number.isFinite(parsedProviderReceivedAtMs) ? parsedProviderReceivedAtMs : null;
    if (
      providerReceivedAtMs !== null
      && staleOutputSuppressionStartedAtMs !== null
      && providerReceivedAtMs <= staleOutputSuppressionStartedAtMs
    ) {
      if (staleOutputSuppressionArmedBy === 'provider_input_transcription') {
        return null;
      }
      return 'pre_barge_in_relay_backlog';
    }
    return 'barge_in_generation_active';
  };

  const handleInputAudioActivity = (diagnostic: GeminiInputAudioActivityDiagnostic) => {
    const nowMs = monotonicNowMs();
    const assistantAudioActive = hasPendingAssistantAudioPlayback();
    const bargeInConfirmed = staleOutputSuppressionActive;
    let suppressionDeferredReason: GeminiSuppressionDeferredReason | null = null;

    if (diagnostic.eventType === 'input_audio_frame_sent') {
      decayBargeInCandidateIfStale(nowMs);
      if (assistantAudioActive && !staleOutputSuppressionActive) {
        if (bargeInCandidateStartedAtMs === null) {
          bargeInCandidateStartedAtMs = nowMs;
        }
        if (rawAssistantUserOverlapStartedAtMs === null) {
          rawAssistantUserOverlapStartedAtMs = nowMs;
        }
        bargeInCandidateLastFrameAtMs = nowMs;
        const framesRepresented = Math.max(1, diagnostic.framesRepresented ?? 1);
        bargeInCandidateFrameCount += framesRepresented;
        inputFrameOnlyNotBargeInCount += framesRepresented;
        candidateFramesDidNotConfirmCount += framesRepresented;
        suppressionDeferredReason = bargeInCandidateFrameCount <= framesRepresented
          ? 'input_frame_only_not_barge_in'
          : 'barge_in_confirmation_pending';
      } else if (!assistantAudioActive && !staleOutputSuppressionActive) {
        closeRawAssistantUserOverlap(nowMs);
        resetBargeInCandidate();
      }
    }
    options.onInputAudioActivity?.({
      ...diagnostic,
      assistantAudioActive,
      userInputActiveAgeMs: userInputActiveAgeMs(nowMs),
      bargeInConfirmed,
      bargeInConfirmationSource: currentBargeInConfirmationSource(),
      bargeInConfirmationReason: currentBargeInConfirmationReason(),
      bargeInCandidateFrameCount: Math.max(bargeInCandidateFrameCount, confirmedBargeInCandidateFrameCount),
      suppressionDeferredReason,
      staleSuppressionArmedAt: staleOutputSuppressionArmedAt,
      assistantAudioDropReason: null,
      inputFrameOnlyNotBargeInCount,
      candidateFramesDidNotConfirmCount,
      candidateExpiredCount,
      suppressionBlockedBecauseNoIntentCount,
      rawAssistantUserOverlapMs: Math.round(rawAssistantUserOverlapTotalMs(nowMs)),
      confirmedAssistantUserOverlapMs: Math.round(confirmedAssistantUserOverlapTotalMs(nowMs)),
    });
  };

  const updateToolCallLedger = (
    toolCallId: string | null,
    update: Partial<Omit<GeminiBrowserLiveToolCallLedgerEntry, 'toolCallId' | 'effectId' | 'providerConnectionEpoch'>>,
  ) => {
    if (!toolCallId) {
      return null;
    }
    const current = toolCallLedger.get(toolCallId)
      ?? createToolCallLedgerEntry(toolCallId, providerConnectionEpoch);
    if (isTerminalToolCallLedgerState(current.finalState)) {
      return current;
    }
    const next = finalizeToolCallLedgerEntry({ ...current, ...update });
    toolCallLedger.set(toolCallId, next);
    notifyToolCallLedgerUpdate(next);
    return next;
  };

  const buildSyntheticToolEvidence = (
    toolCall: GeminiBrowserLiveDogfoodToolCallSummary,
    receiveMetadata: GeminiProviderReceiveMetadata,
    receivedAt: string,
  ): GeminiSyntheticToolEvidence | null => {
    if (!toolCall.id || !toolCall.name) return null;
    const binding = syntheticInputEvidence?.latestAcceptedBinding() ?? null;
    const current = toolCallLedger.get(toolCall.id);
    if (
      syntheticTestContext === null
      || !binding
      || !current
      || binding.test_run_id !== syntheticTestContext.test_run_id
      || binding.provider_input_sequence === null
      || !syntheticTestContext.scenario_id
      || !syntheticTestContext.scenario_version
    ) {
      return null;
    }
    return {
      schema: 'sophia_synthetic_tool_evidence_v1',
      test_run_id: syntheticTestContext.test_run_id,
      scenario_id: syntheticTestContext.scenario_id,
      scenario_version: syntheticTestContext.scenario_version,
      operation_id: binding.operation_id,
      utterance_id: binding.utterance_id,
      provider_input_sequence: binding.provider_input_sequence,
      public_utterance_id: binding.public_utterance_id,
      tool_call_id: toolCall.id,
      effect_id: current.effectId,
      provider_connection_epoch: current.providerConnectionEpoch,
      relay_correlation_id: receiveMetadata.relayCorrelationId,
      tool_name: toolCall.name,
      received_at: current.receivedAt ?? receivedAt,
    };
  };

  const noteToolResponseSent = (functionResponse: Record<string, unknown>, timestamp: string) => {
    const toolName = stringFromAnyKey(functionResponse, 'name');
    if (!isCoreviewToolName(toolName) && !isCoreviewBuilderToolName(toolName)) {
      return;
    }
    const parsedTimestampMs = Date.parse(timestamp);
    lastCoreviewToolResponseSentAtMs = Number.isFinite(parsedTimestampMs) ? parsedTimestampMs : Date.now();
  };

  const performCleanup = async () => {
    notifyStage('closing');
    continuityState = 'ended';
    safeResumptionHandle = null;
    safeResumptionGeneration = 0;
    if (providerExpiryTimer !== null) {
      clearTimeout(providerExpiryTimer);
      providerExpiryTimer = null;
    }
    if (!cleanupTeardownComplete) {
      const teardownGeneration = providerCleanupGeneration;
      const requiredEpochs = syntheticTestContext !== null
        ? Array.from(new Set([
          ...(cleanupRequestedProviderEpochs ?? []),
          ...unsettledProviderEpochs,
        ])).sort((left, right) => left - right)
        : [];
      const socketByEpoch = new Map<number, WebSocketLike>();
      if (syntheticTestContext !== null) {
        if (requiredEpochs.length === 0) {
          throw new Error('Synthetic provider cleanup epochs are unavailable.');
        }
        for (const epoch of requiredEpochs) {
          const socket = Array.from(providerSockets).find(
            (candidate) => providerSocketEpochs.get(candidate) === epoch,
          );
          if (socket) socketByEpoch.set(epoch, socket);
        }
        // Provider spend is the first teardown priority. Issue every socket
        // close synchronously before recorder/audio/media cleanup can await or
        // stall; exact close receipts are collected after local media stops.
        for (const socket of socketByEpoch.values()) {
          if (socket.readyState < 2) {
            socket.close(1000, 'Gemini browser dogfood session closed.');
          }
        }
      } else {
        const activeProvider = websocketRef.current ?? websocket;
        if (activeProvider && activeProvider.readyState < 2) {
          activeProvider.close(1000, 'Gemini browser dogfood session closed.');
        }
      }
      if (outputTranscriptRelayTimer !== null) {
        clearTimeout(outputTranscriptRelayTimer);
        outputTranscriptRelayTimer = null;
      }
      pendingOutputTranscriptRelay = null;
      dropPendingArtifactReviewAudio(null, 'artifact_review_response_suppressed');
      outputAudioPlayer?.stop('session_close');
      outputAudioPlayer = null;
      cleanupConversationAudio ??= await conversationAudioRecorder?.stop().catch(() => null) ?? null;
      conversationAudioRecorder = null;
      outputLegMonitor?.stop();
      outputLegMonitor = null;
      syntheticInputEvidence?.stop();
      syntheticInputEvidence = null;
      syntheticInteractionEvidence?.stop();
      syntheticInteractionEvidence = null;
      await audioPipeline?.stop().catch(() => undefined);
      if (!audioPipeline && audioContext) {
        await audioContext.close().catch(() => undefined);
      }
      localStream?.getTracks().forEach((track) => track.stop());
      if (syntheticTestContext !== null) {
        const closeReceipts: Record<string, unknown>[] = [];
        const abortReceipts: Record<string, unknown>[] = [];
        for (const epoch of requiredEpochs) {
          const socket = socketByEpoch.get(epoch);
          if (socket) {
            const observed = await waitForProviderSocketClose(socket, epoch);
            if (observed === null) {
              throw new Error(
                `Synthetic provider socket epoch ${epoch} close was not observed; cleanup remains pending.`,
              );
            }
            closeReceipts.push(providerCloseReceipt(socket, epoch, observed));
            continue;
          }
          if (!knownProviderCandidateEpochs.has(epoch)) {
            throw new Error(
              `Synthetic provider candidate epoch ${epoch} ownership is unavailable; cleanup remains pending.`,
            );
          }
          let abortReceipt = activationAbortReceiptsByEpoch.get(epoch);
          if (!abortReceipt) {
            const receiptId = globalThis.crypto?.randomUUID?.();
            if (!receiptId) {
              throw new Error('Synthetic provider activation-abort identity is unavailable.');
            }
            abortReceipt = {
              schema: 'sophia_gemini_browser_provider_activation_abort_v1',
              receipt_id: receiptId,
              session_id: dogfoodSessionId,
              previous_activated_epoch: epoch - 1,
              candidate_epoch: epoch,
              websocket_created: false,
              aborted_at: new Date().toISOString(),
            };
            activationAbortReceiptsByEpoch.set(epoch, abortReceipt);
          }
          abortReceipts.push(abortReceipt);
        }
        cleanupBrowserCloseReceipts = closeReceipts;
        cleanupActivationAbortReceipts = abortReceipts;
      }
      if (teardownGeneration !== providerCleanupGeneration) {
        cleanupBrowserCloseReceipts = [];
        cleanupActivationAbortReceipts = [];
        cleanupSettlementAcknowledgement = null;
        cleanupTeardownComplete = false;
        await performCleanup();
        return;
      }
      cleanupTeardownComplete = true;
    }
    if (dogfoodSessionId && !cleanupDisconnectAcknowledged) {
      const disconnectBody: Record<string, unknown> = { session_id: dogfoodSessionId };
      if (syntheticTestContext !== null) {
        disconnectBody.browser_provider_close_receipts = cleanupBrowserCloseReceipts;
        disconnectBody.browser_provider_activation_abort_receipts = cleanupActivationAbortReceipts;
      }
      if (cleanupConversationAudio) {
        disconnectBody.conversation_audio_base64 = bytesToBase64(
          new Uint8Array(cleanupConversationAudio.data),
        );
        disconnectBody.conversation_audio_mime_type = cleanupConversationAudio.mimeType;
      }
      const disconnectResponse = await fetchFn(disconnectTargetPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(providerCleanupToken
            ? { [VOICE_LAB_PROVIDER_CLEANUP_HEADER]: providerCleanupToken }
            : {}),
        },
        body: JSON.stringify(disconnectBody),
        keepalive: true,
      }).catch(() => null);
      let disconnectPayload: Record<string, unknown> | null = null;
      if (syntheticTestContext !== null) {
        if (!disconnectResponse?.ok || disconnectResponse.status !== 202) {
          throw new Error('Synthetic provider close receipt was not accepted; cleanup remains pending.');
        }
        disconnectPayload = (await disconnectResponse.json()) as Record<string, unknown>;
        const acceptedCloseReceipts = disconnectPayload.browser_provider_close_receipts;
        const acceptedAbortReceipts = disconnectPayload.browser_provider_activation_abort_receipts;
        if (
          !sameJsonValue(acceptedCloseReceipts, cleanupBrowserCloseReceipts)
          || !sameJsonValue(acceptedAbortReceipts, cleanupActivationAbortReceipts)
        ) {
          throw new Error('Synthetic provider settlement acknowledgement did not match.');
        }
        // Retain only the two canonical arrays echoed by the authenticated
        // 202 response.  The D02 browser-owner bridge must never manufacture a
        // success receipt from local teardown state alone.
        cleanupSettlementAcknowledgement = {
          browser_provider_close_receipts: cleanupBrowserCloseReceipts.map((receipt) => ({ ...receipt })),
          browser_provider_activation_abort_receipts: cleanupActivationAbortReceipts.map((receipt) => ({ ...receipt })),
        };
      }
      if (syntheticTraceFault !== null) {
        if (!disconnectResponse?.ok || syntheticTestContext === null) {
          throw new Error('Governed trace fault cleanup did not return an authenticated restoration receipt.');
        }
        disconnectPayload ??= (await disconnectResponse.json()) as Record<string, unknown>;
        const restored = readGeminiVoiceLabTraceFaultReceipt(
          disconnectPayload.trace_fault,
          syntheticTestContext,
          'Gemini trace fault restoration receipt',
          'restored',
        );
        if (restored === null || restored.applied_at !== syntheticTraceFault.applied_at) {
          throw new Error('Governed trace fault restoration receipt did not match the applied fault.');
        }
        options.onSyntheticTraceFaultReceipt?.(restored);
      }
      cleanupDisconnectAcknowledged = syntheticTestContext !== null
        ? true
        : disconnectResponse !== null;
      if (cleanupDisconnectAcknowledged && cleanupRetryTimer !== null) {
        clearTimeout(cleanupRetryTimer);
        cleanupRetryTimer = null;
      }
    }
    if (!dogfoodSessionId) cleanupDisconnectAcknowledged = true;
    notifyRelayStatus('disconnected');
    notifyStage('closed');
  };

  const cleanup = async () => {
    if (cleanupDisconnectAcknowledged) return;
    cleanupInFlight ??= performCleanup();
    try {
      await cleanupInFlight;
      cleanupRetryAttempt = 0;
    } catch (error) {
      if (
        syntheticTestContext !== null
        && !cleanupDisconnectAcknowledged
        && cleanupRetryTimer === null
      ) {
        const delayMs = Math.min(1_000 * (2 ** cleanupRetryAttempt), 30_000);
        cleanupRetryAttempt += 1;
        cleanupRetryTimer = setTimeout(() => {
          cleanupRetryTimer = null;
          void cleanup().catch((retryError: unknown) => {
            options.onRelayError?.(retryError);
          });
        }, delayMs);
      }
      throw error;
    } finally {
      cleanupInFlight = null;
    }
  };

  try {
    notifyStage('starting_backend_session');
    const browserSession = options.bootstrapPayload
      ? readBrowserSessionPayload(options.bootstrapPayload, 'Gemini browser Live session bootstrap')
      : await startBrowserDogfoodSession(fetchFn, options);
    dogfoodSessionId = browserSession.sessionId;
    syntheticTestContext = browserSession.syntheticTest;
    providerCleanupToken = browserSession.providerCleanupToken;
    providerCleanupExpiresAt = browserSession.providerCleanupExpiresAt;
    cleanupProviderAdmissionId = browserSession.cleanupProviderAdmissionId;
    syntheticTraceFault = browserSession.syntheticTraceFault;
    if (syntheticTraceFault !== null) {
      options.onSyntheticTraceFaultReceipt?.(syntheticTraceFault);
    }
    const initialProviderCandidateEpoch = browserSession.providerConnectionEpoch;
    providerConnectionEpoch = browserSession.syntheticTest !== null
      ? initialProviderCandidateEpoch - 1
      : initialProviderCandidateEpoch;
    if (browserSession.syntheticTest !== null) {
      knownProviderCandidateEpochs.add(initialProviderCandidateEpoch);
      unsettledProviderEpochs.add(initialProviderCandidateEpoch);
      providerCleanupGeneration += 1;
      const providerExpiryMs = Date.parse(browserSession.syntheticTest.provider_expires_at);
      const remainingMs = providerExpiryMs - Date.now();
      if (!Number.isFinite(providerExpiryMs) || remainingMs <= 0) {
        throw new Error('Gemini synthetic provider authority has expired.');
      }
      providerExpiryTimer = setTimeout(() => {
        if (closed) return;
        closed = true;
        void cleanup().catch((error: unknown) => options.onRelayError?.(error));
      }, Math.min(remainingMs, 2_147_483_647));
    }
    syntheticInteractionEvidence = browserSession.syntheticTest
      ? createGeminiSyntheticInteractionEvidenceTracker({
          syntheticTest: browserSession.syntheticTest,
          getProviderConnectionEpoch: () => providerConnectionEpoch,
          onReceipt: options.onSyntheticInteractionReceipt,
          onFaultReceipt: (receipt) => {
            syntheticInputEvidenceFaulted = true;
            options.onSyntheticInteractionFaultReceipt?.(receipt);
            const activeProvider = websocketRef.current;
            if (activeProvider?.readyState === WEBSOCKET_OPEN) {
              activeProvider.close(4102, 'voice-lab-interaction-evidence-fault');
            }
          },
        })
      : null;
    syntheticInputEvidence = browserSession.syntheticTest
      ? createGeminiSyntheticInputEvidenceTracker({
          syntheticTest: browserSession.syntheticTest,
          getProviderConnectionEpoch: () => providerConnectionEpoch,
          onLegReceipt: options.onSyntheticInputLegReceipt,
          onTurnReceipt: options.onSyntheticInputTurnReceipt,
          onAcceptedPublicUserTurn: (binding, acceptedAt) => {
            syntheticInteractionEvidence?.noteAcceptedPublicUserTurn(binding, acceptedAt);
          },
          onFaultReceipt: (receipt) => {
            syntheticInputEvidenceFaulted = true;
            options.onSyntheticInputFaultReceipt?.(receipt);
            const activeProvider = websocketRef.current;
            if (activeProvider?.readyState === WEBSOCKET_OPEN) {
              activeProvider.close(4101, 'voice-lab-input-evidence-fault');
            }
          },
        })
      : null;
    langsmithTraceContext = {
      langsmithTraceId: browserSession.langsmithTraceId,
      langsmithTraceStatus: browserSession.langsmithTraceStatus,
      langsmithTraceUnavailableReason: browserSession.langsmithTraceUnavailableReason,
    };
    notifyProviderConnectionEpoch('bootstrap', null, 'initial_browser_session');
    websocketRef.current = null;
    disconnectTargetPath = browserSession.disconnectUrl ?? DISCONNECT_TARGET_PATH;
    const activationReceipts = new Map<number, Record<string, unknown>>();
    const activateProviderSocket = async (
      socket: WebSocketLike,
      candidateEpoch: number,
      previousActivatedEpoch: number,
      previousSocketCloseReceipt: Record<string, unknown> | null = null,
    ) => {
      if (browserSession.syntheticTest === null) {
        providerConnectionEpoch = candidateEpoch;
        return;
      }
      const activationUrl = browserSession.providerActivationUrl;
      if (!activationUrl || !dogfoodSessionId) {
        throw new Error('Synthetic provider activation endpoint is unavailable.');
      }
      if (
        providerSocketEpochs.get(socket) !== candidateEpoch
        || candidateEpoch !== previousActivatedEpoch + 1
      ) {
        throw new Error('Synthetic provider activation epoch binding is invalid.');
      }
      let receipt = activationReceipts.get(candidateEpoch);
      if (!receipt) {
        const activationId = globalThis.crypto?.randomUUID?.();
        if (!activationId) {
          throw new Error('Synthetic provider activation identity is unavailable.');
        }
        receipt = {
          schema: 'sophia_gemini_browser_provider_activation_v1',
          activation_id: activationId,
          session_id: dogfoodSessionId,
          previous_activated_epoch: previousActivatedEpoch,
          candidate_epoch: candidateEpoch,
          websocket_open_observed: true,
          close_observer_attached: true,
          websocket_opened_at: new Date().toISOString(),
          previous_socket_close_receipt: previousSocketCloseReceipt,
        };
        activationReceipts.set(candidateEpoch, receipt);
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetchFn(activationUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(receipt),
        }).catch(() => null);
        if (response?.ok && response.status === 202) {
          const payload = (await response.json()) as Record<string, unknown>;
          const accepted = payload.provider_activation_receipt;
          if (
            isRecord(accepted)
            && sameJsonValue(accepted, receipt)
            && payload.activated === true
            && payload.provider_connection_epoch === candidateEpoch
          ) {
            providerConnectionEpoch = candidateEpoch;
            if (pendingContinuationCandidateExpected === candidateEpoch) {
              pendingContinuationCandidateExpected = null;
            }
            if (previousActivatedEpoch > 0) {
              if (unsettledProviderEpochs.delete(previousActivatedEpoch)) {
                providerCleanupGeneration += 1;
              }
            }
            return;
          }
        }
        if (attempt < 2) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100 * (2 ** attempt));
          });
        }
      }
      throw new Error('Synthetic provider activation was not acknowledged.');
    };
    const coreviewToolsEnabled = options.coreviewStillFrameEnabled ?? isCoReviewStillFrameEnabled();
    const sessionSetup = withCoreviewGeminiToolDeclarations(browserSession.setup, coreviewToolsEnabled, {
      allowArtifactCreation: false,
    });
    const bootstrapProviderContinuation = async (): Promise<{
      websocket: WebSocketLike;
      setup: Record<string, unknown>;
    } | null> => {
      if (closed) return null;
      const continuationUrl = browserSession.continuationBootstrapUrl;
      if (!continuationUrl || !dogfoodSessionId) {
        continuityState = 'degraded';
        notifyRelayStatus('degraded');
        notifyProviderConnectionEpoch('degraded', providerConnectionEpoch, 'continuation_endpoint_unavailable');
        return null;
      }
      if (!safeResumptionHandle) {
        // A fresh token cannot preserve native Gemini continuity. Never turn
        // a transport failure into a silent new conversation.
        continuityState = 'degraded';
        notifyRelayStatus('degraded');
        notifyProviderConnectionEpoch('degraded', providerConnectionEpoch, 'resumption_handle_unavailable');
        return null;
      }
      continuityState = 'rotation_pending';
      const expectedEpoch = providerConnectionEpoch;
      pendingContinuationCandidateExpected = expectedEpoch + 1;
      if (browserSession.syntheticTest !== null) {
        knownProviderCandidateEpochs.add(pendingContinuationCandidateExpected);
        unsettledProviderEpochs.add(pendingContinuationCandidateExpected);
        providerCleanupGeneration += 1;
      }
      notifyProviderConnectionEpoch('rotation_pending', expectedEpoch, 'provider_continuation_requested');
      const response = await fetchFn(continuationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_epoch: expectedEpoch,
          handle_present: true,
          secret_generation: safeResumptionGeneration,
        }),
      }).catch(() => null);
      if (!response?.ok) {
        continuityState = 'degraded';
        notifyRelayStatus('degraded');
        notifyProviderConnectionEpoch('degraded', expectedEpoch, 'provider_continuation_bootstrap_failed');
        return null;
      }
      const payload = (await response.json()) as BrowserSessionPayload;
      const nextSession = readBrowserSessionPayload(payload, 'Gemini continuation bootstrap');
      if (!sameGeminiSyntheticTestContext(browserSession.syntheticTest, nextSession.syntheticTest)) {
        throw new Error('Gemini continuation bootstrap synthetic_test did not match the active run.');
      }
      if (nextSession.providerExpiresAt !== browserSession.providerExpiresAt) {
        throw new Error('Gemini continuation provider deadline changed.');
      }
      if (
        nextSession.providerCleanupExpiresAt !== providerCleanupExpiresAt
        || nextSession.cleanupProviderAdmissionId !== cleanupProviderAdmissionId
        || (browserSession.syntheticTest !== null && !nextSession.providerCleanupToken)
      ) {
        throw new Error('Gemini continuation provider cleanup binding changed.');
      }
      if (nextSession.providerCleanupToken) {
        providerCleanupToken = nextSession.providerCleanupToken;
      }
      if (browserSession.syntheticTest !== null) {
        const candidateWasKnown = knownProviderCandidateEpochs.has(
          nextSession.providerConnectionEpoch,
        );
        const candidateWasUnsettled = unsettledProviderEpochs.has(
          nextSession.providerConnectionEpoch,
        );
        knownProviderCandidateEpochs.add(nextSession.providerConnectionEpoch);
        unsettledProviderEpochs.add(nextSession.providerConnectionEpoch);
        if (!candidateWasKnown || !candidateWasUnsettled) {
          providerCleanupGeneration += 1;
        }
      }
      if (closed) {
        cleanupTeardownComplete = false;
        return null;
      }
      const nextSetup = withCoreviewGeminiToolDeclarations(nextSession.setup, coreviewToolsEnabled, {
        allowArtifactCreation: false,
      });
      const currentResumption = isRecord(nextSetup.sessionResumption)
        ? nextSetup.sessionResumption
        : {};
      nextSetup.sessionResumption = {
        ...currentResumption,
        handle: safeResumptionHandle,
      };
      if (langsmithTraceContext.langsmithTraceStatus === 'trace_unavailable' && nextSession.langsmithTraceId) {
        langsmithTraceContext = {
          langsmithTraceId: nextSession.langsmithTraceId,
          langsmithTraceStatus: nextSession.langsmithTraceStatus,
          langsmithTraceUnavailableReason: nextSession.langsmithTraceUnavailableReason,
        };
      }
      if (closed) return null;
      const nextSocket = webSocketFactory(nextSession.websocketUrl);
      providerSocketEpochs.set(nextSocket, nextSession.providerConnectionEpoch);
      providerSockets.add(nextSocket);
      providerCleanupGeneration += 1;
      nextSocket.onclose = (event) => noteProviderSocketClosed(nextSocket, event);
      if (closed) {
        nextSocket.close(1000, 'Gemini Live continuation cancelled during cleanup.');
        return null;
      }
      return {
        websocket: nextSocket,
        setup: nextSetup,
      };
    };

    audioContext = audioContextFactory();
    // The evidence monitor is part of the protected synthetic test plane only.
    // Ordinary Sophia sessions preserve the pre-VT00 source -> output wiring.
    outputLegMonitor = browserSession.syntheticTest
      ? createGeminiOutputLegMonitor(audioContext)
      : null;
    // Construct and resume the context while the connect gesture is still
    // active. Waiting until getUserMedia resolves can lose the browser's user
    // activation and leave a perfectly healthy provider stream inaudible.
    notifyAudioContextDiagnostics(await resumeGeminiAudioContext(audioContext));
    notifyStage('requesting_microphone');
    localStream = await getUserMedia({
      audio: { ...REQUESTED_MICROPHONE_AUDIO_CONSTRAINTS },
    });
    microphoneAudioSettings = recordGeminiMicrophoneAudioSettings(localStream);
    options.onMicrophoneAudioSettings?.(microphoneAudioSettings);
    notifyAudioContextDiagnostics(await resumeGeminiAudioContext(audioContext));
    if (browserSession.audioCaptureEnabled) {
      conversationAudioRecorder = createGeminiConversationAudioRecorder(audioContext);
    }
    outputAudioPlayer = createGeminiOutputAudioPlaybackController(audioContext, {
      maxDiagnostics: MAX_OUTPUT_AUDIO_CHUNK_DIAGNOSTICS,
      onChunkReceived: options.onOutputAudioReceived || syntheticInteractionEvidence
        ? (diagnostic) => {
            options.onOutputAudioReceived?.(
              syntheticInteractionEvidence?.noteOutputReceived(diagnostic) ?? diagnostic,
            );
          }
        : undefined,
      onChunkDiagnostic: options.onOutputAudioChunk || syntheticInteractionEvidence
        ? (diagnostic) => {
            options.onOutputAudioChunk?.(
              syntheticInteractionEvidence?.noteOutputChunk(diagnostic) ?? diagnostic,
            );
          }
        : undefined,
      onPlaybackReceipt: options.onOutputAudioPlaybackReceipt || syntheticInteractionEvidence
        ? (receipt) => {
            options.onOutputAudioPlaybackReceipt?.(
              syntheticInteractionEvidence?.noteOutputPlayback(receipt) ?? receipt,
            );
          }
        : undefined,
      onOutputLegMonitorReceipt: options.onOutputLegMonitorReceipt,
      outputLegMonitor: outputLegMonitor ?? undefined,
      outputNode: conversationAudioRecorder?.outputNode,
      maxPlaybackAheadSeconds: options.outputAudioMaxPlaybackAheadSeconds,
      maxQueuedChunks: options.outputAudioMaxQueuedChunks,
    });

    notifyStage('opening_websocket');
    websocket = webSocketFactory(browserSession.websocketUrl);
    providerSocketEpochs.set(websocket, initialProviderCandidateEpoch);
    providerSockets.add(websocket);
    providerCleanupGeneration += 1;
    websocketRef.current = websocket;
    await waitForWebSocketOpen(websocket, (event) => {
      noteProviderSocketClosed(websocket as WebSocketLike, event);
    });

    const setupComplete = waitForGeminiSetupComplete(websocket, {
      onProviderEvent: options.onProviderEvent,
      onProviderEventTelemetry: (event, receiveMetadata) => {
        if (isRecord(event)) {
          syntheticInteractionEvidence?.observeProviderEvent(event, receiveMetadata);
        }
        const telemetry = recordGeminiProviderEventTelemetry(
          providerCategoryCounts,
          relayClassificationCounts,
          event,
          receiveMetadata.providerReceivedAt,
          receiveMetadata,
        );
        lastProviderEventType = telemetry.primaryCategory;
        const usageMetadata = recordFromAnyKey(event, 'usageMetadata', 'usage_metadata');
        if (usageMetadata) {
          latestUsageMetadata = { ...usageMetadata };
          latestUsageMetadataReceiveSequence = receiveMetadata.providerReceiveSequence;
        }
        const syntheticInputOperation = syntheticInputEvidence?.currentBinding() ?? null;
        if (telemetry.hasInputTranscriptionText) {
          syntheticInputEvidence?.noteProviderInputTranscription(
            receiveMetadata,
            telemetry.inputTranscriptionTextPreview?.length ?? 0,
          );
        }
        options.onProviderEventTelemetry?.(
          syntheticInputEvidence
            ? { ...telemetry, syntheticInputOperation }
            : telemetry,
        );
      },
      onProviderToolEvent: (event) => {
        const timestamp = new Date().toISOString();
        for (const toolCall of readGeminiToolCallsFromEvent(event)) {
          updateToolCallLedger(toolCall.id, {
            toolName: toolCall.name,
            receivedAt: timestamp,
          });
        }
        for (const cancelledId of readGeminiToolCancellationIds(event)) {
          updateToolCallLedger(cancelledId, { cancelledAt: timestamp });
        }
      },
      onFrontendToolEvent: (event) => handleGeminiFrontendCoreviewToolEvent({
        event,
        websocket,
        sessionId: browserSession.sessionId,
        threadId: options.threadId ?? null,
        activeArtifactId: artifactReviewArtifactId,
        artifactReviewContext: snapshotArtifactReviewRelayContext(),
        reviewToolTimeoutMs: options.reviewToolTimeoutMs,
        toolCallLedger,
        onToolCallLedgerUpdate: notifyToolCallLedgerUpdate,
        onToolLoopDiagnostic: options.onToolLoopDiagnostic,
        onToolResponseSent: noteToolResponseSent,
      }),
      onProviderEventReceived: (event) => ({
        ...buildGeminiProviderReceiveMetadata(
          event,
          providerReceiveSequence += 1,
        ),
        providerConnectionEpoch,
      }),
      onRelayEvent: function handleRelayEvent(event, receiveMetadata) {
        const flushPendingOutputTranscript = () => {
          if (outputTranscriptRelayTimer !== null) {
            clearTimeout(outputTranscriptRelayTimer);
            outputTranscriptRelayTimer = null;
          }
          const pending = pendingOutputTranscriptRelay;
          pendingOutputTranscriptRelay = null;
          if (!pending) {
            return false;
          }
          lastOutputTranscriptRelayAtMs = monotonicNowMs();
          assembledOutputTranscriptRelayEvents.add(pending.event);
          handleRelayEvent(pending.event, pending.receiveMetadata);
          return true;
        };

        const discardPendingOutputTranscript = () => {
          if (outputTranscriptRelayTimer !== null) {
            clearTimeout(outputTranscriptRelayTimer);
            outputTranscriptRelayTimer = null;
          }
          if (pendingOutputTranscriptRelay) {
            relayThroughputMetrics.transcriptPartialsDropped += 1;
          }
          pendingOutputTranscriptRelay = null;
        };

        const finishOutputTranscriptSegment = () => {
          activeOutputTranscriptSegment = null;
          outputTranscriptSegmentOrdinal += 1;
        };

        const schedulePendingOutputTranscript = () => {
          if (transcriptRelayCadenceMs === 0) {
            flushPendingOutputTranscript();
            return;
          }
          if (outputTranscriptRelayTimer !== null) {
            return;
          }
          const elapsedSinceLastFlush = lastOutputTranscriptRelayAtMs === null
            ? 0
            : elapsedMs(lastOutputTranscriptRelayAtMs);
          const delayMs = lastOutputTranscriptRelayAtMs === null
            ? transcriptRelayCadenceMs
            : Math.max(0, transcriptRelayCadenceMs - elapsedSinceLastFlush);
          outputTranscriptRelayTimer = setTimeout(() => {
            outputTranscriptRelayTimer = null;
            flushPendingOutputTranscript();
          }, delayMs);
        };

        const assembledRelayEvent = assembledOutputTranscriptRelayEvents.has(event);
        if (!assembledRelayEvent) {
          const rawCategories = categorizeGeminiProviderEvent(event);
          const hasOutputTranscription = rawCategories.includes('outputTranscription');
          const interrupted = isGeminiServerInterruptedEvent(event);

          if (rawCategories.includes('inputTranscription')) {
            discardPendingOutputTranscript();
            finishOutputTranscriptSegment();
            anonymousResponseOrdinal += 1;
            anonymousResponseCompleted = false;
          } else if (!hasOutputTranscription && interrupted) {
            discardPendingOutputTranscript();
            finishOutputTranscriptSegment();
          } else if (!hasOutputTranscription && shouldAdvanceAssistantTranscriptPartialSegment(event, rawCategories)) {
            flushPendingOutputTranscript();
            finishOutputTranscriptSegment();
          }

          if (hasOutputTranscription) {
            const rawOutputText = readTranscriptionText(event, 'outputTranscription', 'output_transcription');
            const responseId = readGeminiStableResponseId(event);
            if (!responseId && anonymousResponseCompleted) {
              anonymousResponseOrdinal += 1;
              anonymousResponseCompleted = false;
            }
            const responseKey = responseId
              ? `response:${responseId}`
              : `anonymous-response:${anonymousResponseOrdinal}`;
            if (activeOutputTranscriptSegment?.responseKey !== responseKey) {
              flushPendingOutputTranscript();
              finishOutputTranscriptSegment();
              activeOutputTranscriptSegment = {
                responseId,
                responseKey,
                segmentKey: `${responseKey}:segment:${outputTranscriptSegmentOrdinal}`,
                text: '',
                lastFragment: null,
              };
            }

            if (rawOutputText && activeOutputTranscriptSegment) {
              const responseState = repeatedIntentResponseStates.get(responseKey) ?? {
                text: '',
                lastFragment: null,
                gated: false,
              };
              const responseAssembly = assembleGeminiOutputTranscription(
                responseState.text,
                rawOutputText,
                responseState.lastFragment,
              );
              responseState.text = responseAssembly.text;
              responseState.lastFragment = rawOutputText;
              repeatedIntentResponseStates.delete(responseKey);
              repeatedIntentResponseStates.set(responseKey, responseState);
              while (repeatedIntentResponseStates.size > MAX_REPEATED_INTENT_RESPONSE_STATES) {
                const oldest = repeatedIntentResponseStates.keys().next().value;
                if (typeof oldest !== 'string') break;
                repeatedIntentResponseStates.delete(oldest);
              }

              if (!responseState.gated && responseAssembly.changed) {
                const repeatedIntent = detectGeminiSameResponseRepeatedIntent(responseState.text);
                if (repeatedIntent.detected) {
                  responseState.gated = true;
                  repeatedIntentSuppressedResponseKeys.add(responseKey);
                  pruneStringSet(repeatedIntentSuppressedResponseKeys, 50);
                  dropBufferedArtifactReviewAudio(responseId, 'repeated_intent_gate');
                  const playbackStateBefore = outputAudioPlayer?.snapshot() ?? defaultPlaybackState();
                  const playbackFlushed = playbackStateBefore.activeSourceCount > 0
                    || playbackStateBefore.queuedChunkCount > 0
                    || playbackStateBefore.playbackAheadSeconds > 0;
                  const playbackStateAfter = playbackFlushed
                    ? outputAudioPlayer?.flush('repeated_intent_gate') ?? defaultPlaybackState()
                    : playbackStateBefore;
                  const gateDiagnostic: GeminiRepeatedIntentGateDiagnostic = {
                    timestamp: new Date().toISOString(),
                    reason: 'repeated_intent_gate',
                    responseId,
                    segmentKey: activeOutputTranscriptSegment.segmentKey,
                    providerReceiveSequence: receiveMetadata.providerReceiveSequence,
                    providerReceivedAt: receiveMetadata.providerReceivedAt,
                    questionCount: repeatedIntent.questionCount,
                    firstQuestionFingerprint: repeatedIntent.firstQuestionFingerprint,
                    secondQuestionFingerprint: repeatedIntent.secondQuestionFingerprint,
                    similarityScore: repeatedIntent.similarityScore,
                    matchedSignals: repeatedIntent.matchedSignals,
                    playbackFlushed,
                    playbackStateBefore,
                    playbackStateAfter,
                    rawProviderOutputTranscriptionUsed: true,
                  };
                  options.onRepeatedIntentGate?.(gateDiagnostic);
                  emitStaleOutputSuppression(
                    event,
                    receiveMetadata,
                    'audio',
                    'repeated_intent_gate',
                    {
                      questionCount: gateDiagnostic.questionCount,
                      firstQuestionFingerprint: gateDiagnostic.firstQuestionFingerprint,
                      secondQuestionFingerprint: gateDiagnostic.secondQuestionFingerprint,
                      similarityScore: gateDiagnostic.similarityScore,
                      matchedSignals: gateDiagnostic.matchedSignals,
                    },
                  );
                }
              }

              const segmentAssembly = assembleGeminiOutputTranscription(
                activeOutputTranscriptSegment.text,
                rawOutputText,
                activeOutputTranscriptSegment.lastFragment,
              );
              activeOutputTranscriptSegment.text = segmentAssembly.text;
              activeOutputTranscriptSegment.lastFragment = rawOutputText;
              if (segmentAssembly.changed) {
                const assembledEvent = buildGeminiAssembledOutputTranscriptionEvent(
                  event,
                  segmentAssembly.text,
                );
                const previousPending = pendingOutputTranscriptRelay;
                pendingOutputTranscriptRelay = {
                  event: assembledEvent,
                  receiveMetadata,
                  segmentKey: activeOutputTranscriptSegment.segmentKey,
                };
                if (previousPending) {
                  relayThroughputMetrics.transcriptPartialsCoalesced += 1;
                  relayThroughputMetrics.transcriptPartialsDropped += 1;
                  relayThroughputMetrics.coalescedBySegment[activeOutputTranscriptSegment.segmentKey] = (
                    relayThroughputMetrics.coalescedBySegment[activeOutputTranscriptSegment.segmentKey] ?? 0
                  ) + 1;
                  options.onRelayCoalescingDiagnostic?.({
                    timestamp: new Date().toISOString(),
                    reason: 'superseded_pending_assistant_partial',
                    segmentKey: activeOutputTranscriptSegment.segmentKey,
                    droppedProviderReceiveSequence: previousPending.receiveMetadata.providerReceiveSequence,
                    replacementProviderReceiveSequence: receiveMetadata.providerReceiveSequence,
                    droppedRelayCorrelationId: previousPending.receiveMetadata.relayCorrelationId,
                    replacementRelayCorrelationId: receiveMetadata.relayCorrelationId,
                    orderedRelayQueueDepth: orderedRelayQueue.length,
                    oldestQueuedAgeMs: relayQueueOldestQueuedAgeMs(),
                    metrics: snapshotRelayThroughputMetrics(),
                  });
                }
              } else {
                relayThroughputMetrics.transcriptPartialsDropped += 1;
              }
            }

            if (isRawAssistantOutputTranscriptPartial(event, rawCategories)) {
              schedulePendingOutputTranscript();
              return;
            }

            flushPendingOutputTranscript();
            event = removeGeminiOutputTranscriptionFromEvent(event);
            finishOutputTranscriptSegment();
            if (hasGeminiServerContentTurnBoundary(event)) {
              anonymousResponseCompleted = true;
            }
            if (!isRelayableGeminiProviderEvent(event)) {
              return;
            }
          }
          if (!hasOutputTranscription && hasGeminiServerContentTurnBoundary(event)) {
            anonymousResponseCompleted = true;
          }
        }

        const classification = classifyGeminiProviderEventForRelay(event);
        if (!classification.shouldRelay) {
          return;
        }
        const categories = classification.categories;
        markAssistantOutputStarted(event, categories, receiveMetadata);
        if (categories.includes('inputTranscription')) {
          rememberArtifactReviewUserIntent(readTranscriptionText(event, 'inputTranscription', 'input_transcription'));
          const confirmation = providerInputTranscriptionConfirmation(event, receiveMetadata);
          promoteBargeInInputTranscription(event, receiveMetadata, confirmation);
        }
        const artifactReviewContext = snapshotArtifactReviewRelayContext();
        const leakageMarker = artifactReviewAssistantLeakageMarker(event, categories, artifactReviewContext);
        const responseId = readGeminiResponseId(event);
        if (leakageMarker) {
          if (responseId) {
            artifactReviewSuppressedResponseIds.add(responseId);
            pruneStringSet(artifactReviewSuppressedResponseIds, 50);
          }
          dropBufferedArtifactReviewAudio(responseId);
          if (categories.includes('outputTranscription') || categories.includes('modelTurnText')) {
            relayThroughputMetrics.transcriptPartialsDropped += 1;
          }
          return;
        }
        if (
          artifactReviewContext?.active
          && responseId
          && (categories.includes('outputTranscription') || categories.includes('modelTurnText'))
        ) {
          markArtifactReviewResponseSafe(responseId);
        }
        const transcriptSuppressionReason = staleOutputSuppressionReason(event, categories, receiveMetadata);
        if (transcriptSuppressionReason && (categories.includes('outputTranscription') || categories.includes('modelTurnText'))) {
          relayThroughputMetrics.transcriptPartialsDropped += 1;
          emitStaleOutputSuppression(event, receiveMetadata, 'transcript', transcriptSuppressionReason);
          return;
        }
        if (
          responseId
          && (hasGeminiServerContentTurnBoundary(event) || isGeminiServerInterruptedEvent(event))
          && !artifactReviewSafeResponseIds.has(responseId)
        ) {
          dropBufferedArtifactReviewAudio(responseId);
        }
        if (hasGeminiServerContentTurnBoundary(event) && !isGeminiServerInterruptedEvent(event)) {
          if (staleOutputSuppressionActive) {
            clearStaleOutputFence();
          }
          clearAssistantOutputState();
        }
        const eventCategory = categories[0] ?? 'unknown';
        const correlationId = receiveMetadata.relayCorrelationId;
        const rawAssistantTranscriptPartial = isRawAssistantOutputTranscriptPartial(event, categories);
        const coalescingKey = null;
        const useOrderedLane = shouldUseOrderedRelayLane(classification);
        dispatchRelay(async (queueDepth, oldestQueuedAgeMs) => {
          const nextProviderRelaySequence = providerRelaySequence + 1;
          const relayMetadata: GeminiProviderReceiveMetadata = {
            ...receiveMetadata,
            providerRelaySequence: nextProviderRelaySequence,
          };
          const relayStartedAt = new Date().toISOString();
          const relayStartMs = monotonicNowMs();
          relayAttemptCount += 1;
          if (rawAssistantTranscriptPartial) {
            relayThroughputMetrics.transcriptPartialsSent += 1;
          } else if (isFinalTranscriptRelayEvent(event)) {
            relayThroughputMetrics.finalTranscriptEventsSent += 1;
          } else if (isNonDroppableCriticalRelayEvent(classification, event, categories)) {
            relayThroughputMetrics.nonDroppableCriticalEventsSent += 1;
          }
          const syntheticToolEvidence: GeminiSyntheticToolEvidence[] = [];
          for (const toolCall of readGeminiToolCallsFromEvent(event)) {
            updateToolCallLedger(toolCall.id, {
              toolName: toolCall.name,
              relayStartedAt,
            });
            const evidence = buildSyntheticToolEvidence(toolCall, relayMetadata, relayStartedAt);
            if (evidence) {
              syntheticToolEvidence.push(evidence);
              updateToolCallLedger(toolCall.id, { syntheticToolEvidence: evidence });
            }
          }
          await relayGeminiProviderEvent(
            fetchFn,
            browserSession.sessionId,
            event,
            relayMetadata,
            browserSession.relayTargetPath ?? RELAY_TARGET_PATH,
            artifactReviewContext,
            syntheticToolEvidence,
          )
          .then((relayResponse) => {
            providerRelaySequence = Math.max(providerRelaySequence, nextProviderRelaySequence);
            const relayCompletedAt = new Date().toISOString();
            const transcriptRelayLatencyMs = categories.includes('outputTranscription')
              ? latencyMsFromIso(receiveMetadata.providerReceivedAt, relayCompletedAt)
              : null;
            recordTranscriptRelayLatency(transcriptRelayLatencyMs);
            relaySuccessCount += 1;
            options.onRelayTrace?.({
              timestamp: relayCompletedAt,
              correlationId,
              providerReceiveSequence: relayMetadata.providerReceiveSequence,
              providerConnectionEpoch: relayMetadata.providerConnectionEpoch ?? null,
              providerReceivedAt: relayMetadata.providerReceivedAt,
              eventCategory,
              categories,
              relayClassification: classification.classification,
              relayClassificationReason: classification.reason,
              attemptCount: relayAttemptCount,
              successCount: relaySuccessCount,
              failureCount: relayFailureCount,
              success: true,
              statusCode: relayResponse.statusCode,
              statusText: relayResponse.statusText,
              durationMs: elapsedMs(relayStartMs),
              responseKind: relayResponse.responseKind,
              responseClientActionCount: relayResponse.clientActions.length,
              responseToolDiagnosticCount: relayResponse.toolDiagnostics.length,
              backendDiagnostics: compactGeminiBackendDiagnostics(relayResponse.backendDiagnostics),
              orderedRelayLane: useOrderedLane,
              queueDepth,
              oldestQueuedAgeMs,
              throughput: snapshotRelayThroughputMetrics(),
              aborted: false,
              sessionClosing: closed,
              errorText: null,
            });
            for (const diagnostic of relayResponse.toolDiagnostics) {
              const toolCallId = typeof diagnostic.id === 'string' ? diagnostic.id : null;
              const backendResponse = recordFromAnyKey(diagnostic, 'response');
              const currentEntry = toolCallId ? toolCallLedger.get(toolCallId) : null;
              const syntheticBuilderJoin = readGeminiSyntheticBuilderJoin(
                backendResponse?.synthetic_builder_join,
                currentEntry?.syntheticToolEvidence ?? null,
              );
              const executionRejected = diagnostic.execution_rejected === true
                || diagnostic.executionRejected === true
                || diagnostic.success === false
                || backendResponse?.ok === false;
              updateToolCallLedger(toolCallId, {
                toolName: typeof diagnostic.name === 'string' ? diagnostic.name : null,
                relayCompletedAt,
                backendAcceptedAt: executionRejected ? null : relayCompletedAt,
                syntheticBuilderJoin,
                finalState: executionRejected ? 'rejected' : 'unknown',
              });
            }
            for (const action of relayResponse.clientActions) {
              if (action.type !== 'gemini_tool_response' || !isRecord(action.payload)) {
                continue;
              }
              for (const functionResponse of readGeminiFunctionResponsesFromToolResponse(action.payload)) {
                const toolCallId = stringFromAnyKey(functionResponse, 'id');
                const response = recordFromAnyKey(functionResponse, 'response');
                const currentEntry = toolCallId ? toolCallLedger.get(toolCallId) : null;
                updateToolCallLedger(toolCallId, {
                  toolName: stringFromAnyKey(functionResponse, 'name'),
                  relayCompletedAt,
                  toolResponsePreparedAt: relayCompletedAt,
                  syntheticBuilderJoin: readGeminiSyntheticBuilderJoin(
                    response?.synthetic_builder_join,
                    currentEntry?.syntheticToolEvidence ?? null,
                  ),
                });
              }
            }
            relayConsecutiveFailures = 0;
            notifyRelayStatus('active');
            handleGeminiRelayClientActions({
              relayResponse,
              websocket,
              sessionId: browserSession.sessionId,
              threadId: options.threadId ?? null,
              toolCallLedger,
              onToolCallLedgerUpdate: notifyToolCallLedgerUpdate,
              onToolLoopDiagnostic: options.onToolLoopDiagnostic,
              onToolResponseSent: noteToolResponseSent,
            });
          })
          .catch((error) => {
            const failedAt = new Date().toISOString();
            const transcriptRelayLatencyMs = categories.includes('outputTranscription')
              ? latencyMsFromIso(receiveMetadata.providerReceivedAt, failedAt)
              : null;
            recordTranscriptRelayLatency(transcriptRelayLatencyMs);
            relayFailureCount += 1;
            relayFailureObserved = true;
            relayConsecutiveFailures += 1;
            const diagnostic = buildRelayDiagnostic({
              error,
              event,
              websocket,
              consecutiveFailures: relayConsecutiveFailures,
              sessionClosing: closed,
            });
            notifyRelayStatus(diagnostic.terminal ? 'terminal_error' : 'degraded');
            options.onRelayTrace?.({
              timestamp: failedAt,
              correlationId,
              providerReceiveSequence: relayMetadata.providerReceiveSequence,
              providerConnectionEpoch: relayMetadata.providerConnectionEpoch ?? null,
              providerReceivedAt: relayMetadata.providerReceivedAt,
              eventCategory,
              categories,
              relayClassification: classification.classification,
              relayClassificationReason: classification.reason,
              attemptCount: relayAttemptCount,
              successCount: relaySuccessCount,
              failureCount: relayFailureCount,
              success: false,
              statusCode: diagnostic.statusCode,
              statusText: diagnostic.statusText,
              durationMs: elapsedMs(relayStartMs),
              responseKind: 'neither',
              responseClientActionCount: 0,
              responseToolDiagnosticCount: 0,
              backendDiagnostics: null,
              orderedRelayLane: useOrderedLane,
              queueDepth,
              oldestQueuedAgeMs,
              throughput: snapshotRelayThroughputMetrics(),
              aborted: diagnostic.fetchErrorName === 'AbortError',
              sessionClosing: closed,
              errorText: diagnostic.errorText,
            });
            options.onRelayDiagnostic?.(diagnostic);
            options.onRelayError?.(error);
          });
        }, useOrderedLane, {
          coalescingKey,
          providerReceiveSequence: receiveMetadata.providerReceiveSequence,
          relayCorrelationId: receiveMetadata.relayCorrelationId,
        });
      },
      onOutputAudio: (event, receiveMetadata) => {
        const audioChunks = readGeminiOutputAudioChunks(event);
        if (!audioChunks.length) {
          return;
        }
        const categories = classifyGeminiProviderEventForRelay(event).categories;
        markAssistantOutputStarted(event, categories, receiveMetadata);
        const stableResponseId = readGeminiStableResponseId(event);
        const repeatedIntentResponseKey = stableResponseId
          ? `response:${stableResponseId}`
          : `anonymous-response:${anonymousResponseOrdinal}`;
        if (repeatedIntentSuppressedResponseKeys.has(repeatedIntentResponseKey)) {
          outputAudioPlayer?.dropEvent(event, receiveMetadata, 'repeated_intent_gate');
          return;
        }
        const audioSuppressionReason = staleOutputSuppressionReason(event, categories, receiveMetadata);
        if (audioSuppressionReason) {
          outputAudioPlayer?.dropEvent(event, receiveMetadata, audioSuppressionReason);
          emitStaleOutputSuppression(event, receiveMetadata, 'audio', audioSuppressionReason);
          return;
        }
        const responseId = readGeminiResponseId(event);
        if (responseId && artifactReviewSuppressedResponseIds.has(responseId)) {
          outputAudioPlayer?.dropEvent(event, receiveMetadata, 'artifact_review_response_suppressed');
          return;
        }
        const artifactReviewContext = snapshotArtifactReviewRelayContext();
        if (
          artifactReviewContext?.active
          && responseId
          && !artifactReviewSafeResponseIds.has(responseId)
        ) {
          bufferArtifactReviewAudio(responseId, event, receiveMetadata);
          return;
        }
        playGeminiOutputAudio(event, receiveMetadata);
      },
      onInterruption: (event) => {
        const responseId = readGeminiResponseId(event);
        if (responseId) {
          interruptedResponseIds.add(responseId);
        }
        const timestamp = new Date().toISOString();
        const wasStaleFenceActive = staleOutputSuppressionActive;
        const playbackStateBefore = outputAudioPlayer?.snapshot() ?? defaultPlaybackState();
        confirmBargeIn('provider_interruption', timestamp, {
          stopPlayback: true,
          reason: 'gemini_server_interrupted_event',
        });
        const playbackStateAfter = outputAudioPlayer?.snapshot() ?? defaultPlaybackState();
        const currentRawAssistantUserOverlapMs = Math.round(rawAssistantUserOverlapTotalMs());
        const currentConfirmedAssistantUserOverlapMs = Math.round(confirmedAssistantUserOverlapTotalMs());
        closeConfirmedAssistantUserOverlap();
        options.onInterruption?.({
          timestamp,
          reason: 'server_interrupted',
          playbackFlushed: playbackStateBefore.activeSourceCount > 0
            || playbackStateBefore.queuedChunkCount > 0
            || playbackStateBefore.playbackAheadSeconds > 0
            || playbackStateBefore.nextPlaybackTime > 0
            || wasStaleFenceActive,
          playbackStateBefore,
          playbackStateAfter,
          playbackGeneration: playbackStateAfter.playbackGeneration,
          interruptedResponseIds: Array.from(interruptedResponseIds).slice(-12),
          assistantUserOverlapMs: currentRawAssistantUserOverlapMs,
          rawAssistantUserOverlapMs: currentRawAssistantUserOverlapMs,
          confirmedAssistantUserOverlapMs: currentConfirmedAssistantUserOverlapMs,
          bargeInConfirmationSource: 'provider_interruption',
          bargeInConfirmationReason: 'gemini_server_interrupted_event',
        });
      },
      onToolLoopDiagnostic: options.onToolLoopDiagnostic,
      onWebSocketDiagnostic: recordWebSocketDiagnostic,
      onSessionResumptionUpdate: (event) => {
        const update = readGeminiSessionResumptionUpdate(event);
        if (!update) {
          return;
        }
        if (update.resumable && update.handle) {
          safeResumptionHandle = update.handle;
          safeResumptionGeneration += 1;
          return;
        }
        // A false/empty update is not permission to erase the last safe handle.
        // The next rotation will either use the last mechanically safe point or
        // degrade honestly when no continuation endpoint is available.
        continuityState = 'rotation_pending';
        notifyProviderConnectionEpoch(
          'rotation_pending',
          providerConnectionEpoch,
          'provider_resumption_not_currently_available',
        );
      },
      onGoAway: bootstrapProviderContinuation,
      onUnexpectedClose: async () => {
        if (closed || syntheticInputEvidenceFaulted) {
          return null;
        }
        notifyStage('reconnecting');
        outputAudioPlayer?.stop('provider_reconnect');
        clearAssistantOutputState();
        clearStaleOutputFence();
        return bootstrapProviderContinuation();
      },
      onProviderConnectionChanged: (nextSocket) => {
        websocket = nextSocket;
        websocketRef.current = nextSocket;
      },
      onProviderConnectionActivation: async (nextSocket, previousSocket) => {
        const nextEpoch = providerSocketEpochs.get(nextSocket);
        const previousEpoch = providerSocketEpochs.get(previousSocket);
        if (!nextEpoch || !previousEpoch || previousEpoch !== providerConnectionEpoch) {
          throw new Error('Gemini provider rotation epoch binding is invalid.');
        }
        if (previousSocket.readyState === WEBSOCKET_OPEN) {
          previousSocket.close(1000, 'Gemini Live continuation rotation.');
        }
        const previousClosed = await waitForProviderSocketClose(
          previousSocket,
          previousEpoch,
        );
        if (previousClosed === null) {
          throw new Error('Previous Gemini provider socket close was not observed.');
        }
        await activateProviderSocket(
          nextSocket,
          nextEpoch,
          previousEpoch,
          providerCloseReceipt(previousSocket, previousEpoch, previousClosed),
        );
        notifyProviderConnectionEpoch(
          'rotated',
          previousEpoch,
          'provider_continuation_browser_activated',
        );
      },
      onProviderSocketClosed: noteProviderSocketClosed,
      isSessionClosed: () => closed,
      onProviderConnectionRestored: () => {
        continuityState = 'active';
        notifyProviderConnectionEpoch('restored', providerConnectionEpoch, 'provider_continuation_setup_complete');
        notifyRelayStatus('active');
        notifyStage('connected');
        notifyStage('streaming_audio');
      },
      onProviderConnectionTerminated: () => {
        if (closed) {
          return;
        }
        continuityState = 'degraded';
        notifyProviderConnectionEpoch('degraded', providerConnectionEpoch, 'provider_connection_terminated');
        websocketRef.current = null;
        outputAudioPlayer?.stop('provider_connection_terminated');
        clearAssistantOutputState();
        notifyRelayStatus('terminal_error');
        notifyStage('connection_lost');
      },
      onProviderEventCompleted: (event, receiveMetadata) => {
        syntheticInteractionEvidence?.finishProviderEvent(event, receiveMetadata);
      },
    });
    // Activation is deliberately committed before provider setup is sent. If
    // that commit fails, cleanup closes the socket before control reaches the
    // later `await setupComplete`; attach a handler immediately so the exact
    // setup failure remains awaitable without becoming an unhandled rejection.
    void setupComplete.catch(() => undefined);

    await activateProviderSocket(
      websocket,
      initialProviderCandidateEpoch,
      providerConnectionEpoch,
    );
    notifyProviderConnectionEpoch(
      'bootstrap',
      null,
      'initial_browser_provider_activated',
    );

    notifyStage('sending_setup');
    websocket.send(JSON.stringify({ setup: sessionSetup }));

    notifyStage('waiting_setup_complete');
    await setupComplete;

    notifyStage('connected');
    audioPipeline = startMicrophoneAudioPipeline({
      localStream,
      audioContext,
      websocketRef,
      recordingInputNode: conversationAudioRecorder?.inputNode,
      onInputAudioActivity: handleInputAudioActivity,
      microphoneAudioSettings,
      syntheticInputEvidence,
    });
    notifyStage('streaming_audio');

    return {
      userId: options.userId,
      sessionId: browserSession.sessionId,
      streamUrl: browserSession.streamUrl,
      websocketUrl: browserSession.websocketUrl,
      relayUrl: browserSession.relayUrl,
      publicEventBoundary: browserSession.publicEventBoundary,
      transport: browserSession.transport,
      setup: sessionSetup,
      setupComplete: true,
      websocket,
      localStream,
      microphoneAudioSettings,
      get providerConnectionEpoch() {
        return providerConnectionEpoch;
      },
      getProviderConnectionEpoch: () => providerConnectionEpoch,
      getProviderSocketEpochs: () => Array.from(new Set([
        ...unsettledProviderEpochs,
        ...(pendingContinuationCandidateExpected === null
          ? []
          : [pendingContinuationCandidateExpected]),
      ])).sort((left, right) => left - right),
      get continuityState() {
        return continuityState;
      },
      get langsmithTraceId() {
        return langsmithTraceContext.langsmithTraceId;
      },
      get langsmithTraceStatus() {
        return langsmithTraceContext.langsmithTraceStatus;
      },
      get langsmithTraceUnavailableReason() {
        return langsmithTraceContext.langsmithTraceUnavailableReason;
      },
      syntheticTest: browserSession.syntheticTest,
      syntheticTraceFault: browserSession.syntheticTraceFault,
      sendText: (text: string) => {
        if (websocket?.readyState !== WEBSOCKET_OPEN) {
          throw new Error('Gemini Live WebSocket is not open.');
        }
        rememberArtifactReviewUserIntent(text);
        websocket.send(JSON.stringify({ realtimeInput: { text } }));
      },
      sendArtifactFrame: (
        frame: GeminiArtifactFramePayload,
        context?: GeminiArtifactFrameSendContext,
      ) => sendGeminiArtifactFrameOverWebSocket({
        websocket,
        frame,
        context,
        enabled: coreviewToolsEnabled,
        providerSnapshot: snapshotArtifactFrameProviderState,
        transportSnapshot: snapshotArtifactFrameTransportStatus,
      }).then((result) => {
        if (result.ok && result.websocketSendAccepted && result.artifactId) {
          if (artifactReviewArtifactId !== result.artifactId) {
            artifactReviewUserIntent = 'unknown';
            artifactReviewBuilderUpdateIntentDetected = false;
            artifactReviewUserIntentAt = null;
            artifactReviewSafeResponseIds.clear();
            artifactReviewSuppressedResponseIds.clear();
            dropPendingArtifactReviewAudio(null, 'artifact_review_response_suppressed');
          }
          artifactReviewArtifactId = result.artifactId;
          artifactReviewExpiresAtMs = monotonicNowMs() + ARTIFACT_REVIEW_RELAY_CONTEXT_TTL_MS;
        }
        return result;
      }),
      getArtifactFrameTransportStatus: snapshotArtifactFrameTransportStatus,
      setMicrophoneMuted: (muted: boolean) => {
        localStream?.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        });
        audioPipeline?.setMuted(muted);
      },
      acknowledgeSyntheticPublicUserTurn: (input) => {
        syntheticInputEvidence?.notePublicUserTurn(input);
      },
      flushOutputAudio: () => {
        confirmBargeIn('manual_interrupt', new Date().toISOString(), {
          stopPlayback: true,
          reason: 'local_manual_output_flush',
        });
        return outputAudioPlayer?.snapshot() ?? defaultPlaybackState();
      },
      close: async (control) => {
        if (control) {
          const requestedEpochs = Array.from(new Set(control.providerConnectionEpochs))
            .sort((left, right) => left - right);
          if (
            requestedEpochs.length === 0
            || requestedEpochs.length !== control.providerConnectionEpochs.length
            || requestedEpochs.some((epoch) => !Number.isSafeInteger(epoch) || epoch <= 0)
          ) {
            throw new Error('Synthetic provider cleanup control epochs are malformed.');
          }
          if (
            cleanupDisconnectAcknowledged
            && !sameJsonValue(cleanupRequestedProviderEpochs, requestedEpochs)
          ) {
            throw new Error('Synthetic provider cleanup control conflicts with the accepted settlement.');
          }
          for (const epoch of requestedEpochs) {
            const hasSocket = Array.from(providerSockets).some(
              (socket) => providerSocketEpochs.get(socket) === epoch,
            );
            if (
              !knownProviderCandidateEpochs.has(epoch)
              && !hasSocket
              && epoch === pendingContinuationCandidateExpected
            ) {
              knownProviderCandidateEpochs.add(epoch);
              unsettledProviderEpochs.add(epoch);
              providerCleanupGeneration += 1;
            }
          }
          if (!sameJsonValue(cleanupRequestedProviderEpochs, requestedEpochs)) {
            cleanupTeardownComplete = false;
            cleanupSettlementAcknowledgement = null;
            providerCleanupGeneration += 1;
          }
          cleanupRequestedProviderEpochs = requestedEpochs;
        }
        closed = true;
        await cleanup();
        if (control && syntheticTestContext !== null && cleanupSettlementAcknowledgement === null) {
          throw new Error('Synthetic provider settlement acknowledgement is unavailable.');
        }
        return cleanupSettlementAcknowledgement === null
          ? null
          : {
            browser_provider_close_receipts: cleanupSettlementAcknowledgement.browser_provider_close_receipts.map((receipt) => ({ ...receipt })),
            browser_provider_activation_abort_receipts: cleanupSettlementAcknowledgement.browser_provider_activation_abort_receipts.map((receipt) => ({ ...receipt })),
          };
      },
    };
  } catch (error) {
    closed = true;
    await cleanup();
    throw error;
  }
}

export async function connectGeminiBrowserLiveFromBootstrap(
  options: GeminiBrowserLiveProductionConnectOptions,
): Promise<GeminiBrowserLiveDogfoodConnection> {
  return connectGeminiBrowserLiveDogfood({
    ...options,
    bootstrapPayload: options.bootstrap,
  });
}

export function buildGeminiLiveWebSocketUrl(baseUrl: string, token: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('access_token', token);
    return url.toString();
  } catch {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

export function buildGeminiArtifactFrameRealtimeInput(
  frame: GeminiArtifactFramePayload,
): Record<string, unknown> {
  return {
    realtimeInput: {
      video: {
        mimeType: frame.mimeType,
        data: frame.data,
      },
    },
  };
}

export function buildGeminiArtifactTextReaderHint(artifactId: string): Record<string, unknown> {
  return {
    realtimeInput: {
      text: [
        'App context: artifact review is active for the selected artifact.',
        `artifact_id: ${artifactId}.`,
        'For simple visibility questions, answer from the fresh artifact frame or safe current-view metadata.',
        'Use exact-text sideband only when exact words, numbers, labels, or table values are needed.',
        'For highlight, mark, underline, annotate, note, comment, pin, flag, or callout requests, use coreview_add_annotation and wait for ok=true before saying it was added. Do not use coreview_refresh_view for annotation requests.',
        'For selected artifact edit, update, revise, rebuild, restyle, change title, or new-version requests, call coreview_request_artifact_update. Do not call edit_builder_artifact, start_builder_task, update_async_task, or emit_artifact directly in review.',
        'For zoom or focus on a title, selection, text, or area, use coreview_focus_anchor. Use coreview_refresh_view only when the user asks to refresh your view.',
        'Do not answer this context message.',
      ].join(' '),
    },
  };
}

async function sendGeminiArtifactFrameOverWebSocket({
  websocket,
  frame,
  context,
  enabled,
  providerSnapshot,
  transportSnapshot,
}: {
  websocket: WebSocketLike;
  frame: GeminiArtifactFramePayload;
  context?: GeminiArtifactFrameSendContext;
  enabled: boolean;
  providerSnapshot: () => {
    providerEventCount: number;
    lastProviderEventType: string | null;
    usageMetadata: Record<string, unknown> | null;
    usageMetadataReceiveSequence: number | null;
    imageCount: number | null;
  };
  transportSnapshot: () => GeminiArtifactFrameTransportStatusSnapshot;
}): Promise<GeminiArtifactFrameSendResult> {
  const sendStartedAtMs = monotonicNowMs();
  const sendStartedAt = new Date().toISOString();
  const providerBefore = providerSnapshot();
  const transportBefore = transportSnapshot();
  const baseResult = {
    coreviewSendStage: context?.coreviewSendStage ?? null,
    artifactId: frame.artifactId ?? null,
    frameBytes: frame.byteLength,
    frameDimensions: frame.dimensions,
    visualSourceKind: frame.visualSourceKind ?? null,
    mimeType: frame.mimeType,
    framePayloadSchemaVersion: GEMINI_ARTIFACT_FRAME_PAYLOAD_SCHEMA_VERSION,
    websocketReadyStateBefore: transportBefore.websocketReadyState,
    websocketOpenBeforeSend: transportBefore.websocketOpen,
    sendStartedAt,
    providerEventCountBefore: providerBefore.providerEventCount,
    lastProviderEventTypeBefore: providerBefore.lastProviderEventType,
    estimatedVisualCost: null,
    rawFrameExcluded: true as const,
  };
  const finish = (
    patch: Omit<
      GeminiArtifactFrameSendResult,
      keyof typeof baseResult
    > & Partial<Pick<GeminiArtifactFrameSendResult, keyof typeof baseResult>>,
  ): GeminiArtifactFrameSendResult => ({
    ...baseResult,
    ...patch,
  });

  if (!enabled) {
    const providerAfter = providerSnapshot();
    const transportAfter = transportSnapshot();
    const sendCompletedAt = new Date().toISOString();
    return finish({
      ok: false,
      supported: false,
      providerAcceptedFrame: false,
      websocketSendAccepted: false,
      websocketReadyStateAfter: transportAfter.websocketReadyState,
      websocketOpenAfterSend: transportAfter.websocketOpen,
      frameSendLatencyMs: elapsedMs(sendStartedAtMs),
      sendCompletedAt,
      sendDurationMs: elapsedMs(sendStartedAtMs),
      sendExceptionName: null,
      sendExceptionSafeMessage: null,
      providerEventCountAfter: providerAfter.providerEventCount,
      lastProviderEventTypeAfter: providerAfter.lastProviderEventType,
      websocketCloseCode: transportAfter.websocketCloseCode,
      websocketCloseReasonSafe: transportAfter.websocketCloseReasonSafe,
      websocketCloseWasClean: transportAfter.websocketCloseWasClean,
      websocketCloseAt: transportAfter.websocketCloseAt,
      websocketClosedAfterFrameSend: false,
      timeFromFrameSendToCloseMs: null,
      usageMetadataAfterFrame: usageMetadataObservedAfterFrame(providerAfter, providerBefore.providerEventCount),
      imageCountAfterFrame: imageCountObservedAfterFrame(providerAfter, providerBefore.providerEventCount),
      videoDurationSecondsAfterFrame: usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'video'),
      audioDurationSecondsAfterFrame: usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'audio'),
      visualResponseObserved: false,
      error: 'coreview_still_frame_feature_flag_disabled',
    });
  }

  if (websocket.readyState !== WEBSOCKET_OPEN) {
    const providerAfter = providerSnapshot();
    const transportAfter = transportSnapshot();
    return finish({
      ok: false,
      supported: true,
      providerAcceptedFrame: false,
      websocketSendAccepted: false,
      websocketReadyStateAfter: transportAfter.websocketReadyState,
      websocketOpenAfterSend: transportAfter.websocketOpen,
      frameSendLatencyMs: elapsedMs(sendStartedAtMs),
      sendCompletedAt: new Date().toISOString(),
      sendDurationMs: elapsedMs(sendStartedAtMs),
      sendExceptionName: null,
      sendExceptionSafeMessage: null,
      providerEventCountAfter: providerAfter.providerEventCount,
      lastProviderEventTypeAfter: providerAfter.lastProviderEventType,
      websocketCloseCode: transportAfter.websocketCloseCode,
      websocketCloseReasonSafe: transportAfter.websocketCloseReasonSafe,
      websocketCloseWasClean: transportAfter.websocketCloseWasClean,
      websocketCloseAt: transportAfter.websocketCloseAt,
      websocketClosedAfterFrameSend: false,
      timeFromFrameSendToCloseMs: null,
      usageMetadataAfterFrame: usageMetadataObservedAfterFrame(providerAfter, providerBefore.providerEventCount),
      imageCountAfterFrame: imageCountObservedAfterFrame(providerAfter, providerBefore.providerEventCount),
      videoDurationSecondsAfterFrame: usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'video'),
      audioDurationSecondsAfterFrame: usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'audio'),
      visualResponseObserved: false,
      error: 'gemini_live_websocket_not_open',
    });
  }

  try {
    websocket.send(JSON.stringify(buildGeminiArtifactFrameRealtimeInput(frame)));
  } catch (error) {
    const providerAfter = providerSnapshot();
    const transportAfter = transportSnapshot();
    return finish({
      ok: false,
      supported: true,
      providerAcceptedFrame: false,
      websocketSendAccepted: false,
      websocketReadyStateAfter: transportAfter.websocketReadyState,
      websocketOpenAfterSend: transportAfter.websocketOpen,
      frameSendLatencyMs: elapsedMs(sendStartedAtMs),
      sendCompletedAt: new Date().toISOString(),
      sendDurationMs: elapsedMs(sendStartedAtMs),
      sendExceptionName: error instanceof Error ? error.name : 'UnknownError',
      sendExceptionSafeMessage: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      providerEventCountAfter: providerAfter.providerEventCount,
      lastProviderEventTypeAfter: providerAfter.lastProviderEventType,
      websocketCloseCode: transportAfter.websocketCloseCode,
      websocketCloseReasonSafe: transportAfter.websocketCloseReasonSafe,
      websocketCloseWasClean: transportAfter.websocketCloseWasClean,
      websocketCloseAt: transportAfter.websocketCloseAt,
      websocketClosedAfterFrameSend: false,
      timeFromFrameSendToCloseMs: null,
      usageMetadataAfterFrame: usageMetadataObservedAfterFrame(providerAfter, providerBefore.providerEventCount),
      imageCountAfterFrame: imageCountObservedAfterFrame(providerAfter, providerBefore.providerEventCount),
      videoDurationSecondsAfterFrame: usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'video'),
      audioDurationSecondsAfterFrame: usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'audio'),
      visualResponseObserved: false,
      error: 'gemini_artifact_frame_send_failed',
    });
  }

  await waitMs(ARTIFACT_FRAME_SEND_SETTLE_MS);

  const providerAfter = providerSnapshot();
  const transportAfter = transportSnapshot();
  const websocketClosedAfterFrameSend = !transportAfter.websocketOpen;
  const closeElapsedMs = websocketClosedAfterFrameSend && transportAfter.websocketCloseAt
    ? latencyMsFromIso(sendStartedAt, transportAfter.websocketCloseAt)
    : null;
  const imageCountAfterFrame = imageCountObservedAfterFrame(providerAfter, providerBefore.providerEventCount);
  const videoDurationSecondsAfterFrame = usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'video');
  const audioDurationSecondsAfterFrame = usageDurationObservedAfterFrame(providerAfter, providerBefore.providerEventCount, 'audio');
  const visualResponseObserved = providerAfter.providerEventCount > providerBefore.providerEventCount
    && Boolean(providerAfter.lastProviderEventType && providerAfter.lastProviderEventType !== 'setupComplete');

  return finish({
    ok: !websocketClosedAfterFrameSend,
    supported: true,
    providerAcceptedFrame: !websocketClosedAfterFrameSend && typeof imageCountAfterFrame === 'number' && imageCountAfterFrame > 0,
    websocketSendAccepted: true,
    websocketReadyStateAfter: transportAfter.websocketReadyState,
    websocketOpenAfterSend: transportAfter.websocketOpen,
    frameSendLatencyMs: elapsedMs(sendStartedAtMs),
    sendCompletedAt: new Date().toISOString(),
    sendDurationMs: elapsedMs(sendStartedAtMs),
    sendExceptionName: null,
    sendExceptionSafeMessage: null,
    providerEventCountAfter: providerAfter.providerEventCount,
    lastProviderEventTypeAfter: providerAfter.lastProviderEventType,
    websocketCloseCode: transportAfter.websocketCloseCode,
    websocketCloseReasonSafe: transportAfter.websocketCloseReasonSafe,
    websocketCloseWasClean: transportAfter.websocketCloseWasClean,
    websocketCloseAt: transportAfter.websocketCloseAt,
    websocketClosedAfterFrameSend,
    timeFromFrameSendToCloseMs: closeElapsedMs,
    usageMetadataAfterFrame: usageMetadataObservedAfterFrame(providerAfter, providerBefore.providerEventCount),
    imageCountAfterFrame,
    videoDurationSecondsAfterFrame,
    audioDurationSecondsAfterFrame,
    visualResponseObserved,
    error: websocketClosedAfterFrameSend ? 'frame_send_closed_gemini_websocket' : null,
  });
}

export function isGeminiSetupCompleteMessage(event: unknown): boolean {
  if (!isRecord(event)) {
    return false;
  }

  for (const key of ZERO_FIELD_GEMINI_PROVIDER_EVENT_KEYS) {
    if (key in event && isRecord(event[key])) {
      return true;
    }
  }

  return false;
}

export function isRelayableGeminiProviderEvent(event: unknown): event is Record<string, unknown> {
  if (!isRecord(event) || Object.keys(event).length === 0) {
    return false;
  }

  for (const key of RELAYABLE_GEMINI_PROVIDER_EVENT_KEYS) {
    if (!(key in event)) {
      continue;
    }

    if (ZERO_FIELD_GEMINI_PROVIDER_EVENT_KEYS.has(key)) {
      if (isRecord(event[key])) {
        return true;
      }
      continue;
    }

    if (!isSemanticallyEmptyValue(event[key])) {
      return true;
    }
  }

  return false;
}

export function isGeminiServerInterruptedEvent(event: unknown): boolean {
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  return isRecord(serverContent) && serverContent.interrupted === true;
}

export function assembleGeminiOutputTranscription(
  currentText: string | null | undefined,
  incomingText: string | null | undefined,
  previousFragment: string | null | undefined = null,
): GeminiOutputTranscriptAssemblyResult {
  const current = normalizeGeminiTranscriptText(currentText);
  const incoming = normalizeGeminiTranscriptText(incomingText);
  const previous = normalizeGeminiTranscriptText(previousFragment);
  if (!incoming) {
    return { text: current, changed: false, decision: 'empty_fragment', overlapTokenCount: 0 };
  }
  if (!current) {
    return { text: incoming, changed: true, decision: 'seed', overlapTokenCount: 0 };
  }
  if (previous && comparableGeminiTranscriptText(previous) === comparableGeminiTranscriptText(incoming)) {
    return { text: current, changed: false, decision: 'exact_adjacent_replay', overlapTokenCount: 0 };
  }

  const comparableCurrent = comparableGeminiTranscriptText(current);
  const comparableIncoming = comparableGeminiTranscriptText(incoming);
  if (comparableCurrent === comparableIncoming) {
    return { text: current, changed: false, decision: 'cumulative_snapshot', overlapTokenCount: 0 };
  }
  if (startsWithGeminiTranscriptBoundary(comparableIncoming, comparableCurrent)) {
    return {
      text: incoming,
      changed: incoming !== current,
      decision: 'cumulative_snapshot',
      overlapTokenCount: comparableGeminiTranscriptTokens(current).length,
    };
  }
  if (
    previous
    && startsWithGeminiTranscriptBoundary(comparableGeminiTranscriptText(previous), comparableIncoming)
    && startsWithGeminiTranscriptBoundary(comparableCurrent, comparableGeminiTranscriptText(previous))
  ) {
    return { text: current, changed: false, decision: 'stale_adjacent_snapshot', overlapTokenCount: 0 };
  }

  const currentTokens = current.split(' ');
  const incomingTokens = incoming.split(' ');
  const currentComparableTokens = comparableGeminiTranscriptTokens(current);
  const incomingComparableTokens = comparableGeminiTranscriptTokens(incoming);
  const maxOverlap = Math.min(currentComparableTokens.length, incomingComparableTokens.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const currentSuffix = currentComparableTokens.slice(-overlap);
    const incomingPrefix = incomingComparableTokens.slice(0, overlap);
    if (!currentSuffix.every((token, index) => token === incomingPrefix[index])) {
      continue;
    }
    // A whole incoming phrase appearing at the end is ambiguous: it can be an
    // intentional later repeat. Only the exact adjacent-fragment check above
    // is allowed to discard it wholesale.
    if (overlap === incomingComparableTokens.length) {
      break;
    }
    const merged = [...currentTokens, ...incomingTokens.slice(overlap)].join(' ');
    return {
      text: merged,
      changed: merged !== current,
      decision: 'suffix_prefix_overlap',
      overlapTokenCount: overlap,
    };
  }

  const appended = joinGeminiTranscriptFragments(current, incoming);
  return {
    text: appended,
    changed: appended !== current,
    decision: 'delta_append',
    overlapTokenCount: 0,
  };
}

export function detectGeminiSameResponseRepeatedIntent(
  assembledRawProviderOutputTranscription: string,
): GeminiRepeatedIntentDetection {
  const questions = extractCompletedGeminiQuestions(assembledRawProviderOutputTranscription);
  if (questions.length < 2) {
    return {
      detected: false,
      questionCount: questions.length,
      firstQuestionFingerprint: questions[0] ? telemetryTextFingerprint(questions[0]) : null,
      secondQuestionFingerprint: null,
      similarityScore: 0,
      matchedSignals: [],
    };
  }

  const firstQuestion = questions.at(-2) ?? '';
  const secondQuestion = questions.at(-1) ?? '';
  const firstTokens = canonicalGeminiQuestionTokens(firstQuestion);
  const secondTokens = canonicalGeminiQuestionTokens(secondQuestion);
  const firstSet = new Set(firstTokens);
  const secondSet = new Set(secondTokens);
  const intersectionCount = [...firstSet].filter((token) => secondSet.has(token)).length;
  const minimumSize = Math.max(1, Math.min(firstSet.size, secondSet.size));
  const unionSize = Math.max(1, new Set([...firstSet, ...secondSet]).size);
  const containment = intersectionCount / minimumSize;
  const jaccard = intersectionCount / unionSize;
  const sameQuestionOpener = firstTokens[0] !== undefined && firstTokens[0] === secondTokens[0];
  const sharedTemporalFrame = hasOrderedTokenPair(firstTokens, 'right', 'now')
    && hasOrderedTokenPair(secondTokens, 'right', 'now');
  const sharedIntentConcept = ['decision_factor', 'architecture', 'priority', 'goal']
    .some((token) => firstSet.has(token) && secondSet.has(token));
  const exactMatch = comparableGeminiTranscriptText(firstQuestion) === comparableGeminiTranscriptText(secondQuestion);
  const similarityScore = Math.min(1, Math.max(
    jaccard,
    containment * 0.78
      + (sameQuestionOpener ? 0.08 : 0)
      + (sharedTemporalFrame ? 0.07 : 0)
      + (sharedIntentConcept ? 0.07 : 0),
  ));
  const detected = exactMatch
    || containment >= 0.72
    || (
      sameQuestionOpener
      && containment >= 0.5
      && (sharedTemporalFrame || sharedIntentConcept)
      && similarityScore >= 0.58
    );
  const matchedSignals = [
    exactMatch ? 'exact_question' : null,
    sameQuestionOpener ? 'same_question_opener' : null,
    sharedTemporalFrame ? 'shared_right_now_frame' : null,
    sharedIntentConcept ? 'shared_intent_concept' : null,
    containment >= 0.5 ? 'token_containment' : null,
  ].filter((signal): signal is string => Boolean(signal));

  return {
    detected,
    questionCount: questions.length,
    firstQuestionFingerprint: telemetryTextFingerprint(firstQuestion),
    secondQuestionFingerprint: telemetryTextFingerprint(secondQuestion),
    similarityScore: Math.round(similarityScore * 1_000) / 1_000,
    matchedSignals,
  };
}

function normalizeGeminiTranscriptText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function comparableGeminiTranscriptText(value: string): string {
  return normalizeGeminiTranscriptText(value).toLocaleLowerCase();
}

function comparableGeminiTranscriptTokens(value: string): string[] {
  return normalizeGeminiTranscriptText(value)
    .split(' ')
    .map((token) => token.toLocaleLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);
}

function startsWithGeminiTranscriptBoundary(value: string, prefix: string): boolean {
  if (!prefix || !value.startsWith(prefix)) {
    return false;
  }
  const boundary = value[prefix.length];
  return boundary === undefined || /\s|[.,!?;:]/.test(boundary);
}

function joinGeminiTranscriptFragments(current: string, incoming: string): string {
  return /^[,.;:!?)]/.test(incoming)
    ? `${current}${incoming}`
    : `${current} ${incoming}`;
}

function extractCompletedGeminiQuestions(value: string): string[] {
  const pieces = value.split('?');
  const questions: string[] = [];
  for (let index = 0; index < pieces.length - 1; index += 1) {
    const piece = normalizeGeminiTranscriptText(pieces[index]);
    const lastSentenceBoundary = Math.max(piece.lastIndexOf('.'), piece.lastIndexOf('!'));
    const clause = normalizeGeminiTranscriptText(piece.slice(lastSentenceBoundary + 1));
    if (clause.split(' ').length >= 2) {
      questions.push(`${clause}?`);
    }
  }
  return questions;
}

const GEMINI_QUESTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'between', 'do', 'does', 'for', 'from',
  'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'we', 'you', 'your',
]);

function canonicalGeminiQuestionTokens(value: string): string[] {
  const rawTokens = comparableGeminiTranscriptText(value)
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const canonical = rawTokens.map((token) => {
    if (['what', 'whats', 'which'].includes(token)) return 'what';
    if (['blocker', 'blockers', 'consideration', 'considerations', 'constraint', 'constraints', 'concern', 'concerns', 'factor', 'factors', 'issue', 'issues', 'tradeoff', 'tradeoffs'].includes(token)) return 'decision_factor';
    if (['architectural', 'architecturally', 'architecture', 'control', 'execution', 'layer', 'layers', 'plane', 'system', 'systems'].includes(token)) return 'architecture';
    if (['important', 'importance', 'priority', 'priorities'].includes(token)) return 'priority';
    if (['aim', 'goal', 'objective', 'outcome'].includes(token)) return 'goal';
    return token;
  });
  return [...new Set(canonical.filter((token) => !GEMINI_QUESTION_STOP_WORDS.has(token)))];
}

function hasOrderedTokenPair(tokens: string[], first: string, second: string): boolean {
  return tokens.some((token, index) => token === first && tokens[index + 1] === second);
}

export function readGeminiConfiguredToolNames(setup: Record<string, unknown>): string[] {
  const tools = Array.isArray(setup.tools) ? setup.tools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    if ('googleSearch' in tool || 'google_search' in tool) {
      names.add('google_search');
    }
    const declarations = arrayFromAnyKey(tool, 'functionDeclarations', 'function_declarations') ?? [];
    for (const declaration of declarations) {
      if (!isRecord(declaration)) {
        continue;
      }
      const name = stringFromAnyKey(declaration, 'name');
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

export function readGeminiToolCallsFromEvent(event: unknown): GeminiBrowserLiveDogfoodToolCallSummary[] {
  const toolCall = recordFromAnyKey(event, 'toolCall', 'tool_call');
  const functionCalls = [
    ...(arrayFromAnyKey(toolCall, 'functionCalls', 'function_calls') ?? []),
    ...readGeminiNestedFunctionCallsFromModelTurn(event),
  ];
  const calls: GeminiBrowserLiveDogfoodToolCallSummary[] = [];
  for (const functionCall of functionCalls) {
    if (!isRecord(functionCall)) {
      continue;
    }
    const args = readGeminiFunctionCallArgs(functionCall);
    const name = stringFromAnyKey(functionCall, 'name');
    const telemetryArgs = redactToolCallArgsForTelemetry(name, args);
    calls.push({
      id: stringFromAnyKey(functionCall, 'id'),
      name,
      args: telemetryArgs,
      argsPreview: previewJson(telemetryArgs),
    });
  }
  return calls;
}

export function categorizeGeminiProviderEvent(event: unknown): GeminiProviderEventCategory[] {
  if (!isRecord(event)) {
    return [];
  }

  const categories = new Set<GeminiProviderEventCategory>();
  if (isGeminiSetupCompleteMessage(event)) {
    categories.add('setupComplete');
  }
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  if (isRecord(serverContent)) {
    categories.add('serverContent');
    if (hasTranscriptionText(event, 'inputTranscription', 'input_transcription')) {
      categories.add('inputTranscription');
    }
    if (hasTranscriptionText(event, 'outputTranscription', 'output_transcription')) {
      categories.add('outputTranscription');
    }
    const modelTurn = recordFromAnyKey(serverContent, 'modelTurn', 'model_turn');
    const parts = arrayFromAnyKey(modelTurn, 'parts') ?? [];
    if (parts.some(isGeminiModelTurnAudioPart)) {
      categories.add('modelTurnAudio');
    }
    if (parts.some((part) => isRecord(part) && typeof part.text === 'string' && part.text.trim().length > 0)) {
      categories.add('modelTurnText');
    }
    if (parts.some((part) => isRecord(part) && isRecord(recordFromAnyKey(part, 'functionCall', 'function_call')))) {
      categories.add('toolCall');
    }
  }
  if (readGeminiToolCallsFromEvent(event).length) {
    categories.add('toolCall');
  }
  if (readGeminiToolCancellationIds(event).length) {
    categories.add('toolCallCancellation');
  }
  if (isRecord(recordFromAnyKey(event, 'goAway', 'go_away'))) {
    categories.add('goAway');
  }
  if (isRecord(recordFromAnyKey(event, 'sessionResumptionUpdate', 'session_resumption_update'))) {
    categories.add('sessionResumptionUpdate');
  }
  if (isRecord(recordFromAnyKey(event, 'usageMetadata', 'usage_metadata'))) {
    categories.add('usageMetadata');
  }
  if (isRecord(recordFromAnyKey(event, 'error'))) {
    categories.add('error');
  }

  return [...categories];
}

function readGeminiSessionResumptionUpdate(event: unknown): {
  resumable: boolean;
  handle: string | null;
} | null {
  const update = recordFromAnyKey(event, 'sessionResumptionUpdate', 'session_resumption_update');
  if (!update) {
    return null;
  }
  const rawHandle = stringFromAnyKey(update, 'newHandle', 'new_handle');
  return {
    resumable: update.resumable === true,
    handle: rawHandle && rawHandle.trim() ? rawHandle : null,
  };
}

export function classifyGeminiProviderEventForRelay(event: unknown): GeminiProviderEventRelayClassification {
  const categories = categorizeGeminiProviderEvent(event);
  const result = (
    classification: GeminiRelayClassification,
    priority: GeminiRelayPriority,
    reason: string,
  ): GeminiProviderEventRelayClassification => ({
    classification,
    priority,
    reason,
    categories,
    shouldRelay: classification === 'critical',
  });

  if (!isRelayableGeminiProviderEvent(event)) {
    return result('skip', 'local_only', 'not_relayable_provider_message');
  }

  if (categories.includes('toolCall')) {
    return result('critical', 'immediate', 'tool_call_requires_backend_execution');
  }
  if (categories.includes('toolCallCancellation')) {
    return result('critical', 'immediate', 'tool_call_cancellation_updates_suppression_ledger');
  }
  if (categories.includes('inputTranscription')) {
    return result('critical', 'immediate', 'input_transcription_updates_public_user_transcript');
  }
  if (categories.includes('outputTranscription')) {
    return result('critical', 'immediate', 'output_transcription_updates_public_assistant_transcript');
  }
  if (categories.includes('modelTurnText')) {
    return result('critical', 'immediate', 'model_turn_text_updates_public_assistant_transcript');
  }
  if (isGeminiServerInterruptedEvent(event)) {
    return result('critical', 'immediate', 'interruption_updates_turn_and_playback_continuity');
  }
  if (hasGeminiServerContentTurnBoundary(event)) {
    return result('critical', 'immediate', 'turn_boundary_updates_public_turn_state');
  }
  if (categories.includes('error')) {
    return result('critical', 'immediate', 'provider_error_updates_public_diagnostics');
  }
  if (categories.includes('goAway')) {
    return result('critical', 'immediate', 'go_away_updates_session_lifecycle_diagnostics');
  }
  if (categories.includes('setupComplete')) {
    return result('critical', 'immediate', 'setup_complete_confirms_provider_handshake');
  }
  if (categories.includes('usageMetadata')) {
    return result('summary', 'local_summary', 'usage_metadata_is_counted_locally');
  }
  if (categories.includes('sessionResumptionUpdate')) {
    return result('skip', 'local_only', 'session_resumption_update_is_browser_local_until_resume_is_used');
  }
  if (isPureGeminiOutputAudioEvent(event)) {
    return result('skip', 'local_only', 'pure_output_audio_is_played_locally');
  }
  if (categories.includes('serverContent')) {
    return result('summary', 'local_summary', 'server_content_has_no_public_continuity_fields');
  }

  return result('summary', 'local_summary', 'provider_message_has_no_backend_continuity_effect');
}

export function createGeminiProviderEventCategoryCounts(): GeminiProviderEventCategoryCounts {
  return Object.fromEntries(
    GEMINI_PROVIDER_EVENT_CATEGORIES.map((category) => [category, { count: 0, lastAt: null }]),
  ) as GeminiProviderEventCategoryCounts;
}

function isAssistantOutputCategories(categories: GeminiProviderEventCategory[]): boolean {
  return categories.includes('outputTranscription')
    || categories.includes('modelTurnAudio')
    || categories.includes('modelTurnText');
}

export function createGeminiRelayClassificationCounts(): GeminiRelayClassificationCounts {
  return {
    critical: { count: 0, lastAt: null },
    summary: { count: 0, lastAt: null },
    skip: { count: 0, lastAt: null },
  };
}

export function recordGeminiProviderEventTelemetry(
  counts: GeminiProviderEventCategoryCounts,
  relayCounts: GeminiRelayClassificationCounts,
  event: unknown,
  timestamp = new Date().toISOString(),
  receiveMetadata: GeminiProviderReceiveMetadata | null = null,
): GeminiBrowserLiveProviderEventTelemetry {
  const categories = categorizeGeminiProviderEvent(event);
  const relayClassification = classifyGeminiProviderEventForRelay(event);
  for (const category of categories) {
    counts[category] = {
      count: counts[category].count + 1,
      lastAt: timestamp,
    };
  }
  relayCounts[relayClassification.classification] = {
    count: relayCounts[relayClassification.classification].count + 1,
    lastAt: timestamp,
  };
  return {
    timestamp,
    correlationId: receiveMetadata?.relayCorrelationId ?? geminiProviderEventCorrelationId(event, 0),
    responseId: readGeminiResponseId(event),
    providerReceiveSequence: receiveMetadata?.providerReceiveSequence ?? null,
    providerConnectionEpoch: receiveMetadata?.providerConnectionEpoch ?? null,
    providerReceivedAt: receiveMetadata?.providerReceivedAt ?? null,
    primaryCategory: categories[0] ?? 'unknown',
    categories,
    categoryCounts: cloneGeminiProviderEventCategoryCounts(counts),
    usageMetadata: isRecord(event)
      ? buildGeminiUsageMetadataTelemetry(recordFromAnyKey(event, 'usageMetadata', 'usage_metadata'))
      : null,
    relayClassification: relayClassification.classification,
    relayClassificationReason: relayClassification.reason,
    relayShouldRelay: relayClassification.shouldRelay,
    relayClassificationCounts: cloneGeminiRelayClassificationCounts(relayCounts),
    toolCallIds: readGeminiToolCallsFromEvent(event).map((toolCall) => toolCall.id).filter((id): id is string => Boolean(id)),
    toolCancellationIds: readGeminiToolCancellationIds(event),
    outputAudioChunkCount: isRecord(event) ? readGeminiOutputAudioChunks(event).length : 0,
    hasInputTranscriptionText: hasTranscriptionText(event, 'inputTranscription', 'input_transcription'),
    hasOutputTranscriptionText: hasTranscriptionText(event, 'outputTranscription', 'output_transcription'),
    inputTranscriptionTextPreview: readTranscriptionTextPreview(event, 'inputTranscription', 'input_transcription'),
    outputTranscriptionTextPreview: readTranscriptionTextPreview(event, 'outputTranscription', 'output_transcription'),
    serverContentInterrupted: isGeminiServerInterruptedEvent(event),
    generationComplete: hasGeminiServerContentFlag(event, 'generationComplete', 'generation_complete'),
    turnComplete: hasGeminiServerContentFlag(event, 'turnComplete', 'turn_complete'),
  };
}

function buildGeminiProviderReceiveMetadata(
  event: unknown,
  providerReceiveSequence: number,
  providerReceivedAt = new Date().toISOString(),
): GeminiProviderReceiveMetadata {
  const categories = categorizeGeminiProviderEvent(event);
  return {
    providerReceiveSequence,
    providerReceivedAt,
    relayCorrelationId: geminiProviderEventCorrelationId(event, providerReceiveSequence),
    providerPrimaryCategory: categories[0] ?? 'unknown',
    providerCategories: categories,
  };
}

function shouldUseOrderedRelayLane(classification: GeminiProviderEventRelayClassification): boolean {
  if (!classification.shouldRelay) {
    return false;
  }
  return classification.classification === 'critical';
}

function isRawAssistantOutputTranscriptPartial(
  event: unknown,
  categories = categorizeGeminiProviderEvent(event),
): boolean {
  return categories.includes('outputTranscription')
    && !categories.includes('inputTranscription')
    && !categories.includes('toolCall')
    && !categories.includes('toolCallCancellation')
    && !categories.includes('modelTurnText')
    && !categories.includes('error')
    && !categories.includes('goAway')
    && !hasGeminiServerContentTurnBoundary(event)
    && !isGeminiServerInterruptedEvent(event);
}

function shouldAdvanceAssistantTranscriptPartialSegment(
  event: unknown,
  categories = categorizeGeminiProviderEvent(event),
): boolean {
  return categories.includes('inputTranscription')
    || categories.includes('toolCall')
    || categories.includes('toolCallCancellation')
    || categories.includes('modelTurnText')
    || categories.includes('error')
    || categories.includes('goAway')
    || hasGeminiServerContentTurnBoundary(event)
    || isGeminiServerInterruptedEvent(event);
}

function isFinalTranscriptRelayEvent(
  event: unknown,
): boolean {
  return hasGeminiServerContentTurnBoundary(event);
}

function isNonDroppableCriticalRelayEvent(
  classification: GeminiProviderEventRelayClassification,
  event: unknown,
  categories = categorizeGeminiProviderEvent(event),
): boolean {
  return classification.classification === 'critical'
    && !isRawAssistantOutputTranscriptPartial(event, categories)
    && !isFinalTranscriptRelayEvent(event);
}

export function pcm16Base64FromFloat32(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = INPUT_AUDIO_RATE_HZ,
): string {
  if (!input.length || sourceSampleRate <= 0 || targetSampleRate <= 0) {
    return '';
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const pcm = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.min(input.length - 1, Math.floor(index * ratio));
    const sample = Math.max(-1, Math.min(1, input[sourceIndex] ?? 0));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return bytesToBase64(new Uint8Array(pcm.buffer));
}

async function startBrowserDogfoodSession(
  fetchFn: FetchLike,
  options: GeminiBrowserLiveDogfoodConnectOptions,
): Promise<GeminiLangSmithTraceContext & {
  sessionId: string;
  websocketUrl: string;
  streamUrl: string;
  relayUrl: string | null;
  relayTargetPath: string | null;
  disconnectUrl: string | null;
  publicEventBoundary: string | null;
  transport: string | null;
  setup: Record<string, unknown>;
  audioCaptureEnabled: boolean;
  continuationBootstrapUrl: string | null;
  providerActivationUrl: string | null;
  providerConnectionEpoch: number;
  providerExpiresAt: string | null;
  providerCleanupToken: string | null;
  providerCleanupExpiresAt: string | null;
  cleanupProviderAdmissionId: string | null;
  syntheticTest: GeminiSyntheticTestContext | null;
  syntheticTraceFault: GeminiVoiceLabTraceFaultReceipt | null;
}> {
  const response = await fetchFn('/api/sophia/voice/dogfood/gemini/browser-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: options.sessionId }),
  });

  if (!response.ok) {
    throw new Error(await formatDogfoodHttpError(response, 'Gemini browser dogfood session failed'));
  }

  const payload = (await response.json()) as BrowserSessionPayload;
  return readBrowserSessionPayload(payload, 'Gemini browser dogfood session response');
}

type GeminiProviderCleanupAuthority = {
  token: string;
  cleanupExpiresAt: string;
  cleanupProviderAdmissionId: string;
};

function decodeGeminiProviderCleanupPayload(token: string): Record<string, unknown> {
  const [encodedPayload, encodedSignature] = token.split('.');
  if (!encodedPayload || !encodedSignature) {
    throw new Error('Gemini provider cleanup token was malformed.');
  }
  try {
    const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      base64ToBytes(padded),
    );
    const payload = JSON.parse(decoded) as unknown;
    if (!isRecord(payload)) throw new Error('payload');
    return payload;
  } catch {
    throw new Error('Gemini provider cleanup token was malformed.');
  }
}

function readGeminiProviderCleanupAuthority(
  payload: BrowserSessionPayload,
  sessionId: string,
  syntheticTest: GeminiSyntheticTestContext | null,
  label: string,
): GeminiProviderCleanupAuthority | null {
  const token = payload.provider_cleanup_token;
  const cleanupExpiresAt = payload.provider_cleanup_expires_at;
  if (syntheticTest === null) {
    if (token !== undefined || cleanupExpiresAt !== undefined) {
      throw new Error(`${label} exposed provider cleanup authority outside the synthetic lane.`);
    }
    return null;
  }
  if (
    typeof token !== 'string'
    || !isOpaqueVoiceLabProviderCleanupToken(token)
    || !isCanonicalGeminiUtcMillis(cleanupExpiresAt)
  ) {
    throw new Error(`${label} provider cleanup authority was malformed.`);
  }
  const claims = decodeGeminiProviderCleanupPayload(token);
  const allowedKeys = new Set([
    'v',
    'iss',
    'aud',
    'sub',
    'principal_id',
    'test_run_id',
    'scenario_id',
    'scenario_version',
    'voice_lab_run_id_sha256',
    'browser_worker_id_sha256',
    'browser_lease_epoch',
    'browser_context_id_sha256',
    'synthetic',
    'environment',
    'retention_hours',
    'cleanup_obligation_id',
    'provider_expires_at',
    'retention_expires_at',
    'cleanup_expires_at',
    'allowed_ops',
    'expected_deployment',
    'provider_session_id',
    'cleanup_provider_admission_id',
    'iat',
    'nbf',
    'exp',
    'jti',
  ]);
  const deployment = claims.expected_deployment;
  const providerDeadlineMs = Date.parse(syntheticTest.provider_expires_at);
  const retentionDeadlineMs = typeof claims.retention_expires_at === 'string'
    ? Date.parse(claims.retention_expires_at)
    : Number.NaN;
  const cleanupDeadlineMs = Date.parse(cleanupExpiresAt);
  const expectedCleanupDeadlineMs = Math.min(
    retentionDeadlineMs,
    providerDeadlineMs + 600_000,
  );
  const safeOptional = (value: unknown) => (
    value === undefined
    || (typeof value === 'string' && GEMINI_SYNTHETIC_SAFE_ID.test(value))
  );
  const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    Object.keys(claims).some((key) => !allowedKeys.has(key))
    || claims.v !== 1
    || claims.iss !== 'sophia-voice-gateway'
    || claims.aud !== 'sophia-voice-lab-provider-cleanup'
    || claims.synthetic !== true
    || claims.sub !== syntheticTest.principal_id
    || claims.principal_id !== syntheticTest.principal_id
    || claims.test_run_id !== syntheticTest.test_run_id
    || claims.scenario_id !== syntheticTest.scenario_id
    || claims.scenario_version !== syntheticTest.scenario_version
    || claims.voice_lab_run_id_sha256 !== syntheticTest.voice_lab_run_id_sha256
    || claims.browser_worker_id_sha256 !== syntheticTest.browser_worker_id_sha256
    || claims.browser_lease_epoch !== syntheticTest.browser_lease_epoch
    || claims.browser_context_id_sha256 !== syntheticTest.browser_context_id_sha256
    || claims.environment !== syntheticTest.environment
    || claims.retention_hours !== syntheticTest.retention_hours
    || claims.cleanup_obligation_id !== syntheticTest.cleanup_obligation_id
    || claims.provider_expires_at !== syntheticTest.provider_expires_at
    || claims.cleanup_expires_at !== cleanupExpiresAt
    || claims.provider_session_id !== sessionId
    || !safeOptional(claims.scenario_id)
    || !safeOptional(claims.scenario_version)
    || !Array.isArray(claims.allowed_ops)
    || claims.allowed_ops.length !== 1
    || claims.allowed_ops[0] !== 'provider:settle'
    || !isRecord(deployment)
    || Object.keys(deployment).sort().join(',') !== 'backend,frontend,voice'
    || !['frontend', 'backend', 'voice'].every(
      (key) => typeof deployment[key] === 'string' && /^[a-f0-9]{40}$/.test(deployment[key]),
    )
    || typeof claims.cleanup_provider_admission_id !== 'string'
    || !uuid4.test(claims.cleanup_provider_admission_id)
    || typeof claims.jti !== 'string'
    || !uuid4.test(claims.jti)
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.nbf)
    || !Number.isSafeInteger(claims.exp)
    || claims.nbf !== claims.iat
    || Number(claims.exp) <= Number(claims.iat)
    || Number(claims.exp) !== Math.floor(cleanupDeadlineMs / 1000)
    || !isCanonicalGeminiUtcMillis(claims.retention_expires_at)
    || !Number.isFinite(providerDeadlineMs)
    || !Number.isFinite(retentionDeadlineMs)
    || !Number.isFinite(cleanupDeadlineMs)
    || retentionDeadlineMs < providerDeadlineMs
    || cleanupDeadlineMs !== expectedCleanupDeadlineMs
    || cleanupDeadlineMs <= Date.now()
  ) {
    throw new Error(`${label} provider cleanup authority did not match the authenticated run.`);
  }
  return {
    token,
    cleanupExpiresAt,
    cleanupProviderAdmissionId: claims.cleanup_provider_admission_id,
  };
}

function readBrowserSessionPayload(
  payload: BrowserSessionPayload,
  label: string,
): GeminiLangSmithTraceContext & {
  sessionId: string;
  websocketUrl: string;
  streamUrl: string;
  relayUrl: string | null;
  relayTargetPath: string | null;
  disconnectUrl: string | null;
  publicEventBoundary: string | null;
  transport: string | null;
  setup: Record<string, unknown>;
  audioCaptureEnabled: boolean;
  continuationBootstrapUrl: string | null;
  providerActivationUrl: string | null;
  providerConnectionEpoch: number;
  providerExpiresAt: string | null;
  providerCleanupToken: string | null;
  providerCleanupExpiresAt: string | null;
  cleanupProviderAdmissionId: string | null;
  syntheticTest: GeminiSyntheticTestContext | null;
  syntheticTraceFault: GeminiVoiceLabTraceFaultReceipt | null;
} {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const ephemeralCredential = readEphemeralToken(payload.ephemeral_token);
  const token = ephemeralCredential?.value ?? null;
  const baseWebSocketUrl = typeof payload.websocket_url === 'string'
    ? payload.websocket_url
    : DEFAULT_GEMINI_LIVE_WEBSOCKET_URL;
  const setup = isRecord(payload.setup) ? payload.setup : null;
  const streamUrl = typeof payload.stream_url === 'string'
    ? payload.stream_url
    : typeof payload.event_stream_url === 'string'
      ? payload.event_stream_url
      : null;
  const relayUrl = typeof payload.provider_event_relay_url === 'string' ? payload.provider_event_relay_url : null;
  const relayTargetPath = relayUrl && isBrowserApiPath(relayUrl) ? relayUrl : null;
  const disconnectUrl = typeof payload.disconnect_url === 'string' && isBrowserApiPath(payload.disconnect_url)
    ? payload.disconnect_url
    : null;
  const publicEventBoundary = typeof payload.public_event_boundary === 'string' ? payload.public_event_boundary : null;
  const transport = typeof payload.transport === 'string' ? payload.transport : null;
  const audioCaptureEnabled = payload.audio_capture_enabled === true;
  const continuationBootstrapUrl = (
    typeof payload.continuation_bootstrap_url === 'string'
    && isBrowserApiPath(payload.continuation_bootstrap_url)
  ) ? payload.continuation_bootstrap_url : null;
  const providerActivationUrl = (
    typeof payload.provider_activation_url === 'string'
    && isBrowserApiPath(payload.provider_activation_url)
  ) ? payload.provider_activation_url : null;
  const providerConnectionEpoch = (
    typeof payload.provider_connection_epoch === 'number'
    && Number.isInteger(payload.provider_connection_epoch)
    && payload.provider_connection_epoch > 0
  ) ? payload.provider_connection_epoch : 1;
  const syntheticTest = readGeminiSyntheticTestContext(payload.synthetic_test, label);
  const providerCleanup = sessionId
    ? readGeminiProviderCleanupAuthority(payload, sessionId, syntheticTest, label)
    : null;
  const providerExpiresAt = ephemeralCredential?.expireTime ?? null;
  const syntheticTraceFault = readGeminiVoiceLabTraceFaultReceipt(
    payload.trace_fault,
    syntheticTest,
    `${label} trace_fault`,
    'applied',
  );
  const langsmithTrace = readGeminiLangSmithTraceContext(payload, syntheticTraceFault);

  if (!sessionId) {
    throw new Error(`${label} omitted session_id.`);
  }
  if (!token) {
    throw new Error(`${label} omitted the ephemeral token.`);
  }
  if (!setup) {
    throw new Error(`${label} omitted setup.`);
  }
  if (!streamUrl) {
    throw new Error(`${label} omitted stream_url.`);
  }
  if (
    syntheticTest !== null
    && providerExpiresAt !== syntheticTest.provider_expires_at
  ) {
    throw new Error(`${label} provider deadline did not match the authenticated run.`);
  }

  return {
    sessionId,
    websocketUrl: buildGeminiLiveWebSocketUrl(baseWebSocketUrl, token),
    streamUrl,
    relayUrl,
    relayTargetPath,
    disconnectUrl,
    publicEventBoundary,
    transport,
    setup,
    audioCaptureEnabled,
    continuationBootstrapUrl,
    providerActivationUrl,
    providerConnectionEpoch,
    providerExpiresAt,
    providerCleanupToken: providerCleanup?.token ?? null,
    providerCleanupExpiresAt: providerCleanup?.cleanupExpiresAt ?? null,
    cleanupProviderAdmissionId: providerCleanup?.cleanupProviderAdmissionId ?? null,
    syntheticTest,
    syntheticTraceFault,
    ...langsmithTrace,
  };
}

const GEMINI_SYNTHETIC_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GEMINI_CLEANUP_OBLIGATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GEMINI_SHA256 = /^[a-f0-9]{64}$/;

function isCanonicalGeminiUtcMillis(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function readGeminiSyntheticTestContext(
  value: unknown,
  label = 'Gemini browser session',
): GeminiSyntheticTestContext | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error(`${label} synthetic_test was malformed.`);
  }
  const allowed = new Set([
    'synthetic',
    'principal_id',
    'test_run_id',
    'scenario_id',
    'scenario_version',
    'voice_lab_run_id_sha256',
    'browser_worker_id_sha256',
    'browser_lease_epoch',
    'browser_context_id_sha256',
    'environment',
    'retention_hours',
    'cleanup_obligation_id',
    'provider_expires_at',
  ]);
  const optionalSafe = (candidate: unknown) => (
    candidate === undefined
    || (typeof candidate === 'string' && GEMINI_SYNTHETIC_SAFE_ID.test(candidate))
  );
  const d02Ownership = [
    value.voice_lab_run_id_sha256,
    value.browser_worker_id_sha256,
    value.browser_lease_epoch,
    value.browser_context_id_sha256,
  ];
  const d02OwnershipCount = d02Ownership.filter((candidate) => candidate !== undefined).length;
  const d02OwnershipValid = value.scenario_id === 'V-D02'
    ? d02OwnershipCount === 4
      && GEMINI_SHA256.test(String(value.voice_lab_run_id_sha256 ?? ''))
      && GEMINI_SHA256.test(String(value.browser_worker_id_sha256 ?? ''))
      && Number.isSafeInteger(value.browser_lease_epoch)
      && Number(value.browser_lease_epoch) > 0
      && GEMINI_SHA256.test(String(value.browser_context_id_sha256 ?? ''))
    : d02OwnershipCount === 0;
  if (
    value.synthetic !== true
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.principal_id !== 'string'
    || !GEMINI_SYNTHETIC_SAFE_ID.test(value.principal_id)
    || typeof value.test_run_id !== 'string'
    || !GEMINI_SYNTHETIC_SAFE_ID.test(value.test_run_id)
    || typeof value.environment !== 'string'
    || !GEMINI_SYNTHETIC_SAFE_ID.test(value.environment)
    || !Number.isSafeInteger(value.retention_hours)
    || Number(value.retention_hours) < 1
    || Number(value.retention_hours) > 168
    || typeof value.cleanup_obligation_id !== 'string'
    || !GEMINI_CLEANUP_OBLIGATION_ID.test(value.cleanup_obligation_id)
    || !isCanonicalGeminiUtcMillis(value.provider_expires_at)
    || !optionalSafe(value.scenario_id)
    || !optionalSafe(value.scenario_version)
    || !d02OwnershipValid
  ) {
    throw new Error(`${label} synthetic_test was malformed.`);
  }
  return {
    synthetic: true,
    principal_id: value.principal_id,
    test_run_id: value.test_run_id,
    ...(typeof value.scenario_id === 'string' ? { scenario_id: value.scenario_id } : {}),
    ...(typeof value.scenario_version === 'string' ? { scenario_version: value.scenario_version } : {}),
    ...(value.scenario_id === 'V-D02' ? {
      voice_lab_run_id_sha256: String(value.voice_lab_run_id_sha256),
      browser_worker_id_sha256: String(value.browser_worker_id_sha256),
      browser_lease_epoch: Number(value.browser_lease_epoch),
      browser_context_id_sha256: String(value.browser_context_id_sha256),
    } : {}),
    environment: value.environment,
    retention_hours: Number(value.retention_hours),
    cleanup_obligation_id: value.cleanup_obligation_id,
    provider_expires_at: value.provider_expires_at,
  };
}

export function sameGeminiSyntheticTestContext(
  left: GeminiSyntheticTestContext | null,
  right: GeminiSyntheticTestContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.principal_id === right.principal_id
    && left.test_run_id === right.test_run_id
    && left.scenario_id === right.scenario_id
    && left.scenario_version === right.scenario_version
    && left.voice_lab_run_id_sha256 === right.voice_lab_run_id_sha256
    && left.browser_worker_id_sha256 === right.browser_worker_id_sha256
    && left.browser_lease_epoch === right.browser_lease_epoch
    && left.browser_context_id_sha256 === right.browser_context_id_sha256
    && left.environment === right.environment
    && left.retention_hours === right.retention_hours
    && left.cleanup_obligation_id === right.cleanup_obligation_id
    && left.provider_expires_at === right.provider_expires_at
  );
}

const GEMINI_DEPLOYMENT_SHA = /^[a-f0-9]{40}$/;

export function readGeminiVoiceLabTraceFaultReceipt(
  value: unknown,
  syntheticTest: GeminiSyntheticTestContext | null,
  label = 'Gemini trace fault receipt',
  expectedPhase?: 'applied' | 'restored',
): GeminiVoiceLabTraceFaultReceipt | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || syntheticTest === null) {
    throw new Error(`${label} was malformed or lacked an authenticated synthetic binding.`);
  }
  const allowed = new Set([
    'schema',
    'fault',
    'phase',
    'principal_id',
    'test_run_id',
    'scenario_id',
    'scenario_version',
    'environment',
    'expected_deployment',
    'trace_unavailable',
    'canonical_behavior_unchanged',
    'applied_at',
    'restored_at',
  ]);
  const deployment = value.expected_deployment;
  const phase = value.phase;
  const appliedAt = typeof value.applied_at === 'string' ? value.applied_at : '';
  const restoredAt = typeof value.restored_at === 'string' ? value.restored_at : null;
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || value.schema !== 'sophia_voice_lab_trace_fault_v1'
    || value.fault !== 'langsmith_unavailable'
    || (phase !== 'applied' && phase !== 'restored')
    || (expectedPhase !== undefined && phase !== expectedPhase)
    || value.principal_id !== syntheticTest.principal_id
    || value.test_run_id !== syntheticTest.test_run_id
    || value.scenario_id !== syntheticTest.scenario_id
    || value.scenario_version !== syntheticTest.scenario_version
    || value.environment !== syntheticTest.environment
    || syntheticTest.scenario_id !== 'V-L01'
    || typeof syntheticTest.scenario_version !== 'string'
    || !isRecord(deployment)
    || Object.keys(deployment).length !== 3
    || !GEMINI_DEPLOYMENT_SHA.test(String(deployment.frontend ?? ''))
    || !GEMINI_DEPLOYMENT_SHA.test(String(deployment.backend ?? ''))
    || !GEMINI_DEPLOYMENT_SHA.test(String(deployment.voice ?? ''))
    || value.trace_unavailable !== true
    || value.canonical_behavior_unchanged !== true
    || !appliedAt
    || !Number.isFinite(Date.parse(appliedAt))
    || (phase === 'applied' && value.restored_at !== null)
    || (phase === 'restored' && (!restoredAt || !Number.isFinite(Date.parse(restoredAt))))
  ) {
    throw new Error(`${label} was malformed or did not match the authenticated synthetic run.`);
  }
  return {
    schema: 'sophia_voice_lab_trace_fault_v1',
    fault: 'langsmith_unavailable',
    phase,
    principal_id: syntheticTest.principal_id,
    test_run_id: syntheticTest.test_run_id,
    scenario_id: syntheticTest.scenario_id,
    scenario_version: syntheticTest.scenario_version,
    environment: syntheticTest.environment,
    expected_deployment: {
      frontend: String(deployment.frontend),
      backend: String(deployment.backend),
      voice: String(deployment.voice),
    },
    trace_unavailable: true,
    canonical_behavior_unchanged: true,
    applied_at: appliedAt,
    restored_at: restoredAt,
  };
}

export function readGeminiLangSmithTraceContext(
  payload: Pick<BrowserSessionPayload, 'langsmith_trace_id' | 'langsmith_trace_unavailable_reason'>,
  traceFault: GeminiVoiceLabTraceFaultReceipt | null = null,
): GeminiLangSmithTraceContext {
  if (traceFault !== null) {
    if (payload.langsmith_trace_id !== undefined && payload.langsmith_trace_id !== null) {
      throw new Error('Governed trace fault bootstrap unexpectedly exposed a LangSmith trace id.');
    }
    if (
      payload.langsmith_trace_unavailable_reason !== undefined
      && payload.langsmith_trace_unavailable_reason !== null
      && payload.langsmith_trace_unavailable_reason !== 'governed_synthetic_fault'
    ) {
      throw new Error('Governed trace fault bootstrap exposed an inconsistent unavailable reason.');
    }
    return {
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'governed_synthetic_fault',
    };
  }
  if (typeof payload.langsmith_trace_id === 'string') {
    const langsmithTraceId = payload.langsmith_trace_id.trim();
    if (langsmithTraceId) {
      if (
        payload.langsmith_trace_unavailable_reason !== undefined
        && payload.langsmith_trace_unavailable_reason !== null
      ) {
        throw new Error('LangSmith trace bootstrap exposed both an id and an unavailable reason.');
      }
      return {
        langsmithTraceId,
        langsmithTraceStatus: 'available',
        langsmithTraceUnavailableReason: null,
      };
    }
    return {
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'invalid',
    };
  }
  if (payload.langsmith_trace_id !== undefined && payload.langsmith_trace_id !== null) {
    return {
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'invalid',
    };
  }
  if (
    payload.langsmith_trace_unavailable_reason !== undefined
    && payload.langsmith_trace_unavailable_reason !== null
  ) {
    if (
      payload.langsmith_trace_unavailable_reason === 'synthetic_isolation_policy'
      || payload.langsmith_trace_unavailable_reason === 'governed_synthetic_fault'
    ) {
      return {
        langsmithTraceId: null,
        langsmithTraceStatus: 'trace_unavailable',
        langsmithTraceUnavailableReason: payload.langsmith_trace_unavailable_reason,
      };
    }
    return {
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'invalid',
    };
  }
  return {
    langsmithTraceId: null,
    langsmithTraceStatus: 'trace_unavailable',
    langsmithTraceUnavailableReason: 'not_provided',
  };
}

function isBrowserApiPath(value: string): boolean {
  return value.startsWith('/api/');
}

async function relayGeminiProviderEvent(
  fetchFn: FetchLike,
  sessionId: string,
  event: Record<string, unknown>,
  receiveMetadata: GeminiProviderReceiveMetadata,
  relayTargetPath = RELAY_TARGET_PATH,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null = null,
  syntheticToolEvidence: GeminiSyntheticToolEvidence[] = [],
): Promise<GeminiBrowserLiveDogfoodRelayResponse> {
  const body = JSON.stringify({
    session_id: sessionId,
    event,
    provider_receive_sequence: receiveMetadata.providerReceiveSequence,
    provider_relay_sequence: receiveMetadata.providerRelaySequence ?? receiveMetadata.providerReceiveSequence,
    provider_connection_epoch: receiveMetadata.providerConnectionEpoch ?? null,
    provider_received_at: receiveMetadata.providerReceivedAt,
    relay_correlation_id: receiveMetadata.relayCorrelationId,
    provider_primary_category: receiveMetadata.providerPrimaryCategory,
    provider_categories: receiveMetadata.providerCategories,
    ...(artifactReviewContext ? { artifact_review_context: artifactReviewContext } : {}),
    ...(syntheticToolEvidence.length > 0 ? { synthetic_tool_evidence: syntheticToolEvidence } : {}),
  });
  const eventType = describeGeminiProviderEventType(event);
  const requestBodyBytes = textByteLength(body);
  let response: Response;

  try {
    response = await fetchFn(relayTargetPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown fetch failure.';
    throw new GeminiRelayFetchError(`Gemini browser dogfood relay fetch failed: ${message}`, {
      targetPath: relayTargetPath,
      eventType,
      requestBodyBytes,
      hasHttpResponse: false,
      statusCode: null,
      statusText: null,
      errorText: message,
      fetchErrorName: error instanceof Error ? error.name : null,
    });
  }

  if (!response.ok) {
    const message = await formatDogfoodHttpError(response, 'Gemini browser dogfood relay failed');
    throw new GeminiRelayFetchError(message, {
      targetPath: relayTargetPath,
      eventType,
      requestBodyBytes,
      hasHttpResponse: true,
      statusCode: response.status,
      statusText: response.statusText || null,
      errorText: message,
      fetchErrorName: null,
    });
  }

  return readGeminiRelayResponse(response);
}

async function readGeminiRelayResponse(response: Response): Promise<GeminiBrowserLiveDogfoodRelayResponse> {
  const contentType = response.headers.get('Content-Type') ?? response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return {
      accepted: true,
      clientActions: [],
      toolDiagnostics: [],
      statusCode: response.status,
      statusText: response.statusText || null,
      responseKind: 'neither',
      backendDiagnostics: null,
    };
  }

  try {
    const payload = await response.json() as GeminiBrowserLiveDogfoodRelayResponsePayload | null;
    if (!isRecord(payload)) {
      return {
        accepted: true,
        clientActions: [],
        toolDiagnostics: [],
        statusCode: response.status,
        statusText: response.statusText || null,
        responseKind: 'neither',
        backendDiagnostics: null,
      };
    }

    const clientActions = arrayFromAnyKey(payload, 'client_actions', 'clientActions')
      ?.filter(isRecord)
      .map((action) => ({ ...action })) as GeminiRelayClientAction[] | undefined;
    const toolDiagnostics = arrayFromAnyKey(payload, 'tool_diagnostics', 'toolDiagnostics')
      ?.filter(isRecord)
      .map((diagnostic) => ({ ...diagnostic })) as GeminiRelayToolDiagnosticPayload[] | undefined;
    return {
      accepted: payload.accepted !== false,
      clientActions: clientActions ?? [],
      toolDiagnostics: toolDiagnostics ?? [],
      statusCode: response.status,
      statusText: response.statusText || null,
      responseKind: relayResponseKind(clientActions?.length ?? 0, toolDiagnostics?.length ?? 0),
      backendDiagnostics: isRecord(payload.diagnostics) ? payload.diagnostics : null,
    };
  } catch {
    return {
      accepted: true,
      clientActions: [],
      toolDiagnostics: [],
      statusCode: response.status,
      statusText: response.statusText || null,
      responseKind: 'neither',
      backendDiagnostics: null,
    };
  }
}

function relayResponseKind(clientActionCount: number, toolDiagnosticCount: number): GeminiRelayResponseKind {
  if (clientActionCount > 0 && toolDiagnosticCount > 0) {
    return 'client_actions_and_tool_diagnostics';
  }
  if (clientActionCount > 0) {
    return 'client_actions';
  }
  if (toolDiagnosticCount > 0) {
    return 'tool_diagnostics';
  }
  return 'neither';
}

function handleGeminiRelayClientActions(options: {
  relayResponse: GeminiBrowserLiveDogfoodRelayResponse;
  websocket: WebSocketLike | null;
  sessionId: string;
  threadId?: string | null;
  toolCallLedger: Map<string, GeminiBrowserLiveToolCallLedgerEntry>;
  onToolCallLedgerUpdate?: (entry: GeminiBrowserLiveToolCallLedgerEntry) => void;
  onToolLoopDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => void;
  onToolResponseSent?: (functionResponse: Record<string, unknown>, timestamp: string) => void;
}): void {
  for (const diagnostic of options.relayResponse.toolDiagnostics) {
    const rawBackendResponse = recordFromAnyKey(diagnostic, 'response');
    const backendResponse = redactBackendResponseForToolTelemetry(
      typeof diagnostic.name === 'string' ? diagnostic.name : null,
      rawBackendResponse,
    );
    const executionRejected = diagnostic.execution_rejected === true
      || diagnostic.executionRejected === true
      || diagnostic.success === false
      || backendResponse?.ok === false;
    options.onToolLoopDiagnostic?.({
      timestamp: new Date().toISOString(),
      phase: diagnostic.cancelled === true
        ? 'tool_call_cancelled'
        : executionRejected ? 'tool_execution_rejected' : 'backend_accepted_tool_call',
      toolCall: toolCallSummaryFromDiagnostic(diagnostic),
      success: diagnostic.success === true,
      resultSummary: stringFromAnyKey(diagnostic, 'result_summary', 'resultSummary'),
      taskId: taskIdFromDiagnostic(diagnostic) ?? taskIdFromResponseRecord(backendResponse),
      taskStatus: taskStatusFromDiagnostic(diagnostic) ?? taskStatusFromResponseRecord(backendResponse),
      trackedTaskIds: uniqueStrings([
        ...trackedTaskIdsFromDiagnostic(diagnostic),
        ...trackedTaskIdsFromResponseRecord(backendResponse),
      ]),
      rejectionReason: stringFromAnyKey(diagnostic, 'rejection_reason', 'rejectionReason')
        ?? stringFromAnyKey(backendResponse, 'error_type', 'errorType'),
      recoveryGuidance: stringFromAnyKey(diagnostic, 'recovery_guidance', 'recoveryGuidance')
        ?? stringFromAnyKey(backendResponse, 'recovery_guidance', 'recoveryGuidance'),
      backendResponse,
      errorText: stringFromAnyKey(diagnostic, 'error_text', 'errorText')
        ?? (executionRejected ? stringFromAnyKey(backendResponse, 'error_message', 'errorMessage') : null),
      reviewToolTimedOut: backendResponse?.review_tool_timed_out === true,
      reviewToolTimeoutName: stringFromAnyKey(backendResponse, 'review_tool_timeout_name', 'reviewToolTimeoutName'),
      reviewToolTimeoutResultSent: backendResponse?.review_tool_timeout_result_sent === true,
    });
  }

  for (const action of options.relayResponse.clientActions) {
    if (action.type !== 'gemini_tool_response' || !isRecord(action.payload)) {
      continue;
    }

    const functionResponses = readGeminiFunctionResponsesFromToolResponse(action.payload)
      .map((functionResponse) => applyCoreviewReadArtifactTextSideband(functionResponse, {
        sessionId: options.sessionId,
        threadId: options.threadId ?? null,
      }));
    const fallbackSummary = stringFromAnyKey(action, 'result_summary', 'resultSummary');
    const activeFunctionResponses: Record<string, unknown>[] = [];
    const suppressedFunctionResponses: Record<string, unknown>[] = [];
    const suppressedAt = new Date().toISOString();
    for (const functionResponse of functionResponses) {
      const toolCallId = stringFromAnyKey(functionResponse, 'id');
      const ledgerEntry = toolCallId ? options.toolCallLedger.get(toolCallId) : null;
      if (ledgerEntry?.cancelledAt && !ledgerEntry.toolResponseSentAt) {
        suppressedFunctionResponses.push(functionResponse);
        emitToolCallLedgerEntry(
          options.toolCallLedger,
          toolCallId,
          {
            toolName: stringFromAnyKey(functionResponse, 'name'),
            sendSuppressedAt: suppressedAt,
            suppressionReason: 'cancelled_before_tool_response_send',
            finalState: 'suppressed',
          },
          options.onToolCallLedgerUpdate,
        );
        options.onToolLoopDiagnostic?.({
          timestamp: suppressedAt,
          phase: 'tool_response_send_suppressed',
          toolCall: toolCallSummaryFromFunctionResponse(functionResponse),
          success: false,
          resultSummary: responseSummaryFromFunctionResponse(functionResponse) ?? fallbackSummary,
          taskId: null,
          taskStatus: null,
          trackedTaskIds: null,
          rejectionReason: null,
          recoveryGuidance: 'Gemini cancelled this tool call before the browser could return the toolResponse.',
          backendResponse: redactBackendResponseForToolTelemetry(
            stringFromAnyKey(functionResponse, 'name'),
            recordFromAnyKey(functionResponse, 'response'),
          ),
          errorText: null,
          suppressionReason: 'cancelled_before_tool_response_send',
        });
        continue;
      }
      activeFunctionResponses.push(functionResponse);
    }

    if (functionResponses.length > 0 && activeFunctionResponses.length === 0 && suppressedFunctionResponses.length > 0) {
      continue;
    }

    const payloadToSend = functionResponses.length > 0
      ? replaceGeminiFunctionResponsesInToolResponse(action.payload, activeFunctionResponses)
      : action.payload;
    try {
      if (options.websocket?.readyState !== WEBSOCKET_OPEN) {
        throw new Error('Gemini Live WebSocket is not open for toolResponse send-back.');
      }
      options.websocket.send(JSON.stringify(payloadToSend));
      for (const functionResponse of activeFunctionResponses.length ? activeFunctionResponses : functionResponses) {
        const timestamp = new Date().toISOString();
        const toolCallId = stringFromAnyKey(functionResponse, 'id');
        const ledgerEntry = toolCallId ? options.toolCallLedger.get(toolCallId) : null;
        options.onToolResponseSent?.(functionResponse, timestamp);
        emitToolCallLedgerEntry(
          options.toolCallLedger,
          toolCallId,
          {
            toolName: stringFromAnyKey(functionResponse, 'name'),
            toolResponseSentAt: timestamp,
            finalState: 'responded',
            ...(ledgerEntry?.syntheticBuilderJoin ? {
              syntheticBuilderJoin: {
                ...ledgerEntry.syntheticBuilderJoin,
                tool_state: ledgerEntry.syntheticBuilderJoin.tool_state === 'terminal_settled'
                  ? 'terminal_settled'
                  : 'responded',
                source_tool_response_sent_at: timestamp,
              },
            } : {}),
          },
          options.onToolCallLedgerUpdate,
        );
        const rawBackendResponse = recordFromAnyKey(functionResponse, 'response');
        const backendResponse = redactBackendResponseForToolTelemetry(
          stringFromAnyKey(functionResponse, 'name'),
          rawBackendResponse,
        );
        const responseRejected = backendResponse?.ok === false
          || backendResponse?.rejected === true
          || backendResponse?.execution_rejected === true;
        options.onToolLoopDiagnostic?.({
          timestamp,
          phase: 'tool_response_sent',
          toolCall: toolCallSummaryFromFunctionResponse(functionResponse),
          success: !responseRejected,
          resultSummary: responseSummaryFromFunctionResponse(functionResponse) ?? fallbackSummary,
          taskId: taskIdFromResponseRecord(backendResponse),
          taskStatus: taskStatusFromResponseRecord(backendResponse),
          trackedTaskIds: trackedTaskIdsFromResponseRecord(backendResponse),
          rejectionReason: stringFromAnyKey(backendResponse, 'error_type', 'errorType', 'rejection_reason', 'rejectionReason', 'safe_reason', 'safeReason'),
          recoveryGuidance: stringFromAnyKey(backendResponse, 'recovery_guidance', 'recoveryGuidance'),
          backendResponse,
          errorText: null,
          reviewToolTimedOut: backendResponse?.review_tool_timed_out === true,
          reviewToolTimeoutName: stringFromAnyKey(backendResponse, 'review_tool_timeout_name', 'reviewToolTimeoutName'),
          reviewToolTimeoutResultSent: backendResponse?.review_tool_timeout_result_sent === true,
        });
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'Gemini toolResponse send failed.';
      for (const functionResponse of functionResponses.length ? functionResponses : [null]) {
        const timestamp = new Date().toISOString();
        options.onToolLoopDiagnostic?.({
          timestamp,
          phase: 'tool_response_send_failed',
          toolCall: functionResponse
            ? toolCallSummaryFromFunctionResponse(functionResponse)
            : emptyToolCallSummary(),
          success: false,
          resultSummary: fallbackSummary,
          taskId: functionResponse ? taskIdFromResponseRecord(recordFromAnyKey(functionResponse, 'response')) : null,
          taskStatus: functionResponse ? taskStatusFromResponseRecord(recordFromAnyKey(functionResponse, 'response')) : null,
          trackedTaskIds: functionResponse ? trackedTaskIdsFromResponseRecord(recordFromAnyKey(functionResponse, 'response')) : [],
          rejectionReason: null,
          recoveryGuidance: null,
          backendResponse: functionResponse
            ? redactBackendResponseForToolTelemetry(
                stringFromAnyKey(functionResponse, 'name'),
                recordFromAnyKey(functionResponse, 'response'),
              )
            : null,
          errorText,
          reviewToolTimedOut: false,
          reviewToolTimeoutName: null,
          reviewToolTimeoutResultSent: false,
        });
      }
    }
  }
}

async function handleGeminiFrontendCoreviewToolEvent(options: {
  event: Record<string, unknown>;
  websocket: WebSocketLike | null;
  sessionId: string;
  threadId?: string | null;
  activeArtifactId?: string | null;
  artifactReviewContext?: GeminiArtifactReviewRelayContext | null;
  reviewToolTimeoutMs?: number;
  toolCallLedger: Map<string, GeminiBrowserLiveToolCallLedgerEntry>;
  onToolCallLedgerUpdate?: (entry: GeminiBrowserLiveToolCallLedgerEntry) => void;
  onToolLoopDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => void;
  onToolResponseSent?: (functionResponse: Record<string, unknown>, timestamp: string) => void;
}): Promise<Record<string, unknown> | null> {
  const split = splitFrontendReviewToolCallsFromProviderEvent(
    options.event,
    options.artifactReviewContext ?? null,
  );
  if (
    split.frontendCalls.length === 0
    && split.suppressedEmitArtifactCalls.length === 0
    && split.suppressedGenericBuilderCalls.length === 0
  ) {
    return options.event;
  }

  const preparedAt = new Date().toISOString();
  const functionResponses: Record<string, unknown>[] = [];
  const toolDiagnostics: GeminiRelayToolDiagnosticPayload[] = [];
  for (const call of split.suppressedEmitArtifactCalls) {
    const response = suppressedEmitArtifactToolResponse(call, options.artifactReviewContext ?? null);
    functionResponses.push({
      ...(call.id ? { id: call.id } : {}),
      name: call.name,
      response,
    });
    toolDiagnostics.push(suppressedEmitArtifactToolDiagnostic(call, response));
    emitToolCallLedgerEntry(
      options.toolCallLedger,
      call.id,
      {
        toolName: call.name,
        toolResponsePreparedAt: preparedAt,
      },
      options.onToolCallLedgerUpdate,
    );
  }
  for (const call of split.suppressedGenericBuilderCalls) {
    const response = suppressedGenericBuilderToolResponse(call, options.artifactReviewContext ?? null);
    functionResponses.push({
      ...(call.id ? { id: call.id } : {}),
      name: call.name,
      response,
    });
    toolDiagnostics.push(suppressedGenericBuilderToolDiagnostic(call, response));
    emitToolCallLedgerEntry(
      options.toolCallLedger,
      call.id,
      {
        toolName: call.name,
        toolResponsePreparedAt: preparedAt,
      },
      options.onToolCallLedgerUpdate,
    );
  }
  for (const call of split.frontendCalls) {
    const response = await executeFrontendReviewToolCallWithTimeout(call, {
      sessionId: options.sessionId,
      threadId: options.threadId ?? null,
      activeArtifactId: options.activeArtifactId ?? null,
      timeoutMs: options.reviewToolTimeoutMs,
    });
    functionResponses.push({
      ...(call.id ? { id: call.id } : {}),
      name: call.name,
      response,
    });
    emitToolCallLedgerEntry(
      options.toolCallLedger,
      call.id,
      {
        toolName: call.name,
        toolResponsePreparedAt: preparedAt,
      },
      options.onToolCallLedgerUpdate,
    );
  }

  handleGeminiRelayClientActions({
    relayResponse: {
      accepted: true,
      clientActions: [{
        type: 'gemini_tool_response',
        payload: {
          toolResponse: {
            functionResponses,
          },
        },
        result_summary: functionResponses
          .map((functionResponse) => responseSummaryFromFunctionResponse(functionResponse))
          .filter((summary): summary is string => Boolean(summary))
          .join(' '),
      }],
      toolDiagnostics,
      statusCode: null,
      statusText: null,
      responseKind: 'client_actions',
      backendDiagnostics: null,
    },
    websocket: options.websocket,
    sessionId: options.sessionId,
    threadId: options.threadId ?? null,
    toolCallLedger: options.toolCallLedger,
    onToolCallLedgerUpdate: options.onToolCallLedgerUpdate,
    onToolLoopDiagnostic: options.onToolLoopDiagnostic,
    onToolResponseSent: options.onToolResponseSent,
  });

  return split.relayEvent;
}

async function executeFrontendReviewToolCallWithTimeout(
  call: GeminiFrontendReviewToolCallInput,
  options: {
    sessionId: string;
    threadId?: string | null;
    activeArtifactId: string | null;
    timeoutMs?: number;
  },
): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeReviewToolTimeoutMs(options.timeoutMs);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const startedAtMs = monotonicNowMs();
  const execution = (async () => {
    try {
      if (isReadArtifactTextToolCall(call)) {
        return executeBrowserReadArtifactTextToolCall(call, {
          sessionId: options.sessionId,
          threadId: options.threadId ?? null,
          activeArtifactId: options.activeArtifactId,
          startedAtMs,
        });
      }
      if (isCoreviewRoutedBuilderToolCall(call)) {
        const coreviewResponse = { ...(await executeCoreviewBuilderToolBridgeCall(call.coreviewCall)) };
        const directCallResult = coreviewResponse.ok === true
          ? call.routeKind === 'direct_edit_builder_artifact'
            ? 'routed_to_coreview_update'
            : 'routed_to_coreview_status'
          : stringFromAnyKey(coreviewResponse, 'blockedReason', 'blocked_reason')
            ?? stringFromAnyKey(coreviewResponse, 'result')
            ?? 'coreview_route_failed';
        return {
          ...coreviewResponse,
          result_summary: stringFromAnyKey(coreviewResponse, 'userFacingMessage', 'user_facing_message')
            ?? (call.routeKind === 'direct_edit_builder_artifact'
              ? 'Direct edit_builder_artifact routed through Coreview update state.'
              : 'Generic builder status routed through Coreview status.'),
          coreview_control_plane_tool: call.coreviewCall.name,
          editBuilderArtifactInterceptedByCoreview: call.routeKind === 'direct_edit_builder_artifact',
          editBuilderArtifactDirectCallResult: call.routeKind === 'direct_edit_builder_artifact' ? directCallResult : null,
          coreviewUpdateStateCreatedFromDirectEditTool: call.routeKind === 'direct_edit_builder_artifact'
            && coreviewResponse.ok === true
            && (
              stringFromAnyKey(coreviewResponse, 'result') === 'task_started'
              || stringFromAnyKey(coreviewResponse, 'result') === 'update_requested'
            ),
          genericAsyncToolBlockedReason: call.routeKind === 'generic_builder_status'
            ? 'use_coreview_get_builder_status'
            : null,
          genericAsyncToolRespondedSafely: true,
          raw_artifact_text_excluded: true,
          raw_frame_excluded: true,
          raw_comment_text_excluded: true,
        };
      }
      if (isCoreviewBuilderToolName(call.name)) {
        return { ...(await executeCoreviewBuilderToolBridgeCall(call as CoreviewBuilderToolCallInput)) };
      }
      return { ...(await executeCoreviewToolBridgeCall(call as CoreviewToolCallInput)) };
    } catch (error) {
      if (isReadArtifactTextToolCall(call)) {
        return readArtifactTextFailureResponse(call, 'unavailable', error instanceof Error
          ? error.message
          : 'Trusted artifact text is unavailable.');
      }
      if (isCoreviewRoutedBuilderToolCall(call)) {
        return {
          ...coreviewBuilderToolExceptionResult(call.coreviewCall, error),
          result_summary: 'Coreview artifact update action failed.',
          coreview_control_plane_tool: call.coreviewCall.name,
          editBuilderArtifactInterceptedByCoreview: call.routeKind === 'direct_edit_builder_artifact',
          editBuilderArtifactDirectCallResult: 'coreview_route_failed',
          coreviewUpdateStateCreatedFromDirectEditTool: false,
          raw_artifact_text_excluded: true,
          raw_frame_excluded: true,
          raw_comment_text_excluded: true,
        };
      }
      return isCoreviewBuilderToolName(call.name)
        ? { ...coreviewBuilderToolExceptionResult(call as CoreviewBuilderToolCallInput, error) }
        : { ...coreviewToolExceptionResult(call as CoreviewToolCallInput, error) };
    }
  })();
  const timeout = new Promise<Record<string, unknown>>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(reviewToolTimeoutResult(call, {
        activeArtifactId: options.activeArtifactId,
        timeoutMs,
      }));
    }, timeoutMs);
  });

  const result = await Promise.race([execution, timeout]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
}

function isReadArtifactTextToolCall(
  call: GeminiFrontendReviewToolCallInput,
): call is GeminiReadArtifactTextToolCallInput {
  return !isCoreviewRoutedBuilderToolCall(call)
    && call.name === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME;
}

function isCoreviewRoutedBuilderToolCall(
  call: GeminiFrontendReviewToolCallInput,
): call is GeminiCoreviewRoutedBuilderToolCallInput {
  const candidate = call as Record<string, unknown>;
  return isRecord(candidate)
    && isRecord(candidate.coreviewCall)
    && typeof candidate.routeKind === 'string';
}

function executeBrowserReadArtifactTextToolCall(
  call: GeminiReadArtifactTextToolCallInput,
  options: {
    sessionId: string;
    threadId?: string | null;
    activeArtifactId: string | null;
    startedAtMs: number;
  },
): Record<string, unknown> {
  const artifactId = stringFromAnyKey(call.args, 'artifact_id', 'artifactId') ?? options.activeArtifactId;
  const latencyMs = elapsedMs(options.startedAtMs);
  if (!artifactId) {
    return {
      ...readArtifactTextFailureResponse(call, 'no_selected_artifact', 'No artifact is selected for trusted text reading.'),
      latency_ms: latencyMs,
    };
  }

  return {
    ...readCoreviewArtifactTextSideband({
      artifactId,
      sessionId: options.sessionId,
      threadId: options.threadId ?? null,
    }),
    latency_ms: latencyMs,
    raw_artifact_text_excluded: true,
  };
}

function readArtifactTextFailureResponse(
  call: GeminiReadArtifactTextToolCallInput,
  status: string,
  safeReason: string,
): Record<string, unknown> {
  return {
    ok: false,
    artifact_id: stringFromAnyKey(call.args, 'artifact_id', 'artifactId') ?? null,
    status,
    safe_reason: safeReason,
    raw_artifact_text_excluded: true,
  };
}

function reviewToolTimeoutResult(
  call: GeminiFrontendReviewToolCallInput,
  options: {
    activeArtifactId: string | null;
    timeoutMs: number;
  },
): Record<string, unknown> {
  if (isReadArtifactTextToolCall(call)) {
    return {
      ...readArtifactTextFailureResponse(
        call,
        'timeout',
        'Trusted artifact text read timed out before the voice response deadline.',
      ),
      artifact_id: stringFromAnyKey(call.args, 'artifact_id', 'artifactId') ?? options.activeArtifactId,
      latency_ms: options.timeoutMs,
      review_tool_timed_out: true,
      review_tool_timeout_name: call.name,
      review_tool_timeout_result_sent: true,
    };
  }

  if (isCoreviewRoutedBuilderToolCall(call)) {
    return {
      ok: false,
      action: call.coreviewCall.name,
      result: 'failed',
      blockedReason: 'builder_action_unavailable',
      userFacingMessage: "Artifact update status is taking longer than expected. I'll keep the review open.",
      result_summary: 'Coreview artifact update action timed out.',
      coreview_control_plane_tool: call.coreviewCall.name,
      editBuilderArtifactInterceptedByCoreview: call.routeKind === 'direct_edit_builder_artifact',
      editBuilderArtifactDirectCallResult: 'coreview_route_timeout',
      coreviewUpdateStateCreatedFromDirectEditTool: false,
      preservedMic: true,
      preservedReview: true,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
      rawCommentTextExcluded: true,
      review_tool_timed_out: true,
      review_tool_timeout_name: call.name,
      review_tool_timeout_result_sent: true,
      raw_comment_text_excluded: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    };
  }

  if (isCoreviewBuilderToolName(call.name)) {
    return {
      ok: false,
      action: call.name,
      result: 'failed',
      blockedReason: 'builder_action_unavailable',
      userFacingMessage: "Artifact update status is taking longer than expected. I'll keep the review open.",
      preservedMic: true,
      preservedReview: true,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
      rawCommentTextExcluded: true,
      review_tool_timed_out: true,
      review_tool_timeout_name: call.name,
      review_tool_timeout_result_sent: true,
      raw_comment_text_excluded: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    };
  }

  const action = call.name === COREVIEW_REFRESH_VIEW_TOOL_NAME
    ? 'refresh_view'
    : call.name === COREVIEW_GET_CURRENT_VIEW_TOOL_NAME
      ? 'get_current_view'
      : call.name === COREVIEW_ADD_ANNOTATION_TOOL_NAME
        ? 'add_annotation'
        : call.name === COREVIEW_FOCUS_ANCHOR_TOOL_NAME
          ? 'focus_anchor'
          : 'set_view';
  return {
    ok: false,
    action,
    artifact_id: stringFromAnyKey(call.args, 'artifact_id', 'artifactId') ?? options.activeArtifactId,
    artifact_path: null,
    artifact_title: null,
    renderer_kind: null,
    page_index: null,
    page_number: null,
    page_count: null,
    zoom: null,
    fit_mode: null,
    view_signature: null,
    stale: false,
    refresh_attempted: false,
    refresh_result: 'not_requested',
    blocked_reason: 'tool_unavailable',
    result_summary: `${call.name} timed out before the voice response deadline.`,
    command_source: 'gemini_tool',
    preserved_mic: true,
    preserved_review: true,
    view_ready_wait_ms: options.timeoutMs,
    view_signature_before: null,
    view_signature_after: null,
    exact_text_available: false,
    visual_frame_fresh: false,
    visual_fresh: false,
    frame_sent: false,
    review_active: true,
    current_view_summary: 'Coreview tool timed out.',
    annotation_overlay_captured: null,
    artifact_stable_identity: null,
    rebind_status: 'not_attempted',
    rebind_attempted: false,
    rebind_result: 'not_attempted',
    rebind_reason: null,
    review_tool_timed_out: true,
    review_tool_timeout_name: call.name,
    review_tool_timeout_result_sent: true,
    raw_comment_text_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function normalizeReviewToolTimeoutMs(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return GEMINI_REVIEW_TOOL_TIMEOUT_MS;
  }
  return Math.min(1_500, Math.max(25, Math.floor(value)));
}

type GeminiReviewToolCallSplitResult = {
  frontendCalls: GeminiFrontendReviewToolCallInput[];
  suppressedEmitArtifactCalls: GeminiSuppressedEmitArtifactToolCallInput[];
  suppressedGenericBuilderCalls: GeminiSuppressedGenericBuilderToolCallInput[];
  relayEvent: Record<string, unknown> | null;
};

type GeminiRoutedReviewFunctionCalls = {
  frontendCalls: GeminiFrontendReviewToolCallInput[];
  suppressedEmitArtifactCalls: GeminiSuppressedEmitArtifactToolCallInput[];
  suppressedGenericBuilderCalls: GeminiSuppressedGenericBuilderToolCallInput[];
  relayFunctionCalls: unknown[];
};

type GeminiReviewToolCallRoute =
  | { kind: 'relay' }
  | { kind: 'frontend'; call: GeminiFrontendReviewToolCallInput; markCoreviewRouted?: boolean }
  | { kind: 'suppressed_emit_artifact'; call: GeminiSuppressedEmitArtifactToolCallInput }
  | { kind: 'suppressed_generic_builder'; call: GeminiSuppressedGenericBuilderToolCallInput };

type LocatedProviderFunctionCalls = {
  toolCallKey: 'toolCall' | 'tool_call';
  toolCall: Record<string, unknown>;
  functionCallsKey: 'functionCalls' | 'function_calls';
  functionCalls: unknown[];
};

function locateProviderFunctionCalls(event: Record<string, unknown>): LocatedProviderFunctionCalls | null {
  const toolCallKey = isRecord(event.toolCall)
    ? 'toolCall'
    : isRecord(event.tool_call)
      ? 'tool_call'
      : null;
  if (!toolCallKey) {
    return null;
  }

  const toolCall = event[toolCallKey];
  if (!isRecord(toolCall)) {
    return null;
  }

  const functionCallsKey = Array.isArray(toolCall.functionCalls)
    ? 'functionCalls'
    : Array.isArray(toolCall.function_calls)
      ? 'function_calls'
      : null;
  if (!functionCallsKey) {
    return null;
  }

  const functionCalls = toolCall[functionCallsKey];
  if (!Array.isArray(functionCalls)) {
    return null;
  }
  return { toolCallKey, toolCall, functionCallsKey, functionCalls };
}

function isCoreviewArtifactUpdateFunctionCall(functionCall: unknown): boolean {
  return isRecord(functionCall)
    && stringFromAnyKey(functionCall, 'name') === COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME;
}

function routeSuppressedEmitArtifactReviewCall(
  functionCall: Record<string, unknown>,
  name: string | null,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): GeminiReviewToolCallRoute | null {
  if (
    name !== GEMINI_EMIT_ARTIFACT_TOOL_NAME
    || !shouldSuppressEmitArtifactToolCallForArtifactReview(artifactReviewContext)
  ) {
    return null;
  }
  return {
    kind: 'suppressed_emit_artifact',
    call: {
      id: stringFromAnyKey(functionCall, 'id'),
      name,
      args: readGeminiFunctionCallArgs(functionCall) ?? {},
    },
  };
}

function routeDirectEditBuilderReviewCall(
  functionCall: Record<string, unknown>,
  name: string | null,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
  coreviewUpdateAlreadyRoutedInBatch: boolean,
): GeminiReviewToolCallRoute | null {
  if (
    name !== GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME
    || !shouldRouteDirectEditBuilderArtifactThroughCoreview(artifactReviewContext)
  ) {
    return null;
  }
  const args = readGeminiFunctionCallArgs(functionCall) ?? {};
  if (coreviewUpdateAlreadyRoutedInBatch) {
    return {
      kind: 'suppressed_generic_builder',
      call: {
        id: stringFromAnyKey(functionCall, 'id'),
        name,
        args,
        duplicateOfCoreviewUpdate: true,
      },
    };
  }
  return {
    kind: 'frontend',
    call: {
      id: stringFromAnyKey(functionCall, 'id'),
      name,
      args,
      routeKind: 'direct_edit_builder_artifact',
      coreviewCall: {
        id: stringFromAnyKey(functionCall, 'id'),
        name: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
        args: coreviewRequestArtifactUpdateArgsFromEditBuilderArtifactArgs(args),
      },
    },
    markCoreviewRouted: true,
  };
}

function routeGenericBuilderStatusReviewCall(
  functionCall: Record<string, unknown>,
  name: string | null,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): GeminiReviewToolCallRoute | null {
  if (
    (name !== 'check_async_task' && name !== 'list_async_tasks')
    || !shouldRouteGenericBuilderStatusThroughCoreview(artifactReviewContext)
  ) {
    return null;
  }
  const args = readGeminiFunctionCallArgs(functionCall) ?? {};
  return {
    kind: 'frontend',
    call: {
      id: stringFromAnyKey(functionCall, 'id'),
      name,
      args,
      routeKind: 'generic_builder_status',
      coreviewCall: {
        id: stringFromAnyKey(functionCall, 'id'),
        name: COREVIEW_GET_BUILDER_STATUS_TOOL_NAME,
        args: {
          reason: stringFromAnyKey(args, 'reason', 'message', 'query')
            ?? 'Check selected artifact update status.',
          source_actor: 'sophia',
        },
      },
    },
  };
}

function routeSuppressedGenericBuilderReviewCall(
  functionCall: Record<string, unknown>,
  name: string | null,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): GeminiReviewToolCallRoute | null {
  if (
    typeof name !== 'string'
    || !GEMINI_GENERIC_BUILDER_TOOL_NAMES.has(name)
    || !shouldSuppressGenericBuilderToolCallForArtifactReviewUpdate(artifactReviewContext, name)
  ) {
    return null;
  }
  return {
    kind: 'suppressed_generic_builder',
    call: {
      id: stringFromAnyKey(functionCall, 'id'),
      name,
      args: readGeminiFunctionCallArgs(functionCall) ?? {},
    },
  };
}

function routeReviewFunctionCall(
  functionCall: Record<string, unknown>,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
  coreviewUpdateAlreadyRoutedInBatch: boolean,
): GeminiReviewToolCallRoute {
  const name = stringFromAnyKey(functionCall, 'name');
  const routed = routeSuppressedEmitArtifactReviewCall(functionCall, name, artifactReviewContext)
    ?? routeDirectEditBuilderReviewCall(functionCall, name, artifactReviewContext, coreviewUpdateAlreadyRoutedInBatch)
    ?? routeGenericBuilderStatusReviewCall(functionCall, name, artifactReviewContext)
    ?? routeSuppressedGenericBuilderReviewCall(functionCall, name, artifactReviewContext);
  if (routed) {
    return routed;
  }
  if (!isCoreviewToolName(name) && !isCoreviewBuilderToolName(name) && name !== GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME) {
    return { kind: 'relay' };
  }
  return {
    kind: 'frontend',
    call: {
      id: stringFromAnyKey(functionCall, 'id'),
      name,
      args: readGeminiFunctionCallArgs(functionCall) ?? {},
    } as GeminiFrontendReviewToolCallInput,
  };
}

function splitReviewFunctionCalls(
  functionCalls: unknown[],
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): GeminiRoutedReviewFunctionCalls {
  let coreviewUpdateAlreadyRoutedInBatch = functionCalls.some(isCoreviewArtifactUpdateFunctionCall);

  const frontendCalls: GeminiFrontendReviewToolCallInput[] = [];
  const suppressedEmitArtifactCalls: GeminiSuppressedEmitArtifactToolCallInput[] = [];
  const suppressedGenericBuilderCalls: GeminiSuppressedGenericBuilderToolCallInput[] = [];
  const relayFunctionCalls: unknown[] = [];
  for (const functionCall of functionCalls) {
    if (!isRecord(functionCall)) {
      relayFunctionCalls.push(functionCall);
      continue;
    }
    const route = routeReviewFunctionCall(functionCall, artifactReviewContext, coreviewUpdateAlreadyRoutedInBatch);
    switch (route.kind) {
      case 'frontend':
        frontendCalls.push(route.call);
        coreviewUpdateAlreadyRoutedInBatch = coreviewUpdateAlreadyRoutedInBatch || route.markCoreviewRouted === true;
        break;
      case 'suppressed_emit_artifact':
        suppressedEmitArtifactCalls.push(route.call);
        break;
      case 'suppressed_generic_builder':
        suppressedGenericBuilderCalls.push(route.call);
        break;
      default:
        relayFunctionCalls.push(functionCall);
        break;
    }
  }
  return { frontendCalls, suppressedEmitArtifactCalls, suppressedGenericBuilderCalls, relayFunctionCalls };
}

function buildReviewToolCallSplitResult(
  event: Record<string, unknown>,
  located: LocatedProviderFunctionCalls,
  routed: GeminiRoutedReviewFunctionCalls,
): GeminiReviewToolCallSplitResult {
  const { frontendCalls, suppressedEmitArtifactCalls, suppressedGenericBuilderCalls, relayFunctionCalls } = routed;
  if (frontendCalls.length === 0 && suppressedEmitArtifactCalls.length === 0 && suppressedGenericBuilderCalls.length === 0) {
    return { frontendCalls, suppressedEmitArtifactCalls, suppressedGenericBuilderCalls, relayEvent: event };
  }

  if (relayFunctionCalls.length > 0) {
    return {
      frontendCalls,
      suppressedEmitArtifactCalls,
      suppressedGenericBuilderCalls,
      relayEvent: {
        ...event,
        [located.toolCallKey]: {
          ...located.toolCall,
          [located.functionCallsKey]: relayFunctionCalls,
        },
      },
    };
  }

  const relayEvent = { ...event };
  delete relayEvent[located.toolCallKey];
  return {
    frontendCalls,
    suppressedEmitArtifactCalls,
    suppressedGenericBuilderCalls,
    relayEvent: Object.keys(relayEvent).length > 0 ? relayEvent : null,
  };
}

function splitFrontendReviewToolCallsFromProviderEvent(
  event: Record<string, unknown>,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null = null,
): GeminiReviewToolCallSplitResult {
  const located = locateProviderFunctionCalls(event);
  if (!located) {
    return { frontendCalls: [], suppressedEmitArtifactCalls: [], suppressedGenericBuilderCalls: [], relayEvent: event };
  }
  const routed = splitReviewFunctionCalls(located.functionCalls, artifactReviewContext);
  return buildReviewToolCallSplitResult(event, located, routed);
}

function shouldSuppressEmitArtifactToolCallForArtifactReview(
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): boolean {
  return Boolean(
    artifactReviewContext?.active
    && (
      artifactReviewContext.builder_update_intent_detected
      || artifactReviewContext.user_intent !== 'create_update'
    ),
  );
}

function shouldRouteDirectEditBuilderArtifactThroughCoreview(
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): boolean {
  return Boolean(
    artifactReviewContext?.active
    && artifactReviewContext.artifact_id
    && (
      artifactReviewContext.builder_update_intent_detected
      || artifactReviewContext.user_intent === 'create_update'
      || (
        artifactReviewContext.selected_artifact_update_context
        && artifactReviewContext.user_intent === 'unknown'
      )
    ),
  );
}

function shouldRouteGenericBuilderStatusThroughCoreview(
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): boolean {
  return Boolean(
    artifactReviewContext?.active
    && artifactReviewContext.artifact_id
    && (
      artifactReviewContext.builder_update_intent_detected
      || artifactReviewContext.user_intent === 'create_update'
      || (
        artifactReviewContext.selected_artifact_update_context
        && artifactReviewContext.user_intent === 'unknown'
      )
    ),
  );
}

function shouldSuppressGenericBuilderToolCallForArtifactReviewUpdate(
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
  toolName: string,
): boolean {
  return Boolean(
    artifactReviewContext?.active
    && artifactReviewContext.artifact_id
    && GEMINI_SELECTED_ARTIFACT_REVIEW_REDIRECT_BUILDER_TOOL_NAMES.has(toolName)
    && (
      artifactReviewContext.user_intent !== 'create_update'
      || artifactReviewContext.selected_artifact_update_context
      || artifactReviewContext.builder_update_intent_detected
      || artifactReviewContext.user_intent === 'create_update'
      || artifactReviewContext.user_intent === 'unknown'
    ),
  );
}

function coreviewRequestArtifactUpdateArgsFromEditBuilderArtifactArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    user_update_request: stringFromAnyKey(
      args,
      'message',
      'user_update_request',
      'userUpdateRequest',
      'requested_change_summary',
      'requestedChangeSummary',
      'change_summary',
      'changeSummary',
      'description',
      'brief',
      'task',
      'request',
      'summary',
    ) ?? 'Update this artifact.',
    update_mode: 'revise_version',
    source_actor: 'sophia',
    source_artifact_path: stringFromAnyKey(args, 'artifact_path', 'artifactPath', 'source_artifact_path', 'sourceArtifactPath'),
    revision_of_artifact_path: stringFromAnyKey(args, 'revision_of_artifact_path', 'revisionOfArtifactPath', 'artifact_path', 'artifactPath'),
    routed_from_tool: GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
    raw_comment_text_excluded: true,
  };
}

function suppressedEmitArtifactToolResponse(
  call: GeminiSuppressedEmitArtifactToolCallInput,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): Record<string, unknown> {
  const updateOnlyReviewRequest = artifactReviewContext?.builder_update_intent_detected === true
  return {
    ok: false,
    rejected: true,
    execution_rejected: true,
    safe_reason: updateOnlyReviewRequest ? 'update_only_review_request' : 'artifact_review_emit_artifact_suppressed',
    rejection_reason: 'artifact_review_emit_artifact_suppressed',
    recovery_guidance: updateOnlyReviewRequest
      ? 'Use coreview_request_artifact_update for selected-artifact update requests during Review with Sophia.'
      : 'Use Coreview review tools for selected-artifact review requests.',
    result_summary: 'Review-only emit_artifact call suppressed.',
    artifact_review_active: artifactReviewContext?.active === true,
    artifact_review_user_intent: artifactReviewContext?.user_intent ?? null,
    coreview_builder_update_intent_detected: artifactReviewContext?.builder_update_intent_detected === true,
    selected_artifact_update_context: artifactReviewContext?.selected_artifact_update_context === true,
    update_only_review_request: updateOnlyReviewRequest,
    emit_artifact_blocked_for_annotation_intent: artifactReviewContext?.user_intent !== 'create_update',
    emit_artifact_blocked_for_review_update_intent: artifactReviewContext?.builder_update_intent_detected === true,
    htmlNavigationSuppressedEmitArtifact: artifactReviewContext?.user_intent !== 'create_update',
    htmlNavigationSuppressedBuilderTool: false,
    raw_transcript_excluded: true,
    raw_comment_text_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function suppressedGenericBuilderToolResponse(
  call: GeminiSuppressedGenericBuilderToolCallInput,
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): Record<string, unknown> {
  const isStatusCheck = call.name === 'check_async_task' || call.name === 'list_async_tasks';
  const duplicateOfCoreviewUpdate = call.duplicateOfCoreviewUpdate === true;
  const recoveryGuidance = isStatusCheck
    ? 'Use coreview_get_builder_status for artifact update status. Do not expose internal ids, tool names, or recovery mechanics to the user.'
    : 'Use coreview_request_artifact_update for selected-artifact update requests during Review with Sophia. Do not expose internal ids, tool names, or recovery mechanics to the user.';
  return {
    ok: false,
    rejected: true,
    execution_rejected: true,
    safe_reason: duplicateOfCoreviewUpdate
      ? 'artifact_review_generic_builder_duplicate_suppressed'
      : isStatusCheck
      ? 'artifact_review_generic_async_status_redirected'
      : 'artifact_review_generic_builder_tool_suppressed',
    rejection_reason: duplicateOfCoreviewUpdate
      ? 'artifact_review_generic_builder_tool_suppressed'
      : isStatusCheck
      ? 'artifact_review_generic_async_status_redirected'
      : 'artifact_review_generic_builder_tool_suppressed',
    recovery_guidance: recoveryGuidance,
    result_summary: duplicateOfCoreviewUpdate
      ? 'Duplicate selected-artifact update tool call suppressed because Coreview already controls this update.'
      : isStatusCheck
      ? 'Artifact update status redirected to Coreview status.'
      : 'Selected-artifact update redirected to Coreview builder action.',
    user_facing_message: isStatusCheck
      ? "I don't see an active artifact update right now."
      : "I'll update the selected artifact from the review.",
    artifact_review_active: artifactReviewContext?.active === true,
    artifact_review_user_intent: artifactReviewContext?.user_intent ?? null,
    coreview_builder_update_intent_detected: artifactReviewContext?.builder_update_intent_detected === true,
    selected_artifact_update_context: artifactReviewContext?.selected_artifact_update_context === true,
    generic_async_tool_blocked_reason: isStatusCheck
      ? 'use_coreview_get_builder_status'
      : duplicateOfCoreviewUpdate
        ? 'already_routed_through_coreview_request_artifact_update'
      : 'use_coreview_request_artifact_update',
    generic_async_tool_responded_safely: true,
    htmlNavigationBlockedGenericToolCount: artifactReviewContext?.user_intent !== 'create_update'
      && artifactReviewContext?.builder_update_intent_detected !== true
      ? 1
      : 0,
    htmlNavigationSuppressedEmitArtifact: false,
    htmlNavigationSuppressedBuilderTool: artifactReviewContext?.user_intent !== 'create_update'
      && artifactReviewContext?.builder_update_intent_detected !== true,
    coreviewHtmlUpdateSuppressedDuplicateReplyCount: duplicateOfCoreviewUpdate ? 1 : 0,
    suppressed_tool_name: call.name,
    raw_transcript_excluded: true,
    raw_comment_text_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function suppressedEmitArtifactToolDiagnostic(
  call: GeminiSuppressedEmitArtifactToolCallInput,
  response: Record<string, unknown>,
): GeminiRelayToolDiagnosticPayload {
  return {
    id: call.id ?? undefined,
    name: call.name,
    success: false,
    execution_rejected: true,
    rejection_reason: 'artifact_review_emit_artifact_suppressed',
    recovery_guidance: 'Use Coreview review tools for annotation, highlight, comment, note, or pin requests.',
    result_summary: 'Review-only emit_artifact call suppressed.',
    response,
  };
}

function suppressedGenericBuilderToolDiagnostic(
  call: GeminiSuppressedGenericBuilderToolCallInput,
  response: Record<string, unknown>,
): GeminiRelayToolDiagnosticPayload {
  const isStatusCheck = call.name === 'check_async_task' || call.name === 'list_async_tasks';
  return {
    id: call.id ?? undefined,
    name: call.name,
    success: false,
    execution_rejected: true,
    rejection_reason: isStatusCheck
      ? 'artifact_review_generic_async_status_redirected'
      : 'artifact_review_generic_builder_tool_suppressed',
    recovery_guidance: isStatusCheck
      ? 'Use coreview_get_builder_status for artifact update status. Do not expose internal ids, tool names, or recovery mechanics to the user.'
      : 'Use coreview_request_artifact_update for selected-artifact update requests during Review with Sophia. Do not expose internal ids, tool names, or recovery mechanics to the user.',
    result_summary: isStatusCheck
      ? 'Artifact update status redirected to Coreview status.'
      : 'Selected-artifact update redirected to Coreview builder action.',
    response,
  };
}

function coreviewToolExceptionResult(
  call: CoreviewToolCallInput,
  error: unknown,
): CoreviewActionResult {
  const action = call.name === COREVIEW_REFRESH_VIEW_TOOL_NAME
    ? 'refresh_view'
    : call.name === COREVIEW_GET_CURRENT_VIEW_TOOL_NAME
      ? 'get_current_view'
      : call.name === COREVIEW_ADD_ANNOTATION_TOOL_NAME
        ? 'add_annotation'
        : call.name === COREVIEW_FOCUS_ANCHOR_TOOL_NAME
          ? 'focus_anchor'
          : 'set_view';
  return {
    ok: false,
    action,
    artifact_id: null,
    artifact_path: null,
    artifact_title: null,
    renderer_kind: null,
    page_index: null,
    page_number: null,
    page_count: null,
    zoom: null,
    fit_mode: null,
    view_signature: null,
    stale: false,
    refresh_attempted: false,
    refresh_result: 'not_requested',
    blocked_reason: 'tool_unavailable',
    result_summary: error instanceof Error
      ? `Coreview tool failed: ${error.message}`
      : 'Coreview tool failed.',
    command_source: 'gemini_tool',
    preserved_mic: true,
    preserved_review: true,
    view_ready_wait_ms: null,
    view_signature_before: null,
    view_signature_after: null,
    exact_text_available: false,
    visual_frame_fresh: false,
    visual_fresh: false,
    review_active: false,
    annotation_overlay_captured: null,
    artifact_stable_identity: null,
    rebind_status: 'not_attempted',
    rebind_attempted: false,
    rebind_result: 'not_attempted',
    rebind_reason: null,
    raw_comment_text_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function waitForWebSocketOpen(
  websocket: WebSocketLike,
  onClose?: (event: CloseEvent) => void,
): Promise<void> {
  if (websocket.readyState === WEBSOCKET_OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    websocket.onopen = () => resolve();
    websocket.onerror = () => reject(new Error('Gemini Live WebSocket failed to open.'));
    websocket.onclose = (event) => {
      onClose?.(event);
      reject(new Error('Gemini Live WebSocket closed before setup.'));
    };
  });
}

function waitForGeminiSetupComplete(
  websocket: WebSocketLike,
  handlers: {
    onProviderEventReceived: (event: unknown) => GeminiProviderReceiveMetadata;
    onProviderEvent?: (event: unknown) => void;
    onProviderEventTelemetry?: (event: unknown, receiveMetadata: GeminiProviderReceiveMetadata) => void;
    onProviderToolEvent?: (event: Record<string, unknown>) => void;
    onFrontendToolEvent?: (event: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    onRelayEvent: (event: Record<string, unknown>, receiveMetadata: GeminiProviderReceiveMetadata) => void;
    onOutputAudio: (event: Record<string, unknown>, receiveMetadata: GeminiProviderReceiveMetadata) => void;
    onInterruption: (event: Record<string, unknown>) => void;
    onToolLoopDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => void;
    onWebSocketDiagnostic?: (diagnostic: Omit<GeminiBrowserLiveDogfoodWebSocketDiagnostic, 'relayFailureAlreadyObserved'>) => void;
    onSessionResumptionUpdate?: (event: Record<string, unknown>) => void;
    onGoAway?: (
      event: Record<string, unknown>,
      receiveMetadata: GeminiProviderReceiveMetadata,
    ) => Promise<{ websocket: WebSocketLike; setup: Record<string, unknown> } | null>;
    onUnexpectedClose?: (
      event: CloseEvent,
    ) => Promise<{ websocket: WebSocketLike; setup: Record<string, unknown> } | null>;
    onProviderConnectionChanged?: (websocket: WebSocketLike) => void;
    onProviderConnectionActivation?: (
      websocket: WebSocketLike,
      previousWebsocket: WebSocketLike,
    ) => Promise<void>;
    onProviderSocketClosed?: (websocket: WebSocketLike, event: CloseEvent) => void;
    isSessionClosed?: () => boolean;
    onProviderConnectionRestored?: () => void;
    onProviderConnectionTerminated?: (event: CloseEvent) => void;
    onProviderEventCompleted?: (
      event: Record<string, unknown>,
      receiveMetadata: GeminiProviderReceiveMetadata,
    ) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let activeSocket = websocket;
    let initialSetupResolved = false;
    let rotationInFlight = false;
    let messageHandlingChain = Promise.resolve();

    const activateContinuation = async (
      continuation: { websocket: WebSocketLike; setup: Record<string, unknown> },
      previousSocket: WebSocketLike,
    ) => {
      if (handlers.isSessionClosed?.()) {
        continuation.websocket.close(1000, 'Gemini Live continuation cancelled during cleanup.');
        return;
      }
      if (previousSocket === activeSocket && previousSocket.readyState === WEBSOCKET_OPEN) {
        previousSocket.close(1000, 'Gemini Live continuation rotation.');
      }
      activeSocket = continuation.websocket;
      handlers.onProviderConnectionChanged?.(activeSocket);
      await waitForWebSocketOpen(activeSocket, (event) => {
        handlers.onProviderSocketClosed?.(activeSocket, event);
      });
      if (handlers.isSessionClosed?.()) {
        activeSocket.close(1000, 'Gemini Live continuation cancelled during cleanup.');
        return;
      }
      attach(activeSocket);
      try {
        await handlers.onProviderConnectionActivation?.(activeSocket, previousSocket);
      } catch (error) {
        if (activeSocket.readyState < 2) {
          activeSocket.close(1000, 'Gemini Live continuation activation failed.');
        }
        throw error;
      }
      if (handlers.isSessionClosed?.()) {
        activeSocket.close(1000, 'Gemini Live continuation cancelled during cleanup.');
        return;
      }
      activeSocket.send(JSON.stringify({ setup: continuation.setup }));
    };

    const recoverUnexpectedClose = async (socket: WebSocketLike, event: CloseEvent) => {
      if (
        socket !== activeSocket
        || !initialSetupResolved
        || rotationInFlight
        || !handlers.onUnexpectedClose
      ) {
        return;
      }
      rotationInFlight = true;
      try {
        const continuation = await handlers.onUnexpectedClose(event);
        if (!continuation) {
          handlers.onProviderConnectionTerminated?.(event);
          return;
        }
        await activateContinuation(continuation, socket);
      } catch {
        handlers.onProviderConnectionTerminated?.(event);
      } finally {
        rotationInFlight = false;
      }
    };

    const attach = (socket: WebSocketLike) => {
      const handleMessage = async (messageEvent: MessageEvent) => {
        const parsed = await parseWebSocketMessage(messageEvent.data);
        if (socket !== activeSocket) {
          return;
        }
        handlers.onProviderEvent?.(parsed);
        const receiveMetadata = handlers.onProviderEventReceived(parsed);
        handlers.onProviderEventTelemetry?.(parsed, receiveMetadata);

        const categories = categorizeGeminiProviderEvent(parsed);
        if (categories.includes('sessionResumptionUpdate') && isRecord(parsed)) {
          handlers.onSessionResumptionUpdate?.(parsed);
        }

        if (!isRelayableGeminiProviderEvent(parsed)) {
          return;
        }

        handlers.onProviderToolEvent?.(parsed);
        notifyToolCallReceived(parsed, handlers.onToolLoopDiagnostic);
        const interrupted = isGeminiServerInterruptedEvent(parsed);
        if (interrupted) {
          handlers.onInterruption(parsed);
        }
        const relayEvent = handlers.onFrontendToolEvent
          ? await handlers.onFrontendToolEvent(parsed)
          : parsed;
        if (relayEvent) {
          handlers.onRelayEvent(relayEvent, receiveMetadata);
        }
        if (!interrupted) {
          handlers.onOutputAudio(parsed, receiveMetadata);
        }
        handlers.onProviderEventCompleted?.(parsed, receiveMetadata);

        if (categories.includes('goAway') && handlers.onGoAway && !rotationInFlight) {
          rotationInFlight = true;
          try {
            const continuation = await handlers.onGoAway(parsed, receiveMetadata);
            if (continuation) {
              await activateContinuation(continuation, socket);
            }
          } finally {
            rotationInFlight = false;
          }
        }

        if (isGeminiSetupCompleteMessage(parsed) && !initialSetupResolved) {
          initialSetupResolved = true;
          resolve();
        } else if (isGeminiSetupCompleteMessage(parsed) && socket === activeSocket) {
          handlers.onProviderConnectionRestored?.();
        }
      };

      socket.onmessage = (messageEvent) => {
        messageHandlingChain = messageHandlingChain
          .then(() => handleMessage(messageEvent))
          .catch((error: unknown) => {
            if (!initialSetupResolved) {
              reject(error instanceof Error ? error : new Error('Gemini Live WebSocket message handling failed.'));
            }
          });
      };

      socket.onerror = () => {
        handlers.onWebSocketDiagnostic?.({
          timestamp: new Date().toISOString(),
          kind: 'error',
          message: 'Gemini Live WebSocket error event fired.',
          closeCode: null,
          closeReason: null,
          wasClean: null,
        });
        if (!initialSetupResolved) {
          reject(new Error('Gemini Live WebSocket failed before setupComplete.'));
        }
      };
      socket.onclose = (event) => {
        handlers.onProviderSocketClosed?.(socket, event);
        handlers.onWebSocketDiagnostic?.({
          timestamp: new Date().toISOString(),
          kind: 'close',
          message: 'Gemini Live WebSocket closed.',
          closeCode: typeof event.code === 'number' ? event.code : null,
          closeReason: typeof event.reason === 'string' && event.reason ? event.reason : null,
          wasClean: typeof event.wasClean === 'boolean' ? event.wasClean : null,
        });
        if (!initialSetupResolved) {
          reject(new Error('Gemini Live WebSocket closed before setupComplete.'));
          return;
        }
        void messageHandlingChain.then(() => recoverUnexpectedClose(socket, event));
      };
    };

    attach(activeSocket);
  });
}

const VOICE_LAB_INPUT_OPERATION_EVENT = 'sophia:voice-lab-input-operation';
const VOICE_LAB_INPUT_SETTLEMENT_MS = 5_000;

interface GeminiSyntheticInputOperationSignal extends Omit<
  GeminiSyntheticInputOperationBinding,
  'provider_input_sequence' | 'public_utterance_id'
> {
  settlement_window_ms: number;
}

interface GeminiSyntheticInputEvidenceState {
  signal: GeminiSyntheticInputOperationSignal;
  startedAt: string;
  completedAt: string | null;
  providerConnectionEpoch: number;
  firstAudioFrameSequence: number | null;
  lastAudioFrameSequence: number | null;
  frameCount: number;
  sampleCount: number;
  nonzeroSampleCount: number;
  byteLength: number;
  squareSum: number;
  peak: number;
  digest: Uint8Array;
  digestSequence: number;
  digestPromise: Promise<void>;
  digestFailed: boolean;
  legReceiptEmitted: boolean;
  providerInputObserved: boolean;
  providerInputSequence: number | null;
  publicUserTurnObserved: boolean;
  publicUtteranceId: string | null;
  publicUserTurnAcceptedAt: string | null;
  settlementEmitted: boolean;
  settlementTimer: ReturnType<typeof setTimeout> | null;
}

interface GeminiSyntheticInputEvidenceTracker {
  observePcmFrame: (
    bytes: Uint8Array,
    audioFrameSequence: number,
  ) => {
    binding: GeminiSyntheticInputOperationBinding;
    diagnostic: GeminiSyntheticOutgoingPcmFrameDiagnostic;
  } | null;
  currentBinding: () => GeminiSyntheticInputOperationBinding | null;
  latestAcceptedBinding: () => GeminiSyntheticInputOperationBinding | null;
  noteProviderInputTranscription: (
    receiveMetadata: GeminiProviderReceiveMetadata,
    transcriptLength: number,
  ) => void;
  notePublicUserTurn: (input: {
    publicUtteranceId?: string | null;
    transcriptLength: number;
  }) => void;
  stop: () => void;
}

interface GeminiSyntheticInteractionEvidenceState {
  binding: GeminiSyntheticInteractionBinding;
  providerFirstReceiveSequence: number;
  providerLastReceiveSequence: number;
  providerEventIds: Set<string>;
  relayCorrelationIds: Set<string>;
  toolCallIds: Set<string>;
  effectIds: Set<string>;
  toolFinalStates: Map<string, GeminiToolCallLedgerFinalState>;
  outputRealizationIds: Set<string>;
  outputProviderChunkSequences: Set<string>;
  outputReceivedRealizations: Set<string>;
  outputScheduledRealizations: Set<string>;
  outputStartedRealizations: Set<string>;
  outputCompletedRealizations: Set<string>;
  assistantEndedAt: string | null;
  responseBoundaryReason: GeminiSyntheticInteractionReceipt['response_boundary_reason'];
  emittedToolSignatures: Set<string>;
  emittedOutputSettlements: Set<string>;
}

interface GeminiSyntheticInteractionEvidenceTracker {
  noteAcceptedPublicUserTurn: (
    binding: GeminiSyntheticInputOperationBinding,
    acceptedAt: string,
  ) => void;
  observeProviderEvent: (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata,
  ) => void;
  finishProviderEvent: (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata,
  ) => void;
  noteToolLedger: (
    entry: GeminiBrowserLiveToolCallLedgerEntry,
  ) => GeminiBrowserLiveToolCallLedgerEntry;
  noteOutputReceived: (
    diagnostic: GeminiOutputAudioReceivedDiagnostic,
  ) => GeminiOutputAudioReceivedDiagnostic;
  noteOutputChunk: (
    diagnostic: GeminiOutputAudioChunkDiagnostic,
  ) => GeminiOutputAudioChunkDiagnostic;
  noteOutputPlayback: (
    receipt: GeminiOutputAudioPlaybackReceipt,
  ) => GeminiOutputAudioPlaybackReceipt;
  bindingForResponse: (responseId: string | null) => GeminiSyntheticInteractionBinding | null;
  stop: () => void;
}

class GeminiSyntheticInputSignalError extends Error {
  constructor(readonly code: GeminiSyntheticInputFaultReceipt['code']) {
    super(code);
  }
}

function createGeminiSyntheticInteractionEvidenceTracker(options: {
  syntheticTest: GeminiSyntheticTestContext;
  getProviderConnectionEpoch: () => number;
  onReceipt?: (receipt: GeminiSyntheticInteractionReceipt) => void;
  onFaultReceipt?: (receipt: GeminiSyntheticInteractionFaultReceipt) => void;
}): GeminiSyntheticInteractionEvidenceTracker {
  const statesByResponse = new Map<string, GeminiSyntheticInteractionEvidenceState>();
  const statesByInput = new Map<string, GeminiSyntheticInteractionEvidenceState>();
  const pendingToolsByInput = new Map<string, Map<string, GeminiBrowserLiveToolCallLedgerEntry>>();
  let pendingInput: { binding: GeminiSyntheticInputOperationBinding; acceptedAt: string } | null = null;
  let activeResponseId: string | null = null;
  let stopped = false;
  let faulted = false;
  let fallbackInteractionSequence = 0;

  const inputKey = (binding: Pick<GeminiSyntheticInputOperationBinding, 'operation_id' | 'utterance_id'>) => (
    `${binding.operation_id}\0${binding.utterance_id}`
  );
  const copyBinding = (binding: GeminiSyntheticInteractionBinding): GeminiSyntheticInteractionBinding => ({
    ...binding,
  });
  const newInteractionId = () => {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return `interaction:${randomUuid}`;
    fallbackInteractionSequence += 1;
    return `interaction:${Date.now().toString(36)}:${fallbackInteractionSequence.toString(36)}`;
  };
  const addBounded = (values: Set<string>, value: string | null, maximum = 256) => {
    if (!value) return;
    values.add(value);
    while (values.size > maximum) {
      const oldest = values.values().next().value;
      if (typeof oldest !== 'string') break;
      values.delete(oldest);
    }
  };
  const fail = (
    code: GeminiSyntheticInteractionFaultReceipt['code'],
    detail: {
      operationId?: string | null;
      utteranceId?: string | null;
      responseId?: string | null;
    } = {},
  ) => {
    if (stopped || faulted) return;
    faulted = true;
    options.onFaultReceipt?.({
      schema: 'sophia_gemini_interaction_fault_v1',
      synthetic: true,
      test_run_id: options.syntheticTest.test_run_id,
      code,
      operation_id: detail.operationId ?? pendingInput?.binding.operation_id ?? null,
      utterance_id: detail.utteranceId ?? pendingInput?.binding.utterance_id ?? null,
      response_id: detail.responseId ?? activeResponseId,
      observed_at: new Date().toISOString(),
      provider_connection_epoch: options.getProviderConnectionEpoch(),
      raw_audio_excluded: true,
      raw_transcript_excluded: true,
      secrets_excluded: true,
    });
  };
  const emit = (
    state: GeminiSyntheticInteractionEvidenceState,
    phase: GeminiSyntheticInteractionReceipt['phase'],
  ) => {
    if (stopped || faulted) return;
    options.onReceipt?.({
      ...copyBinding(state.binding),
      schema: 'sophia_gemini_interaction_v1',
      phase,
      assistant_ended_at: state.assistantEndedAt,
      response_boundary_reason: state.responseBoundaryReason,
      provider_first_receive_sequence: state.providerFirstReceiveSequence,
      provider_last_receive_sequence: state.providerLastReceiveSequence,
      provider_event_ids: [...state.providerEventIds],
      relay_correlation_ids: [...state.relayCorrelationIds],
      tool_call_ids: [...state.toolCallIds],
      effect_ids: [...state.effectIds],
      tool_final_states: Object.fromEntries(state.toolFinalStates),
      output_realization_ids: [...state.outputRealizationIds],
      output_provider_chunk_sequences: [...state.outputProviderChunkSequences],
      output_audio_received_count: state.outputReceivedRealizations.size,
      output_audio_playback_scheduled_count: state.outputScheduledRealizations.size,
      output_audio_playback_started_count: state.outputStartedRealizations.size,
      output_audio_playback_completed_count: state.outputCompletedRealizations.size,
      raw_audio_excluded: true,
      raw_transcript_excluded: true,
      secrets_excluded: true,
    });
  };
  const updateProviderEvent = (
    state: GeminiSyntheticInteractionEvidenceState,
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata,
  ) => {
    if (receiveMetadata.providerConnectionEpoch !== state.binding.provider_connection_epoch) {
      fail('interaction_provider_epoch_conflict', {
        operationId: state.binding.operation_id,
        utteranceId: state.binding.utterance_id,
        responseId: state.binding.response_id,
      });
      return false;
    }
    state.providerLastReceiveSequence = Math.max(
      state.providerLastReceiveSequence,
      receiveMetadata.providerReceiveSequence,
    );
    addBounded(state.providerEventIds, readGeminiProviderEventId(event));
    addBounded(state.relayCorrelationIds, receiveMetadata.relayCorrelationId);
    return true;
  };
  const hydratePendingTools = (state: GeminiSyntheticInteractionEvidenceState) => {
    const key = inputKey(state.binding);
    const tools = pendingToolsByInput.get(key);
    if (!tools) return;
    for (const entry of tools.values()) {
      state.toolCallIds.add(entry.toolCallId);
      state.effectIds.add(entry.effectId);
      if (isTerminalToolCallLedgerState(entry.finalState)) {
        state.toolFinalStates.set(entry.toolCallId, entry.finalState);
      }
    }
    pendingToolsByInput.delete(key);
  };
  const stateForResponse = (responseId: string | null) => (
    responseId ? statesByResponse.get(responseId) ?? null : null
  );

  return {
    noteAcceptedPublicUserTurn: (binding, acceptedAt) => {
      if (stopped || faulted || binding.expected_silence === true) return;
      if (
        typeof options.syntheticTest.scenario_id !== 'string'
        || typeof options.syntheticTest.scenario_version !== 'string'
      ) {
        fail('interaction_synthetic_binding_incomplete', {
          operationId: binding.operation_id,
          utteranceId: binding.utterance_id,
        });
        return;
      }
      if (
        typeof binding.public_utterance_id !== 'string'
        || !GEMINI_SYNTHETIC_SAFE_ID.test(binding.public_utterance_id)
      ) {
        fail('interaction_public_turn_binding_malformed', {
          operationId: binding.operation_id,
          utteranceId: binding.utterance_id,
        });
        return;
      }
      if (pendingInput !== null) {
        if (inputKey(pendingInput.binding) === inputKey(binding)) {
          pendingInput = { binding: { ...binding }, acceptedAt };
          return;
        }
        fail('interaction_pending_input_overlap', {
          operationId: binding.operation_id,
          utteranceId: binding.utterance_id,
        });
        return;
      }
      if (statesByInput.has(inputKey(binding))) return;
      pendingInput = { binding: { ...binding }, acceptedAt };
    },
    observeProviderEvent: (event, receiveMetadata) => {
      if (stopped || faulted) return;
      const categories = categorizeGeminiProviderEvent(event);
      if (!isAssistantOutputCategories(categories)) return;
      const responseId = readGeminiStableResponseId(event);
      if (!responseId || !GEMINI_SYNTHETIC_SAFE_ID.test(responseId)) {
        if (pendingInput !== null) {
          fail('interaction_response_id_missing');
        }
        return;
      }
      const existing = statesByResponse.get(responseId);
      if (existing) {
        updateProviderEvent(existing, event, receiveMetadata);
        return;
      }
      if (pendingInput === null) {
        if (activeResponseId !== null && activeResponseId !== responseId) {
          fail('interaction_response_overlap', { responseId });
        }
        return;
      }
      if (activeResponseId !== null && activeResponseId !== responseId) {
        fail('interaction_response_overlap', { responseId });
        return;
      }
      const key = inputKey(pendingInput.binding);
      if (
        !Number.isInteger(pendingInput.binding.provider_input_sequence)
        || Number(pendingInput.binding.provider_input_sequence) <= 0
      ) {
        fail('interaction_public_turn_binding_malformed', {
          operationId: pendingInput.binding.operation_id,
          utteranceId: pendingInput.binding.utterance_id,
          responseId,
        });
        return;
      }
      const rebound = statesByInput.get(key);
      if (rebound && rebound.binding.response_id !== responseId) {
        fail('interaction_response_rebind', {
          operationId: pendingInput.binding.operation_id,
          utteranceId: pendingInput.binding.utterance_id,
          responseId,
        });
        return;
      }
      const providerEpoch = receiveMetadata.providerConnectionEpoch ?? options.getProviderConnectionEpoch();
      if (!Number.isInteger(providerEpoch) || providerEpoch < 1) {
        fail('interaction_provider_epoch_conflict', { responseId });
        return;
      }
      const state: GeminiSyntheticInteractionEvidenceState = {
        binding: {
          schema: 'sophia_gemini_interaction_binding_v1',
          synthetic: true,
          test_run_id: options.syntheticTest.test_run_id,
          scenario_id: options.syntheticTest.scenario_id as string,
          scenario_version: options.syntheticTest.scenario_version as string,
          interaction_id: newInteractionId(),
          operation_id: pendingInput.binding.operation_id,
          utterance_id: pendingInput.binding.utterance_id,
          frame_window_id: pendingInput.binding.frame_window_id,
          provider_input_sequence: pendingInput.binding.provider_input_sequence as number,
          public_utterance_id: pendingInput.binding.public_utterance_id as string,
          public_user_turn_accepted_at: pendingInput.acceptedAt,
          response_id: responseId,
          assistant_turn_id: responseId,
          assistant_started_at: receiveMetadata.providerReceivedAt,
          provider_connection_epoch: providerEpoch,
        },
        providerFirstReceiveSequence: receiveMetadata.providerReceiveSequence,
        providerLastReceiveSequence: receiveMetadata.providerReceiveSequence,
        providerEventIds: new Set(),
        relayCorrelationIds: new Set(),
        toolCallIds: new Set(),
        effectIds: new Set(),
        toolFinalStates: new Map(),
        outputRealizationIds: new Set(),
        outputProviderChunkSequences: new Set(),
        outputReceivedRealizations: new Set(),
        outputScheduledRealizations: new Set(),
        outputStartedRealizations: new Set(),
        outputCompletedRealizations: new Set(),
        assistantEndedAt: null,
        responseBoundaryReason: null,
        emittedToolSignatures: new Set(),
        emittedOutputSettlements: new Set(),
      };
      pendingInput = null;
      activeResponseId = responseId;
      statesByResponse.set(responseId, state);
      statesByInput.set(key, state);
      hydratePendingTools(state);
      updateProviderEvent(state, event, receiveMetadata);
      while (statesByResponse.size > 64) {
        const oldestResponseId = statesByResponse.keys().next().value;
        if (typeof oldestResponseId !== 'string' || oldestResponseId === activeResponseId) break;
        const oldest = statesByResponse.get(oldestResponseId);
        statesByResponse.delete(oldestResponseId);
        if (oldest) statesByInput.delete(inputKey(oldest.binding));
      }
      emit(state, 'assistant_response_assigned');
    },
    finishProviderEvent: (event, receiveMetadata) => {
      if (stopped || faulted) return;
      const responseId = readGeminiStableResponseId(event);
      const state = stateForResponse(responseId);
      if (!state || state.assistantEndedAt !== null) return;
      const interrupted = isGeminiServerInterruptedEvent(event);
      const boundary = hasGeminiServerContentTurnBoundary(event);
      if (!interrupted && !boundary) return;
      if (!updateProviderEvent(state, event, receiveMetadata)) return;
      state.assistantEndedAt = receiveMetadata.providerReceivedAt;
      state.responseBoundaryReason = interrupted
        ? 'interrupted'
        : hasGeminiServerContentFlag(event, 'turnComplete', 'turn_complete')
          ? 'turn_complete'
          : 'generation_complete';
      if (activeResponseId === state.binding.response_id) activeResponseId = null;
      emit(
        state,
        interrupted ? 'assistant_response_interrupted' : 'assistant_response_completed',
      );
    },
    noteToolLedger: (entry) => {
      if (stopped || faulted || !entry.syntheticToolEvidence) return entry;
      const evidence = entry.syntheticToolEvidence;
      const key = inputKey(evidence);
      const pendingTools = pendingToolsByInput.get(key) ?? new Map<string, GeminiBrowserLiveToolCallLedgerEntry>();
      pendingTools.set(entry.toolCallId, entry);
      pendingToolsByInput.set(key, pendingTools);
      const state = statesByInput.get(key);
      if (!state) return entry;
      if (
        evidence.test_run_id !== state.binding.test_run_id
        || evidence.provider_connection_epoch !== state.binding.provider_connection_epoch
      ) {
        fail('interaction_provider_epoch_conflict', {
          operationId: evidence.operation_id,
          utteranceId: evidence.utterance_id,
          responseId: state.binding.response_id,
        });
        return entry;
      }
      state.toolCallIds.add(entry.toolCallId);
      state.effectIds.add(entry.effectId);
      if (isTerminalToolCallLedgerState(entry.finalState)) {
        state.toolFinalStates.set(entry.toolCallId, entry.finalState);
        const signature = `${entry.toolCallId}\0${entry.effectId}\0${entry.finalState}`;
        if (!state.emittedToolSignatures.has(signature)) {
          state.emittedToolSignatures.add(signature);
          emit(state, 'tool_settled');
        }
      }
      return { ...entry, syntheticInteraction: copyBinding(state.binding) };
    },
    noteOutputReceived: (diagnostic) => {
      const state = stateForResponse(diagnostic.responseId);
      if (!state || faulted || stopped) return diagnostic;
      addBounded(state.outputRealizationIds, diagnostic.realizationId);
      addBounded(state.outputProviderChunkSequences, diagnostic.providerChunkSequence);
      state.outputReceivedRealizations.add(diagnostic.realizationId);
      return { ...diagnostic, syntheticInteraction: copyBinding(state.binding) };
    },
    noteOutputChunk: (diagnostic) => {
      const state = stateForResponse(diagnostic.responseId);
      if (!state || faulted || stopped) return diagnostic;
      addBounded(state.outputRealizationIds, diagnostic.realizationId);
      addBounded(state.outputProviderChunkSequences, diagnostic.providerChunkSequence);
      return { ...diagnostic, syntheticInteraction: copyBinding(state.binding) };
    },
    noteOutputPlayback: (receipt) => {
      const state = stateForResponse(receipt.responseId);
      if (!state || faulted || stopped) return receipt;
      addBounded(state.outputRealizationIds, receipt.realizationId);
      addBounded(state.outputProviderChunkSequences, receipt.providerChunkSequence);
      if (receipt.phase === 'scheduled') state.outputScheduledRealizations.add(receipt.realizationId);
      if (receipt.phase === 'started') state.outputStartedRealizations.add(receipt.realizationId);
      if (receipt.phase === 'completed') {
        state.outputCompletedRealizations.add(receipt.realizationId);
        if (!state.emittedOutputSettlements.has(receipt.realizationId)) {
          state.emittedOutputSettlements.add(receipt.realizationId);
          emit(state, 'output_settled');
        }
      }
      return { ...receipt, syntheticInteraction: copyBinding(state.binding) };
    },
    bindingForResponse: (responseId) => {
      const state = stateForResponse(responseId);
      return state && !faulted && !stopped ? copyBinding(state.binding) : null;
    },
    stop: () => {
      stopped = true;
      pendingInput = null;
      activeResponseId = null;
      statesByResponse.clear();
      statesByInput.clear();
      pendingToolsByInput.clear();
    },
  };
}

function readSyntheticInputOperationSignal(
  value: unknown,
  expectedTestRunId: string,
  expectedCleanupObligationId: string,
): GeminiSyntheticInputOperationSignal {
  if (!isRecord(value)) {
    throw new GeminiSyntheticInputSignalError('input_operation_signal_malformed');
  }
  const allowed = new Set([
    'schema',
    'phase',
    'test_run_id',
    'cleanup_obligation_id',
    'operation_id',
    'utterance_id',
    'source_sha256',
    'expected_silence',
    'settlement_window_ms',
    'scheduled_context_time',
    'actual_context_time',
    'duration_seconds',
    'forwarded_frame_count',
    'reason',
  ]);
  const phases = new Set<GeminiSyntheticInputOperationPhase>([
    'scheduled',
    'started',
    'completed',
    'interrupted',
    'rejected',
  ]);
  const phase = value.phase;
  const expectedSilence = value.expected_silence;
  const settlementWindow = value.settlement_window_ms;
  if (
    value.test_run_id !== expectedTestRunId
    || value.cleanup_obligation_id !== expectedCleanupObligationId
  ) {
    throw new GeminiSyntheticInputSignalError('input_operation_signal_binding_mismatch');
  }
  if (
    value.schema !== 'sophia_voice_lab_input_operation_v1'
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof phase !== 'string'
    || !phases.has(phase as GeminiSyntheticInputOperationPhase)
    || typeof value.operation_id !== 'string'
    || !GEMINI_SYNTHETIC_SAFE_ID.test(value.operation_id)
    || typeof value.utterance_id !== 'string'
    || !GEMINI_SYNTHETIC_SAFE_ID.test(value.utterance_id)
    || typeof value.source_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.source_sha256)
    || (expectedSilence !== undefined && typeof expectedSilence !== 'boolean')
    || (
      settlementWindow !== undefined
      && (
        typeof settlementWindow !== 'number'
        || !Number.isInteger(settlementWindow)
        || settlementWindow < 1_000
        || settlementWindow > 15_000
      )
    )
  ) {
    throw new GeminiSyntheticInputSignalError('input_operation_signal_malformed');
  }
  return {
    schema: 'sophia_voice_lab_input_operation_v1',
    phase: phase as GeminiSyntheticInputOperationPhase,
    test_run_id: expectedTestRunId,
    operation_id: value.operation_id,
    utterance_id: value.utterance_id,
    source_sha256: value.source_sha256,
    expected_silence: typeof expectedSilence === 'boolean' ? expectedSilence : null,
    frame_window_id: `${value.operation_id}:${value.utterance_id}`,
    settlement_window_ms: typeof settlementWindow === 'number'
      ? settlementWindow
      : VOICE_LAB_INPUT_SETTLEMENT_MS,
  };
}

function createGeminiSyntheticInputEvidenceTracker(options: {
  syntheticTest: GeminiSyntheticTestContext;
  getProviderConnectionEpoch: () => number;
  onLegReceipt?: (receipt: GeminiSyntheticInputLegReceipt) => void;
  onTurnReceipt?: (receipt: GeminiSyntheticInputTurnReceipt) => void;
  onFaultReceipt?: (receipt: GeminiSyntheticInputFaultReceipt) => void;
  onAcceptedPublicUserTurn?: (
    binding: GeminiSyntheticInputOperationBinding,
    acceptedAt: string,
  ) => void;
  eventTarget?: EventTarget | null;
}): GeminiSyntheticInputEvidenceTracker {
  const states = new Map<string, GeminiSyntheticInputEvidenceState>();
  const subtle = globalThis.crypto?.subtle;
  const eventTarget = options.eventTarget ?? (typeof window === 'undefined' ? null : window);
  let stopped = false;
  let faulted = false;

  const keyFor = (signal: Pick<GeminiSyntheticInputOperationBinding, 'operation_id' | 'utterance_id'>) => (
    `${signal.operation_id}\0${signal.utterance_id}`
  );
  const binding = (state: GeminiSyntheticInputEvidenceState): GeminiSyntheticInputOperationBinding => ({
    schema: state.signal.schema,
    phase: state.signal.phase,
    test_run_id: state.signal.test_run_id,
    operation_id: state.signal.operation_id,
    utterance_id: state.signal.utterance_id,
    source_sha256: state.signal.source_sha256,
    expected_silence: state.signal.expected_silence,
    frame_window_id: state.signal.frame_window_id,
    provider_input_sequence: state.providerInputSequence,
    public_utterance_id: state.publicUtteranceId,
  });
  const fail = (code: GeminiSyntheticInputFaultReceipt['code']) => {
    if (stopped || faulted) return;
    faulted = true;
    options.onFaultReceipt?.({
      schema: 'sophia_gemini_input_fault_v1',
      synthetic: true,
      test_run_id: options.syntheticTest.test_run_id,
      code,
      observed_at: new Date().toISOString(),
      provider_connection_epoch: options.getProviderConnectionEpoch(),
      raw_audio_excluded: true,
    });
  };
  const activeState = () => {
    const active = [...states.values()].filter((state) => state.signal.phase === 'started');
    return active.length === 1 ? active[0] : null;
  };
  const correlationState = () => {
    const candidates = [...states.values()].filter((state) => (
      state.signal.phase === 'started'
      || (
        state.completedAt !== null
        && !state.settlementEmitted
        && state.signal.phase === 'completed'
      )
    ));
    if (candidates.length > 1) {
      fail('input_operation_turn_correlation_ambiguous');
      return null;
    }
    return candidates[0] ?? null;
  };
  const latestAcceptedState = () => {
    const accepted = [...states.values()].filter((state) => (
      state.providerInputObserved || state.publicUserTurnObserved
    ));
    return accepted.at(-1) ?? null;
  };
  const emitTurnReceipt = (
    state: GeminiSyntheticInputEvidenceState,
    source: GeminiSyntheticInputTurnReceipt['source'],
    outcome: GeminiSyntheticInputTurnReceipt['outcome'],
    detail: {
      providerReceiveSequence?: number | null;
      providerReceivedAt?: string | null;
      publicUtteranceId?: string | null;
      transcriptLength?: number | null;
      observedAt?: string;
    } = {},
  ) => {
    if (stopped) return;
    options.onTurnReceipt?.({
      schema: 'sophia_gemini_input_turn_v1',
      synthetic: true,
      test_run_id: state.signal.test_run_id,
      operation_id: state.signal.operation_id,
      utterance_id: state.signal.utterance_id,
      frame_window_id: state.signal.frame_window_id,
      expected_silence: state.signal.expected_silence,
      source,
      outcome,
      observed_at: detail.observedAt ?? new Date().toISOString(),
      provider_receive_sequence: detail.providerReceiveSequence ?? null,
      provider_received_at: detail.providerReceivedAt ?? null,
      public_utterance_id: detail.publicUtteranceId ?? null,
      transcript_length: detail.transcriptLength ?? null,
      settlement_window_ms: state.signal.settlement_window_ms,
      raw_audio_excluded: true,
    });
  };
  const scheduleSettlement = (state: GeminiSyntheticInputEvidenceState) => {
    if (state.settlementTimer !== null) clearTimeout(state.settlementTimer);
    state.settlementTimer = setTimeout(() => {
      state.settlementTimer = null;
      if (stopped || state.settlementEmitted) return;
      state.settlementEmitted = true;
      const turnObserved = state.providerInputObserved || state.publicUserTurnObserved;
      const outcome: GeminiSyntheticInputTurnReceipt['outcome'] = state.signal.expected_silence === true
        ? turnObserved ? 'unexpected_user_turn_observed' : 'no_user_turn_observed'
        : turnObserved ? 'user_turn_observed' : 'user_turn_unavailable';
      emitTurnReceipt(state, 'settlement', outcome);
    }, state.signal.settlement_window_ms);
  };
  const finishLeg = async (state: GeminiSyntheticInputEvidenceState) => {
    if (state.legReceiptEmitted) return;
    state.legReceiptEmitted = true;
    await state.digestPromise;
    if (stopped) return;
    const digest = !state.digestFailed && state.digestSequence > 0
      ? bytesToHex(state.digest)
      : null;
    const completedNormally = state.signal.phase === 'completed';
    const signalMatchesExpectation = state.signal.expected_silence === true
      ? state.sampleCount > 0 && state.nonzeroSampleCount === 0
      : state.nonzeroSampleCount > 0;
    const verified = completedNormally && digest !== null && signalMatchesExpectation;
    const reason = verified
      ? state.signal.expected_silence === true
        ? 'outgoing_pcm_silence_observed'
        : 'outgoing_pcm_non_silent_observed'
      : !completedNormally
        ? `input_operation_${state.signal.phase}`
        : state.frameCount === 0
          ? 'outgoing_pcm_frame_missing'
          : digest === null
            ? 'outgoing_pcm_digest_unavailable'
            : state.nonzeroSampleCount === 0
              ? state.signal.expected_silence === false
                ? 'outgoing_pcm_unexpected_zero_only'
                : 'outgoing_pcm_zero_only_expectation_unknown'
              : 'outgoing_pcm_unexpected_non_silence';
    options.onLegReceipt?.({
      schema: 'sophia_gemini_input_leg_v1',
      status: verified ? 'verified' : digest === null ? 'unavailable' : 'inconclusive',
      reason,
      synthetic: true,
      test_run_id: state.signal.test_run_id,
      operation_id: state.signal.operation_id,
      utterance_id: state.signal.utterance_id,
      source_sha256: state.signal.source_sha256,
      expected_silence: state.signal.expected_silence,
      frame_window_id: state.signal.frame_window_id,
      provider_connection_epoch: state.providerConnectionEpoch,
      first_audio_frame_sequence: state.firstAudioFrameSequence,
      last_audio_frame_sequence: state.lastAudioFrameSequence,
      frame_count: state.frameCount,
      sample_count: state.sampleCount,
      nonzero_sample_count: state.nonzeroSampleCount,
      byte_length: state.byteLength,
      pcm_rms: state.sampleCount > 0 ? Math.sqrt(state.squareSum / state.sampleCount) : null,
      pcm_peak: state.sampleCount > 0 ? state.peak : null,
      pcm_digest_algorithm: digest === null ? null : 'sha-256-chain-v1',
      pcm_sha256_chain: digest,
      started_at: state.startedAt,
      completed_at: state.completedAt ?? new Date().toISOString(),
      raw_audio_excluded: true,
    });
  };
  const handleSignal = (event: Event) => {
    if (stopped || faulted) return;
    let signal: GeminiSyntheticInputOperationSignal;
    try {
      signal = readSyntheticInputOperationSignal(
        (event as CustomEvent<unknown>).detail,
        options.syntheticTest.test_run_id,
        options.syntheticTest.cleanup_obligation_id,
      );
    } catch (error) {
      fail(
        error instanceof GeminiSyntheticInputSignalError
          ? error.code
          : 'input_operation_signal_malformed',
      );
      return;
    }
    const key = keyFor(signal);
    if (signal.phase === 'scheduled') {
      const existing = states.get(key);
      if (existing && existing.signal.source_sha256 !== signal.source_sha256) {
        fail('input_operation_signal_binding_mismatch');
        return;
      }
      if (!existing) {
        states.set(key, {
          signal,
          startedAt: new Date().toISOString(),
          completedAt: null,
          providerConnectionEpoch: options.getProviderConnectionEpoch(),
          firstAudioFrameSequence: null,
          lastAudioFrameSequence: null,
          frameCount: 0,
          sampleCount: 0,
          nonzeroSampleCount: 0,
          byteLength: 0,
          squareSum: 0,
          peak: 0,
          digest: new Uint8Array(32),
          digestSequence: 0,
          digestPromise: Promise.resolve(),
          digestFailed: subtle === undefined,
          legReceiptEmitted: false,
          providerInputObserved: false,
          providerInputSequence: null,
          publicUserTurnObserved: false,
          publicUtteranceId: null,
          publicUserTurnAcceptedAt: null,
          settlementEmitted: false,
          settlementTimer: null,
        });
      }
      return;
    }
    const state = states.get(key);
    if (!state || state.signal.source_sha256 !== signal.source_sha256) {
      fail('input_operation_phase_invalid');
      return;
    }
    if (signal.phase === 'started') {
      if (state.signal.phase === 'started') return;
      if (state.signal.phase !== 'scheduled') {
        fail('input_operation_phase_invalid');
        return;
      }
      const unresolvedOther = [...states.values()].some((candidate) => (
        candidate !== state
        && (
          candidate.signal.phase === 'started'
          || (candidate.signal.phase === 'completed' && !candidate.settlementEmitted)
        )
      ));
      if (unresolvedOther) {
        fail('input_operation_overlap_forbidden');
        return;
      }
      state.signal = signal;
      state.startedAt = new Date().toISOString();
      state.providerConnectionEpoch = options.getProviderConnectionEpoch();
      return;
    }
    if (state.signal.phase === signal.phase && state.completedAt !== null) return;
    if (
      (signal.phase === 'completed' || signal.phase === 'interrupted')
      && state.signal.phase !== 'started'
    ) {
      fail('input_operation_phase_invalid');
      return;
    }
    if (signal.phase === 'rejected' && state.signal.phase !== 'scheduled') {
      fail('input_operation_phase_invalid');
      return;
    }
    state.signal = signal;
    state.completedAt = new Date().toISOString();
    void finishLeg(state);
    scheduleSettlement(state);
  };
  eventTarget?.addEventListener(VOICE_LAB_INPUT_OPERATION_EVENT, handleSignal);

  return {
    observePcmFrame: (bytes, audioFrameSequence) => {
      if (faulted) return null;
      const state = activeState();
      if (!state) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let squareSum = 0;
      let peak = 0;
      let nonzero = 0;
      const sampleCount = Math.floor(bytes.byteLength / 2);
      for (let index = 0; index < sampleCount; index += 1) {
        const pcm = view.getInt16(index * 2, true);
        const sample = pcm / (pcm < 0 ? 32768 : 32767);
        const absolute = Math.abs(sample);
        if (pcm !== 0) nonzero += 1;
        squareSum += sample * sample;
        peak = Math.max(peak, absolute);
      }
      state.firstAudioFrameSequence ??= audioFrameSequence;
      state.lastAudioFrameSequence = audioFrameSequence;
      state.frameCount += 1;
      state.sampleCount += sampleCount;
      state.nonzeroSampleCount += nonzero;
      state.byteLength += bytes.byteLength;
      state.squareSum += squareSum;
      state.peak = Math.max(state.peak, peak);
      if (subtle) {
        const frameBytes = bytes.slice();
        state.digestSequence += 1;
        const sequence = state.digestSequence;
        state.digestPromise = state.digestPromise.then(async () => {
          try {
            const frameDigest = new Uint8Array(
              await subtle.digest('SHA-256', frameBytes.buffer as ArrayBuffer),
            );
            const chained = new Uint8Array(68);
            chained.set(state.digest, 0);
            chained.set(frameDigest, 32);
            new DataView(chained.buffer).setUint32(64, sequence, false);
            state.digest = new Uint8Array(
              await subtle.digest('SHA-256', chained.buffer as ArrayBuffer),
            );
          } catch {
            state.digestFailed = true;
          }
        });
      }
      return {
        binding: binding(state),
        diagnostic: {
          sample_count: sampleCount,
          nonzero_sample_count: nonzero,
          rms: sampleCount > 0 ? Math.sqrt(squareSum / sampleCount) : 0,
          peak,
          byte_length: bytes.byteLength,
          raw_audio_excluded: true,
        },
      };
    },
    currentBinding: () => {
      if (faulted) return null;
      const state = correlationState();
      return state ? binding(state) : null;
    },
    latestAcceptedBinding: () => {
      if (faulted) return null;
      const state = correlationState() ?? latestAcceptedState();
      return state ? binding(state) : null;
    },
    noteProviderInputTranscription: (receiveMetadata, transcriptLength) => {
      if (faulted) return;
      const state = correlationState();
      if (!state || state.providerInputObserved) return;
      state.providerInputObserved = true;
      state.providerInputSequence = receiveMetadata.providerReceiveSequence;
      emitTurnReceipt(
        state,
        'provider_input_transcription',
        state.signal.expected_silence === true
          ? 'unexpected_user_turn_observed'
          : 'provider_input_transcription_observed',
        {
          providerReceiveSequence: receiveMetadata.providerReceiveSequence,
          providerReceivedAt: receiveMetadata.providerReceivedAt,
          transcriptLength,
        },
      );
      if (state.publicUserTurnObserved && state.publicUserTurnAcceptedAt !== null) {
        options.onAcceptedPublicUserTurn?.(binding(state), state.publicUserTurnAcceptedAt);
      }
    },
    notePublicUserTurn: (input) => {
      if (faulted) return;
      const state = correlationState();
      if (!state || state.publicUserTurnObserved) return;
      state.publicUserTurnObserved = true;
      state.publicUtteranceId = input.publicUtteranceId ?? null;
      const acceptedAt = new Date().toISOString();
      state.publicUserTurnAcceptedAt = acceptedAt;
      emitTurnReceipt(
        state,
        'public_user_turn',
        state.signal.expected_silence === true
          ? 'unexpected_user_turn_observed'
          : 'public_user_turn_accepted',
        {
          publicUtteranceId: input.publicUtteranceId,
          transcriptLength: input.transcriptLength,
          observedAt: acceptedAt,
        },
      );
      if (state.signal.expected_silence !== true) {
        options.onAcceptedPublicUserTurn?.(binding(state), acceptedAt);
      }
    },
    stop: () => {
      stopped = true;
      eventTarget?.removeEventListener(VOICE_LAB_INPUT_OPERATION_EVENT, handleSignal);
      for (const state of states.values()) {
        if (state.settlementTimer !== null) clearTimeout(state.settlementTimer);
      }
      states.clear();
    },
  };
}

function startMicrophoneAudioPipeline(options: {
  localStream: MediaStream;
  audioContext: AudioContext;
  websocketRef: { current: WebSocketLike | null };
  recordingInputNode?: AudioNode;
  onInputAudioActivity?: (diagnostic: GeminiInputAudioActivityDiagnostic) => void;
  microphoneAudioSettings?: GeminiMicrophoneAudioSettingsDiagnostic;
  syntheticInputEvidence?: GeminiSyntheticInputEvidenceTracker | null;
}): AudioPipeline {
  const source = options.audioContext.createMediaStreamSource(options.localStream);
  const processor = options.audioContext.createScriptProcessor(4096, 1, 1);
  let muted = false;
  let audioStreamEndSent = false;
  let localSequence = 0;
  let audioFrameSequence = 0;
  let framesSinceLastDiagnostic = 0;

  const emitInputAudioActivity = (
    eventType: GeminiInputAudioActivityEventType,
    diagnostic: Partial<GeminiInputAudioActivityDiagnostic> = {},
  ) => {
    if (!options.onInputAudioActivity) {
      return;
    }
    localSequence += 1;
    options.onInputAudioActivity({
      eventType,
      recordedAt: new Date().toISOString(),
      localSequence,
      audioFrameSequence: null,
      framesRepresented: null,
      micState: muted ? 'muted' : 'unmuted',
      frameByteLength: null,
      frameDurationMs: null,
      audioStreamEndSent,
      trigger: 'audio_pipeline',
      ...diagnostic,
    });
  };

  if (options.microphoneAudioSettings) {
    emitInputAudioActivity('microphone_settings_recorded', {
      trigger: 'microphone_track_settings',
      microphoneAudioSettings: options.microphoneAudioSettings,
    });
  }

  const sendAudioStreamEnd = (trigger: string) => {
    const websocket = options.websocketRef.current;
    if (!websocket || websocket.readyState !== WEBSOCKET_OPEN || audioStreamEndSent) {
      return;
    }
    websocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    audioStreamEndSent = true;
    emitInputAudioActivity('input_audio_stream_end_sent', {
      audioFrameSequence,
      framesRepresented: framesSinceLastDiagnostic || null,
      audioStreamEndSent: true,
      trigger,
    });
  };

  processor.onaudioprocess = (event) => {
    const outputBuffer = event.outputBuffer;
    for (let channel = 0; channel < outputBuffer.numberOfChannels; channel += 1) {
      outputBuffer.getChannelData(channel).fill(0);
    }

    const websocket = options.websocketRef.current;
    if (!websocket || websocket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    if (muted) {
      sendAudioStreamEnd('muted_audio_process');
      return;
    }

    const syntheticInputOperation = options.syntheticInputEvidence?.currentBinding() ?? null;
    if (options.syntheticInputEvidence && syntheticInputOperation?.phase !== 'started') {
      if (
        syntheticInputOperation?.phase === 'completed'
        || syntheticInputOperation?.phase === 'interrupted'
      ) {
        sendAudioStreamEnd(`synthetic_input_operation_${syntheticInputOperation.phase}`);
      }
      return;
    }
    audioStreamEndSent = false;

    const input = event.inputBuffer.getChannelData(0);
    const data = pcm16Base64FromFloat32(input, options.audioContext.sampleRate, INPUT_AUDIO_RATE_HZ);
    if (!data) {
      return;
    }
    audioFrameSequence += 1;
    framesSinceLastDiagnostic += 1;
    const exactPcmBytes = options.syntheticInputEvidence ? base64ToBytes(data) : null;
    const syntheticPcm = exactPcmBytes
      ? options.syntheticInputEvidence?.observePcmFrame(exactPcmBytes, audioFrameSequence) ?? null
      : null;

    websocket.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data,
          mimeType: `audio/pcm;rate=${INPUT_AUDIO_RATE_HZ}`,
        },
      },
    }));

    if (shouldEmitInputAudioFrameDiagnostic(audioFrameSequence)) {
      emitInputAudioActivity('input_audio_frame_sent', {
        audioFrameSequence,
        framesRepresented: framesSinceLastDiagnostic,
        frameByteLength: estimatePcm16ByteLength(input.length, options.audioContext.sampleRate, INPUT_AUDIO_RATE_HZ),
        frameDurationMs: Math.round((input.length / options.audioContext.sampleRate) * 1000),
        audioStreamEndSent: false,
        trigger: 'audio_process',
        syntheticInputOperation: syntheticPcm?.binding ?? null,
        outgoingPcm: syntheticPcm?.diagnostic ?? null,
      });
      framesSinceLastDiagnostic = 0;
    }
  };

  source.connect(processor);
  processor.connect(options.audioContext.destination);
  if (options.recordingInputNode) {
    source.connect(options.recordingInputNode);
  }

  return {
    setMuted: (nextMuted: boolean) => {
      const wasMuted = muted;
      muted = nextMuted;
      if (!muted) {
        audioStreamEndSent = false;
        if (wasMuted) {
          emitInputAudioActivity('manual_mute_off', {
            audioFrameSequence,
            trigger: 'set_muted',
          });
        }
        return;
      }
      if (!wasMuted) {
        emitInputAudioActivity('manual_mute_on', {
          audioFrameSequence,
          trigger: 'set_muted',
        });
        emitInputAudioActivity('input_audio_stream_paused', {
          audioFrameSequence,
          framesRepresented: framesSinceLastDiagnostic || null,
          trigger: 'set_muted',
        });
      }
      sendAudioStreamEnd('set_muted');
    },
    stop: async () => {
      processor.disconnect();
      source.disconnect();
      await options.audioContext.close().catch(() => undefined);
    },
  };
}

function shouldEmitInputAudioFrameDiagnostic(audioFrameSequence: number): boolean {
  return audioFrameSequence <= 12 || audioFrameSequence % 25 === 0;
}

function estimatePcm16ByteLength(sourceSampleCount: number, sourceRate: number, targetRate: number): number {
  const targetSampleCount = Math.max(0, Math.floor(sourceSampleCount * targetRate / sourceRate));
  return targetSampleCount * 2;
}

export function createGeminiOutputAudioPlaybackController(
  audioContext: AudioContext,
  options: GeminiOutputAudioPlaybackControllerOptions = {},
): GeminiOutputAudioPlaybackController {
  interface PendingAudioChunk {
    chunk: string;
    samples: Float32Array<ArrayBuffer>;
    metadata: GeminiOutputAudioChunkMetadata;
    decodeStartedAt: string;
    decodeCompletedAt: string;
    playbackGeneration: number;
  }

  interface ActiveAudioSource {
    pending: PendingAudioChunk;
    scheduledStartTime: number;
    durationSeconds: number;
    startReceiptEmitted: boolean;
    startReceiptTimer: ReturnType<typeof setTimeout> | null;
  }

  interface RecentTransportFingerprint {
    seenAtMs: number;
    eventId: string | null;
    responseId: string | null;
    providerConnectionEpoch: number | null;
    suppressions: number;
  }

  let nextPlaybackTime = 0;
  const activeSources = new Map<AudioBufferSourceNode, ActiveAudioSource>();
  const pendingChunks: PendingAudioChunk[] = [];
  const chunkHashCounts = new Map<string, number>();
  const recentTransportFingerprints = new Map<string, RecentTransportFingerprint>();
  let diagnosticsEmitted = 0;
  let playbackGeneration = 0;
  let localChunkSequence = 0;
  const maxPlaybackAheadSeconds = Math.max(
    0.05,
    options.maxPlaybackAheadSeconds ?? DEFAULT_OUTPUT_AUDIO_MAX_PLAYBACK_AHEAD_SECONDS,
  );
  const maxQueuedChunks = Math.max(1, Math.floor(options.maxQueuedChunks ?? DEFAULT_OUTPUT_AUDIO_MAX_QUEUED_CHUNKS));
  const duplicateReplayWindowMs = Math.max(
    0,
    options.duplicateReplayWindowMs ?? DEFAULT_OUTPUT_AUDIO_DUPLICATE_REPLAY_WINDOW_MS,
  );
  const nowMs = options.nowMs ?? monotonicNowMs;

  const emitChunkDiagnostic = (diagnostic: GeminiOutputAudioChunkDiagnostic) => {
    if (!options.onChunkDiagnostic) {
      return;
    }
    const maxDiagnostics = options.maxDiagnostics ?? Number.POSITIVE_INFINITY;
    if (diagnosticsEmitted >= maxDiagnostics) {
      return;
    }
    diagnosticsEmitted += 1;
    options.onChunkDiagnostic(diagnostic);
  };

  const playbackAheadSeconds = () => {
    const currentTime = Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0;
    return Math.max(0, nextPlaybackTime - currentTime);
  };

  const snapshot = (): GeminiOutputAudioPlaybackState => ({
    nextPlaybackTime,
    activeSourceCount: activeSources.size,
    playbackGeneration,
    queuedChunkCount: pendingChunks.length,
    playbackAheadSeconds: playbackAheadSeconds(),
  });

  const nextChunkDuplicateOrdinal = (chunkHash: string) => {
    const duplicateOrdinal = (chunkHashCounts.get(chunkHash) ?? 0) + 1;
    if (chunkHashCounts.has(chunkHash)) {
      chunkHashCounts.delete(chunkHash);
    }
    chunkHashCounts.set(chunkHash, duplicateOrdinal);
    while (chunkHashCounts.size > MAX_AUDIO_CHUNK_HASH_COUNTS) {
      const oldest = chunkHashCounts.keys().next().value;
      if (typeof oldest !== 'string') break;
      chunkHashCounts.delete(oldest);
    }
    return duplicateOrdinal;
  };

  const createChunkMetadata = (
    chunk: string,
    chunkIndex: number,
    chunksInEvent: number,
    receiveMetadata?: GeminiProviderReceiveMetadata,
    event?: Record<string, unknown>,
  ): GeminiOutputAudioChunkMetadata => {
    const chunkHash = hashGeminiOutputAudioChunk(chunk);
    const duplicateOrdinal = nextChunkDuplicateOrdinal(chunkHash);
    const responseId = event ? readGeminiStableResponseId(event) : null;
    const providerEventId = event ? readGeminiProviderEventId(event) : null;
    if (!receiveMetadata) {
      localChunkSequence += 1;
    }
    const realizationId = receiveMetadata
      ? [
          'gemini-output',
          receiveMetadata.providerConnectionEpoch ?? 0,
          receiveMetadata.providerReceiveSequence,
          chunkIndex,
          chunkHash,
          duplicateOrdinal,
        ].join('-')
      : ['gemini-output-local', playbackGeneration, localChunkSequence, chunkHash, duplicateOrdinal].join('-');
    const providerChunkSequence = receiveMetadata
      ? [
          receiveMetadata.providerConnectionEpoch ?? 0,
          receiveMetadata.providerReceiveSequence,
          chunkIndex,
        ].join(':')
      : ['local', playbackGeneration, localChunkSequence, chunkIndex].join(':');
    return {
      receiveMetadata,
      responseId,
      assistantTurnId: responseId,
      providerEventId,
      chunkIndex,
      chunksInEvent,
      chunkHash,
      byteLength: estimatedBase64DecodedByteLength(chunk),
      duplicateOrdinal,
      realizationId,
      providerChunkSequence,
    };
  };

  const emitPlaybackReceipt = (
    phase: GeminiOutputAudioPlaybackReceiptPhase,
    chunk: string,
    metadata: GeminiOutputAudioChunkMetadata,
    receiptPlaybackGeneration: number,
    details: {
      timestamp?: string;
      scheduledStartTime?: number | null;
      durationSeconds?: number;
      dropReason?: GeminiOutputAudioDropReason | null;
      flushReason?: string | null;
      invalidatedByPlaybackGeneration?: number | null;
    } = {},
  ) => {
    const receiveMetadata = metadata.receiveMetadata;
    options.onPlaybackReceipt?.({
      timestamp: details.timestamp ?? new Date().toISOString(),
      phase,
      realizationId: metadata.realizationId,
      providerChunkSequence: metadata.providerChunkSequence,
      responseId: metadata.responseId,
      assistantTurnId: metadata.assistantTurnId,
      providerEventId: metadata.providerEventId,
      providerReceiveSequence: receiveMetadata?.providerReceiveSequence ?? null,
      providerRelaySequence: receiveMetadata?.providerRelaySequence ?? null,
      providerConnectionEpoch: receiveMetadata?.providerConnectionEpoch ?? null,
      providerReceivedAt: receiveMetadata?.providerReceivedAt ?? null,
      relayCorrelationId: receiveMetadata?.relayCorrelationId ?? null,
      chunkIndex: metadata.chunkIndex,
      chunksInEvent: metadata.chunksInEvent,
      chunkHash: metadata.chunkHash,
      byteLength: metadata.byteLength,
      playbackGeneration: receiptPlaybackGeneration,
      invalidatedByPlaybackGeneration: details.invalidatedByPlaybackGeneration ?? null,
      audioContextCurrentTime: Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0,
      scheduledStartTime: details.scheduledStartTime ?? null,
      durationSeconds: details.durationSeconds ?? 0,
      dropReason: details.dropReason ?? null,
      flushReason: details.flushReason ?? null,
    });
  };

  const finishOutputLegMonitor = (
    active: ActiveAudioSource,
    phase: 'completed' | 'flushed',
    completedAt: string,
  ) => {
    const monitor = options.outputLegMonitor;
    if (!monitor) return;
    void monitor.finish(
      active.pending.metadata.realizationId,
      phase,
      completedAt,
      active.durationSeconds,
    ).then((receipt) => options.onOutputLegMonitorReceipt?.(receipt));
  };

  const emitUnscheduledChunkDiagnostic = (
    chunk: string,
    metadata: GeminiOutputAudioChunkMetadata,
    dropReason: GeminiOutputAudioDropReason,
    decodeStartedAt = new Date().toISOString(),
    decodeCompletedAt = decodeStartedAt,
  ) => {
    const currentTime = Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0;
    emitChunkDiagnostic({
      timestamp: decodeCompletedAt,
      realizationId: metadata.realizationId,
      responseId: metadata.responseId,
      assistantTurnId: metadata.assistantTurnId,
      providerEventId: metadata.providerEventId,
      providerChunkSequence: metadata.providerChunkSequence,
      providerReceiveSequence: metadata?.receiveMetadata?.providerReceiveSequence ?? null,
      providerRelaySequence: metadata?.receiveMetadata?.providerRelaySequence ?? null,
      providerConnectionEpoch: metadata?.receiveMetadata?.providerConnectionEpoch ?? null,
      providerReceivedAt: metadata?.receiveMetadata?.providerReceivedAt ?? null,
      relayCorrelationId: metadata?.receiveMetadata?.relayCorrelationId ?? null,
      chunkIndex: metadata?.chunkIndex ?? null,
      chunksInEvent: metadata?.chunksInEvent ?? null,
      chunkHash: metadata?.chunkHash ?? null,
      byteLength: metadata?.byteLength ?? null,
      base64Length: chunk.length,
      duplicateOrdinal: metadata?.duplicateOrdinal ?? null,
      decodeStartedAt,
      decodeCompletedAt,
      sourceStartIssuedAt: null,
      audioContextCurrentTime: currentTime,
      scheduledStartTime: null,
      durationSeconds: 0,
      nextPlaybackTimeBefore: nextPlaybackTime,
      nextPlaybackTimeAfter: nextPlaybackTime,
      activeSourceCountBefore: activeSources.size,
      activeSourceCountAfter: activeSources.size,
      playbackGeneration,
      audioContextState: typeof audioContext.state === 'string' ? audioContext.state : null,
      dropReason,
      scheduled: false,
    });
    emitPlaybackReceipt('dropped', chunk, metadata, playbackGeneration, {
      timestamp: decodeCompletedAt,
      dropReason,
    });
  };

  const emitStartedReceipt = (source: AudioBufferSourceNode, active: ActiveAudioSource) => {
    if (active.startReceiptEmitted || !activeSources.has(source)) {
      return;
    }
    active.startReceiptEmitted = true;
    active.startReceiptTimer = null;
    const startedAt = new Date().toISOString();
    options.outputLegMonitor?.markStarted(
      active.pending.metadata.realizationId,
      startedAt,
    );
    emitPlaybackReceipt(
      'started',
      active.pending.chunk,
      active.pending.metadata,
      active.pending.playbackGeneration,
      {
        timestamp: startedAt,
        scheduledStartTime: active.scheduledStartTime,
        durationSeconds: active.durationSeconds,
      },
    );
  };

  const observeScheduledSourceStart = (source: AudioBufferSourceNode, active: ActiveAudioSource) => {
    const currentTime = Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0;
    if (audioContext.state !== 'running' || currentTime + 0.001 < active.scheduledStartTime) {
      active.startReceiptTimer = null;
      return;
    }
    emitStartedReceipt(source, active);
  };

  const schedulePendingChunks = () => {
    while (pendingChunks.length > 0) {
      const currentTime = Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0;
      const queuedAheadSeconds = Math.max(0, nextPlaybackTime - currentTime);
      const nextChunkDuration = (pendingChunks[0]?.samples.length ?? 0) / OUTPUT_AUDIO_RATE_HZ;
      if (
        activeSources.size > 0
        && queuedAheadSeconds + nextChunkDuration > maxPlaybackAheadSeconds
      ) {
        return;
      }
      const pending = pendingChunks.shift();
      if (!pending) {
        return;
      }
      const nextPlaybackTimeBefore = nextPlaybackTime;
      const activeSourceCountBefore = activeSources.size;
      const buffer = audioContext.createBuffer(1, pending.samples.length, OUTPUT_AUDIO_RATE_HZ);
      buffer.copyToChannel(pending.samples, 0);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      const startAt = Math.max(currentTime, nextPlaybackTime);
      const duration = Number.isFinite(buffer.duration) && buffer.duration > 0
        ? buffer.duration
        : pending.samples.length / OUTPUT_AUDIO_RATE_HZ;
      const sourceStartIssuedAt = new Date().toISOString();
      const downstreamNode = options.outputNode ?? audioContext.destination;
      const monitoredOutputNode = options.outputLegMonitor?.begin({
        realizationId: pending.metadata.realizationId,
        providerChunkFingerprint: pending.metadata.chunkHash,
        providerConnectionEpoch: pending.metadata.receiveMetadata?.providerConnectionEpoch ?? null,
        playbackGeneration: pending.playbackGeneration,
        scheduledAt: sourceStartIssuedAt,
      }, downstreamNode) ?? downstreamNode;
      source.connect(monitoredOutputNode);
      const active: ActiveAudioSource = {
        pending,
        scheduledStartTime: startAt,
        durationSeconds: duration,
        startReceiptEmitted: false,
        startReceiptTimer: null,
      };
      activeSources.set(source, active);
      source.onended = () => {
        const completed = activeSources.get(source);
        if (!completed) {
          return;
        }
        if (completed.startReceiptTimer !== null) {
          clearTimeout(completed.startReceiptTimer);
        }
        // A natural onended callback proves that the source crossed its start
        // boundary even if a throttled timer did not run in time.
        emitStartedReceipt(source, completed);
        activeSources.delete(source);
        source.disconnect();
        const completedAt = new Date().toISOString();
        emitPlaybackReceipt(
          'completed',
          completed.pending.chunk,
          completed.pending.metadata,
          completed.pending.playbackGeneration,
          {
            timestamp: completedAt,
            scheduledStartTime: completed.scheduledStartTime,
            durationSeconds: completed.durationSeconds,
          },
        );
        finishOutputLegMonitor(completed, 'completed', completedAt);
        if (activeSources.size === 0 && nextPlaybackTime < audioContext.currentTime) {
          nextPlaybackTime = audioContext.currentTime;
        }
        schedulePendingChunks();
      };
      source.start(startAt);
      nextPlaybackTime = startAt + duration;
      emitChunkDiagnostic({
        timestamp: sourceStartIssuedAt,
        realizationId: pending.metadata.realizationId,
        responseId: pending.metadata.responseId,
        assistantTurnId: pending.metadata.assistantTurnId,
        providerEventId: pending.metadata.providerEventId,
        providerChunkSequence: pending.metadata.providerChunkSequence,
        providerReceiveSequence: pending.metadata?.receiveMetadata?.providerReceiveSequence ?? null,
        providerRelaySequence: pending.metadata?.receiveMetadata?.providerRelaySequence ?? null,
        providerConnectionEpoch: pending.metadata?.receiveMetadata?.providerConnectionEpoch ?? null,
        providerReceivedAt: pending.metadata?.receiveMetadata?.providerReceivedAt ?? null,
        relayCorrelationId: pending.metadata?.receiveMetadata?.relayCorrelationId ?? null,
        chunkIndex: pending.metadata?.chunkIndex ?? null,
        chunksInEvent: pending.metadata?.chunksInEvent ?? null,
        chunkHash: pending.metadata?.chunkHash ?? null,
        byteLength: pending.metadata?.byteLength ?? null,
        base64Length: pending.chunk.length,
        duplicateOrdinal: pending.metadata?.duplicateOrdinal ?? null,
        decodeStartedAt: pending.decodeStartedAt,
        decodeCompletedAt: pending.decodeCompletedAt,
        sourceStartIssuedAt,
        audioContextCurrentTime: currentTime,
        scheduledStartTime: startAt,
        durationSeconds: duration,
        nextPlaybackTimeBefore,
        nextPlaybackTimeAfter: nextPlaybackTime,
        activeSourceCountBefore,
        activeSourceCountAfter: activeSources.size,
        playbackGeneration,
        audioContextState: typeof audioContext.state === 'string' ? audioContext.state : null,
        dropReason: null,
        scheduled: true,
      });
      emitPlaybackReceipt('scheduled', pending.chunk, pending.metadata, pending.playbackGeneration, {
        timestamp: sourceStartIssuedAt,
        scheduledStartTime: startAt,
        durationSeconds: duration,
      });
      const startDelayMs = Math.max(0, Math.ceil((startAt - currentTime) * 1000));
      if (startDelayMs === 0) {
        observeScheduledSourceStart(source, active);
      } else {
        active.startReceiptTimer = setTimeout(
          () => observeScheduledSourceStart(source, active),
          startDelayMs + 1,
        );
      }
    }
  };

  const enqueueBase64Chunk = (chunk: string, metadata: GeminiOutputAudioChunkMetadata): boolean => {
    const decodeStartedAt = new Date().toISOString();
    const samples = pcm16BytesToFloat32(base64ToBytes(chunk));
    const decodeCompletedAt = new Date().toISOString();
    if (!samples.length) {
      emitUnscheduledChunkDiagnostic(chunk, metadata, 'invalid_pcm_payload', decodeStartedAt, decodeCompletedAt);
      return false;
    }
    if (pendingChunks.length >= maxQueuedChunks) {
      emitUnscheduledChunkDiagnostic(chunk, metadata, 'playback_queue_full', decodeStartedAt, decodeCompletedAt);
      return false;
    }
    pendingChunks.push({
      chunk,
      samples,
      metadata,
      decodeStartedAt,
      decodeCompletedAt,
      playbackGeneration,
    });
    schedulePendingChunks();
    return true;
  };

  const isExactTransportReplay = (
    event: Record<string, unknown>,
    chunks: string[],
    receiveMetadata?: GeminiProviderReceiveMetadata,
  ) => {
    const responseId = readGeminiStableResponseId(event);
    const eventId = readGeminiProviderEventId(event);
    const providerConnectionEpoch = receiveMetadata?.providerConnectionEpoch ?? null;
    const fingerprint = hashGeminiOutputAudioChunk([
      responseId ?? 'response:none',
      chunks.length.toString(),
      ...chunks.map(hashGeminiOutputAudioChunk),
    ].join('|'));
    const observedAtMs = nowMs();
    const previous = recentTransportFingerprints.get(fingerprint);
    const withinWindow = previous !== undefined
      && observedAtMs - previous.seenAtMs >= 0
      && observedAtMs - previous.seenAtMs <= duplicateReplayWindowMs;
    const stableEventReplay = Boolean(eventId && previous?.eventId === eventId);
    const crossEpochReplay = previous?.providerConnectionEpoch !== null
      && providerConnectionEpoch !== null
      && previous?.providerConnectionEpoch !== providerConnectionEpoch;
    const suppress = Boolean(
      previous
      && withinWindow
      && previous.responseId === responseId
      && (stableEventReplay || crossEpochReplay)
    );
    const nextRecord: RecentTransportFingerprint = suppress && previous
      ? { ...previous, suppressions: previous.suppressions + 1 }
      : { seenAtMs: observedAtMs, eventId, responseId, providerConnectionEpoch, suppressions: 0 };
    recentTransportFingerprints.delete(fingerprint);
    recentTransportFingerprints.set(fingerprint, nextRecord);
    while (recentTransportFingerprints.size > MAX_RECENT_AUDIO_TRANSPORT_FINGERPRINTS) {
      const oldest = recentTransportFingerprints.keys().next().value;
      if (typeof oldest !== 'string') break;
      recentTransportFingerprints.delete(oldest);
    }
    return suppress;
  };

  const flush = (reason = 'unspecified'): GeminiOutputAudioPlaybackState => {
    const invalidatedByPlaybackGeneration = playbackGeneration + 1;
    for (const pending of pendingChunks.splice(0, pendingChunks.length)) {
      emitPlaybackReceipt('flushed', pending.chunk, pending.metadata, pending.playbackGeneration, {
        flushReason: reason,
        invalidatedByPlaybackGeneration,
      });
    }
    for (const [source, active] of activeSources) {
      source.onended = null;
      if (active.startReceiptTimer !== null) {
        clearTimeout(active.startReceiptTimer);
      }
      const flushedAt = new Date().toISOString();
      emitPlaybackReceipt('flushed', active.pending.chunk, active.pending.metadata, active.pending.playbackGeneration, {
        timestamp: flushedAt,
        scheduledStartTime: active.scheduledStartTime,
        durationSeconds: active.durationSeconds,
        flushReason: reason,
        invalidatedByPlaybackGeneration,
      });
      finishOutputLegMonitor(active, 'flushed', flushedAt);
      try {
        source.stop();
      } catch {
        // Source may already have ended; disconnect is still safe below.
      }
      source.disconnect();
    }
    activeSources.clear();
    nextPlaybackTime = 0;
    playbackGeneration = invalidatedByPlaybackGeneration;
    return snapshot();
  };

  const processEventChunks = (
    event: Record<string, unknown>,
    receiveMetadata: GeminiProviderReceiveMetadata | undefined,
    onChunk: (chunk: string, metadata: GeminiOutputAudioChunkMetadata) => boolean,
  ) => {
    let accepted = 0;
    const chunks = readGeminiOutputAudioChunks(event);
    chunks.forEach((chunk, index) => {
      const metadata = createChunkMetadata(chunk, index, chunks.length, receiveMetadata, event);
      if (receiveMetadata) {
        options.onChunkReceived?.({
          timestamp: new Date().toISOString(),
          realizationId: metadata.realizationId,
          providerChunkSequence: metadata.providerChunkSequence,
          providerReceiveSequence: receiveMetadata.providerReceiveSequence,
          providerRelaySequence: receiveMetadata.providerRelaySequence ?? null,
          providerConnectionEpoch: receiveMetadata.providerConnectionEpoch ?? null,
          providerReceivedAt: receiveMetadata.providerReceivedAt,
          relayCorrelationId: receiveMetadata.relayCorrelationId,
          responseId: metadata.responseId,
          assistantTurnId: metadata.assistantTurnId,
          providerEventId: metadata.providerEventId,
          chunkIndex: metadata.chunkIndex,
          chunksInEvent: metadata.chunksInEvent,
          chunkHash: metadata.chunkHash,
          byteLength: metadata.byteLength,
          duplicateOrdinal: metadata.duplicateOrdinal,
          playbackGeneration,
        });
      }
      if (onChunk(chunk, metadata)) {
        accepted += 1;
      }
    });
    return accepted;
  };

  return {
    playEvent: (event, receiveMetadata) => {
      const chunks = readGeminiOutputAudioChunks(event);
      const replaySuppressed = chunks.length > 0 && isExactTransportReplay(event, chunks, receiveMetadata);
      return processEventChunks(event, receiveMetadata, (chunk, metadata) => {
        if (replaySuppressed) {
          emitUnscheduledChunkDiagnostic(chunk, metadata, 'exact_transport_replay');
          return false;
        }
        return enqueueBase64Chunk(chunk, metadata);
      });
    },
    playBase64Chunk: (chunk) => enqueueBase64Chunk(
      chunk,
      createChunkMetadata(chunk, 0, 1),
    ),
    dropEvent: (event, receiveMetadata, reason) => processEventChunks(
      event,
      receiveMetadata,
      (chunk, metadata) => {
        emitUnscheduledChunkDiagnostic(chunk, metadata, reason);
        return true;
      },
    ),
    stop: (reason = 'stop') => { void flush(reason); },
    flush,
    snapshot,
  };
}

export function readGeminiOutputAudioChunks(event: Record<string, unknown>): string[] {
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  if (!isRecord(serverContent)) {
    return [];
  }
  const modelTurn = recordFromAnyKey(serverContent, 'modelTurn', 'model_turn');
  const parts = arrayFromAnyKey(modelTurn, 'parts');
  if (!parts) {
    return [];
  }

  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    const inlineData = recordFromAnyKey(part, 'inlineData', 'inline_data');
    if (!isRecord(inlineData)) {
      continue;
    }
    const mimeType = stringFromAnyKey(inlineData, 'mimeType', 'mime_type') ?? '';
    const data = stringFromAnyKey(inlineData, 'data') ?? '';
    if (mimeType.startsWith('audio/pcm') && data) {
      chunks.push(data);
    }
  }
  return chunks;
}

export function hashGeminiOutputAudioChunk(chunk: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < chunk.length; index += 1) {
    hash ^= chunk.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function estimatedBase64DecodedByteLength(value: string): number {
  const compact = value.replace(/\s/g, '');
  if (!compact) {
    return 0;
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function readEphemeralToken(value: unknown): { value: string; expireTime: string | null } | null {
  if (typeof value === 'string' && value.trim()) {
    return { value: value.trim(), expireTime: null };
  }
  if (!isRecord(value)) {
    return null;
  }
  const token = (value as EphemeralTokenPayload).value ?? (value as EphemeralTokenPayload).name;
  if (typeof token !== 'string' || !token.trim()) return null;
  const expireTime = (value as EphemeralTokenPayload).expireTime;
  if (expireTime !== undefined && !isCanonicalGeminiUtcMillis(expireTime)) {
    return null;
  }
  return {
    value: token.trim(),
    expireTime: typeof expireTime === 'string' ? expireTime : null,
  };
}

async function parseWebSocketMessage(data: unknown): Promise<unknown> {
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    const text = await readBlobText(data);
    if (text !== null) {
      return parseWebSocketMessage(text);
    }
  }

  if (data instanceof ArrayBuffer) {
    return parseWebSocketMessage(new TextDecoder().decode(data));
  }

  if (ArrayBuffer.isView(data)) {
    return parseWebSocketMessage(new TextDecoder().decode(data));
  }

  if (typeof data !== 'string') {
    return data;
  }
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

async function readBlobText(data: Blob): Promise<string | null> {
  if (typeof data.text === 'function') {
    return data.text();
  }

  if (typeof data.arrayBuffer === 'function') {
    return new TextDecoder().decode(await data.arrayBuffer());
  }

  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(data);
    });
  }

  return null;
}

async function formatDogfoodHttpError(response: Response, prefix: string): Promise<string> {
  let detail = '';

  try {
    const contentType = response.headers.get('Content-Type') ?? response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const payload = await response.json() as DogfoodErrorPayload | null;
      detail = readDogfoodErrorDetail(payload);
    } else {
      detail = (await response.text()).trim();
    }
  } catch {
    detail = '';
  }

  const suffix = detail || response.statusText || `HTTP ${response.status}`;
  return `${prefix}: ${suffix}`;
}

function readDogfoodErrorDetail(payload: DogfoodErrorPayload | null): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  for (const candidate of [payload.detail, payload.error, payload.message]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

export function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples: Float32Array<ArrayBuffer> = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

function buildRelayDiagnostic(options: {
  error: unknown;
  event: Record<string, unknown>;
  websocket: WebSocketLike | null;
  consecutiveFailures: number;
  sessionClosing: boolean;
}): GeminiBrowserLiveDogfoodRelayDiagnostic {
  const detail = options.error instanceof GeminiRelayFetchError
    ? options.error.detail
    : fallbackRelayFailureDetail(options.error, options.event);
  const websocketReadyState = typeof options.websocket?.readyState === 'number' ? options.websocket.readyState : null;
  const websocketOpen = websocketReadyState === WEBSOCKET_OPEN;
  const terminal = !options.sessionClosing
    && (!websocketOpen || options.consecutiveFailures >= MAX_CONSECUTIVE_RELAY_FAILURES);

  return {
    timestamp: new Date().toISOString(),
    ...detail,
    terminal,
    consecutiveFailures: options.consecutiveFailures,
    websocketOpen,
    websocketReadyState,
    websocketState: websocketReadyStateLabel(websocketReadyState),
    sessionClosing: options.sessionClosing,
  };
}

function fallbackRelayFailureDetail(error: unknown, event: Record<string, unknown>): GeminiRelayFailureDetail {
  const message = error instanceof Error ? error.message : 'Unknown relay failure.';
  return {
    targetPath: RELAY_TARGET_PATH,
    eventType: describeGeminiProviderEventType(event),
    requestBodyBytes: textByteLength(JSON.stringify({ event })),
    hasHttpResponse: false,
    statusCode: null,
    statusText: null,
    errorText: message,
    fetchErrorName: error instanceof Error ? error.name : null,
  };
}

function describeGeminiProviderEventType(event: Record<string, unknown>): string {
  if (isGeminiSetupCompleteMessage(event)) {
    return 'setupComplete';
  }

  if (readGeminiToolCallsFromEvent(event).length) {
    return 'toolCall';
  }

  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  if (isRecord(serverContent)) {
    if (serverContent.interrupted === true) {
      return 'serverContent.interrupted';
    }
    const modelTurn = recordFromAnyKey(serverContent, 'modelTurn', 'model_turn');
    const parts = arrayFromAnyKey(modelTurn, 'parts');
    if (parts?.some((part) => {
      if (!isRecord(part)) {
        return false;
      }
      const inlineData = recordFromAnyKey(part, 'inlineData', 'inline_data');
      return isRecord(inlineData) && (stringFromAnyKey(inlineData, 'mimeType', 'mime_type') ?? '').startsWith('audio/pcm');
    })) {
      return 'serverContent.modelTurn.inlineData.audio';
    }
    if (hasTranscriptionText(event, 'outputTranscription', 'output_transcription')) {
      return 'serverContent.outputTranscription';
    }
    if (hasTranscriptionText(event, 'inputTranscription', 'input_transcription')) {
      return 'serverContent.inputTranscription';
    }
    return 'serverContent';
  }

  for (const key of RELAYABLE_GEMINI_PROVIDER_EVENT_KEYS) {
    if (key in event) {
      return key;
    }
  }

  return 'unknown';
}

function hasGeminiServerContentTurnBoundary(event: unknown): boolean {
  return hasGeminiServerContentFlag(event, 'generationComplete', 'generation_complete')
    || hasGeminiServerContentFlag(event, 'turnComplete', 'turn_complete');
}

function hasGeminiServerContentFlag(event: unknown, camelKey: string, snakeKey: string): boolean {
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  if (!isRecord(serverContent)) {
    return false;
  }
  return serverContent[camelKey] === true || serverContent[snakeKey] === true;
}

function isPureGeminiOutputAudioEvent(event: unknown): boolean {
  const categories = categorizeGeminiProviderEvent(event);
  return categories.length > 0
    && categories.every((category) => category === 'serverContent' || category === 'modelTurnAudio')
    && isRecord(event)
    && readGeminiOutputAudioChunks(event).length > 0
    && !hasGeminiServerContentTurnBoundary(event)
    && !isGeminiServerInterruptedEvent(event);
}

function cloneGeminiProviderEventCategoryCounts(
  counts: GeminiProviderEventCategoryCounts,
): GeminiProviderEventCategoryCounts {
  return Object.fromEntries(
    GEMINI_PROVIDER_EVENT_CATEGORIES.map((category) => [
      category,
      { count: counts[category].count, lastAt: counts[category].lastAt },
    ]),
  ) as GeminiProviderEventCategoryCounts;
}

function cloneGeminiRelayClassificationCounts(
  counts: GeminiRelayClassificationCounts,
): GeminiRelayClassificationCounts {
  return {
    critical: { count: counts.critical.count, lastAt: counts.critical.lastAt },
    summary: { count: counts.summary.count, lastAt: counts.summary.lastAt },
    skip: { count: counts.skip.count, lastAt: counts.skip.lastAt },
  };
}

function compactGeminiBackendDiagnostics(
  diagnostics: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!diagnostics) {
    return null;
  }

  const providerCategoryCounts = recordFromAnyKey(diagnostics, 'provider_category_counts', 'providerCategoryCounts');
  const toolExecutionCounts = recordFromAnyKey(diagnostics, 'tool_execution_counts', 'toolExecutionCounts');
  const mappingOutputs = recordFromAnyKey(diagnostics, 'provider_event_mapping_outputs', 'providerEventMappingOutputs');
  const publicCounts = recordFromAnyKey(diagnostics, 'public_sophia_emitted_counts', 'publicSophiaEmittedCounts');
  const functionCalls = recordFromAnyKey(diagnostics, 'function_calls_extracted', 'functionCallsExtracted');
  const cancellations = arrayFromAnyKey(diagnostics, 'cancellation_ids_observed', 'cancellationIdsObserved');
  const recentToolExecutions = arrayFromAnyKey(diagnostics, 'tool_execution_recent', 'toolExecutionRecent');
  const latestToolExecution = recentToolExecutions?.filter(isRecord).at(-1) ?? null;

  return {
    schema: 'gemini_backend_diagnostics_compact_v1',
    session_id: stringFromAnyKey(diagnostics, 'session_id', 'sessionId'),
    raw_provider_events_accepted: numberFromAnyKey(diagnostics, 'raw_provider_events_accepted', 'rawProviderEventsAccepted'),
    provider_events_pushed_into_mapper: numberFromAnyKey(diagnostics, 'provider_events_pushed_into_mapper', 'providerEventsPushedIntoMapper'),
    provider_category_count_total: sumNumericRecord(providerCategoryCounts),
    function_calls_extracted_count: functionCalls ? Object.keys(functionCalls).length : 0,
    cancellation_ids_observed_count: cancellations?.length ?? 0,
    tool_execution_count_total: sumNumericRecord(toolExecutionCounts),
    tool_execution_recent_count: recentToolExecutions?.length ?? 0,
    provider_event_mapping_output_total: sumNumericRecord(mappingOutputs),
    public_sophia_emitted_count_total: sumNumericRecord(publicCounts),
    latest_tool_execution: latestToolExecution
      ? {
          phase: stringFromAnyKey(latestToolExecution, 'phase'),
          tool_call_id: stringFromAnyKey(latestToolExecution, 'tool_call_id', 'toolCallId'),
          tool_name: stringFromAnyKey(latestToolExecution, 'tool_name', 'toolName'),
          recorded_at: numberFromAnyKey(latestToolExecution, 'recorded_at', 'recordedAt'),
        }
      : null,
  };
}

function readGeminiNestedFunctionCallsFromModelTurn(event: unknown): Record<string, unknown>[] {
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  const modelTurn = recordFromAnyKey(serverContent, 'modelTurn', 'model_turn');
  const parts = arrayFromAnyKey(modelTurn, 'parts') ?? [];
  const calls: Record<string, unknown>[] = [];
  for (const part of parts) {
    const functionCall = recordFromAnyKey(part, 'functionCall', 'function_call');
    if (functionCall) {
      calls.push(functionCall);
    }
  }
  return calls;
}

function readGeminiToolCancellationIds(event: unknown): string[] {
  const cancellation = recordFromAnyKey(event, 'toolCallCancellation', 'tool_call_cancellation');
  return (arrayFromAnyKey(cancellation, 'ids') ?? []).filter((id): id is string => typeof id === 'string');
}

function isGeminiModelTurnAudioPart(part: unknown): boolean {
  if (!isRecord(part)) {
    return false;
  }
  const inlineData = recordFromAnyKey(part, 'inlineData', 'inline_data');
  return isRecord(inlineData) && (stringFromAnyKey(inlineData, 'mimeType', 'mime_type') ?? '').startsWith('audio/pcm');
}

function hasTranscriptionText(event: unknown, ...transcriptionKeys: string[]): boolean {
  return Boolean(readTranscriptionText(event, ...transcriptionKeys));
}

function readTranscriptionText(event: unknown, ...transcriptionKeys: string[]): string | null {
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  const transcription = valueFromAnyKey(serverContent, ...transcriptionKeys);
  const text = typeof transcription === 'string'
    ? transcription
    : stringFromAnyKey(transcription, 'text', 'transcript');
  const normalized = text?.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function buildGeminiAssembledOutputTranscriptionEvent(
  templateEvent: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  const serverKey = 'server_content' in templateEvent ? 'server_content' : 'serverContent';
  const sourceServerContent = recordFromAnyKey(templateEvent, 'serverContent', 'server_content') ?? {};
  const transcriptionKey = 'output_transcription' in sourceServerContent ? 'output_transcription' : 'outputTranscription';
  const sourceTranscription = valueFromAnyKey(sourceServerContent, 'outputTranscription', 'output_transcription');
  const outputTranscription = typeof sourceTranscription === 'string'
    ? text
    : { ...(isRecord(sourceTranscription) ? sourceTranscription : {}), text };
  const serverContent: Record<string, unknown> = { [transcriptionKey]: outputTranscription };
  for (const identifier of ['responseId', 'response_id', 'eventId', 'event_id']) {
    if (identifier in sourceServerContent) {
      serverContent[identifier] = sourceServerContent[identifier];
    }
  }
  const assembledEvent: Record<string, unknown> = { [serverKey]: serverContent };
  for (const identifier of ['responseId', 'response_id', 'eventId', 'event_id']) {
    if (identifier in templateEvent) {
      assembledEvent[identifier] = templateEvent[identifier];
    }
  }
  return assembledEvent;
}

function removeGeminiOutputTranscriptionFromEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const serverKey = 'server_content' in event ? 'server_content' : 'serverContent';
  const sourceServerContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  if (!sourceServerContent) {
    return { ...event };
  }
  const serverContent = { ...sourceServerContent };
  delete serverContent.outputTranscription;
  delete serverContent.output_transcription;
  return { ...event, [serverKey]: serverContent };
}

function artifactReviewAssistantLeakageMarker(
  event: Record<string, unknown>,
  categories: GeminiProviderEventCategory[],
  artifactReviewContext: GeminiArtifactReviewRelayContext | null,
): string | null {
  if (!artifactReviewContext?.active) {
    return null;
  }
  if (!categories.includes('outputTranscription') && !categories.includes('modelTurnText')) {
    return null;
  }

  const candidates = [
    readTranscriptionText(event, 'outputTranscription', 'output_transcription'),
    ...readGeminiModelTurnTextParts(event),
  ].filter((text): text is string => Boolean(text));

  for (const text of candidates) {
    const marker = promptOrToolLeakageMarker(text);
    if (marker) return marker;
  }
  return null;
}

const PROMPT_OR_TOOL_LEAKAGE_MARKER_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bemit_artifact\b/u, 'emit_artifact'],
  [/\bread_artifact_text\b/u, 'read_artifact_text'],
  [/\bcoreview_request_artifact_update\b/u, 'coreview_request_artifact_update'],
  [/\bcoreview_get_builder_status\b/u, 'coreview_get_builder_status'],
  [/\b(?:start_builder_task|edit_builder_artifact|check_async_task|update_async_task|cancel_async_task|list_async_tasks)\b/u, 'generic_builder_lifecycle_tool'],
  [/\bartifact_id\b/u, 'artifact_id'],
  [/\btask[_\s-]?id\b/u, 'task_id'],
  [/\basync\s+task\b/u, 'async_task'],
  [/\btracking\s+that\s+specific\s+task\b/u, 'task_tracking_recovery'],
  [/\b(?:listing\s+all\s+(?:the\s+)?builds|try\s+listing\s+all\s+(?:the\s+)?builds|list(?:ing)?\s+builds)\b/u, 'list_builds_recovery'],
  [/\bactive_goal\s*:/u, 'active_goal'],
  [/\btool_call_id\b/u, 'tool_call_id'],
  [/\btool\s+(?:call|response|result|name|mechanic|mechanics)\b/u, 'tool_mechanics'],
  [/^(?:tool\s+)?schema$/u, 'tool_schema'],
  [/\btool\s+schema\b/u, 'tool_schema'],
  [/\b(?:system|developer|internal|behavior)\s+prompt\b/u, 'internal_prompt'],
  [/\bdeveloper\s+instructions\b/u, 'internal_prompt'],
  [/\bfunction\s*declarations?\b|\bfunctiondeclarations\b|\btool\s+payload\b/u, 'tool_schema'],
  [/\btool\b/u, 'tool_word'],
];

function promptOrToolLeakageMarker(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return null;
  for (const [pattern, marker] of PROMPT_OR_TOOL_LEAKAGE_MARKER_RULES) {
    if (pattern.test(normalized)) return marker;
  }
  return null;
}

function readGeminiModelTurnTextParts(event: Record<string, unknown>): string[] {
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  const modelTurn = recordFromAnyKey(serverContent, 'modelTurn', 'model_turn');
  const parts = arrayFromAnyKey(modelTurn, 'parts') ?? [];
  return parts
    .filter(isRecord)
    .map((part) => stringFromAnyKey(part, 'text')?.replace(/\s+/g, ' ').trim())
    .filter((text): text is string => Boolean(text));
}

function normalizeTranscriptionForIntent(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function pruneStringSet(values: Set<string>, maxSize: number): void {
  while (values.size > maxSize) {
    const first = values.values().next().value;
    if (typeof first !== 'string') return;
    values.delete(first);
  }
}

export function classifyArtifactReviewUserIntent(text: string): GeminiArtifactReviewUserIntent {
  const normalized = normalizeTranscriptionForIntent(text);
  if (!normalized) {
    return 'unknown';
  }

  const createOrUpdate =
    /\b(create|make|write|draft|generate|update|edit|revise|rewrite|change|save|add|remove|replace)\b/u.test(normalized)
    && /\b(artifact|document|doc|summary|brief|report|file|canvas|it|this)\b/u.test(normalized);
  if (
    createOrUpdate
    || /\b(turn this into|save this as|make this into|new artifact|new version)\b/u.test(normalized)
  ) {
    return 'create_update';
  }

  return 'analysis';
}

function isArtifactReviewSelectedArtifactUpdateIntent(text: string): boolean {
  const normalized = normalizeTranscriptionForIntent(text);
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:update|edit|revise|rewrite|change|rebuild|repair)\s+(?:this|the|that)?\s*(?:file|artifact|document|doc|page|canvas|it|this|that)?\b/u.test(normalized)
    || /\bchange\s+(?:the\s+)?(?:title|heading|headline|background|layout|copy|text|tone|color|colour|section|hero|cards?)\b/u.test(normalized)
    || /\bmake\s+(?:it|this|that|the|those)?\s*(?:background|layout|copy|text|title|heading|headline|section|hero|cards?)?\s*(?:more|less|darker|lighter|brighter|premium|polished|compact|spacious|clear|modern)\b/u.test(normalized)
    || /\b(?:new version|revise version|updated version)\b/u.test(normalized)
  );
}

function isConfirmableProviderInputTranscription(text: string): boolean {
  const normalized = normalizeTranscriptionForIntent(text);
  if (!normalized) {
    return false;
  }
  const compact = normalized.replace(/\s/g, '');
  if (compact.length < 2) {
    return false;
  }
  return !new Set(['ah', 'eh', 'hm', 'hmm', 'mm', 'mmm', 'oh', 'uh', 'um']).has(normalized);
}

function isLikelyAssistantEcho(inputText: string, assistantText: string | null): boolean {
  if (!assistantText) {
    return false;
  }
  const normalizedInput = normalizeTranscriptionForIntent(inputText);
  if (normalizedInput.length < 8) {
    return false;
  }
  const normalizedAssistant = normalizeTranscriptionForIntent(assistantText);
  return normalizedAssistant.includes(normalizedInput);
}

function readTranscriptionTextPreview(event: unknown, ...transcriptionKeys: string[]): string | null {
  const text = readTranscriptionText(event, ...transcriptionKeys);
  if (!text) {
    return null;
  }
  return text.length > MAX_TRANSCRIPTION_TELEMETRY_PREVIEW_CHARS
    ? `${text.slice(0, MAX_TRANSCRIPTION_TELEMETRY_PREVIEW_CHARS)}...`
    : text;
}

function readGeminiResponseId(event: unknown): string | null {
  if (!isRecord(event)) {
    return null;
  }
  const direct = stringFromAnyKey(event, 'responseId', 'response_id', 'eventId', 'event_id');
  if (direct) {
    return direct;
  }
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  return stringFromAnyKey(serverContent, 'responseId', 'response_id');
}

function readGeminiStableResponseId(event: unknown): string | null {
  if (!isRecord(event)) {
    return null;
  }
  const direct = stringFromAnyKey(event, 'responseId', 'response_id');
  if (direct) {
    return direct;
  }
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  return stringFromAnyKey(serverContent, 'responseId', 'response_id');
}

function readGeminiProviderEventId(event: unknown): string | null {
  if (!isRecord(event)) {
    return null;
  }
  const direct = stringFromAnyKey(event, 'eventId', 'event_id');
  if (direct) {
    return direct;
  }
  const serverContent = recordFromAnyKey(event, 'serverContent', 'server_content');
  return stringFromAnyKey(serverContent, 'eventId', 'event_id');
}

function geminiProviderEventCorrelationId(event: unknown, sequence: number): string {
  if (isRecord(event)) {
    const direct = stringFromAnyKey(event, 'eventId', 'event_id', 'responseId', 'response_id');
    if (direct) {
      return direct;
    }
    const toolCallId = readGeminiToolCallsFromEvent(event)[0]?.id;
    if (toolCallId) {
      return toolCallId;
    }
    const cancellationId = readGeminiToolCancellationIds(event)[0];
    if (cancellationId) {
      return cancellationId;
    }
  }
  return `gemini-event-${sequence}`;
}

function createToolCallLedgerEntry(
  toolCallId: string,
  providerConnectionEpoch: number,
): GeminiBrowserLiveToolCallLedgerEntry {
  return {
    toolCallId,
    effectId: `effect:${globalThis.crypto.randomUUID()}`,
    providerConnectionEpoch,
    toolName: null,
    receivedAt: null,
    cancelledAt: null,
    relayStartedAt: null,
    relayCompletedAt: null,
    backendAcceptedAt: null,
    toolResponsePreparedAt: null,
    toolResponseSentAt: null,
    sendSuppressedAt: null,
    suppressionReason: null,
    finalState: 'unknown',
    syntheticToolEvidence: null,
    syntheticBuilderJoin: null,
  };
}

function readGeminiSyntheticBuilderJoin(
  value: unknown,
  evidence: GeminiSyntheticToolEvidence | null,
): GeminiSyntheticBuilderJoin | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || evidence === null) {
    throw new Error('Synthetic Builder join was present without exact browser tool evidence.');
  }
  const expectedKeys = new Set([
    'schema', 'test_run_id', 'scenario_id', 'scenario_version', 'operation_id',
    'utterance_id', 'provider_input_sequence', 'tool_call_id', 'effect_id',
    'provider_connection_epoch', 'relay_correlation_id', 'tool_name', 'tool_state',
    'builder_operation_id', 'parent_thread_id', 'task_id', 'thread_id', 'run_id',
    'build_id', 'artifact_id', 'artifact_path_sha256', 'ui_projection_state',
    'cancel_count', 'no_post_cancel_publication', 'source_tool_received_at',
    'source_backend_accepted_at', 'source_tool_response_sent_at',
    'source_builder_event_id', 'source_builder_event_at', 'source_ui_projected_at',
    'scenario_assertions',
  ]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new Error('Synthetic Builder join contained an unexpected field.');
  }
  const requiredStrings = [
    'test_run_id', 'scenario_id', 'scenario_version', 'operation_id', 'utterance_id',
    'tool_call_id', 'effect_id', 'relay_correlation_id', 'tool_name', 'tool_state',
    'builder_operation_id', 'parent_thread_id', 'task_id', 'thread_id', 'run_id',
    'build_id', 'source_tool_received_at', 'source_backend_accepted_at',
  ] as const;
  if (
    value.schema !== 'sophia_synthetic_builder_join_v1'
    || requiredStrings.some((key) => (
      typeof value[key] !== 'string'
      || !value[key]
      || String(value[key]).length > 512
      || String(value[key]).includes('\0')
    ))
    || !Number.isInteger(value.provider_input_sequence)
    || Number(value.provider_input_sequence) <= 0
    || !Number.isInteger(value.provider_connection_epoch)
    || Number(value.provider_connection_epoch) <= 0
    || !Number.isInteger(value.cancel_count)
    || Number(value.cancel_count) < 0
    || typeof value.no_post_cancel_publication !== 'boolean'
    || !isRecord(value.scenario_assertions)
  ) {
    throw new Error('Synthetic Builder join was malformed.');
  }
  const exactBindings: Array<[unknown, unknown]> = [
    [value.test_run_id, evidence.test_run_id],
    [value.scenario_id, evidence.scenario_id],
    [value.scenario_version, evidence.scenario_version],
    [value.operation_id, evidence.operation_id],
    [value.utterance_id, evidence.utterance_id],
    [value.provider_input_sequence, evidence.provider_input_sequence],
    [value.tool_call_id, evidence.tool_call_id],
    [value.effect_id, evidence.effect_id],
    [value.provider_connection_epoch, evidence.provider_connection_epoch],
    [value.relay_correlation_id, evidence.relay_correlation_id],
    [value.tool_name, evidence.tool_name],
    [value.source_tool_received_at, evidence.received_at],
  ];
  if (exactBindings.some(([actual, expected]) => actual !== expected)) {
    throw new Error('Synthetic Builder join conflicted with exact browser tool evidence.');
  }
  for (const key of [
    'artifact_id', 'artifact_path_sha256', 'ui_projection_state',
    'source_tool_response_sent_at', 'source_builder_event_id',
    'source_builder_event_at', 'source_ui_projected_at',
  ] as const) {
    if (value[key] !== null && (typeof value[key] !== 'string' || !value[key])) {
      throw new Error(`Synthetic Builder join ${key} was malformed.`);
    }
  }
  return value as unknown as GeminiSyntheticBuilderJoin;
}

function finalizeToolCallLedgerEntry(
  entry: GeminiBrowserLiveToolCallLedgerEntry,
): GeminiBrowserLiveToolCallLedgerEntry {
  if (entry.finalState === 'responded' && entry.cancelledAt && entry.toolResponseSentAt) {
    return { ...entry, finalState: 'cancelled-after-send' };
  }
  if (entry.finalState === 'unknown' && entry.cancelledAt && !entry.toolResponseSentAt) {
    return { ...entry, finalState: 'cancelled-before-send' };
  }
  return entry;
}

function isTerminalToolCallLedgerState(state: GeminiToolCallLedgerFinalState): boolean {
  return state !== 'unknown';
}

function emitToolCallLedgerEntry(
  ledger: Map<string, GeminiBrowserLiveToolCallLedgerEntry>,
  toolCallId: string | null,
  update: Partial<Omit<GeminiBrowserLiveToolCallLedgerEntry, 'toolCallId' | 'effectId' | 'providerConnectionEpoch'>>,
  onUpdate?: (entry: GeminiBrowserLiveToolCallLedgerEntry) => void,
): GeminiBrowserLiveToolCallLedgerEntry | null {
  if (!toolCallId) {
    return null;
  }
  const current = ledger.get(toolCallId);
  if (!current) {
    return null;
  }
  if (isTerminalToolCallLedgerState(current.finalState)) {
    return current;
  }
  const next = finalizeToolCallLedgerEntry({ ...current, ...update });
  ledger.set(toolCallId, next);
  onUpdate?.({ ...next });
  return next;
}

function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function elapsedMs(startMs: number): number {
  return Math.max(0, Math.round(monotonicNowMs() - startMs));
}

function latencyMsFromIso(startIso: string | null | undefined, endIso: string): number | null {
  if (!startIso) {
    return null;
  }
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return Math.max(0, Math.round(endMs - startMs));
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function sanitizeDiagnosticText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const withoutTokens = value
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .replace(/auth_tokens\/[A-Za-z0-9._~+-]+/g, 'auth_tokens/[redacted]');
  return withoutTokens.length > MAX_SAFE_DIAGNOSTIC_TEXT_CHARS
    ? `${withoutTokens.slice(0, MAX_SAFE_DIAGNOSTIC_TEXT_CHARS)}...`
    : withoutTokens;
}

function readGeminiUsageMetadataImageCount(metadata: Record<string, unknown> | null): number | null {
  if (!metadata) {
    return null;
  }
  return numberFromAnyKey(metadata, 'imageCount', 'image_count');
}

function readGeminiUsageMetadataDurationSeconds(
  metadata: Record<string, unknown> | null,
  kind: 'audio' | 'video',
): number | null {
  if (!metadata) {
    return null;
  }
  return kind === 'audio'
    ? numberFromAnyKey(metadata, 'audioDurationSeconds', 'audio_duration_seconds')
    : numberFromAnyKey(metadata, 'videoDurationSeconds', 'video_duration_seconds');
}

function buildGeminiUsageMetadataTelemetry(
  metadata: Record<string, unknown> | null,
): GeminiUsageMetadataTelemetry | null {
  if (!metadata) {
    return null;
  }
  return {
    imageCount: readGeminiUsageMetadataImageCount(metadata),
    videoDurationSeconds: readGeminiUsageMetadataDurationSeconds(metadata, 'video'),
    audioDurationSeconds: readGeminiUsageMetadataDurationSeconds(metadata, 'audio'),
    totalTokenCount: numberFromAnyKey(metadata, 'totalTokenCount', 'total_token_count'),
    rawUsageMetadataExcluded: true,
  };
}

function usageMetadataObservedAfterFrame(
  providerAfter: {
    usageMetadata: Record<string, unknown> | null;
    usageMetadataReceiveSequence: number | null;
  },
  providerEventCountBefore: number,
): GeminiUsageMetadataTelemetry | null {
  if (
    providerAfter.usageMetadata
    && typeof providerAfter.usageMetadataReceiveSequence === 'number'
    && providerAfter.usageMetadataReceiveSequence > providerEventCountBefore
  ) {
    return buildGeminiUsageMetadataTelemetry(providerAfter.usageMetadata);
  }
  return null;
}

function imageCountObservedAfterFrame(
  providerAfter: {
    imageCount: number | null;
    usageMetadataReceiveSequence: number | null;
  },
  providerEventCountBefore: number,
): number | null {
  if (
    typeof providerAfter.imageCount === 'number'
    && typeof providerAfter.usageMetadataReceiveSequence === 'number'
    && providerAfter.usageMetadataReceiveSequence > providerEventCountBefore
  ) {
    return providerAfter.imageCount;
  }
  return null;
}

function usageDurationObservedAfterFrame(
  providerAfter: {
    usageMetadata: Record<string, unknown> | null;
    usageMetadataReceiveSequence: number | null;
  },
  providerEventCountBefore: number,
  kind: 'audio' | 'video',
): number | null {
  if (
    providerAfter.usageMetadata
    && typeof providerAfter.usageMetadataReceiveSequence === 'number'
    && providerAfter.usageMetadataReceiveSequence > providerEventCountBefore
  ) {
    return readGeminiUsageMetadataDurationSeconds(providerAfter.usageMetadata, kind);
  }
  return null;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function notifyToolCallReceived(
  event: Record<string, unknown>,
  onToolLoopDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => void,
): void {
  for (const toolCall of readGeminiToolCallsFromEvent(event)) {
    onToolLoopDiagnostic?.({
      timestamp: new Date().toISOString(),
      phase: 'tool_call_received',
      toolCall,
      success: null,
      resultSummary: null,
      taskId: taskIdFromToolCallArgs(toolCall.args),
      taskStatus: null,
      trackedTaskIds: [],
      rejectionReason: null,
      recoveryGuidance: null,
      backendResponse: null,
      errorText: null,
    });
  }

  const cancellation = recordFromAnyKey(event, 'toolCallCancellation', 'tool_call_cancellation');
  const cancelledIds = arrayFromAnyKey(cancellation, 'ids') ?? [];
  for (const cancelledId of cancelledIds) {
    if (typeof cancelledId !== 'string') {
      continue;
    }
    onToolLoopDiagnostic?.({
      timestamp: new Date().toISOString(),
      phase: 'tool_call_cancelled',
      toolCall: { id: cancelledId, name: null, args: null, argsPreview: '{}' },
      success: false,
      resultSummary: 'Gemini cancelled this tool call before response send-back.',
      taskId: null,
      taskStatus: null,
      trackedTaskIds: [],
      rejectionReason: null,
      recoveryGuidance: null,
      backendResponse: null,
      errorText: null,
    });
  }
}

function readGeminiFunctionCallArgs(functionCall: Record<string, unknown>): Record<string, unknown> | null {
  const args = functionCall.args ?? functionCall.arguments;
  if (isRecord(args)) {
    return args;
  }
  if (typeof args !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(args) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readGeminiFunctionResponsesFromToolResponse(payload: Record<string, unknown>): Record<string, unknown>[] {
  const toolResponse = recordFromAnyKey(payload, 'toolResponse', 'tool_response');
  const responses = arrayFromAnyKey(toolResponse, 'functionResponses', 'function_responses') ?? [];
  return responses.filter(isRecord).map((response) => ({ ...response }));
}

function applyCoreviewReadArtifactTextSideband(
  functionResponse: Record<string, unknown>,
  scope: { sessionId: string; threadId?: string | null },
): Record<string, unknown> {
  if (stringFromAnyKey(functionResponse, 'name') !== GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME) {
    return functionResponse;
  }

  const response = recordFromAnyKey(functionResponse, 'response');
  if (!response || response.ok === true) {
    return functionResponse;
  }

  const artifactId = stringFromAnyKey(response, 'artifact_id', 'artifactId');
  if (!artifactId) {
    return functionResponse;
  }

  const startedAtMs = monotonicNowMs();
  const sidebandResponse = readCoreviewArtifactTextSideband({
    artifactId,
    sessionId: scope.sessionId,
    threadId: scope.threadId ?? null,
  });
  const latencyMs = elapsedMs(startedAtMs);
  if (!sidebandResponse.ok) {
    return {
      ...functionResponse,
      response: {
        ...sidebandResponse,
        latency_ms: latencyMs,
      },
    };
  }

  return {
    ...functionResponse,
    response: {
      ...sidebandResponse,
      latency_ms: latencyMs,
    },
  };
}

function replaceGeminiFunctionResponsesInToolResponse(
  payload: Record<string, unknown>,
  functionResponses: Record<string, unknown>[],
): Record<string, unknown> {
  const camelToolResponse = recordFromAnyKey(payload, 'toolResponse');
  if (camelToolResponse) {
    return {
      ...payload,
      toolResponse: {
        ...camelToolResponse,
        functionResponses,
      },
    };
  }
  const snakeToolResponse = recordFromAnyKey(payload, 'tool_response');
  if (snakeToolResponse) {
    return {
      ...payload,
      tool_response: {
        ...snakeToolResponse,
        function_responses: functionResponses,
      },
    };
  }
  return {
    ...payload,
    toolResponse: { functionResponses },
  };
}

function toolCallSummaryFromDiagnostic(diagnostic: GeminiRelayToolDiagnosticPayload): GeminiBrowserLiveDogfoodToolCallSummary {
  return {
    id: typeof diagnostic.id === 'string' ? diagnostic.id : null,
    name: typeof diagnostic.name === 'string' ? diagnostic.name : null,
    args: null,
    argsPreview: '{}',
  };
}

function toolCallSummaryFromFunctionResponse(functionResponse: Record<string, unknown>): GeminiBrowserLiveDogfoodToolCallSummary {
  return {
    id: stringFromAnyKey(functionResponse, 'id'),
    name: stringFromAnyKey(functionResponse, 'name'),
    args: null,
    argsPreview: '{}',
  };
}

function responseSummaryFromFunctionResponse(functionResponse: Record<string, unknown>): string | null {
  const response = recordFromAnyKey(functionResponse, 'response');
  if (!response) {
    return null;
  }
  const toolName = stringFromAnyKey(functionResponse, 'name');
  if (isCoreviewToolName(toolName)) {
    const summary = stringFromAnyKey(response, 'result_summary', 'resultSummary');
    if (summary) {
      return summary;
    }
    const status = response.ok === true ? 'success' : stringFromAnyKey(response, 'blocked_reason', 'blockedReason') ?? 'blocked';
    return `${toolName} returned ${status}.`;
  }
  if (isCoreviewBuilderToolName(toolName)) {
    const message = stringFromAnyKey(response, 'userFacingMessage', 'user_facing_message', 'result_summary', 'resultSummary');
    if (message) {
      return message;
    }
    return `${toolName} returned ${stringFromAnyKey(response, 'result') ?? (response.ok === true ? 'ok' : 'blocked')}.`;
  }
  if (toolName === GEMINI_RETRIEVE_MEMORIES_TOOL_NAME) {
    const status = stringFromAnyKey(response, 'status') ?? 'unknown';
    const count = numberFromAnyKey(response, 'count') ?? 0;
    return `retrieve_memories returned ${status} with ${count} snippet(s).`;
  }
  if (toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME) {
    if (response.ok === true) {
      const source = stringFromAnyKey(response, 'source') ?? 'unknown';
      const charCount = numberFromAnyKey(response, 'char_count', 'charCount') ?? 0;
      return `read_artifact_text returned ${source} text (${charCount} chars).`;
    }
    return `read_artifact_text returned ${stringFromAnyKey(response, 'status') ?? 'unavailable'}.`;
  }
  const summary = stringFromAnyKey(response, 'result_summary', 'resultSummary', 'message', 'backend_tool_loop');
  if (summary) {
    return summary;
  }
  return previewJson(response, 140);
}

function redactCoreviewToolArgsForTelemetry(args: Record<string, unknown>): Record<string, unknown> {
  const reason = stringFromAnyKey(args, 'reason');
  const commentText = stringFromAnyKey(args, 'comment_text', 'commentText', 'note', 'text');
  const textQuote = stringFromAnyKey(args, 'text_quote', 'textQuote');
  return {
    artifact_id: stringFromAnyKey(args, 'artifact_id', 'artifactId'),
    page_index: numberFromAnyKey(args, 'page_index', 'pageIndex'),
    page_number: numberFromAnyKey(args, 'page_number', 'pageNumber'),
    page_label_present: Boolean(stringFromAnyKey(args, 'page_label', 'pageLabel')),
    zoom: numberFromAnyKey(args, 'zoom'),
    zoom_delta: numberFromAnyKey(args, 'zoom_delta', 'zoomDelta'),
    fit_mode: stringFromAnyKey(args, 'fit_mode', 'fitMode'),
    kind: stringFromAnyKey(args, 'kind'),
    anchor_type: stringFromAnyKey(args, 'anchor_type', 'anchorType'),
    color: stringFromAnyKey(args, 'color'),
    occurrence: numberFromAnyKey(args, 'occurrence'),
    rect_present: Boolean(recordFromAnyKey(args, 'rect')),
    point_present: Boolean(recordFromAnyKey(args, 'point')),
    comment_text_length: commentText?.length ?? 0,
    text_quote_length: textQuote?.length ?? 0,
    text_quote_fingerprint: textQuote ? telemetryTextFingerprint(textQuote) : null,
    reason_length: reason?.length ?? 0,
    raw_reason_excluded: true,
    raw_comment_text_excluded: true,
    raw_text_quote_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function redactCoreviewBuilderToolArgsForTelemetry(args: Record<string, unknown>): Record<string, unknown> {
  const request = stringFromAnyKey(
    args,
    'user_update_request',
    'userUpdateRequest',
    'requested_change_summary',
    'requestedChangeSummary',
    'request',
    'summary',
  );
  const reason = stringFromAnyKey(args, 'reason');
  return {
    user_update_request_length: request?.length ?? 0,
    user_update_request_fingerprint: request ? telemetryTextFingerprint(request) : null,
    update_mode: stringFromAnyKey(args, 'update_mode', 'updateMode'),
    reason_length: reason?.length ?? 0,
    raw_user_update_request_excluded: true,
    raw_reason_excluded: true,
    raw_comment_text_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function redactReadArtifactTextArgsForTelemetry(args: Record<string, unknown>): Record<string, unknown> {
  const query = stringFromAnyKey(args, 'query');
  const reason = stringFromAnyKey(args, 'reason');
  return {
    artifact_id: stringFromAnyKey(args, 'artifact_id', 'artifactId'),
    query_length: query?.length ?? 0,
    query_fingerprint: query ? telemetryTextFingerprint(query) : null,
    reason_length: reason?.length ?? 0,
    raw_query_excluded: true,
  };
}

function redactGenericBuilderToolArgsForTelemetry(args: Record<string, unknown>): Record<string, unknown> {
  const description = stringFromAnyKey(args, 'description', 'task', 'brief', 'message', 'request', 'summary');
  const rawTaskId = stringFromAnyKey(args, 'task_id', 'taskId');
  const rawRunId = stringFromAnyKey(args, 'run_id', 'runId');
  const taskId = rawTaskId && !isPlaceholderBuilderTaskId(rawTaskId) ? rawTaskId : null;
  const runId = rawRunId && !isPlaceholderBuilderTaskId(rawRunId) ? rawRunId : null;
  return {
    description_length: description?.length ?? 0,
    description_fingerprint: description ? telemetryTextFingerprint(description) : null,
    task_type: stringFromAnyKey(args, 'task_type', 'taskType'),
    task_id: taskId,
    taskId,
    task_id_present: Boolean(rawTaskId),
    task_id_placeholder: Boolean(rawTaskId && isPlaceholderBuilderTaskId(rawTaskId)),
    run_id: runId,
    runId,
    run_id_present: Boolean(rawRunId),
    run_id_placeholder: Boolean(rawRunId && isPlaceholderBuilderTaskId(rawRunId)),
    artifact_path_present: Boolean(stringFromAnyKey(args, 'artifact_path', 'artifactPath', 'source_artifact_path', 'sourceArtifactPath')),
    raw_description_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function redactRetrieveMemoriesArgsForTelemetry(args: Record<string, unknown>): Record<string, unknown> {
  const query = stringFromAnyKey(args, 'query');
  const ignoredModelArgNames = ['user_id', 'categories', 'category', 'filters', 'memory_provider']
    .filter((name) => Object.prototype.hasOwnProperty.call(args, name));
  return {
    query_length: query?.length ?? 0,
    query_fingerprint: query ? telemetryTextFingerprint(query) : null,
    raw_query_excluded: true,
    ignored_model_arg_names: ignoredModelArgNames,
  };
}

function redactToolCallArgsForTelemetry(
  toolName: string | null,
  args: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!args) {
    return args;
  }
  if (isCoreviewToolName(toolName)) {
    return redactCoreviewToolArgsForTelemetry(args);
  }
  if (isCoreviewBuilderToolName(toolName)) {
    return redactCoreviewBuilderToolArgsForTelemetry(args);
  }
  if (toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME) {
    return redactReadArtifactTextArgsForTelemetry(args);
  }
  if (toolName && GEMINI_GENERIC_BUILDER_TOOL_NAMES.has(toolName)) {
    return redactGenericBuilderToolArgsForTelemetry(args);
  }
  if (toolName !== GEMINI_RETRIEVE_MEMORIES_TOOL_NAME) {
    return args;
  }
  return redactRetrieveMemoriesArgsForTelemetry(args);
}

function redactBackendResponseForToolTelemetry(
  toolName: string | null,
  response: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (isCoreviewToolName(toolName) && response) {
    return redactCoreviewActionResponseForTelemetry(response);
  }

  if (isCoreviewBuilderToolName(toolName) && response) {
    return redactCoreviewBuilderActionResponseForTelemetry(response);
  }

  if (
    toolName === GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME
    && response?.editBuilderArtifactInterceptedByCoreview === true
  ) {
    return {
      ...redactCoreviewBuilderActionResponseForTelemetry(response),
      original_tool_name: GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
      coreview_control_plane_tool: stringFromAnyKey(response, 'coreview_control_plane_tool', 'coreviewControlPlaneTool'),
      editBuilderArtifactInterceptedByCoreview: true,
      editBuilderArtifactDirectCallResult: stringFromAnyKey(response, 'editBuilderArtifactDirectCallResult'),
      coreviewUpdateStateCreatedFromDirectEditTool: response.coreviewUpdateStateCreatedFromDirectEditTool === true,
    };
  }

  if (toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME && response) {
    return redactReadArtifactTextResponseForTelemetry(response);
  }

  if (toolName !== GEMINI_RETRIEVE_MEMORIES_TOOL_NAME || !response) {
    return response;
  }
  const diagnostics = recordFromAnyKey(response, 'diagnostics');
  const count = numberFromAnyKey(response, 'count') ?? 0;
  return {
    ok: response.ok === true,
    status: stringFromAnyKey(response, 'status'),
    count,
    has_results: count > 0,
    provider_status: stringFromAnyKey(response, 'provider_status', 'providerStatus')
      ?? stringFromAnyKey(diagnostics, 'provider_status', 'providerStatus'),
    provider_reason: stringFromAnyKey(response, 'provider_reason', 'providerReason')
      ?? stringFromAnyKey(diagnostics, 'provider_reason', 'providerReason'),
    trusted_user_id_source: stringFromAnyKey(response, 'trusted_user_id_source', 'trustedUserIdSource'),
    ignored_model_arg_names: uniqueStrings([
      ...stringArrayFromAnyKey(response, 'ignored_model_arg_names', 'ignoredModelArgNames'),
      ...stringArrayFromAnyKey(diagnostics, 'ignored_model_arg_names', 'ignoredModelArgNames'),
    ]),
    raw_memory_text_excluded: true,
    raw_query_excluded: true,
    diagnostics: diagnostics ? redactRetrieveMemoriesDiagnosticsForTelemetry(diagnostics) : null,
  };
}

function anyKeyEqualsBoolean(value: Record<string, unknown>, keys: string[], expected: boolean): boolean {
  for (const key of keys) {
    if (value[key] === expected) {
      return true;
    }
  }
  return false;
}

function trueFromAnyKey(value: Record<string, unknown>, ...keys: string[]): boolean {
  return anyKeyEqualsBoolean(value, keys, true);
}

function triStateBooleanFromAnyKey(value: Record<string, unknown>, ...keys: string[]): boolean | null {
  if (anyKeyEqualsBoolean(value, keys, true)) {
    return true;
  }
  return anyKeyEqualsBoolean(value, keys, false) ? false : null;
}

function redactCoreviewActionResponseForTelemetry(
  response: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: response.ok === true,
    action: stringFromAnyKey(response, 'action'),
    artifact_id: stringFromAnyKey(response, 'artifact_id', 'artifactId'),
    renderer_kind: stringFromAnyKey(response, 'renderer_kind', 'rendererKind'),
    page_index: numberFromAnyKey(response, 'page_index', 'pageIndex'),
    page_number: numberFromAnyKey(response, 'page_number', 'pageNumber'),
    page_count: numberFromAnyKey(response, 'page_count', 'pageCount'),
    zoom: numberFromAnyKey(response, 'zoom'),
    fit_mode: stringFromAnyKey(response, 'fit_mode', 'fitMode'),
    stale: response.stale === true,
    refresh_attempted: trueFromAnyKey(response, 'refresh_attempted', 'refreshAttempted'),
    refresh_result: stringFromAnyKey(response, 'refresh_result', 'refreshResult'),
    blocked_reason: stringFromAnyKey(response, 'blocked_reason', 'blockedReason'),
    result_summary: stringFromAnyKey(response, 'result_summary', 'resultSummary'),
    command_source: stringFromAnyKey(response, 'command_source', 'commandSource'),
    preserved_mic: trueFromAnyKey(response, 'preserved_mic', 'preservedMic'),
    preserved_review: trueFromAnyKey(response, 'preserved_review', 'preservedReview'),
    view_ready_wait_ms: numberFromAnyKey(response, 'view_ready_wait_ms', 'viewReadyWaitMs'),
    view_signature_before_present: Boolean(stringFromAnyKey(response, 'view_signature_before', 'viewSignatureBefore')),
    view_signature_after_present: Boolean(stringFromAnyKey(response, 'view_signature_after', 'viewSignatureAfter')),
    exact_text_available: trueFromAnyKey(response, 'exact_text_available', 'exactTextAvailable'),
    visual_frame_fresh: trueFromAnyKey(response, 'visual_frame_fresh', 'visualFrameFresh'),
    visual_fresh: trueFromAnyKey(response, 'visual_fresh', 'visualFresh', 'visual_frame_fresh', 'visualFrameFresh'),
    frame_sent: trueFromAnyKey(response, 'frame_sent', 'frameSent'),
    review_active: trueFromAnyKey(response, 'review_active', 'reviewActive'),
    current_view_summary: stringFromAnyKey(response, 'current_view_summary', 'currentViewSummary'),
    annotation_overlay_captured: triStateBooleanFromAnyKey(response, 'annotation_overlay_captured', 'annotationOverlayCaptured'),
    annotation_id_present: Boolean(stringFromAnyKey(response, 'annotation_id', 'annotationId')),
    annotation_kind: stringFromAnyKey(response, 'annotation_kind', 'annotationKind'),
    annotation_anchor_type: stringFromAnyKey(response, 'annotation_anchor_type', 'annotationAnchorType'),
    annotation_color: stringFromAnyKey(response, 'annotation_color', 'annotationColor'),
    annotation_page_index: numberFromAnyKey(response, 'annotation_page_index', 'annotationPageIndex'),
    annotation_count: numberFromAnyKey(response, 'annotation_count', 'annotationCount'),
    highlight_count: numberFromAnyKey(response, 'highlight_count', 'highlightCount'),
    comment_count: numberFromAnyKey(response, 'comment_count', 'commentCount'),
    annotation_action_source: stringFromAnyKey(response, 'annotation_action_source', 'annotationActionSource'),
    focus_anchor_type: stringFromAnyKey(response, 'focus_anchor_type', 'focusAnchorType'),
    focused_rect_present: Boolean(recordFromAnyKey(response, 'focused_rect', 'focusedRect')),
    navigation_model: stringFromAnyKey(response, 'navigation_model', 'navigationModel'),
    html_navigation_controller_active: trueFromAnyKey(response, 'html_navigation_controller_active', 'htmlNavigationControllerActive'),
    html_navigation_router_used: trueFromAnyKey(response, 'html_navigation_router_used', 'htmlNavigationRouterUsed'),
    html_navigation_command_kind: stringFromAnyKey(response, 'html_navigation_command_kind', 'htmlNavigationCommandKind'),
    html_navigation_target_safe: stringFromAnyKey(response, 'html_navigation_target_safe', 'htmlNavigationTargetSafe'),
    html_navigation_target_kind: stringFromAnyKey(response, 'html_navigation_target_kind', 'htmlNavigationTargetKind'),
    html_navigation_result: stringFromAnyKey(response, 'html_navigation_result', 'htmlNavigationResult'),
    html_navigation_failure_reason: stringFromAnyKey(response, 'html_navigation_failure_reason', 'htmlNavigationFailureReason'),
    html_navigation_scroll_top_before: numberFromAnyKey(response, 'html_navigation_scroll_top_before', 'htmlNavigationScrollTopBefore'),
    html_navigation_scroll_top_after: numberFromAnyKey(response, 'html_navigation_scroll_top_after', 'htmlNavigationScrollTopAfter'),
    html_navigation_scrolled: trueFromAnyKey(response, 'html_navigation_scrolled', 'htmlNavigationScrolled'),
    html_navigation_command_id: stringFromAnyKey(response, 'html_navigation_command_id', 'htmlNavigationCommandId'),
    html_navigation_timed_out: trueFromAnyKey(response, 'html_navigation_timed_out', 'htmlNavigationTimedOut'),
    html_navigation_waited_for_ready: trueFromAnyKey(response, 'html_navigation_waited_for_ready', 'htmlNavigationWaitedForReady'),
    html_navigation_feedback_emitted: trueFromAnyKey(response, 'html_navigation_feedback_emitted', 'htmlNavigationFeedbackEmitted'),
    html_navigation_prevented_pdf_fallback: trueFromAnyKey(response, 'html_navigation_prevented_pdf_fallback', 'htmlNavigationPreventedPdfFallback'),
    html_navigation_blocked_generic_tool_count: numberFromAnyKey(response, 'html_navigation_blocked_generic_tool_count', 'htmlNavigationBlockedGenericToolCount'),
    html_internal_navigation_used_same_resolver: trueFromAnyKey(response, 'html_internal_navigation_used_same_resolver', 'htmlInternalNavigationUsedSameResolver'),
    html_voice_navigation_used_same_resolver: trueFromAnyKey(response, 'html_voice_navigation_used_same_resolver', 'htmlVoiceNavigationUsedSameResolver'),
    html_navigation_suppressed_emit_artifact: trueFromAnyKey(response, 'html_navigation_suppressed_emit_artifact', 'htmlNavigationSuppressedEmitArtifact'),
    html_navigation_suppressed_builder_tool: trueFromAnyKey(response, 'html_navigation_suppressed_builder_tool', 'htmlNavigationSuppressedBuilderTool'),
    html_navigation_result_confirmed_before_feedback: trueFromAnyKey(response, 'html_navigation_result_confirmed_before_feedback', 'htmlNavigationResultConfirmedBeforeFeedback'),
    raw_comment_text_excluded: true,
    review_tool_timed_out: trueFromAnyKey(response, 'review_tool_timed_out', 'reviewToolTimedOut'),
    review_tool_timeout_name: stringFromAnyKey(response, 'review_tool_timeout_name', 'reviewToolTimeoutName'),
    review_tool_timeout_result_sent: trueFromAnyKey(response, 'review_tool_timeout_result_sent', 'reviewToolTimeoutResultSent'),
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function redactCoreviewBuilderActionResponseForTelemetry(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const context = recordFromAnyKey(response, 'context');
  const status = recordFromAnyKey(response, 'status');
  const latestOutput = recordFromAnyKey(response, 'latestOutput', 'latest_output');
  const capabilitySummary = recordFromAnyKey(context, 'capabilitySummary', 'capability_summary');
  return {
    ok: response.ok === true,
    action: stringFromAnyKey(response, 'action'),
    result: stringFromAnyKey(response, 'result'),
    task_id_present: Boolean(stringFromAnyKey(response, 'taskId', 'task_id')),
    run_id_present: Boolean(stringFromAnyKey(response, 'runId', 'run_id')),
    blocked_reason: stringFromAnyKey(response, 'blockedReason', 'blocked_reason'),
    update_mode: stringFromAnyKey(response, 'updateMode', 'update_mode'),
    renderer_kind: stringFromAnyKey(response, 'rendererKind', 'renderer_kind')
      ?? stringFromAnyKey(context, 'rendererKind', 'renderer_kind'),
    requested_change_summary_length: stringFromAnyKey(response, 'requestedChangeSummary', 'requested_change_summary')?.length
      ?? stringFromAnyKey(context, 'requestedChangeSummary', 'requested_change_summary')?.length
      ?? 0,
    context_present: Boolean(context),
    artifact_path_present: Boolean(stringFromAnyKey(context, 'artifactPath', 'artifact_path')),
    artifact_stable_identity_present: Boolean(stringFromAnyKey(context, 'artifactStableIdentity', 'artifact_stable_identity')),
    original_artifact_href_present: Boolean(stringFromAnyKey(context, 'originalArtifactHref', 'original_artifact_href')),
    current_page: numberFromAnyKey(context, 'currentPage', 'current_page'),
    page_count: numberFromAnyKey(context, 'pageCount', 'page_count'),
    annotation_count: numberFromAnyKey(recordFromAnyKey(context, 'annotationCounts', 'annotation_counts'), 'annotationCount', 'annotation_count'),
    capability_supports_artifact_update: capabilitySummary?.supportsArtifactUpdate === true || capabilitySummary?.supports_artifact_update === true,
    capability_supports_versioning: capabilitySummary?.supportsVersioning === true || capabilitySummary?.supports_versioning === true,
    capability_supports_source_read: capabilitySummary?.supportsSourceRead === true || capabilitySummary?.supports_source_read === true,
    status_phase: stringFromAnyKey(status, 'phase'),
    status_cancellable: status?.cancellable === true,
    latest_output_path_present: Boolean(stringFromAnyKey(latestOutput, 'artifactPath', 'artifact_path')),
    preserved_mic: response.preservedMic === true || response.preserved_mic === true,
    preserved_review: response.preservedReview === true || response.preserved_review === true,
    review_tool_timed_out: response.review_tool_timed_out === true || response.reviewToolTimedOut === true,
    review_tool_timeout_name: stringFromAnyKey(response, 'review_tool_timeout_name', 'reviewToolTimeoutName'),
    review_tool_timeout_result_sent: response.review_tool_timeout_result_sent === true || response.reviewToolTimeoutResultSent === true,
    raw_user_update_request_excluded: true,
    raw_comment_text_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  };
}

function redactReadArtifactTextResponseForTelemetry(
  response: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: response.ok === true,
    artifact_id: stringFromAnyKey(response, 'artifact_id', 'artifactId'),
    source: stringFromAnyKey(response, 'source'),
    char_count: numberFromAnyKey(response, 'char_count', 'charCount') ?? 0,
    page_count: numberFromAnyKey(response, 'page_count', 'pageCount'),
    truncated: response.truncated === true,
    status: response.ok === true ? 'success' : stringFromAnyKey(response, 'status'),
    safe_reason: response.ok === true ? null : stringFromAnyKey(response, 'safe_reason', 'safeReason'),
    latency_ms: numberFromAnyKey(response, 'latency_ms', 'latencyMs'),
    review_tool_timed_out: response.review_tool_timed_out === true || response.reviewToolTimedOut === true,
    review_tool_timeout_name: stringFromAnyKey(response, 'review_tool_timeout_name', 'reviewToolTimeoutName'),
    review_tool_timeout_result_sent: response.review_tool_timeout_result_sent === true || response.reviewToolTimeoutResultSent === true,
    raw_artifact_text_excluded: true,
  };
}

function redactRetrieveMemoriesDiagnosticsForTelemetry(
  diagnostics: Record<string, unknown>,
): Record<string, unknown> {
  const safeKeys = new Set([
    'any_result_exact_query_terms_present',
    'cache_status',
    'count',
    'has_results',
    'ignored_model_arg_names',
    'internal_category_count',
    'latency_ms',
    'limit',
    'max_query_terms_matched_count',
    'provider_reason',
    'provider_status',
    'provider_transport',
    'query_fingerprint',
    'query_length',
    'query_term_count',
    'query_was_truncated',
    'raw_memory_text_excluded',
    'raw_query_excluded',
    'result_categories',
    'result_fingerprints',
    'result_preview_included',
    'result_text_lengths',
    'schema',
    'status',
    'tool',
    'trusted_user_id_source',
  ]);
  return Object.fromEntries(
    Object.entries(diagnostics)
      .filter(([key]) => safeKeys.has(key))
      .map(([key, value]) => [
        key,
        key === 'result_fingerprints' ? redactRetrieveMemoriesResultFingerprints(value) : value,
      ]),
  );
}

function redactRetrieveMemoriesResultFingerprints(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const safeKeys = new Set([
    'category',
    'exact_query_terms_present',
    'query_term_count',
    'query_terms_matched_count',
    'rank',
    'score',
    'text_fingerprint',
    'text_length',
  ]);
  return value
    .filter(isRecord)
    .map((fingerprint) => Object.fromEntries(
      Object.entries(fingerprint).filter(([key]) => safeKeys.has(key)),
    ));
}

function telemetryTextFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function taskIdFromDiagnostic(diagnostic: GeminiRelayToolDiagnosticPayload): string | null {
  return stringFromAnyKey(diagnostic, 'task_id', 'taskId');
}

function taskStatusFromDiagnostic(diagnostic: GeminiRelayToolDiagnosticPayload): string | null {
  return stringFromAnyKey(diagnostic, 'task_status', 'taskStatus');
}

function trackedTaskIdsFromDiagnostic(diagnostic: GeminiRelayToolDiagnosticPayload): string[] {
  return stringArrayFromAnyKey(diagnostic, 'tracked_task_ids', 'trackedTaskIds');
}

function taskIdFromToolCallArgs(args: Record<string, unknown> | null): string | null {
  const taskId = stringFromAnyKey(args, 'task_id', 'taskId');
  return taskId && !isPlaceholderBuilderTaskId(taskId) ? taskId : null;
}

function isPlaceholderBuilderTaskId(value: string | null | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return false;
  }
  return new Set([
    'builder-thread-id',
    'thread-id',
    'task-id',
    'builder-task-id',
    'async-task-id',
    'placeholder',
  ]).has(normalized);
}

function taskIdFromResponseRecord(response: Record<string, unknown> | null): string | null {
  if (!response) {
    return null;
  }
  const direct = stringFromAnyKey(response, 'task_id', 'taskId');
  if (direct) {
    return direct;
  }
  const asyncTask = recordFromAnyKey(response, 'async_task', 'asyncTask');
  return stringFromAnyKey(asyncTask, 'task_id', 'taskId');
}

function taskStatusFromResponseRecord(response: Record<string, unknown> | null): string | null {
  if (!response) {
    return null;
  }
  const direct = stringFromAnyKey(response, 'status', 'task_status', 'taskStatus');
  if (direct) {
    return direct;
  }
  const asyncTask = recordFromAnyKey(response, 'async_task', 'asyncTask');
  return stringFromAnyKey(asyncTask, 'status', 'task_status', 'taskStatus');
}

function trackedTaskIdsFromResponseRecord(response: Record<string, unknown> | null): string[] {
  if (!response) {
    return [];
  }
  const taskIds = new Set<string>();
  const direct = taskIdFromResponseRecord(response);
  if (direct && response.ok !== false && response.rejected !== true) {
    taskIds.add(direct);
  }
  for (const taskId of stringArrayFromAnyKey(response, 'tracked_task_ids', 'trackedTaskIds')) {
    taskIds.add(taskId);
  }
  const tasks = arrayFromAnyKey(response, 'tasks') ?? [];
  for (const task of tasks) {
    if (!isRecord(task)) {
      continue;
    }
    const taskId = stringFromAnyKey(task, 'task_id', 'taskId');
    if (taskId) {
      taskIds.add(taskId);
    }
  }
  return [...taskIds];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function emptyToolCallSummary(): GeminiBrowserLiveDogfoodToolCallSummary {
  return { id: null, name: null, args: null, argsPreview: '{}' };
}

function previewJson(value: unknown, maxLength: number = 180): string {
  if (value == null) {
    return '{}';
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= maxLength) {
    return serialized;
  }
  return `${serialized.slice(0, maxLength - 1)}...`;
}

function websocketReadyStateLabel(readyState: number | null): string {
  if (readyState === 0) return 'connecting';
  if (readyState === 1) return 'open';
  if (readyState === 2) return 'closing';
  if (readyState === 3) return 'closed';
  return 'unknown';
}

function textByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

function recordFromAnyKey(value: unknown, ...keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) {
      return candidate;
    }
  }

  return null;
}

function valueFromAnyKey(value: unknown, ...keys: string[]): unknown {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key];
    }
  }

  return null;
}

function arrayFromAnyKey(value: unknown, ...keys: string[]): unknown[] | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return null;
}

function stringFromAnyKey(value: unknown, ...keys: string[]): string | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  return null;
}

function numberFromAnyKey(value: unknown, ...keys: string[]): number | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

function sumNumericRecord(value: Record<string, unknown> | null): number {
  if (!value) {
    return 0;
  }
  return Object.values(value).reduce<number>((total, entry) => (
    typeof entry === 'number' && Number.isFinite(entry) ? total + entry : total
  ), 0);
}

function stringArrayFromAnyKey(value: unknown, ...keys: string[]): string[] {
  if (!isRecord(value)) {
    return [];
  }

  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is string => typeof item === 'string');
    }
  }

  return [];
}

function bytesToBase64(bytes: Uint8Array): string {
  const bufferApi = (globalThis as unknown as { Buffer?: { from: (bytes: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer;
  if (bufferApi) {
    return bufferApi.from(bytes).toString('base64');
  }

  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const bufferApi = (globalThis as unknown as { Buffer?: { from: (value: string, encoding: string) => Uint8Array } }).Buffer;
  if (bufferApi) {
    return bufferApi.from(value, 'base64');
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => key === rightKeys[index]
        && sameJsonValue(left[key], right[key]),
    );
}

function isSemanticallyEmptyValue(value: unknown): boolean {
  if (value == null) {
    return true;
  }

  if (typeof value === 'string') {
    return value.trim().length === 0;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length === 0 || value.every((entry) => isSemanticallyEmptyValue(entry));
  }

  if (!isRecord(value)) {
    return false;
  }

  const entries = Object.values(value);
  return entries.length === 0 || entries.every((entry) => isSemanticallyEmptyValue(entry));
}
