/**
 * Recap Types
 * Phase 3 - Week 3
 * 
 * Type definitions for the Recap view model.
 * All fields optional except IDs for graceful rendering.
 */

import type { BuilderArtifactV1 } from './builder-artifact';
import type { PresetType, ContextMode, CanonicalMemoryCategory } from './session';

// =============================================================================
// RECAP VIEW MODEL
// =============================================================================

export interface RecapArtifactsV1 {
  /** Session identifier */
  sessionId: string;

  /** Thread identifier for artifact downloads */
  threadId?: string;
  
  /** Type of session */
  sessionType: PresetType;
  
  /** Context mode */
  contextMode: ContextMode;
  
  /** When session started */
  startedAt?: string;
  
  /** When session ended */
  endedAt?: string;
  
  /** Main takeaway - 1-2 sentences max */
  takeaway?: string;
  
  /** Reflection prompt for user */
  reflectionCandidate?: {
    prompt: string;
    tag?: 'tilt' | 'focus' | 'confidence' | 'communication' | 'boundaries' | 'growth';
  };
  
  /** Memory candidates for user approval (max 3) */
  memoryCandidates?: MemoryCandidateV1[];

  /** Builder deliverable emitted during the session */
  builderArtifact?: BuilderArtifactV1;
  
  /** Processing status */
  status: 'processing' | 'ready' | 'unavailable';
}

export interface MemoryCandidateV1 {
  /** Unique ID for this candidate */
  id: string;
  
  /** The memory text */
  text: string;

  /** Legacy memory text fallback (older backend payloads) */
  memory?: string;
  
  /** Category of memory */
  category?: CanonicalMemoryCategory | string;

  /** Creation timestamp from Mem0 */
  created_at?: string;
  
  /** Confidence score (0-1) */
  confidence?: number;
  
  /** Why Sophia suggests this memory (for trust UI) */
  reason?: string;
}

// =============================================================================
// MEMORY DECISION STATE
// =============================================================================

/** Full state machine for memory candidate decisions */
export type MemoryDecisionStatus = 
  | 'idle'           // Not yet reviewed
  | 'approved'       // User approved (pending commit)
  | 'edited'         // User edited (pending commit)
  | 'discarded'      // User discarded
  | 'committing'     // Being sent to backend
  | 'committed'      // Successfully saved to Mem0
  | 'error';         // Failed to commit

/** Simplified decision for UI actions */
export type MemoryDecision = 'idle' | 'approved' | 'edited' | 'discarded';

export interface MemoryDecisionState {
  candidateId: string;
  decision: MemoryDecision;
  status: MemoryDecisionStatus;
  editedText?: string;
  errorMessage?: string;
  timestamp: string;
}

// =============================================================================
// BACKEND API TYPES
// =============================================================================

/** Raw artifacts from backend (may have different shape) */
export interface BackendArtifactsPayload {
  session_id?: string;
  thread_id?: string;
  session_type?: string;
  preset?: string;
  context_mode?: string;
  started_at?: string;
  ended_at?: string;
  takeaway?: string;
  session_takeaway?: string; // Alternative field name
  reflection_candidate?: {
    prompt?: string;
    tag?: string;
  };
  reflection?: { // Alternative structure
    prompt?: string;
    tag?: string;
  };
  memory_candidates?: Array<{
    id?: string;
    candidate_id?: string;
    text?: string;
    memory?: string; // Alternative field name
    category?: string;
    created_at?: string;
    confidence?: number;
    reason?: string;
    source?: string;
  }>;
  signals?: {
    top_emotions?: string[];
  };
  builder_artifact?: BuilderArtifactV1;
  builderArtifact?: BuilderArtifactV1;
  builder_result?: BuilderArtifactV1;
  status?: string;
}

/** Request body for committing memory decisions */
export interface CommitMemoriesRequest {
  session_id: string;
  thread_id?: string;
  decisions: Array<{
    candidate_id: string;
    decision: 'approve' | 'discard';
    text: string;
    category?: string;
    source: 'recap';
    metadata?: {
      session_type?: string;
      preset?: string;
    };
  }>;
}

/** Response from commit-candidates endpoint */
export interface CommitMemoriesResponse {
  committed: string[];
  discarded: string[];
  errors: Array<{
    candidate_id: string;
    message: string;
  }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

export const MAX_MEMORY_CANDIDATES = 3;

export type RecapMemoryCategory = CanonicalMemoryCategory;

type CategoryPresentation = {
  label: string;
  icon: string;
  badgeClassName: string;
};

const UNKNOWN_CATEGORY_PRESENTATION: CategoryPresentation = {
  label: 'Memory',
  icon: '•',
  badgeClassName: 'bg-sophia-surface/80 text-sophia-text2 border border-sophia-surface-border/80',
};

export const CATEGORY_LABELS: Record<string, string> = {
  identity_profile: 'Identity',
  relationship_context: 'Relationships',
  goals_projects: 'Goals & Projects',
  emotional_patterns: 'Emotional Patterns',
  regulation_tools: 'Regulation Tools',
  preferences_boundaries: 'Preferences & Boundaries',
  wins_pride: 'Wins & Pride',
  temporary_context: 'Right Now',
};

export const CATEGORY_ICONS: Record<string, string> = {
  identity_profile: '🪪',
  relationship_context: '🤝',
  goals_projects: '🎯',
  emotional_patterns: '💜',
  regulation_tools: '🫁',
  preferences_boundaries: '⚙️',
  wins_pride: '🏆',
  temporary_context: '🕰️',
};

export const CATEGORY_BADGE_STYLES: Record<string, string> = {
  identity_profile: 'bg-cyan-500/12 text-cyan-100 border border-cyan-300/25',
  relationship_context: 'bg-rose-500/12 text-rose-100 border border-rose-300/25',
  goals_projects: 'bg-amber-500/12 text-amber-100 border border-amber-300/25',
  emotional_patterns: 'bg-fuchsia-500/12 text-fuchsia-100 border border-fuchsia-300/25',
  regulation_tools: 'bg-emerald-500/12 text-emerald-100 border border-emerald-300/25',
  preferences_boundaries: 'bg-sky-500/12 text-sky-100 border border-sky-300/25',
  wins_pride: 'bg-orange-500/12 text-orange-100 border border-orange-300/25',
  temporary_context: 'bg-slate-400/12 text-slate-100 border border-slate-300/25',
};

export function isRecapMemoryCategory(category: string | null | undefined): category is RecapMemoryCategory {
  return typeof category === 'string' && category in CATEGORY_LABELS;
}

export function normalizeRecapMemoryCategory(category: string | null | undefined): RecapMemoryCategory | null {
  return isRecapMemoryCategory(category) ? category : null;
}

export function getRecapCategoryPresentation(category: string | null | undefined): CategoryPresentation {
  const normalized = normalizeRecapMemoryCategory(category);
  if (!normalized) {
    return UNKNOWN_CATEGORY_PRESENTATION;
  }

  return {
    label: CATEGORY_LABELS[normalized],
    icon: CATEGORY_ICONS[normalized],
    badgeClassName: CATEGORY_BADGE_STYLES[normalized],
  };
}

export const TAG_LABELS: Record<string, string> = {
  tilt: 'Managing Tilt',
  focus: 'Focus & Flow',
  confidence: 'Building Confidence',
  communication: 'Communication',
  boundaries: 'Setting Boundaries',
  growth: 'Personal Growth',
};
