import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { normalizeGreetingForDisplay } from '../lib/greeting-normalizer';
import type { ContextMode, PresetType, SessionClientStore, SessionMessage } from '../lib/session-types';
import type { BootstrapData } from '../hooks/useSessionBootstrap';
import type { MemoryHighlight } from '../types/session';
import { consumeRefreshInterruptHint } from './refresh-interrupt-hint';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
};

interface UseSessionChatInitializationParams {
  session: SessionClientStore | null;
  storedMessages: SessionMessage[];
  initialGreeting: string;
  greetingMessageId: string;
  hasBootstrap: boolean;
  bootstrap: BootstrapData | null;
  greetingRendered: boolean;
  markGreetingRendered: () => void;
  memoryHighlights?: MemoryHighlight[];
  sessionPresetType?: PresetType;
  sessionContextMode?: ContextMode;
  setChatMessages: (messages: ChatMessage[]) => void;
  setLastUserMessageId: (value: string | null) => void;
  setLastUserMessageContent: (value: string | null) => void;
  setCancelledMessageId: (value: string | null) => void;
  setIsInterruptedByRefresh: (value: boolean) => void;
  setInterruptedResponseMode: (value: 'text' | 'voice' | null) => void;
  setRefreshInterruptedAt: (value: number | null) => void;
  hasShownReconnectRef: MutableRefObject<boolean>;
  setMessageTimestamp: (id: string, createdAt: string) => void;
  showToast: (args: { message: string; variant: 'info' | 'success' | 'error'; durationMs?: number }) => void;
}

export function useSessionChatInitialization({
  session,
  storedMessages,
  initialGreeting,
  greetingMessageId,
  hasBootstrap,
  bootstrap,
  greetingRendered,
  markGreetingRendered,
  memoryHighlights,
  sessionPresetType,
  sessionContextMode,
  setChatMessages,
  setLastUserMessageId,
  setLastUserMessageContent,
  setCancelledMessageId,
  setIsInterruptedByRefresh,
  setInterruptedResponseMode,
  setRefreshInterruptedAt,
  hasShownReconnectRef,
  setMessageTimestamp,
  showToast,
}: UseSessionChatInitializationParams) {
  const hasInitializedRef = useRef(false);
  const initialGreetingSetRef = useRef(false);
  const [isInitializingChat, setIsInitializingChat] = useState(true);

  useEffect(() => {
    if (!session) return;

    if (storedMessages && storedMessages.length > 0) {
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;

        storedMessages.forEach((message) => {
          setMessageTimestamp(message.id, message.createdAt || new Date().toISOString());
        });

        setChatMessages(
          storedMessages.map((message) => ({
            id: message.id,
            role: message.role,
            parts: [{ type: 'text', text: message.content }],
          })),
        );

        setIsInitializingChat(false);

        if (hasBootstrap && bootstrap?.messageId) {
          const hasGreeting = storedMessages.some((message) => message.id === bootstrap.messageId);
          if (hasGreeting && !greetingRendered) {
            markGreetingRendered();
          }
        }

        const lastMessage = storedMessages[storedMessages.length - 1];
        const refreshHint = session?.sessionId ? consumeRefreshInterruptHint(session.sessionId) : null;
        const isInterruptedAssistantMessage =
          lastMessage?.role === 'assistant' &&
          (Boolean(lastMessage.incomplete) || (refreshHint?.assistantMessageId === lastMessage.id));

        if (isInterruptedAssistantMessage && lastMessage) {
          const lastMessageIndex = storedMessages.length - 1;
          let userMessage: SessionMessage | null = null;

          for (let index = lastMessageIndex - 1; index >= 0; index--) {
            if (storedMessages[index].role === 'user') {
              userMessage = storedMessages[index];
              break;
            }
          }

          if (userMessage) {
            setLastUserMessageId(userMessage.id);
            setLastUserMessageContent(userMessage.content);
          }

          setCancelledMessageId(lastMessage.id);
          setIsInterruptedByRefresh(true);
          setInterruptedResponseMode(refreshHint?.responseMode ?? (session?.voiceMode ? 'voice' : 'text'));
          setRefreshInterruptedAt(
            refreshHint?.interruptedAt ??
            typeof lastMessage.createdAt === 'string'
              ? new Date(lastMessage.createdAt).getTime()
              : Date.now(),
          );

          if (!hasShownReconnectRef.current) {
            hasShownReconnectRef.current = true;
            showToast({
              message: 'Reconnected. You can retry the last reply.',
              variant: 'info',
              durationMs: 2200,
            });
          }
        }
      }
      return;
    }

    if (initialGreetingSetRef.current) return;

    const hasApiGreeting = !!session.greetingMessage;
    const hasBootstrapGreeting = hasBootstrap && bootstrap?.greetingMessage;

    let effectiveGreeting: string;
    let effectiveGreetingId: string;

    if (hasApiGreeting) {
      effectiveGreeting = session.greetingMessage!;
      effectiveGreetingId = session.greetingMessageId || greetingMessageId;
    } else if (hasBootstrapGreeting) {
      effectiveGreeting = bootstrap!.greetingMessage;
      effectiveGreetingId = bootstrap!.messageId;
    } else {
      effectiveGreeting = initialGreeting;
      effectiveGreetingId = greetingMessageId;
    }

    const normalizedGreeting = normalizeGreetingForDisplay({
      greeting: effectiveGreeting,
      isResumed: Boolean(session?.isResumed || bootstrap?.isResumed),
      sessionType: sessionPresetType,
      contextMode: sessionContextMode,
      memoryHighlights,
    });

    initialGreetingSetRef.current = true;
    hasInitializedRef.current = true;

    setMessageTimestamp(effectiveGreetingId, new Date().toISOString());
    setChatMessages([
      {
        id: effectiveGreetingId,
        role: 'assistant',
        parts: [{ type: 'text', text: normalizedGreeting }],
      },
    ]);

    setIsInitializingChat(false);

    if (hasBootstrap && !greetingRendered) {
      markGreetingRendered();
    }
  }, [
    session,
    storedMessages,
    initialGreeting,
    greetingMessageId,
    setChatMessages,
    hasBootstrap,
    bootstrap,
    greetingRendered,
    markGreetingRendered,
    showToast,
    sessionPresetType,
    sessionContextMode,
    memoryHighlights,
    setLastUserMessageId,
    setLastUserMessageContent,
    setCancelledMessageId,
    setIsInterruptedByRefresh,
    setInterruptedResponseMode,
    setRefreshInterruptedAt,
    setMessageTimestamp,
    hasShownReconnectRef,
  ]);

  return {
    isInitializingChat,
  };
}
