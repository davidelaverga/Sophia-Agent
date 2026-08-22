import { useCallback, useEffect, useRef } from 'react';

import type { UIMessage } from '../components/session';
import {
  getSessionMessages,
  isError,
  persistSessionMessages,
} from '../lib/api/sessions-api';
import { debugLog } from '../lib/debug-logger';
import type { SessionMessage } from '../lib/session-types';
import { isUuid } from '../lib/utils';
import { useSessionStore } from '../stores/session-store';
import type { SessionMessageItem, SessionMessagesResponse } from '../types/session';

interface UseSessionStreamPersistenceParams {
  messages: UIMessage[];
  chatStatus: 'submitted' | 'streaming' | 'ready' | 'error';
  updateMessages: (messages: SessionMessage[]) => void;
}

type PersistedTranscriptMessage = {
  id: string;
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string | null;
  source: string;
  final: boolean;
  incomplete: boolean;
  approximate?: boolean;
  turn_id?: string | null;
  provider_event_id?: string | null;
};

type PersistPayload = {
  sessionId: string;
  userId: string;
  threadId?: string;
  messages: PersistedTranscriptMessage[];
};

type QueuedSnapshot = {
  generation: number;
  payload: PersistPayload;
  rebaseAttempts: number;
};

const MAX_CONFLICT_REBASE_ATTEMPTS = 3;

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

function persistedMessageId(message: PersistedTranscriptMessage) {
  return message.message_id || message.id;
}

function snapshotFingerprint(messages: PersistedTranscriptMessage[]) {
  return messages.map((message) => [
    persistedMessageId(message),
    message.role,
    normalizeMessageContent(message.content),
    message.created_at ?? '',
  ].join(':')).join('|');
}

function historyMessageToPersisted(message: SessionMessageItem): PersistedTranscriptMessage {
  return {
    id: message.id,
    message_id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    created_at: message.created_at,
    source: message.source ?? 'text',
    final: message.final ?? true,
    incomplete: false,
    approximate: message.approximate,
    turn_id: message.turn_id,
    provider_event_id: message.provider_event_id,
  };
}

function persistedToSessionMessages(messages: PersistedTranscriptMessage[]): SessionMessage[] {
  const fallbackTimestamp = new Date().toISOString();
  return messages.map((message) => ({
    id: persistedMessageId(message),
    role: message.role,
    content: message.content,
    createdAt: message.created_at ?? fallbackTimestamp,
    incomplete: !message.final || message.incomplete,
  }));
}

function rebaseLocalAdditions({
  authoritative,
  local,
  previousAccepted,
}: {
  authoritative: PersistedTranscriptMessage[];
  local: PersistedTranscriptMessage[];
  previousAccepted: PersistedTranscriptMessage[];
}) {
  const previousIds = new Set(previousAccepted.map(persistedMessageId));
  const authoritativeIds = new Set(authoritative.map(persistedMessageId));
  const localAdditions = local.filter((message) => {
    const id = persistedMessageId(message);
    return !previousIds.has(id) && !authoritativeIds.has(id);
  });
  return [...authoritative, ...localAdditions];
}

