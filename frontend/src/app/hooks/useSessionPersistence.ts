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

import { endSession as endSessionAPI, getActiveSession, getSession, isError, isSuccess } from '../lib/api/sessions-api';
import { archiveConversation } from '../lib/conversation-history';
import { logger } from '../lib/error-logger';
import { teardownSessionClientState } from '../lib/session-teardown';
import { isUuid } from '../lib/utils';
import { useChatStore, type ChatMessage } from '../stores/chat-store';
import { useSessionStore, selectIsSessionActive, selectSessionSummary } from '../stores/session-store';
import type { SessionMessage } from '../types/session';

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
  /** Restores persisted session/chat state for resume flows */
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

function toChatMessages(messages: SessionMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role === 'user' ? 'user' : 'sophia',
    content: message.content,
    createdAt: new Date(message.createdAt).getTime(),
    status: message.incomplete ? 'interrupted' : 'complete',
    source: 'text',
  }));
}

export async function restorePersistedActiveSession(): Promise<boolean> {
  const { session, restoreOpenSession } = useSessionStore.getState();

  if (!session?.isActive) {
    return false;
  }

  const userId = session.userId?.trim() || undefined;

  if (isUuid(session.sessionId)) {
    try {
      const latestSession = await getSession(session.sessionId, userId);
      if (!isError(latestSession)) {
        if (latestSession.data.status !== 'ended') {
          await restoreOpenSession(latestSession.data, userId);
          return true;
        }

        logger.warn('SessionPersistence: Ignoring ended backend snapshot during local resume restore', {
          component: 'SessionPersistence',
          sessionId: session.sessionId,
          userId,
        });
      }
    } catch (error) {
      logger.warn('SessionPersistence: Failed to refresh persisted active session from backend', {
        component: 'SessionPersistence',
        sessionId: session.sessionId,
        userId,
        error,
      });
    }
  }

  const chatState = useChatStore.getState();
  const needsChatRehydration = chatState.conversationId !== session.sessionId || chatState.messages.length === 0;

  if (needsChatRehydration) {
    const restoredMessages = toChatMessages(session.messages ?? []);
    const lastCompletedAssistant = [...restoredMessages]
      .reverse()
      .find((message) => message.role === 'sophia' && message.status === 'complete');
    const lastUserMessage = [...restoredMessages]
      .reverse()
      .find((message) => message.role === 'user');

    useChatStore.setState({
      messages: restoredMessages,
      conversationId: session.sessionId,
      isLoadingHistory: false,
      lastError: undefined,
      isLocked: false,
      activeReplyId: undefined,
      abortController: undefined,
      streamStatus: 'idle',
      streamAttempt: 0,
      lastCompletedTurnId: lastCompletedAssistant?.turnId,
      lastUserTurnId: lastUserMessage?.id,
    });
  }

  return true;
}

export async function restoreSessionRouteState(): Promise<boolean> {
  if (await restorePersistedActiveSession()) {
    return true;
  }

  const sessionStore = useSessionStore.getState();
  const latestRecoverableSession = [
    ...sessionStore.openSessions,
    ...sessionStore.recentSessions.filter((session) => session.status !== 'ended'),
  ]
    .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())[0];

  if (latestRecoverableSession) {
    try {
      const userId = sessionStore.session?.userId?.trim() || undefined;
      await sessionStore.restoreOpenSession(latestRecoverableSession, userId);
      return true;
    } catch (error) {
      logger.warn('SessionPersistence: Failed to restore the latest recoverable session from store state', {
        component: 'SessionPersistence',
        sessionId: latestRecoverableSession.session_id,
        error,
      });
    }
  }

  try {
    const activeSessionResult = await getActiveSession();
    if (isError(activeSessionResult) || !activeSessionResult.data.has_active_session || !activeSessionResult.data.session) {
      return false;
    }

    const userId = useSessionStore.getState().session?.userId?.trim() || undefined;
    await useSessionStore.getState().restoreOpenSession(activeSessionResult.data.session, userId);
    return true;
  } catch (error) {
    logger.warn('SessionPersistence: Failed to restore active session for the session route', {
      component: 'SessionPersistence',
      error,
    });
    return false;
  }
}

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
  // Restore Session: Rehydrate persisted stores for resume surfaces
  // ---------------------------------------------------------------------------
  
  const restoreSession = useCallback((): boolean => {
    if (!hasActiveSession) {
      return false;
    }

    void restorePersistedActiveSession();
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
