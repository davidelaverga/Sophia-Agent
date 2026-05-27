'use client';

import { useEffect, useState } from 'react';

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
const TERMINAL_STATUSES = new Set<BuilderCanvasTaskSnapshotV1['status']>(['completed', 'failed', 'cancelled']);

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 12) : null;
}

function logCanvasClient(event: string, payload: Record<string, unknown>) {
  console.warn('[builder-canvas]', event, payload);
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
  const activeTask = snapshot.active_task;
  const recentEvents = activeTask
    ? snapshot.recent_events.filter((event) => eventMatchesTask(event, activeTask))
    : snapshot.recent_events;
  const activeCompletion = activeTask && completionMatchesTask(activeTask.completion, activeTask)
    ? activeTask?.completion
    : null;

  return {
    activeTask,
    recentEvents: sortEvents(recentEvents),
    completion: activeCompletion ?? latestTerminalCompletion(recentEvents, activeTask),
    reconnecting: false,
    retiredRuns: new Set(),
    runOrder: activeTask ? new Map([[taskRunKey(activeTask), 1]]) : new Map(),
    nextRunOrder: activeTask ? 1 : 0,
  };
}

function applySnapshot(current: BuilderCanvasState, snapshot: BuilderCanvasSnapshotV1): BuilderCanvasState {
  const snapshotState = stateFromSnapshot(snapshot);
  const snapshotTask = snapshotState.activeTask;
  const currentTask = current.activeTask;
  const sameRun = snapshotTask
    ? currentTask?.task_id === snapshotTask.task_id && currentTask?.run_id === snapshotTask.run_id
    : false;

  if (!snapshotTask) {
    return {
      ...snapshotState,
      retiredRuns: current.retiredRuns,
      runOrder: current.runOrder,
      nextRunOrder: current.nextRunOrder,
    };
  }

  if (!sameRun) {
    const retiredRuns = new Set(current.retiredRuns);
    let runOrder = current.runOrder;
    let nextRunOrder = current.nextRunOrder;
    const observed = observeRun(runOrder, nextRunOrder, taskRunKey(snapshotTask));
    runOrder = observed.runOrder;
    nextRunOrder = observed.nextRunOrder;
    const snapshotOrder = observed.order;
    if (currentTask) {
      const currentOrder = runOrder.get(taskRunKey(currentTask));
      if (currentOrder !== undefined && snapshotOrder <= currentOrder) {
        return {
          ...current,
          reconnecting: false,
          retiredRuns,
          runOrder,
          nextRunOrder,
        };
      }
      if (currentOrder === undefined || snapshotOrder > currentOrder) {
        retiredRuns.add(taskRunKey(currentTask));
      }
    }
    return { ...snapshotState, retiredRuns, runOrder, nextRunOrder };
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

export function useBuilderCanvas(
  parentThreadId: string | null | undefined,
  options?: { enabled?: boolean },
): BuilderCanvasState {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<BuilderCanvasState>(EMPTY_STATE);

  useEffect(() => {
    setState(EMPTY_STATE);
    logCanvasClient('hook-start', {
      enabled,
      parent_thread_id: shortId(parentThreadId),
    });
    if (!enabled || !parentThreadId) {
      return;
    }
    const encodedThreadId = encodeURIComponent(parentThreadId);
    const basePath = `/api/sophia/builder/threads/${encodedThreadId}/canvas`;
    let cancelled = false;
    const hydrateSnapshot = () => fetch(`${basePath}/snapshot`, { cache: 'no-store' })
      .then(async (response) => {
        logCanvasClient('snapshot-response', {
          parent_thread_id: shortId(parentThreadId),
          status: response.status,
          ok: response.ok,
        });
        if (!response.ok || cancelled) return;
        const snapshot = await response.json() as BuilderCanvasSnapshotV1;
        logCanvasClient('snapshot-hydrated', {
          parent_thread_id: shortId(parentThreadId),
          active_task_id: shortId(snapshot.active_task?.task_id),
          active_run_id: shortId(snapshot.active_task?.run_id),
          active_status: snapshot.active_task?.status ?? null,
          recent_events: snapshot.recent_events.length,
        });
        setState((current) => applySnapshot(current, snapshot));
      })
      .catch((error) => {
        logCanvasClient('snapshot-error', {
          parent_thread_id: shortId(parentThreadId),
          error: error instanceof Error ? error.name : 'unknown',
        });
      });
    void hydrateSnapshot();
    const reconcileTimer = setInterval(() => {
      void hydrateSnapshot();
    }, SNAPSHOT_RECONCILE_MS);

    if (typeof EventSource !== 'function') {
      return () => {
        cancelled = true;
        clearInterval(reconcileTimer);
      };
    }
    const source = new EventSource(`${basePath}/events`);
    source.onmessage = (message) => {
      if (cancelled) return;
      try {
        const event = JSON.parse(message.data) as BuilderCanvasEventV1;
        logCanvasClient('event', {
          parent_thread_id: shortId(parentThreadId),
          event_id: shortId(event.event_id),
          task_id: shortId(event.task_id),
          run_id: shortId(event.run_id),
          sequence: event.sequence,
          kind: event.kind,
          status: event.status,
        });
        setState((current) => applyEvent(current, event));
      } catch {
        // Ignore malformed server data and leave the last truthful state visible.
        logCanvasClient('event-malformed', {
          parent_thread_id: shortId(parentThreadId),
        });
      }
    };
    source.onerror = () => {
      if (!cancelled) {
        logCanvasClient('sse-error', {
          parent_thread_id: shortId(parentThreadId),
        });
        logCanvasClient('sse-timeout-reconnect', {
          parent_thread_id: shortId(parentThreadId),
        });
        setState((current) => ({ ...current, reconnecting: true }));
        void hydrateSnapshot();
      }
    };
    source.onopen = () => {
      if (!cancelled) {
        logCanvasClient('sse-open', {
          parent_thread_id: shortId(parentThreadId),
        });
        setState((current) => ({ ...current, reconnecting: false }));
      }
    };
    return () => {
      cancelled = true;
      clearInterval(reconcileTimer);
      source.close();
    };
  }, [enabled, parentThreadId]);

  return state;
}
