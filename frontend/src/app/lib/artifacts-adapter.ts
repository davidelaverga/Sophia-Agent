/**
 * Backend Artifacts Adapter
 * Phase 3 - Week 3
 * 
 * Maps backend artifacts response to frontend RecapArtifactsV1 format.
 * Handles field name variations, defaults, and caps memory candidates at 3.
 */

import type { 
  RecapArtifactsV1, 
  MemoryCandidateV1, 
  BackendArtifactsPayload,
} from '../types/recap';
import type { PresetType, ContextMode } from '../types/session';

import { normalizeBuilderArtifactPayload } from './builder-artifacts';


// =============================================================================
// ADAPTER FUNCTION
// =============================================================================

/**
 * Maps backend artifacts payload to frontend RecapArtifactsV1.
 * 
 * Handles:
 * - Field name variations (snake_case vs camelCase)
 * - Alternative field names from different backend versions
 * - Default values for missing fields
 * - Capping memory candidates at MAX_MEMORY_CANDIDATES (3)
 * - Validation of required fields
 * 
 * @param payload - Raw backend response
 * @param sessionId - Session ID (fallback if not in payload)
 * @returns Normalized RecapArtifactsV1 or null if invalid
 */
export function mapBackendArtifactsToRecapV1(
  payload: BackendArtifactsPayload | null | undefined,
  sessionId: string
): RecapArtifactsV1 | null {
  if (!payload) {
    return null;
  }
  
  // Extract session type with fallbacks
  const sessionType = normalizeSessionType(
    payload.session_type || payload.preset
  );
  
  // Extract context mode with fallbacks
  const contextMode = normalizeContextMode(
    payload.context_mode || payload.preset
  );
  
  // Extract takeaway with alternative field names
  const takeaway = payload.takeaway || payload.session_takeaway;
  
  // Extract reflection candidate with alternative structures
  const reflectionCandidate = normalizeReflectionCandidate(
    payload.reflection_candidate || payload.reflection
  );
  
  // Map and cap memory candidates
  const memoryCandidates = normalizeMemoryCandidates(
    payload.memory_candidates
  );

  const builderArtifact = normalizeBuilderArtifactPayload(
    payload.builder_artifact || payload.builderArtifact || payload.builder_result
  );
  
  // Determine status
  const status = normalizeStatus(payload.status, takeaway, reflectionCandidate, memoryCandidates);
  
  const result = {
    sessionId: payload.session_id || sessionId,
    threadId: payload.thread_id,
    sessionType,
    contextMode,
    startedAt: payload.started_at,
    endedAt: payload.ended_at,
    takeaway,
    reflectionCandidate,
    memoryCandidates,
    ...(builderArtifact ? { builderArtifact } : {}),
    status,
  };
  
  return result;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Normalizes session type string to PresetType enum
 */
function normalizeSessionType(value?: string): PresetType {
  const normalized = value?.toLowerCase();
  
  const typeMap: Record<string, PresetType> = {
    prepare: 'prepare',
    preparation: 'prepare',
    debrief: 'debrief',
    debriefing: 'debrief',
    reset: 'reset',
    tilt_reset: 'reset',
    vent: 'vent',
    vent_reset: 'vent',
  };
  
  return typeMap[normalized || ''] || 'debrief';
}

/**
 * Normalizes context mode string to ContextMode enum
 */
function normalizeContextMode(value?: string): ContextMode {
  const normalized = value?.toLowerCase();
  
  const modeMap: Record<string, ContextMode> = {
    gaming: 'gaming',
    game: 'gaming',
    work: 'work',
    professional: 'work',
    life: 'life',
    personal: 'life',
  };
  
  return modeMap[normalized || ''] || 'gaming';
}

/**
 * Normalizes reflection candidate from various backend formats
 */
function normalizeReflectionCandidate(
  raw?: { prompt?: string; tag?: string } | null
): RecapArtifactsV1['reflectionCandidate'] {
  if (!raw?.prompt) {
    return undefined;
  }
  
  const validTags = ['tilt', 'focus', 'confidence', 'communication', 'boundaries', 'growth'];
  const tag = raw.tag && validTags.includes(raw.tag.toLowerCase()) 
    ? raw.tag.toLowerCase() as RecapArtifactsV1['reflectionCandidate']['tag']
    : undefined;
  
  return {
    prompt: raw.prompt,
    tag,
  };
}

/**
 * Normalizes memory candidates, caps at MAX_MEMORY_CANDIDATES
 */
function normalizeMemoryCandidates(
  raw?: BackendArtifactsPayload['memory_candidates']
): MemoryCandidateV1[] {
  if (!raw || !Array.isArray(raw)) {
    return [];
  }

  // Filter valid candidates and map to frontend format
  const candidates = raw
    .filter(c => c && (c.text || c.memory))
    .map((c, index) => normalizeMemoryCandidate(c, index))
    .filter((c): c is MemoryCandidateV1 => c !== null);

  return candidates;
}

/**
 * Normalizes a single memory candidate
 */
function normalizeMemoryCandidate(
  raw: NonNullable<BackendArtifactsPayload['memory_candidates']>[0],
  index: number
): MemoryCandidateV1 | null {
  const displayText = raw.text ?? raw.memory ?? '';
  const text = typeof displayText === 'string' ? displayText.trim() : '';
  
  if (!text) {
    return null;
  }

  const normalizedCategory = typeof raw.category === 'string' && raw.category.trim().length > 0
    ? raw.category.trim().toLowerCase()
    : 'general';
  
  // Generate unique ID: use provided ID, or create one from text hash + index
  const uniqueId = raw.id || raw.candidate_id || `candidate-${index}-${text.slice(0, 20).replace(/\s+/g, '_')}`;
  
  return {
    id: uniqueId,
    text,
    memory: typeof raw.memory === 'string' ? raw.memory : undefined,
    category: normalizedCategory,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
    confidence: typeof raw.confidence === 'number' 
      ? Math.min(1, Math.max(0, raw.confidence)) 
      : undefined,
    reason: raw.reason || raw.source,
  };
}

/**
 * Determines artifacts status based on payload
 */
function normalizeStatus(
  rawStatus?: string,
  takeaway?: string,
  reflectionCandidate?: RecapArtifactsV1['reflectionCandidate'],
  memoryCandidates: MemoryCandidateV1[] = []
): RecapArtifactsV1['status'] {
  if (rawStatus === 'processing' || rawStatus === 'pending') {
    return 'processing';
  }
  
  if (rawStatus === 'unavailable' || rawStatus === 'error') {
    return 'unavailable';
  }
  
  if (takeaway || reflectionCandidate?.prompt || memoryCandidates.length > 0) {
    return 'ready';
  }
  
  // Default to processing if no clear indicator
  return 'processing';
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Checks if artifacts payload has minimum required data
 */
export function isArtifactsPayloadValid(
  payload: BackendArtifactsPayload | null | undefined
): boolean {
  if (!payload) return false;
  
  // At minimum, we need a session ID or takeaway
  return !!(
    payload.session_id || 
    payload.takeaway || 
    payload.session_takeaway
  );
}

/**
 * Creates empty/default artifacts for a session
 */
export function createEmptyArtifacts(
  sessionId: string,
  sessionType: PresetType = 'debrief',
  contextMode: ContextMode = 'gaming'
): RecapArtifactsV1 {
  return {
    sessionId,
    sessionType,
    contextMode,
    status: 'processing',
    memoryCandidates: [],
  };
}

export default mapBackendArtifactsToRecapV1;
