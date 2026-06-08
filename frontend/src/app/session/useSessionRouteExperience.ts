import { useCallback, useEffect, useRef, useState } from 'react';

import { useCompanionArtifactsRuntime } from '../companion-runtime/artifacts-runtime';
import { useCompanionChatRuntime } from '../companion-runtime/chat-runtime';
import { getCompanionRouteProfile } from '../companion-runtime/route-profiles';
import { useCompanionStreamContract } from '../companion-runtime/stream-contract';
import { useCompanionVoiceRuntime } from '../companion-runtime/voice-runtime';
import { useAppVersionFreshness } from '../hooks/useAppVersionFreshness';
import { useBuilderCanvas } from '../hooks/useBuilderCanvas';
import {
  cancelBuilderTask as requestBuilderTaskCancellation,
} from '../lib/builder-workflow';
import { debugLog } from '../lib/debug-logger';
import { recordSophiaCaptureEvent } from '../lib/session-capture';
import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type { BuilderCanvasActivity } from '../types/builder-canvas';
import type { BuilderCompletionEventV1, BuilderFailureDiagnosticsV1 } from '../types/builder-completion';
import type { BuilderTaskV1 } from '../types/builder-task';
import type { InterruptPayload, RitualArtifacts } from '../types/session';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';

import { completionFromTerminalCanvasTask } from './builder-canvas-completion';
import { useSessionMessageViewModel } from './useSessionMessageViewModel';
import { useSessionOutboundSend } from './useSessionSendActions';
import { useSessionVoiceMessages } from './useSessionVoiceMessages';
import { useSessionVoiceUiControls } from './useSessionVoiceUiControls';

type ToastVariant = 'info' | 'success' | 'error' | 'warning';

