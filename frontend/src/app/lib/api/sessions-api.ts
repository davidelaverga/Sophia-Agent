/**
 * Sessions API Client
 * Sprint 1+ Phase 3
 * 
 * Client for the backend Sessions API endpoints:
 * - POST /api/v1/sessions/start - Start or resume session
 * - POST /api/v1/sessions/end - End session
 * - GET /api/v1/sessions/active - Check for active session
 * - POST /api/v1/sessions/micro-briefing - Get micro-briefing
 * - GET /api/v1/sessions/{id}/context - Get session context
 * - GET /api/v1/sessions/{id} - Get session details
 */

import type {
  SessionStartRequest,
  SessionStartResponse,
  SessionEndRequest,
  SessionEndResponse,
  DebriefDecisionRequest,
  DebriefDecisionResponse,
  ActiveSessionResponse,
  MicroBriefingRequest,
  MicroBriefingResponse,
  SessionContext,
  SessionInfo,
  OpenSessionsResponse,
  SessionListResponse,
  SessionUpdateRequest,
  SessionMessagesResponse,
} from '../../types/session';

// ============================================================================
// CONFIGURATION
// ============================================================================

const BACKEND_URL = process.env.NEXT_PUBLIC_SESSIONS_PROXY_URL || '';
const SESSIONS_BASE = '/api/sessions';
const SOPHIA_END_SESSION_ENDPOINT = '/api/sophia/end-session';
const DEFAULT_TIMEOUT_MS = 10000;

// ============================================================================
// TYPES
// ============================================================================

export interface ApiResult<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: string;
  code: 'NETWORK_ERROR' | 'VALIDATION_ERROR' | 'AUTH_ERROR' | 'NOT_FOUND' | 'SERVER_ERROR' | 'TIMEOUT';
  status?: number;
}

export type ApiResponse<T> = ApiResult<T> | ApiError;

export interface SessionDeleteResponse {
  ok: boolean;
  session_id: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Create fetch with timeout and auth
 */
async function fetchWithAuth<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ApiResponse<T>> {
  // Auth is handled server-side by the proxy route (httpOnly cookie)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const url = `${BACKEND_URL}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ detail: response.statusText }));
      const detail = errorBody?.detail;
      const message = typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((item) => item?.msg).filter(Boolean).join(' | ') || 'Validation error'
          : typeof detail === 'object' && detail
            ? 'Validation error'
            : response.statusText || `HTTP ${response.status}`;
      
      let code: ApiError['code'] = 'SERVER_ERROR';
      if (response.status === 401) code = 'AUTH_ERROR';
      else if (response.status === 403) code = 'AUTH_ERROR';
      else if (response.status === 404) code = 'NOT_FOUND';
      else if (response.status === 422) code = 'VALIDATION_ERROR';
      
      return {
        success: false,
        error: message,
        code,
        status: response.status,
      };
    }
    
    const data = await response.json() as T;
    
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
// API FUNCTIONS
// ============================================================================

/**
 * Start a new session or resume an existing one
 * 
 * @example
 * ```tsx
 * const result = await startSession({
 *   session_type: 'prepare',
 *   preset_context: 'gaming',
 *   intention: 'Hit Diamond today',
 *   focus_cue: 'Stay calm in ranked',
 * });
 * 
 * if (result.success) {
 *   const { session_id, greeting_message, memory_highlights } = result.data;
 * }
 * ```
 */
export async function startSession(
  request: SessionStartRequest
): Promise<ApiResponse<SessionStartResponse>> {
  return fetchWithAuth<SessionStartResponse>(
    `${SESSIONS_BASE}/start`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );
}

/**
 * End an active session
 * 
 * @example
 * ```tsx
 * const result = await endSession({
 *   session_id: '550e8400-e29b-41d4-a716-446655440000',
 *   offer_debrief: true,
 * });
 * 
 * if (result.success && result.data.offer_debrief) {
 *   // Show debrief prompt
 * }
 * ```
 */
export async function endSession(
  request: SessionEndRequest
): Promise<ApiResponse<SessionEndResponse>> {
  return fetchWithAuth<SessionEndResponse>(
    SOPHIA_END_SESSION_ENDPOINT,
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );
}

/**
 * Record user decision from debrief offer modal.
 */
export async function submitDebriefDecision(
  request: DebriefDecisionRequest
): Promise<ApiResponse<DebriefDecisionResponse>> {
  const primary = await fetchWithAuth<DebriefDecisionResponse>(
    `${SESSIONS_BASE}/debrief-decision`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );

  if (isError(primary) && (primary.status === 404 || primary.status === 405)) {
    return fetchWithAuth<DebriefDecisionResponse>(
      `${SESSIONS_BASE}/${request.session_id}/debrief-decision`,
      {
        method: 'POST',
        body: JSON.stringify({ decision: request.decision }),
      }
    );
  }

  return primary;
}

/**
 * Check if user has an active session
 * Call this on app launch to decide whether to show "Continue last session"
 * 
 * @example
 * ```tsx
 * const result = await getActiveSession();
 * 
 * if (result.success && result.data.has_active_session) {
 *   // Show "Continue last session" button
 *   const session = result.data.session;
 * }
 * ```
 */
export async function getActiveSession(): Promise<ApiResponse<ActiveSessionResponse>> {
  return fetchWithAuth<ActiveSessionResponse>(
    `${SESSIONS_BASE}/active`,
    {
      method: 'GET',
    }
  );
}

/**
 * Get a micro-briefing for interruption cards / nudges
 * This is fast and lightweight - does NOT start LangGraph
 * 
 * @example
 * ```tsx
 * const result = await getMicroBriefing({
 *   intent: 'interrupt_checkin',
 *   preset_context: 'gaming',
 * });
 * 
 * if (result.success) {
 *   // Show notification card with result.data.assistant_text
 * }
 * ```
 */
export async function getMicroBriefing(
  request: MicroBriefingRequest
): Promise<ApiResponse<MicroBriefingResponse>> {
  return fetchWithAuth<MicroBriefingResponse>(
    `${SESSIONS_BASE}/micro-briefing`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    5000 // Shorter timeout for micro-briefings
  );
}

/**
 * Get session context for companion calls
 * 
 * @example
 * ```tsx
 * const result = await getSessionContext(sessionId);
 * 
 * if (result.success) {
 *   const { turn_count, duration_minutes } = result.data;
 * }
 * ```
 */
export async function getSessionContext(
  sessionId: string
): Promise<ApiResponse<SessionContext>> {
  return fetchWithAuth<SessionContext>(
    `${SESSIONS_BASE}/${sessionId}/context`,
    {
      method: 'GET',
    }
  );
}

/**
 * Get full session details
 * 
 * @example
 * ```tsx
 * const result = await getSessionDetails(sessionId);
 * 
 * if (result.success) {
 *   const session = result.data;
 * }
 * ```
 */
export async function getSessionDetails(
  sessionId: string
): Promise<ApiResponse<SessionInfo>> {
  return fetchWithAuth<SessionInfo>(
    `${SESSIONS_BASE}/${sessionId}`,
    {
      method: 'GET',
    }
  );
}

// ============================================================================
// MULTI-SESSION API FUNCTIONS
// ============================================================================

/**
 * Get all open sessions for the current user
 */
export async function getOpenSessions(
  userId: string = 'dev-user'
): Promise<ApiResponse<OpenSessionsResponse>> {
  return fetchWithAuth<OpenSessionsResponse>(
    `${SESSIONS_BASE}/open?user_id=${encodeURIComponent(userId)}`,
    { method: 'GET' }
  );
}

/**
 * List recent sessions with optional status filter
 */
export async function listSessions(
  userId: string = 'dev-user',
  options: { limit?: number; status?: 'open' | 'ended' } = {}
): Promise<ApiResponse<SessionListResponse>> {
  const params = new URLSearchParams({ user_id: userId });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.status) params.set('status', options.status);
  return fetchWithAuth<SessionListResponse>(
    `${SESSIONS_BASE}/list?${params.toString()}`,
    { method: 'GET' }
  );
}

