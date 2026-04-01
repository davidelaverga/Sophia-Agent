import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionVoiceOrchestration } from '../../app/session/useSessionVoiceOrchestration';

const useSessionVoiceMessagesMock = vi.fn();
const useSessionVoiceBridgeMock = vi.fn();
const useSessionVoiceUiControlsMock = vi.fn();

vi.mock('../../app/session/useSessionVoiceMessages', () => ({
  useSessionVoiceMessages: (...args: unknown[]) => useSessionVoiceMessagesMock(...args),
}));

vi.mock('../../app/session/useSessionVoiceBridge', () => ({
  useSessionVoiceBridge: (...args: unknown[]) => useSessionVoiceBridgeMock(...args),
}));

vi.mock('../../app/session/useSessionVoiceUiControls', () => ({
  useSessionVoiceUiControls: (...args: unknown[]) => useSessionVoiceUiControlsMock(...args),
}));

describe('useSessionVoiceOrchestration', () => {
  it('wires voice bridge/messages and returns orchestrated voice controls', () => {
    const setOnUserTranscriptHandler = vi.fn();
    const setAssistantResponseSuppressedChecker = vi.fn();
    const baseHandleMicClick = vi.fn();
    const setVoiceStatusCompat = vi.fn();
    const appendVoiceUserMessage = vi.fn();

    useSessionVoiceMessagesMock.mockReturnValue({
      appendVoiceUserMessage,
      appendVoiceAssistantMessage: vi.fn(),
    });

    useSessionVoiceBridgeMock.mockReturnValue({
      voiceState: { stage: 'ready' },
      voiceStatus: 'ready',
      isReflectionTtsActive: false,
      setOnUserTranscriptHandler,
      setAssistantResponseSuppressedChecker,
      voiceRetryState: null,
      handleVoiceRetryPress: vi.fn(),
      handleDismissVoiceRetry: vi.fn(),
      queueVoiceRetryFromCancel: vi.fn(),
    });

    useSessionVoiceUiControlsMock.mockReturnValue({
      baseHandleMicClick,
      setVoiceStatusCompat,
    });

    const { result } = renderHook(() =>
      useSessionVoiceOrchestration({
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        setChatMessages: vi.fn(),
        setMessageTimestamp: vi.fn(),
        ingestArtifacts: vi.fn(),
        sendMessage: vi.fn(async () => undefined),
        latestAssistantMessage: null,
        isTyping: false,
      })
    );

    expect(setOnUserTranscriptHandler).toHaveBeenCalledWith(appendVoiceUserMessage);
    expect(setAssistantResponseSuppressedChecker).toHaveBeenCalledWith(expect.any(Function));
    expect(result.current.baseHandleMicClick).toBe(baseHandleMicClick);
    expect(result.current.setVoiceStatusCompat).toBe(setVoiceStatusCompat);
  });
});