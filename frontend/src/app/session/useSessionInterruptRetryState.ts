import { useCallback, useRef, useState } from 'react';

import { errorCopy } from '../lib/error-copy';
import { logger } from '../lib/error-logger';

export function useSessionInterruptRetryState() {
  const [cancelledMessageId, setCancelledMessageId] = useState<string | null>(null);
  const [lastUserMessageId, setLastUserMessageId] = useState<string | null>(null);
  const [lastUserMessageContent, setLastUserMessageContent] = useState<string | null>(null);
  const [isInterruptedByRefresh, setIsInterruptedByRefresh] = useState(false);
  const [interruptedResponseMode, setInterruptedResponseMode] = useState<'text' | 'voice' | null>(null);
  const [refreshInterruptedAt, setRefreshInterruptedAt] = useState<number | null>(null);

  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeRetryOptionId, setResumeRetryOptionId] = useState<string | null>(null);
  const interruptSelectHandlerRef = useRef<((optionId: string) => Promise<void>) | null>(null);

  const clearResumeError = useCallback(() => {
    setResumeError(null);
  }, []);

  const prepareInterruptSelectRetry = useCallback((optionId: string) => {
    setResumeRetryOptionId(optionId);
    setResumeError(null);
  }, []);

  const runInterruptSelectWithRetry = useCallback(async (
    optionId: string,
    handleInterruptSelect: (option: string) => Promise<void>
  ) => {
    setResumeRetryOptionId(optionId);
    setResumeError(null);
    await handleInterruptSelect(optionId);
  }, []);

  const setInterruptSelectHandler = useCallback((handler: (optionId: string) => Promise<void>) => {
    interruptSelectHandlerRef.current = handler;
  }, []);

  const handleInterruptSelectWithRetry = useCallback(async (optionId: string) => {
    const handler = interruptSelectHandlerRef.current;
    if (!handler) return;
    await runInterruptSelectWithRetry(optionId, handler);
  }, [runInterruptSelectWithRetry]);

  const handleResumeRetry = useCallback(async () => {
    if (!resumeRetryOptionId) return;
    await handleInterruptSelectWithRetry(resumeRetryOptionId);
  }, [resumeRetryOptionId, handleInterruptSelectWithRetry]);

  const handleResumeRetryPress = useCallback(() => {
    void handleResumeRetry();
  }, [handleResumeRetry]);

  const handleResumeError = useCallback((error: unknown) => {
    logger.logError(error, {
      component: 'Session',
      action: 'interrupt_resume',
    });

    const normalizedError = error instanceof Error ? error : new Error('Resume failed');
    if (normalizedError.message === 'INTERRUPT_EXPIRED') {
      setResumeRetryOptionId(null);
      setResumeError(errorCopy.offerExpired);
      return;
    }

    setResumeError(errorCopy.resumeFailed);
  }, []);

  return {
    cancelledMessageId,
    setCancelledMessageId,
    lastUserMessageId,
    setLastUserMessageId,
    lastUserMessageContent,
    setLastUserMessageContent,
    isInterruptedByRefresh,
    setIsInterruptedByRefresh,
    interruptedResponseMode,
    setInterruptedResponseMode,
    refreshInterruptedAt,
    setRefreshInterruptedAt,
    resumeError,
    setResumeError,
    resumeRetryOptionId,
    prepareInterruptSelectRetry,
    runInterruptSelectWithRetry,
    setInterruptSelectHandler,
    handleInterruptSelectWithRetry,
    handleResumeRetry,
    handleResumeRetryPress,
    clearResumeError,
    handleResumeError,
  };
}