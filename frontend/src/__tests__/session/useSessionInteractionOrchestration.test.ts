import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionInteractionOrchestration } from '../../app/session/useSessionInteractionOrchestration';

const useSessionSendActionsMock = vi.fn();
const useSessionRetryHandlersMock = vi.fn();
const useSessionCancelledRetryVoiceReplayMock = vi.fn();
const useSessionUiCallbacksMock = vi.fn();
const useSessionMemoryActionsMock = vi.fn();

vi.mock('../../app/session/useSessionSendActions', () => ({
  useSessionSendActions: (...args: unknown[]) => useSessionSendActionsMock(...args),
}));

vi.mock('../../app/session/useSessionRetryHandlers', () => ({
  useSessionRetryHandlers: (...args: unknown[]) => useSessionRetryHandlersMock(...args),
}));

vi.mock('../../app/session/useSessionCancelledRetryVoiceReplay', () => ({
  useSessionCancelledRetryVoiceReplay: (...args: unknown[]) => useSessionCancelledRetryVoiceReplayMock(...args),
}));

vi.mock('../../app/session/useSessionUiCallbacks', () => ({
  useSessionUiCallbacks: (...args: unknown[]) => useSessionUiCallbacksMock(...args),
}));

vi.mock('../../app/session/useSessionMemoryActions', () => ({
  useSessionMemoryActions: (...args: unknown[]) => useSessionMemoryActionsMock(...args),
}));

describe('useSessionInteractionOrchestration', () => {
  it('composes interaction hooks and exposes merged handlers', () => {
    const handleRetry = vi.fn(async () => ({ kind: 'none' }));

    useSessionSendActionsMock.mockReturnValue({
      messageCountBeforeSendRef: { current: 0 },
      handleSubmit: vi.fn(),
      handleCancelThinking: vi.fn(),
    });

    useSessionRetryHandlersMock.mockReturnValue({
      handleRetry,
      handleDismissCancelled: vi.fn(),
    });

    useSessionCancelledRetryVoiceReplayMock.mockReturnValue({
      handleCancelledRetryPress: vi.fn(),
    });

    useSessionUiCallbacksMock.mockReturnValue({
      handlePromptSelect: vi.fn(),
      handleMessageFeedback: vi.fn(),
      handleStreamErrorRetry: vi.fn(),
      handleDismissStreamError: vi.fn(),
      handleGoToDashboard: vi.fn(),
      handleFeedbackToastClose: vi.fn(),
      handleSessionExpiredRetry: vi.fn(),
      handleSessionExpiredGoHome: vi.fn(),
      handleMultiTabGoHome: vi.fn(),
      handleMultiTabTakeOver: vi.fn(),
    });

    useSessionMemoryActionsMock.mockReturnValue({
      handleMemoryApprove: vi.fn(),
      handleMemoryReject: vi.fn(),
    });

    const { result } = renderHook(() =>
      useSessionInteractionOrchestration({
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
          stage: 'ready',
          resetVoiceState: vi.fn(),
          speakText: vi.fn(async () => true),
        },
        queueVoiceRetryFromCancel: vi.fn(),
        cancelledRetryMessage: 'cancelled',
        lastUserMessageContent: null,
        isInterruptedByRefresh: false,
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        refreshInterruptedAt: null,
        cancelledMessageId: null,
        lastUserMessageId: null,
        chatMessages: [],
        setLastUserMessageId: vi.fn(),
        setIsInterruptedByRefresh: vi.fn(),
        setInterruptedResponseMode: vi.fn(),
        setRefreshInterruptedAt: vi.fn(),
        setMessageTimestamp: vi.fn(),
        interruptedResponseMode: null,
        sessionVoiceMode: false,
        latestAssistantMessage: null,
        setFeedback: vi.fn(),
        setShowFeedbackToast: vi.fn(),
        focusComposer: vi.fn(),
        messages: [],
        navigateHome: vi.fn(),
        clearSessionError: vi.fn(),
        endSession: vi.fn(),
        takeOverSession: vi.fn(),
        artifacts: null,
        applyMemoryCandidates: vi.fn(),
        isOffline: false,
        queueMemoryApproval: vi.fn(),
        backendSessionIdForMemory: 'session-1',
      })
    );

    expect(useSessionSendActionsMock).toHaveBeenCalledTimes(1);
    expect(useSessionRetryHandlersMock).toHaveBeenCalledTimes(1);
    expect(useSessionCancelledRetryVoiceReplayMock).toHaveBeenCalledTimes(1);
    expect(useSessionUiCallbacksMock).toHaveBeenCalledTimes(1);
    expect(useSessionMemoryActionsMock).toHaveBeenCalledTimes(1);

    const cancelledRetryArgs = useSessionCancelledRetryVoiceReplayMock.mock.calls[0][0] as {
      handleRetry: unknown;
    };
    expect(cancelledRetryArgs.handleRetry).toBe(handleRetry);
    expect(result.current.handleSubmit).toBeDefined();
    expect(result.current.handleMemoryApprove).toBeDefined();
  });
});