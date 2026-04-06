import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useStreamVoiceSession } from '../hooks/useStreamVoiceSession';

import type { UseCompanionVoiceRuntimeOptions, CompanionVoiceRetryState } from './types';

const DEFAULT_VOICE_CANCEL_RETRY_MESSAGE = 'Voice response cancelled. Retry?';

export function useCompanionVoiceRuntime({
  userId,
  sessionId,
  onUserTranscriptFallback,
  appendAssistantMessage,
  ingestArtifacts,
  onRateLimitError: _onRateLimitError,
  sendMessage,
  latestAssistantMessage,
  isTyping,
}: UseCompanionVoiceRuntimeOptions) {
  const [lastVoiceTranscript, setLastVoiceTranscript] = useState<string | null>(null);
  const [voiceRetryState, setVoiceRetryState] = useState<CompanionVoiceRetryState>(null);
  const [pendingVoiceRetryPlayback, setPendingVoiceRetryPlayback] = useState(false);
  const consumedRetryAssistantIdRef = useRef<string | null>(null);
  const onUserTranscriptHandlerRef = useRef<(text: string) => void>(onUserTranscriptFallback);
  const appendAssistantMessageRef = useRef(appendAssistantMessage);
  const isAssistantResponseSuppressedRef = useRef<() => boolean>(() => false);

  useEffect(() => {
    onUserTranscriptHandlerRef.current = onUserTranscriptFallback;
  }, [onUserTranscriptFallback]);

  useEffect(() => {
    appendAssistantMessageRef.current = appendAssistantMessage;
  }, [appendAssistantMessage]);

  const setOnUserTranscriptHandler = useCallback((handler: (text: string) => void) => {
    onUserTranscriptHandlerRef.current = handler;
  }, []);

  const setAssistantResponseSuppressedChecker = useCallback((checker: () => boolean) => {
    isAssistantResponseSuppressedRef.current = checker;
  }, []);

  const handleUserTranscript = useCallback((text: string) => {
    const normalized = text.trim();
    if (!normalized) return;

    setLastVoiceTranscript(normalized);
    onUserTranscriptHandlerRef.current(normalized);
  }, []);

  const handleAssistantResponse = useCallback((text: string) => {
    setVoiceRetryState(null);
    appendAssistantMessageRef.current(text, isAssistantResponseSuppressedRef.current());
  }, []);

  const handleVoiceArtifacts = useCallback((artifacts: Parameters<UseCompanionVoiceRuntimeOptions['ingestArtifacts']>[0]) => {
    ingestArtifacts(artifacts, 'voice');
  }, [ingestArtifacts]);

  const voiceState = useStreamVoiceSession(userId, {
    sessionId,
    onUserTranscript: handleUserTranscript,
    onAssistantResponse: handleAssistantResponse,
    onArtifacts: handleVoiceArtifacts,
  });

  useEffect(() => {
    if (!voiceState.error) return;
    if (!lastVoiceTranscript && !voiceState.hasRetryableVoiceTurn()) return;

    setVoiceRetryState((prev) => {
      const transcript = lastVoiceTranscript || '';
      if (prev?.transcript === transcript && prev.message === voiceState.error) {
        return prev;
      }

      return {
        transcript,
        message: voiceState.error,
      };
    });
  }, [voiceState, lastVoiceTranscript]);

  useEffect(() => {
    if (!pendingVoiceRetryPlayback) return;
    if (isTyping) return;
    if (!latestAssistantMessage?.content.trim()) return;
    if (consumedRetryAssistantIdRef.current === latestAssistantMessage.id) return;

    consumedRetryAssistantIdRef.current = latestAssistantMessage.id;
    setPendingVoiceRetryPlayback(false);

    void voiceState.speakText(latestAssistantMessage.content).then((spoken) => {
      if (!spoken) {
        setVoiceRetryState((prev) => {
          if (prev) return prev;
          return {
            transcript: lastVoiceTranscript || '',
            message: 'Retry sent, but voice playback failed. Retry again?',
          };
        });
      }
    });
  }, [pendingVoiceRetryPlayback, isTyping, latestAssistantMessage, voiceState, lastVoiceTranscript]);

  const handleVoiceRetry = useCallback(async () => {
    consumedRetryAssistantIdRef.current = null;
    setVoiceRetryState(null);

    const retriedAsVoice = await voiceState.retryLastVoiceTurn();
    if (retriedAsVoice) {
      setPendingVoiceRetryPlayback(false);
      return;
    }

    if (!voiceRetryState?.transcript) return;

    setPendingVoiceRetryPlayback(true);
    await sendMessage({ text: voiceRetryState.transcript });
  }, [voiceRetryState, sendMessage, voiceState]);

  const handleVoiceRetryPress = useCallback(() => {
    void handleVoiceRetry();
  }, [handleVoiceRetry]);

  const handleDismissVoiceRetry = useCallback(() => {
    setPendingVoiceRetryPlayback(false);
    setVoiceRetryState(null);
  }, []);

  const queueVoiceRetryFromCancel = useCallback((message?: string) => {
    const canRetryFromAudio = voiceState.hasRetryableVoiceTurn();
    if (!lastVoiceTranscript && !canRetryFromAudio) return false;

    setPendingVoiceRetryPlayback(false);
    setVoiceRetryState((prev) => {
      const transcript = lastVoiceTranscript || '';
      if (prev?.transcript === transcript && prev.message === (message || DEFAULT_VOICE_CANCEL_RETRY_MESSAGE)) {
        return prev;
      }

      return {
        transcript,
        message: message || DEFAULT_VOICE_CANCEL_RETRY_MESSAGE,
      };
    });

    return true;
  }, [lastVoiceTranscript, voiceState]);

  const voiceStatus = useMemo<'ready' | 'listening' | 'thinking' | 'speaking'>(() => {
    if (voiceState.stage === 'listening') return 'listening';
    if (voiceState.stage === 'speaking') return 'speaking';
    if (voiceState.stage === 'thinking' || voiceState.stage === 'connecting') return 'thinking';
    return 'ready';
  }, [voiceState.stage]);

  return {
    voiceState,
    voiceStatus,
    isReflectionTtsActive: voiceState.isReflectionTtsActive,
    setOnUserTranscriptHandler,
    setAssistantResponseSuppressedChecker,
    voiceRetryState,
    handleVoiceRetry,
    handleVoiceRetryPress,
    handleDismissVoiceRetry,
    queueVoiceRetryFromCancel,
  };
}