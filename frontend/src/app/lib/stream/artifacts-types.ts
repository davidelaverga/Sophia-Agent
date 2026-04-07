/**
 * Artifacts Types
 * Sprint 1+ - Shared type for Lane B data parts
 * 
 * CRITICAL RULES (per Sprint 1+ spec):
 * - reflection_candidate is a STRING (not object)
 * - memory_candidates[].text is the canonical field (not "memory")
 * - Cap to 3 memory candidates max
 */

// =============================================================================
// ARTIFACTS PAYLOAD
// =============================================================================

export interface ArtifactsPayload {
  /** Main takeaway from the session */
  takeaway?: string;
  
  /** Reflection prompt for the user (STRING, not object) */
  reflection_candidate?: string;
  
  /** Memory candidates for user to approve */
  memory_candidates?: MemoryCandidate[];
  
  /** Status of artifacts generation */
  artifacts_status: 'pending' | 'complete' | 'error';
}

export interface MemoryCandidate {
  /** Unique ID for this candidate */
  id: string;
  
  /** The memory text (canonical field - NOT "memory") */
  text: string;
  
  /** Category of memory */
  category?: 'identity_profile' | 'relationship_context' | 'goals_projects' | 
             'emotional_patterns' | 'regulation_tools' | 'preferences_boundaries' | 
             'wins_pride' | 'temporary_context';
  
  /** Confidence score (0-1) */
  confidence?: number;
  
  /** Why Sophia suggests this memory */
  reason?: string;
}

// HARD RULE: Max 3 memory candidates per response
export const MAX_MEMORY_CANDIDATES = 3;

// =============================================================================
// DATA PART TYPES (from Lane B stream)
// =============================================================================

export interface ArtifactsDataPart {
  type: 'artifactsV1' | 'artifacts';
  data: ArtifactsPayload;
}

export interface TraceDataPart {
  type: 'trace';
  skill_used?: string;
  llm_provider?: string;
  latency_ms?: number;
}

export type StreamDataPart = ArtifactsDataPart | TraceDataPart | { type: string; [key: string]: unknown };

// =============================================================================
// TYPE GUARDS
// =============================================================================

export function isArtifactsDataPart(part: unknown): part is ArtifactsDataPart {
  if (!part || typeof part !== 'object') return false;
  const p = part as Record<string, unknown>;
  return p.type === 'artifactsV1' || p.type === 'artifacts';
}

export function isTraceDataPart(part: unknown): part is TraceDataPart {
  if (!part || typeof part !== 'object') return false;
  const p = part as Record<string, unknown>;
  return p.type === 'trace';
}
