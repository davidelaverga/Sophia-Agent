import { useEffect, useRef } from 'react';
import type { SessionMessage } from '../lib/session-types';
import type { UIMessage } from '../components/session';

interface UseSessionStreamPersistenceParams {
  messages: UIMessage[];
  chatStatus: 'submitted' | 'streaming' | 'ready' | 'error';
  updateMessages: (messages: SessionMessage[]) => void;
}

export function useSessionStreamPersistence({
  messages,
  chatStatus,
  updateMessages,
}: UseSessionStreamPersistenceParams) {
  const isUnloadingRef = useRef(false);
  const wasStreamingRef = useRef(false);

  useEffect(() => {
    const handleBeforeUnload = () => {
      isUnloadingRef.current = true;
    };

    window.addEventListener('beforeunload', handleBeforeUnload, { capture: true });
    return () => window.removeEventListener('beforeunload', handleBeforeUnload, { capture: true });
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

  }, [messages, updateMessages, chatStatus]);
}
