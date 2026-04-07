import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionQueueOrchestration } from '../../app/session/useSessionQueueOrchestration';

const useSessionQueueRuntimeMock = vi.fn();
const useSessionQueueSyncMock = vi.fn();

vi.mock('../../app/session/useSessionQueueRuntime', () => ({
  useSessionQueueRuntime: (...args: unknown[]) => useSessionQueueRuntimeMock(...args),
}));

vi.mock('../../app/session/useSessionQueueSync', () => ({
  useSessionQueueSync: (...args: unknown[]) => useSessionQueueSyncMock(...args),
}));

describe('useSessionQueueOrchestration', () => {
  it('pipes runtime getters into queue sync wiring', () => {
    const getChatMessages = vi.fn(() => []);
    const getChatStatus = vi.fn(() => 'ready');

    useSessionQueueRuntimeMock.mockReturnValue({
      getChatMessages,
      getChatStatus,
    });

    renderHook(() =>
      useSessionQueueOrchestration({
        chatStatus: 'ready',
        chatMessages: [],
        connectivityStatus: 'online',
        onReconnectOnline: vi.fn(),
        sessionId: 'session-1',
        getQueuedMessages: vi.fn(() => []),
        getQueuedMemoryApprovals: vi.fn(() => []),
        sendMessage: vi.fn(async () => undefined),
        removeFromQueue: vi.fn(),
        incrementRetry: vi.fn(),
        removeMemoryApprovalFromQueue: vi.fn(),
        incrementMemoryApprovalRetry: vi.fn(),
        setChatMessages: vi.fn(),
        showToast: vi.fn(),
      })
    );

    expect(useSessionQueueRuntimeMock).toHaveBeenCalledTimes(1);
    expect(useSessionQueueSyncMock).toHaveBeenCalledTimes(1);

    const syncArgs = useSessionQueueSyncMock.mock.calls[0][0] as {
      getChatMessages: unknown;
      getChatStatus: unknown;
      sessionId: string;
      connectivityStatus: string;
    };

    expect(syncArgs.getChatMessages).toBe(getChatMessages);
    expect(syncArgs.getChatStatus).toBe(getChatStatus);
    expect(syncArgs.sessionId).toBe('session-1');
    expect(syncArgs.connectivityStatus).toBe('online');
  });
});