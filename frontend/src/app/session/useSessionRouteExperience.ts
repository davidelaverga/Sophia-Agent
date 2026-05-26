import { useCallback, useEffect, useRef, useState } from 'react';

import { useCompanionArtifactsRuntime } from '../companion-runtime/artifacts-runtime';
import { useCompanionChatRuntime } from '../companion-runtime/chat-runtime';
import { getCompanionRouteProfile } from '../companion-runtime/route-profiles';
import { useCompanionStreamContract } from '../companion-runtime/stream-contract';
import { useCompanionVoiceRuntime } from '../companion-runtime/voice-runtime';
import { useBuilderCanvas } from '../hooks/useBuilderCanvas';
import {
  cancelBuilderTask as requestBuilderTaskCancellation,
} from '../lib/builder-workflow';
import { debugLog } from '../lib/debug-logger';
import { recordSophiaCaptureEvent } from '../lib/session-capture';
import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type { BuilderCompletionEventV1 } from '../types/builder-completion';
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
  sessionVoiceMode?: boolean;
  markOffline: () => void;
  debugEnabled?: boolean;
  memoryHighlightsCount?: number;
};

function builderRunKey(taskId?: string | null, runId?: string | null): string | null {
  if (!taskId) return null;
  return `${taskId}:${runId ?? ''}`;
}

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
  sessionVoiceMode,
  markOffline,
  debugEnabled = false,
  memoryHighlightsCount = 0,
}: UseSessionRouteExperienceParams) {
  const routeProfile = getCompanionRouteProfile('ritual');
  const [builderArtifact, setBuilderArtifact] = useState<BuilderArtifactV1 | null>(storedBuilderArtifact ?? null);
  const [builderTask, setBuilderTask] = useState<BuilderTaskV1 | null>(null);
  const [isCancellingBuilderTask, setIsCancellingBuilderTask] = useState(false);
  const builderCanvas = useBuilderCanvas(activeThreadId, { enabled: Boolean(activeThreadId) });
  const lastBuilderCaptureSignatureRef = useRef<string | null>(null);
  /** Builder run identities dismissed by the user — stale SSE events for these are rejected. */
  const dismissedBuilderRunsRef = useRef(new Set<string>());

  const setBuilderArtifactAndPersist = useCallback((nextBuilderArtifact: BuilderArtifactV1 | null) => {
    setBuilderArtifact(nextBuilderArtifact);
    if (nextBuilderArtifact) {
      setBuilderTask((currentTask) => {
        if (!currentTask) return currentTask;
        // When a task is actively running with a taskId, polling is responsible
        // for the running→completed transition. Forcing completion here would
        // break the second builder request: the companion's artifact for turn N+1
        // carries stale builder_result from turn N, which would prematurely kill
        // the new running task.
        if (currentTask.phase === 'running' && currentTask.taskId) {
          return currentTask;
        }
        return {
          ...currentTask,
          phase: 'completed',
          detail: currentTask.detail ?? 'Deliverable ready.',
        };
      });
    }
    storeBuilderArtifact(nextBuilderArtifact);
  }, [storeBuilderArtifact]);

  const clearBuilderTask = useCallback(() => {
    setBuilderTask((current) => {
      const key = builderRunKey(current?.taskId, current?.runId);
      if (key) {
        dismissedBuilderRunsRef.current.add(key);
      }
      return null;
    });
  }, []);

  const clearBuilderArtifact = useCallback(() => {
    setBuilderArtifact(null);
    storeBuilderArtifact(null);
  }, [storeBuilderArtifact]);

  /** Setter that rejects stale SSE events for runs the user already dismissed. */
  const guardedSetBuilderTask = useCallback((task: BuilderTaskV1 | null) => {
    const key = builderRunKey(task?.taskId, task?.runId);
    if (key && dismissedBuilderRunsRef.current.has(key)) return;
    setBuilderTask(task?.phase === 'running' ? { ...task, canvasStreamed: true } : task);
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
    setBuilderTask: guardedSetBuilderTask,
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
    dismissedBuilderRunsRef.current.clear();
  }, [activeSessionId, storedBuilderArtifact]);

  // Native builder-canvas snapshot plus SSE is the single lifecycle source
  // for browser progress, reload recovery, and terminal delivery.
  useEffect(() => {
    const active = builderCanvas.activeTask;
    const activeKey = builderRunKey(active?.task_id, active?.run_id);
    if (!active || (activeKey && dismissedBuilderRunsRef.current.has(activeKey))) {
      return;
    }
    const phase: BuilderTaskV1['phase'] = active.status === 'completed'
      ? 'completed'
      : active.status === 'failed'
        ? 'failed'
        : active.status === 'cancelled'
          ? 'cancelled'
          : 'running';
    const activityLog = builderCanvas.recentEvents
      .filter((event) => event.task_id === active.task_id && event.run_id === active.run_id && event.activity)
      .map((event) => ({
        type: 'thinking' as const,
        title: event.activity?.label ?? 'Working on deliverable',
        status: 'done' as const,
      }));
    setBuilderTask((current) => {
      const sameRun = current?.taskId === active.task_id && current.runId === active.run_id;
      return {
        ...(sameRun ? current : {}),
        phase,
        taskId: active.task_id,
        runId: active.run_id,
        detail: active.latest_activity?.label ?? (sameRun ? current?.detail : undefined) ?? 'Starting',
        ...(activityLog.length ? { activityLog } : {}),
        canvasStreamed: true,
      };
    });
  }, [builderCanvas.activeTask, builderCanvas.recentEvents]);

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
    if (!activeThreadId || !builderTask?.taskId || builderTask.phase !== 'running' || isCancellingBuilderTask) {
      return;
    }

    const runId = builderTask.runId
      ?? (builderCanvas.activeTask?.task_id === builderTask.taskId ? builderCanvas.activeTask.run_id : undefined);

    setIsCancellingBuilderTask(true);

    try {
      const response = await requestBuilderTaskCancellation(activeThreadId, builderTask.taskId, runId);
      const responseRunId = response.run_id ?? runId;
      const requestRunKey = builderRunKey(builderTask.taskId, runId);
      const responseRunKey = builderRunKey(response.task_id ?? builderTask.taskId, responseRunId);
      if (response.status === 'completed' || response.status === 'failed') {
        setBuilderTask((current) => {
          if (!current || builderRunKey(current.taskId, current.runId) !== requestRunKey) {
            return current;
          }
          return {
            ...current,
            phase: response.status === 'completed' ? 'completed' : 'failed',
            runId: responseRunId ?? current.runId,
            detail: response.detail ?? current?.detail,
          };
        });
      } else if (response.status === 'cancelled') {
        if (responseRunKey) dismissedBuilderRunsRef.current.add(responseRunKey);
        setBuilderTask(null);
      } else {
        setBuilderTask((current) => {
          if (!current || builderRunKey(current.taskId, current.runId) !== requestRunKey) {
            return current;
          }
          return {
            ...current,
            runId: responseRunId ?? current.runId,
            detail: response.detail ?? current.detail,
          };
        });
      }
      showToast({
        message: response.detail || 'Builder cancelled.',
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
  }, [activeThreadId, builderCanvas.activeTask, builderTask, isCancellingBuilderTask, showToast]);

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

  const rawSendMessage = useSessionOutboundSend({
    chatStatus,
    sendChatMessage,
    hasValidBackendSessionId,
    chatRequestBody,
    debugEnabled,
    markStreamTurnStarted,
    showToast,
  });

  /**
   * PR-B (B5): cancel-on-restart guard.
   *
   * If the user submits a new prompt while a previous builder task is
   * still running, fire the cancellation first so the prior subagent
   * doesn't keep burning budget in parallel — this is the failure mode
   * we saw on thread ``019dd00c``: the user typed "Sophia please can
   * cel the task" (chat text, not a button click) and Sophia couldn't
   * actually trigger the cancel API; the next "build it again" message
   * spawned a SECOND concurrent subagent.
   *
   * Fires fire-and-forget — we don't block the new send on the cancel
   * round-trip; the executor's Future.cancel + cooperative cancel_event
   * will catch up within a few hundred ms. The user gets a snappy
   * response instead of a 1–2s freeze waiting on the cancel HTTP.
   */
  const sendMessage: typeof rawSendMessage = useCallback(
    async (...args) => {
      if (
        builderTask?.taskId &&
        builderTask.phase === 'running' &&
        !isCancellingBuilderTask
      ) {
        void cancelBuilderTask();
      }
      return rawSendMessage(...args);
    },
    [builderTask, cancelBuilderTask, isCancellingBuilderTask, rawSendMessage],
  );

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
    voiceMode: sessionVoiceMode,
    onUserTranscriptFallback: appendVoiceUserMessage,
    appendAssistantMessage: appendVoiceAssistantMessage,
    ingestArtifacts,
    setBuilderArtifact: setBuilderArtifactAndPersist,
    setBuilderTask: guardedSetBuilderTask,
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

  // The authenticated canvas stream carries terminal events as well as live
  // progress, keeping the session to one subscription.
  const effectiveBuilderCompletion: BuilderCompletionEventV1 | null =
    builderCanvas.completion && !dismissedBuilderRunsRef.current.has(
      builderRunKey(builderCanvas.completion.task_id, builderCanvas.completion.run_id) ?? '',
    )
      ? builderCanvas.completion
      : null;

  /**
   * PR-B: handler for the completion card's "Try again" button.
   *
   * Posts the literal user message ``"yes, please try that again"`` through
   * the same composer pipeline a typed message would take. The companion's
   * BuilderSessionMiddleware already keeps the original ``delegation_context.task``
   * brief in the prompt (PR #87 memory fix), so Sophia can re-issue
   * ``switch_to_builder`` with the right task without any client-side
   * context replay.
   */
  const handleBuilderRetry = useCallback(
    (event: BuilderCompletionEventV1) => {
      void sendMessage({ text: 'yes, please try that again' });
      const key = builderRunKey(event.task_id, event.run_id);
      if (key) dismissedBuilderRunsRef.current.add(key);
    },
    [sendMessage],
  );

  /**
   * PR-B: handler for the completion card's Open / Download dismissal.
   *
   * Marks the task/run as dismissed so a /last fetch on remount won't
   * resurrect the card. Clears the local ``builderTask`` state so the
   * card unmounts in the current view as well.
   */
  const handleBuilderCompletionDismiss = useCallback(
    (event: BuilderCompletionEventV1) => {
      const key = builderRunKey(event.task_id, event.run_id);
      if (key) dismissedBuilderRunsRef.current.add(key);
      setBuilderTask((current) => (
        builderRunKey(current?.taskId, current?.runId) === key ? null : current
      ));
    },
    [],
  );

  return {
    routeProfile,
    artifactStatus,
    builderArtifact,
    builderTask,
    clearBuilderTask,
    clearBuilderArtifact,
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
    // PR-B: builder completion card surface
    builderCompletion: effectiveBuilderCompletion,
    handleBuilderRetry,
    handleBuilderCompletionDismiss,
  };
}
