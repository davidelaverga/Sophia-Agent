import { useEffect } from 'react';
import type { StreamArtifactsPayload } from './stream-contract-adapters';
import { useSessionVoiceMessages } from './useSessionVoiceMessages';
import { useSessionVoiceBridge } from './useSessionVoiceBridge';
import { useSessionVoiceUiControls } from './useSessionVoiceUiControls';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
};

type UseSessionVoiceOrchestrationParams = {
  userId?: string;
  hasValidBackendSessionId: boolean;
  backendSessionId?: string;
  setChatMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  setMessageTimestamp: (id: string, createdAt: string) => void;
  ingestArtifacts: (artifacts: StreamArtifactsPayload, source: 'voice' | 'interrupt') => void;
  sendMessage: (params: { text: string }) => Promise<void>;
  latestAssistantMessage: { id: string; content: string } | null;
  isTyping: boolean;
};

export function useSessionVoiceOrchestration({
  userId,
  hasValidBackendSessionId,
  backendSessionId,
  setChatMessages,
  setMessageTimestamp,
  ingestArtifacts,
  sendMessage,
  latestAssistantMessage,
  isTyping,
}: UseSessionVoiceOrchestrationParams) {
  const {
    appendVoiceUserMessage,
    appendVoiceAssistantMessage,
  } = useSessionVoiceMessages({
    setChatMessages,
    setMessageTimestamp,
  });

  const {
    voiceState,
    voiceStatus,
    isReflectionTtsActive,
    setOnUserTranscriptHandler,
    setAssistantResponseSuppressedChecker,
    voiceRetryState,
    handleVoiceRetryPress,
    handleDismissVoiceRetry,
    queueVoiceRetryFromCancel,
  } = useSessionVoiceBridge({
    userId,
    sessionId: hasValidBackendSessionId ? backendSessionId : undefined,
    onUserTranscriptFallback: appendVoiceUserMessage,
    appendAssistantMessage: appendVoiceAssistantMessage,
    ingestArtifacts,
    onRateLimitError: () => undefined,
    sendMessage,
    latestAssistantMessage,
    isTyping,
  });

  const {
    baseHandleMicClick,
    setVoiceStatusCompat,
  } = useSessionVoiceUiControls({
    voiceState,
  });

  useEffect(() => {
    setOnUserTranscriptHandler(appendVoiceUserMessage);
    setAssistantResponseSuppressedChecker(() => false);
  }, [
    appendVoiceUserMessage,
    setAssistantResponseSuppressedChecker,
    setOnUserTranscriptHandler,
  ]);

  return {
    voiceState,
    voiceStatus,
    isReflectionTtsActive,
    appendVoiceUserMessage,
    setOnUserTranscriptHandler,
    setAssistantResponseSuppressedChecker,
    voiceRetryState,
    handleVoiceRetryPress,
    handleDismissVoiceRetry,
    queueVoiceRetryFromCancel,
    baseHandleMicClick,
    setVoiceStatusCompat,
  };
}