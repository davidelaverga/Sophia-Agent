import { useCallback, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';

import { haptic } from '../hooks/useHaptics';
import { isError, touchSession } from '../lib/api/sessions-api';
import { debugLog } from '../lib/debug-logger';
import { recordSourceSendIntent, sourceSendIntentSchema, type SourceSendInput, type SourceSendIntent } from '../lib/memory-source-client';
import { chatSanitizer } from '../lib/sanitize';
import { useAttachmentsStore } from '../stores/attachments-store';
import { useSessionStore } from '../stores/session-store';

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
  sendMessage: (params: SourceSendInput) => Promise<void>;
  captureSourceInput: (text: string) => SourceSendInput;
  connectivityStatus: string;
  queueMessage: (message: string, sessionId: string, sourceIntent?: SourceSendIntent) => string;
  sessionId: string;
  chatMessagesLength: number;
  setChatMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  showToast: (args: { message: string; variant: 'info' | 'success' | 'error' | 'warning'; durationMs?: number; action?: { label: string; onClick: () => void } }) => void;
  voiceStatus: string;
  setVoiceStatus: (status: 'ready' | 'listening' | 'thinking' | 'speaking') => void;
  setShowScaffold: (show: boolean) => void;
  setJustSent: (value: boolean) => void;
  setDismissedError: (value: boolean) => void;
  setLastUserMessageContent: (value: string | null) => void;
  setLastUserMessageId: (value: string | null) => void;
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
    message: { text: string } | { id: string; role: 'user'; parts: Array<{ type: 'text'; text: string }> },
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
  const sourceDispatchingRef = useRef(false);
  const sendScope = JSON.stringify([chatRequestBody?.user_id, chatRequestBody?.session_id, chatRequestBody?.thread_id]);
  const liveSendScope = useRef({ scope: sendScope, generation: 0, active: true });
  if (liveSendScope.current.scope !== sendScope) liveSendScope.current = { scope: sendScope, generation: liveSendScope.current.generation + 1, active: true };
  const sendGeneration = liveSendScope.current.generation;
  useEffect(() => {
    liveSendScope.current.active = true;
    return () => { liveSendScope.current.active = false; };
  }, [sendScope]);

  const syncSessionDescriptor = useCallback(async (messageText: string) => {
    const bodySessionId = typeof chatRequestBody?.session_id === 'string' ? chatRequestBody.session_id.trim() : '';
    if (!bodySessionId) return;

    const messagePreview = messageText.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!messagePreview) return;

    useSessionStore.getState().recordOpenSessionActivity(bodySessionId, {
      messagePreview,
    });

    const bodyUserId = typeof chatRequestBody?.user_id === 'string'
      ? chatRequestBody.user_id.trim()
      : useSessionStore.getState().session?.userId?.trim() ?? '';

    if (!bodyUserId) return;

    const result = await touchSession(bodySessionId, bodyUserId, messagePreview);
    if (isError(result)) {
      debugLog('SessionSend', 'touch session failed', {
        session_id: bodySessionId,
        code: result.code,
        status: result.status,
      });
      return;
    }

    useSessionStore.getState().recordOpenSessionActivity(bodySessionId, {
      messagePreview: result.data.last_message_preview ?? messagePreview,
      title: result.data.title,
      turnCount: result.data.turn_count,
      updatedAt: result.data.updated_at,
      status: result.data.status,
      endedAt: result.data.ended_at ?? null,
    });
  }, [chatRequestBody]);

  useEffect(() => {
    chatStatusForSendRef.current = chatStatus;
  }, [chatStatus]);

  return useCallback(async (params: SourceSendInput) => {
    const normalizedText = chatSanitizer.sanitize(params.text);
    if (!normalizedText) return;

    const now = Date.now();
    const previousOutbound = lastOutboundRef.current;
    const currentStatus = chatStatusForSendRef.current;
    const streamActive = currentStatus === 'submitted' || currentStatus === 'streaming';

    if (params.sourceIntent ? sourceDispatchingRef.current || streamActive
      : shouldBlockOutboundDuplicate(previousOutbound, normalizedText, now, streamActive)) {
      if (params.sourceIntent) throw new Error('memory_source_dispatch_busy');
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
      if (params.sourceIntent) throw new Error('memory_source_session_unavailable');
      return;
    }

    if (debugEnabled) {
      debugLog('SessionPage', 'chat request body', {
        session_id: chatRequestBody?.session_id,
      });
    }

    const sourceIntent = params.sourceIntent ? sourceSendIntentSchema.parse(params.sourceIntent) : undefined;
    if (sourceIntent && (sourceIntent.owner_id !== chatRequestBody?.user_id || sourceIntent.session_id !== chatRequestBody?.session_id
      || sourceIntent.action.thread_id !== chatRequestBody?.thread_id || sourceIntent.action.content !== normalizedText)) {
      throw new Error('memory_source_action_scope_invalid');
    }
    if (sourceIntent && ['attached_files', 'attachedFiles'].some(key => chatRequestBody?.[key] !== undefined
      && (!Array.isArray(chatRequestBody[key]) || (chatRequestBody[key] as unknown[]).length > 0))) {
      throw new Error('memory_source_legacy_attachments_unavailable');
    }
    // The caller must create this at explicit send/queue time. Never manufacture
    // an action or refresh its epoch here, especially on retries.
    if (sourceIntent) sourceDispatchingRef.current = true;
    try {
      const assertScope = () => {
        if (sourceIntent && (!liveSendScope.current.active || liveSendScope.current.scope !== sendScope || liveSendScope.current.generation !== sendGeneration)) {
          throw new Error('memory_source_action_scope_changed');
        }
      };
      assertScope();
      const sourceReceipt = sourceIntent ? await recordSourceSendIntent(sourceIntent) : undefined;
      assertScope();
      const requestOptions = {
        body: { ...chatRequestBody },
      };
      // Selection is captured in the original intent, never the live composer
      // body. Absence must overwrite a previous turn's transport metadata.
      if (sourceIntent) delete requestOptions.body.memory_source_attachment_keys;

      // The installed AI SDK's {text} overload generates its own ID. Use the
      // full UI-message overload to retain the canonical source message ID.
      await sendChatMessage(sourceReceipt ? { id: sourceReceipt.message_id, role: 'user', parts: [{ type: 'text', text: normalizedText }] } : { text: normalizedText },
        sourceIntent ? { body: { ...requestOptions.body, memory_source_action: sourceIntent.action,
        } } : requestOptions);

      // Once the turn has been dispatched, the attachments belong to
      // that turn — clear them so the next turn starts with a fresh
      // chip list. Scope the clear to THIS thread only so attachments
      // the user uploaded in a different open thread aren't wiped
      // (Codex P2 PR #132). The chat-side payload already snapshotted
      // the filenames in chatRequestBody.attached_files, so clearing
      // here doesn't race with the in-flight request.
      const threadIdForClear = typeof chatRequestBody?.thread_id === 'string'
        ? chatRequestBody.thread_id
        : null;
      if (threadIdForClear && liveSendScope.current.active && liveSendScope.current.scope === sendScope && liveSendScope.current.generation === sendGeneration) {
        if (!sourceIntent) useAttachmentsStore.getState().clearForThread(threadIdForClear);
      }

      // Source intake already writes the durable transcript. Avoid the legacy
      // whole-parent touch upsert after a governed source action.
      if (!sourceIntent) await syncSessionDescriptor(normalizedText);
    } finally {
      if (sourceIntent) sourceDispatchingRef.current = false;
    }
  }, [
    chatRequestBody,
    debugEnabled,
    hasValidBackendSessionId,
    markStreamTurnStarted,
    sendChatMessage,
    sendScope,
    sendGeneration,
    syncSessionDescriptor,
    showToast,
  ]);
}

