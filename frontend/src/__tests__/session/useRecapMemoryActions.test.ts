import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRecapMemoryActions } from '../../app/recap/[sessionId]/useRecapMemoryActions';

describe('useRecapMemoryActions', () => {
  it('commits approved decisions before reporting success', async () => {
    vi.useFakeTimers();

    const commitMemories = vi.fn(async () => ({ committed: ['c1'], discarded: [], errors: [] }));
    const showToast = vi.fn();
    const navigateAfterSave = vi.fn();

    const { result } = renderHook(() =>
      useRecapMemoryActions({
        artifacts: {
          sessionId: 's1',
          sessionType: 'open',
          contextMode: 'life',
          status: 'ready',
          memoryCandidates: [{ id: 'c1', text: 'Memory 1' }],
        },
        decisions: [{ candidateId: 'c1', decision: 'approved' }],
        sessionId: 's1',
        setArtifacts: vi.fn(),
        setDecision: vi.fn(),
        commitMemories,
        showToast,
        navigateAfterSave,
      })
    );

    await act(async () => {
      await result.current.handleSaveApproved();
    });

    expect(commitMemories).toHaveBeenCalledWith('s1');
    expect(result.current.saveSuccess).toEqual({ count: 1 });

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(navigateAfterSave).toHaveBeenCalledTimes(1);
    expect(navigateAfterSave).toHaveBeenCalledWith({ committed: ['c1'], discarded: [], errors: [] });
    vi.useRealTimers();
  });

  it('shows action error when commit fails', async () => {
    const commitMemories = vi.fn(async () => ({
      committed: [],
      discarded: [],
      errors: [{ candidate_id: 'c1', message: 'failed' }],
    }));

    const { result } = renderHook(() =>
      useRecapMemoryActions({
        artifacts: {
          sessionId: 's1',
          sessionType: 'open',
          contextMode: 'life',
          status: 'ready',
          memoryCandidates: [{ id: 'c1', text: 'Memory 1' }],
        },
        decisions: [{ candidateId: 'c1', decision: 'approved' }],
        sessionId: 's1',
        setArtifacts: vi.fn(),
        setDecision: vi.fn(),
        commitMemories,
        showToast: vi.fn(),
        navigateAfterSave: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.handleSaveApproved();
    });

    expect(result.current.actionError).toBeTruthy();
    expect(result.current.saveSuccess).toBeNull();
    expect(result.current.actionRetry).toBeTypeOf('function');
  });

  it('persists discard state for real memory ids without deleting the record', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'mem-real', metadata: { status: 'discarded' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const setArtifacts = vi.fn();
    const setDecision = vi.fn();
    const showToast = vi.fn();

    const { result } = renderHook(() =>
      useRecapMemoryActions({
        artifacts: {
          sessionId: 's1',
          sessionType: 'open',
          contextMode: 'life',
          status: 'ready',
          memoryCandidates: [{ id: 'mem-real', text: 'Memory 1', category: 'identity_profile' }],
        },
        decisions: [],
        sessionId: 's1',
        setArtifacts,
        setDecision,
        commitMemories: vi.fn(async () => ({ committed: [], discarded: [], errors: [] })),
        showToast,
        navigateAfterSave: vi.fn(),
      })
    );

    await act(async () => {
      result.current.handleDecisionChange('mem-real', 'discarded');
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/memories/mem-real', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          metadata: {
            status: 'discarded',
            category: 'identity_profile',
          },
        }),
      });
    });

    expect(setDecision).toHaveBeenCalledWith('s1', 'mem-real', 'discarded');
    expect(setArtifacts).toHaveBeenCalledWith('s1', {
      sessionId: 's1',
      sessionType: 'open',
      contextMode: 'life',
      status: 'ready',
      memoryCandidates: [],
    });
    expect(showToast).toHaveBeenCalledWith({
      message: 'Memory discarded.',
      variant: 'info',
      durationMs: 1800,
    });
  });

  it('removes a real memory optimistically before the discard request resolves', async () => {
    let resolveFetch: ((value: { ok: boolean; status: number; json: () => Promise<{ id: string; metadata: { status: string } }> }) => void) | null = null;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const setArtifacts = vi.fn();
    const setDecision = vi.fn();
    const showToast = vi.fn();

    const { result } = renderHook(() =>
      useRecapMemoryActions({
        artifacts: {
          sessionId: 's1',
          sessionType: 'open',
          contextMode: 'life',
          status: 'ready',
          memoryCandidates: [{ id: 'mem-real', text: 'Memory 1', category: 'identity_profile' }],
        },
        decisions: [],
        sessionId: 's1',
        setArtifacts,
        setDecision,
        commitMemories: vi.fn(async () => ({ committed: [], discarded: [], errors: [] })),
        showToast,
        navigateAfterSave: vi.fn(),
      })
    );

    await act(async () => {
      result.current.handleDecisionChange('mem-real', 'discarded');
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/memories/mem-real', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          status: 'discarded',
          category: 'identity_profile',
        },
      }),
    });
    expect(setDecision).toHaveBeenCalledWith('s1', 'mem-real', 'discarded');
    expect(setArtifacts).toHaveBeenCalledWith('s1', {
      sessionId: 's1',
      sessionType: 'open',
      contextMode: 'life',
      status: 'ready',
      memoryCandidates: [],
    });
    expect(showToast).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch?.({
        ok: true,
        status: 200,
        json: async () => ({ id: 'mem-real', metadata: { status: 'discarded' } }),
      });
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledWith({
      message: 'Memory discarded.',
      variant: 'info',
      durationMs: 1800,
    });
  });

  it('restores the candidate when a real-memory discard fails', async () => {
    let rejectFetch: ((reason?: unknown) => void) | null = null;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((_, reject) => {
        rejectFetch = reject;
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const initialArtifacts = {
      sessionId: 's1',
      sessionType: 'open' as const,
      contextMode: 'life' as const,
      status: 'ready' as const,
      memoryCandidates: [{ id: 'mem-real', text: 'Memory 1', category: 'identity_profile' }],
    };

    const artifactsState: { current: typeof initialArtifacts } = { current: initialArtifacts };
    let rerenderHook: ((props: { artifacts: typeof initialArtifacts }) => void) | null = null;
    const setArtifacts = vi.fn((_: string, nextArtifacts: typeof initialArtifacts) => {
      artifactsState.current = nextArtifacts;
      rerenderHook?.({ artifacts: nextArtifacts });
    });
    const setDecision = vi.fn();

    const { result, rerender } = renderHook(({ artifacts }) =>
      useRecapMemoryActions({
        artifacts,
        decisions: [],
        sessionId: 's1',
        setArtifacts,
        setDecision,
        commitMemories: vi.fn(async () => ({ committed: [], discarded: [], errors: [] })),
        showToast: vi.fn(),
        navigateAfterSave: vi.fn(),
      }),
      { initialProps: { artifacts: artifactsState.current } }
    );
    rerenderHook = rerender;

    await act(async () => {
      result.current.handleDecisionChange('mem-real', 'discarded');
      await Promise.resolve();
    });

    await act(async () => {
      rejectFetch?.(new Error('network failed'));
      await Promise.resolve();
    });

    expect(setArtifacts).toHaveBeenNthCalledWith(1, 's1', {
      sessionId: 's1',
      sessionType: 'open',
      contextMode: 'life',
      status: 'ready',
      memoryCandidates: [],
    });
    expect(setArtifacts).toHaveBeenNthCalledWith(2, 's1', {
      sessionId: 's1',
      sessionType: 'open',
      contextMode: 'life',
      status: 'ready',
      memoryCandidates: [{ id: 'mem-real', text: 'Memory 1', category: 'identity_profile' }],
    });
    expect(setDecision).toHaveBeenNthCalledWith(1, 's1', 'mem-real', 'discarded');
    expect(setDecision).toHaveBeenNthCalledWith(2, 's1', 'mem-real', 'idle');
    expect(result.current.actionError).toBe("Couldn't remove this memory. Try again?");
  });
});
