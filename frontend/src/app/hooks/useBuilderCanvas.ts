'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { diagErrorType, diagLog } from '../lib/diag-log';
import { recordSophiaCaptureEvent } from '../lib/session-capture';
import { recordSyntheticBuilderCanvasProjection } from '../lib/synthetic-builder-evidence';
import type {
  BuilderCanvasEventV1,
  BuilderCanvasSnapshotV1,
  BuilderCanvasTaskSnapshotV1,
} from '../types/builder-canvas';
import type { BuilderCompletionEventV1 } from '../types/builder-completion';

type BuilderCanvasState = {
  activeTask: BuilderCanvasTaskSnapshotV1 | null;
  recentEvents: BuilderCanvasEventV1[];
  completion: BuilderCompletionEventV1 | null;
  reconnecting: boolean;
  retiredRuns: Set<string>;
  runOrder: Map<string, number>;
  nextRunOrder: number;
  /** A valid snapshot for this thread has been applied (failed requests never count). */
  snapshotLoaded?: boolean;
};

const EMPTY_STATE: BuilderCanvasState = {
  activeTask: null,
  recentEvents: [],
  completion: null,
  reconnecting: false,
  retiredRuns: new Set(),
  runOrder: new Map(),
  nextRunOrder: 0,
};
const SNAPSHOT_RECONCILE_MS = 30_000;
const TERMINAL_STATUSES = new Set<BuilderCanvasTaskSnapshotV1['status']>([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
]);

// One single-line, content-free diagnostics event (`builder_canvas.<event>`).
function logCanvasClient(event: string, payload: Record<string, unknown>) {
  diagLog(`builder_canvas.${event}`, payload);
}

// Server receive-to-browser lag for one canvas event; null when unparseable.
function canvasEventLagMs(occurredAt: string | undefined, receivedAtMs: number): number | null {
  const occurredAtMs = typeof occurredAt === 'string' ? Date.parse(occurredAt) : Number.NaN;
  return Number.isFinite(occurredAtMs) ? receivedAtMs - occurredAtMs : null;
}

function runKey(taskId: string, runId: string): string {
  return `${taskId}:${runId}`;
}

function eventRunKey(event: BuilderCanvasEventV1): string {
  return runKey(event.task_id, event.run_id);
}

function taskRunKey(task: BuilderCanvasTaskSnapshotV1): string {
  return runKey(task.task_id, task.run_id);
}

function observeRun(
  runOrder: Map<string, number>,
  nextRunOrder: number,
  key: string,
): { runOrder: Map<string, number>; nextRunOrder: number; order: number } {
  const existing = runOrder.get(key);
  if (existing !== undefined) {
    return { runOrder, nextRunOrder, order: existing };
  }
  const order = nextRunOrder + 1;
  const updated = new Map(runOrder);
  updated.set(key, order);
  return { runOrder: updated, nextRunOrder: order, order };
}

function eventMatchesTask(event: BuilderCanvasEventV1, task: BuilderCanvasTaskSnapshotV1): boolean {
  return event.task_id === task.task_id && event.run_id === task.run_id;
}

function completionMatchesTask(
  completion: BuilderCompletionEventV1 | null | undefined,
  task: BuilderCanvasTaskSnapshotV1,
): completion is BuilderCompletionEventV1 {
  return Boolean(completion?.task_id === task.task_id && completion.run_id === task.run_id);
}

function latestTerminalCompletion(
  events: BuilderCanvasEventV1[],
  activeTask: BuilderCanvasTaskSnapshotV1 | null,
): BuilderCompletionEventV1 | null {
  const terminal = [...events]
    .reverse()
    .find((event) => event.kind === 'terminal' && (!activeTask || eventMatchesTask(event, activeTask)));

  return terminal?.completion ?? null;
}

function statusFromCompletion(completion: BuilderCompletionEventV1): BuilderCanvasTaskSnapshotV1['status'] {
  return completion.status === 'success'
    ? 'completed'
    : completion.status === 'timeout'
      ? 'timed_out'
      : completion.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
}

function taskFromTerminalCompletion(
  completion: BuilderCompletionEventV1 | null,
): BuilderCanvasTaskSnapshotV1 | null {
  if (!completion?.task_id || !completion.run_id) return null;
  return {
    parent_thread_id: completion.thread_id,
    task_id: completion.task_id,
    run_id: completion.run_id,
    status: statusFromCompletion(completion),
    completion,
  };
}

