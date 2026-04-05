/**
 * Session Snapshot Types
 * Phase 4 - Week 4: Resume Session
 * 
 * Defines the "Persisted Session Snapshot" contract for localStorage.
 * This is the single source of truth for restoring UI state after refresh.
 * 
 * Storage key: sophia.session.snapshot.v1
 */

import type { ChatMessage } from './conversation';
import type { FocusMode } from '../stores/ui-store';
import type { PresetType, ContextMode, MemoryHighlight } from './session';

// =============================================================================
// SCHEMA VERSION
// =============================================================================

/**
 * Current schema version. Increment when making breaking changes.
 * Old snapshots with different versions will be soft-reset.
 */
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Active session metadata (ritual context)
 */
export interface ActiveSessionMeta {
  /** Session type: prepare, debrief, reset, vent, open, chat */
  session_type: PresetType;
  /** Context: gaming, work, life */
  preset_context?: ContextMode;
  /** Session ID from backend (UUID) */
  session_id: string;
  /** Thread ID for conversation continuity */
  thread_id: string;
  /** User's stated intention for the session */
  intention?: string;
  /** Memory highlights shown at session start */
  memory_highlights?: MemoryHighlight[];
  /** Voice mode enabled? */
  voice_mode?: boolean;
  /** When the session started */
  started_at: string;
  /** Is session still active or ended? */
  status: 'active' | 'paused' | 'ended';
}

/**
 * Last view tracking for recap integration
 */
export type LastViewType = 'conversation' | 'recap' | 'home';

/**
 * The complete persisted session snapshot.
 * This is what gets saved to localStorage on "safe moments".
 */
export interface SessionSnapshot {
  /** Schema version for migration support */
  schema_version: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;
  
  /** Conversation identifier from backend */
  conversation_id?: string;
  
  /** Chat messages (user + sophia) */
  messages: ChatMessage[];
  
  /** Turn ID of last completed exchange */
  last_completed_turn_id?: string;
  
  /** Current UI mode (voice/text) */
  active_mode: FocusMode;
  
  /** Ritual session metadata (if in a ritual) */
  active_session_meta?: ActiveSessionMeta;
  
  /** Last view user was on (for recap integration) */
  last_view?: LastViewType;
  
  /** Session ID if last view was recap */
  last_recap_session_id?: string;
  
  /** When the snapshot was last updated */
  updated_at: string;
  
  /** User ID for validation (don't restore if different user) */
  user_id?: string;
}

// =============================================================================
// STORAGE KEY
// =============================================================================

export const SESSION_SNAPSHOT_STORAGE_KEY = 'sophia.session.snapshot.v1';

// =============================================================================
// VALIDATION & DEFAULTS
// =============================================================================

/**
 * Maximum age of a snapshot before it's considered stale (in hours)
 */
export const SESSION_SNAPSHOT_MAX_AGE_HOURS = 24;

/**
 * Check if a snapshot is too old to restore
 */
export function isSnapshotStale(snapshot: SessionSnapshot): boolean {
  const updatedAt = new Date(snapshot.updated_at);
  const ageHours = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
  return ageHours > SESSION_SNAPSHOT_MAX_AGE_HOURS;
}

/**
 * Check if snapshot has the correct schema version
 */
export function isSnapshotVersionValid(snapshot: unknown): snapshot is SessionSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const s = snapshot as Partial<SessionSnapshot>;
  return s.schema_version === SESSION_SNAPSHOT_SCHEMA_VERSION;
}

/**
 * Create an empty/default snapshot
 */
export function createEmptySnapshot(userId?: string): SessionSnapshot {
  return {
    schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
    messages: [],
    active_mode: 'voice',
    updated_at: new Date().toISOString(),
    user_id: userId,
  };
}

/**
 * Summary info for UI display (without full messages)
 */
export interface SnapshotSummary {
  hasSnapshot: boolean;
  messageCount: number;
  lastMessagePreview?: string;
  sessionType?: PresetType;
  contextMode?: ContextMode;
  updatedAt: string;
  isStale: boolean;
  lastView?: LastViewType;
}

/**
 * Extract a summary from a snapshot (for UI display)
 */
export function getSnapshotSummary(snapshot: SessionSnapshot | null): SnapshotSummary {
  if (!snapshot) {
    return {
      hasSnapshot: false,
      messageCount: 0,
      updatedAt: new Date().toISOString(),
      isStale: true,
    };
  }
  
  const lastMessage = snapshot.messages[snapshot.messages.length - 1];
  
  return {
    hasSnapshot: true,
    messageCount: snapshot.messages.length,
    lastMessagePreview: lastMessage?.content.slice(0, 100),
    sessionType: snapshot.active_session_meta?.session_type,
    contextMode: snapshot.active_session_meta?.preset_context,
    updatedAt: snapshot.updated_at,
    isStale: isSnapshotStale(snapshot),
    lastView: snapshot.last_view,
  };
}
