import type { BuilderArtifactV1 } from './builder-artifact';

/**
 * Session Types for Sophia V2
 * Sprint 1+ Phase 3
 * 
 * Core types for session management, presets, and companion interactions
 * Updated to match backend Sessions API contract
 */

// ============================================================================
// CORE ENUMS / LITERALS
// ============================================================================

export type PresetType = 'prepare' | 'debrief' | 'reset' | 'vent' | 'open' | 'chat';
export type ContextMode = 'gaming' | 'work' | 'life';
export type SessionStatus = 'active' | 'paused' | 'ended' | 'pending_debrief';
export type InvokeType = 'quick_question' | 'plan_reminder' | 'tilt_reset' | 'micro_debrief';

/** Source of briefing/greeting data */
export type BriefingSource = 'openmemory' | 'mem0' | 'fallback' | 'none';

/** Intent types for micro-briefing requests */
export type MicroBriefingIntent = 'interrupt_checkin' | 'quick_reset' | 'reflection_prompt' | 'nudge';

export type CanonicalMemoryCategory =
  | 'identity_profile'
  | 'relationship_context'
  | 'goals_projects'
  | 'emotional_patterns'
  | 'regulation_tools'
  | 'preferences_boundaries'
  | 'wins_pride'
  | 'temporary_context';

export type LegacySessionMemoryCategory =
  | 'episodic'
  | 'emotional'
  | 'reflective';

export type MemoryCategory =
  | CanonicalMemoryCategory
  | LegacySessionMemoryCategory;

export const CANONICAL_MEMORY_CATEGORIES = [
  'identity_profile',
  'relationship_context',
  'goals_projects',
  'emotional_patterns',
  'regulation_tools',
  'preferences_boundaries',
  'wins_pride',
  'temporary_context',
] as const satisfies CanonicalMemoryCategory[];

// ============================================================================
// SESSION MESSAGE (lightweight for persistence)
// ============================================================================

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** True if message was interrupted mid-stream (e.g., user left session) */
  incomplete?: boolean;
}

// ============================================================================
// MEMORY HIGHLIGHT (from Sessions API)
// ============================================================================

/**
 * Memory highlight returned from session start/micro-briefing
 * Max 3 per session start, max 2 per micro-briefing
 */
export interface MemoryHighlight {
  id: string;
  /** Short, display-ready text (max 100 chars) */
  text: string;
  /** Category of memory */
  category?: LegacySessionMemoryCategory;
  /** Salience score 0-1 */
  salience?: number;
  /** Human-readable recency */
  recency_label?: string;
}

// ============================================================================
// SESSIONS API TYPES
// ============================================================================

/**
 * POST /api/v1/sessions/start - Request
 */
export interface SessionStartRequest {
  session_type: PresetType;
  preset_context: ContextMode;
  intention?: string;
  focus_cue?: string;
}

/**
 * POST /api/v1/sessions/start - Response
 */
export interface SessionStartResponse {
  /** Session identifiers */
  session_id: string;
  thread_id: string;
  
  /** The "magic opener" - render as first assistant message */
  greeting_message: string;
  /** Message ID for AI SDK persistence */
  message_id: string;
  
  /** Memory highlights (max 3) - render as cards */
  memory_highlights: MemoryHighlight[];
  
  /** Resume behavior */
  is_resumed: boolean;
  
  /** Provenance */
  briefing_source: BriefingSource;
  has_memory: boolean;
  
  /** Session metadata */
  session_type: string;
  preset_context: string;
  started_at: string;
}

/**
 * POST /api/v1/sessions/end - Request
 */
export interface SessionEndRequest {
  session_id: string;
  thread_id?: string;
  user_id?: string;
  offer_debrief?: boolean;
  session_type?: PresetType;
  context_mode?: ContextMode;
  started_at?: string;
  ended_at?: string;
  turn_count?: number;
  platform?: 'voice' | 'text' | 'ios_voice';
  messages?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    created_at?: string;
  }>;
  recap_artifacts?: {
    takeaway?: string;
    session_takeaway?: string;
    reflection?: {
      prompt?: string;
      tag?: string;
    };
    reflection_candidate?: {
      prompt?: string;
      tag?: string;
    };
    memory_candidates?: Array<{
      id?: string;
      candidate_id?: string;
      text?: string;
      memory?: string;
      category?: string;
      created_at?: string;
      confidence?: number;
      reason?: string;
      source?: string;
    }>;
    builder_artifact?: BuilderArtifactV1;
    memories_created?: number;
    status?: string;
  };
}

/**
 * POST /api/v1/sessions/end - Response
 */
export interface SessionEndResponse {
  status?: string;
  session_id: string;
  ended_at: string;
  duration_minutes: number;
  turn_count: number;
  
