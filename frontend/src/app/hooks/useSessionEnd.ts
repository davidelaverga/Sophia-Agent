/**
 * useSessionEnd Hook
 * Sprint 1+ Phase 3
 * 
 * Handles session termination via backend API:
 * - Calls POST /api/v1/sessions/end
 * - Returns recap artifacts and debrief offer
 * - Stores session to history
 */

'use client';

import { useRouter } from 'next/navigation';
import { useState, useCallback } from 'react';

import { endSession as endSessionAPI, isSuccess } from '../lib/api/sessions-api';
import { logger } from '../lib/error-logger';
import { teardownSessionClientState } from '../lib/session-teardown';
import { useSessionHistoryStore } from '../stores/session-history-store';
import { useSessionStore } from '../stores/session-store';

// SessionEndResponse type used indirectly via API
import { haptic } from './useHaptics';

// ============================================================================
// TYPES
// ============================================================================

export interface SessionEndResult {
  success: true;
  sessionId: string;
  durationMinutes: number;
  turnCount: number;
  recapArtifacts?: {
    takeaway?: string;
    reflection?: {
      prompt?: string;
      tag?: string;
    };
    memoriesCreated?: number;
  };
  offerDebrief: boolean;
  debriefPrompt?: string;
}

export interface SessionEndError {
  success: false;
  error: string;
  code: string;
}

export type EndSessionResult = SessionEndResult | SessionEndError;

export interface UseSessionEndOptions {
  /** Navigate to recap page after ending */
  navigateToRecap?: boolean;
  /** Callback when session ends successfully */
  onSuccess?: (result: SessionEndResult) => void;
  /** Callback on error */
  onError?: (error: SessionEndError) => void;
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useSessionEnd(options: UseSessionEndOptions = {}) {
  const { navigateToRecap = true, onSuccess, onError } = options;
  
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const setEnding = useSessionStore((state) => state.setEnding);
  const endSessionStore = useSessionStore((state) => state.endSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  
  const [isLoading, setIsLoading] = useState(false);
  const [lastResult, setLastResult] = useState<EndSessionResult | null>(null);
  
  /**
   * End the current session via backend API
   */
  const end = useCallback(async (
    offerDebrief: boolean = true
  ): Promise<EndSessionResult> => {
    if (!session) {
      const errorResult: SessionEndError = {
        success: false,
        error: 'No active session',
        code: 'VALIDATION_ERROR',
      };
      onError?.(errorResult);
      return errorResult;
    }
    
    setIsLoading(true);
    setEnding(true);
    
    try {
      // Call backend API
      const result = await endSessionAPI({
        session_id: session.sessionId,
        offer_debrief: offerDebrief,
      });
      
      // Store session data for history before clearing
      const sessionData = {
        sessionId: session.sessionId,
        presetType: session.presetType,
        contextMode: session.contextMode,
        startedAt: session.startedAt,
        endedAt: new Date().toISOString(),
        messageCount: session.messages?.length || 0,
        takeawayPreview: undefined as string | undefined,
      };
      
      if (isSuccess(result)) {
        const response = result.data;
        
        // Update session data with backend info
        sessionData.endedAt = response.ended_at;
        sessionData.takeawayPreview = response.recap_artifacts?.takeaway;
        
        // Save to history
        useSessionHistoryStore.getState().addSession(sessionData);
        
        // Update local store
        endSessionStore();
        clearSession();
        teardownSessionClientState(response.session_id);
        
        const successResult: SessionEndResult = {
          success: true,
          sessionId: response.session_id,
          durationMinutes: response.duration_minutes,
          turnCount: response.turn_count,
          recapArtifacts: response.recap_artifacts ? {
            takeaway: response.recap_artifacts.takeaway,
            reflection: response.recap_artifacts.reflection,
            memoriesCreated: response.recap_artifacts.memories_created,
          } : undefined,
          offerDebrief: response.offer_debrief,
          debriefPrompt: response.debrief_prompt,
        };
        
        setLastResult(successResult);
        onSuccess?.(successResult);
        
        // Navigate to recap
        if (navigateToRecap) {
          haptic('medium');
          router.push(`/recap/${session.sessionId}`);
        }
        
        return successResult;
        
      } else {
        // API failed - still end locally (offline mode)
        logger.warn('API failed, ending locally', {
          component: 'useSessionEnd',
          action: 'end_session_api_fallback',
          metadata: { error: result.error },
        });
        
        // Save to history anyway
        useSessionHistoryStore.getState().addSession(sessionData);
        
        // Update local store
        endSessionStore();
        clearSession();
        teardownSessionClientState(session.sessionId);
        
        // Return partial success (local end)
        const partialResult: SessionEndResult = {
          success: true,
          sessionId: session.sessionId,
          durationMinutes: Math.floor(
            (Date.now() - new Date(session.startedAt).getTime()) / 60000
          ),
          turnCount: session.messages?.length || 0,
          offerDebrief: offerDebrief,
        };
        
        setLastResult(partialResult);
        
        if (navigateToRecap) {
          haptic('medium');
          router.push(`/recap/${session.sessionId}`);
        }
        
        return partialResult;
      }
      
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const errorResult: SessionEndError = {
        success: false,
        error: message,
        code: 'NETWORK_ERROR',
      };
      
      setLastResult(errorResult);
      onError?.(errorResult);
      
      return errorResult;
      
    } finally {
      setIsLoading(false);
      setEnding(false);
    }
  }, [
    session,
    setEnding,
    endSessionStore,
    clearSession,
    router,
    navigateToRecap,
    onSuccess,
    onError,
  ]);
  
  /**
   * End session and start debrief
   */
  const endAndDebrief = useCallback(async (): Promise<EndSessionResult> => {
    const result = await end(true);
    
    if (result.success && result.offerDebrief) {
      // Navigate to debrief session instead of recap
      // TODO: Start a new debrief session
      logger.debug('useSessionEnd', 'Debrief offered', { debriefPrompt: result.debriefPrompt });
    }
    
    return result;
  }, [end]);
  
  return {
    end,
    endAndDebrief,
    isLoading,
    lastResult,
  };
}

export default useSessionEnd;
