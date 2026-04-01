import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionStreamOrchestration } from '../../app/session/useSessionStreamOrchestration';

const useSessionStreamContractMock = vi.fn();

vi.mock('../../app/session/useSessionStreamContract', () => ({
  useSessionStreamContract: (...args: unknown[]) => useSessionStreamContractMock(...args),
}));

describe('useSessionStreamOrchestration', () => {
  it('binds stream interrupt handler through setter bridge', () => {
    useSessionStreamContractMock.mockImplementation((params) => ({
      handleDataPart: vi.fn(),
      handleFinish: vi.fn(),
      markStreamTurnStarted: vi.fn(),
      __params: params,
    }));

    const ingestArtifacts = vi.fn();
    const setCurrentContext = vi.fn();
    const setMessageMetadata = vi.fn();

    const { result } = renderHook(() => useSessionStreamOrchestration({
      ingestArtifacts,
      setCurrentContext,
      setMessageMetadata,
      sessionId: 'session-1',
      activeSessionId: 'session-1',
      activeThreadId: 'thread-1',
    }));

    const streamContractCall = useSessionStreamContractMock.mock.calls[0][0] as {
      setInterrupt: (interrupt: { id?: string }) => void;
    };

    const interruptHandler = vi.fn();
    act(() => {
      result.current.setStreamInterruptHandler(interruptHandler);
      streamContractCall.setInterrupt({ id: 'interrupt-1' });
    });

    expect(interruptHandler).toHaveBeenCalledWith({ id: 'interrupt-1' });
  });
});
