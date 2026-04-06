import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRecentSessionEndHint,
  getRecentSessionEndHint,
  markRecentSessionEnd,
} from '../../app/lib/recent-session-end';
import { useRecapArtifactsLoader } from '../../app/recap/[sessionId]/useRecapArtifactsLoader';

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
    vi.useRealTimers();
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
      await vi.advanceTimersByTimeAsync(1500);
    });

    await flushEffects();

    expect(setArtifacts).toHaveBeenCalledWith(
      'sess-processing',
      expect.objectContaining({ takeaway: 'A clean ending still counts.' }),
    );
    expect(result.current.status).toBe('ready');
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