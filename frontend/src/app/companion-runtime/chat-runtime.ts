import { useChat } from '@ai-sdk/react';
import { useEffect, useMemo } from 'react';

import { debugWarn } from '../lib/debug-logger';
import { errorCopy } from '../lib/error-copy';
import { parseUsageLimitFromError } from '../lib/usage-limit-parser';

import { TurnErrorReportingChatTransport } from './turn-error-transport';
import type { UseCompanionChatRuntimeParams } from './types';

export function useCompanionChatRuntime({
  chatRequestBody,
  handleDataPart,
  handleFinish,
  showUsageLimitModal,
  recordConnectivityFailure,
  showToast,
  onTurnError,
}: UseCompanionChatRuntimeParams) {
  const chatTransport = useMemo(() => {
    return new TurnErrorReportingChatTransport({
      api: '/api/chat',
      body: chatRequestBody,
    }, onTurnError);
  }, [chatRequestBody, onTurnError]);

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
      void stopStreaming();
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