function isEmptyPassiveSnapshot(snapshot: BuilderCanvasSnapshotV1): boolean {
  return !snapshot.active_task && snapshot.recent_events.length === 0;
}

function sortEvents(events: BuilderCanvasEventV1[]): BuilderCanvasEventV1[] {
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

function isTerminalStatus(status: BuilderCanvasTaskSnapshotV1['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

function mergeEvents(
  currentEvents: BuilderCanvasEventV1[],
  snapshotEvents: BuilderCanvasEventV1[],
): BuilderCanvasEventV1[] {
  const byId = new Map<string, BuilderCanvasEventV1>();
  for (const event of currentEvents) byId.set(event.event_id, event);
  for (const event of snapshotEvents) byId.set(event.event_id, event);
  return sortEvents([...byId.values()]);
}

function stateFromSnapshot(snapshot: BuilderCanvasSnapshotV1): BuilderCanvasState {
  const snapshotTask = snapshot.active_task;
  const recentEvents = snapshotTask
    ? snapshot.recent_events.filter((event) => eventMatchesTask(event, snapshotTask))
    : snapshot.recent_events;
  const activeCompletion = snapshotTask && completionMatchesTask(snapshotTask.completion, snapshotTask)
    ? snapshotTask.completion
    : null;
  const terminalCompletion = activeCompletion ?? latestTerminalCompletion(recentEvents, snapshotTask);
  const terminalTask = taskFromTerminalCompletion(terminalCompletion);
  const activeTask = snapshotTask && terminalCompletion && completionMatchesTask(terminalCompletion, snapshotTask)
    ? {
      ...snapshotTask,
      status: statusFromCompletion(terminalCompletion),
      completion: terminalCompletion,
    }
    : snapshotTask ?? terminalTask;

  return {
    activeTask,
    recentEvents: sortEvents(recentEvents),
    completion: terminalCompletion,
    reconnecting: false,
    retiredRuns: new Set(),
    runOrder: activeTask ? new Map([[taskRunKey(activeTask), 1]]) : new Map(),
    nextRunOrder: activeTask ? 1 : 0,
  };
}

function retainNoTaskSnapshotState(
  current: BuilderCanvasState,
  snapshotState: BuilderCanvasState,
): BuilderCanvasState {
  return {
    ...snapshotState,
    retiredRuns: current.retiredRuns,
    runOrder: current.runOrder,
    nextRunOrder: current.nextRunOrder,
  };
}

function shouldKeepCurrentForUnseenSnapshot(
  current: BuilderCanvasState,
  currentTask: BuilderCanvasTaskSnapshotV1,
  snapshotOrder: number | undefined,
): boolean {
  if (snapshotOrder !== undefined || isTerminalStatus(currentTask.status)) {
    return false;
  }
  const currentOrder = current.runOrder.get(taskRunKey(currentTask));
  if (currentOrder === undefined) {
    return false;
  }
  return current.recentEvents.some((event) => eventMatchesTask(event, currentTask));
}

function shouldKeepCurrentForKnownOlderSnapshot(
  current: BuilderCanvasState,
  currentTask: BuilderCanvasTaskSnapshotV1,
  snapshotOrder: number | undefined,
): boolean {
  const currentOrder = current.runOrder.get(taskRunKey(currentTask));
  return currentOrder !== undefined && snapshotOrder !== undefined && snapshotOrder <= currentOrder;
}

function reconcileDifferentRunSnapshot(
  current: BuilderCanvasState,
  snapshotState: BuilderCanvasState,
  snapshotTask: BuilderCanvasTaskSnapshotV1,
): BuilderCanvasState {
  const retiredRuns = new Set(current.retiredRuns);
  const snapshotKey = taskRunKey(snapshotTask);
  const snapshotOrder = current.runOrder.get(snapshotKey);
  const currentTask = current.activeTask;

  if (currentTask && shouldKeepCurrentForUnseenSnapshot(current, currentTask, snapshotOrder)) {
    return { ...current, reconnecting: false, retiredRuns };
  }
  if (currentTask && shouldKeepCurrentForKnownOlderSnapshot(current, currentTask, snapshotOrder)) {
    return { ...current, reconnecting: false, retiredRuns };
  }
  if (currentTask) {
    retiredRuns.add(taskRunKey(currentTask));
  }

  const observed = observeRun(current.runOrder, current.nextRunOrder, snapshotKey);
  return {
    ...snapshotState,
    retiredRuns,
    runOrder: observed.runOrder,
    nextRunOrder: observed.nextRunOrder,
  };
}

function applySnapshot(
  current: BuilderCanvasState,
  snapshot: BuilderCanvasSnapshotV1,
  options?: { artifactReviewActive?: boolean },
): BuilderCanvasState {
  if (isEmptyPassiveSnapshot(snapshot)) {
    return options?.artifactReviewActive
      ? { ...current, reconnecting: false }
      : { ...EMPTY_STATE };
  }

  const snapshotState = stateFromSnapshot(snapshot);
  const snapshotTask = snapshotState.activeTask;
  const currentTask = current.activeTask;
  const sameRun = snapshotTask
    ? currentTask?.task_id === snapshotTask.task_id && currentTask?.run_id === snapshotTask.run_id
    : false;

  if (!snapshotTask) {
    return retainNoTaskSnapshotState(current, snapshotState);
  }

  if (!sameRun) {
    return reconcileDifferentRunSnapshot(current, snapshotState, snapshotTask);
  }

  const currentRunEvents = current.recentEvents.filter((event) => eventMatchesTask(event, snapshotTask));
  const recentEvents = mergeEvents(currentRunEvents, snapshotState.recentEvents);
  const currentCompletion = completionMatchesTask(current.completion, snapshotTask) ? current.completion : null;
  const keepLocalTerminal = currentTask
    && isTerminalStatus(currentTask.status)
    && !isTerminalStatus(snapshotTask.status);
  const activeTask = keepLocalTerminal
    ? {
      ...snapshotTask,
      ...currentTask,
      latest_activity: currentTask.latest_activity ?? snapshotTask.latest_activity,
      completion: currentTask.completion ?? snapshotTask.completion,
    }
    : snapshotState.activeTask;

  return {
    activeTask,
    recentEvents,
    completion: snapshotState.completion ?? currentCompletion,
    reconnecting: false,
    retiredRuns: current.retiredRuns,
    runOrder: current.runOrder,
    nextRunOrder: current.nextRunOrder,
  };
}

function applyEvent(state: BuilderCanvasState, event: BuilderCanvasEventV1): BuilderCanvasState {
  const active = state.activeTask;
  const sameRun = active?.task_id === event.task_id && active?.run_id === event.run_id;
  if (active && !sameRun && state.retiredRuns.has(eventRunKey(event))) {
    return state;
  }
  const latestSequence = sameRun
    ? state.recentEvents.reduce((latest, item) => Math.max(latest, item.sequence), 0)
    : 0;
  if (sameRun && event.kind !== 'terminal' && event.sequence <= latestSequence) {
    return state;
  }
  const recentEvents = sameRun
    ? [...state.recentEvents.filter((item) => item.event_id !== event.event_id), event]
    : [event];
  recentEvents.sort((left, right) => left.sequence - right.sequence);
  const latestActivity = event.activity ?? (sameRun ? active?.latest_activity : undefined);
  const retiredRuns = new Set(state.retiredRuns);
  const observed = observeRun(state.runOrder, state.nextRunOrder, eventRunKey(event));
  if (active && !sameRun) {
    retiredRuns.add(taskRunKey(active));
  }
  return {
    activeTask: {
      parent_thread_id: event.parent_thread_id,
      task_id: event.task_id,
      run_id: event.run_id,
      status: event.status,
      ...(latestActivity ? { latest_activity: latestActivity } : {}),
      ...(event.completion ? { completion: event.completion } : {}),
    },
    recentEvents,
    completion: event.kind === 'terminal' ? (event.completion ?? null) : (sameRun ? state.completion : null),
    reconnecting: false,
    retiredRuns,
    runOrder: observed.runOrder,
    nextRunOrder: observed.nextRunOrder,
  };
}

type BuilderCanvasFeedContext = {
  parentThreadId: string;
  basePath: string;
  isCancelled: () => boolean;
  artifactReviewActiveRef: { current: boolean };
  snapshotTelemetrySignatureRef: { current: string | null };
  setState: Dispatch<SetStateAction<BuilderCanvasState>>;
};

function recordEmptyPassiveSnapshotTelemetry(
  context: BuilderCanvasFeedContext,
  current: BuilderCanvasState,
  activeArtifactReview: boolean,
): void {
  const protectedExistingState = Boolean(current.activeTask || current.completion || current.recentEvents.length > 0);
  const signature = [
    context.parentThreadId,
    protectedExistingState ? 'protected' : 'empty',
    activeArtifactReview ? 'artifact-review-active' : 'artifact-review-inactive',
  ].join('|');
  if (context.snapshotTelemetrySignatureRef.current === signature) {
    return;
  }
  context.snapshotTelemetrySignatureRef.current = signature;
  if (activeArtifactReview) {
    logCanvasClient('snapshot_ignored_for_active_artifact', {
      parent_thread_id: context.parentThreadId,
      protected_existing_state: protectedExistingState,
    });
  }
  recordSophiaCaptureEvent({
    category: 'builder-ui',
    name: 'builder-canvas-snapshot-hydration',
    payload: {
      builderSnapshotEmptyPassive: true,
      builderSnapshotIgnoredForActiveArtifact: activeArtifactReview,
      artifactStageProtectedFromSnapshot: activeArtifactReview,
      artifactStageUnmountPrevented: activeArtifactReview,
      parentThreadIdPresent: Boolean(context.parentThreadId),
      activeTaskPresentBeforeSnapshot: Boolean(current.activeTask),
      activeCompletionPresentBeforeSnapshot: Boolean(current.completion),
      recentEventCountBeforeSnapshot: current.recentEvents.length,
      rawArtifactTextExcluded: true,
      rawCommentTextExcluded: true,
      rawFrameExcluded: true,
    },
  });
}

async function applyBuilderCanvasSnapshotResponse(
  context: BuilderCanvasFeedContext,
  response: Response,
): Promise<void> {
  logCanvasClient('snapshot_response', {
    parent_thread_id: context.parentThreadId,
    http_status: response.status,
    ok: response.ok,
  });
  if (!response.ok || context.isCancelled()) return;
  const snapshot = await response.json() as BuilderCanvasSnapshotV1;
  logCanvasClient('snapshot_hydrated', {
    parent_thread_id: context.parentThreadId,
    active_task_id: snapshot.active_task?.task_id ?? null,
    active_run_id: snapshot.active_task?.run_id ?? null,
    active_status: snapshot.active_task?.status ?? null,
    recent_events: snapshot.recent_events.length,
    received_at: new Date().toISOString(),
  });
  const emptyPassiveSnapshot = isEmptyPassiveSnapshot(snapshot);
  const activeArtifactReview = context.artifactReviewActiveRef.current;
  if (emptyPassiveSnapshot) {
    logCanvasClient('snapshot_empty_passive', {
      parent_thread_id: context.parentThreadId,
      active_artifact_review: activeArtifactReview,
    });
  }
  context.setState((current) => {
    const next = applySnapshot(current, snapshot, { artifactReviewActive: activeArtifactReview });
    if (emptyPassiveSnapshot) {
      recordEmptyPassiveSnapshotTelemetry(context, current, activeArtifactReview);
    }
    return { ...next, snapshotLoaded: true };
  });
}

function hydrateBuilderCanvasSnapshot(context: BuilderCanvasFeedContext): Promise<void> {
  return fetch(`${context.basePath}/snapshot`, { cache: 'no-store' })
    .then((response) => applyBuilderCanvasSnapshotResponse(context, response))
    .catch((error) => {
      logCanvasClient('snapshot_error', {
        parent_thread_id: context.parentThreadId,
        error_type: diagErrorType(error),
      });
    });
}

function handleBuilderCanvasSseMessage(context: BuilderCanvasFeedContext, message: MessageEvent): void {
  if (context.isCancelled()) return;
  try {
    const receivedAtMs = Date.now();
    const event = JSON.parse(message.data) as BuilderCanvasEventV1;
    logCanvasClient('event', {
      parent_thread_id: context.parentThreadId,
      task_id: event.task_id,
      run_id: event.run_id,
      sequence: event.sequence,
      kind: event.kind,
      status: event.status,
      occurred_at: event.occurred_at,
      received_at: new Date(receivedAtMs).toISOString(),
      lag_ms: canvasEventLagMs(event.occurred_at, receivedAtMs),
    });
    context.setState((current) => {
      const next = applyEvent(current, event);
      return next === current || next.snapshotLoaded === current.snapshotLoaded
        ? next
        : { ...next, snapshotLoaded: current.snapshotLoaded };
    });
  } catch {
    // Ignore malformed server data and leave the last truthful state visible.
    logCanvasClient('event_malformed', {
      parent_thread_id: context.parentThreadId,
    });
  }
}

function handleBuilderCanvasSseError(context: BuilderCanvasFeedContext): void {
  if (context.isCancelled()) return;
  logCanvasClient('sse_error', {
    parent_thread_id: context.parentThreadId,
  });
  logCanvasClient('sse_timeout_reconnect', {
    parent_thread_id: context.parentThreadId,
  });
  context.setState((current) => ({ ...current, reconnecting: true }));
  void hydrateBuilderCanvasSnapshot(context);
}

function handleBuilderCanvasSseOpen(context: BuilderCanvasFeedContext): void {
  if (context.isCancelled()) return;
  logCanvasClient('sse_open', {
    parent_thread_id: context.parentThreadId,
  });
  context.setState((current) => ({ ...current, reconnecting: false }));
}

function createBuilderCanvasEventSource(context: BuilderCanvasFeedContext): EventSource {
  const source = new EventSource(`${context.basePath}/events`);
  source.onmessage = (message) => handleBuilderCanvasSseMessage(context, message);
  source.onerror = () => handleBuilderCanvasSseError(context);
  source.onopen = () => handleBuilderCanvasSseOpen(context);
  return source;
}

export function useBuilderCanvas(
  parentThreadId: string | null | undefined,
  options?: { enabled?: boolean; artifactReviewActive?: boolean },
): BuilderCanvasState {
  const enabled = options?.enabled ?? true;
  const artifactReviewActive = options?.artifactReviewActive ?? false;
  const [state, setState] = useState<BuilderCanvasState>(EMPTY_STATE);
  const snapshotTelemetrySignatureRef = useRef<string | null>(null);
  const artifactReviewActiveRef = useRef(artifactReviewActive);
  const committedProjectionEventsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    artifactReviewActiveRef.current = artifactReviewActive;
  }, [artifactReviewActive]);

  useEffect(() => {
    committedProjectionEventsRef.current = new Set();
    setState(EMPTY_STATE);
    logCanvasClient('hook_start', {
      enabled,
      parent_thread_id: parentThreadId ?? null,
    });
    if (!enabled || !parentThreadId) {
      return;
    }
    let cancelled = false;
    const context: BuilderCanvasFeedContext = {
      parentThreadId,
      basePath: `/api/sophia/builder/threads/${encodeURIComponent(parentThreadId)}/canvas`,
      isCancelled: () => cancelled,
      artifactReviewActiveRef,
      snapshotTelemetrySignatureRef,
      setState,
    };
    void hydrateBuilderCanvasSnapshot(context);
    const reconcileTimer = setInterval(() => {
      void hydrateBuilderCanvasSnapshot(context);
    }, SNAPSHOT_RECONCILE_MS);

    if (typeof EventSource !== 'function') {
      return () => {
        cancelled = true;
        clearInterval(reconcileTimer);
      };
    }
    const source = createBuilderCanvasEventSource(context);
    return () => {
      cancelled = true;
      clearInterval(reconcileTimer);
      source.close();
    };
  }, [enabled, parentThreadId]);

  useEffect(() => {
    if (!enabled || !parentThreadId || !state.activeTask) {
      return;
    }
    for (const event of state.recentEvents) {
      if (
        event.parent_thread_id !== parentThreadId
        || event.task_id !== state.activeTask.task_id
        || event.run_id !== state.activeTask.run_id
        || committedProjectionEventsRef.current.has(event.event_id)
      ) {
        continue;
      }
      // This effect runs only after React has committed the reducer result.
      // Provider/SSE ingestion alone is therefore never evidence of a canvas
      // projection, and events rejected by applyEvent/applySnapshot cannot be
      // stamped with source_ui_projected_at.
      committedProjectionEventsRef.current.add(event.event_id);
      void recordSyntheticBuilderCanvasProjection(event, 'canvas_current');
    }
  }, [enabled, parentThreadId, state.activeTask, state.recentEvents]);

  return state;
}
