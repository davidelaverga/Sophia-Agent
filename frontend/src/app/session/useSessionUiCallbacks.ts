import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { UIMessage } from '../components/session';
import { haptic } from '../hooks/useHaptics';
import type { SourceSendInput } from '../lib/memory-source-client';
import type { FeedbackType } from '../types/sophia-ui-message';

interface UseSessionUiCallbacksParams {
  setFeedback: (messageId: string, feedback: FeedbackType) => void;
  setShowFeedbackToast: Dispatch<SetStateAction<'helpful' | 'not_helpful' | null>>;
  setDismissedError: Dispatch<SetStateAction<boolean>>;
  setInput: Dispatch<SetStateAction<string>>;
  focusComposer: () => void;
  messages: UIMessage[];
  sendMessage: (payload: SourceSendInput) => void | Promise<void>;
  retrySourceInput: (text: string, messageId: string | null) => SourceSendInput;
  showToast: (args: { message: string; variant: 'error' }) => void;
  navigateHome: () => void;
  clearSessionError: () => void;
  endSession: () => void;
  takeOverSession: () => void;
}

export function useSessionUiCallbacks({
  setFeedback,
  setShowFeedbackToast,
  setDismissedError,
  setInput,
  focusComposer,
  messages,
  sendMessage,
  retrySourceInput,
  showToast,
  navigateHome,
  clearSessionError,
  endSession,
  takeOverSession,
}: UseSessionUiCallbacksParams) {
  const handlePromptSelect = useCallback((prompt: string) => {
    setInput(prompt);
    focusComposer();
    haptic('light');
  }, [focusComposer, setInput]);

  const handleMessageFeedback = useCallback((messageId: string, feedback: FeedbackType) => {
    setFeedback(messageId, feedback);
    if (feedback === 'helpful' || feedback === 'not_helpful') {
      setShowFeedbackToast(feedback);
      setTimeout(() => setShowFeedbackToast(null), 3000);
    }
  }, [setFeedback, setShowFeedbackToast]);

  const handleStreamErrorRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUserMsg) {
      let original: SourceSendInput;
      try { original = retrySourceInput(lastUserMsg.content, lastUserMsg.id); }
      catch { showToast({ message: 'The original source action is unavailable. No replacement action was created or sent.', variant: 'error' }); return; }
      setDismissedError(true);
      void Promise.resolve(sendMessage(original)).catch(() => setDismissedError(false));
    }
  }, [messages, sendMessage, retrySourceInput, setDismissedError, showToast]);

  const handleDismissStreamError = useCallback(() => {
    setDismissedError(true);
  }, [setDismissedError]);

  const handleGoToDashboard = useCallback(() => {
    navigateHome();
  }, [navigateHome]);

  const handleFeedbackToastClose = useCallback(() => {
    setShowFeedbackToast(null);
  }, [setShowFeedbackToast]);

  const handleSessionExpiredRetry = useCallback(() => {
    clearSessionError();
    endSession();
    navigateHome();
  }, [clearSessionError, endSession, navigateHome]);

  const handleSessionExpiredGoHome = useCallback(() => {
    clearSessionError();
    endSession();
    navigateHome();
  }, [clearSessionError, endSession, navigateHome]);

  const handleMultiTabGoHome = useCallback(() => {
    clearSessionError();
    navigateHome();
  }, [clearSessionError, navigateHome]);

  const handleMultiTabTakeOver = useCallback(() => {
    takeOverSession();
  }, [takeOverSession]);

  return {
    handlePromptSelect,
    handleMessageFeedback,
    handleStreamErrorRetry,
    handleDismissStreamError,
    handleGoToDashboard,
    handleFeedbackToastClose,
    handleSessionExpiredRetry,
    handleSessionExpiredGoHome,
    handleMultiTabGoHome,
    handleMultiTabTakeOver,
  };
}
