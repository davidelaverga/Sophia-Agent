import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionInitializationOrchestration } from '../../app/session/useSessionInitializationOrchestration';

const useSessionChatInitializationMock = vi.fn();

vi.mock('../../app/session/useSessionChatInitialization', () => ({
  useSessionChatInitialization: (...args: unknown[]) => useSessionChatInitializationMock(...args),
}));

describe('useSessionInitializationOrchestration', () => {
  it('maps grouped orchestration inputs to useSessionChatInitialization contract', () => {
    useSessionChatInitializationMock.mockReturnValue({ isInitializingChat: false });

    const hasShownReconnectRef = { current: false };
    const setChatMessages = vi.fn();
    const setMessageTimestamp = vi.fn();

    const { result } = renderHook(() =>
      useSessionInitializationOrchestration({
        session: null,
        storedMessages: [],
        greeting: {
          initialGreeting: 'hello',
          greetingMessageId: 'g-1',
          hasBootstrap: false,
          bootstrap: null,
          greetingRendered: false,
          markGreetingRendered: vi.fn(),
        },
        context: {
          memoryHighlights: [],
          sessionPresetType: 'chat',
          sessionContextMode: 'life',
        },
        chat: {
          setChatMessages,
          setMessageTimestamp,
        },
        retry: {
          setLastUserMessageId: vi.fn(),
          setLastUserMessageContent: vi.fn(),
          setCancelledMessageId: vi.fn(),
          setIsInterruptedByRefresh: vi.fn(),
          setInterruptedResponseMode: vi.fn(),
          setRefreshInterruptedAt: vi.fn(),
          hasShownReconnectRef,
        },
        showToast: vi.fn(),
      }),
    );

    expect(result.current.isInitializingChat).toBe(false);
    expect(useSessionChatInitializationMock).toHaveBeenCalledTimes(1);

    const call = useSessionChatInitializationMock.mock.calls[0][0] as {
      initialGreeting: string;
      greetingMessageId: string;
      setChatMessages: unknown;
      setMessageTimestamp: unknown;
      hasShownReconnectRef: { current: boolean };
      sessionPresetType?: string;
      sessionContextMode?: string;
    };

    expect(call.initialGreeting).toBe('hello');
    expect(call.greetingMessageId).toBe('g-1');
    expect(call.setChatMessages).toBe(setChatMessages);
    expect(call.setMessageTimestamp).toBe(setMessageTimestamp);
    expect(call.hasShownReconnectRef).toBe(hasShownReconnectRef);
    expect(call.sessionPresetType).toBe('chat');
    expect(call.sessionContextMode).toBe('life');
  });
});
