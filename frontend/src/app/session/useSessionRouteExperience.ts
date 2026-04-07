import { useCallback, useEffect, useRef } from 'react';

import { useCompanionArtifactsRuntime } from '../companion-runtime/artifacts-runtime';
import { useCompanionChatRuntime } from '../companion-runtime/chat-runtime';
import { getCompanionRouteProfile } from '../companion-runtime/route-profiles';
import { useCompanionStreamContract } from '../companion-runtime/stream-contract';
import { useCompanionVoiceRuntime } from '../companion-runtime/voice-runtime';
import { debugLog } from '../lib/debug-logger';
import type { InterruptPayload, RitualArtifacts } from '../types/session';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';

import { useSessionMessageViewModel } from './useSessionMessageViewModel';
import { useSessionOutboundSend } from './useSessionSendActions';
import { useSessionVoiceMessages } from './useSessionVoiceMessages';
import { useSessionVoiceUiControls } from './useSessionVoiceUiControls';

type ToastVariant = 'info' | 'success' | 'error' | 'warning';

type ShowToastFn = (args: {
  message: string;
  variant: ToastVariant;
  durationMs?: number;
}) => void;

type UseSessionRouteExperienceParams = {
  sessionId: string;
  activeSessionId?: string;
  activeThreadId?: string;
  chatRequestBody?: Record<string, unknown>;
  hasValidBackendSessionId: boolean;
  backendSessionId?: string;
  userId?: string;
  artifacts: RitualArtifacts | null;
  storeArtifacts: (artifacts: RitualArtifacts, summary?: string) => void;
  updateSession: (updates: { artifacts?: RitualArtifacts; summary?: string }) => void;
  showUsageLimitModal: (info: unknown) => void;
  recordConnectivityFailure: () => void;
  showToast: ShowToastFn;
  setCurrentContext: (threadId: string, sessionId: string, runId?: string) => void;
  setMessageMetadata: (messageId: string, metadata: Partial<SophiaMessageMetadata>) => void;
  greetingAnchorId: string | null;
  markOffline: () => void;
  debugEnabled?: boolean;
  memoryHighlightsCount?: number;
};

export function useSessionRouteExperience({
  sessionId,
  activeSessionId,
  activeThreadId,
  chatRequestBody,
  hasValidBackendSessionId,
  backendSessionId,
  userId,
  artifacts,
  storeArtifacts,
  updateSession,
  showUsageLimitModal,
  recordConnectivityFailure,
  showToast,
  setCurrentContext,
  setMessageMetadata,
  greetingAnchorId,
  markOffline,
  debugEnabled = false,
  memoryHighlightsCount = 0,
}: UseSessionRouteExperienceParams) {
  const routeProfile = getCompanionRouteProfile('ritual');

  const { artifactStatus, ingestArtifacts, applyMemoryCandidates } = useCompanionArtifactsRuntime({
    sessionId: activeSessionId,
    artifacts,
    storeArtifacts,
    updateSession,
  });

  const interruptSetterRef = useRef<(interrupt: InterruptPayload) => void>(() => undefined);

  const routeIncomingInterrupt = useCallback((interrupt: InterruptPayload) => {
    interruptSetterRef.current(interrupt);
  }, []);

  const setStreamInterruptHandler = useCallback((handler: (interrupt: InterruptPayload) => void) => {
    interruptSetterRef.current = handler;
  }, []);

  const { handleDataPart, handleFinish, markStreamTurnStarted } = useCompanionStreamContract({
    ingestArtifacts,
    setInterrupt: routeIncomingInterrupt,
    setCurrentContext,
    setMessageMetadata,
    sessionId,
    activeSessionId,
    activeThreadId,
  });

  useEffect(() => {
    if (!debugEnabled) return;

    debugLog('SessionPage', 'stream protocol', {
      ai_sdk_stream_enabled: true,
      route_profile: routeProfile.id,
    });
  }, [debugEnabled, routeProfile.id]);

  const {
    chatMessages,
    sendChatMessage,
    chatStatus,
    chatError,
    setChatMessages,
    stopStreaming,
  } = useCompanionChatRuntime({
    chatRequestBody,
    handleDataPart,
    handleFinish,
    showUsageLimitModal,
    recordConnectivityFailure,
    showToast,
  });

  const { messages, latestAssistantMessage, setMessageTimestamp } = useSessionMessageViewModel({
    chatMessages,
    greetingAnchorId,
    markOffline,
    debugEnabled,
    memoryHighlightsCount,
  });

  const sendMessage = useSessionOutboundSend({
    chatStatus,
    sendChatMessage,
    hasValidBackendSessionId,
    chatRequestBody,
    debugEnabled,
    markStreamTurnStarted,
    showToast,
  });

  const { appendVoiceUserMessage, appendVoiceAssistantMessage } = useSessionVoiceMessages({
    setChatMessages,
    setMessageTimestamp,
  });

  const isTyping = chatStatus === 'streaming' || chatStatus === 'submitted';

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
  } = useCompanionVoiceRuntime({
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

  const { baseHandleMicClick, setVoiceStatusCompat } = useSessionVoiceUiControls({
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
    routeProfile,
    artifactStatus,
    ingestArtifacts,
    applyMemoryCandidates,
    chatMessages,
    sendChatMessage,
    chatStatus,
    chatError,
    setChatMessages,
    stopStreaming,
    messages,
    latestAssistantMessage,
    setMessageTimestamp,
    markStreamTurnStarted,
    setStreamInterruptHandler,
    sendMessage,
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