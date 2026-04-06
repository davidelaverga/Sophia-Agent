import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionExitFlow } from '../../app/session/useSessionExitFlow';

const hapticMock = vi.fn();
const endSessionApiMock = vi.fn();
const submitDebriefDecisionMock = vi.fn();
const isSuccessMock = vi.fn();
const addSessionMock = vi.fn();
const setRecapArtifactsMock = vi.fn();
const showToastMock = vi.fn();
const teardownSessionClientStateMock = vi.fn();

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: (...args: unknown[]) => hapticMock(...args),
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  endSession: (...args: unknown[]) => endSessionApiMock(...args),
  submitDebriefDecision: (...args: unknown[]) => submitDebriefDecisionMock(...args),
  isSuccess: (...args: unknown[]) => isSuccessMock(...args),
}));

vi.mock('../../app/stores/session-history-store', () => ({
  useSessionHistoryStore: {
    getState: () => ({
      addSession: addSessionMock,
    }),
  },
}));

vi.mock('../../app/stores/recap-store', () => ({
  useRecapStore: {
    getState: () => ({
      setArtifacts: setRecapArtifactsMock,
    }),
  },
}));

vi.mock('../../app/stores/ui-store', () => ({
  useUiStore: {
    getState: () => ({
      showToast: showToastMock,
    }),
  },
}));

vi.mock('../../app/lib/session-teardown', () => ({
  teardownSessionClientState: (...args: unknown[]) => teardownSessionClientStateMock(...args),
}));

