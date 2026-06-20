import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionBuilderArtifactLibrary } from '../../app/session/useSessionBuilderArtifactLibrary';

const ORIGINAL_FETCH = globalThis.fetch;

type DeferredResponse = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};

function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function artifactResponse(threadId: string, path: string, name: string): Response {
  return new Response(JSON.stringify({
    thread_id: threadId,
    artifacts: [{ path, name }],
  }), { status: 200 });
}

function artifactListResponse(
  threadId: string,
  artifacts: Array<{ path: string; name: string }>,
): Response {
  return new Response(JSON.stringify({
    thread_id: threadId,
    artifacts,
  }), { status: 200 });
}

async function flushAsyncState() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('useSessionBuilderArtifactLibrary', () => {
  it('normalizes artifact paths before exposing library items for canvas selection', async () => {
    globalThis.fetch = vi.fn(async () => artifactResponse('thread-1', '/outputs/brief.md', ' brief.md ')) as typeof fetch;

    const { result } = renderHook(() => useSessionBuilderArtifactLibrary({
      threadId: 'thread-1',
      refreshOnFocus: false,
    }));

    await act(async () => {
      await flushAsyncState();
    });

    expect(result.current.items).toEqual([{
      path: 'mnt/user-data/outputs/brief.md',
      name: 'brief.md',
    }]);
  });

  it('keeps deck preview PDFs in the shared builder artifact library', async () => {
    globalThis.fetch = vi.fn(async () => artifactListResponse('thread-1', [
      { path: '/outputs/deck.preview.pdf', name: 'deck.preview.pdf' },
      { path: '/outputs/deck.pptx', name: 'deck.pptx' },
    ])) as typeof fetch;

    const { result } = renderHook(() => useSessionBuilderArtifactLibrary({
      threadId: 'thread-1',
      refreshOnFocus: false,
    }));

    await act(async () => {
      await flushAsyncState();
    });

    expect(result.current.items.map((item) => item.name)).toEqual(['deck.pptx', 'deck.preview.pdf']);
  });

  it('ignores stale no-signal artifact loads after switching threads', async () => {
    const oldInitial = deferredResponse();
    const oldPoll = deferredResponse();
    const newInitial = deferredResponse();
    const responses = [oldInitial, oldPoll, newInitial];
    globalThis.fetch = vi.fn(() => {
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next.promise;
    }) as typeof fetch;

    const { result, rerender } = renderHook(
      ({ threadId }) => useSessionBuilderArtifactLibrary({
        threadId,
        pollIntervalMs: 1000,
        refreshOnFocus: false,
      }),
      { initialProps: { threadId: 'thread-old' } },
    );

    await act(async () => {
      oldInitial.resolve(artifactResponse('thread-old', 'mnt/user-data/outputs/old.md', 'old.md'));
      await oldInitial.promise;
      await flushAsyncState();
    });
    expect(result.current.items[0]?.name).toBe('old.md');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    rerender({ threadId: 'thread-new' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      newInitial.resolve(artifactResponse('thread-new', 'mnt/user-data/outputs/new.md', 'new.md'));
      await newInitial.promise;
      await flushAsyncState();
    });
    expect(result.current.items[0]?.name).toBe('new.md');

    await act(async () => {
      oldPoll.resolve(artifactResponse('thread-old', 'mnt/user-data/outputs/late-old.md', 'late-old.md'));
      await oldPoll.promise;
      await flushAsyncState();
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.name).toBe('new.md');
  });
});
