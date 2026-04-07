import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionQueueSync } from '../../app/session/useSessionQueueSync';
import { useConnectivityStore } from '../../app/stores/connectivity-store';

type ChatMessageLike = {
  id: string;
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
};

describe('useSessionQueueSync', () => {
  beforeEach(() => {
    useConnectivityStore.setState({
      status: 'online',
      messageQueue: [],
      memoryApprovalQueue: [],
      failedAttempts: 0,
      lastChecked: null,
      lastOnline: null,
    });
  });

  it('coalesces equivalent availability pings and removes stale queued bubbles', async () => {
    const sessionId = 'session-1';

    useConnectivityStore.setState({
      messageQueue: [
        {
          id: 'q1',
          content: 'Hello Sophia',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
        {
          id: 'q2',
          content: 'Sophia, are you there?',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    });

    const store = useConnectivityStore.getState();
    const removeFromQueue = vi.fn((messageId: string) => store.removeFromQueue(messageId));
    const setChatMessages = vi.fn();
    const sendMessage = vi.fn(async () => undefined);
    const incrementRetry = vi.fn();

    const getQueuedMessages = (currentSessionId: string) =>
      useConnectivityStore
        .getState()
        .messageQueue.filter((message) => message.sessionId === currentSessionId);

    const deliveredUserMessages: ChatMessageLike[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'Sophia, are you there?' }],
      },
    ];

    renderHook(() =>
      useSessionQueueSync({
        connectivityStatus: 'online',
        sessionId,
        getQueuedMessages,
        getQueuedMemoryApprovals: () => [],
        getChatMessages: () => deliveredUserMessages,
        sendMessage,
        getChatStatus: () => 'ready',
        removeFromQueue,
        incrementRetry,
        removeMemoryApprovalFromQueue: vi.fn(),
        incrementMemoryApprovalRetry: vi.fn(),
        setChatMessages,
        showToast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(removeFromQueue).toHaveBeenCalledWith('q1');
      expect(removeFromQueue).toHaveBeenCalledWith('q2');
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(incrementRetry).not.toHaveBeenCalled();
    expect(setChatMessages).toHaveBeenCalled();
  });

  it('keeps hybrid intent: drops redundant ping but sends substantive + latest ping sequentially', async () => {
    const sessionId = 'session-1';

    useConnectivityStore.setState({
      messageQueue: [
        {
          id: 'q1',
          content: 'Hello Sophia',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
        {
          id: 'q2',
          content: 'I need help with my goals today',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
        {
          id: 'q3',
          content: 'Sophia, are you there?',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    });

    const store = useConnectivityStore.getState();
    const removeFromQueue = vi.fn((messageId: string) => store.removeFromQueue(messageId));
    const incrementRetry = vi.fn();
    const setChatMessages = vi.fn();

    let chatStatus: 'ready' | 'submitted' | 'streaming' | 'error' = 'ready';
    const sendMessage = vi.fn(async (_input: { text: string }) => {
      chatStatus = 'submitted';
      setTimeout(() => {
        chatStatus = 'ready';
      }, 10);
    });

    const getQueuedMessages = (currentSessionId: string) =>
      useConnectivityStore
        .getState()
        .messageQueue.filter((message) => message.sessionId === currentSessionId);

    renderHook(() =>
      useSessionQueueSync({
        connectivityStatus: 'online',
        sessionId,
        getQueuedMessages,
        getQueuedMemoryApprovals: () => [],
        getChatMessages: () => [],
        sendMessage,
        getChatStatus: () => chatStatus,
        removeFromQueue,
        incrementRetry,
        removeMemoryApprovalFromQueue: vi.fn(),
        incrementMemoryApprovalRetry: vi.fn(),
        setChatMessages,
        showToast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(2);
    }, { timeout: 12000 });

    expect(sendMessage.mock.calls.map((call) => call[0].text)).toEqual([
      'I need help with my goals today',
      'Sophia, are you there?',
    ]);
    expect(removeFromQueue).toHaveBeenCalledWith('q1');
    expect(removeFromQueue).toHaveBeenCalledWith('q2');
    expect(removeFromQueue).toHaveBeenCalledWith('q3');
    expect(incrementRetry).not.toHaveBeenCalled();
  });

  it('does not collapse substantive messages even when semantically close', async () => {
    const sessionId = 'session-1';

    useConnectivityStore.setState({
      messageQueue: [
        {
          id: 'q1',
          content: 'I want to improve my discipline this month',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
        {
          id: 'q2',
          content: 'I want to improve my discipline this quarter with a routine',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    });

    const store = useConnectivityStore.getState();
    const removeFromQueue = vi.fn((messageId: string) => store.removeFromQueue(messageId));
    const incrementRetry = vi.fn();

    let chatStatus: 'ready' | 'submitted' | 'streaming' | 'error' = 'ready';
    const sendMessage = vi.fn(async (_input: { text: string }) => {
      chatStatus = 'submitted';
      setTimeout(() => {
        chatStatus = 'ready';
      }, 10);
    });

    const getQueuedMessages = (currentSessionId: string) =>
      useConnectivityStore
        .getState()
        .messageQueue.filter((message) => message.sessionId === currentSessionId);

    renderHook(() =>
      useSessionQueueSync({
        connectivityStatus: 'online',
        sessionId,
        getQueuedMessages,
        getQueuedMemoryApprovals: () => [],
        getChatMessages: () => [],
        sendMessage,
        getChatStatus: () => chatStatus,
        removeFromQueue,
        incrementRetry,
        removeMemoryApprovalFromQueue: vi.fn(),
        incrementMemoryApprovalRetry: vi.fn(),
        setChatMessages: vi.fn(),
        showToast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(2);
    }, { timeout: 12000 });

    expect(sendMessage.mock.calls.map((call) => call[0].text)).toEqual([
      'I want to improve my discipline this month',
      'I want to improve my discipline this quarter with a routine',
    ]);
    expect(removeFromQueue).toHaveBeenCalledWith('q1');
    expect(removeFromQueue).toHaveBeenCalledWith('q2');
    expect(incrementRetry).not.toHaveBeenCalled();
  });

  it('resumes persisted queue while already online after refresh-like remount', async () => {
    const sessionId = 'session-1';

    useConnectivityStore.setState({
      status: 'online',
      messageQueue: [
        {
          id: 'q-refresh-1',
          content: 'Can you help me structure my day?',
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    });

    const store = useConnectivityStore.getState();
    const removeFromQueue = vi.fn((messageId: string) => store.removeFromQueue(messageId));
    const incrementRetry = vi.fn();

    let chatStatus: 'ready' | 'submitted' | 'streaming' | 'error' = 'ready';
    const sendMessage = vi.fn(async (_input: { text: string }) => {
      chatStatus = 'submitted';
      setTimeout(() => {
        chatStatus = 'ready';
      }, 10);
    });

    const getQueuedMessages = (currentSessionId: string) =>
      useConnectivityStore
        .getState()
        .messageQueue.filter((message) => message.sessionId === currentSessionId);

    renderHook(() =>
      useSessionQueueSync({
        connectivityStatus: 'online',
        sessionId,
        getQueuedMessages,
        getQueuedMemoryApprovals: () => [],
        getChatMessages: () => [],
        sendMessage,
        getChatStatus: () => chatStatus,
        removeFromQueue,
        incrementRetry,
        removeMemoryApprovalFromQueue: vi.fn(),
        incrementMemoryApprovalRetry: vi.fn(),
        setChatMessages: vi.fn(),
        showToast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(removeFromQueue).toHaveBeenCalledWith('q-refresh-1');
    }, { timeout: 12000 });

    expect(incrementRetry).not.toHaveBeenCalled();
  });
});