  /** 
   * Full recap artifacts (may be null for short sessions)
   * Contains takeaway, reflection candidate, and memory candidates
   */
  recap_artifacts?: {
    takeaway?: string;
    session_takeaway?: string;
    /** Alternative reflection structure (matches BackendArtifactsPayload) */
    reflection?: {
      prompt?: string;
      tag?: string;
    };
    reflection_candidate?: {
      prompt?: string;
      tag?: string;
    };
    memory_candidates?: Array<{
      id?: string;
      candidate_id?: string;
      text?: string;
      memory?: string;
      category?: string;
      created_at?: string;
      confidence?: number;
      reason?: string;
      source?: string;
    }>;
    builder_artifact?: BuilderArtifactV1;
    memories_created?: number;
    status?: string;
  };
  
  /** Debrief offer */
  offer_debrief: boolean;
  debrief_prompt?: string;
}

/**
 * POST /api/v1/sessions/debrief-decision - Request
 */
export interface DebriefDecisionRequest {
  session_id: string;
  decision: 'debrief' | 'skip';
}

/**
 * POST /api/v1/sessions/debrief-decision - Response
 */
export interface DebriefDecisionResponse {
  session_id: string;
  decision: 'debrief' | 'skip';
  recorded_at: string;
}

/**
 * GET /api/v1/sessions/active - Response
 */
export interface ActiveSessionResponse {
  has_active_session: boolean;
  session?: SessionInfo;
}

/**
 * Session info returned from session endpoints
 */
export interface SessionInfo {
  session_id: string;
  thread_id: string;
  session_type: string;
  preset_context: string;
  status: string;
  started_at: string;
  updated_at: string;
  ended_at?: string | null;
  turn_count: number;
  title?: string | null;
  last_message_preview?: string | null;
  platform?: string;
  intention?: string;
  focus_cue?: string;
}

/**
 * GET /api/v1/sessions/open - Response
 */
export interface OpenSessionsResponse {
  sessions: SessionInfo[];
  count: number;
}

/**
 * GET /api/v1/sessions/list - Response
 */
export interface SessionListResponse {
  sessions: SessionInfo[];
  total: number;
}

/**
 * PATCH /api/v1/sessions/{id} - Request
 */
export interface SessionUpdateRequest {
  title?: string;
}

/**
 * GET /api/v1/sessions/{id}/messages - Response message
 */
export interface SessionMessageItem {
  id: string;
  role: 'user' | 'sophia';
  content: string;
  created_at: string | null;
}

/**
 * GET /api/v1/sessions/{id}/messages - Response
 */
export interface SessionMessagesResponse {
  session_id: string;
  thread_id: string;
  messages: SessionMessageItem[];
}

/**
 * POST /api/v1/sessions/micro-briefing - Request
 */
export interface MicroBriefingRequest {
  intent: MicroBriefingIntent;
  preset_context: ContextMode;
  session_type?: PresetType;
}

/**
 * POST /api/v1/sessions/micro-briefing - Response
 */
export interface MicroBriefingResponse {
  message_id: string;
  /** One-liner to display */
  assistant_text: string;
  /** Max 1-2 highlights */
  highlights: MemoryHighlight[];
  /** Future: structured UI cards */
  ui_cards?: object[];
  briefing_source: BriefingSource;
  has_memory: boolean;
}

/**
 * GET /api/v1/sessions/{session_id}/context - Response
 */
export interface SessionContext {
  session_id: string;
  thread_id: string;
  session_type: string;
  preset_context: string;
  intention?: string;
  focus_cue?: string;
  turn_count: number;
  duration_minutes: number;
}

// ============================================================================
// SESSION CLIENT STORE
// ============================================================================

export interface SessionClientStore {
  // IDs
  sessionId: string;
  threadId: string;
  userId: string;
  
  // Session config
  presetType: PresetType;
  contextMode: ContextMode;
  status: SessionStatus;
  
  // Voice mode flag (voice-first experience)
  voiceMode: boolean;
  
  // Timestamps
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string;
  /** Seconds actively spent inside /session view (excludes paused time) */
  activeElapsedSeconds?: number;
  /** Timestamp when current active segment began */
  activeSegmentStartedAt?: string;
  
  // Optional context
  gameName?: string;
  intention?: string;
  focusCue?: string;
  
  // State flags
  isActive: boolean;
  companionInvokesCount: number;
  
  // Memory/greeting from session start (via POST /sessions/start)
  greetingMessage?: string;
  /** Message ID from backend - use for AI SDK persistence */
  greetingMessageId?: string;
  memoryHighlights?: MemoryHighlight[];
  isResumed?: boolean;
  hasMemory?: boolean;
  briefingSource?: BriefingSource;
  
  // Conversation history (persisted for session recovery)
  messages?: SessionMessage[];
  
