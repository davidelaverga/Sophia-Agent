/**
 * Types Index
 * ===========
 * 
 * Re-export all types from this directory for convenient imports.
 * 
 * @example
 * import type { ChatMessage, SessionSummary } from "../types"
 */

// Conversation types
export type {
  MessageRole,
  MessageStatus,
  MessageSource,
  InputMode,
  EmotionData,
  ChatMessage,
  ApiMessage,
  SessionSummary,
  SessionWithMessages,
  ConversationSummary,
  ArchivedConversation,
  ConversationHistory,
} from "./conversation"

export {
  apiMessageToChatMessage,
  chatMessageToApiMessage,
  determineInputMode,
} from "./conversation"

// Rate limit types
export type { UsageLimitInfo } from "./rate-limits"

// Session types
export type {
  PresetType,
  ContextMode,
  SessionStatus,
  InvokeType,
  MemoryCategory,
  BriefingSource,
  MicroBriefingIntent,
  SessionMessage,
  MemoryHighlight,
  SessionStartRequest,
  SessionStartResponse,
  SessionEndRequest,
  SessionEndResponse,
  ActiveSessionResponse,
  SessionInfo,
  MicroBriefingRequest,
  MicroBriefingResponse,
  SessionContext,
  SessionClientStore,
  CompanionButton,
  CompanionInvokeRequest,
  CompanionInvokeResponse,
  CompanionSessionContext,
  RitualArtifacts,
  ReflectionCandidate,
  MemoryCandidate,
  EmotionSignals,
  NudgeSuggestion,
  ErrorModalProps,
  ErrorModalAction,
  PresetConfig,
  ContextModeConfig,
  InterruptKind,
  MicroDialogKind,
  InterruptOption,
  InterruptPayload,
  ResumePayload,
  ChatStreamRequest,
  PendingInterrupt,
  ResolvedInterrupt,
} from "./session"

// Recap types
export type {
  RecapArtifactsV1,
  MemoryCandidateV1,
  MemoryDecisionStatus,
  MemoryDecision,
  MemoryDecisionState,
  BackendArtifactsPayload,
  CommitMemoriesRequest,
  CommitMemoriesResponse,
} from "./recap"

export {
  MAX_MEMORY_CANDIDATES,
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  TAG_LABELS,
} from "./recap"

// Session Snapshot types (Phase 4 - Week 4)
export type {
  ActiveSessionMeta,
  LastViewType,
  SessionSnapshot,
  SnapshotSummary,
} from "./session-snapshot"

export {
  SESSION_SNAPSHOT_SCHEMA_VERSION,
  SESSION_SNAPSHOT_STORAGE_KEY,
  SESSION_SNAPSHOT_MAX_AGE_HOURS,
  isSnapshotStale,
  isSnapshotVersionValid,
  createEmptySnapshot,
  getSnapshotSummary,
} from "./session-snapshot"

// Conversation Identity types (Phase 4 - Week 4 - Subphase 3)
export type {
  ConversationId,
  SessionId,
  ThreadId,
  TurnId,
  MessageId,
  ConversationIdentity,
  BackendConversationListItem,
  BackendMessage,
  BackendSessionStatus,
  ConversationCursor,
  IdentifiedMessage,
} from "./conversation-identity"

export {
  generateConversationId,
  generateTurnId,
  generateMessageId,
  generateContentHash,
  generateMessageFingerprint,
  isConversationId,
  isTurnId,
  isMessageId,
} from "./conversation-identity"
