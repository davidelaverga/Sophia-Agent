/**
 * Bootstrap API Client
 * Sprint 1+ Phase 3
 * 
 * Client for the backend Bootstrap API endpoints:
 * - GET /api/bootstrap/opener - Get pre-computed session opener
 * - GET /api/bootstrap/status - Check if opener is available
 * 
 * The bootstrap opener is pre-computed at the END of each session,
 * so it's ready instantly (<100ms) for the NEXT session.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface BootstrapOpenerResponse {
  opener_text: string;
  suggested_ritual: 'prepare' | 'debrief' | 'reset' | 'vent' | null;
  emotional_context: {
    last_emotion?: string;
    trend?: string;
  } | null;
  has_opener: boolean;
}

export interface BootstrapStatusResponse {
  has_opener: boolean;
  user_id: string;
}

export interface ApiResult<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: string;
  code: 'NETWORK_ERROR' | 'AUTH_ERROR' | 'NOT_FOUND' | 'SERVER_ERROR' | 'TIMEOUT';
}

export type ApiResponse<T> = ApiResult<T> | ApiError;

// ============================================================================
// CONFIGURATION
// ============================================================================

const BOOTSTRAP_BASE = '/api/bootstrap';
const DEFAULT_TIMEOUT_MS = 5000; // 5 seconds (should be fast)

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Create fetch with timeout and auth
 */
async function fetchWithAuth<T>(
  endpoint: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ApiResponse<T>> {
  // Auth is handled server-side by the proxy route (httpOnly cookie)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'Unauthorized', code: 'AUTH_ERROR' };
      }
      if (response.status === 404) {
        return { success: false, error: 'Not found', code: 'NOT_FOUND' };
      }
      return { 
        success: false, 
        error: `Server error: ${response.status}`, 
        code: 'SERVER_ERROR' 
      };
    }
    
    const data = await response.json() as T;
    return { success: true, data };
    
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, error: 'Request timeout', code: 'TIMEOUT' };
    }
    
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Network error', 
      code: 'NETWORK_ERROR' 
    };
  }
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Fetch pre-computed bootstrap opener
 * 
 * This returns a personalized greeting that was computed at the end
 * of the user's last session. Response time should be <100ms.
 * 
 * @example
 * ```tsx
 * const result = await fetchBootstrapOpener();
 * if (result.success && result.data.has_opener) {
 *   showPersonalizedGreeting(result.data.opener_text);
 *   if (result.data.suggested_ritual) {
 *     preselectRitual(result.data.suggested_ritual);
 *   }
 * }
 * ```
 */
export async function fetchBootstrapOpener(): Promise<ApiResponse<BootstrapOpenerResponse>> {
  return fetchWithAuth<BootstrapOpenerResponse>(`${BOOTSTRAP_BASE}/opener`);
}

/**
 * Check if a bootstrap opener is available
 * 
 * Lightweight check without fetching the full opener.
 */
export async function checkBootstrapStatus(): Promise<ApiResponse<BootstrapStatusResponse>> {
  return fetchWithAuth<BootstrapStatusResponse>(`${BOOTSTRAP_BASE}/status`);
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isBootstrapSuccess(
  result: ApiResponse<BootstrapOpenerResponse>
): result is ApiResult<BootstrapOpenerResponse> {
  return result.success === true;
}

export function hasValidOpener(data: BootstrapOpenerResponse): boolean {
  return data.has_opener && !!data.opener_text;
}

// ============================================================================
// EXPORTS
// ============================================================================

export type {
  BootstrapOpenerResponse as BootstrapOpener,
  BootstrapStatusResponse as BootstrapStatus,
};
