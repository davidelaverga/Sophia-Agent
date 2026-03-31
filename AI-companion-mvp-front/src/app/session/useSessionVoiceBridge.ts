import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceLoop } from '../hooks/useVoiceLoop';
import { useStreamVoiceSession } from '../hooks/useStreamVoiceSession';
import { STREAM_VOICE_ENABLED } from '../stores/voice-store';
import type { StreamArtifactsPayload } from './stream-contract-adapters';

type VoiceRetryState = { transcript: string; message: string } | null;
const DEFAULT_VOICE_CANCEL_RETRY_MESSAGE = 'Voice response cancelled. Retry?';

type UseSessionVoiceBridgeOptions = {
  userId?: string;
  sessionId?: string;
  onUserTranscriptFallback: (text: string) => void;
  appendAssistantMessage: (text: string, suppressAssistantResponse: boolean) => void;
  ingestArtifacts: (artifacts: StreamArtifactsPayload, source: 'voice' | 'interrupt') => void;
  onRateLimitError: (payload: {
    message: string;
    remaining?: number;
    estimatedSeconds?: number;
  }) => void;
  sendMessage: (params: { text: string }) => Promise<void>;
  latestAssistantMessage: { id: string; content: string } | null;
  isTyping: boolean;
};

export function useSessionVoiceBridge({
  userId,
  sessionId,
  onUserTranscriptFallback,
  appendAssistantMessage,
  ingestArtifacts,
  onRateLimitError,
  sendMessage,
  latestAssistantMessage,
  isTyping,
}: UseSessionVoiceBridgeOptions) {
  const [lastVoiceTranscript, setLastVoiceTranscript] = useState<string | null>(null);
  const [voiceRetryState, setVoiceRetryState] = useState<VoiceRetryState>(null);
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

  const handleVoiceArtifacts = useCallback((artifacts: StreamArtifactsPayload) => {
    ingestArtifacts(artifacts, 'voice');
  }, [ingestArtifacts]);

  const voiceStateLegacy = useVoiceLoop(undefined, {
    sessionId,
    onUserTranscript: handleUserTranscript,
    onAssistantResponse: handleAssistantResponse,
    onArtifacts: handleVoiceArtifacts,
    onRateLimitError,
  });

  // Both hooks called unconditionally (React rules). Feature flag selects.
  const voiceStateStream = useStreamVoiceSession(userId, {
    sessionId,
    onUserTranscript: handleUserTranscript,
    onAssistantResponse: handleAssistantResponse,
    onArtifacts: handleVoiceArtifacts,
  });

  const voiceState = STREAM_VOICE_ENABLED ? voiceStateStream : voiceStateLegacy;

  useEffect(() => {
    if (!voiceState.error) return;
    if (!lastVoiceTranscript && !voiceState.hasRetryableVoiceTurn()) return;

    setVoiceRetryState((prev) => {
      const transcript = lastVoiceTranscript || '';
      if (prev && prev.transcript === transcript && prev.message === voiceState.error) {
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
    if (!latestAssistantMessage || !latestAssistantMessage.content.trim()) return;
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
      if (prev && prev.transcript === transcript && prev.message === (message || DEFAULT_VOICE_CANCEL_RETRY_MESSAGE)) {
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
