import { useCallback, useEffect, useRef, useState } from 'react';

import { useCompanionArtifactsRuntime } from '../companion-runtime/artifacts-runtime';
import { useCompanionChatRuntime } from '../companion-runtime/chat-runtime';
import { getCompanionRouteProfile } from '../companion-runtime/route-profiles';
import { useCompanionStreamContract } from '../companion-runtime/stream-contract';
import { useCompanionVoiceRuntime } from '../companion-runtime/voice-runtime';
import {
  cancelBuilderTask as requestBuilderTaskCancellation,
  getActiveBuilderTask,
  getBuilderArtifactFromStatus,
  getBuilderTaskPhaseFromStatus,
  getBuilderTaskStatus,
  mergeBuilderTaskStatus,
} from '../lib/builder-workflow';
import { debugLog } from '../lib/debug-logger';
import { recordSophiaCaptureEvent } from '../lib/session-capture';
import { useSessionStore } from '../stores/session-store';
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
  storedDismissedBuilderArtifactKey?: string;
  storeArtifacts: (artifacts: RitualArtifacts, summary?: string) => void;
  storeBuilderArtifact: (builderArtifact: BuilderArtifactV1 | null) => void;
  updateSession: (updates: {
    artifacts?: RitualArtifacts;
    summary?: string;
    builderArtifact?: BuilderArtifactV1;
    dismissedBuilderArtifactKey?: string;
  }) => void;
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

