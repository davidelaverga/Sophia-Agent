/**
 * useSessionStart Hook
 * Sprint 1+ Phase 3
 * 
 * Orchestrates session start flow:
 * 1. Calls POST /api/v1/sessions/start
 * 2. Updates session store with backend IDs
 * 3. Returns greeting message and memory highlights
 * 
 * This replaces the old fetchSessionBootstrap() flow.
 */

'use client';

import { useRouter } from 'next/navigation';
import { useState, useCallback, useRef } from 'react';

import { startSession, getActiveSession, isSuccess, getErrorMessage } from '../lib/api/sessions-api';
import { logger } from '../lib/error-logger';
import { SessionStartResponseSchema, validateResponse } from '../lib/schemas/session-schemas';
import type { PresetType, ContextMode } from '../lib/session-types';
import { useSessionStore } from '../stores/session-store';
import type { 
  MemoryHighlight, 
  ActiveSessionResponse,
} from '../types/session';

import { haptic } from './useHaptics';

// Cache to prevent duplicate checkActiveSession calls
const activeSessionCache = {
  data: null as Awaited<ReturnType<typeof getActiveSession>> | null,
  userId: null as string | null,
  timestamp: 0,
  TTL_MS: 30_000, // 30 seconds cache
};

/** Invalidate the active-session cache so the next check hits the backend. */
export function invalidateActiveSessionCache(): void {
  activeSessionCache.data = null;
  activeSessionCache.userId = null;
  activeSessionCache.timestamp = 0;
}

// Backend session start circuit-breaker (client-side)
const SESSION_START_DISABLED_KEY = 'sophia.disableSessionStart';
const SESSION_START_DISABLED_TTL_MS = 15 * 60 * 1000;
const SESSION_START_HEALTHCHECK_TIMEOUT_MS = 5000;

function clearSessionStartDisabled(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(SESSION_START_DISABLED_KEY);
  } catch {
    // ignore storage errors
  }
}

function isSessionStartDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = localStorage.getItem(SESSION_START_DISABLED_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { disabledAt?: number };
    const disabledAt = typeof parsed?.disabledAt === 'number' ? parsed.disabledAt : null;
    if (!disabledAt || Date.now() - disabledAt > SESSION_START_DISABLED_TTL_MS) {
      localStorage.removeItem(SESSION_START_DISABLED_KEY);
      return false;
    }
    return true;
  } catch {
    return localStorage.getItem(SESSION_START_DISABLED_KEY) === 'true';
  }
}

function disableSessionStart(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      SESSION_START_DISABLED_KEY,
      JSON.stringify({ disabledAt: Date.now() })
    );
  } catch {
    // ignore storage errors
  }
}

async function canRecoverDisabledSessionStart(): Promise<boolean> {
  if (typeof window === 'undefined') return true;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), SESSION_START_HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await fetch('/api/health?deep=true', {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    clearSessionStartDisabled();
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// ============================================================================
// TYPES
// ============================================================================

/** Backend session type - maps from frontend PresetType */
type SessionType = 'prepare' | 'debrief' | 'reset' | 'vent' | 'chat';

/** Backend preset context - same as frontend ContextMode */
type PresetContext = 'gaming' | 'work' | 'life';
// ============================================================================

function isDebugEnabled(): boolean {
  // 🔒 SECURITY: debug mode restricted to development only
  return process.env.NODE_ENV === 'development';
}

function normalizeMemoryHighlights(raw: unknown): MemoryHighlight[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;

      const text = record.text || record.content || record.memory;
      if (typeof text !== 'string' || text.trim().length === 0) return null;

      const id = record.id || record.memory_id || record.memoryId || record.candidate_id || `mem-${index}`;
      const rawCategory = typeof record.category === 'string' ? record.category.toLowerCase() : undefined;
      const category = rawCategory === 'episodic' || rawCategory === 'emotional' || rawCategory === 'reflective'
        ? rawCategory
        : undefined;
      const salienceRaw = record.salience ?? record.relevance ?? record.score;
      const salience = typeof salienceRaw === 'number'
        ? Math.max(0, Math.min(1, salienceRaw))
        : undefined;
      const recencyLabel = typeof record.recency_label === 'string'
        ? record.recency_label
        : typeof record.recencyLabel === 'string'
          ? record.recencyLabel
          : undefined;

      const highlight: MemoryHighlight = {
        id: String(id),
        text: String(text),
      };
      if (category) highlight.category = category;
      if (salience !== undefined) highlight.salience = salience;
      if (recencyLabel) highlight.recency_label = recencyLabel;

      return highlight;
    })
    .filter((item): item is MemoryHighlight => item !== null);
}

