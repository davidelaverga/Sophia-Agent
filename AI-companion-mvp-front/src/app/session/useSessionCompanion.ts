import { useCallback, useEffect, useState } from 'react';
import { haptic } from '../hooks/useHaptics';
import { useCompanionInvoke } from '../hooks/useCompanionInvoke';
import { useMicroBriefing } from '../hooks/useMicroBriefing';
import type { UIMessage, NudgeSuggestion } from '../components/session';
import type { ContextMode, PresetType, InvokeType } from '../types/session';
import type { StreamArtifactsPayload } from './stream-contract-adapters';

interface UseSessionCompanionParams {
  sessionThreadId?: string;
  sessionContextMode?: ContextMode;
  sessionPresetType?: PresetType;
  chatMessageCount: number;
  messages: UIMessage[];
  isTyping: boolean;
  isReadOnly: boolean;
  appendAssistantMessage: (text: string) => void;
  onArtifacts: (artifacts: StreamArtifactsPayload) => void;
  onInvokeError: () => void;
}

export function useSessionCompanion({
  sessionThreadId,
  sessionContextMode,
  sessionPresetType,
  chatMessageCount,
  messages,
  isTyping,
  isReadOnly,
  appendAssistantMessage,
  onArtifacts,
  onInvokeError,
}: UseSessionCompanionParams) {
  const [activeInvoke, setActiveInvoke] = useState<InvokeType | null>(null);
  const [nudgeSuggestion, setNudgeSuggestion] = useState<NudgeSuggestion | null>(null);

  const { resetTimer: resetNudgeTimer } = useMicroBriefing({
    presetContext: sessionContextMode || 'life',
    sessionType: sessionPresetType,
    autoNudgeIntervalMinutes: 15,
    onNudge: (result) => {
      setNudgeSuggestion({
        id: result.messageId,
        message: result.text,
        actionType: 'quick_question',
        priority: 'low',
        timestamp: new Date().toISOString(),
        reason: result.hasMemory ? 'Based on your recent context' : undefined,
      });
    },
  });

  useEffect(() => {
    if (chatMessageCount > 0) {
      resetNudgeTimer();
    }
  }, [chatMessageCount, resetNudgeTimer]);

  const { invoke: invokeCompanion, isLoading: isInvoking } = useCompanionInvoke({
    threadId: sessionThreadId,
    onSuccess: (response) => {
      const messageText = response.assistant_message || response.response || '';
      appendAssistantMessage(messageText);
      setActiveInvoke(null);

      if (response.artifacts && Object.keys(response.artifacts).length > 0) {
        onArtifacts(response.artifacts);
      }
    },
    onError: () => {
      setActiveInvoke(null);
      onInvokeError();
    },
  });

  const handleCompanionInvoke = useCallback(
    async (invokeType: InvokeType) => {
      if (isInvoking || isTyping || isReadOnly) return;

      setActiveInvoke(invokeType);
      haptic('medium');

      const recentMessages = messages.slice(-4);
      let transcript = recentMessages.map((message) => `${message.role}: ${message.content}`).join('\n');

      if (transcript.length > 900) {
        transcript = transcript.slice(-900);
      }

      await invokeCompanion(invokeType, transcript);
    },
    [isInvoking, isTyping, isReadOnly, messages, invokeCompanion],
  );

  const handleNudgeAccept = useCallback(
    (actionType: InvokeType) => {
      setNudgeSuggestion(null);
      handleCompanionInvoke(actionType);
    },
    [handleCompanionInvoke],
  );

  const handleNudgeDismiss = useCallback(() => {
    setNudgeSuggestion(null);
  }, []);

  return {
    activeInvoke,
    nudgeSuggestion,
    isInvoking,
    handleCompanionInvoke,
    handleNudgeAccept,
    handleNudgeDismiss,
  };
}
