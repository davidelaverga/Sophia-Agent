import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useChatMock = vi.fn();

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: unknown) => useChatMock(options),
}));

import { useCompanionChatRuntime } from '../../app/companion-runtime/chat-runtime';

describe('useCompanionChatRuntime', () => {
  it('reports every chat stream error to onChatError before the toast', () => {
    useChatMock.mockReturnValue({
      messages: [],
      sendMessage: vi.fn(),
      status: 'ready',
      error: undefined,
      setMessages: vi.fn(),
      stop: vi.fn(),
    });
    const onChatError = vi.fn();
    const showToast = vi.fn();

    renderHook(() => useCompanionChatRuntime({
      chatRequestBody: { session_id: 'session-1' },
      handleDataPart: vi.fn(),
      handleFinish: vi.fn(),
      showUsageLimitModal: vi.fn(),
      recordConnectivityFailure: vi.fn(),
      showToast,
      onChatError,
    }));

    const options = useChatMock.mock.calls[0][0] as { onError: (error: Error) => void };
    const refusal = new Error('memory_context_rotation_required');
    options.onError(refusal);

    expect(onChatError).toHaveBeenCalledWith(refusal);
    expect(onChatError.mock.invocationCallOrder[0]).toBeLessThan(showToast.mock.invocationCallOrder[0]);
  });
});
