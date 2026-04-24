/**
 * SophiaUIMessage — The Shared Contract
 * Sprint 1+ - Prevents Prompt Bloat
 * 
 * This type is the SOURCE OF TRUTH for UI messages.
 * Backend converts this to ModelMessage just-in-time.
 * Frontend stores and renders this as-is.
 * 
 * CRITICAL: metadata and data parts NEVER reach the LLM.
 */

// =============================================================================
// METADATA (UI-only, never sent to model)
// =============================================================================

export interface SophiaMessageMetadata {
  // Identity (for tracing/resume)
  thread_id: string;
  run_id?: string;
  session_id: string;
  
  // Context (for UI display)
  session_type: 'prepare' | 'debrief' | 'reset' | 'vent' | 'open';
  preset_context: 'gaming' | 'work' | 'life';
  invoke_type: 'text' | 'voice';
  
  // Artifacts status
  artifacts_status: 'none' | 'pending' | 'complete' | 'error';
  
  // Memory sources (for debugging/trust UI)
  memory_sources_used?: ('flash' | 'mem0' | 'openmemory')[];
  
  // Skill and emotion metadata from backend
  skill_used?: string;
  emotion_detected?: string;
  session_title?: string;
  
  // CRITICAL: Bootstrap flag
  // If true, this message is excluded from model context
  isBootstrap?: boolean;
  
  // Timestamps
  computed_at?: string;
}

// =============================================================================
// DATA PARTS (UI-only, never sent to model unless explicitly converted)
// =============================================================================

export interface SophiaArtifactsV1 {
  type: 'artifactsV1';
  takeaway?: string;
  reflection_candidate?: string;
  memory_candidates?: Array<{
    id: string;
    text: string;
    memory?: string;
    category?: string;
    created_at?: string;
    confidence?: number;
    reason?: string;  // "Why Sophia suggests this" for trust UI
  }>;
}

export interface SophiaTraceData {
  type: 'trace';
  skill_used?: string;
  llm_provider?: string;
  latency_ms?: number;
}

export type SophiaDataPart = SophiaArtifactsV1 | SophiaTraceData;

// =============================================================================
// INTERRUPT PAYLOAD
// =============================================================================

export interface SophiaInterruptPayload {
  kind: 'DEBRIEF_OFFER' | 'RESET_OFFER' | 'NUDGE_OFFER' | 'MICRO_DIALOG';
  title: string;
  message: string;
  options: Array<{ 
    id: string; 
    label: string; 
    style?: 'primary' | 'secondary' | 'danger';
  }>;
  snooze?: boolean;
  expiresAt?: string;
}

// =============================================================================
// FEEDBACK (for learning loop)
// =============================================================================

export type FeedbackType = 'helpful' | 'not_helpful' | 'inappropriate';

export interface MessageFeedback {
  message_id: string;
  feedback_type: FeedbackType;
  created_at: string;
  comment?: string;
}

// =============================================================================
// THE MAIN TYPE
// =============================================================================

export interface SophiaUIMessage {
  // Core fields (these DO go to model, after pruning)
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt?: string;
  
  // UI-only fields (NEVER sent to model)
  metadata?: SophiaMessageMetadata;
  data?: SophiaDataPart[];
  
  // Interrupt state (for resume UX)
  interrupt?: SophiaInterruptPayload;
  
  // Feedback state
  feedback?: FeedbackType;
  
  // Animation/display flags
  isNew?: boolean;
  incomplete?: boolean;
}

// =============================================================================
// HELPER: Check if message should be excluded from model context
// =============================================================================

export function shouldExcludeFromModel(message: SophiaUIMessage): boolean {
  // Bootstrap messages are never sent to the model
  if (message.metadata?.isBootstrap) return true;
  
  // System messages with bootstrap pattern
  if (message.role === 'system' && message.id.startsWith('bootstrap')) return true;
  
  return false;
}

// =============================================================================
// HELPER: Convert SophiaUIMessage[] to minimal model messages
// NOTE: This is for REFERENCE/DEBUG only. Production conversion is backend-only.
// =============================================================================

export function convertToModelMessagesDebug(
  messages: SophiaUIMessage[],
  options?: { maxTurns?: number }
): Array<{ role: string; content: string }> {
  const maxTurns = options?.maxTurns ?? 10;
  
  return messages
    .filter(m => !shouldExcludeFromModel(m))
    .slice(-maxTurns)
    .map(m => ({ role: m.role, content: m.content }));
}

// =============================================================================
// EMOTIONAL WEATHER (for UI indicators)
// =============================================================================

export type EmotionalTrend = 'improving' | 'stable' | 'declining' | 'unknown';

export interface EmotionalWeather {
  trend: EmotionalTrend;
  label: string;
  confidence?: number;
  last_updated?: string;
}

// =============================================================================
// BOOTSTRAP RESPONSE (from backend)
// =============================================================================

export interface BootstrapResponse {
  user_id: string;
  thread_id: string;
  opening_message: string;
  opening_tone: 'warm' | 'energizing' | 'grounding' | 'supportive';
  top_memories: Array<{ content: string; category: string }>;
  suggested_ritual: 'prepare' | 'debrief' | 'reset' | 'vent' | null;
  suggested_preset: 'gaming' | 'work' | 'life' | null;
  suggestion_reason: string | null;
  ui_cards: UICard[];
  emotional_weather?: EmotionalWeather;
  computed_at: string;
  cache_hit: boolean;
}

export interface UICard {
  type: 'welcome' | 'suggestion' | 'context' | 'memory_highlight' | 'emotional_weather';
  title?: string;
  content?: string;
  memories?: Array<{ content: string; category: string }>;
  action?: string;
  ritual?: string;
  trend?: EmotionalTrend;
  label?: string;
}