/**
 * Get a single session by ID
 */
export async function getSession(
  sessionId: string,
  userId: string = 'dev-user'
): Promise<ApiResponse<SessionInfo>> {
  return fetchWithAuth<SessionInfo>(
    `${SESSIONS_BASE}/${sessionId}?user_id=${encodeURIComponent(userId)}`,
    { method: 'GET' }
  );
}

/**
 * Update session metadata (e.g. title)
 */
export async function updateSession(
  sessionId: string,
  updates: SessionUpdateRequest,
  userId: string = 'dev-user'
): Promise<ApiResponse<SessionInfo>> {
  return fetchWithAuth<SessionInfo>(
    `${SESSIONS_BASE}/${sessionId}?user_id=${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }
  );
}

/**
 * Touch a session — increment message count and update preview.
 * Called after each user message.
 */
export async function touchSession(
  sessionId: string,
  userId: string = 'dev-user',
  messagePreview?: string
): Promise<ApiResponse<SessionInfo>> {
  const params = new URLSearchParams({ user_id: userId });
  if (messagePreview) params.set('message_preview', messagePreview.slice(0, 200));
  return fetchWithAuth<SessionInfo>(
    `${SESSIONS_BASE}/${sessionId}/touch?${params.toString()}`,
    { method: 'POST' }
  );
}

/**
 * Get conversation messages from a session's LangGraph thread.
 * Used when switching back to an open session to restore history.
 */
export async function getSessionMessages(
  sessionId: string,
  userId: string = 'dev-user'
): Promise<ApiResponse<SessionMessagesResponse>> {
  return fetchWithAuth<SessionMessagesResponse>(
    `${SESSIONS_BASE}/${sessionId}/messages?user_id=${encodeURIComponent(userId)}`,
    { method: 'GET' }
  );
}

/**
 * Delete a persisted session record.
 */
export async function deleteSessionRecord(
  sessionId: string,
  userId: string = 'dev-user'
): Promise<ApiResponse<SessionDeleteResponse>> {
  return fetchWithAuth<SessionDeleteResponse>(
    `${SESSIONS_BASE}/${sessionId}?user_id=${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );
}

// ============================================================================
// CONVENIENCE HELPERS
// ============================================================================

/**
 * Check if an API result is successful
 */
export function isSuccess<T>(result: ApiResponse<T>): result is ApiResult<T> {
  return result.success;
}

/**
 * Check if an API result is an error
 */
export function isError<T>(result: ApiResponse<T>): result is ApiError {
  return !result.success;
}

/**
 * Check if error is authentication related
 */
export function isAuthError(result: ApiError): boolean {
  return result.code === 'AUTH_ERROR';
}

/**
 * Extract error message for display
 */
export function getErrorMessage(result: ApiError): string {
  switch (result.code) {
    case 'AUTH_ERROR':
      return 'Please sign in to continue';
    case 'NOT_FOUND':
      return 'Session not found';
    case 'TIMEOUT':
      return 'Request timed out. Please try again.';
    case 'NETWORK_ERROR':
      return 'Connection error. Check your internet.';
    default:
      return result.error || 'Something went wrong';
  }
}
