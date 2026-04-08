import type { MutableRefObject } from 'react';

import type { UIMessage } from '../components/session';
import type { RitualArtifacts } from '../lib/session-types';
import type { FeedbackType } from '../types/sophia-ui-message';

import { useSessionCancelledRetryVoiceReplay } from './useSessionCancelledRetryVoiceReplay';
import { useSessionMemoryActions } from './useSessionMemoryActions';
import { useSessionRetryHandlers } from './useSessionRetryHandlers';
import { useSessionSendActions } from './useSessionSendActions';
import { useSessionUiCallbacks } from './useSessionUiCallbacks';

type ChatMessage = {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: Array<{
    type?: string;
    text?: string;
    [key: string]: unknown;
  }>;
};

type ToastFn = (input: {
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}) => void;

interface UseSessionInteractionOrchestrationParams {
  input: string;
  setInput: (value: string) => void;
  isTyping: boolean;
  isReadOnly: boolean;
  sendMessage: (params: { text: string }) => Promise<void>;
  connectivityStatus: string;
  queueMessage: (message: string, sessionId: string) => string;
  sessionId: string;
  chatMessagesLength: number;
  setChatMessages: (messages: ChatMessage[] | ((messages: ChatMessage[]) => ChatMessage[])) => void;
  showToast: ToastFn;
  voiceStatus: string;
  setVoiceStatus: (status: 'ready' | 'listening' | 'thinking' | 'speaking') => void;
  setShowScaffold: (show: boolean) => void;
  setJustSent: (value: boolean) => void;
  setDismissedError: (value: boolean) => void;
  setLastUserMessageContent: (value: string | null) => void;
  setCancelledMessageId: (value: string | null) => void;
  stopStreaming: () => void;
  voiceState: {
    stage: string;
    resetVoiceState: () => void;
    speakText: (text: string) => Promise<unknown>;
  };
  queueVoiceRetryFromCancel: (message?: string) => void;
  cancelledRetryMessage: string;
  lastUserMessageContent: string | null;
  isInterruptedByRefresh: boolean;
  hasValidBackendSessionId: boolean;
  backendSessionId?: string;
  refreshInterruptedAt: number | null;
  cancelledMessageId: string | null;
  lastUserMessageId: string | null;
  chatMessages: ChatMessage[];
  messageCountBeforeSendRef?: MutableRefObject<number>;
  setLastUserMessageId: (value: string | null) => void;
  setIsInterruptedByRefresh: (value: boolean) => void;
  setInterruptedResponseMode: (value: 'text' | 'voice' | null) => void;
  setRefreshInterruptedAt: (value: number | null) => void;
  setMessageTimestamp: (id: string, createdAt: string) => void;
  interruptedResponseMode: string | null;
  sessionVoiceMode?: boolean;
  latestAssistantMessage: { id: string; content: string } | null;
  setFeedback: (messageId: string, feedback: FeedbackType) => void;
  setShowFeedbackToast: (value: 'helpful' | 'not_helpful' | null) => void;
  focusComposer: () => void;
  messages: UIMessage[];
  navigateHome: () => void;
  clearSessionError: () => void;
  endSession: () => void;
  takeOverSession: () => void;
  artifacts: RitualArtifacts | null;
  applyMemoryCandidates: (nextCandidates: RitualArtifacts['memory_candidates']) => void;
  isOffline: boolean;
  queueMemoryApproval: (
    memory: string,
    sessionId: string,
    category?: RitualArtifacts['memory_candidates'][number]['category']
  ) => void;
  backendSessionIdForMemory?: string;
}

export function useSessionInteractionOrchestration({
  input,
  setInput,
  isTyping,
  isReadOnly,
  sendMessage,
  connectivityStatus,
  queueMessage,
  sessionId,
  chatMessagesLength,
  setChatMessages,
  showToast,
  voiceStatus,
  setVoiceStatus,
  setShowScaffold,
  setJustSent,
  setDismissedError,
  setLastUserMessageContent,
  setCancelledMessageId,
  stopStreaming,
  voiceState,
  queueVoiceRetryFromCancel,
  cancelledRetryMessage,
  lastUserMessageContent,
  isInterruptedByRefresh,
  hasValidBackendSessionId,
  backendSessionId,
  refreshInterruptedAt,
  cancelledMessageId,
  lastUserMessageId,
  chatMessages,
  setLastUserMessageId,
  setIsInterruptedByRefresh,
  setInterruptedResponseMode,
  setRefreshInterruptedAt,
  setMessageTimestamp,
  interruptedResponseMode,
  sessionVoiceMode,
  latestAssistantMessage,
  setFeedback,
  setShowFeedbackToast,
  focusComposer,
  messages,
  navigateHome,
  clearSessionError,
  endSession,
  takeOverSession,
  artifacts,
  applyMemoryCandidates,
  isOffline,
  queueMemoryApproval,
  backendSessionIdForMemory,
}: UseSessionInteractionOrchestrationParams) {
  const {
    messageCountBeforeSendRef,
    handleSubmit,
    handleCancelThinking,
  } = useSessionSendActions({
    input,
    setInput,
    isTyping,
    isReadOnly,
    sendMessage,
    connectivityStatus,
    queueMessage,
    sessionId,
    chatMessagesLength,
    setChatMessages,
    showToast,
    voiceStatus,
    setVoiceStatus,
    setShowScaffold,
    setJustSent,
    setDismissedError,
    setLastUserMessageContent,
    setCancelledMessageId,
    stopStreaming,
    voiceState,
    queueVoiceRetryFromCancel,
    cancelledRetryMessage,
  });

  const {
    handleRetry,
    handleDismissCancelled,
  } = useSessionRetryHandlers({
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
  });

  const {
    handleCancelledRetryPress,
  } = useSessionCancelledRetryVoiceReplay({
    interruptedResponseMode,
    sessionVoiceMode,
    latestAssistantMessage,
    isTyping,
    handleRetry,
    speakText: voiceState.speakText,
  });

  const {
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
  } = useSessionUiCallbacks({
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
  });

  const {
    handleMemoryApprove,
    handleMemoryReject,
  } = useSessionMemoryActions({
    artifacts,
    applyMemoryCandidates,
    showToast,
    isOffline,
    queueMemoryApproval,
    sessionId,
    backendSessionId: backendSessionIdForMemory,
  });

  return {
    handleSubmit,
    handleCancelThinking,
    handleRetry,
    handleDismissCancelled,
    handleCancelledRetryPress,
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
    handleMemoryApprove,
    handleMemoryReject,
  };
}