import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useCompanionArtifactsRuntimeMock = vi.fn();
const useCompanionStreamContractMock = vi.fn();
const useCompanionChatRuntimeMock = vi.fn();
const useSessionMessageViewModelMock = vi.fn();
const useSessionOutboundSendMock = vi.fn();
const useSessionVoiceMessagesMock = vi.fn();
const useCompanionVoiceRuntimeMock = vi.fn();
const useSessionVoiceUiControlsMock = vi.fn();

vi.mock('../../app/companion-runtime/artifacts-runtime', () => ({
  useCompanionArtifactsRuntime: (...args: unknown[]) => useCompanionArtifactsRuntimeMock(...args),
}));

vi.mock('../../app/companion-runtime/stream-contract', () => ({
  useCompanionStreamContract: (...args: unknown[]) => useCompanionStreamContractMock(...args),
}));

vi.mock('../../app/companion-runtime/chat-runtime', () => ({
  useCompanionChatRuntime: (...args: unknown[]) => useCompanionChatRuntimeMock(...args),
}));

vi.mock('../../app/session/useSessionMessageViewModel', () => ({
  useSessionMessageViewModel: (...args: unknown[]) => useSessionMessageViewModelMock(...args),
}));

vi.mock('../../app/session/useSessionSendActions', () => ({
  useSessionOutboundSend: (...args: unknown[]) => useSessionOutboundSendMock(...args),
}));

vi.mock('../../app/session/useSessionVoiceMessages', () => ({
  useSessionVoiceMessages: (...args: unknown[]) => useSessionVoiceMessagesMock(...args),
}));

vi.mock('../../app/companion-runtime/voice-runtime', () => ({
  useCompanionVoiceRuntime: (...args: unknown[]) => useCompanionVoiceRuntimeMock(...args),
}));

vi.mock('../../app/session/useSessionVoiceUiControls', () => ({
  useSessionVoiceUiControls: (...args: unknown[]) => useSessionVoiceUiControlsMock(...args),
}));

import { useSessionRouteExperience } from '../../app/session/useSessionRouteExperience';

describe('useSessionRouteExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useCompanionArtifactsRuntimeMock.mockReturnValue({
      artifactStatus: {
        takeaway: 'waiting',
        reflection: 'waiting',
        memories: 'waiting',
      },
      ingestArtifacts: vi.fn(),
      applyMemoryCandidates: vi.fn(),
    });

    useCompanionStreamContractMock.mockReturnValue({
      handleDataPart: vi.fn(),
      handleFinish: vi.fn(),
      markStreamTurnStarted: vi.fn(),
    });

    useCompanionChatRuntimeMock.mockReturnValue({
      chatMessages: [],
      sendChatMessage: vi.fn(),
      chatStatus: 'ready',
      chatError: undefined,
      setChatMessages: vi.fn(),
      stopStreaming: vi.fn(),
    });

    useSessionMessageViewModelMock.mockReturnValue({
      messages: [],
      latestAssistantMessage: { id: 'assistant-1', content: 'Canonical reply' },
      setMessageTimestamp: vi.fn(),
    });

    useSessionOutboundSendMock.mockReturnValue(vi.fn(async () => undefined));

    useSessionVoiceMessagesMock.mockReturnValue({
      appendVoiceUserMessage: vi.fn(),
      appendVoiceAssistantMessage: vi.fn(),
    });

    useCompanionVoiceRuntimeMock.mockReturnValue({
      voiceState: { stage: 'idle' },
      voiceStatus: 'ready',
      isReflectionTtsActive: false,
      setOnUserTranscriptHandler: vi.fn(),
      setAssistantResponseSuppressedChecker: vi.fn(),
      voiceRetryState: null,
      handleVoiceRetryPress: vi.fn(),
      handleDismissVoiceRetry: vi.fn(),
      queueVoiceRetryFromCancel: vi.fn(),
    });

    useSessionVoiceUiControlsMock.mockReturnValue({
      baseHandleMicClick: vi.fn(),
      setVoiceStatusCompat: vi.fn(),
    });
  });

  it('wires the ritual route through canonical companion runtime modules', () => {
    const interruptHandler = vi.fn();

    const { result } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1' },
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        userId: 'user-1',
        artifacts: null,
        storeArtifacts: vi.fn(),
        updateSession: vi.fn(),
        showUsageLimitModal: vi.fn(),
        recordConnectivityFailure: vi.fn(),
        showToast: vi.fn(),
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        greetingAnchorId: 'greeting-1',
        markOffline: vi.fn(),
      })
    );

    expect(result.current.routeProfile).toEqual(
      expect.objectContaining({ id: 'ritual', routePath: '/session' })
    );

    const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
      setInterrupt: (interrupt: { kind: string }) => void;
    };

    act(() => {
      result.current.setStreamInterruptHandler(interruptHandler);
      streamContractCall.setInterrupt({ kind: 'DEBRIEF_OFFER' });
    });

    expect(interruptHandler).toHaveBeenCalledWith({ kind: 'DEBRIEF_OFFER' });

    const streamContract = useCompanionStreamContractMock.mock.results[0].value as {
      handleDataPart: unknown;
      handleFinish: unknown;
      markStreamTurnStarted: unknown;
    };
    const sendChatMessage = useCompanionChatRuntimeMock.mock.results[0].value.sendChatMessage;
    const sendMessage = useSessionOutboundSendMock.mock.results[0].value;
    const { appendVoiceUserMessage, appendVoiceAssistantMessage } =
      useSessionVoiceMessagesMock.mock.results[0].value;
    const { latestAssistantMessage } = useSessionMessageViewModelMock.mock.results[0].value;
    const {
      setOnUserTranscriptHandler,
      setAssistantResponseSuppressedChecker,
    } = useCompanionVoiceRuntimeMock.mock.results[0].value;

    expect(useCompanionChatRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatRequestBody: { session_id: 'session-1' },
        handleDataPart: streamContract.handleDataPart,
        handleFinish: streamContract.handleFinish,
      })
    );

    expect(useSessionOutboundSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatStatus: 'ready',
        sendChatMessage,
        markStreamTurnStarted: streamContract.markStreamTurnStarted,
      })
    );

    expect(useCompanionVoiceRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        onUserTranscriptFallback: appendVoiceUserMessage,
        appendAssistantMessage: appendVoiceAssistantMessage,
        sendMessage,
        latestAssistantMessage,
        isTyping: false,
      })
    );

    expect(setOnUserTranscriptHandler).toHaveBeenCalledWith(appendVoiceUserMessage);
    expect(setAssistantResponseSuppressedChecker).toHaveBeenCalledWith(expect.any(Function));
  });

  it('passes active stream state through to voice runtime retry handling', () => {
    useCompanionChatRuntimeMock.mockReturnValue({
      chatMessages: [],
      sendChatMessage: vi.fn(),
      chatStatus: 'streaming',
      chatError: undefined,
      setChatMessages: vi.fn(),
      stopStreaming: vi.fn(),
    });

    renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1' },
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        userId: 'user-1',
        artifacts: null,
        storeArtifacts: vi.fn(),
        updateSession: vi.fn(),
        showUsageLimitModal: vi.fn(),
        recordConnectivityFailure: vi.fn(),
        showToast: vi.fn(),
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        greetingAnchorId: 'greeting-1',
        markOffline: vi.fn(),
      })
    );

    expect(useCompanionVoiceRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ isTyping: true })
    );
  });
});