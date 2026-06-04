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

export type GeminiBrowserLiveDogfoodStage =
  | 'starting_backend_session'
  | 'requesting_microphone'
  | 'opening_websocket'
  | 'sending_setup'
  | 'waiting_setup_complete'
  | 'connected'
  | 'streaming_audio'
  | 'closing'
  | 'closed';

export type GeminiBrowserLiveDogfoodRelayStatus = 'disconnected' | 'active' | 'degraded' | 'terminal_error';

export type GeminiTranscriptCoalescingDisabledReason = 'provider_output_transcription_is_delta_like';

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
  | 'pre_barge_in_relay_backlog';

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
}

export type GeminiInputAudioActivityEventType =
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
  providerReceivedAt: string;
  relayCorrelationId: string;
  providerPrimaryCategory: GeminiProviderEventCategory | 'unknown';
  providerCategories: GeminiProviderEventCategory[];
}

export interface GeminiArtifactReviewRelayContext {
  active: true;
  artifact_id: string | null;
  source: 'coreview_still_frame';
  user_intent: GeminiArtifactReviewUserIntent;
  last_user_intent_at: string | null;
  expires_at: string | null;
  raw_transcript_excluded: true;
  raw_artifact_text_excluded: true;
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
}

export interface GeminiOutputAudioChunkDiagnostic {
  timestamp: string;
  providerReceiveSequence: number | null;
  providerRelaySequence: number | null;
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
  dropReason: GeminiStaleOutputSuppressionReason | null;
  scheduled: boolean;
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
  coreviewStillFrameEnabled?: boolean;
  reviewToolTimeoutMs?: number;
  onStage?: (stage: GeminiBrowserLiveDogfoodStage) => void;
  onProviderEvent?: (event: unknown) => void;
  onOutputAudio?: () => void;
  onOutputAudioChunk?: (diagnostic: GeminiOutputAudioChunkDiagnostic) => void;
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
  onBargeInTranscriptHandoff?: (diagnostic: GeminiBargeInTranscriptHandoffDiagnostic) => void;
  onToolLoopDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => void;
}

export interface GeminiBrowserLiveProductionConnectOptions extends Omit<GeminiBrowserLiveDogfoodConnectOptions, 'bootstrapPayload'> {
  bootstrap: GeminiBrowserLiveSessionBootstrap;
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
  sendText: (text: string) => void;
  sendArtifactFrame: (
    frame: GeminiArtifactFramePayload,
    context?: GeminiArtifactFrameSendContext,
  ) => Promise<GeminiArtifactFrameSendResult>;
  getArtifactFrameTransportStatus: () => GeminiArtifactFrameTransportStatusSnapshot;
  setMicrophoneMuted: (muted: boolean) => void;
  flushOutputAudio: () => GeminiOutputAudioPlaybackState;
  close: () => Promise<void>;
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

interface BrowserSessionPayload {
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
}

export type GeminiBrowserLiveSessionBootstrap = BrowserSessionPayload;

interface EphemeralTokenPayload {
  value?: unknown;
  name?: unknown;
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

export interface GeminiOutputAudioPlaybackState {
  nextPlaybackTime: number;
  activeSourceCount: number;
  playbackGeneration: number;
}

export interface GeminiOutputAudioPlaybackController {
  playEvent: (event: Record<string, unknown>, receiveMetadata?: GeminiProviderReceiveMetadata) => number;
  playBase64Chunk: (chunk: string) => boolean;
  stop: () => void;
  snapshot: () => GeminiOutputAudioPlaybackState;
}

interface GeminiOutputAudioPlaybackControllerOptions {
  maxDiagnostics?: number;
  onChunkDiagnostic?: (diagnostic: GeminiOutputAudioChunkDiagnostic) => void;
}

interface GeminiOutputAudioChunkMetadata {
  receiveMetadata?: GeminiProviderReceiveMetadata;
  chunkIndex: number;
  chunksInEvent: number;
  chunkHash: string;
  byteLength: number;
  duplicateOrdinal: number;
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
const GEMINI_RETRIEVE_MEMORIES_TOOL_NAME = 'retrieve_memories';
const GEMINI_TRANSCRIPT_COALESCING_DISABLED_REASON: GeminiTranscriptCoalescingDisabledReason = 'provider_output_transcription_is_delta_like';
const WEBSOCKET_OPEN = 1;
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
const GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME = 'read_artifact_text';
type GeminiReadArtifactTextToolCallInput = {
  id: string | null;
  name: typeof GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME;
  args: Record<string, unknown>;
};
type GeminiFrontendReviewToolCallInput = CoreviewToolCallInput | GeminiReadArtifactTextToolCallInput;
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

