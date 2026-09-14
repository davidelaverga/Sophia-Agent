import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionSendActions } from '../../app/session/useSessionSendActions';

function buildParams(overrides: Partial<Parameters<typeof useSessionSendActions>[0]> = {}) {
  return {
    input: '',
    setInput: vi.fn(),
    isTyping: false,
    isReadOnly: false,
    sendMessage: vi.fn(async () => undefined),
    captureSourceInput: (text: string) => ({ text }), // Explicit legacy fixture.
    connectivityStatus: 'online',
    queueMessage: vi.fn(() => 'q-1'),
    sessionId: 'session-1',
    chatMessagesLength: 0,
    setChatMessages: vi.fn(),
    showToast: vi.fn(),
    voiceStatus: 'ready',
    setVoiceStatus: vi.fn(),
    setShowScaffold: vi.fn(),
    setJustSent: vi.fn(),
    setDismissedError: vi.fn(),
    setLastUserMessageContent: vi.fn(),
    setLastUserMessageId: vi.fn(),
    setCancelledMessageId: vi.fn(),
    stopStreaming: vi.fn(),
    voiceState: {
      stage: 'ready' as const,
      resetVoiceState: vi.fn(),
    },
    queueVoiceRetryFromCancel: vi.fn(),
    cancelledRetryMessage: 'cancelled by user',
    ...overrides,
  };
}

describe('useSessionSendActions', () => {
  it('holds explicit submit when original source capture is unavailable', () => {
    const params = buildParams({ input: 'SYNTHETIC INPUT', captureSourceInput: () => { throw new Error('unavailable'); } });
    const { result } = renderHook(() => useSessionSendActions(params));
    act(() => result.current.handleSubmit());
    expect(params.sendMessage).not.toHaveBeenCalled();
    expect(params.queueMessage).not.toHaveBeenCalled();
    expect(params.setInput).not.toHaveBeenCalled();
    expect(params.showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });
  it('delivery-failure retry action reuses the captured source without recapturing', async () => {
    const captured = { text: 'SYNTHETIC RETRY', sourceIntent: { owner_id: 'owner', session_id: '20000000-0000-4000-8000-000000000001',
      action: { thread_id: '30000000-0000-4000-8000-000000000001', message_id: 'source-message-key', command_key: 'source-command-key',
        expected_clear_epoch: 2, content: 'SYNTHETIC RETRY' } } };
    const captureSourceInput = vi.fn(() => captured), sendMessage = vi.fn().mockRejectedValueOnce(new Error('unconfirmed')).mockResolvedValueOnce(undefined);
    const showToast = vi.fn();
    const params = buildParams({ input: captured.text, captureSourceInput, sendMessage, showToast });
    const { result } = renderHook(() => useSessionSendActions(params));
    await act(async () => result.current.handleSubmit());
    const retryToast = showToast.mock.calls.find(([value]) => value.action?.label === 'Retry original')[0];
    expect(retryToast.durationMs).toBe(0);
    await act(async () => retryToast.action.onClick());
    expect(captureSourceInput).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls).toEqual([[captured], [captured]]);
  });
  it('handleCancelThinking cancels active text stream when typing', () => {
    const params = buildParams({ isTyping: true });
    const { result } = renderHook(() => useSessionSendActions(params));

    act(() => {
      result.current.handleCancelThinking();
    });

    expect(params.stopStreaming).toHaveBeenCalledTimes(1);
    expect(params.setCancelledMessageId).toHaveBeenCalledWith('cancelled');
    expect(params.queueVoiceRetryFromCancel).not.toHaveBeenCalled();
  });

  it('handleCancelThinking queues voice retry and resets voice state when voice is thinking', () => {
    const params = buildParams({
      voiceState: {
        stage: 'thinking',
        resetVoiceState: vi.fn(),
      },
    });
    const { result } = renderHook(() => useSessionSendActions(params));

    act(() => {
      result.current.handleCancelThinking();
    });

    expect(params.queueVoiceRetryFromCancel).toHaveBeenCalledWith('cancelled by user');
    expect(params.voiceState.resetVoiceState).toHaveBeenCalledTimes(1);
    expect(params.stopStreaming).not.toHaveBeenCalled();
  });
});
