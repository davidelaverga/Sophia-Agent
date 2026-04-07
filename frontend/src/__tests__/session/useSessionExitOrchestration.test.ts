import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionExitOrchestration } from '../../app/session/useSessionExitOrchestration';

const useSessionExitFlowMock = vi.fn();
const useSessionExitProtectionMock = vi.fn();

vi.mock('../../app/session/useSessionExitFlow', () => ({
  useSessionExitFlow: (...args: unknown[]) => useSessionExitFlowMock(...args),
}));

vi.mock('../../app/session/useSessionExitProtection', () => ({
  useSessionExitProtection: (...args: unknown[]) => useSessionExitProtectionMock(...args),
}));

describe('useSessionExitOrchestration', () => {
  it('composes exit flow with exit protection using computed in-progress gate', () => {
    const flowResult = {
      showExitConfirm: false,
      showDebriefOffer: true,
      debriefData: null,
      isNavigatingToRecap: false,
      openExitConfirm: vi.fn(),
      handleEndSession: vi.fn(),
      handleVoiceEndSession: vi.fn(),
      handleCancelExit: vi.fn(),
      handleStartDebrief: vi.fn(),
      handleSkipToRecap: vi.fn(),
    };

    useSessionExitFlowMock.mockReturnValue(flowResult);

    const { result } = renderHook(() =>
      useSessionExitOrchestration({
        isReadOnly: false,
        isSophiaResponding: true,
        stopStreaming: vi.fn(),
        setEnding: vi.fn(),
        sessionId: 'session-1',
        sessionStartedAt: '2026-03-02T00:00:00.000Z',
        sessionPresetType: 'chat',
        sessionContextMode: 'life',
        messageCount: 4,
        endSessionStore: vi.fn(),
        clearSessionStore: vi.fn(),
        clearBootstrap: vi.fn(),
        navigateTo: vi.fn(),
        promoteToDebriefMode: vi.fn(),
        startDebriefWithLLM: vi.fn(),
        persistedSessionId: 'session-1',
        responseMode: 'voice',
        messages: [],
        updateMessages: vi.fn(),
        isEnding: false,
      })
    );

    expect(useSessionExitFlowMock).toHaveBeenCalledTimes(1);
    expect(useSessionExitProtectionMock).toHaveBeenCalledTimes(1);

    const protectionArgs = useSessionExitProtectionMock.mock.calls[0][0] as {
      isExitInProgress: boolean;
      openExitConfirm: unknown;
      responseMode: string;
    };

    expect(protectionArgs.isExitInProgress).toBe(true);
    expect(protectionArgs.openExitConfirm).toBe(flowResult.openExitConfirm);
    expect(protectionArgs.responseMode).toBe('voice');
    expect(result.current.handleVoiceEndSession).toBe(flowResult.handleVoiceEndSession);
  });
});