  // Artifacts (populated on session end)
  artifacts?: RitualArtifacts;
  builderArtifact?: BuilderArtifactV1;
  summary?: string;
}

// ============================================================================
// COMPANION TYPES
// ============================================================================

export interface CompanionButton {
  type: InvokeType;
  label: string;
  icon: string;
  timeoutSeconds: number;
  description: string;
}

export interface CompanionInvokeRequest {
  invoke_type: InvokeType;
  transcript: string;
  thread_id?: string;
  session_context?: CompanionSessionContext;
}

export interface CompanionInvokeResponse {
  /** Backend response format */
  assistant_message?: string;
  artifacts?: Record<string, unknown>;
  tts_style?: string | null;
  thread_id?: string;
  invoke_type?: string;
  /** Legacy format */
  response?: string;
  suggested_action?: string;
  emotion_detected?: string;
}

/** Legacy session context for companion invokes (different from API SessionContext) */
export interface CompanionSessionContext {
  session_id: string;
  preset_type: PresetType;
  context_mode: ContextMode;
  game_name?: string;
  intention?: string;
  elapsed_seconds?: number;
}

// ============================================================================
// ARTIFACTS
// ============================================================================

export interface RitualArtifacts {
  takeaway: string;
  reflection_candidate?: ReflectionCandidate;
  memory_candidates?: MemoryCandidate[];
  signals?: EmotionSignals;
  session_type?: PresetType;
  preset_context?: ContextMode;
  timestamp?: string;
}

export interface ReflectionCandidate {
  prompt: string;
  why?: string;
  category?: string;
}

export interface MemoryCandidate {
  id?: string;
  memory: string;
  category: MemoryCategory;
  confidence: number;
  tags?: string[];
  created_at?: string;
  reason?: string;
  source_turn?: number;
}

export interface EmotionSignals {
  top_emotions?: string[];
  valence?: number;
  arousal?: number;
}

// ============================================================================
// NUDGE TYPES
// ============================================================================

export interface NudgeSuggestion {
  message: string;
  actionType: InvokeType;
  priority: 'low' | 'medium' | 'high';
  trigger?: string;
}

// ============================================================================
// UI COMPONENT PROPS
// ============================================================================

export interface ErrorModalProps {
  title: string;
  message: string;
  actions: ErrorModalAction[];
}

export interface ErrorModalAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

// ============================================================================
// PRESET CONFIGURATIONS
// ============================================================================

export interface PresetConfig {
  type: PresetType;
  icon: string;
  labels: Record<ContextMode, { title: string; description: string }>;
}

export interface ContextModeConfig {
  value: ContextMode;
  label: string;
  emoji: string;
}

// ============================================================================
// INTERRUPT TYPES (Phase 2 - Streaming + Resume)
// ============================================================================

/**
 * Interrupt kinds for permissioned UI interactions
 * These are sent by the backend when Sophia needs user confirmation
 */
export type InterruptKind =
  | 'DEBRIEF_OFFER'
  | 'RESET_OFFER'
  | 'NUDGE_OFFER'
  | 'MICRO_DIALOG';

export type MicroDialogKind =
  | 'tilt_reset'
  | 'micro_debrief'
  | 'plan_choice'
  | 'breathing_style'
  | 'confirm_action';

export interface InterruptOption {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'ghost';
}

/**
 * Universal Interrupt Payload
 * Covers all interactive prompts from the backend
 */
export type InterruptPayload =
  | {
      kind: 'DEBRIEF_OFFER' | 'RESET_OFFER' | 'NUDGE_OFFER';
      title: string;
      message: string;
      options: InterruptOption[];
      snooze?: boolean;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: 'MICRO_DIALOG';
      dialogKind: MicroDialogKind;
      title: string;
      message: string;
      options: InterruptOption[];
      metadata?: Record<string, unknown>;
    };

/**
 * Resume payload sent back to backend when user makes a choice
 */
export interface ResumePayload {
  thread_id: string;
  session_id: string;
  resume: {
    kind: InterruptKind;
    action: 'accept' | 'dismiss' | 'snooze' | 'select';
    option_id: string;
    extra?: Record<string, unknown>;
  };
}

/**
 * Chat request payload for streaming API
 */
export interface ChatStreamRequest {
  session_id: string;
  thread_id: string;
  preset: PresetType;
  context_mode: ContextMode;
  message: string;
  voice_mode?: boolean;
}

/**
 * Pending interrupt state (for UI recovery on reload)
 */
export interface PendingInterrupt {
  interrupt: InterruptPayload;
  receivedAt: string;
  messageId?: string;
}

/**
 * Resolved interrupt (for showing "You chose X" in chat)
 */
export interface ResolvedInterrupt {
  kind: InterruptKind;
  title: string;
  selectedOption: InterruptOption;
  resolvedAt: string;
}
