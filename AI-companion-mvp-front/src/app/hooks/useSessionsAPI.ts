/**
 * useSessionsAPI Hook
 * Sprint 1+ Phase 3
 * 
 * React hook for interacting with the Sessions API.
 * Handles loading states, errors, and integrates with session store.
 */

import { useState, useCallback } from 'react';
import {
  startSession,
  endSession,
  getActiveSession,
  getMicroBriefing,
  getSessionContext,
  isSuccess,
  isAuthError,
  getErrorMessage,
  type ApiResponse,
} from '../lib/api/sessions-api';
import type {
  SessionStartRequest,
  SessionStartResponse,
  SessionEndRequest as _SessionEndRequest,
  SessionEndResponse,
  ActiveSessionResponse,
  MicroBriefingRequest,
  MicroBriefingResponse,
  SessionContext,
  PresetType as _PresetType,
  ContextMode as _ContextMode,
} from '../types/session';

// ============================================================================
// TYPES
// ============================================================================

export interface UseSessionsAPIOptions {
  /** Callback when auth error occurs */
  onAuthError?: () => void;
  /** Callback when any error occurs */
  onError?: (message: string) => void;
}

export interface UseSessionsAPIReturn {
  // Loading states
  isLoading: boolean;
  isStartingSession: boolean;
  isEndingSession: boolean;
  isCheckingActive: boolean;
  
  // Error state
  error: string | null;
  
  // Actions
  startNewSession: (request: SessionStartRequest) => Promise<SessionStartResponse | null>;
  endCurrentSession: (sessionId: string, offerDebrief?: boolean) => Promise<SessionEndResponse | null>;
  checkActiveSession: () => Promise<ActiveSessionResponse | null>;
  fetchMicroBriefing: (request: MicroBriefingRequest) => Promise<MicroBriefingResponse | null>;
  fetchSessionContext: (sessionId: string) => Promise<SessionContext | null>;
  
  // Utilities
  clearError: () => void;
}

// ============================================================================
// HOOK
// ============================================================================

export function useSessionsAPI(options: UseSessionsAPIOptions = {}): UseSessionsAPIReturn {
  const { onAuthError, onError } = options;
  
  // Loading states
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);
  const [isCheckingActive, setIsCheckingActive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  // Error state
  const [error, setError] = useState<string | null>(null);
  
  /**
   * Handle API response errors
   */
  const handleError = useCallback(<T>(result: ApiResponse<T>): null => {
    if (!isSuccess(result)) {
      const message = getErrorMessage(result);
      setError(message);
      onError?.(message);
      
      if (isAuthError(result)) {
        onAuthError?.();
      }
    }
    return null;
  }, [onAuthError, onError]);
  
  /**
   * Start a new session
   */
  const startNewSession = useCallback(async (
    request: SessionStartRequest
  ): Promise<SessionStartResponse | null> => {
    setIsStartingSession(true);
    setError(null);
    
    try {
      const result = await startSession(request);
      
      if (isSuccess(result)) {
        return result.data;
      }
      
      return handleError(result);
    } finally {
      setIsStartingSession(false);
    }
  }, [handleError]);
  
  /**
   * End current session
   */
  const endCurrentSession = useCallback(async (
    sessionId: string,
    offerDebrief: boolean = true
  ): Promise<SessionEndResponse | null> => {
    setIsEndingSession(true);
    setError(null);
    
    try {
      const result = await endSession({
        session_id: sessionId,
        offer_debrief: offerDebrief,
      });
      
      if (isSuccess(result)) {
        return result.data;
      }
      
      return handleError(result);
    } finally {
      setIsEndingSession(false);
    }
  }, [handleError]);
  
  /**
   * Check for active session
   */
  const checkActiveSession = useCallback(async (): Promise<ActiveSessionResponse | null> => {
    setIsCheckingActive(true);
    setError(null);
    
    try {
      const result = await getActiveSession();
      
      if (isSuccess(result)) {
        return result.data;
      }
      
      return handleError(result);
    } finally {
      setIsCheckingActive(false);
    }
  }, [handleError]);
  
  /**
   * Fetch micro-briefing
   */
  const fetchMicroBriefing = useCallback(async (
    request: MicroBriefingRequest
  ): Promise<MicroBriefingResponse | null> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await getMicroBriefing(request);
      
      if (isSuccess(result)) {
        return result.data;
      }
      
      return handleError(result);
    } finally {
      setIsLoading(false);
    }
  }, [handleError]);
  
  /**
   * Fetch session context
   */
  const fetchSessionContext = useCallback(async (
    sessionId: string
  ): Promise<SessionContext | null> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await getSessionContext(sessionId);
      
      if (isSuccess(result)) {
        return result.data;
      }
      
      return handleError(result);
    } finally {
      setIsLoading(false);
    }
  }, [handleError]);
  
  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);
  
  return {
    // Loading states
    isLoading,
    isStartingSession,
    isEndingSession,
    isCheckingActive,
    
    // Error state
    error,
    
    // Actions
    startNewSession,
    endCurrentSession,
    checkActiveSession,
    fetchMicroBriefing,
    fetchSessionContext,
    
    // Utilities
    clearError,
  };
}

// ============================================================================
// CONVENIENCE HOOKS
// ============================================================================

/**
 * Hook for checking active session on mount
 */
export function useActiveSessionCheck(options: UseSessionsAPIOptions = {}) {
  const api = useSessionsAPI(options);
  const [activeSession, setActiveSession] = useState<ActiveSessionResponse | null>(null);
  const [hasChecked, setHasChecked] = useState(false);
  
  const check = useCallback(async () => {
    const result = await api.checkActiveSession();
    setActiveSession(result);
    setHasChecked(true);
    return result;
  }, [api]);
  
  return {
    ...api,
    activeSession,
    hasChecked,
    checkOnMount: check,
  };
}

/**
 * Quick helper to start a gaming prepare session
 */
export function useQuickPrepare(options: UseSessionsAPIOptions = {}) {
  const api = useSessionsAPI(options);
  
  const startGamingPrepare = useCallback(async (
    intention?: string,
    focusCue?: string
  ) => {
    return api.startNewSession({
      session_type: 'prepare',
      preset_context: 'gaming',
      intention,
      focus_cue: focusCue,
    });
  }, [api]);
  
  return {
    ...api,
    startGamingPrepare,
  };
}
