import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRecentSessionEndHint,
  getRecentSessionEndHint,
  markRecentSessionEnd,
} from '../../app/lib/recent-session-end';
import {
  hydrateStoredArtifactsWithRecentMemories,
  useRecapArtifactsLoader,
} from '../../app/recap/[sessionId]/useRecapArtifactsLoader';
import { useRecapStore } from '../../app/stores/recap-store';

const markRecapViewedMock = vi.fn();
const getSessionHistoryEntryMock = vi.fn();

vi.mock('../../app/stores/session-history-store', () => ({
  useSessionHistoryStore: {
    getState: () => ({
      markRecapViewed: markRecapViewedMock,
      getSession: getSessionHistoryEntryMock,
    }),
  },
}));

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRecapArtifactsLoader', () => {
  beforeEach(() => {
    localStorage.clear();
    clearRecentSessionEndHint();
    vi.clearAllMocks();
    getSessionHistoryEntryMock.mockReturnValue(undefined);
    useRecapStore.setState({
      artifacts: {},
      decisions: {},
      commitStatus: {},
    });
    vi.useRealTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats a just-ended 404 as processing and retries until recap artifacts arrive', async () => {
    vi.useFakeTimers();

    const setArtifacts = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: 'Not found' }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 'sess-recent-404',
          takeaway: 'You found your footing again.',
          memory_candidates: [
            {
              id: 'mem-1',
              text: 'I can recover faster than I think.',
              category: 'lesson',
            },
          ],
        }),
      );

    global.fetch = fetchMock as unknown as typeof fetch;
    markRecentSessionEnd('sess-recent-404');

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-recent-404',
        artifacts: null,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(result.current.status).toBe('processing');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    await flushEffects();

    expect(setArtifacts).toHaveBeenCalledWith(
      'sess-recent-404',
      expect.objectContaining({ takeaway: 'You found your footing again.' }),
    );
    expect(result.current.status).toBe('ready');

    expect(getRecentSessionEndHint()).toBeNull();
  });

  it('retries when the session exists but recap artifacts are still empty right after ending', async () => {
    vi.useFakeTimers();

    const setArtifacts = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 'sess-processing',
          recap_artifacts: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 'sess-processing',
          takeaway: 'A clean ending still counts.',
          reflection_candidate: {
            prompt: 'What shifted when you chose to stop here?',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          memories: [
            {
              id: 'mem-processing-1',
              text: 'User wants to end sessions cleanly when they have enough signal.',
              category: 'preference',
              created_at: '2026-03-03T20:02:00.000Z',
            },
          ],
          count: 1,
          fallbackApplied: true,
        }),
      );

    global.fetch = fetchMock as unknown as typeof fetch;
    markRecentSessionEnd('sess-processing');

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-processing',
        artifacts: null,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(result.current.status).toBe('processing');

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    await flushEffects();

    expect(setArtifacts).toHaveBeenCalledWith(
      'sess-processing',
      expect.objectContaining({
        takeaway: 'A clean ending still counts.',
        memoryCandidates: [
          expect.objectContaining({ id: 'mem-processing-1' }),
        ],
      }),
    );
    expect(result.current.status).toBe('ready');
  });

  it('hydrates missing memory candidates from the recent memory review queue', async () => {
    const setArtifacts = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 'sess-memory-review',
          started_at: '2026-03-03T19:46:00.000Z',
          ended_at: '2026-03-03T20:00:00.000Z',
          takeaway: 'You found the cleaner thread under the noise.',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          memories: [
            {
              id: '05941898-bd0b-4d01-bcd1-9577ca94c6bc',
              text: 'User was promoted to CTO after 2 years of sustained effort.',
              category: 'fact',
              created_at: '2026-03-03T19:52:00.000Z',
            },
          ],
          count: 1,
          fallbackApplied: true,
        }),
      );

    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-memory-review',
        artifacts: null,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(AbortSignal.timeout).toHaveBeenCalledWith(15000);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/memory/recent?status=pending_review&session_id=sess-memory-review&started_at=2026-03-03T19%3A46%3A00.000Z&ended_at=2026-03-03T20%3A00%3A00.000Z',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(setArtifacts).toHaveBeenCalledWith(
      'sess-memory-review',
      expect.objectContaining({
        takeaway: 'You found the cleaner thread under the noise.',
        memoryCandidates: [
          expect.objectContaining({
            id: '05941898-bd0b-4d01-bcd1-9577ca94c6bc',
            text: 'User was promoted to CTO after 2 years of sustained effort.',
          }),
        ],
      }),
    );
    expect(result.current.status).toBe('ready');
  });

  it('marks the recap as reviewed when no pending candidates remain but approved memories exist in the journal', async () => {
    const setArtifacts = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 'sess-reviewed',
          started_at: '2026-03-03T19:46:00.000Z',
          ended_at: '2026-03-03T20:00:00.000Z',
          takeaway: 'The important part already landed.',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          memories: [],
          count: 0,
          fallbackApplied: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          memories: [
            {
              id: 'approved-memory-1',
              text: 'User already saved the key memory from this session.',
              category: 'lesson',
              created_at: '2026-03-03T20:02:00.000Z',
            },
          ],
          count: 1,
          fallbackApplied: false,
        }),
      );

    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-reviewed',
        artifacts: null,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/memory/recent?status=approved&session_id=sess-reviewed&started_at=2026-03-03T19%3A46%3A00.000Z&ended_at=2026-03-03T20%3A00%3A00.000Z',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(setArtifacts).toHaveBeenCalledWith(
      'sess-reviewed',
      expect.objectContaining({ takeaway: 'The important part already landed.' }),
    );
    expect(result.current.status).toBe('reviewed');
  });

  it('keeps the recap ready after the last candidate is discarded locally', async () => {
    const setArtifacts = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        memories: [],
        count: 0,
        fallbackApplied: true,
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;
    useRecapStore.getState().setDecision('sess-local-discard', 'discarded-memory-1', 'discarded');
    markRecentSessionEnd('sess-local-discard');
    const artifacts = {
      sessionId: 'sess-local-discard',
      threadId: 'thread-local-discard',
      sessionType: 'debrief' as const,
      contextMode: 'life' as const,
      startedAt: '2026-03-03T19:46:00.000Z',
      endedAt: new Date().toISOString(),
      takeaway: 'You cleared the noise without needing to keep all of it.',
      memoryCandidates: [],
      status: 'ready' as const,
    };

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-local-discard',
        artifacts,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(result.current.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRecentSessionEndHint()).toBeNull();
  });

  it('does not flash back to loading when stored artifacts change after a local discard', async () => {
    const setArtifacts = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        memories: [],
        count: 0,
        fallbackApplied: true,
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const initialArtifacts = {
      sessionId: 'sess-no-flash',
      threadId: 'thread-no-flash',
      sessionType: 'debrief' as const,
      contextMode: 'life' as const,
      startedAt: '2026-03-03T19:46:00.000Z',
      endedAt: new Date().toISOString(),
      takeaway: 'You kept only what mattered.',
      memoryCandidates: [
        {
          id: 'mem-1',
          text: 'Low-signal memory candidate.',
          category: 'fact' as const,
        },
      ],
      status: 'ready' as const,
    };

    useRecapStore.getState().setDecision('sess-no-flash', 'mem-1', 'discarded');
    markRecentSessionEnd('sess-no-flash');

    const { result, rerender } = renderHook(
      ({ artifacts }) => useRecapArtifactsLoader({
        sessionId: 'sess-no-flash',
        artifacts,
        setArtifacts,
      }),
      { initialProps: { artifacts: initialArtifacts } },
    );

    await flushEffects();
    expect(result.current.status).toBe('ready');

    rerender({
      artifacts: {
        ...initialArtifacts,
        memoryCandidates: [],
      },
    });

    expect(result.current.status).toBe('ready');

    await flushEffects();

    expect(result.current.status).toBe('ready');
    expect(getRecentSessionEndHint()).toBeNull();
  });

  it('marks the recap as reviewed when discarded memories already exist for the session', async () => {
    const setArtifacts = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 'sess-discarded-reviewed',
          started_at: '2026-03-03T19:46:00.000Z',
          ended_at: '2026-03-03T20:00:00.000Z',
          takeaway: 'You let the unnecessary parts stay behind.',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          memories: [],
          count: 0,
          fallbackApplied: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          memories: [],
          count: 0,
          fallbackApplied: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          memories: [
            {
              id: 'discarded-memory-1',
              text: 'User chose not to keep the low-signal recap memory.',
              category: 'preference',
              created_at: '2026-03-03T20:02:00.000Z',
            },
          ],
          count: 1,
          fallbackApplied: false,
        }),
      );

    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-discarded-reviewed',
        artifacts: null,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/memory/recent?status=discarded&session_id=sess-discarded-reviewed&started_at=2026-03-03T19%3A46%3A00.000Z&ended_at=2026-03-03T20%3A00%3A00.000Z',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(setArtifacts).toHaveBeenCalledWith(
      'sess-discarded-reviewed',
      expect.objectContaining({ takeaway: 'You let the unnecessary parts stay behind.' }),
    );
    expect(result.current.status).toBe('reviewed');
  });

  it('hydrates stored recap artifacts that were persisted before memories arrived', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        memories: [
          {
            id: 'candidate-memory-1',
            text: 'User wants to protect quiet mornings for deep work.',
            category: 'preference',
            created_at: '2026-03-03T20:04:00.000Z',
          },
        ],
        count: 1,
        fallbackApplied: true,
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const hydrated = await hydrateStoredArtifactsWithRecentMemories(
      {
        sessionId: 'sess-stored-artifacts',
        threadId: 'thread-stored-artifacts',
        sessionType: 'debrief',
        contextMode: 'work',
        startedAt: '2026-03-03T19:46:00.000Z',
        endedAt: '2026-03-03T20:00:00.000Z',
        takeaway: 'The quieter plan was the real plan.',
        builderArtifact: {
          artifactTitle: 'Focus memo',
          artifactType: 'document',
          artifactPath: 'mnt/user-data/outputs/focus-memo.md',
          decisionsMade: ['Dropped the redundant context section'],
        },
        status: 'ready',
        memoryCandidates: [],
      },
      'sess-stored-artifacts',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/memory/recent?status=pending_review&session_id=sess-stored-artifacts&started_at=2026-03-03T19%3A46%3A00.000Z&ended_at=2026-03-03T20%3A00%3A00.000Z',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(hydrated).toEqual(
      expect.objectContaining({
        threadId: 'thread-stored-artifacts',
        takeaway: 'The quieter plan was the real plan.',
        builderArtifact: expect.objectContaining({
          artifactTitle: 'Focus memo',
        }),
        memoryCandidates: [
          expect.objectContaining({
            id: 'candidate-memory-1',
            text: 'User wants to protect quiet mornings for deep work.',
          }),
        ],
      }),
    );
  });

  it('keeps stale missing recaps as not found', async () => {
    const setArtifacts = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'Not found' }, 404));

    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-stale',
        artifacts: null,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(result.current.status).toBe('not_found');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});