import { useCallback, useEffect, useRef, useState } from 'react';

import { useCompanionArtifactsRuntime } from '../companion-runtime/artifacts-runtime';
import { useCompanionChatRuntime } from '../companion-runtime/chat-runtime';
import { getCompanionRouteProfile } from '../companion-runtime/route-profiles';
import { useCompanionStreamContract } from '../companion-runtime/stream-contract';
import { useCompanionVoiceRuntime } from '../companion-runtime/voice-runtime';
import {
  cancelBuilderTask as requestBuilderTaskCancellation,
  getBuilderArtifactFromStatus,
  getBuilderTaskPhaseFromStatus,
  getBuilderTaskStatus,
  mergeBuilderTaskStatus,
} from '../lib/builder-workflow';
import { debugLog } from '../lib/debug-logger';
import { recordSophiaCaptureEvent } from '../lib/session-capture';
import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type { BuilderTaskV1 } from '../types/builder-task';
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
  storedBuilderArtifact?: BuilderArtifactV1 | null;
  storeArtifacts: (artifacts: RitualArtifacts, summary?: string) => void;
  storeBuilderArtifact: (builderArtifact: BuilderArtifactV1 | null) => void;
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
  storedBuilderArtifact,
  storeArtifacts,
  storeBuilderArtifact,
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
  const [builderArtifact, setBuilderArtifact] = useState<BuilderArtifactV1 | null>(storedBuilderArtifact ?? null);
  const [builderTask, setBuilderTask] = useState<BuilderTaskV1 | null>(null);
  const [isCancellingBuilderTask, setIsCancellingBuilderTask] = useState(false);
  const lastBuilderCaptureSignatureRef = useRef<string | null>(null);

  const setBuilderArtifactAndPersist = useCallback((nextBuilderArtifact: BuilderArtifactV1 | null) => {
    setBuilderArtifact(nextBuilderArtifact);
    if (nextBuilderArtifact) {
      setBuilderTask((currentTask) => currentTask
        ? {
            ...currentTask,
            phase: 'completed',
            detail: currentTask.detail ?? 'Deliverable ready.',
          }
        : currentTask);
    }
    storeBuilderArtifact(nextBuilderArtifact);
  }, [storeBuilderArtifact]);

  const clearBuilderTask = useCallback(() => {
    setBuilderTask(null);
  }, []);

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
    setBuilderArtifact: setBuilderArtifactAndPersist,
    setBuilderTask,
    setInterrupt: routeIncomingInterrupt,
    setCurrentContext,
    setMessageMetadata,
    sessionId,
    activeSessionId,
    activeThreadId,
  });

  useEffect(() => {
    setBuilderArtifact(storedBuilderArtifact ?? null);
    setBuilderTask(null);
    setIsCancellingBuilderTask(false);
    lastBuilderCaptureSignatureRef.current = null;
  }, [activeSessionId, storedBuilderArtifact]);

  useEffect(() => {
    if (!builderTask) {
      return;
    }

    const signature = JSON.stringify(builderTask);
    if (signature === lastBuilderCaptureSignatureRef.current) {
      return;
    }

    lastBuilderCaptureSignatureRef.current = signature;
    recordSophiaCaptureEvent({
      category: 'builder',
      name: `task-${builderTask.phase}`,
      payload: builderTask,
    });
  }, [builderTask]);

  useEffect(() => {
    if (!builderTask?.taskId || builderTask.phase !== 'running') {
      return;
    }

    const activeTaskId = builderTask.taskId;
    let cancelled = false;
    let timeoutId: ReturnType<typeof window.setTimeout> | null = null;

    const pollTaskStatus = async () => {
      try {
        const status = await getBuilderTaskStatus(activeTaskId);
        if (cancelled) {
          return;
        }

        const nextBuilderArtifact = getBuilderArtifactFromStatus(status);
        if (nextBuilderArtifact) {
          setBuilderArtifactAndPersist(nextBuilderArtifact);
        }

        setBuilderTask((currentTask) => {
          if (currentTask?.taskId !== activeTaskId) {
            return currentTask;
          }

          return mergeBuilderTaskStatus(currentTask, status);
        });

        if (getBuilderTaskPhaseFromStatus(status.status) !== 'running') {
          return;
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof Error && error.message.includes('Task not found')) {
          setBuilderTask((currentTask) => {
            if (currentTask?.taskId !== activeTaskId || currentTask.phase !== 'running') {
              return currentTask;
            }

            return {
              ...currentTask,
              phase: 'failed',
              detail: 'Builder task state disappeared before completion.',
            };
          });
          return;
        }
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(() => {
          void pollTaskStatus();
        }, 2000);
      }
    };

    void pollTaskStatus();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [builderTask?.phase, builderTask?.taskId, setBuilderArtifactAndPersist]);

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

  const cancelBuilderTask = useCallback(async () => {
    if (!builderTask?.taskId || builderTask.phase !== 'running' || isCancellingBuilderTask) {
      return;
    }

    setIsCancellingBuilderTask(true);

    try {
      const response = await requestBuilderTaskCancellation(builderTask.taskId);
      setBuilderTask((currentTask) => {
        if (currentTask?.taskId !== builderTask.taskId) {
          return currentTask;
        }

        return {
          ...currentTask,
          phase: 'cancelled',
          detail: response.detail || 'Builder was cancelled before finishing the deliverable.',
        };
      });
      showToast({
        message: 'Builder cancelled.',
        variant: 'info',
        durationMs: 2400,
      });
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Could not cancel Builder right now.',
        variant: 'warning',
        durationMs: 3200,
      });
    } finally {
      setIsCancellingBuilderTask(false);
    }
  }, [builderTask, isCancellingBuilderTask, showToast]);

  const stopStreamingWithBuilderCancel = useCallback(() => {
    if (builderTask?.taskId && builderTask.phase === 'running') {
      void cancelBuilderTask();
    }
    void stopStreaming();
  }, [builderTask, cancelBuilderTask, stopStreaming]);

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
    threadId: activeThreadId,
    onUserTranscriptFallback: appendVoiceUserMessage,
    appendAssistantMessage: appendVoiceAssistantMessage,
    ingestArtifacts,
    setBuilderArtifact: setBuilderArtifactAndPersist,
    setBuilderTask,
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
    builderArtifact,
    builderTask,
    clearBuilderTask,
    cancelBuilderTask,
    isCancellingBuilderTask,
    ingestArtifacts,
    applyMemoryCandidates,
    chatMessages,
    sendChatMessage,
    chatStatus,
    chatError,
    setChatMessages,
    stopStreaming: stopStreamingWithBuilderCancel,
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