export function useSessionStreamPersistence({
  messages,
  chatStatus,
  updateMessages,
}: UseSessionStreamPersistenceParams) {
  const activeSessionId = useSessionStore((state) => state.session?.sessionId);
  const activeThreadId = useSessionStore((state) => state.session?.threadId);
  const activeUserId = useSessionStore((state) => state.session?.userId);
  const greetingMessageId = useSessionStore((state) => state.session?.greetingMessageId);
  const isUnloadingRef = useRef(false);
  const wasStreamingRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageRevisionRef = useRef(0);
  const generationRef = useRef(0);
  const acceptedMessagesRef = useRef<PersistedTranscriptMessage[]>([]);
  const acceptedBaselineKnownRef = useRef(false);
  const latestPersistPayloadRef = useRef<PersistPayload | null>(null);
  const pendingSnapshotRef = useRef<QueuedSnapshot | null>(null);
  const writeInFlightRef = useRef(false);
  const seedPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const updateMessagesRef = useRef(updateMessages);

  useEffect(() => {
    updateMessagesRef.current = updateMessages;
  }, [updateMessages]);

  const applyAuthoritativeResponse = useCallback((
    data: SessionMessagesResponse,
    { syncSessionContext = false }: { syncSessionContext?: boolean } = {},
  ) => {
    const authoritative = data.messages.map(historyMessageToPersisted);
    messageRevisionRef.current = Math.max(0, data.message_revision);
    acceptedMessagesRef.current = authoritative;
    acceptedBaselineKnownRef.current = true;
    if (syncSessionContext) {
      updateMessagesRef.current(persistedToSessionMessages(authoritative));
    }
    return authoritative;
  }, []);

  const drainQueue = useCallback(async () => {
    if (writeInFlightRef.current) return;
    writeInFlightRef.current = true;

    try {
      while (pendingSnapshotRef.current) {
        const queued = pendingSnapshotRef.current;
        pendingSnapshotRef.current = null;
        await seedPromiseRef.current;

        if (queued.generation !== generationRef.current) continue;
        if (
          snapshotFingerprint(queued.payload.messages)
          === snapshotFingerprint(acceptedMessagesRef.current)
        ) {
          continue;
        }

        const previousAccepted = acceptedMessagesRef.current;
        const previousAcceptedWasKnown = acceptedBaselineKnownRef.current;
        const result = await persistSessionMessages(
          queued.payload.sessionId,
          {
            user_id: queued.payload.userId,
            thread_id: queued.payload.threadId,
            messages: queued.payload.messages,
            base_revision: messageRevisionRef.current,
          },
          queued.payload.userId,
        );

        if (queued.generation !== generationRef.current) continue;
        if (isError(result)) {
          debugLog('SessionStreamPersistence', 'persist session messages failed', {
            status: result.status,
            code: result.code,
          });
          continue;
        }

        if (result.data.conflict || result.data.accepted === false) {
          debugLog('SessionStreamPersistence', 'snapshot rejected; refetching authoritative transcript', {
            messageRevision: result.data.message_revision,
            rejectionReason: result.data.rejection_reason ?? 'revision_conflict',
          });
          const refresh = await getSessionMessages(
            queued.payload.sessionId,
            queued.payload.userId,
          );
          if (queued.generation !== generationRef.current) continue;
          if (isError(refresh)) {
            debugLog('SessionStreamPersistence', 'conflict refetch failed; snapshot remains rejected', {
              status: refresh.status,
              code: refresh.code,
            });
            continue;
          }

          const authoritative = applyAuthoritativeResponse(refresh.data);
          const newestQueued = (
            pendingSnapshotRef.current?.generation === queued.generation
              ? pendingSnapshotRef.current
              : queued
          );
          if (pendingSnapshotRef.current === newestQueued) {
            pendingSnapshotRef.current = null;
          }
          const rebasedMessages = previousAcceptedWasKnown
            ? rebaseLocalAdditions({
                authoritative,
                local: newestQueued.payload.messages,
                previousAccepted,
              })
            : authoritative;

          if (!previousAcceptedWasKnown) {
            debugLog(
              'SessionStreamPersistence',
              'conflict occurred without a seeded baseline; stale local snapshot rejected',
              { messageRevision: messageRevisionRef.current },
            );
          }

          if (snapshotFingerprint(rebasedMessages) === snapshotFingerprint(authoritative)) {
            latestPersistPayloadRef.current = {
              ...newestQueued.payload,
              messages: authoritative,
            };
            updateMessagesRef.current(persistedToSessionMessages(authoritative));
            continue;
          }

          if (newestQueued.rebaseAttempts >= MAX_CONFLICT_REBASE_ATTEMPTS) {
            latestPersistPayloadRef.current = {
              ...newestQueued.payload,
              messages: authoritative,
            };
            updateMessagesRef.current(persistedToSessionMessages(authoritative));
            debugLog('SessionStreamPersistence', 'conflict rebase limit reached; server transcript kept', {
              messageRevision: messageRevisionRef.current,
            });
            continue;
          }

          const rebasedPayload = {
            ...newestQueued.payload,
            messages: rebasedMessages,
          };
          latestPersistPayloadRef.current = rebasedPayload;
          pendingSnapshotRef.current = {
            generation: queued.generation,
            payload: rebasedPayload,
            rebaseAttempts: newestQueued.rebaseAttempts + 1,
          };
          continue;
        }

        const accepted = applyAuthoritativeResponse(result.data, { syncSessionContext: true });
        latestPersistPayloadRef.current = {
          ...queued.payload,
          messages: accepted,
        };
      }
    } finally {
      writeInFlightRef.current = false;
    }
  }, [applyAuthoritativeResponse]);

  const enqueueSnapshot = useCallback((snapshot: QueuedSnapshot) => {
    if (snapshot.generation !== generationRef.current) return;
    pendingSnapshotRef.current = snapshot;
    void drainQueue();
  }, [drainQueue]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    messageRevisionRef.current = 0;
    acceptedMessagesRef.current = [];
    acceptedBaselineKnownRef.current = false;
    pendingSnapshotRef.current = null;
    latestPersistPayloadRef.current = null;
    isUnloadingRef.current = false;
    wasStreamingRef.current = false;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    if (
      !activeSessionId
      || !activeUserId
      || !isUuid(activeSessionId)
    ) {
      seedPromiseRef.current = Promise.resolve();
      return;
    }

    seedPromiseRef.current = (async () => {
      const result = await getSessionMessages(activeSessionId, activeUserId);
      if (generation !== generationRef.current) return;
      if (isError(result)) {
        debugLog('SessionStreamPersistence', 'revision seed failed; writes will conflict safely', {
          status: result.status,
          code: result.code,
        });
        return;
      }
      applyAuthoritativeResponse(result.data);
    })();
  }, [
    activeSessionId,
    activeThreadId,
    activeUserId,
    applyAuthoritativeResponse,
  ]);

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
        base_revision: messageRevisionRef.current,
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

    if (
      !activeSessionId
      || !activeUserId
      || !isUuid(activeSessionId)
    ) return;

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }

    const isPlaceholderGreeting = (message: SessionMessage, index: number) => (
      index === 0
      && message.role === 'assistant'
      && (
        message.id === greetingMessageId
        || message.id === 'greeting-1'
        || message.id.startsWith('fallback-')
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
      .map((message, index): PersistedTranscriptMessage => {
        const stableId = message.id || deriveStableMessageId({
          sessionId: activeSessionId,
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

    const payload: PersistPayload = {
      sessionId: activeSessionId,
      userId: activeUserId,
      threadId: activeThreadId,
      messages: transcript,
    };
    latestPersistPayloadRef.current = payload;
    const generation = generationRef.current;

    persistTimerRef.current = setTimeout(() => {
      const latestSession = useSessionStore.getState().session;
      if (!latestSession?.sessionId || latestSession.sessionId !== payload.sessionId) return;
      enqueueSnapshot({ generation, payload, rebaseAttempts: 0 });
    }, isStreaming ? 700 : 150);
  }, [
    activeSessionId,
    activeThreadId,
    activeUserId,
    chatStatus,
    enqueueSnapshot,
    greetingMessageId,
    messages,
    updateMessages,
  ]);
}
