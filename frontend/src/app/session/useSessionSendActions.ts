import { useCallback, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';

import { haptic } from '../hooks/useHaptics';
import { debugLog } from '../lib/debug-logger';
import { chatSanitizer } from '../lib/sanitize';

import { shouldBlockOutboundDuplicate, shouldBlockSubmitDuplicate } from './send-gate';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
};

interface UseSessionSendActionsParams {
  input: string;
  setInput: (value: string) => void;
  isTyping: boolean;
  isReadOnly: boolean;
  sendMessage: (params: { text: string }) => Promise<void>;
  connectivityStatus: string;
  queueMessage: (message: string, sessionId: string) => string;
  sessionId: string;
  chatMessagesLength: number;
  setChatMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  showToast: (args: { message: string; variant: 'info' | 'success' | 'error' | 'warning'; durationMs?: number }) => void;
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
  };
  queueVoiceRetryFromCancel: (message?: string) => void;
  cancelledRetryMessage: string;
}

interface UseSessionOutboundSendParams {
  chatStatus: 'submitted' | 'streaming' | 'ready' | 'error';
  sendChatMessage: (
    message: { text: string },
    options?: { body?: Record<string, unknown> },
  ) => Promise<void>;
  hasValidBackendSessionId: boolean;
  chatRequestBody?: Record<string, unknown>;
  debugEnabled: boolean;
  markStreamTurnStarted: (startedAtMs: number) => void;
  showToast: (args: { message: string; variant: 'info' | 'success' | 'error' | 'warning'; durationMs?: number }) => void;
}

export function useSessionOutboundSend({
  chatStatus,
  sendChatMessage,
  hasValidBackendSessionId,
  chatRequestBody,
  debugEnabled,
  markStreamTurnStarted,
  showToast,
}: UseSessionOutboundSendParams) {
  const chatStatusForSendRef = useRef(chatStatus);
  const lastOutboundRef = useRef<{ text: string; at: number } | null>(null);

  useEffect(() => {
    chatStatusForSendRef.current = chatStatus;
  }, [chatStatus]);

  return useCallback(async (params: { text: string }) => {
    const normalizedText = chatSanitizer.sanitize(params.text);
    if (!normalizedText) return;

    const now = Date.now();
    const previousOutbound = lastOutboundRef.current;
    const currentStatus = chatStatusForSendRef.current;
    const streamActive = currentStatus === 'submitted' || currentStatus === 'streaming';

    if (shouldBlockOutboundDuplicate(previousOutbound, normalizedText, now, streamActive)) {
      return;
    }

    lastOutboundRef.current = { text: normalizedText, at: now };
    markStreamTurnStarted(now);

    if (!hasValidBackendSessionId) {
      showToast({
        message: 'Session is still initializing. Please start a session and try again.',
        variant: 'warning',
        durationMs: 3000,
      });
      return;
    }

    if (debugEnabled) {
      debugLog('SessionPage', 'chat request body', {
        session_id: chatRequestBody?.session_id,
      });
    }

    const requestOptions = chatRequestBody
      ? {
          body: chatRequestBody,
        }
      : undefined;

    await sendChatMessage({ text: normalizedText }, requestOptions);
  }, [
    chatRequestBody,
    debugEnabled,
    hasValidBackendSessionId,
    markStreamTurnStarted,
    sendChatMessage,
    showToast,
  ]);
}

export function useSessionSendActions({
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
}: UseSessionSendActionsParams) {
  const messageCountBeforeSendRef = useRef<number>(0);
  const lastSubmitRef = useRef<{ text: string; at: number } | null>(null);

  const handleSubmit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (isReadOnly) return;

      const sanitizedInput = chatSanitizer.sanitize(input);
      if (!sanitizedInput || isTyping) return;

      const now = Date.now();
      const previousSubmit = lastSubmitRef.current;
      if (shouldBlockSubmitDuplicate(previousSubmit, sanitizedInput, now)) {
        return;
      }
      lastSubmitRef.current = { text: sanitizedInput, at: now };

      haptic('light');
      setShowScaffold(false);

      if (voiceStatus === 'listening') {
        setVoiceStatus('ready');
      }

      if (connectivityStatus === 'offline' || connectivityStatus === 'degraded') {
        const queuedId = queueMessage(sanitizedInput, sessionId);
        const queuedMessage: ChatMessage = {
          id: `queued-${queuedId}`,
          role: 'user',
          parts: [{ type: 'text', text: sanitizedInput }],
        };

        setChatMessages((prev) => [...prev, queuedMessage]);
        setInput('');

        showToast({
          message: "I'm offline right now, so I saved your message and I'll send it automatically when we're back online.",
          variant: 'info',
          durationMs: 3600,
        });
        return;
      }

      setDismissedError(false);
      setJustSent(true);
      setTimeout(() => setJustSent(false), 600);

      setLastUserMessageContent(sanitizedInput);
      setCancelledMessageId(null);

      messageCountBeforeSendRef.current = chatMessagesLength;
      void sendMessage({ text: sanitizedInput });
      setInput('');
    },
    [
      isReadOnly,
      input,
      isTyping,
      setShowScaffold,
      voiceStatus,
      setVoiceStatus,
      connectivityStatus,
      queueMessage,
      sessionId,
      setChatMessages,
      setInput,
      showToast,
      setDismissedError,
      setJustSent,
      setLastUserMessageContent,
      setCancelledMessageId,
      chatMessagesLength,
      sendMessage,
    ],
  );

  const handleCancelStream = useCallback(() => {
    stopStreaming();
    setCancelledMessageId('cancelled');
  }, [stopStreaming, setCancelledMessageId]);

  const handleCancelThinking = useCallback(() => {
    if (isTyping) {
      handleCancelStream();
      return;
    }

    if (voiceState.stage === 'thinking') {
      queueVoiceRetryFromCancel(cancelledRetryMessage);
      voiceState.resetVoiceState();
    }
  }, [
    isTyping,
    handleCancelStream,
    voiceState,
    queueVoiceRetryFromCancel,
    cancelledRetryMessage,
  ]);

  return {
    messageCountBeforeSendRef,
    handleSubmit,
    handleCancelStream,
    handleCancelThinking,
  };
}
