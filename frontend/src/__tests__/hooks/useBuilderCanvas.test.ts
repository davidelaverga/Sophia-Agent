import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordCanvasProjection = vi.hoisted(() => vi.fn(async () => null));

vi.mock('../../app/lib/synthetic-builder-evidence', () => ({
  recordSyntheticBuilderCanvasProjection: recordCanvasProjection,
}));

import { useBuilderCanvas } from '../../app/hooks/useBuilderCanvas';
import type { BuilderCanvasEventV1, BuilderCanvasSnapshotV1 } from '../../app/types/builder-canvas';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EVENT_SOURCE = globalThis.EventSource;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(event: BuilderCanvasEventV1) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
}

const SNAPSHOT: BuilderCanvasSnapshotV1 = {
  version: 1,
  active_task: {
    parent_thread_id: 'thread-1',
    task_id: 'task-1',
    run_id: 'run-1',
    status: 'running',
    latest_activity: { kind: 'phase', phase: 'starting', label: 'Starting' },
  },
  recent_events: [],
};

function mockFetchSnapshots(...snapshots: BuilderCanvasSnapshotV1[]) {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  for (const snapshot of snapshots) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  recordCanvasProjection.mockClear();
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 })) as typeof fetch;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  (globalThis as { EventSource?: unknown }).EventSource = ORIGINAL_EVENT_SOURCE;
  vi.restoreAllMocks();
});

