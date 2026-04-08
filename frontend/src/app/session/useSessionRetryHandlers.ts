import { useCallback } from 'react';
import type { MutableRefObject } from 'react';

import { logger } from '../lib/error-logger';
import { recoverFromDisconnect } from '../lib/stream-recovery';

type ChatMessage = {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: Array<{
    type?: string;
    text?: string;
    [key: string]: unknown;
  }>;
};

function buildAssistantTextParts(text: string) {
  return [{ type: 'text' as const, text }];
}

export type RetryResult =
  | { kind: 'none' }
  | { kind: 'recovered'; response: string }
  | { kind: 'resent' };

interface UseSessionRetryHandlersParams<TChatMessage extends ChatMessage> {
  lastUserMessageContent: string | null;
  isInterruptedByRefresh: boolean;
  hasValidBackendSessionId: boolean;
  backendSessionId?: string;
  refreshInterruptedAt: number | null;
  cancelledMessageId: string | null;
  lastUserMessageId: string | null;
  chatMessages: TChatMessage[];
  setChatMessages: (messages: TChatMessage[] | ((messages: TChatMessage[]) => TChatMessage[])) => void;
  sendMessage: (params: { text: string }) => Promise<void>;
  showToast: (args: { message: string; variant: 'info' | 'success' | 'error'; durationMs?: number }) => void;
  messageCountBeforeSendRef: MutableRefObject<number>;
  setCancelledMessageId: (value: string | null) => void;
  setLastUserMessageContent: (value: string | null) => void;
  setLastUserMessageId: (value: string | null) => void;
  setIsInterruptedByRefresh: (value: boolean) => void;
  setInterruptedResponseMode: (value: 'text' | 'voice' | null) => void;
  setRefreshInterruptedAt: (value: number | null) => void;
  setMessageTimestamp: (id: string, createdAt: string) => void;
}

export function useSessionRetryHandlers<TChatMessage extends ChatMessage>({
  lastUserMessageContent,
  isInterruptedByRefresh,
  hasValidBackendSessionId,
  backendSessionId,
  refreshInterruptedAt,
  cancelledMessageId,
  lastUserMessageId,
  chatMessages,
  setChatMessages,
  sendMessage,
  showToast,
  messageCountBeforeSendRef,
  setCancelledMessageId,
  setLastUserMessageContent,
  setLastUserMessageId,
  setIsInterruptedByRefresh,
  setInterruptedResponseMode,
  setRefreshInterruptedAt,
  setMessageTimestamp,
}: UseSessionRetryHandlersParams<TChatMessage>) {
  const handleRetry = useCallback(async (): Promise<RetryResult> => {
    if (!lastUserMessageContent) {
      return { kind: 'none' };
    }

    if (isInterruptedByRefresh && hasValidBackendSessionId && backendSessionId) {
      try {
        const recovery = await recoverFromDisconnect({
          sessionId: backendSessionId,
          lastUserMessage: lastUserMessageContent,
          disconnectedAt: refreshInterruptedAt ?? Date.now() - 5000,
          minWaitMs: 2500,
          maxWaitMs: 30000,
        });

        if (!recovery.shouldRetry && recovery.existingResponse) {
          const recoveredAt = new Date().toISOString();

          setChatMessages((prev) => {
            let replaced = false;
            const next = prev.map((message) => {
              if (cancelledMessageId && message.id === cancelledMessageId && message.role === 'assistant') {
                replaced = true;
                setMessageTimestamp(message.id, recoveredAt);
                return {
                  ...message,
                  parts: buildAssistantTextParts(recovery.existingResponse),
                } as TChatMessage;
              }
              return message;
            });

            if (!replaced) {
              const recoveredId = recovery.existingMessageId || `recovered-${Date.now()}`;
              setMessageTimestamp(recoveredId, recoveredAt);
              next.push({
                id: recoveredId,
                role: 'assistant' as const,
                parts: buildAssistantTextParts(recovery.existingResponse),
              } as TChatMessage);
            }

            return next;
          });

          setCancelledMessageId(null);
          setIsInterruptedByRefresh(false);
          setInterruptedResponseMode(null);
          setRefreshInterruptedAt(null);
          showToast({
            message: 'Recovered Sophia’s last reply.',
            variant: 'success',
            durationMs: 2200,
          });
          return {
            kind: 'recovered',
            response: recovery.existingResponse,
          };
        }
      } catch (error) {
        logger.logError(error, {
          component: 'SessionPage',
          action: 'retry_recovery_check',
        });
      }
    }

    if (isInterruptedByRefresh && lastUserMessageId) {
      const userMsgIndex = chatMessages.findIndex((message) => message.id === lastUserMessageId);
      if (userMsgIndex >= 0) {
        setChatMessages((prev) => prev.slice(0, userMsgIndex));
      }
    } else {
      const currentMessages = [...chatMessages];
      const countBefore = messageCountBeforeSendRef.current;

      if (countBefore > 0 && currentMessages.length > countBefore) {
        setChatMessages((prev) => prev.slice(0, countBefore));
      }
    }

    setCancelledMessageId(null);
    setIsInterruptedByRefresh(false);
    setInterruptedResponseMode(null);
    setRefreshInterruptedAt(null);

    messageCountBeforeSendRef.current = chatMessages.length;
    await sendMessage({ text: lastUserMessageContent });
    return { kind: 'resent' };
  }, [
    lastUserMessageContent,
    isInterruptedByRefresh,
    hasValidBackendSessionId,
    backendSessionId,
    refreshInterruptedAt,
    cancelledMessageId,
    lastUserMessageId,
    chatMessages,
    messageCountBeforeSendRef,
    setChatMessages,
    sendMessage,
    showToast,
    setCancelledMessageId,
    setIsInterruptedByRefresh,
    setInterruptedResponseMode,
    setRefreshInterruptedAt,
    setMessageTimestamp,
  ]);

  const handleDismissCancelled = useCallback(() => {
    setCancelledMessageId(null);
    setLastUserMessageContent(null);
    setLastUserMessageId(null);
    setIsInterruptedByRefresh(false);
    setInterruptedResponseMode(null);
    setRefreshInterruptedAt(null);
  }, [
    setCancelledMessageId,
    setLastUserMessageContent,
    setLastUserMessageId,
    setIsInterruptedByRefresh,
    setInterruptedResponseMode,
    setRefreshInterruptedAt,
  ]);

  return {
    handleRetry,
    handleDismissCancelled,
  };
}
