/**
 * useSessionPersistence Hook
 * Phase 4 - Week 4: Resume Session (Unified)
 * 
 * Simple hook that provides session resume functionality using the unified
 * session-store. The session-store handles all persistence automatically
 * via Zustand's persist middleware.
 * 
 * This hook provides:
 * - canResume: Check if there's an active session to resume
 * - getSummary: Get session summary for UI display
 * - clearAndStartFresh: Clear session and start new
 */

'use client';

import { useCallback } from 'react';

import { endSession as endSessionAPI, isSuccess } from '../lib/api/sessions-api';
import { archiveConversation } from '../lib/conversation-history';
import { logger } from '../lib/error-logger';
import { teardownSessionClientState } from '../lib/session-teardown';
import { useChatStore } from '../stores/chat-store';
import { useSessionStore, selectIsSessionActive, selectSessionSummary } from '../stores/session-store';

// =============================================================================
// TYPES
// =============================================================================

interface SessionSummary {
  sessionType: string;
  contextMode: string;
  messageCount: number;
  lastMessagePreview?: string;
  startedAt: string;
  updatedAt: string;
  // Backward compat
  hasSnapshot: boolean;
  isStale: boolean;
}

interface UseSessionPersistenceReturn {
  /** @deprecated No-op since session-store auto-persists */
  restoreSession: () => boolean;
  /** Check if there's a valid session to resume */
  canResume: boolean;
  /** Get session summary for UI display */
  getSummary: () => SessionSummary;
  /** Clear the session (user chose "Start fresh") */
  clearAndStartFresh: () => Promise<void>;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useSessionPersistence(): UseSessionPersistenceReturn {
  // Get session state directly from session-store (single source of truth)
  const hasActiveSession = useSessionStore(selectIsSessionActive);
  const sessionSummary = useSessionStore(selectSessionSummary);
  const clearSession = useSessionStore((state) => state.clearSession);
  const endSession = useSessionStore((state) => state.endSession);
  
  // ---------------------------------------------------------------------------
  // Can Resume: Simple check for active session
  // ---------------------------------------------------------------------------
  
  const canResume = hasActiveSession && sessionSummary !== null;
  
  // ---------------------------------------------------------------------------
  // Restore Session: No-op (session-store auto-persists via Zustand)
  // ---------------------------------------------------------------------------
  
  const restoreSession = useCallback((): boolean => {
    // No-op - session data is already in session-store
    // Just return true if there's an active session
    return hasActiveSession;
  }, [hasActiveSession]);
  
  // ---------------------------------------------------------------------------
  // Get Summary: Returns session info for UI display
  // ---------------------------------------------------------------------------
  
  const getSummary = useCallback((): SessionSummary => {
    if (!sessionSummary) {
      return {
        sessionType: 'open',
        contextMode: 'life',
        messageCount: 0,
        lastMessagePreview: undefined,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hasSnapshot: false,
        isStale: true,
      };
    }
    
    // Check if stale (> 24 hours)
    const updatedAt = new Date(sessionSummary.updatedAt || sessionSummary.startedAt);
    const isStale = Date.now() - updatedAt.getTime() > 24 * 60 * 60 * 1000;
    
    return {
      ...sessionSummary,
      hasSnapshot: hasActiveSession,
      isStale,
    };
  }, [sessionSummary, hasActiveSession]);
  
  // ---------------------------------------------------------------------------
  // Clear and Start Fresh: Clears all session data
  // ---------------------------------------------------------------------------
  
  const clearAndStartFresh = useCallback(async () => {
    const activeSessionId = useSessionStore.getState().session?.sessionId;

    // End backend session first so next start is truly fresh (not resumed)
    if (activeSessionId) {
      try {
        const result = await endSessionAPI({
          session_id: activeSessionId,
          offer_debrief: false,
        });

        if (!isSuccess(result)) {
          logger.warn('Backend end_session failed during start fresh', {
            component: 'SessionPersistence',
            sessionId: activeSessionId,
            code: result.code,
            status: result.status,
          });
        }
      } catch (error) {
        logger.warn('Backend end_session threw during start fresh', {
          component: 'SessionPersistence',
          sessionId: activeSessionId,
          error,
        });
      }
    }

    // Archive current conversation before clearing (for history)
    const chatMessages = useChatStore.getState().messages;
    const conversationId = useChatStore.getState().conversationId;
    const currentMode = 'text'; // Default mode for archiving
    
    if (conversationId && chatMessages.length >= 2) {
      archiveConversation(conversationId, chatMessages, currentMode);
      logger.debug('SessionPersistence', 'Archived conversation before clear');
    }
    
    // Clear session-store (main storage)
    endSession();
    clearSession();

    teardownSessionClientState(activeSessionId);
    
    // Emit event for other components
    window.dispatchEvent(new CustomEvent('sophia:reset-session'));
    
    logger.debug('SessionPersistence', 'Cleared all session data');
  }, [endSession, clearSession]);
  
  return {
    restoreSession,
    canResume,
    getSummary,
    clearAndStartFresh,
  };
}