  let websocket: WebSocketLike | null = null;
  let localStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let audioPipeline: AudioPipeline | null = null;
  let outputAudioPlayer: GeminiOutputAudioPlaybackController | null = null;
  let dogfoodSessionId: string | null = null;
  let disconnectTargetPath = DISCONNECT_TARGET_PATH;
  let closed = false;
  let relayConsecutiveFailures = 0;
  let relayFailureObserved = false;
  let relayAttemptCount = 0;
  let relaySuccessCount = 0;
  let relayFailureCount = 0;
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
  let assistantTranscriptPartialSegmentOrdinal = 0;
  let assistantTranscriptPartialSeenInSegment = false;
  const orderedRelayQueue: GeminiOrderedRelayTask[] = [];
  const transcriptRelayLatencySamples: number[] = [];
  const relayThroughputMetrics: GeminiOrderedRelayThroughputMetrics = {
    orderedRelayQueueDepth: 0,
    oldestQueuedAgeMs: null,
    transcriptPartialsCoalesced: 0,
    transcriptPartialsSent: 0,
    transcriptPartialsDropped: 0,
    transcriptCoalescingDisabledReason: GEMINI_TRANSCRIPT_COALESCING_DISABLED_REASON,
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
    options.onToolCallLedgerUpdate?.({ ...entry });
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
    artifactReviewUserIntentAt = new Date().toISOString();
  };

  const snapshotArtifactReviewRelayContext = (): GeminiArtifactReviewRelayContext | null => {
    if (!artifactReviewArtifactId || artifactReviewExpiresAtMs === null) {
      return null;
    }
    if (monotonicNowMs() > artifactReviewExpiresAtMs) {
      artifactReviewArtifactId = null;
      artifactReviewExpiresAtMs = null;
      artifactReviewUserIntent = 'unknown';
      artifactReviewUserIntentAt = null;
      artifactReviewSafeResponseIds.clear();
      artifactReviewSuppressedResponseIds.clear();
      pendingArtifactReviewAudio.clear();
      return null;
    }

    return {
      active: true,
      artifact_id: artifactReviewArtifactId,
      source: 'coreview_still_frame',
      user_intent: artifactReviewUserIntent,
      last_user_intent_at: artifactReviewUserIntentAt,
      expires_at: new Date(Date.now() + Math.max(0, artifactReviewExpiresAtMs - monotonicNowMs())).toISOString(),
      raw_transcript_excluded: true,
      raw_artifact_text_excluded: true,
    };
  };

