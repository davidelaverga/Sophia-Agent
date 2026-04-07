import { useCallback, useEffect, useState } from 'react';

type RetryResult =
  | { kind: 'recovered'; response: string }
  | { kind: 'resent' }
  | { kind: string; response?: string };

interface AssistantMessageBaseline {
  id: string;
  content: string;
}

interface UseSessionCancelledRetryVoiceReplayParams {
  interruptedResponseMode?: string | null;
  sessionVoiceMode?: boolean;
  latestAssistantMessage: { id: string; content: string } | null;
  isTyping: boolean;
  handleRetry: () => Promise<RetryResult>;
  speakText: (text: string) => Promise<unknown>;
}

export function useSessionCancelledRetryVoiceReplay({
  interruptedResponseMode,
  sessionVoiceMode,
  latestAssistantMessage,
  isTyping,
  handleRetry,
  speakText,
}: UseSessionCancelledRetryVoiceReplayParams) {
  const [pendingRefreshRetryVoiceBaseline, setPendingRefreshRetryVoiceBaseline] = useState<AssistantMessageBaseline | null>(null);

  const handleCancelledRetry = useCallback(async () => {
    const shouldSpeakRetryAsVoice = interruptedResponseMode === 'voice' || Boolean(sessionVoiceMode);
    const previousAssistantBaseline = {
      id: latestAssistantMessage?.id ?? '',
      content: latestAssistantMessage?.content ?? '',
    };

    let result: RetryResult;
    try {
      result = await handleRetry();
    } catch {
      return;
    }

    if (!shouldSpeakRetryAsVoice) return;

    if (result.kind === 'recovered') {
      if ((result.response || '').trim()) {
        void speakText(result.response || '');
      }
      return;
    }

    if (result.kind === 'resent') {
      setPendingRefreshRetryVoiceBaseline(previousAssistantBaseline);
    }
  }, [
    interruptedResponseMode,
    sessionVoiceMode,
    latestAssistantMessage,
    handleRetry,
    speakText,
  ]);

  const handleCancelledRetryPress = useCallback(() => {
    void handleCancelledRetry();
  }, [handleCancelledRetry]);

  useEffect(() => {
    if (!(interruptedResponseMode === 'voice' || sessionVoiceMode)) return;
    if (!pendingRefreshRetryVoiceBaseline) return;
    if (isTyping) return;
    if (!latestAssistantMessage?.content.trim()) return;

    const assistantUnchanged =
      latestAssistantMessage.id === pendingRefreshRetryVoiceBaseline.id &&
      latestAssistantMessage.content === pendingRefreshRetryVoiceBaseline.content;

    if (assistantUnchanged) {
      return;
    }

    setPendingRefreshRetryVoiceBaseline(null);
    void speakText(latestAssistantMessage.content);
  }, [
    interruptedResponseMode,
    sessionVoiceMode,
    pendingRefreshRetryVoiceBaseline,
    isTyping,
    latestAssistantMessage,
    speakText,
  ]);

  return {
    handleCancelledRetry,
    handleCancelledRetryPress,
  };
}
