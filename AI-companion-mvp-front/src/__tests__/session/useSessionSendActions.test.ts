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