  const prunePendingArtifactReviewAudio = () => {
    while (pendingArtifactReviewAudio.size > 25) {
      const oldest = pendingArtifactReviewAudio.keys().next().value;
      if (typeof oldest !== 'string') {
        return;
      }
      pendingArtifactReviewAudio.delete(oldest);
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

  const dropBufferedArtifactReviewAudio = (responseId: string | null) => {
    if (!responseId) {
      return;
    }
    pendingArtifactReviewAudio.delete(responseId);
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

  const defaultPlaybackState = (): GeminiOutputAudioPlaybackState => ({
    nextPlaybackTime: 0,
    activeSourceCount: 0,
    playbackGeneration: outputAudioPlayer?.snapshot().playbackGeneration ?? 0,
  });

  const hasPendingAssistantAudioPlayback = () => {
    const playbackState = outputAudioPlayer?.snapshot();
    if (!playbackState) {
      return false;
    }
    const currentTime = audioContext && Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0;
    return playbackState.activeSourceCount > 0 || playbackState.nextPlaybackTime > currentTime;
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
      outputAudioPlayer?.stop();
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
    update: Partial<Omit<GeminiBrowserLiveToolCallLedgerEntry, 'toolCallId'>>,
  ) => {
    if (!toolCallId) {
      return null;
    }
    const current = toolCallLedger.get(toolCallId) ?? createToolCallLedgerEntry(toolCallId);
    const next = finalizeToolCallLedgerEntry({ ...current, ...update });
    toolCallLedger.set(toolCallId, next);
    notifyToolCallLedgerUpdate(next);
    return next;
  };

  const noteToolResponseSent = (functionResponse: Record<string, unknown>, timestamp: string) => {
    const toolName = stringFromAnyKey(functionResponse, 'name');
    if (!isCoreviewToolName(toolName)) {
      return;
    }
    const parsedTimestampMs = Date.parse(timestamp);
    lastCoreviewToolResponseSentAtMs = Number.isFinite(parsedTimestampMs) ? parsedTimestampMs : Date.now();
  };

  const cleanup = async () => {
    notifyStage('closing');
    outputAudioPlayer?.stop();
    outputAudioPlayer = null;
    await audioPipeline?.stop().catch(() => undefined);
    if (!audioPipeline && audioContext) {
      await audioContext.close().catch(() => undefined);
    }
    localStream?.getTracks().forEach((track) => track.stop());
    if (websocket?.readyState === WEBSOCKET_OPEN) {
      websocket.close(1000, 'Gemini browser dogfood session closed.');
    }
    if (dogfoodSessionId) {
      await fetchFn(disconnectTargetPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: dogfoodSessionId }),
        keepalive: true,
      }).catch(() => undefined);
    }
    notifyRelayStatus('disconnected');
    notifyStage('closed');
  };

