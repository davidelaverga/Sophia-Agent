import { act, renderHook } from '@testing-library/react';
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
});
