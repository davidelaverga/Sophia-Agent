import { useEffect, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { parseUsageLimitFromError } from '../lib/usage-limit-parser';
import { errorCopy } from '../lib/error-copy';
import { debugWarn } from '../lib/debug-logger';
import type { UseCompanionChatRuntimeParams } from './types';

export function useCompanionChatRuntime({
  chatRequestBody,
  handleDataPart,
  handleFinish,
  showUsageLimitModal,
  recordConnectivityFailure,
  showToast,
}: UseCompanionChatRuntimeParams) {
  const chatTransport = useMemo(() => {
    return new DefaultChatTransport({
      api: '/api/chat',
      body: chatRequestBody,
    });
  }, [chatRequestBody]);

  const {
    messages: chatMessages,
    sendMessage: sendChatMessage,
    status: chatStatus,
    error: chatError,
    setMessages: setChatMessages,
    stop: stopStreaming,
  } = useChat({
    transport: chatTransport,
    onData: handleDataPart,
    onFinish: handleFinish,
    onError: (error) => {
      debugWarn('useChat', 'Error', { error });

      const parsedUsageLimit = parseUsageLimitFromError(error);
      if (parsedUsageLimit) {
        showUsageLimitModal(parsedUsageLimit.info);
        return;
      }

      const errorMessage = error.message || '';
      if (
        errorMessage.includes('offline') ||
        errorMessage.includes('Backend unavailable') ||
        errorMessage.includes('503')
      ) {
        recordConnectivityFailure();
        showToast({
          message: errorCopy.couldntReachSophia,
          variant: 'warning',
          durationMs: 4000,
        });
        return;
      }

      showToast({
        message: errorCopy.connectionInterrupted,
        variant: 'error',
        durationMs: 3000,
      });
    },
  });

  useEffect(() => {
    return () => {
      stopStreaming();
    };
  }, [stopStreaming]);

  return {
    chatMessages,
    sendChatMessage,
    chatStatus,
    chatError,
    setChatMessages,
    stopStreaming,
  };
}