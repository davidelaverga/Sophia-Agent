import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSourceSendIntent } from '../../app/lib/memory-source-client';
import { useSessionRetryHandlers } from '../../app/session/useSessionRetryHandlers';
import { useConnectivityStore } from '../../app/stores/connectivity-store';

const recoverFromDisconnectMock = vi.fn();

vi.mock('../../app/lib/stream-recovery', () => ({
  recoverFromDisconnect: (...args: unknown[]) => recoverFromDisconnectMock(...args),
}));

describe('useSessionRetryHandlers', () => {
  beforeEach(() => {
    recoverFromDisconnectMock.mockReset();
    useConnectivityStore.setState({ messageQueue: [] });
  });

  it.each([false, true])('governed retry uses exact retained source, not text recovery; missing=%s', async missing => {
    const session = '20000000-0000-4000-8000-000000000001', thread = '30000000-0000-4000-8000-000000000001';
    const intent = createSourceSendIntent({ schema: 'mem00.source-profile.v1', owner_id: 'owner', session_id: session, thread_id: thread,
      authority: 'governed', observation_only: true, boundary: { schema: 'mem00.source-boundary.v1', owner_id: 'owner', session_id: session,
        thread_id: thread, memory_clear_epoch: 2, transcript_revision: 3 } }, 'SYNTHETIC RETRY');
    if (!missing) useConnectivityStore.getState().rememberSourceIntent(intent);
    const sendMessage = vi.fn(async () => undefined), setChatMessages = vi.fn();
    const { result } = renderHook(() => useSessionRetryHandlers({
      lastUserMessageContent: intent.action.content, isInterruptedByRefresh: true, hasValidBackendSessionId: true,
      backendSessionId: session, refreshInterruptedAt: 100, cancelledMessageId: 'assistant', lastUserMessageId: intent.action.message_id,
      chatMessages: [], setChatMessages, sendMessage,
      retrySourceInput: (text, messageId) => ({ text, sourceIntent: useConnectivityStore.getState().findSourceIntent('owner', session, thread, messageId, text) }),
      showToast: vi.fn(), messageCountBeforeSendRef: { current: 0 }, setCancelledMessageId: vi.fn(), setLastUserMessageContent: vi.fn(),
      setLastUserMessageId: vi.fn(), setIsInterruptedByRefresh: vi.fn(), setInterruptedResponseMode: vi.fn(), setRefreshInterruptedAt: vi.fn(),
      setMessageTimestamp: vi.fn(),
    }));
    await act(async () => expect(await result.current.handleRetry()).toEqual({ kind: missing ? 'none' : 'resent' }));
    expect(recoverFromDisconnectMock).not.toHaveBeenCalled();
    if (missing) {
      expect(sendMessage).not.toHaveBeenCalled();
      expect(setChatMessages).not.toHaveBeenCalled();
    } else expect(sendMessage).toHaveBeenCalledWith({ text: intent.action.content, sourceIntent: intent });
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
        retrySourceInput: (text: string) => ({ text }), // Explicit legacy fixture.
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
        retrySourceInput: (text: string) => ({ text }), // Explicit legacy fixture.
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