export interface SessionStartResult {
  success: true;
  sessionId: string;
  threadId: string;
  greetingMessage: string;
  messageId: string;
  memoryHighlights: MemoryHighlight[];
  isResumed: boolean;
  hasMemory: boolean;
}

export interface SessionStartError {
  success: false;
  error: string;
  code: string;
}

export type StartSessionResult = SessionStartResult | SessionStartError;

export interface UseSessionStartOptions {
  onSuccess?: (result: SessionStartResult) => void;
  onError?: (error: SessionStartError) => void;
  navigateOnSuccess?: boolean;
}

export interface StartSessionEntryParams {
  userId: string;
  preset?: PresetType | null;
  contextMode: ContextMode;
  voiceMode?: boolean;
  intention?: string;
  focusCue?: string;
}

// ============================================================================
// MAPPERS
// ============================================================================

/**
 * Map frontend PresetType to backend SessionType
 */
function mapPresetToSessionType(preset: PresetType): SessionType {
  switch (preset) {
    case 'prepare':
      return 'prepare';
    case 'debrief':
      return 'debrief';
    case 'reset':
      return 'reset';
    case 'vent':
      return 'vent';
    case 'open':
    case 'chat':
    default:
      return 'chat';
  }
}

/**
 * Map frontend ContextMode to backend PresetContext
 */
function mapContextMode(mode: ContextMode): PresetContext {
  return mode; // They match: 'gaming' | 'work' | 'life'
}

// ============================================================================
// HOOK
// ============================================================================