type ShowToastFn = (args: {
  message: string;
  variant: ToastVariant;
  durationMs?: number;
  action?: { label: string; onClick: () => void };
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
  artifactReviewActive?: boolean;
};

function builderRunKey(taskId?: string | null, runId?: string | null): string | null {
  if (!taskId) return null;
  return `${taskId}:${runId ?? ''}`;
}

function canvasActivityDetail(activity: BuilderCanvasActivity | undefined): string | undefined {
  if (!activity) return undefined;
  if (activity.source_title && activity.source_domain) {
    return `${activity.source_title} · ${activity.source_domain}`;
  }
  return activity.detail ?? activity.source_title ?? activity.source_domain ?? undefined;
}

function builderFailureDetail(diagnostic?: BuilderFailureDiagnosticsV1 | null): string | undefined {
  if (!diagnostic?.failure_code) return undefined;
  switch (diagnostic.failure_code) {
    case 'artifact_file_missing':
    case 'html_artifact_missing':
      return 'Builder failed: artifact file was missing.';
    case 'supporting_file_missing':
      return 'Builder failed: a supporting file was missing.';
    case 'builder_completed_without_deliverable':
      return 'Builder finished without a deliverable artifact.';
    case 'html_invalid_artifact_extension':
      return 'Builder rejected HTML output because it was not a standalone .html file.';
    case 'html_markdown_fence':
      return 'Builder rejected HTML output because it was wrapped in Markdown fences.';
    case 'html_escaped_as_text':
      return 'Builder rejected HTML output because HTML was escaped as text.';
    case 'html_missing_standalone_structure':
      return 'Builder rejected HTML output because it was not a standalone HTML document.';
    case 'artifact_path_outside_outputs':
      return 'Builder rejected the artifact path because it was outside outputs.';
    case 'artifact_path_traversal':
      return 'Builder rejected the artifact path because it contained path traversal.';
    case 'pdf_integrity_failed':
      return 'Builder rejected PDF output because integrity validation failed.';
    case 'pptx_integrity_failed':
      return 'Builder rejected PPTX output because integrity validation failed.';
    default:
      return diagnostic.failure_reason ?? undefined;
  }
}

function hashDiagnosticPath(path?: string | null): string | null {
  if (!path) return null;
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function builderFailureTelemetryFields(
  diagnostic?: BuilderFailureDiagnosticsV1 | null,
): Partial<BuilderTaskV1> {
  if (!diagnostic) {
    return {
      builderFailureDiagnostics: null,
      builderFailureDiagnosticAvailable: false,
      builderFailureStage: null,
      builderFailureCode: null,
      builderEmitAttempted: null,
      builderExpectedArtifactPathHash: null,
      builderExpectedArtifactExists: null,
      builderOutputsSummaryCount: 0,
      builderSupabaseMirrorResult: null,
      builderCompletionReconciliationAction: null,
    };
  }
  const expectedPath = diagnostic.artifact_target_path ?? diagnostic.target_path ?? null;
  return {
    builderFailureDiagnostics: diagnostic,
    builderFailureDiagnosticAvailable: true,
    builderFailureStage: diagnostic.failure_stage ?? null,
    builderFailureCode: diagnostic.failure_code ?? null,
    builderEmitAttempted: diagnostic.emit_attempted ?? null,
    builderExpectedArtifactPathHash: hashDiagnosticPath(expectedPath),
    builderExpectedArtifactExists: diagnostic.artifact_target_exists ?? null,
    builderOutputsSummaryCount: diagnostic.outputs_summary?.length ?? 0,
    builderSupabaseMirrorResult: diagnostic.supabase_mirror_result ?? null,
    builderCompletionReconciliationAction: diagnostic.canvas_reconciliation_action ?? null,
  };
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
  artifactReviewActive = false,
}: UseSessionRouteExperienceParams) {
  const routeProfile = getCompanionRouteProfile('ritual');
  const [builderArtifact, setBuilderArtifact] = useState<BuilderArtifactV1 | null>(storedBuilderArtifact ?? null);
  const [builderTask, setBuilderTask] = useState<BuilderTaskV1 | null>(null);
  const [isCancellingBuilderTask, setIsCancellingBuilderTask] = useState(false);
  const builderCanvas = useBuilderCanvas(activeThreadId, {
    enabled: Boolean(activeThreadId),
    artifactReviewActive,
  });
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
    setBuilderTask(task);
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
        : active.status === 'timed_out'
          ? 'timed_out'
          : active.status === 'cancelled'
            ? 'cancelled'
            : 'running';
    const activityLog = builderCanvas.recentEvents
      .filter((event) => event.task_id === active.task_id && event.run_id === active.run_id && event.activity)
      .map((event) => ({
        type: event.activity?.kind === 'tool_activity' ? 'tool_call' as const : 'thinking' as const,
        title: event.activity?.label ?? 'Working on deliverable',
        ...(event.activity?.action ? { action: event.activity.action } : {}),
        ...(event.activity?.category ? { tool: event.activity.category } : {}),
        ...(canvasActivityDetail(event.activity) ? { detail: canvasActivityDetail(event.activity) } : {}),
        ...(event.activity?.source_domain ? { sourceDomain: event.activity.source_domain } : {}),
        ...(event.activity?.source_title ? { sourceTitle: event.activity.source_title } : {}),
        status: 'done' as const,
      }));
    const failureDiagnostic = active.completion?.builder_failure_diagnostics ?? null;
    const failureDetail = phase === 'failed' ? builderFailureDetail(failureDiagnostic) : undefined;
    const failureTelemetry = builderFailureTelemetryFields(failureDiagnostic);
    setBuilderTask((current) => {
      const sameRun = current?.taskId === active.task_id && current.runId === active.run_id;
      return {
        ...(sameRun ? current : {}),
        phase,
        taskId: active.task_id,
        runId: active.run_id,
        detail: failureDetail
          ?? active.latest_activity?.label
          ?? (sameRun ? current?.detail : undefined)
          ?? 'Creating plan',
        ...(activityLog.length ? { activityLog } : {}),
        canvasStreamed: true,
        ...failureTelemetry,
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

  const canReloadForFreshBuild = chatStatus !== 'streaming' && chatStatus !== 'submitted';
  const { checkFreshness: checkAppVersionFreshness } = useAppVersionFreshness({
    enabled: Boolean(activeSessionId || sessionId),
    showToast,
    sessionId: activeSessionId || sessionId,
    threadId: activeThreadId,
    canAutoReload: canReloadForFreshBuild,
  });

  const cancelBuilderTask = useCallback(async () => {
    if (!activeThreadId || !builderTask?.taskId || builderTask.phase !== 'running' || isCancellingBuilderTask) {
      return null;
    }

    const runId = builderTask.runId
      ?? (builderCanvas.activeTask?.task_id === builderTask.taskId ? builderCanvas.activeTask.run_id : undefined);

    setIsCancellingBuilderTask(true);

    try {
      const response = await requestBuilderTaskCancellation(activeThreadId, builderTask.taskId, runId);
      const responseRunId = response.run_id ?? runId;
      const requestRunKey = builderRunKey(builderTask.taskId, runId);
      const responseRunKey = builderRunKey(response.task_id ?? builderTask.taskId, responseRunId);
      if (response.status === 'completed' || response.status === 'failed' || response.status === 'timed_out') {
        setBuilderTask((current) => {
          if (!current || builderRunKey(current.taskId, current.runId) !== requestRunKey) {
            return current;
          }
          return {
            ...current,
            phase: response.status === 'completed'
              ? 'completed'
              : response.status === 'timed_out'
                ? 'timed_out'
                : 'failed',
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
      return response;
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Could not cancel Builder right now.',
        variant: 'warning',
        durationMs: 3200,
      });
      return {
        task_id: builderTask.taskId,
        run_id: runId,
        status: 'failed',
        detail: error instanceof Error ? error.message : 'Could not cancel Builder right now.',
      };
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

  const sendMessage: typeof rawSendMessage = useCallback(
    async (...args) => {
      const appVersionFresh = await checkAppVersionFreshness({
        reason: 'before-send',
        reloadIfStale: true,
      });
      if (!appVersionFresh) {
        return;
      }
      return rawSendMessage(...args);
    },
    [checkAppVersionFreshness, rawSendMessage],
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
  const fallbackCanvasCompletion = completionFromTerminalCanvasTask(
    builderCanvas.activeTask,
    builderArtifact,
    activeThreadId,
  );
  const builderCompletionCandidate = builderCanvas.completion ?? fallbackCanvasCompletion;
  const effectiveBuilderCompletion: BuilderCompletionEventV1 | null =
    builderCompletionCandidate && !dismissedBuilderRunsRef.current.has(
      builderRunKey(builderCompletionCandidate.task_id, builderCompletionCandidate.run_id) ?? '',
    )
      ? builderCompletionCandidate
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
    appendVoiceAssistantMessage,
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
