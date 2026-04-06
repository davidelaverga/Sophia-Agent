import type { MutableRefObject } from 'react';

import type { BootstrapData } from '../hooks/useSessionBootstrap';
import type { ContextMode, PresetType, SessionClientStore, SessionMessage } from '../lib/session-types';
import type { MemoryHighlight } from '../types/session';

import { useSessionChatInitialization } from './useSessionChatInitialization';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
};

interface UseSessionInitializationOrchestrationParams {
  session: SessionClientStore | null;
  storedMessages: SessionMessage[];
  greeting: {
    initialGreeting: string;
    greetingMessageId: string;
    hasBootstrap: boolean;
    bootstrap: BootstrapData | null;
    greetingRendered: boolean;
    markGreetingRendered: () => void;
  };
  context: {
    memoryHighlights?: MemoryHighlight[];
    sessionPresetType?: PresetType;
    sessionContextMode?: ContextMode;
  };
  chat: {
    setChatMessages: (messages: ChatMessage[]) => void;
    setMessageTimestamp: (id: string, createdAt: string) => void;
  };
  retry: {
    setLastUserMessageId: (value: string | null) => void;
    setLastUserMessageContent: (value: string | null) => void;
    setCancelledMessageId: (value: string | null) => void;
    setIsInterruptedByRefresh: (value: boolean) => void;
    setInterruptedResponseMode: (value: 'text' | 'voice' | null) => void;
    setRefreshInterruptedAt: (value: number | null) => void;
    hasShownReconnectRef: MutableRefObject<boolean>;
  };
  showToast: (args: { message: string; variant: 'info' | 'success' | 'error'; durationMs?: number }) => void;
}

export function useSessionInitializationOrchestration({
  session,
  storedMessages,
  greeting,
  context,
  chat,
  retry,
  showToast,
}: UseSessionInitializationOrchestrationParams) {
  return useSessionChatInitialization({
    session,
    storedMessages,
    initialGreeting: greeting.initialGreeting,
    greetingMessageId: greeting.greetingMessageId,
    hasBootstrap: greeting.hasBootstrap,
    bootstrap: greeting.bootstrap,
    greetingRendered: greeting.greetingRendered,
    markGreetingRendered: greeting.markGreetingRendered,
    memoryHighlights: context.memoryHighlights,
    sessionPresetType: context.sessionPresetType,
    sessionContextMode: context.sessionContextMode,
    setChatMessages: chat.setChatMessages,
    setLastUserMessageId: retry.setLastUserMessageId,
    setLastUserMessageContent: retry.setLastUserMessageContent,
    setCancelledMessageId: retry.setCancelledMessageId,
    setIsInterruptedByRefresh: retry.setIsInterruptedByRefresh,
    setInterruptedResponseMode: retry.setInterruptedResponseMode,
    setRefreshInterruptedAt: retry.setRefreshInterruptedAt,
    hasShownReconnectRef: retry.hasShownReconnectRef,
    setMessageTimestamp: chat.setMessageTimestamp,
    showToast,
  });
}
