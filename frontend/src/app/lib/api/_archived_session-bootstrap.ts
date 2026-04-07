/**
 * Session Bootstrap API Client
 * Sprint 1+ - Instant Personalized Openers
 * 
 * Fetches pre-computed session bootstrap data including:
 * - Personalized opening message
 * - Thread ID for LangGraph
 * - Top memories for "Since last time" display
 * - Emotional weather
 * - UI cards for initial render
 */

import type { BootstrapResponse, UICard } from '../../types/sophia-ui-message';

// ============================================================================
// TYPES
// ============================================================================

export interface FetchBootstrapOptions {
  userId: string;
  sessionType?: 'prepare' | 'debrief' | 'reset' | 'vent' | 'free_session';
  contextMode?: 'gaming' | 'work' | 'life';
  signal?: AbortSignal;
}

export interface BootstrapResult {
  success: true;
  data: BootstrapResponse;
}

export interface BootstrapError {
  success: false;
  error: string;
  code: 'NETWORK_ERROR' | 'VALIDATION_ERROR' | 'SERVER_ERROR' | 'TIMEOUT';
}

export type FetchBootstrapResult = BootstrapResult | BootstrapError;

// ============================================================================
// CONFIGURATION
// ============================================================================

const BOOTSTRAP_ENDPOINT = '/api/session/bootstrap';
const TIMEOUT_MS = 5000;

// ============================================================================
// API CLIENT
// ============================================================================

/**
 * Fetch session bootstrap data from the API
 * 
 * @example
 * ```tsx
 * const result = await fetchSessionBootstrap({
 *   userId: 'user_123',
 *   sessionType: 'prepare',
 *   contextMode: 'gaming',
 * });
 * 
 * if (result.success) {
 *   const { opening_message, thread_id, top_memories } = result.data;
 *   // Use data to hydrate UI
 * } else {
 *   logger.logError(result.error, { component: 'session-bootstrap', action: 'fetch' });
 * }
 * ```
 */
export async function fetchSessionBootstrap(
  options: FetchBootstrapOptions
): Promise<FetchBootstrapResult> {
  const { userId, sessionType, contextMode, signal } = options;
  
  // Validation
  if (!userId || userId.trim() === '') {
    return {
      success: false,
      error: 'userId is required',
      code: 'VALIDATION_ERROR',
    };
  }
  
  // Build URL
  const url = new URL(BOOTSTRAP_ENDPOINT, window.location.origin);
  url.searchParams.set('user_id', userId);
  if (sessionType) url.searchParams.set('session_type', sessionType);
  if (contextMode) url.searchParams.set('context_mode', contextMode);
  
  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: signal || controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      return {
        success: false,
        error: `Server returned ${response.status}`,
        code: 'SERVER_ERROR',
      };
    }
    
    const data = await response.json() as BootstrapResponse;
    
    return {
      success: true,
      data,
    };
    
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request timed out',
          code: 'TIMEOUT',
        };
      }
      
      return {
        success: false,
        error: error.message,
        code: 'NETWORK_ERROR',
      };
    }
    
    return {
      success: false,
      error: 'Unknown error',
      code: 'NETWORK_ERROR',
    };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract memory highlights from bootstrap response
 */
export function extractMemoryHighlights(bootstrap: BootstrapResponse): Array<{ content: string; category: string }> {
  return bootstrap.top_memories || [];
}

/**
 * Extract UI cards from bootstrap response
 */
export function extractUICards(bootstrap: BootstrapResponse): UICard[] {
  return bootstrap.ui_cards || [];
}

/**
 * Check if bootstrap has memories to display
 */
export function hasMemories(bootstrap: BootstrapResponse): boolean {
  return bootstrap.top_memories && bootstrap.top_memories.length > 0;
}

/**
 * Check if emotional weather should be shown
 */
export function shouldShowWeather(bootstrap: BootstrapResponse): boolean {
  return (
    bootstrap.emotional_weather !== null &&
    bootstrap.emotional_weather.trend !== 'unknown'
  );
}

/**
 * Get suggested session setup from bootstrap
 */
export function getSuggestedSetup(bootstrap: BootstrapResponse): {
  ritual: string | null;
  preset: string | null;
  reason: string | null;
} {
  return {
    ritual: bootstrap.suggested_ritual,
    preset: bootstrap.suggested_preset,
    reason: bootstrap.suggestion_reason,
  };
}
