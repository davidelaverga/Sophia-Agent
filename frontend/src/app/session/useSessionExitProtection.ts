import { useEffect } from 'react';
import { logger } from '../lib/error-logger';
import { persistRefreshInterruptHint } from './refresh-interrupt-hint';

type ExitGuardMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

type PersistedSessionMessage = ExitGuardMessage & {
  incomplete?: boolean;
};

interface UseSessionExitProtectionParams {
  sessionId?: string;
  responseMode?: 'text' | 'voice';
  isSophiaResponding: boolean;
  messages: ExitGuardMessage[];
  updateMessages: (messages: PersistedSessionMessage[]) => void;
  openExitConfirm: () => void;
  isExitInProgress?: boolean;
}

function persistInterruptedMessages(messages: PersistedSessionMessage[]) {
  try {
    const storageKey = 'sophia-session-store';
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;

    const parsed = JSON.parse(stored);
    if (!parsed.state?.session) return;

    parsed.state.session.messages = messages;
    parsed.state.session.updatedAt = new Date().toISOString();
    localStorage.setItem(storageKey, JSON.stringify(parsed));
  } catch (error) {
    logger.logError(error, {
      component: 'SessionPage',
      action: 'mark_message_incomplete',
    });
  }
}

export function useSessionExitProtection({
  sessionId,
  responseMode,
  isSophiaResponding,
  messages,
  updateMessages,
  openExitConfirm,
  isExitInProgress = false,
}: UseSessionExitProtectionParams) {
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isExitInProgress) return;
      if (!isSophiaResponding || messages.length === 0) return;

      const currentMessages = messages.map((message, index) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        incomplete: message.role === 'assistant' && index === messages.length - 1,
      }));

      updateMessages(currentMessages);
      persistInterruptedMessages(currentMessages);

      if (sessionId) {
        const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');
        if (lastAssistantMessage) {
          persistRefreshInterruptHint({
            sessionId,
            assistantMessageId: lastAssistantMessage.id,
            interruptedAt: Date.now(),
            responseMode: responseMode ?? 'text',
          });
        }
      }

      event.preventDefault();
      event.returnValue = 'Sophia is still responding. Are you sure you want to leave?';
      return event.returnValue;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sessionId, responseMode, isSophiaResponding, messages, updateMessages, isExitInProgress]);

  useEffect(() => {
    if (isExitInProgress) return;
    if (!isSophiaResponding) return;

    window.history.pushState({ sophiaResponding: true }, '');

    const handlePopState = () => {
      openExitConfirm();
      window.history.pushState({ sophiaResponding: true }, '');
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (window.history.state?.sophiaResponding) {
        window.history.back();
      }
    };
  }, [isSophiaResponding, openExitConfirm, isExitInProgress]);
}