  try {
    notifyStage('starting_backend_session');
    const browserSession = options.bootstrapPayload
      ? readBrowserSessionPayload(options.bootstrapPayload, 'Gemini browser Live session bootstrap')
      : await startBrowserDogfoodSession(fetchFn, options);
    dogfoodSessionId = browserSession.sessionId;
    disconnectTargetPath = browserSession.disconnectUrl ?? DISCONNECT_TARGET_PATH;
    const coreviewToolsEnabled = options.coreviewStillFrameEnabled ?? isCoReviewStillFrameEnabled();
    const sessionSetup = withCoreviewGeminiToolDeclarations(browserSession.setup, coreviewToolsEnabled, {
      allowArtifactCreation: false,
    });

    notifyStage('requesting_microphone');
    localStream = await getUserMedia({ audio: true });
    audioContext = audioContextFactory();
    outputAudioPlayer = createGeminiOutputAudioPlaybackController(audioContext, {
      maxDiagnostics: MAX_OUTPUT_AUDIO_CHUNK_DIAGNOSTICS,
      onChunkDiagnostic: options.onOutputAudioChunk,
    });

    notifyStage('opening_websocket');
    websocket = webSocketFactory(browserSession.websocketUrl);
    await waitForWebSocketOpen(websocket);

    const setupComplete = waitForGeminiSetupComplete(websocket, {
      onProviderEvent: options.onProviderEvent,
      onProviderEventTelemetry: (event, receiveMetadata) => {
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
        options.onProviderEventTelemetry?.(telemetry);
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
        reviewToolTimeoutMs: options.reviewToolTimeoutMs,
        toolCallLedger,
        onToolCallLedgerUpdate: notifyToolCallLedgerUpdate,
        onToolLoopDiagnostic: options.onToolLoopDiagnostic,
        onToolResponseSent: noteToolResponseSent,
      }),
      onProviderEventReceived: (event) => buildGeminiProviderReceiveMetadata(
        event,
        providerReceiveSequence += 1,
      ),
      onRelayEvent: (event, receiveMetadata) => {
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
        const coalescingKey = isCoalescibleAssistantOutputTranscriptPartial(event, categories)
          ? `assistant-output:${assistantTranscriptPartialSegmentOrdinal}`
          : null;
        if (coalescingKey) {
          assistantTranscriptPartialSeenInSegment = true;
        } else if (shouldAdvanceAssistantTranscriptPartialSegment(event, categories)) {
          if (assistantTranscriptPartialSeenInSegment) {
            assistantTranscriptPartialSegmentOrdinal += 1;
          }
          assistantTranscriptPartialSeenInSegment = false;
        }
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
          for (const toolCall of readGeminiToolCallsFromEvent(event)) {
            updateToolCallLedger(toolCall.id, {
              toolName: toolCall.name,
              relayStartedAt,
            });
          }
          await relayGeminiProviderEvent(
            fetchFn,
            browserSession.sessionId,
            event,
            relayMetadata,
            browserSession.relayTargetPath ?? RELAY_TARGET_PATH,
            artifactReviewContext,
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
              const executionRejected = diagnostic.execution_rejected === true
                || diagnostic.executionRejected === true
                || diagnostic.success === false
                || backendResponse?.ok === false;
              updateToolCallLedger(toolCallId, {
                toolName: typeof diagnostic.name === 'string' ? diagnostic.name : null,
                relayCompletedAt,
                backendAcceptedAt: executionRejected ? null : relayCompletedAt,
                finalState: executionRejected ? 'rejected' : 'unknown',
              });
            }
            for (const action of relayResponse.clientActions) {
              if (action.type !== 'gemini_tool_response' || !isRecord(action.payload)) {
                continue;
              }
              for (const functionResponse of readGeminiFunctionResponsesFromToolResponse(action.payload)) {
                updateToolCallLedger(stringFromAnyKey(functionResponse, 'id'), {
                  toolName: stringFromAnyKey(functionResponse, 'name'),
                  relayCompletedAt,
                  toolResponsePreparedAt: relayCompletedAt,
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
        const audioSuppressionReason = staleOutputSuppressionReason(event, categories, receiveMetadata);
        if (audioSuppressionReason) {
          emitStaleOutputSuppression(event, receiveMetadata, 'audio', audioSuppressionReason);
          return;
        }
        const responseId = readGeminiResponseId(event);
        if (responseId && artifactReviewSuppressedResponseIds.has(responseId)) {
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
    });

    notifyStage('sending_setup');
    websocket.send(JSON.stringify({ setup: sessionSetup }));

    notifyStage('waiting_setup_complete');
    await setupComplete;

    notifyStage('connected');
    audioPipeline = startMicrophoneAudioPipeline({
      localStream,
      audioContext,
      websocket,
      onInputAudioActivity: handleInputAudioActivity,
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
            artifactReviewUserIntentAt = null;
            artifactReviewSafeResponseIds.clear();
            artifactReviewSuppressedResponseIds.clear();
            pendingArtifactReviewAudio.clear();
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
      flushOutputAudio: () => {
        confirmBargeIn('manual_interrupt', new Date().toISOString(), {
          stopPlayback: true,
          reason: 'local_manual_output_flush',
        });
        return outputAudioPlayer?.snapshot() ?? defaultPlaybackState();
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await cleanup();
      },
    };
  } catch (error) {
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

export function readGeminiConfiguredToolNames(setup: Record<string, unknown>): string[] {
  const tools = Array.isArray(setup.tools) ? setup.tools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
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

function isCoalescibleAssistantOutputTranscriptPartial(
  event: unknown,
  categories = categorizeGeminiProviderEvent(event),
): boolean {
  if (isRawAssistantOutputTranscriptPartial(event, categories)) {
    return false;
  }

  return false;
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
): Promise<{
  sessionId: string;
  websocketUrl: string;
  streamUrl: string;
  relayUrl: string | null;
  relayTargetPath: string | null;
  disconnectUrl: string | null;
  publicEventBoundary: string | null;
  transport: string | null;
  setup: Record<string, unknown>;
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

function readBrowserSessionPayload(
  payload: BrowserSessionPayload,
  label: string,
): {
  sessionId: string;
  websocketUrl: string;
  streamUrl: string;
  relayUrl: string | null;
  relayTargetPath: string | null;
  disconnectUrl: string | null;
  publicEventBoundary: string | null;
  transport: string | null;
  setup: Record<string, unknown>;
} {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const token = readEphemeralToken(payload.ephemeral_token);
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
): Promise<GeminiBrowserLiveDogfoodRelayResponse> {
  const body = JSON.stringify({
    session_id: sessionId,
    event,
    provider_receive_sequence: receiveMetadata.providerReceiveSequence,
    provider_relay_sequence: receiveMetadata.providerRelaySequence ?? receiveMetadata.providerReceiveSequence,
    provider_received_at: receiveMetadata.providerReceivedAt,
    relay_correlation_id: receiveMetadata.relayCorrelationId,
    provider_primary_category: receiveMetadata.providerPrimaryCategory,
    provider_categories: receiveMetadata.providerCategories,
    ...(artifactReviewContext ? { artifact_review_context: artifactReviewContext } : {}),
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
        options.onToolResponseSent?.(functionResponse, timestamp);
        emitToolCallLedgerEntry(
          options.toolCallLedger,
          stringFromAnyKey(functionResponse, 'id'),
          {
            toolName: stringFromAnyKey(functionResponse, 'name'),
            toolResponseSentAt: timestamp,
            finalState: 'responded',
          },
          options.onToolCallLedgerUpdate,
        );
        const rawBackendResponse = recordFromAnyKey(functionResponse, 'response');
        const backendResponse = redactBackendResponseForToolTelemetry(
          stringFromAnyKey(functionResponse, 'name'),
          rawBackendResponse,
        );
        options.onToolLoopDiagnostic?.({
          timestamp,
          phase: 'tool_response_sent',
          toolCall: toolCallSummaryFromFunctionResponse(functionResponse),
          success: true,
          resultSummary: responseSummaryFromFunctionResponse(functionResponse) ?? fallbackSummary,
          taskId: taskIdFromResponseRecord(backendResponse),
          taskStatus: taskStatusFromResponseRecord(backendResponse),
          trackedTaskIds: trackedTaskIdsFromResponseRecord(backendResponse),
          rejectionReason: stringFromAnyKey(backendResponse, 'error_type', 'errorType'),
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
  reviewToolTimeoutMs?: number;
  toolCallLedger: Map<string, GeminiBrowserLiveToolCallLedgerEntry>;
  onToolCallLedgerUpdate?: (entry: GeminiBrowserLiveToolCallLedgerEntry) => void;
  onToolLoopDiagnostic?: (diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => void;
  onToolResponseSent?: (functionResponse: Record<string, unknown>, timestamp: string) => void;
}): Promise<Record<string, unknown> | null> {
  const split = splitFrontendReviewToolCallsFromProviderEvent(options.event);
  if (split.frontendCalls.length === 0) {
    return options.event;
  }

  const preparedAt = new Date().toISOString();
  const functionResponses: Record<string, unknown>[] = [];
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
      toolDiagnostics: [],
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
      return { ...(await executeCoreviewToolBridgeCall(call)) };
    } catch (error) {
      return !isReadArtifactTextToolCall(call)
        ? { ...coreviewToolExceptionResult(call, error) }
        : readArtifactTextFailureResponse(call, 'unavailable', error instanceof Error
          ? error.message
          : 'Trusted artifact text is unavailable.');
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
  return call.name === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME;
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
  if (call.name === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME) {
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

function splitFrontendReviewToolCallsFromProviderEvent(event: Record<string, unknown>): {
  frontendCalls: GeminiFrontendReviewToolCallInput[];
  relayEvent: Record<string, unknown> | null;
} {
  const toolCallKey = isRecord(event.toolCall)
    ? 'toolCall'
    : isRecord(event.tool_call)
      ? 'tool_call'
      : null;
  if (!toolCallKey) {
    return { frontendCalls: [], relayEvent: event };
  }

  const toolCall = event[toolCallKey];
  if (!isRecord(toolCall)) {
    return { frontendCalls: [], relayEvent: event };
  }

  const functionCallsKey = Array.isArray(toolCall.functionCalls)
    ? 'functionCalls'
    : Array.isArray(toolCall.function_calls)
      ? 'function_calls'
      : null;
  if (!functionCallsKey) {
    return { frontendCalls: [], relayEvent: event };
  }

  const functionCalls = toolCall[functionCallsKey];
  if (!Array.isArray(functionCalls)) {
    return { frontendCalls: [], relayEvent: event };
  }

  const frontendCalls: GeminiFrontendReviewToolCallInput[] = [];
  const relayFunctionCalls: unknown[] = [];
  for (const functionCall of functionCalls) {
    if (!isRecord(functionCall)) {
      relayFunctionCalls.push(functionCall);
      continue;
    }
    const name = stringFromAnyKey(functionCall, 'name');
    if (!isCoreviewToolName(name) && name !== GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME) {
      relayFunctionCalls.push(functionCall);
      continue;
    }
    frontendCalls.push({
      id: stringFromAnyKey(functionCall, 'id'),
      name,
      args: readGeminiFunctionCallArgs(functionCall) ?? {},
    } as GeminiFrontendReviewToolCallInput);
  }

  if (frontendCalls.length === 0) {
    return { frontendCalls, relayEvent: event };
  }

  if (relayFunctionCalls.length > 0) {
    return {
      frontendCalls,
      relayEvent: {
        ...event,
        [toolCallKey]: {
          ...toolCall,
          [functionCallsKey]: relayFunctionCalls,
        },
      },
    };
  }

  const relayEvent = { ...event };
  delete relayEvent[toolCallKey];
  return {
    frontendCalls,
    relayEvent: Object.keys(relayEvent).length > 0 ? relayEvent : null,
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

function waitForWebSocketOpen(websocket: WebSocketLike): Promise<void> {
  if (websocket.readyState === WEBSOCKET_OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    websocket.onopen = () => resolve();
    websocket.onerror = () => reject(new Error('Gemini Live WebSocket failed to open.'));
    websocket.onclose = () => reject(new Error('Gemini Live WebSocket closed before setup.'));
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
  },
): Promise<void> {
  let resolved = false;

  return new Promise((resolve, reject) => {
    const handleMessage = async (messageEvent: MessageEvent) => {
      const parsed = await parseWebSocketMessage(messageEvent.data);
      handlers.onProviderEvent?.(parsed);
      const receiveMetadata = handlers.onProviderEventReceived(parsed);
      handlers.onProviderEventTelemetry?.(parsed, receiveMetadata);

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

      if (isGeminiSetupCompleteMessage(parsed)) {
        resolved = true;
        resolve();
      }
    };

    websocket.onmessage = (messageEvent) => {
      void handleMessage(messageEvent).catch((error: unknown) => {
        if (!resolved) {
          reject(error instanceof Error ? error : new Error('Gemini Live WebSocket message handling failed.'));
        }
      });
    };

    websocket.onerror = () => {
      handlers.onWebSocketDiagnostic?.({
        timestamp: new Date().toISOString(),
        kind: 'error',
        message: 'Gemini Live WebSocket error event fired.',
        closeCode: null,
        closeReason: null,
        wasClean: null,
      });
      if (!resolved) {
        reject(new Error('Gemini Live WebSocket failed before setupComplete.'));
      }
    };
    websocket.onclose = (event) => {
      handlers.onWebSocketDiagnostic?.({
        timestamp: new Date().toISOString(),
        kind: 'close',
        message: 'Gemini Live WebSocket closed.',
        closeCode: typeof event.code === 'number' ? event.code : null,
        closeReason: typeof event.reason === 'string' && event.reason ? event.reason : null,
        wasClean: typeof event.wasClean === 'boolean' ? event.wasClean : null,
      });
      if (!resolved) {
        reject(new Error('Gemini Live WebSocket closed before setupComplete.'));
      }
    };
  });
}

function startMicrophoneAudioPipeline(options: {
  localStream: MediaStream;
  audioContext: AudioContext;
  websocket: WebSocketLike;
  onInputAudioActivity?: (diagnostic: GeminiInputAudioActivityDiagnostic) => void;
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

  const sendAudioStreamEnd = (trigger: string) => {
    if (options.websocket.readyState !== WEBSOCKET_OPEN || audioStreamEndSent) {
      return;
    }
    options.websocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
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

    if (options.websocket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    if (muted) {
      sendAudioStreamEnd('muted_audio_process');
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

    options.websocket.send(JSON.stringify({
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
      });
      framesSinceLastDiagnostic = 0;
    }
  };

  source.connect(processor);
  processor.connect(options.audioContext.destination);

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
  let nextPlaybackTime = 0;
  const activeSources = new Set<AudioBufferSourceNode>();
  const chunkHashCounts = new Map<string, number>();
  let diagnosticsEmitted = 0;
  let playbackGeneration = 0;

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

  const playBase64Chunk = (chunk: string, metadata?: GeminiOutputAudioChunkMetadata): boolean => {
    const decodeStartedAt = new Date().toISOString();
    const samples = pcm16BytesToFloat32(base64ToBytes(chunk));
    const decodeCompletedAt = new Date().toISOString();
    const currentTime = Number.isFinite(audioContext.currentTime) ? audioContext.currentTime : 0;
    const nextPlaybackTimeBefore = nextPlaybackTime;
    const activeSourceCountBefore = activeSources.size;
    if (!samples.length) {
      emitChunkDiagnostic({
        timestamp: decodeCompletedAt,
        providerReceiveSequence: metadata?.receiveMetadata?.providerReceiveSequence ?? null,
        providerRelaySequence: metadata?.receiveMetadata?.providerRelaySequence ?? null,
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
        nextPlaybackTimeBefore,
        nextPlaybackTimeAfter: nextPlaybackTime,
        activeSourceCountBefore,
        activeSourceCountAfter: activeSources.size,
        playbackGeneration,
        dropReason: null,
        scheduled: false,
      });
      return false;
    }

    const buffer = audioContext.createBuffer(1, samples.length, OUTPUT_AUDIO_RATE_HZ);
    buffer.copyToChannel(samples, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const startAt = Math.max(currentTime, nextPlaybackTime);
    const duration = Number.isFinite(buffer.duration) && buffer.duration > 0
      ? buffer.duration
      : samples.length / OUTPUT_AUDIO_RATE_HZ;

    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      source.disconnect();
    };
    const sourceStartIssuedAt = new Date().toISOString();
    source.start(startAt);
    nextPlaybackTime = startAt + duration;
    emitChunkDiagnostic({
      timestamp: sourceStartIssuedAt,
      providerReceiveSequence: metadata?.receiveMetadata?.providerReceiveSequence ?? null,
      providerRelaySequence: metadata?.receiveMetadata?.providerRelaySequence ?? null,
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
      sourceStartIssuedAt,
      audioContextCurrentTime: currentTime,
      scheduledStartTime: startAt,
      durationSeconds: duration,
      nextPlaybackTimeBefore,
      nextPlaybackTimeAfter: nextPlaybackTime,
      activeSourceCountBefore,
      activeSourceCountAfter: activeSources.size,
      playbackGeneration,
      dropReason: null,
      scheduled: true,
    });
    return true;
  };

  return {
    playEvent: (event, receiveMetadata) => {
      let played = 0;
      const chunks = readGeminiOutputAudioChunks(event);
      chunks.forEach((chunk, index) => {
        const chunkHash = hashGeminiOutputAudioChunk(chunk);
        const duplicateOrdinal = (chunkHashCounts.get(chunkHash) ?? 0) + 1;
        chunkHashCounts.set(chunkHash, duplicateOrdinal);
        if (playBase64Chunk(chunk, {
          receiveMetadata,
          chunkIndex: index,
          chunksInEvent: chunks.length,
          chunkHash,
          byteLength: estimatedBase64DecodedByteLength(chunk),
          duplicateOrdinal,
        })) {
          played += 1;
        }
      });
      return played;
    },
    playBase64Chunk,
    stop: () => {
      for (const source of activeSources) {
        try {
          source.stop();
        } catch {
          // Source may already have ended; disconnect is still safe below.
        }
        source.disconnect();
      }
      activeSources.clear();
      nextPlaybackTime = 0;
      playbackGeneration += 1;
    },
    snapshot: () => ({
      nextPlaybackTime,
      activeSourceCount: activeSources.size,
      playbackGeneration,
    }),
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

function readEphemeralToken(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return null;
  }
  const token = (value as EphemeralTokenPayload).value ?? (value as EphemeralTokenPayload).name;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
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

function promptOrToolLeakageMarker(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return null;
  if (/\bemit_artifact\b/u.test(normalized)) return 'emit_artifact';
  if (/\bread_artifact_text\b/u.test(normalized)) return 'read_artifact_text';
  if (/\bartifact_id\b/u.test(normalized)) return 'artifact_id';
  if (/\bactive_goal\s*:/u.test(normalized)) return 'active_goal';
  if (/\btool_call_id\b/u.test(normalized)) return 'tool_call_id';
  if (/^(?:tool\s+)?schema$/u.test(normalized) || /\btool\s+schema\b/u.test(normalized)) return 'tool_schema';
  if (/\b(?:system|developer|internal)\s+prompt\b/u.test(normalized)) return 'internal_prompt';
  if (/\bdeveloper\s+instructions\b/u.test(normalized)) return 'internal_prompt';
  if (/\bfunction\s*declarations?\b|\bfunctiondeclarations\b|\btool\s+payload\b/u.test(normalized)) return 'tool_schema';
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

function createToolCallLedgerEntry(toolCallId: string): GeminiBrowserLiveToolCallLedgerEntry {
  return {
    toolCallId,
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
  };
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

function emitToolCallLedgerEntry(
  ledger: Map<string, GeminiBrowserLiveToolCallLedgerEntry>,
  toolCallId: string | null,
  update: Partial<Omit<GeminiBrowserLiveToolCallLedgerEntry, 'toolCallId'>>,
  onUpdate?: (entry: GeminiBrowserLiveToolCallLedgerEntry) => void,
): GeminiBrowserLiveToolCallLedgerEntry | null {
  if (!toolCallId) {
    return null;
  }
  const current = ledger.get(toolCallId) ?? createToolCallLedgerEntry(toolCallId);
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

function redactToolCallArgsForTelemetry(
  toolName: string | null,
  args: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (isCoreviewToolName(toolName) && args) {
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

  if (toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME && args) {
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

  if (toolName !== GEMINI_RETRIEVE_MEMORIES_TOOL_NAME || !args) {
    return args;
  }
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

function redactBackendResponseForToolTelemetry(
  toolName: string | null,
  response: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (isCoreviewToolName(toolName) && response) {
    return redactCoreviewActionResponseForTelemetry(response);
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
    refresh_attempted: response.refresh_attempted === true || response.refreshAttempted === true,
    refresh_result: stringFromAnyKey(response, 'refresh_result', 'refreshResult'),
    blocked_reason: stringFromAnyKey(response, 'blocked_reason', 'blockedReason'),
    result_summary: stringFromAnyKey(response, 'result_summary', 'resultSummary'),
    command_source: stringFromAnyKey(response, 'command_source', 'commandSource'),
    preserved_mic: response.preserved_mic === true || response.preservedMic === true,
    preserved_review: response.preserved_review === true || response.preservedReview === true,
    view_ready_wait_ms: numberFromAnyKey(response, 'view_ready_wait_ms', 'viewReadyWaitMs'),
    view_signature_before_present: Boolean(stringFromAnyKey(response, 'view_signature_before', 'viewSignatureBefore')),
    view_signature_after_present: Boolean(stringFromAnyKey(response, 'view_signature_after', 'viewSignatureAfter')),
    exact_text_available: response.exact_text_available === true || response.exactTextAvailable === true,
    visual_frame_fresh: response.visual_frame_fresh === true || response.visualFrameFresh === true,
    visual_fresh: response.visual_fresh === true || response.visualFresh === true || response.visual_frame_fresh === true || response.visualFrameFresh === true,
    frame_sent: response.frame_sent === true || response.frameSent === true,
    review_active: response.review_active === true || response.reviewActive === true,
    current_view_summary: stringFromAnyKey(response, 'current_view_summary', 'currentViewSummary'),
    annotation_overlay_captured: response.annotation_overlay_captured === true || response.annotationOverlayCaptured === true
      ? true
      : response.annotation_overlay_captured === false || response.annotationOverlayCaptured === false
        ? false
        : null,
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
    raw_comment_text_excluded: true,
    review_tool_timed_out: response.review_tool_timed_out === true || response.reviewToolTimedOut === true,
    review_tool_timeout_name: stringFromAnyKey(response, 'review_tool_timeout_name', 'reviewToolTimeoutName'),
    review_tool_timeout_result_sent: response.review_tool_timeout_result_sent === true || response.reviewToolTimeoutResultSent === true,
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
  return stringFromAnyKey(args, 'task_id', 'taskId');
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
