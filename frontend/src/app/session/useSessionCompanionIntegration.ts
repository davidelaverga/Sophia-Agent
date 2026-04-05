import { useCallback } from 'react';
import type React from 'react';
import type { UIMessage } from '../components/session';
import type { ContextMode, PresetType } from '../types/session';
import { useUiStore as useUiToastStore } from '../stores/ui-store';
import { useSessionCompanion } from './useSessionCompanion';
import type { StreamArtifactsPayload } from './stream-contract-adapters';

type ChatMessagePart = {
  type?: string;
  text?: string;
};

type ChatMessageLike = {
  id: string;
  role?: string;
  parts?: ChatMessagePart[];
};

interface UseSessionCompanionIntegrationParams {
  sessionThreadId?: string;
  sessionContextMode?: ContextMode;
  sessionPresetType?: PresetType;
  chatMessageCount: number;
  messages: UIMessage[];
  isTyping: boolean;
  isReadOnly: boolean;
  setMessageTimestamp: (id: string, createdAt: string) => void;
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessageLike[]>>;
  ingestArtifacts: (rawArtifacts: StreamArtifactsPayload, source: 'companion' | 'voice' | 'interrupt') => void;
}

export function useSessionCompanionIntegration({
  sessionThreadId,
  sessionContextMode,
  sessionPresetType,
  chatMessageCount,
  messages,
  isTyping,
  isReadOnly,
  setMessageTimestamp,
  setChatMessages,
  ingestArtifacts,
}: UseSessionCompanionIntegrationParams) {
  const appendCompanionAssistantMessage = useCallback((messageText: string) => {
    const newId = `companion-${Date.now()}`;
    setMessageTimestamp(newId, new Date().toISOString());
    setChatMessages((prev) => [
      ...prev,
      {
        id: newId,
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: messageText }],
      },
    ]);
  }, [setChatMessages, setMessageTimestamp]);

  const handleCompanionArtifacts = useCallback((rawArtifacts: StreamArtifactsPayload) => {
    ingestArtifacts(rawArtifacts, 'companion');
  }, [ingestArtifacts]);

  const handleCompanionInvokeError = useCallback(() => {
    useUiToastStore.getState().showToast({
      message: 'Could not complete action. Try again.',
      variant: 'error',
      durationMs: 3000,
    });
  }, []);

  return useSessionCompanion({
    sessionThreadId,
    sessionContextMode,
    sessionPresetType,
    chatMessageCount,
    messages,
    isTyping,
    isReadOnly,
    appendAssistantMessage: appendCompanionAssistantMessage,
    onArtifacts: handleCompanionArtifacts,
    onInvokeError: handleCompanionInvokeError,
  });
}