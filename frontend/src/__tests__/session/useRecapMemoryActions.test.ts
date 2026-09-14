import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRecapMemoryActions } from '../../app/recap/[sessionId]/useRecapMemoryActions';

describe('useRecapMemoryActions', () => {
  it.each([200, 503])('ignores an old-owner discard response with status %s', async (status) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const setArtifacts = vi.fn(), setDecision = vi.fn(), showToast = vi.fn();
    const { result, rerender } = renderHook(({ ownerId }) => useRecapMemoryActions({
      ownerId, artifacts: { sessionId: 's', sessionType: 'open', contextMode: 'life', status: 'ready',
        memoryCandidates: [{ id: 'c1', text: 'SYNTHETIC', candidateRevision: 1 }] },
      decisions: [], sessionId: 's', setArtifacts, setDecision, showToast,
      commitMemories: vi.fn(), navigateAfterSave: vi.fn(),
    }), { initialProps: { ownerId: 'a' } });
    act(() => result.current.handleDecisionChange('c1', 'discarded'));
    rerender({ ownerId: 'b' });
    await act(async () => {
      finish(new Response(JSON.stringify({ discarded: ['c1'], errors: [] }), { status }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(setArtifacts).not.toHaveBeenCalled();
    expect(setDecision).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(result.current.actionError).toBeNull();
    expect(result.current.actionRetry).toBeNull();
  });
  it.each(['owner-cycle', 'unmount', 'signed-out'])('cannot apply a pending save after %s', async (change) => {
    let finish!: (value: { committed: string[]; discarded: string[]; errors: [] }) => void;
    const commitMemories = vi.fn(() => new Promise<{ committed: string[]; discarded: string[]; errors: [] }>(resolve => { finish = resolve; }));
    const showToast = vi.fn(), navigateAfterSave = vi.fn();
    const { result, rerender, unmount } = renderHook(({ ownerId }: { ownerId: string | null }) => useRecapMemoryActions({
      ownerId, artifacts: null, decisions: [{ candidateId: 'c1', decision: 'approved' }], sessionId: 'same-session',
      setArtifacts: vi.fn(), setDecision: vi.fn(), commitMemories, showToast, navigateAfterSave,
    }), { initialProps: { ownerId: 'a' } });
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSaveApproved(); });
    if (change === 'unmount') unmount();
    else if (change === 'signed-out') rerender({ ownerId: null });
    else { rerender({ ownerId: 'b' }); rerender({ ownerId: 'a' }); }
    await act(async () => { finish({ committed: ['c1'], discarded: [], errors: [] }); await pending; });
    expect(showToast).not.toHaveBeenCalled();
    expect(navigateAfterSave).not.toHaveBeenCalled();
    expect(result.current.saveSuccess).toBeNull();
  });
  it.each(['approved', 'edited'] as const)('does not claim a %s draft is canonically saved', (decision) => {
    const showToast = vi.fn();
    const setDecision = vi.fn();
    const commitMemories = vi.fn();
    const { result } = renderHook(() => useRecapMemoryActions({
      artifacts: {
        sessionId: 's1', sessionType: 'open', contextMode: 'life', status: 'ready',
        memoryCandidates: [{ id: 'c1', text: 'Synthetic fixture', candidateRevision: 1 }],
      },
      decisions: [], sessionId: 's1', setArtifacts: vi.fn(), setDecision,
      commitMemories, showToast, navigateAfterSave: vi.fn(),
    }));
    act(() => result.current.handleDecisionChange('c1', decision, 'Synthetic refinement'));
    expect(setDecision).toHaveBeenCalledWith('s1', 'c1', decision, 'Synthetic refinement');
    expect(commitMemories).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'info' }));
    expect(showToast.mock.calls.map(([payload]) => payload.message).join(' ')).not.toMatch(/saved/i);
    expect(result.current.saveSuccess).toBeNull();
  });

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

  it('persists discard through the revision-bound canonical review bridge', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ committed: [], discarded: ['mem-real'], errors: [] }),
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
          memoryCandidates: [{ id: 'mem-real', text: 'Memory 1', category: 'identity_profile', candidateRevision: 3 }],
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
      expect(fetchMock).toHaveBeenCalledWith('/api/memory/commit-candidates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: 's1',
          decisions: [{
            candidate_id: 'mem-real',
            decision: 'discard',
            text: 'Memory 1',
            category: 'identity_profile',
            source: 'recap',
            expected_candidate_revision: 3,
            idempotency_key: 'recap-discard:s1:mem-real:3',
          }],
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
});
