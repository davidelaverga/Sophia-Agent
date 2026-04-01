import { useCallback } from 'react';
import type { FeedbackType } from '../types/sophia-ui-message';
import type { UIMessage } from '../components/session';
import type { Dispatch, SetStateAction } from 'react';
import { haptic } from '../hooks/useHaptics';

interface UseSessionUiCallbacksParams {
  setFeedback: (messageId: string, feedback: FeedbackType) => void;
  setShowFeedbackToast: Dispatch<SetStateAction<'helpful' | 'not_helpful' | null>>;
  setDismissedError: Dispatch<SetStateAction<boolean>>;
  setInput: Dispatch<SetStateAction<string>>;
  focusComposer: () => void;
  messages: UIMessage[];
  sendMessage: (payload: { text: string }) => void | Promise<void>;
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
    setDismissedError(true);
    const lastUserMsg = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUserMsg) {
      sendMessage({ text: lastUserMsg.content });
    }
  }, [messages, sendMessage, setDismissedError]);

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
