import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RitualArtifacts } from '../../app/types/session';
import { useSessionArtifactsReducer } from '../../app/session/useSessionArtifactsReducer';

describe('useSessionArtifactsReducer', () => {
  it('ingests artifacts with normalization/filtering and updates live status', () => {
    const storeArtifacts = vi.fn();
    const updateSession = vi.fn();

    const { result } = renderHook(() =>
      useSessionArtifactsReducer({
        sessionId: 'session-1',
        artifacts: null,
        storeArtifacts,
        updateSession,
      })
    );

    act(() => {
      result.current.ingestArtifacts(
        {
          takeaway: 'Session completed',
          reflection_candidate: { prompt: 'General reflection prompt' },
          memory_candidates: [
            {
              text: 'I value calm focus',
              category: 'emotional_patterns',
              confidence: 0.92,
            },
          ],
        },
        'stream'
      );
    });

    expect(storeArtifacts).toHaveBeenCalledTimes(1);
    expect(storeArtifacts).toHaveBeenCalledWith(
      expect.objectContaining<RitualArtifacts>({
        takeaway: '',
        memory_candidates: [
          expect.objectContaining({
            memory: 'I value calm focus',
            category: 'emotional_patterns',
            confidence: 0.92,
          }),
        ],
      })
    );

    expect(result.current.artifactStatus).toEqual({
      takeaway: 'capturing',
      reflection: 'waiting',
      memories: 'ready',
    });
  });

  it('applies memory candidate updates through centralized owner', () => {
    const storeArtifacts = vi.fn();
    const updateSession = vi.fn();

    const { result } = renderHook(() =>
      useSessionArtifactsReducer({
        sessionId: 'session-1',
        artifacts: null,
        storeArtifacts,
        updateSession,
      })
    );

    act(() => {
      result.current.ingestArtifacts(
        {
          takeaway: 'Strong close',
          memory_candidates: [{ text: 'Candidate A' }],
        },
        'stream'
      );
    });

    act(() => {
      result.current.applyMemoryCandidates([]);
    });

    expect(storeArtifacts).toHaveBeenCalledTimes(2);
    expect(storeArtifacts).toHaveBeenLastCalledWith(
      expect.objectContaining<RitualArtifacts>({
        takeaway: 'Strong close',
        memory_candidates: [],
      })
    );

    expect(result.current.artifactStatus).toEqual({
      takeaway: 'ready',
      reflection: 'capturing',
      memories: 'waiting',
    });
  });

  it('does not allow companion artifacts to overwrite existing takeaway', () => {
    const storeArtifacts = vi.fn();
    const updateSession = vi.fn();

    const { result } = renderHook(() =>
      useSessionArtifactsReducer({
        sessionId: 'session-1',
        artifacts: null,
        storeArtifacts,
        updateSession,
      })
    );

    act(() => {
      result.current.ingestArtifacts(
        { takeaway: 'Main ritual takeaway' },
        'stream'
      );
    });

    act(() => {
      result.current.ingestArtifacts(
        {
          takeaway: 'Companion quick action takeaway',
          memory_candidates: [{ text: 'Companion memory candidate' }],
        },
        'companion'
      );
    });

    expect(storeArtifacts).toHaveBeenLastCalledWith(
      expect.objectContaining<RitualArtifacts>({
        takeaway: 'Main ritual takeaway',
        memory_candidates: [
          expect.objectContaining({ memory: 'Companion memory candidate' }),
        ],
      })
    );
  });

  it('resets artifacts and status on session change', () => {
    const storeArtifacts = vi.fn();
    const updateSession = vi.fn();

    const { rerender, result } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useSessionArtifactsReducer({
          sessionId,
          artifacts: null,
          storeArtifacts,
          updateSession,
        }),
      { initialProps: { sessionId: 'session-1' } }
    );

    act(() => {
      result.current.ingestArtifacts(
        { takeaway: 'Something meaningful', memory_candidates: [{ text: 'Candidate A' }] },
        'stream'
      );
    });

    rerender({ sessionId: 'session-2' });

    expect(updateSession).toHaveBeenCalledWith({ artifacts: undefined, summary: undefined });
    expect(result.current.artifactStatus).toEqual({
      takeaway: 'waiting',
      reflection: 'waiting',
      memories: 'waiting',
    });
  });
});
