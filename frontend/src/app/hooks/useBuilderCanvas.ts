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
};

const EMPTY_STATE: BuilderCanvasState = {
  activeTask: null,
  recentEvents: [],
  completion: null,
  reconnecting: false,
};

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
  };
}

function applySnapshot(current: BuilderCanvasState, snapshot: BuilderCanvasSnapshotV1): BuilderCanvasState {
  const snapshotState = stateFromSnapshot(snapshot);
  const snapshotTask = snapshotState.activeTask;
  const currentTask = current.activeTask;
  const sameRun = snapshotTask
    ? currentTask?.task_id === snapshotTask.task_id && currentTask?.run_id === snapshotTask.run_id
    : false;

  if (!snapshotTask || !sameRun) {
    return snapshotState;
  }

  const currentRunEvents = current.recentEvents.filter((event) => eventMatchesTask(event, snapshotTask));
  const recentEvents = mergeEvents(currentRunEvents, snapshotState.recentEvents);
  const currentCompletion = completionMatchesTask(current.completion, snapshotTask) ? current.completion : null;

  return {
    activeTask: snapshotState.activeTask,
    recentEvents,
    completion: snapshotState.completion ?? currentCompletion,
    reconnecting: false,
  };
}

function applyEvent(state: BuilderCanvasState, event: BuilderCanvasEventV1): BuilderCanvasState {
  const active = state.activeTask;
  const sameRun = active?.task_id === event.task_id && active?.run_id === event.run_id;
  const latestSequence = sameRun
    ? state.recentEvents.reduce((latest, item) => Math.max(latest, item.sequence), 0)
    : 0;
  if (sameRun && event.kind !== 'terminal' && event.sequence <= latestSequence) {
    return state;
  }
  const shouldReplace = !active || sameRun || event.kind === 'progress' || event.kind === 'terminal';
  if (!shouldReplace) {
    return state;
  }
  const recentEvents = sameRun
    ? [...state.recentEvents.filter((item) => item.event_id !== event.event_id), event]
    : [event];
  recentEvents.sort((left, right) => left.sequence - right.sequence);
  const latestActivity = event.activity ?? (sameRun ? active?.latest_activity : undefined);
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
  };
}

export function useBuilderCanvas(
  parentThreadId: string | null | undefined,
  options?: { enabled?: boolean },
): BuilderCanvasState {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<BuilderCanvasState>(EMPTY_STATE);

  useEffect(() => {
    if (!enabled || !parentThreadId) {
      setState(EMPTY_STATE);
      return;
    }
    const encodedThreadId = encodeURIComponent(parentThreadId);
    const basePath = `/api/sophia/builder/threads/${encodedThreadId}/canvas`;
    let cancelled = false;

    const hydrateSnapshot = () => fetch(`${basePath}/snapshot`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const snapshot = await response.json() as BuilderCanvasSnapshotV1;
        setState((current) => applySnapshot(current, snapshot));
      })
      .catch(() => undefined);
    void hydrateSnapshot();

    if (typeof EventSource !== 'function') {
      return () => {
        cancelled = true;
      };
    }
    const source = new EventSource(`${basePath}/events`);
    source.onmessage = (message) => {
      if (cancelled) return;
      try {
        const event = JSON.parse(message.data) as BuilderCanvasEventV1;
        setState((current) => applyEvent(current, event));
      } catch {
        // Ignore malformed server data and leave the last truthful state visible.
      }
    };
    source.onerror = () => {
      if (!cancelled) {
        setState((current) => ({ ...current, reconnecting: true }));
        void hydrateSnapshot();
      }
    };
    source.onopen = () => {
      if (!cancelled) {
        setState((current) => ({ ...current, reconnecting: false }));
      }
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [enabled, parentThreadId]);

  return state;
}
