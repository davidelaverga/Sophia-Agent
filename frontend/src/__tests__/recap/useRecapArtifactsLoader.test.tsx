import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecapArtifactsV1 } from '../../app/lib/recap-types';
import {
  clearRecentSessionEndHint,
  getRecentSessionEndHint,
  markRecentSessionEnd,
} from '../../app/lib/recent-session-end';
import {
  hydrateStoredArtifactsWithRecentMemories,
  useRecapArtifactsLoader,
} from '../../app/recap/[sessionId]/useRecapArtifactsLoader';

import { canonicalCandidate, canonicalRecap as canonicalRecapFor, type CanonicalFixtureState } from './canonical-recap-fixture';

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
  it('ignores a previous owner response and refuses loading while signed out', async () => {
    let finishOld!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }))
      .mockResolvedValue(jsonResponse({ detail: 'unavailable' }, 503));
    global.fetch = fetchMock;
    const publish = vi.fn(), invalidate = vi.fn();
    const { result, rerender } = renderHook(({ ownerId }: { ownerId: string | null }) => useRecapArtifactsLoader({
      sessionId: 'same-session', ownerId, artifacts: null, setArtifacts: publish, invalidateArtifacts: invalidate,
    }), { initialProps: { ownerId: 'owner-a' as string | null } });
    await flushEffects();
    rerender({ ownerId: 'owner-b' });
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { finishOld(jsonResponse({ detail: 'not found' }, 404)); });
    expect(invalidate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(result.current.status).toBe('unavailable');
    rerender({ ownerId: null });
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).not.toBe('ready');
  });
  it.each([404, 503])('does not trust persisted recap candidates when authority returns %s', async (httpStatus) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'unavailable' }, httpStatus));
    global.fetch = fetchMock as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const invalidateArtifacts = vi.fn();
    const cached: RecapArtifactsV1 = { sessionId: 'mem00-deleted-source', sessionType: 'open', contextMode: 'life', status: 'ready', takeaway: 'MEM00 STALE', memoryCandidates: [{ id: 'old-candidate', text: 'MEM00 STALE', category: 'fact' }] };
    const { result } = renderHook(() => useRecapArtifactsLoader({
      sessionId: 'mem00-deleted-source',
      artifacts: cached,
      setArtifacts,
      invalidateArtifacts,
    }));
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledWith('/api/sophia/sessions/mem00-deleted-source/recap', expect.any(Object));
    expect(result.current.status).toBe(httpStatus === 404 ? 'not_found' : 'unavailable');
    expect(setArtifacts).not.toHaveBeenCalled();
    expect(markRecapViewedMock).not.toHaveBeenCalled();
    expect(invalidateArtifacts.mock.calls).toEqual(httpStatus === 404 ? [['mem00-deleted-source']] : []);
  });

  it('denies a fresh response for a different session', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ session_id: 'wrong-session', memory_candidates: [{ id: 'wrong', text: 'synthetic', category: 'fact' }] })) as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const { result } = renderHook(() => useRecapArtifactsLoader({ sessionId: 'expected-session', artifacts: null, setArtifacts }));
    await flushEffects();
    expect(result.current.status).toBe('unavailable');
    expect(setArtifacts).not.toHaveBeenCalled();
    expect(markRecapViewedMock).not.toHaveBeenCalled();
  });

  it('does not publish an obsolete response or clear the current session end hint', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce(jsonResponse({ session_id: 'new-session', memory_candidates: [{ id: 'new', text: 'synthetic', category: 'fact' }] })) as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const { result, rerender } = renderHook(({ sessionId }) => useRecapArtifactsLoader({ sessionId, artifacts: null, setArtifacts }), { initialProps: { sessionId: 'old-session' } });
    rerender({ sessionId: 'new-session' });
    await flushEffects();
    markRecentSessionEnd('new-session');
    await act(async () => { resolveOld(jsonResponse({ session_id: 'old-session', memory_candidates: [{ id: 'old', text: 'synthetic', category: 'fact' }] })); });
    expect(setArtifacts).toHaveBeenCalledTimes(1);
    expect(setArtifacts.mock.calls[0][0]).toBe('new-session');
    expect(result.current.status).toBe('ready');
    expect(getRecentSessionEndHint()?.sessionId).toBe('new-session');
  });

  it('does not repeat requests when the persisted cache object is replaced', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ session_id: 'stable-session', memory_candidates: [{ id: 'current', text: 'synthetic', category: 'fact' }] })));
    global.fetch = fetchMock as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const cached: RecapArtifactsV1 = { sessionId: 'stable-session', sessionType: 'open', contextMode: 'life', status: 'ready', memoryCandidates: [] };
    const { rerender } = renderHook(({ artifacts }) => useRecapArtifactsLoader({ sessionId: 'stable-session', artifacts, setArtifacts }), { initialProps: { artifacts: cached } });
    await flushEffects();
    rerender({ artifacts: { ...cached } });
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replaces persisted recap candidates with the fresh authoritative response', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ session_id: 'mem00-current-source', takeaway: 'MEM00 CURRENT', memory_candidates: [{ id: 'new-candidate', text: 'MEM00 CURRENT', category: 'fact' }] })) as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const cached: RecapArtifactsV1 = { sessionId: 'mem00-current-source', sessionType: 'open', contextMode: 'life', status: 'ready', takeaway: 'MEM00 STALE', memoryCandidates: [{ id: 'old-candidate', text: 'MEM00 STALE', category: 'fact' }] };
    const { result } = renderHook(() => useRecapArtifactsLoader({
      sessionId: 'mem00-current-source',
      artifacts: cached,
      setArtifacts,
    }));
    await flushEffects();
    expect(result.current.status).toBe('ready');
    expect(setArtifacts).toHaveBeenLastCalledWith('mem00-current-source', expect.objectContaining({ takeaway: 'MEM00 CURRENT', memoryCandidates: [expect.objectContaining({ id: 'new-candidate' })] }));
  });

  it('preserves the complete canonical review contract when hydrating the recent ledger', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      memories: [{
        id: '05941898-bd0b-4d01-bcd1-9577ca94c6bc',
        text: 'Synthetic review fixture',
        category: 'fact',
        candidate_revision: 7,
        review_state: 'pending_review',
        projection_state: 'absent',
        authority: 'sophia_candidate_ledger',
      }],
      count: 1,
      candidate_count: 1,
      source: 'candidate_ledger',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const hydrated = await hydrateStoredArtifactsWithRecentMemories({
      sessionId: 'synthetic-review', sessionType: 'open', contextMode: 'life',
      status: 'ready', memoryCandidates: [],
    }, 'synthetic-review');
    expect(hydrated?.memoryCandidates).toEqual([expect.objectContaining({
      id: '05941898-bd0b-4d01-bcd1-9577ca94c6bc',
      candidateRevision: 7,
      reviewState: 'pending_review',
      projectionState: 'absent',
      authority: 'sophia_candidate_ledger',
    })]);
  });

  beforeEach(() => {
    localStorage.clear();
    clearRecentSessionEndHint();
    vi.clearAllMocks();
    getSessionHistoryEntryMock.mockReturnValue(undefined);
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

    expect(setArtifacts).toHaveBeenLastCalledWith(
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
      // Pending-review lookup after sparse recap envelope; still empty on first pass.
      .mockResolvedValueOnce(jsonResponse({ memories: [], count: 0, fallbackApplied: true }))
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
          source: 'local_review_overlay',
          candidate_count: 1,
          session_id_received: true,
          next_proxy_forwarded_session_id: true,
          gateway_received_session_id: true,
          trace_id: 'memrecent-loader-test',
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

    expect(setArtifacts).toHaveBeenLastCalledWith(
      'sess-processing',
      expect.objectContaining({
        takeaway: 'A clean ending still counts.',
        memoryCandidates: [
          expect.objectContaining({ id: 'mem-processing-1' }),
        ],
      }),
    );
    expect(result.current.status).toBe('ready');
    expect(result.current.telemetry.recap.pollCount).toBe(2);
    expect(result.current.telemetry.memoryRecent).toMatchObject({
      requested: true,
      sessionIdIncluded: true,
      nextProxyForwardedSessionId: true,
      gatewayReceivedSessionId: true,
      status: 200,
      candidateCount: 1,
      source: 'local_review_overlay',
      safeTraceId: 'memrecent-loader-test',
    });
    expect(typeof result.current.telemetry.memoryRecent.durationMs).toBe('number');
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
    expect(setArtifacts).toHaveBeenLastCalledWith(
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

  it('treats an ended session with no session candidates as terminal empty instead of composing', async () => {
    const setArtifacts = vi.fn();
    const artifacts = {
      sessionId: 'sess-terminal-empty',
      threadId: 'thread-terminal-empty',
      sessionType: 'debrief' as const,
      contextMode: 'work' as const,
      startedAt: '2026-03-03T19:46:00.000Z',
      endedAt: '2026-03-03T20:00:00.000Z',
      takeaway: 'You named the thing clearly.',
      status: 'ready' as const,
      memoryCandidates: [],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      session_id: artifacts.sessionId, started_at: artifacts.startedAt, ended_at: artifacts.endedAt,
      takeaway: artifacts.takeaway, memory_candidates: [],
    })).mockResolvedValueOnce(
      jsonResponse({
        memories: [],
        count: 0,
        candidate_count: 0,
        source: 'local_review_overlay',
        empty_reason: 'no_session_candidates',
        unavailable: false,
        session_id_received: true,
        next_proxy_forwarded_session_id: true,
        gateway_received_session_id: true,
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-terminal-empty',
        artifacts,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/memory/recent?status=pending_review&session_id=sess-terminal-empty&started_at=2026-03-03T19%3A46%3A00.000Z&ended_at=2026-03-03T20%3A00%3A00.000Z',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.current.status).toBe('ready');
    // The fresh source replaces the persisted object once. The cache itself
    // is no longer a loader-effect dependency and cannot create a fetch loop.
    expect(setArtifacts).toHaveBeenCalledTimes(1);
    expect(result.current.telemetry.memoryRecent).toMatchObject({
      requested: true,
      terminal: true,
      emptyReason: 'no_session_candidates',
      candidateCount: 0,
      source: 'local_review_overlay',
    });
    expect(result.current.telemetry.recap.terminalReason).toBe('no_session_candidates');
  });

  it('surfaces memory-recent unavailable responses instead of reporting no results', async () => {
    const setArtifacts = vi.fn();
    const artifacts = {
      sessionId: 'sess-unavailable',
      sessionType: 'debrief' as const,
      contextMode: 'work' as const,
      endedAt: '2026-03-03T20:00:00.000Z',
      takeaway: 'A partial recap exists.',
      status: 'ready' as const,
      memoryCandidates: [],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      session_id: artifacts.sessionId, ended_at: artifacts.endedAt,
      takeaway: artifacts.takeaway, memory_candidates: [],
    })).mockResolvedValueOnce(
      jsonResponse({
        memories: [],
        count: 0,
        candidate_count: 0,
        source: 'error',
        unavailable: true,
        empty_reason: 'no_session_candidates',
        session_id_received: true,
        next_proxy_forwarded_session_id: true,
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useRecapArtifactsLoader({
        sessionId: 'sess-unavailable',
        artifacts,
        setArtifacts,
      }),
    );

    await flushEffects();

    expect(result.current.status).toBe('unavailable');
    expect(result.current.telemetry.memoryRecent).toMatchObject({
      requested: true,
      unavailable: true,
      terminal: false,
      source: 'error',
    });
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
    expect(setArtifacts).toHaveBeenLastCalledWith(
      'sess-reviewed',
      expect.objectContaining({ takeaway: 'The important part already landed.' }),
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
    expect(result.current.telemetry.memoryRecent).toMatchObject({
      requested: false,
      memoryRecentNotRequestedReason: 'source_not_found',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

const POLL_SESSION = 'poll-session';
const POLL_RECAP_URL = `/api/sophia/sessions/${POLL_SESSION}/recap`;
const canonicalRecap = (state: CanonicalFixtureState, options?: Parameters<typeof canonicalRecapFor>[2]) =>
  canonicalRecapFor(POLL_SESSION, state, options);

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function recapGets(fetchMock: ReturnType<typeof vi.fn>, url = POLL_RECAP_URL) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === url);
}

describe('useRecapArtifactsLoader canonical processing polling', () => {
  // A fresh function per render would re-run the loader effect every render.
  let stablePublish = vi.fn();

  beforeEach(() => {
    stablePublish = vi.fn();
    localStorage.clear();
    clearRecentSessionEndHint();
    vi.clearAllMocks();
    getSessionHistoryEntryMock.mockReturnValue(undefined);
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-reads a canonical processing recap and shows the review without a manual retry (codex-054)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('processing')))
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('complete', { candidates: [canonicalCandidate(1), canonicalCandidate(2)] })));
    global.fetch = fetchMock as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const { result } = renderHook(() => useRecapArtifactsLoader({ sessionId: POLL_SESSION, artifacts: null, setArtifacts }));
    await settle();

    expect(result.current.status).toBe('processing');
    expect(result.current.autoRefreshing).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1500);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ method: 'GET', cache: 'no-store' });
    expect(result.current.status).toBe('ready');
    expect(result.current.autoRefreshing).toBe(false);
    expect(setArtifacts).toHaveBeenLastCalledWith(POLL_SESSION, expect.objectContaining({
      status: 'ready',
      memoryCandidates: [
        expect.objectContaining({ id: canonicalCandidate(1).candidate_id, candidateRevision: 1, reviewState: 'pending_review' }),
        expect.objectContaining({ id: canonicalCandidate(2).candidate_id }),
      ],
    }));
    expect(markRecapViewedMock).toHaveBeenCalledWith(POLL_SESSION);

    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the processing view on screen while a re-read is in flight', async () => {
    let finishPoll!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('processing')))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPoll = resolve; }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useRecapArtifactsLoader({ sessionId: POLL_SESSION, artifacts: null, setArtifacts: stablePublish }));
    await settle();
    await advance(1500);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('processing');

    await act(async () => { finishPoll(jsonResponse(canonicalRecap('complete', { candidates: [canonicalCandidate(1)] }))); });
    await settle();
    expect(result.current.status).toBe('ready');
  });

  it.each([
    ['nothing was produced', {}, 'ready'],
    ['produced candidates are no longer eligible', { produced: 2, approved: 1, invalidated: 1 }, 'no_pending'],
    ['every produced candidate was already decided', { produced: 2, approved: 1, rejected: 1 }, 'reviewed'],
  ] as const)('ends polling in the truthful empty state when complete and %s', async (_label, summary, expected) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('processing')))
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('complete', { summary })));
    global.fetch = fetchMock as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const { result } = renderHook(() => useRecapArtifactsLoader({ sessionId: POLL_SESSION, artifacts: null, setArtifacts }));
    await settle();
    await advance(1500);

    expect(result.current.status).toBe(expected);
    expect(result.current.autoRefreshing).toBe(false);
    expect(setArtifacts).toHaveBeenLastCalledWith(POLL_SESSION, expect.objectContaining({ status: 'ready', memoryCandidates: [] }));
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after the bounded budget and reports still processing, not an error', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(canonicalRecap('processing'))));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useRecapArtifactsLoader({ sessionId: POLL_SESSION, artifacts: null, setArtifacts: stablePublish }));
    await settle();

    await advance(60_000);
    expect(result.current.status).toBe('processing');
    expect(result.current.autoRefreshing).toBe(true);

    await advance(60_000);
    // Initial read plus 11 re-reads (1.5 s backing off to 15 s, ~70 s of waiting).
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(recapGets(fetchMock)).toHaveLength(12);
    expect(result.current.status).toBe('processing');
    expect(result.current.autoRefreshing).toBe(false);
    expect(result.current.telemetry.recap.errorCode).toBeNull();

    await advance(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it('restarts a fresh budget on manual refresh after exhaustion', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(canonicalRecap('processing'))));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useRecapArtifactsLoader({ sessionId: POLL_SESSION, artifacts: null, setArtifacts: stablePublish }));
    await settle();
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(result.current.autoRefreshing).toBe(false);

    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(canonicalRecap('processing'))))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(canonicalRecap('complete', { candidates: [canonicalCandidate(3)] }))));
    act(() => { result.current.refresh(); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(13);
    expect(result.current.status).toBe('processing');
    expect(result.current.autoRefreshing).toBe(true);

    await advance(1500);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    expect(result.current.status).toBe('ready');
  });

  it('treats awaiting_finalization like processing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('awaiting_finalization')))
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('awaiting_finalization')))
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('complete', { candidates: [canonicalCandidate(1)] })));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useRecapArtifactsLoader({ sessionId: POLL_SESSION, artifacts: null, setArtifacts: stablePublish }));
    await settle();
    expect(result.current.status).toBe('processing');
    expect(result.current.autoRefreshing).toBe(true);

    await advance(1500);
    expect(result.current.status).toBe('processing');
    await advance(1500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe('ready');
  });

  it('stops polling on unmount', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(canonicalRecap('processing'))));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { unmount } = renderHook(() => useRecapArtifactsLoader({ sessionId: POLL_SESSION, artifacts: null, setArtifacts: stablePublish }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling the old session when the session changes', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => Promise.resolve(input === POLL_RECAP_URL
      ? jsonResponse(canonicalRecap('processing'))
      : jsonResponse({ detail: 'Not found' }, 404)));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(({ sessionId }) => useRecapArtifactsLoader({ sessionId, artifacts: null, setArtifacts: stablePublish }), {
      initialProps: { sessionId: POLL_SESSION },
    });
    await settle();
    rerender({ sessionId: 'other-session' });
    await settle();
    await advance(120_000);

    expect(recapGets(fetchMock)).toHaveLength(1);
    expect(recapGets(fetchMock, '/api/sophia/sessions/other-session/recap')).toHaveLength(1);
    expect(result.current.status).toBe('not_found');
  });

  it('drops an in-flight re-read that resolves after the session changed', async () => {
    let finishPoll!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(canonicalRecap('processing')))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPoll = resolve; }))
      .mockResolvedValue(jsonResponse({ detail: 'Not found' }, 404));
    global.fetch = fetchMock as unknown as typeof fetch;
    const setArtifacts = vi.fn();
    const { result, rerender } = renderHook(({ sessionId }) => useRecapArtifactsLoader({ sessionId, artifacts: null, setArtifacts }), {
      initialProps: { sessionId: POLL_SESSION },
    });
    await settle();
    await advance(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    rerender({ sessionId: 'other-session' });
    await settle();
    await act(async () => { finishPoll(jsonResponse(canonicalRecap('complete', { candidates: [canonicalCandidate(1, 'STALE CANDIDATE')] }))); });
    await settle();

    expect(JSON.stringify(setArtifacts.mock.calls)).not.toContain('STALE CANDIDATE');
    expect(result.current.status).toBe('not_found');
  });

  it('cancels the previous owner polling and gives the new owner its own budget', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(canonicalRecap('processing'))));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(({ ownerId }: { ownerId: string | null }) => useRecapArtifactsLoader({
      sessionId: POLL_SESSION, ownerId, artifacts: null, setArtifacts: stablePublish,
    }), { initialProps: { ownerId: 'owner-a' as string | null } });
    await settle();
    await advance(500);
    rerender({ ownerId: 'owner-b' });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // owner-a's re-read would have fired at 1.5 s; owner-b's fires at 2.0 s.
    await advance(1100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(400);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    rerender({ ownerId: null });
    await settle();
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe('loading');
    expect(result.current.autoRefreshing).toBe(false);
  });
});
