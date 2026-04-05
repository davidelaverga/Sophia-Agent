import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionInterruptOrchestration } from '../../app/session/useSessionInterruptOrchestration';

const useInterruptMock = vi.fn();

vi.mock('../../app/hooks/useInterrupt', () => ({
  useInterrupt: (...args: unknown[]) => useInterruptMock(...args),
}));

describe('useSessionInterruptOrchestration', () => {
  it('binds interrupt select handler and routes interrupt artifacts', () => {
    const handleInterruptSelect = vi.fn(async () => undefined);
    useInterruptMock.mockImplementation((_options) => {
      return {
        pendingInterrupt: null,
        interruptQueue: [],
        resolvedInterrupts: [],
        isResuming: false,
        threadId: null,
        detectedEmotion: null,
        handleInterruptSelect,
        handleInterruptSnooze: vi.fn(),
        handleInterruptDismiss: vi.fn(),
        setInterrupt: vi.fn(),
      };
    });

    const ingestArtifacts = vi.fn();
    const setChatMessages = vi.fn();
    const clearResumeError = vi.fn();
    const handleResumeError = vi.fn();
    const setInterruptSelectHandler = vi.fn();
    const setStreamInterruptHandler = vi.fn();
    const showToast = vi.fn();

    renderHook(() => useSessionInterruptOrchestration({
      sessionId: 'session-1',
      threadId: 'thread-1',
      sessionContextMode: 'life',
      sessionPresetType: 'chat',
      artifacts: null,
      ingestArtifacts,
      setChatMessages,
      clearResumeError,
      handleResumeError,
      setInterruptSelectHandler,
      setStreamInterruptHandler,
      showToast,
    }));

    expect(setInterruptSelectHandler).toHaveBeenCalledWith(handleInterruptSelect);
    expect(setStreamInterruptHandler).toHaveBeenCalled();

    const callArgs = useInterruptMock.mock.calls[0][0] as {
      onArtifacts?: (payload: unknown) => void;
      onResumeSuccess?: (response: string) => void;
      onResumeError?: (error: unknown) => void;
    };

    act(() => {
      callArgs.onArtifacts?.({ memory_candidates: [{ content: 'x' }] });
      callArgs.onResumeSuccess?.('resume ok');
      callArgs.onResumeError?.(new Error('resume fail'));
    });

    expect(ingestArtifacts).toHaveBeenCalledWith({ memory_candidates: [{ content: 'x' }] }, 'interrupt');
    expect(setChatMessages).toHaveBeenCalled();
    expect(clearResumeError).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
    expect(handleResumeError).toHaveBeenCalled();
  });
});