export function useSessionSendActions({
  input,
  setInput,
  isTyping,
  isReadOnly,
  sendMessage,
  captureSourceInput,
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
  setLastUserMessageId,
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
      let captured: SourceSendInput;
      try {
        captured = captureSourceInput(sanitizedInput);
      } catch {
        showToast({ message: 'Source verification is unavailable. Your draft has not been sent; please try again when verification is ready.', variant: 'warning' });
        return;
      }
      lastSubmitRef.current = { text: sanitizedInput, at: now };

      haptic('light');
      setShowScaffold(false);

      if (voiceStatus === 'listening') {
        setVoiceStatus('ready');
      }

      if (connectivityStatus === 'offline' || connectivityStatus === 'degraded') {
        let queuedId: string;
        try {
          queuedId = captured.sourceIntent ? queueMessage(sanitizedInput, captured.sourceIntent.session_id, captured.sourceIntent) : queueMessage(sanitizedInput, sessionId);
        } catch {
          showToast({ message: 'The message could not be queued. Your draft is still here.', variant: 'warning' });
          return;
        }
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
      if (captured.sourceIntent) setLastUserMessageId(captured.sourceIntent.action.message_id);
      setCancelledMessageId(null);

      messageCountBeforeSendRef.current = chatMessagesLength;
      void sendMessage(captured).catch(() => {
        showToast({ message: 'Delivery is unconfirmed. Retry the original message; it has not been treated as a new action.', variant: 'warning', durationMs: 0,
          action: { label: 'Retry original', onClick: () => {
            void sendMessage(captured).catch(() => showToast({ message: 'Delivery remains unconfirmed. The original source action is retained.', variant: 'warning' }));
          } } });
      });
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
      setLastUserMessageId,
      setCancelledMessageId,
      chatMessagesLength,
      sendMessage,
      captureSourceInput,
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
