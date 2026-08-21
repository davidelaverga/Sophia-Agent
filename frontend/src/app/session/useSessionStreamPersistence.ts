import { useEffect, useRef } from 'react';

import type { UIMessage } from '../components/session';
import { isError, persistSessionMessages } from '../lib/api/sessions-api';
import { debugLog } from '../lib/debug-logger';
import type { SessionMessage } from '../lib/session-types';
import { isUuid } from '../lib/utils';
import { useSessionStore } from '../stores/session-store';

interface UseSessionStreamPersistenceParams {
  messages: UIMessage[];
  chatStatus: 'submitted' | 'streaming' | 'ready' | 'error';
  updateMessages: (messages: SessionMessage[]) => void;
}

function normalizeMessageContent(content: string) {
  return content.trim().replace(/\s+/g, ' ');
}

function stableContentHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function deriveStableMessageId({
  sessionId,
  role,
  content,
  createdAt,
  index,
}: {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  index: number;
}) {
  const basis = `${sessionId}:${role}:${createdAt}:${stableContentHash(normalizeMessageContent(content).toLowerCase())}:${index}`;
  return `snapshot-${stableContentHash(basis)}`;
}

export function useSessionStreamPersistence({
  messages,
  chatStatus,
  updateMessages,
}: UseSessionStreamPersistenceParams) {
  const isUnloadingRef = useRef(false);
  const wasStreamingRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageRevisionRef = useRef(0);
  const latestPersistPayloadRef = useRef<{
    sessionId: string;
    userId: string;
    threadId?: string;
    messages: Array<{
      id: string;
      message_id: string;
      role: 'user' | 'assistant';
      content: string;
      created_at: string;
      source: string;
      final: boolean;
      incomplete: boolean;
    }>;
  } | null>(null);

  useEffect(() => {
    const handleBeforeUnload = () => {
      isUnloadingRef.current = true;
    };

    window.addEventListener('beforeunload', handleBeforeUnload, { capture: true });
    return () => window.removeEventListener('beforeunload', handleBeforeUnload, { capture: true });
  }, []);

  useEffect(() => () => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const flushTranscript = () => {
      const payload = latestPersistPayloadRef.current;
      if (!payload || payload.messages.length === 0) return;

      const url = `/api/sessions/${payload.sessionId}/messages?user_id=${encodeURIComponent(payload.userId)}`;
      const body = JSON.stringify({
        user_id: payload.userId,
        thread_id: payload.threadId,
        messages: payload.messages,
      });

      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
      }

      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushTranscript();
      }
    };

    window.addEventListener('pagehide', flushTranscript);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushTranscript);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (messages.length <= 0) return;

    const isStreaming = chatStatus === 'streaming' || chatStatus === 'submitted';
    const streamJustEnded = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;

    if (isUnloadingRef.current && streamJustEnded) {
      return;
    }

    const toStore: SessionMessage[] = messages.map(({ id, role, content, createdAt }, index) => ({
      id,
      role,
      content,
      createdAt,
      incomplete: isStreaming && role === 'assistant' && index === messages.length - 1,
    }));

    updateMessages(toStore);

    const session = useSessionStore.getState().session;
    if (!session?.sessionId || !session.userId || !isUuid(session.sessionId)) return;

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }

    const isPlaceholderGreeting = (message: SessionMessage, index: number) => (
      index === 0 &&
      message.role === 'assistant' &&
      (
        message.id === session.greetingMessageId ||
        message.id === 'greeting-1' ||
        message.id.startsWith('fallback-')
      )
    );

    const transcript = toStore
      .filter((message, index) => {
        if (message.role !== 'user' && message.role !== 'assistant') return false;
        if (!normalizeMessageContent(message.content)) return false;
        if (message.role === 'assistant' && message.incomplete) return false;
        if (isPlaceholderGreeting(message, index)) return false;
        return true;
      })
      .map((message, index) => {
        const stableId = message.id || deriveStableMessageId({
          sessionId: session.sessionId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          index,
        });
        return {
          id: stableId,
          message_id: stableId,
          role: message.role,
          content: message.content,
          created_at: message.createdAt,
          source: message.id.startsWith('voice-') ? 'voice' : 'text',
          final: !message.incomplete,
          incomplete: Boolean(message.incomplete),
        };
      });

    if (transcript.length === 0) {
      latestPersistPayloadRef.current = null;
      return;
    }

    latestPersistPayloadRef.current = {
      sessionId: session.sessionId,
      userId: session.userId,
      threadId: session.threadId,
      messages: transcript,
    };

    persistTimerRef.current = setTimeout(() => {
      void (async () => {
        const latestSession = useSessionStore.getState().session;
        if (!latestSession?.sessionId || latestSession.sessionId !== session.sessionId) return;

        const result = await persistSessionMessages(
          session.sessionId,
          {
            user_id: session.userId,
            thread_id: session.threadId,
            messages: transcript,
            base_revision: messageRevisionRef.current,
          },
          session.userId,
        );
        if (isError(result)) {
          debugLog('SessionStreamPersistence', 'persist session messages failed', {
            status: result.status,
            code: result.code,
          });
        } else {
          messageRevisionRef.current = result.data.message_revision ?? messageRevisionRef.current;
          if (result.data.conflict) {
            debugLog('SessionStreamPersistence', 'snapshot conflict merged without deletion', {
              messageRevision: messageRevisionRef.current,
              deletedCount: result.data.deleted_count ?? 0,
            });
          }
        }
      })();
    }, isStreaming ? 700 : 150);

  }, [messages, updateMessages, chatStatus]);
}
