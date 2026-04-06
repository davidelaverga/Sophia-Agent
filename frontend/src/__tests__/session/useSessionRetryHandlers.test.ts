import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionRetryHandlers } from '../../app/session/useSessionRetryHandlers';

const recoverFromDisconnectMock = vi.fn();

vi.mock('../../app/lib/stream-recovery', () => ({
  recoverFromDisconnect: (...args: unknown[]) => recoverFromDisconnectMock(...args),
}));

describe('useSessionRetryHandlers', () => {
  beforeEach(() => {
    recoverFromDisconnectMock.mockReset();
  });

  it('returns recovered result and replaces cancelled assistant message', async () => {
    let messages = [
      { id: 'u1', role: 'user' as const, parts: [{ type: 'text', text: 'hello' }] },
      { id: 'a1', role: 'assistant' as const, parts: [] },
    ];

    const setChatMessages = vi.fn((updater: typeof messages | ((prev: typeof messages) => typeof messages)) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    });

    recoverFromDisconnectMock.mockResolvedValue({
      shouldRetry: false,
      existingResponse: 'Recovered answer',
      existingMessageId: 'a1',
    });

    const sendMessage = vi.fn();
    const showToast = vi.fn();
    const setMessageTimestamp = vi.fn();

    const { result } = renderHook(() =>
      useSessionRetryHandlers({
        lastUserMessageContent: 'hello',
        isInterruptedByRefresh: true,
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        refreshInterruptedAt: Date.now() - 1000,
        cancelledMessageId: 'a1',
        lastUserMessageId: 'u1',
        chatMessages: messages,
        setChatMessages,
        sendMessage,
        showToast,
        messageCountBeforeSendRef: { current: messages.length },
        setCancelledMessageId: vi.fn(),
        setLastUserMessageContent: vi.fn(),
        setLastUserMessageId: vi.fn(),
        setIsInterruptedByRefresh: vi.fn(),
        setInterruptedResponseMode: vi.fn(),
        setRefreshInterruptedAt: vi.fn(),
        setMessageTimestamp,
      })
    );

    let retryResult: Awaited<ReturnType<typeof result.current.handleRetry>>;
    await act(async () => {
      retryResult = await result.current.handleRetry();
    });

    expect(retryResult).toEqual({ kind: 'recovered', response: 'Recovered answer' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messages[1].parts).toEqual([{ type: 'text', text: 'Recovered answer' }]);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recovered Sophia’s last reply.', variant: 'success' })
    );
    expect(setMessageTimestamp).toHaveBeenCalledWith('a1', expect.any(String));
  });

  it('falls back to resend when recovery indicates retry', async () => {
    const messages = [
      { id: 'u1', role: 'user' as const, parts: [{ type: 'text', text: 'hello' }] },
      { id: 'a1', role: 'assistant' as const, parts: [] },
    ];

    recoverFromDisconnectMock.mockResolvedValue({
      shouldRetry: true,
      existingResponse: null,
      existingMessageId: null,
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useSessionRetryHandlers({
        lastUserMessageContent: 'hello',
        isInterruptedByRefresh: true,
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        refreshInterruptedAt: Date.now() - 1000,
        cancelledMessageId: 'a1',
        lastUserMessageId: 'u1',
        chatMessages: messages,
        setChatMessages: vi.fn(),
        sendMessage,
        showToast: vi.fn(),
        messageCountBeforeSendRef: { current: messages.length },
        setCancelledMessageId: vi.fn(),
        setLastUserMessageContent: vi.fn(),
        setLastUserMessageId: vi.fn(),
        setIsInterruptedByRefresh: vi.fn(),
        setInterruptedResponseMode: vi.fn(),
        setRefreshInterruptedAt: vi.fn(),
        setMessageTimestamp: vi.fn(),
      })
    );

    let retryResult: Awaited<ReturnType<typeof result.current.handleRetry>>;
    await act(async () => {
      retryResult = await result.current.handleRetry();
    });

    expect(retryResult).toEqual({ kind: 'resent' });
    expect(sendMessage).toHaveBeenCalledWith({ text: 'hello' });
  });
});