function getBuilderArtifactDismissKey(
  builderArtifact: BuilderArtifactV1 | null | undefined,
): string | null {
  if (!builderArtifact) {
    return null;
  }

  // Key on artifactPath only (with title fallback). supportingFiles and title
  // can churn between emissions (e.g. voice runtime re-emits builder_result on
  // later turns with slightly different supportingFiles). Including them in
  // the key caused the "download pill reopens momentarily" bug when Sophia
  // replied after the user dismissed the pill.
  const path = builderArtifact.artifactPath?.trim();
  if (path) {
    return `path::${path}`;
  }
  const title = builderArtifact.artifactTitle?.trim();
  if (title) {
    return `title::${title}`;
  }
  return null;
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
  storedDismissedBuilderArtifactKey,
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
  const [builderTaskProbeStartedAtMs, setBuilderTaskProbeStartedAtMs] = useState<number | null>(null);
  const lastBuilderCaptureSignatureRef = useRef<string | null>(null);
  /** Task IDs dismissed after download — stale SSE events for these are rejected. */
  const dismissedTaskIdsRef = useRef(new Set<string>());
  /** Same deliverable should stay hidden after dismiss even if a late source re-emits it. */
  const dismissedArtifactKeyRef = useRef<string | null>(null);
  /**
   * TaskId that the currently-displayed `builderArtifact` belongs to.
   * When a new task with a different taskId starts, stale artifacts from the
   * previous task must be cleared so the "ready" pill for the old deliverable
   * doesn't resurface on top of the new running task. The old artifact stays
   * in the Session Files library (persisted on disk) — nothing is lost.
   */
  const currentArtifactTaskIdRef = useRef<string | null>(null);

  const setBuilderArtifactAndPersist = useCallback((
    nextBuilderArtifact: BuilderArtifactV1 | null,
    sourceTaskId?: string | null,
  ) => {
    const nextArtifactKey = getBuilderArtifactDismissKey(nextBuilderArtifact);

    if (nextArtifactKey && dismissedArtifactKeyRef.current === nextArtifactKey) {
      return;
    }

    if (nextArtifactKey && dismissedArtifactKeyRef.current && dismissedArtifactKeyRef.current !== nextArtifactKey) {
      dismissedArtifactKeyRef.current = null;
      updateSession({ dismissedBuilderArtifactKey: undefined });
    }

    setBuilderArtifact(nextBuilderArtifact);
    if (nextBuilderArtifact) {
      setBuilderTask((currentTask) => {
        // Tag the incoming artifact with whatever task it belongs to (if any),
        // so future task switches can invalidate it.
        currentArtifactTaskIdRef.current = sourceTaskId ?? currentTask?.taskId ?? null;
        if (!currentTask) return currentTask;
        // When a task is actively running with a taskId, polling is responsible
        // for the running→completed transition. Forcing completion here would
        // break the second builder request: the companion's artifact for turn
        // N+1 carries stale builder_result from turn N, which would prematurely
        // kill the new running task.
        if (currentTask.phase === 'running' && currentTask.taskId) {
          return currentTask;
        }
        return {
          ...currentTask,
          phase: 'completed',
          detail: currentTask.detail ?? 'Deliverable ready.',
        };
      });
    } else {
      currentArtifactTaskIdRef.current = null;
    }
    storeBuilderArtifact(nextBuilderArtifact);
  }, [storeBuilderArtifact, updateSession]);

  const clearBuilderTask = useCallback(() => {
    setBuilderTask((current) => {
      if (current?.taskId) {
        dismissedTaskIdsRef.current.add(current.taskId);
      }
      return null;
    });
  }, []);

  const clearBuilderArtifact = useCallback(() => {
    const dismissedArtifactKey = getBuilderArtifactDismissKey(builderArtifact);

    if (dismissedArtifactKey) {
      dismissedArtifactKeyRef.current = dismissedArtifactKey;
      updateSession({ dismissedBuilderArtifactKey: dismissedArtifactKey });
    }

    setBuilderArtifact(null);
    currentArtifactTaskIdRef.current = null;
    storeBuilderArtifact(null);
  }, [builderArtifact, storeBuilderArtifact, updateSession]);

  /**
   * Setter that rejects stale SSE events for tasks the user already dismissed.
   * Also: when a *new* task (different taskId) arrives in a non-terminal phase,
   * clears any stale `builderArtifact` from the previous task so the old
   * "ready" pill doesn't snap back over the new running task.
   */
  const guardedSetBuilderTask = useCallback((task: BuilderTaskV1 | null) => {
    if (task?.taskId && dismissedTaskIdsRef.current.has(task.taskId)) return;

    if (task) {
      setBuilderTaskProbeStartedAtMs(null);
    }

    if (task?.taskId && task.phase === 'running') {
      dismissedArtifactKeyRef.current = null;
      const previousArtifactTaskId = currentArtifactTaskIdRef.current;
      if (previousArtifactTaskId !== null && previousArtifactTaskId !== task.taskId) {
        // New task → drop stale artifact from the previous task.
        setBuilderArtifact(null);
        storeBuilderArtifact(null);
        currentArtifactTaskIdRef.current = null;
      } else if (previousArtifactTaskId === null) {
        // Artifact had no task association (e.g., legacy turn-level artifact).
        // A new identified task supersedes it.
        setBuilderArtifact((current) => (current ? null : current));
        storeBuilderArtifact(null);
      }
    }

    setBuilderTask(task);
  }, [storeBuilderArtifact]);

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
    onSessionTitle: useCallback((title: string, sid: string) => {
      const targetSessionId = activeSessionId || sid || sessionId;
      if (targetSessionId) {
        useSessionStore.getState().recordOpenSessionActivity(targetSessionId, { title });
      }
    }, [activeSessionId, sessionId]),
    sessionId,
    activeSessionId,
    activeThreadId,
  });

  const hasHandledInitialArtifactRef = useRef<string | null>(null);

  useEffect(() => {
    setBuilderTask(null);
    setIsCancellingBuilderTask(false);
    setBuilderTaskProbeStartedAtMs(null);
    lastBuilderCaptureSignatureRef.current = null;
    dismissedTaskIdsRef.current.clear();
    dismissedArtifactKeyRef.current = storedDismissedBuilderArtifactKey ?? null;
    currentArtifactTaskIdRef.current = null;
    hasHandledInitialArtifactRef.current = null;
  }, [activeSessionId, storedDismissedBuilderArtifactKey]);

  useEffect(() => {
    const storedArtifactKey = getBuilderArtifactDismissKey(storedBuilderArtifact);

    // Explicit dismiss recorded for this exact artifact → keep hidden.
    if (
      storedBuilderArtifact &&
      storedDismissedBuilderArtifactKey &&
      storedArtifactKey === storedDismissedBuilderArtifactKey
    ) {
      setBuilderArtifact(null);
      return;
    }

    // Persisted-on-reload: if the session store already has a builder artifact
    // at mount time (page refresh / open from history), treat it as already
    // seen so the "download" pill doesn't pop back up. The artifact stays
    // accessible via the Session Files library. Only artifacts that arrive
    // during the live session (new SSE/voice emissions after mount) will show
    // the pill.
    //
    // We gate on a per-session ref so this auto-dismiss only fires once, on
    // the first render for the session — not every time storedBuilderArtifact
    // updates during the live session.
    const handledKey = hasHandledInitialArtifactRef.current;
    const isInitialForSession = handledKey !== (activeSessionId ?? '');
    if (isInitialForSession) {
      hasHandledInitialArtifactRef.current = activeSessionId ?? '';
      if (storedBuilderArtifact && storedArtifactKey) {
        dismissedArtifactKeyRef.current = storedArtifactKey;
        setBuilderArtifact(null);
        if (storedArtifactKey !== storedDismissedBuilderArtifactKey) {
          updateSession({ dismissedBuilderArtifactKey: storedArtifactKey });
        }
        return;
      }
    }

    setBuilderArtifact(storedBuilderArtifact ?? null);
  }, [activeSessionId, storedBuilderArtifact, storedDismissedBuilderArtifactKey, updateSession]);

  // Rehydrate builder task on reconnect — discovers tasks started while SSE was down
  useEffect(() => {
    if (!activeThreadId || builderTask) {
      return;
    }

    let cancelled = false;

    const rehydrate = async () => {
      try {
        const active = await getActiveBuilderTask(activeThreadId, activeSessionId);
        if (cancelled || !active) return;

        // Skip terminal tasks — completed/failed/cancelled tasks from a previous session
        // on the same thread (e.g. after session continuation) should not reappear.
        // For reconnects where the task already completed, storedBuilderArtifact →
        // setBuilderArtifact handles restoring the artifact without needing rehydration.
        const phase = getBuilderTaskPhaseFromStatus(active.status);
        if (phase === 'completed' || phase === 'failed' || phase === 'timed_out' || phase === 'cancelled') return;

        const rehydrated = mergeBuilderTaskStatus(null, active);
        if (rehydrated) {
          // Don't resurrect tasks that were dismissed by their task ID
          if (rehydrated.taskId && dismissedTaskIdsRef.current.has(rehydrated.taskId)) return;
          
          // Don't resurrect tasks whose artifacts were dismissed
          const artifact = getBuilderArtifactFromStatus(active);
          if (artifact) {
            const artifactKey = getBuilderArtifactDismissKey(artifact);
            if (artifactKey && dismissedArtifactKeyRef.current === artifactKey) return;
          }
          
          recordSophiaCaptureEvent({
            category: 'builder',
            name: 'task-rehydrated',
            payload: rehydrated,
          });
          setBuilderTask(rehydrated);

          if (artifact) {
            setBuilderArtifactAndPersist(artifact, rehydrated.taskId ?? active.task_id ?? null);
          }
        }
      } catch {
        // Silent — rehydration is best-effort
      }
    };

    void rehydrate();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeThreadId, builderTask, setBuilderArtifactAndPersist]);

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
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const pollStartedAt = Date.now();

    /** Adaptive interval: fast at first to capture early activity log entries,
     *  then slower as the task progresses to reduce load. */
    const getPollInterval = (): number => {
      const elapsed = Date.now() - pollStartedAt;
      if (elapsed < 10_000) return 1000;   // first 10s: every 1s
      if (elapsed < 30_000) return 2000;   // next 20s: every 2s
      return 3000;                          // after 30s: every 3s
    };

    const pollTaskStatus = async () => {
      try {
        const status = await getBuilderTaskStatus(activeTaskId);
        if (cancelled) {
          return;
        }

        const nextBuilderArtifact = getBuilderArtifactFromStatus(status);
        if (nextBuilderArtifact) {
          setBuilderArtifactAndPersist(nextBuilderArtifact, activeTaskId);
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
        timeoutId = setTimeout(() => {
          void pollTaskStatus();
        }, getPollInterval());
      }
    };

    void pollTaskStatus();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
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

  const markStreamTurnStartedWithBuilderProbe = useCallback((startedAtMs: number) => {
    setBuilderTaskProbeStartedAtMs(startedAtMs);
    markStreamTurnStarted(startedAtMs);
  }, [markStreamTurnStarted]);

  const sendMessage = useSessionOutboundSend({
    chatStatus,
    sendChatMessage,
    hasValidBackendSessionId,
    chatRequestBody,
    debugEnabled,
    markStreamTurnStarted: markStreamTurnStartedWithBuilderProbe,
    showToast,
  });

  const { appendVoiceUserMessage, appendVoiceAssistantMessage } = useSessionVoiceMessages({
    setChatMessages,
    setMessageTimestamp,
  });

  const isTyping = chatStatus === 'streaming' || chatStatus === 'submitted';

  useEffect(() => {
    if (!activeThreadId || !activeSessionId || builderTask || builderTaskProbeStartedAtMs === null) {
      return;
    }

    if (Date.now() - builderTaskProbeStartedAtMs >= 30_000) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const lookupActiveTask = async () => {
      try {
        const active = await getActiveBuilderTask(activeThreadId, activeSessionId);
        if (cancelled) {
          return;
        }

        const rehydrated = mergeBuilderTaskStatus(null, active);
        if (rehydrated) {
          const nextBuilderArtifact = getBuilderArtifactFromStatus(active);
          if (nextBuilderArtifact) {
            setBuilderArtifactAndPersist(nextBuilderArtifact, rehydrated.taskId ?? active.task_id ?? null);
          }
          guardedSetBuilderTask(rehydrated);
          return;
        }
      } catch {
        if (cancelled) {
          return;
        }
      }

      if (!cancelled && Date.now() - builderTaskProbeStartedAtMs < 30_000) {
        timeoutId = setTimeout(() => {
          void lookupActiveTask();
        }, 1_500);
      }
    };

    void lookupActiveTask();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [
    activeSessionId,
    activeThreadId,
    builderTask,
    builderTaskProbeStartedAtMs,
    guardedSetBuilderTask,
    setBuilderArtifactAndPersist,
  ]);

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
    markStreamTurnStarted: markStreamTurnStartedWithBuilderProbe,
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