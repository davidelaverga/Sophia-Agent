/**
 * Artifacts Helpers — PRODUCTION CODE
 * Sprint 1+ - Used by useChat's onData/onFinish callbacks
 * 
 * These helpers extract structured data from Lane B stream parts.
 */

import type { SophiaMessageMetadata } from '../../types/sophia-ui-message';

import { 
  type ArtifactsPayload, 
  MAX_MEMORY_CANDIDATES,
  isArtifactsDataPart,
  isTraceDataPart,
  type TraceDataPart,
} from './artifacts-types';

// =============================================================================
// ARTIFACTS EXTRACTION
// =============================================================================

/**
 * Extract artifacts from data parts.
 * Helper for useChat's onData callback.
 * 
 * CRITICAL: Enforces V1 contract rules:
 * - reflection_candidate must be string
 * - memory_candidates[].text is canonical
 * - Caps at MAX_MEMORY_CANDIDATES (3)
 * 
 * @param dataParts - Array of data parts from stream
 * @returns ArtifactsPayload or null if not found
 */
export function extractArtifacts(dataParts: unknown[]): ArtifactsPayload | null {
  if (!Array.isArray(dataParts)) return null;
  
  // Find artifacts data part
  const artifactsPart = dataParts.find(isArtifactsDataPart);
  
  if (!artifactsPart?.data) return null;
  
  const artifacts = { ...artifactsPart.data };
  
  // Enforce V1 contract: cap memory candidates at 3
  if (artifacts.memory_candidates && artifacts.memory_candidates.length > MAX_MEMORY_CANDIDATES) {
    artifacts.memory_candidates = artifacts.memory_candidates.slice(0, MAX_MEMORY_CANDIDATES);
  }
  
  // Ensure reflection_candidate is string (not object)
  if (artifacts.reflection_candidate && typeof artifacts.reflection_candidate !== 'string') {
    // If it's an object with a text field, extract it
    const rc = artifacts.reflection_candidate as unknown;
    if (rc && typeof rc === 'object' && 'text' in rc) {
      artifacts.reflection_candidate = (rc as { text: string }).text;
    } else {
      // Can't parse, set to undefined
      artifacts.reflection_candidate = undefined;
    }
  }
  
  return artifacts;
}

/**
 * Extract trace data from data parts.
 * Useful for debugging/analytics.
 */
export function extractTrace(dataParts: unknown[]): TraceDataPart | null {
  if (!Array.isArray(dataParts)) return null;
  
  const tracePart = dataParts.find(isTraceDataPart);
  return tracePart || null;
}

// =============================================================================
// METADATA EXTRACTION
// =============================================================================

/**
 * Extract metadata from finish event.
 * Helper for useChat's onFinish callback.
 * 
 * @param finishEvent - The finish event from stream
 * @returns SophiaMessageMetadata or null
 */
export function extractMetadata(finishEvent: unknown): Partial<SophiaMessageMetadata> | null {
  if (!finishEvent || typeof finishEvent !== 'object') return null;
  
  const event = finishEvent as Record<string, unknown>;
  
  // Check for metadata in common locations
  const metadata = event.metadata || event.meta || event._metadata;
  
  if (!metadata || typeof metadata !== 'object') {
    // Try to extract from annotations (AI SDK pattern)
    if (event.annotations && Array.isArray(event.annotations) && event.annotations.length > 0) {
      return event.annotations[0] as Partial<SophiaMessageMetadata>;
    }
    return null;
  }
  
  return metadata as Partial<SophiaMessageMetadata>;
}

/**
 * Extract thread_id from various response formats.
 * Useful for ensuring LangGraph continuity.
 */
export function extractThreadId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  
  const r = response as Record<string, unknown>;
  
  // Direct field
  if (typeof r.thread_id === 'string') return r.thread_id;
  
  // Nested in metadata
  if (r.metadata && typeof r.metadata === 'object') {
    const meta = r.metadata as Record<string, unknown>;
    if (typeof meta.thread_id === 'string') return meta.thread_id;
  }
  
  // Nested in data
  if (r.data && typeof r.data === 'object') {
    const data = r.data as Record<string, unknown>;
    if (typeof data.thread_id === 'string') return data.thread_id;
  }
  
  return null;
}

// =============================================================================
// ARTIFACTS VALIDATION
// =============================================================================

/**
 * Validate artifacts payload structure.
 * Returns true if valid, false otherwise.
 */
export function isValidArtifacts(artifacts: unknown): artifacts is ArtifactsPayload {
  if (!artifacts || typeof artifacts !== 'object') return false;
  
  const a = artifacts as Record<string, unknown>;
  
  // Must have artifacts_status
  if (!['pending', 'complete', 'error'].includes(a.artifacts_status as string)) {
    return false;
  }
  
  // takeaway must be string if present
  if (a.takeaway !== undefined && typeof a.takeaway !== 'string') {
    return false;
  }
  
  // reflection_candidate must be string if present
  if (a.reflection_candidate !== undefined && typeof a.reflection_candidate !== 'string') {
    return false;
  }
  
  // memory_candidates must be array if present
  if (a.memory_candidates !== undefined && !Array.isArray(a.memory_candidates)) {
    return false;
  }
  
  return true;
}

// =============================================================================
// DEFAULT ARTIFACTS
// =============================================================================

export function getEmptyArtifacts(): ArtifactsPayload {
  return {
    artifacts_status: 'pending',
  };
}

export function getErrorArtifacts(error?: string): ArtifactsPayload {
  return {
    artifacts_status: 'error',
    takeaway: error || 'Failed to generate session takeaways.',
  };
}
