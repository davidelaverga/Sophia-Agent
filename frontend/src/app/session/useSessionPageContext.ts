import { useEffect, useRef } from 'react';

import { usePlatformSignal } from '../hooks/usePlatformSignal';
import { isError, updateSession as updatePersistedSession } from '../lib/api/sessions-api';
import { authBypassEnabled, authBypassUserId } from '../lib/auth/dev-bypass';
import { logger } from '../lib/error-logger';
import { getSessionGreetingMessage } from '../lib/time-greetings';
import { isUuid } from '../lib/utils';
import { selectHasUploadsInFlight, selectUploadedFilenamesForThread } from '../stores/attachments-store';
import { useAttachmentsStore } from '../stores/attachments-store';
import { useChatStore } from '../stores/chat-store';
import { useMessageMetadataStore } from '../stores/message-metadata-store';
import { useSessionStore, selectSession, selectArtifacts, selectBuilderArtifact, selectMessages } from '../stores/session-store';
import type { MemoryHighlight } from '../types/session';

interface UseSessionPageContextParams {
  bootstrapSessionId?: string;
  bootstrapMessageId?: string;
  bootstrapMemoryHighlights?: MemoryHighlight[];
}

export function useSessionPageContext({
  bootstrapSessionId,
  bootstrapMessageId,
  bootstrapMemoryHighlights,
}: UseSessionPageContextParams) {
  const session = useSessionStore(selectSession);
  const latestSessionRef = useRef(session);
  const artifacts = useSessionStore(selectArtifacts);
  const builderArtifact = useSessionStore(selectBuilderArtifact);
  const storedMessages = useSessionStore(selectMessages);
  const updateMessages = useSessionStore((state) => state.updateMessages);
  const updateSession = useSessionStore((state) => state.updateSession);
  const storeArtifacts = useSessionStore((state) => state.storeArtifacts);
  const storeBuilderArtifact = useSessionStore((state) => state.storeBuilderArtifact);
  const endSession = useSessionStore((state) => state.endSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  const pauseSession = useSessionStore((state) => state.pauseSession);
  const resumeSession = useSessionStore((state) => state.resumeSession);
  const setEnding = useSessionStore((state) => state.setEnding);
  const isEnding = useSessionStore((state) => state.isEnding);

  const chatConversationId = useChatStore((state) => state.conversationId);
  const currentThreadId = useMessageMetadataStore((state) => state.currentThreadId);
  const currentMetadataSessionId = useMessageMetadataStore((state) => state.currentSessionId);
  const platform = usePlatformSignal();

  const sessionId = session?.sessionId || chatConversationId || 'default-session';
  const backendSessionId = session?.sessionId || bootstrapSessionId;
  const hasValidBackendSessionId = isUuid(backendSessionId);
  const userId = session?.userId || (authBypassEnabled ? authBypassUserId : 'anonymous');
  const sessionPresetType = session?.presetType;
  const sessionContextMode = session?.contextMode;
  const isReadOnly = session?.status === 'ended' && !session.isActive;
  const safeSessionId = hasValidBackendSessionId ? backendSessionId : undefined;
  const hasMatchingMetadataThreadId = safeSessionId && currentMetadataSessionId === safeSessionId;
  const metadataThreadCollidesWithSessionId = hasMatchingMetadataThreadId
    && currentThreadId === safeSessionId
    && Boolean(session?.threadId)
    && session.threadId !== safeSessionId;
  const resolvedThreadId = hasMatchingMetadataThreadId && currentThreadId && !metadataThreadCollidesWithSessionId
    ? currentThreadId
    : session?.threadId;
  const fallbackGreeting = sessionPresetType && sessionContextMode
    ? getSessionGreetingMessage(sessionPresetType, sessionContextMode)
    : "I'm here with you. What's on your mind?";
  const initialGreeting = session?.greetingMessage || fallbackGreeting;
  const greetingMessageId = session?.greetingMessageId || 'greeting-1';
  const greetingAnchorId = session?.greetingMessageId || bootstrapMessageId || null;
  const memoryHighlights = session?.memoryHighlights ?? bootstrapMemoryHighlights;

  // Subscribe to pending attachments for THIS thread. The transport
  // memoizes on chatRequestBody identity — when the user adds/removes
  // a file, the body identity changes and the next POST picks it up.
  //
  // Thread-scope (Codex P2 PR #132): a user could upload in thread A,
  // switch to thread B, and submit. Without the per-thread filter,
  // A's filenames would leak into B's request — view_user_image would
  // then fail to find the bytes (they're in A's sandbox, not B's).
  // The selectors filter by ``resolvedThreadId`` so only this
  // session's uploaded filenames appear in attached_files.
  const attachedFiles = useAttachmentsStore(
    selectUploadedFilenamesForThread(resolvedThreadId),
  );
  // Surface "is anything still uploading?" so the session page can
  // disable submit and avoid the orphan-upload race: if the user
  // hits send mid-upload, the in-flight file is filtered out of
  // attached_files, then post-dispatch clearForThread() wipes the
  // store — when the upload eventually completes, the chip is gone
  // and Sophia never learned the filename. Codex P2 PR #132.
  const hasUploadsInFlight = useAttachmentsStore(
    selectHasUploadsInFlight(resolvedThreadId),
  );

  const chatRequestBody = safeSessionId
    ? {
        session_id: safeSessionId,
        user_id: userId,
        thread_id: resolvedThreadId,
        session_type: sessionPresetType,
        context_mode: sessionContextMode,
        platform,
        attached_files: attachedFiles,
      }
    : undefined;

  useEffect(() => {
    latestSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!session?.sessionId || !resolvedThreadId || resolvedThreadId === session.threadId) {
      return;
    }

    if (currentMetadataSessionId !== session.sessionId) {
      return;
    }

    updateSession({ threadId: resolvedThreadId });
  }, [currentMetadataSessionId, resolvedThreadId, session?.sessionId, session?.threadId, updateSession]);

  useEffect(() => {
    if (!session?.sessionId || !session.isActive || session.status !== 'paused') return;

    resumeSession();

    if (safeSessionId) {
      void (async () => {
        const result = await updatePersistedSession(safeSessionId, { status: 'open' }, userId);
        if (isError(result)) {
          logger.warn('SessionPageContext: Failed to resume paused session on backend', {
            sessionId: safeSessionId,
            userId,
            code: result.code,
            error: result.error,
          });
          return;
        }

        useSessionStore.getState().recordOpenSessionActivity(safeSessionId, {
          updatedAt: result.data.updated_at,
          status: result.data.status,
          endedAt: result.data.ended_at ?? null,
        });
      })();
    }
  }, [resumeSession, safeSessionId, session?.isActive, session?.sessionId, session?.status, userId]);

  useEffect(() => {
    return () => {
      const current = latestSessionRef.current;
      if (!current?.isActive || current.status !== 'active') return;

      pauseSession();

      if (!isUuid(current.sessionId)) return;

      void (async () => {
        const result = await updatePersistedSession(current.sessionId, { status: 'paused' }, current.userId);
        if (isError(result)) {
          logger.warn('SessionPageContext: Failed to persist paused session on backend', {
            sessionId: current.sessionId,
            userId: current.userId,
            code: result.code,
            error: result.error,
          });
          return;
        }

        useSessionStore.getState().recordOpenSessionActivity(current.sessionId, {
          updatedAt: result.data.updated_at,
          status: result.data.status,
          endedAt: result.data.ended_at ?? null,
        });
      })();
    };
  }, [pauseSession]);

  return {
    session,
    artifacts,
    builderArtifact,
    storedMessages,
    updateMessages,
    updateSession,
    storeArtifacts,
    storeBuilderArtifact,
    endSession,
    clearSession,
    pauseSession,
    resumeSession,
    setEnding,
    isEnding,
    sessionId,
    backendSessionId,
    hasValidBackendSessionId,
    userId,
    resolvedThreadId,
    sessionPresetType,
    sessionContextMode,
    isReadOnly,
    safeSessionId,
    initialGreeting,
    greetingMessageId,
    greetingAnchorId,
    memoryHighlights,
    chatRequestBody,
    hasUploadsInFlight,
  };
}