describe('useSessionExitFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('separates start debrief from skip to recap behavior', async () => {
    endSessionApiMock.mockResolvedValue({
      success: true,
      data: {
        session_id: 'session-1',
        ended_at: '2026-03-03T18:00:00.000Z',
        duration_minutes: 12,
        turn_count: 4,
        offer_debrief: true,
        debrief_prompt: 'Want a quick debrief?',
        recap_artifacts: {
          takeaway: 'You stayed focused.',
        },
      },
    });

    isSuccessMock.mockImplementation((result: { success?: boolean }) => result.success === true);
    submitDebriefDecisionMock.mockResolvedValue({
      success: true,
      data: {
        session_id: 'session-1',
        decision: 'debrief',
        recorded_at: '2026-03-03T18:00:05.000Z',
      },
    });

    const setEndingMock = vi.fn();
    const endSessionStoreMock = vi.fn();
    const clearSessionStoreMock = vi.fn();
    const clearBootstrapMock = vi.fn();
    const navigateToMock = vi.fn();
    const promoteToDebriefModeMock = vi.fn();
    const startDebriefWithLLMMock = vi.fn();

    const { result } = renderHook(() =>
      useSessionExitFlow({
        isReadOnly: false,
        isSophiaResponding: false,
        stopStreaming: vi.fn(),
        setEnding: setEndingMock,
        sessionId: 'session-1',
        sessionStartedAt: '2026-03-03T17:45:00.000Z',
        sessionPresetType: 'open',
        sessionContextMode: 'life',
        messageCount: 4,
        endSessionStore: endSessionStoreMock,
        clearSessionStore: clearSessionStoreMock,
        clearBootstrap: clearBootstrapMock,
        navigateTo: navigateToMock,
        promoteToDebriefMode: promoteToDebriefModeMock,
        startDebriefWithLLM: startDebriefWithLLMMock,
      })
    );

    await act(async () => {
      await result.current.handleEndSession();
    });

    expect(result.current.showDebriefOffer).toBe(true);

    await act(async () => {
      result.current.handleStartDebrief();
    });

    expect(promoteToDebriefModeMock).toHaveBeenCalledTimes(1);
    expect(startDebriefWithLLMMock).toHaveBeenCalledTimes(1);
    expect(submitDebriefDecisionMock).toHaveBeenCalledWith({
      session_id: 'session-1',
      decision: 'debrief',
    });
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(endSessionStoreMock).not.toHaveBeenCalled();
    expect(clearSessionStoreMock).not.toHaveBeenCalled();

    await act(async () => {
      result.current.handleSkipToRecap();
    });

    expect(submitDebriefDecisionMock).toHaveBeenCalledWith({
      session_id: 'session-1',
      decision: 'skip',
    });
    expect(navigateToMock).toHaveBeenCalledWith('/recap/session-1');
    expect(endSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(clearSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(clearBootstrapMock).toHaveBeenCalledTimes(1);
    expect(teardownSessionClientStateMock).toHaveBeenCalledWith('session-1');
  });

  it('does not offer debrief again when ending from debrief mode', async () => {
    endSessionApiMock.mockResolvedValue({
      success: true,
      data: {
        session_id: 'session-2',
        ended_at: '2026-03-03T19:00:00.000Z',
        duration_minutes: 20,
        turn_count: 8,
        offer_debrief: true,
        debrief_prompt: 'Want a quick debrief?',
        recap_artifacts: {
          takeaway: 'Solid reflection.',
        },
      },
    });

    isSuccessMock.mockImplementation((result: { success?: boolean }) => result.success === true);

    const navigateToMock = vi.fn();

    const { result } = renderHook(() =>
      useSessionExitFlow({
        isReadOnly: false,
        isSophiaResponding: false,
        stopStreaming: vi.fn(),
        setEnding: vi.fn(),
        sessionId: 'session-2',
        sessionStartedAt: '2026-03-03T18:30:00.000Z',
        sessionPresetType: 'debrief',
        sessionContextMode: 'life',
        messageCount: 8,
        endSessionStore: vi.fn(),
        clearSessionStore: vi.fn(),
        clearBootstrap: vi.fn(),
        navigateTo: navigateToMock,
        promoteToDebriefMode: vi.fn(),
        startDebriefWithLLM: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.handleEndSession();
    });

    expect(endSessionApiMock).toHaveBeenCalledWith({
      session_id: 'session-2',
      offer_debrief: false,
    });
    expect(result.current.showDebriefOffer).toBe(false);
    expect(result.current.showEmergence).toBe(true);

    await act(async () => {
      result.current.handleEmergenceComplete();
    });

    expect(result.current.showFeedback).toBe(true);

    await act(async () => {
      result.current.handleFeedbackComplete();
    });

    expect(navigateToMock).toHaveBeenCalledWith('/recap/session-2');
  });

  it('persists live session artifacts for recap when the end-session response has no recap_artifacts', async () => {
    endSessionApiMock.mockResolvedValue({
      success: true,
      data: {
        session_id: 'session-3',
        ended_at: '2026-03-03T20:00:00.000Z',
        duration_minutes: 14,
        turn_count: 6,
        offer_debrief: false,
        debrief_prompt: undefined,
        recap_artifacts: undefined,
      },
    });

    isSuccessMock.mockImplementation((result: { success?: boolean }) => result.success === true);

    const navigateToMock = vi.fn();

    const { result } = renderHook(() =>
      useSessionExitFlow({
        isReadOnly: false,
        isSophiaResponding: false,
        stopStreaming: vi.fn(),
        setEnding: vi.fn(),
        sessionId: 'session-3',
        sessionStartedAt: '2026-03-03T19:46:00.000Z',
        sessionPresetType: 'open',
        sessionContextMode: 'life',
        messageCount: 6,
        endSessionStore: vi.fn(),
        clearSessionStore: vi.fn(),
        clearBootstrap: vi.fn(),
        navigateTo: navigateToMock,
        promoteToDebriefMode: vi.fn(),
        startDebriefWithLLM: vi.fn(),
        currentArtifacts: {
          takeaway: 'You settled into the truth instead of pushing past it.',
          reflection_candidate: {
            prompt: 'What changed once you stopped forcing the outcome?',
          },
          memory_candidates: [
            {
              memory: 'I can slow down without losing momentum.',
              category: 'reflective',
              confidence: 0.91,
            },
          ],
        },
      })
    );

    await act(async () => {
      await result.current.handleEndSession();
    });

    expect(setRecapArtifactsMock).toHaveBeenCalledWith(
      'session-3',
      expect.objectContaining({
        takeaway: 'You settled into the truth instead of pushing past it.',
        reflectionCandidate: expect.objectContaining({
          prompt: 'What changed once you stopped forcing the outcome?',
        }),
      }),
    );
  });
});