export function useSessionStart(options: UseSessionStartOptions = {}) {
  const { onSuccess, onError, navigateOnSuccess = true } = options;
  
  const router = useRouter();
  const createSession = useSessionStore((state) => state.createSession);
  const restoreOpenSession = useSessionStore((state) => state.restoreOpenSession);
  const updateFromBackend = useSessionStore((state) => state.updateFromBackend);
  const updateSession = useSessionStore((state) => state.updateSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  const setInitializing = useSessionStore((state) => state.setInitializing);
  const setError = useSessionStore((state) => state.setError);
  
  const [isLoading, setIsLoading] = useState(false);
  const [lastResult, setLastResult] = useState<StartSessionResult | null>(null);
  const inFlightRef = useRef(false);
  
  /**
   * Start a new session via backend API
   */
  const start = useCallback(async (
    userId: string,
    presetType: PresetType,
    contextMode: ContextMode,
    options?: {
      intention?: string;
      focusCue?: string;
      voiceMode?: boolean;
    }
  ): Promise<StartSessionResult> => {
    if (inFlightRef.current) {
      return {
        success: false,
        error: 'Session start already in progress',
        code: 'IN_FLIGHT',
      };
    }
    inFlightRef.current = true;
    setIsLoading(true);
    setInitializing(true);
    setError(null);
    
    try {
      // 1. Create local session first (optimistic)
      createSession(userId, presetType, contextMode, {
        voiceMode: options?.voiceMode,
        intention: options?.intention,
        focusCue: options?.focusCue,
      });
      
      // 2. Call backend API (unless disabled due to backend errors)
      if (isSessionStartDisabled()) {
        const recovered = await canRecoverDisabledSessionStart();
        if (!recovered) {
          const errorResult: SessionStartError = {
            success: false,
            error: 'Session start temporarily disabled (backend error). Please try again.',
            code: 'SERVER_ERROR',
          };
          setLastResult(errorResult);
          setError(errorResult.error);
          onError?.(errorResult);
          clearSession();
          
          return errorResult;
        }
      }

      const result = await startSession({
        user_id: userId,
        session_type: mapPresetToSessionType(presetType),
        preset_context: mapContextMode(contextMode),
        intention: options?.intention,
        focus_cue: options?.focusCue,
      });
      
      if (!isSuccess(result)) {
        if (result.code === 'SERVER_ERROR' && result.status === 500) {
          disableSessionStart();
        }
        // API failed - session stays local (offline mode)
        const errorResult: SessionStartError = {
          success: false,
          error: getErrorMessage(result),
          code: result.code,
        };
        
        setLastResult(errorResult);
        setError(errorResult.error);
        onError?.(errorResult);
        clearSession();
        
        return errorResult;
      }
      
      // 3. Update store with real backend IDs
      const response = result.data;
      clearSessionStartDisabled();
      const debugEnabled = isDebugEnabled();
      if (debugEnabled) {
        const validation = validateResponse(SessionStartResponseSchema, response, 'SessionStartResponse');
        if (!validation.success) {
          logger.warn('SessionStartResponse schema mismatch', {
            component: 'useSessionStart',
            action: 'startSession',
            metadata: {
              issue_count: validation.issues?.length ?? 0,
              issues: (validation.issues ?? []).slice(0, 8).map((issue) => ({
                path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
                code: issue.code,
                message: issue.message,
              })),
              response_keys: Object.keys(response as unknown as Record<string, unknown>),
              session_id: response.session_id,
              thread_id: response.thread_id,
            },
          });
        }
        logger.debug('useSessionStart', 'Session started', {
          session_id: response.session_id,
          memory_highlights_count: response.memory_highlights?.length ?? 0,
          has_memory: response.has_memory,
          briefing_source: response.briefing_source,
          is_resumed: response.is_resumed,
          schema_valid: validation.success,
        });
      }
      const normalizedHighlights = normalizeMemoryHighlights(response.memory_highlights);
      updateFromBackend(response.session_id, response.thread_id);
      
      // 4. Store greeting info for session page to use
      updateSession({
        greetingMessage: response.greeting_message,
        greetingMessageId: response.message_id,
        memoryHighlights: normalizedHighlights,
        hasMemory: response.has_memory,
        isResumed: response.is_resumed,
        briefingSource: response.briefing_source,
      });
      if (debugEnabled) {
        const storedHighlights = useSessionStore.getState().session?.memoryHighlights?.length ?? 0;
        logger.debug('useSessionStart', 'Store updated', {
          session_id: response.session_id,
          memoryHighlights_count: storedHighlights,
        });
      }
      
      const successResult: SessionStartResult = {
        success: true,
        sessionId: response.session_id,
        threadId: response.thread_id,
        greetingMessage: response.greeting_message,
        messageId: response.message_id,
        memoryHighlights: normalizedHighlights,
        isResumed: response.is_resumed,
        hasMemory: response.has_memory,
      };
      
      setLastResult(successResult);
      onSuccess?.(successResult);
      
      if (navigateOnSuccess) {
        haptic('medium');
        router.push('/session');
      }
      
      return successResult;
      
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
      setInitializing(false);
    }
  }, [
    createSession, 
    updateFromBackend, 
    updateSession,
    setInitializing, 
    clearSession,
    setError, 
    router, 
    navigateOnSuccess, 
    onSuccess, 
    onError
  ]);

  const startSessionEntry = useCallback(async (
    params: StartSessionEntryParams
  ): Promise<StartSessionResult> => {
    const presetType = params.preset ?? 'open';
    const intention = params.intention?.trim() || undefined;
    const focusCue = params.focusCue?.trim() || undefined;

    return start(params.userId, presetType, params.contextMode, {
      voiceMode: params.voiceMode,
      intention,
      focusCue,
    });
  }, [start]);
  
  /**
   * Check for active session (for "Continue last session")
   * Cached to prevent duplicate backend calls
   */
  const checkActiveSession = useCallback(async (
    force = false,
    userId?: string,
  ): Promise<ActiveSessionResponse | null> => {
    const now = Date.now();
    const normalizedUserId = typeof userId === 'string' && userId.trim()
      ? userId.trim()
      : null;
    
    // Return cached result if fresh (unless forced)
    if (
      !force
      && activeSessionCache.data
      && activeSessionCache.userId === normalizedUserId
      && (now - activeSessionCache.timestamp) < activeSessionCache.TTL_MS
    ) {
      const cached = activeSessionCache.data;
      return isSuccess(cached) ? cached.data : null;
    }
    
    const result = await getActiveSession(normalizedUserId ?? undefined);
    
    // Cache the result
    activeSessionCache.data = result;
    activeSessionCache.userId = normalizedUserId;
    activeSessionCache.timestamp = now;
    
    if (isSuccess(result)) {
      return result.data;
    }
    
    return null;
  }, []);
  
  /**
   * Resume an active session
   */
  const resumeSession = useCallback(async (
    activeSession: ActiveSessionResponse['session'],
    userId: string = 'anonymous',
  ): Promise<StartSessionResult> => {
    if (!activeSession) {
      return {
        success: false,
        error: 'No active session to resume',
        code: 'VALIDATION_ERROR',
      };
    }

    await restoreOpenSession(activeSession, userId);

    const successResult: SessionStartResult = {
      success: true,
      sessionId: activeSession.session_id,
      threadId: activeSession.thread_id,
      greetingMessage: '',
      messageId: 'resume-existing-session',
      memoryHighlights: [],
      isResumed: true,
      hasMemory: false,
    };

    setLastResult(successResult);
    onSuccess?.(successResult);

    if (navigateOnSuccess) {
      haptic('medium');
      router.push('/session');
    }

    return successResult;
  }, [navigateOnSuccess, onSuccess, restoreOpenSession, router]);
  
  return {
    start,
    startSessionEntry,
    checkActiveSession,
    resumeSession,
    isLoading,
    lastResult,
  };
}

export default useSessionStart;