describe('useBuilderCanvas', () => {
  it('hydrates from same-origin snapshot and opens one canvas stream', async () => {
    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-1'));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/sophia/builder/threads/thread-1/canvas/snapshot',
      { cache: 'no-store' },
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('/canvas/events');
  });

  it('clears stale state immediately when switching parent threads', async () => {
    mockFetchSnapshots(
      {
        version: 1,
        active_task: {
          parent_thread_id: 'thread-1',
          task_id: 'task-1',
          run_id: 'run-1',
          status: 'completed',
          completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
        },
        recent_events: [],
      },
      {
        version: 1,
        active_task: {
          parent_thread_id: 'thread-2',
          task_id: 'task-2',
          run_id: 'run-2',
          status: 'running',
        },
        recent_events: [],
      },
    );

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) => useBuilderCanvas(threadId),
      { initialProps: { threadId: 'thread-1' } },
    );

    await waitFor(() => expect(result.current.completion?.task_id).toBe('task-1'));

    rerender({ threadId: 'thread-2' });

    expect(result.current.activeTask).toBeNull();
    expect(result.current.completion).toBeNull();
    expect(result.current.recentEvents).toHaveLength(0);
    await waitFor(() => expect(result.current.activeTask?.parent_thread_id).toBe('thread-2'));
  });

  it('merges activity and terminal completion from the unified stream', async () => {
    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      source.emit({
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:00Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'drafting', label: 'Drafting' },
      });
      source.emit({
        version: 1,
        event_id: 'task-1:run-1:3',
        sequence: 3,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'terminal',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      });
    });
    await waitFor(() => expect(result.current.activeTask?.status).toBe('completed'));
    expect(result.current.recentEvents).toHaveLength(2);
    expect(result.current.completion?.status).toBe('success');
  });

  it('accepts terminal updates that reuse the latest active-run sequence', async () => {
    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      source.emit({
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:00Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'drafting', label: 'Drafting' },
      });
      source.emit({
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'terminal',
        status: 'cancelled',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'cancelled' },
      });
    });

    await waitFor(() => expect(result.current.activeTask?.status).toBe('cancelled'));
    expect(result.current.recentEvents).toHaveLength(1);
    expect(result.current.completion?.status).toBe('cancelled');
  });

  it('accepts terminal events for a newly observed run when progress was missed', async () => {
    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-1'));

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-2:1',
        sequence: 1,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-2',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'terminal',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-2', status: 'success' },
      });
    });

    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-2'));
    expect(result.current.activeTask?.status).toBe('completed');
    expect(result.current.recentEvents).toHaveLength(1);
    expect(result.current.completion?.run_id).toBe('run-2');
  });

  it('rejects delayed events from a retired run after a newer run is active', async () => {
    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-1'));

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-2:1',
        sequence: 1,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-2',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'drafting', label: 'Drafting new run' },
      });
    });

    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-2'));

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:02Z',
        kind: 'terminal',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      });
    });

    expect(result.current.activeTask?.run_id).toBe('run-2');
    expect(result.current.activeTask?.latest_activity?.label).toBe('Drafting new run');
    expect(result.current.completion).toBeNull();
  });

  it('does not retire a live stream run when a stale snapshot reports a different run', async () => {
    mockFetchSnapshots(SNAPSHOT, SNAPSHOT);

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-1'));

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-2:1',
        sequence: 1,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-2',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'drafting', label: 'Drafting live run' },
      });
    });

    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-2'));

    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });

    await waitFor(() => expect(result.current.reconnecting).toBe(false));
    expect(result.current.activeTask?.run_id).toBe('run-2');
    expect(result.current.activeTask?.latest_activity?.label).toBe('Drafting live run');

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-2:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-2',
        occurred_at: '2026-05-25T10:00:02Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'finalizing', label: 'Finalizing live run' },
      });
    });

    expect(result.current.activeTask?.run_id).toBe('run-2');
    expect(result.current.activeTask?.latest_activity?.label).toBe('Finalizing live run');
  });

  it('does not treat a slow unseen stale snapshot as newer than a live stream run', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let resolveSnapshot!: (response: Response) => void;
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveSnapshot = resolve;
    }));

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-2:1',
        sequence: 1,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-2',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'drafting', label: 'Drafting live run' },
      });
    });

    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-2'));

    await act(async () => {
      resolveSnapshot(new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
      await Promise.resolve();
    });

    expect(result.current.activeTask?.run_id).toBe('run-2');
    expect(result.current.activeTask?.latest_activity?.label).toBe('Drafting live run');
  });

  it('retires the previous run when a reconnect snapshot moves to a newer run', async () => {
    mockFetchSnapshots(SNAPSHOT, {
      version: 1,
      active_task: {
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-2',
        status: 'running',
        latest_activity: { kind: 'phase', phase: 'drafting', label: 'Drafting new run' },
      },
      recent_events: [],
    });

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-1'));

    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });

    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-2'));

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:02Z',
        kind: 'terminal',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      });
    });

    expect(result.current.activeTask?.run_id).toBe('run-2');
    expect(result.current.activeTask?.latest_activity?.label).toBe('Drafting new run');
    expect(result.current.completion).toBeNull();
  });

  it('records projection only after reducer state commits and never for a rejected retired event', async () => {
    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-1'));

    const committedEvent: BuilderCanvasEventV1 = {
      version: 1,
      event_id: 'task-1:run-2:1',
      sequence: 1,
      parent_thread_id: 'thread-1',
      task_id: 'task-1',
      run_id: 'run-2',
      occurred_at: '2026-05-25T10:00:01Z',
      kind: 'progress',
      status: 'running',
      activity: { kind: 'phase', phase: 'drafting', label: 'Drafting current run' },
    };
    act(() => {
      FakeEventSource.instances[0].emit(committedEvent);
    });
    await waitFor(() => expect(recordCanvasProjection).toHaveBeenCalledWith(
      committedEvent,
      'canvas_current',
    ));
    expect(result.current.activeTask?.run_id).toBe('run-2');

    recordCanvasProjection.mockClear();
    const rejectedRetiredEvent: BuilderCanvasEventV1 = {
      version: 1,
      event_id: 'task-1:run-1:2',
      sequence: 2,
      parent_thread_id: 'thread-1',
      task_id: 'task-1',
      run_id: 'run-1',
      occurred_at: '2026-05-25T10:00:02Z',
      kind: 'terminal',
      status: 'completed',
      completion: {
        thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        status: 'success',
      },
    };
    await act(async () => {
      FakeEventSource.instances[0].emit(rejectedRetiredEvent);
      await Promise.resolve();
    });

    expect(result.current.activeTask?.run_id).toBe('run-2');
    expect(result.current.recentEvents.map((event) => event.event_id)).toEqual([
      committedEvent.event_id,
    ]);
    expect(recordCanvasProjection).not.toHaveBeenCalled();
  });

  it('ignores stale terminal snapshot events when a newer active run exists', async () => {
    const oldCompletion = { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' } as const;
    const oldTerminal: BuilderCanvasEventV1 = {
      version: 1,
      event_id: 'task-1:run-1:3',
      sequence: 3,
      parent_thread_id: 'thread-1',
      task_id: 'task-1',
      run_id: 'run-1',
      occurred_at: '2026-05-25T10:00:01Z',
      kind: 'terminal',
      status: 'completed',
      completion: oldCompletion,
    };

    mockFetchSnapshots(SNAPSHOT, {
      version: 1,
      active_task: {
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-2',
        status: 'running',
        latest_activity: { kind: 'phase', phase: 'starting', label: 'Starting again' },
      },
      recent_events: [oldTerminal],
    });

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emit(oldTerminal);
      FakeEventSource.instances[0].onerror?.();
    });

    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-2'));
    expect(result.current.recentEvents).toHaveLength(0);
    expect(result.current.completion).toBeNull();
  });

  it('applies reconnect snapshots even when local events are already buffered', async () => {
    const terminalSnapshot: BuilderCanvasSnapshotV1 = {
      version: 1,
      active_task: {
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      },
      recent_events: [{
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:02Z',
        kind: 'terminal',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      }],
    };
    mockFetchSnapshots(SNAPSHOT, terminalSnapshot);

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit({
        version: 1,
        event_id: 'task-1:run-1:1',
        sequence: 1,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'drafting', label: 'Drafting' },
      });
    });
    await waitFor(() => expect(result.current.recentEvents).toHaveLength(1));

    act(() => {
      source.onerror?.();
    });

    await waitFor(() => expect(result.current.activeTask?.status).toBe('completed'));
    expect(result.current.recentEvents.map((event) => event.sequence)).toEqual([1, 2]);
    expect(result.current.completion?.status).toBe('success');
  });

  it('reconciles snapshot state periodically while the stream stays open', async () => {
    vi.useFakeTimers();
    const terminalSnapshot: BuilderCanvasSnapshotV1 = {
      version: 1,
      active_task: {
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      },
      recent_events: [{
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:02Z',
        kind: 'terminal',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      }],
    };
    mockFetchSnapshots(SNAPSHOT, terminalSnapshot);

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.activeTask?.status).toBe('running');
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.activeTask?.status).toBe('completed');
    expect(result.current.completion?.status).toBe('success');
    expect(result.current.reconnecting).toBe(false);
  });

  it('does not downgrade terminal stream state when same-run snapshot is stale', async () => {
    mockFetchSnapshots(SNAPSHOT, SNAPSHOT);

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emit({
        version: 1,
        event_id: 'task-1:run-1:2',
        sequence: 2,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:02Z',
        kind: 'terminal',
        status: 'completed',
        completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
      });
    });

    await waitFor(() => expect(result.current.activeTask?.status).toBe('completed'));

    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    expect(result.current.activeTask?.status).toBe('completed');
    expect(result.current.completion?.status).toBe('success');
  });

  it('clears stale terminal canvas state when an empty snapshot is not artifact-review protected', async () => {
    mockFetchSnapshots(
      {
        version: 1,
        active_task: {
          parent_thread_id: 'thread-1',
          task_id: 'task-1',
          run_id: 'run-1',
          status: 'completed',
          completion: { thread_id: 'thread-1', task_id: 'task-1', run_id: 'run-1', status: 'success' },
        },
        recent_events: [],
      },
      {
        version: 1,
        active_task: null,
        recent_events: [],
      },
    );

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.status).toBe('completed'));
    expect(result.current.completion?.status).toBe('success');

    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.activeTask).toBeNull());
    expect(result.current.completion).toBeNull();
    expect(result.current.recentEvents).toHaveLength(0);
  });

  it('treats empty snapshots as passive during artifact review and keeps active canvas state', async () => {
    mockFetchSnapshots(SNAPSHOT, {
      version: 1,
      active_task: null,
      recent_events: [],
    });

    const { result } = renderHook(() => useBuilderCanvas('thread-1', { artifactReviewActive: true }));
    await waitFor(() => expect(result.current.activeTask?.run_id).toBe('run-1'));

    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.reconnecting).toBe(false));
    expect(result.current.activeTask?.run_id).toBe('run-1');
  });

  it('promotes a retained terminal event when the snapshot has no active task', async () => {
    mockFetchSnapshots(SNAPSHOT, {
      version: 1,
      active_task: null,
      recent_events: [{
        version: 1,
        event_id: 'task-1:run-1:3',
        sequence: 3,
        parent_thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        occurred_at: '2026-05-25T10:00:01Z',
        kind: 'terminal',
        status: 'failed',
        completion: {
          thread_id: 'thread-1',
          task_id: 'task-1',
          run_id: 'run-1',
          status: 'error',
          error_message: 'Deck preparation failed.',
        },
      }],
    });

    const { result } = renderHook(() => useBuilderCanvas('thread-1'));
    await waitFor(() => expect(result.current.activeTask?.status).toBe('running'));

    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.activeTask?.status).toBe('failed'));
    expect(result.current.completion?.error_message).toBe('Deck preparation failed.');
  });
});
