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
const useBuilderCanvasMock = vi.fn();
const cancelBuilderTaskMock = vi.fn();
const getBuilderTaskStatusMock = vi.fn();

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

vi.mock('../../app/hooks/useBuilderCanvas', () => ({
  useBuilderCanvas: (...args: unknown[]) => useBuilderCanvasMock(...args),
}));

vi.mock('../../app/lib/builder-workflow', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../app/lib/builder-workflow');

  return {
    ...actual,
    cancelBuilderTask: (...args: unknown[]) => cancelBuilderTaskMock(...args),
    getBuilderTaskStatus: (...args: unknown[]) => getBuilderTaskStatusMock(...args),
  };
});

import { useSessionRouteExperience } from '../../app/session/useSessionRouteExperience';

describe('useSessionRouteExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelBuilderTaskMock.mockResolvedValue({ detail: 'Builder cancelled.' });
    getBuilderTaskStatusMock.mockReset();
    useBuilderCanvasMock.mockReturnValue({
      activeTask: null,
      recentEvents: [],
      completion: null,
      reconnecting: false,
    });

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
        storedBuilderArtifact: null,
        storeArtifacts: vi.fn(),
        storeBuilderArtifact: vi.fn(),
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
      setBuilderTask: (task: { phase: string; detail?: string }) => void;
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

    // PR-B (B5): the route experience now wraps sendMessage with a
    // cancel-on-restart guard so a new prompt cancels any in-flight builder
    // task before submitting. The voice runtime receives the WRAPPED
    // function (a stable callback), not the raw mock return value — but
    // the wrapped function delegates to it for the actual send.
    expect(useCompanionVoiceRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        onUserTranscriptFallback: appendVoiceUserMessage,
        appendAssistantMessage: appendVoiceAssistantMessage,
        sendMessage: expect.any(Function),
        latestAssistantMessage,
        isTyping: false,
      })
    );
    // Sanity-check the delegation: invoking the wrapped sendMessage with
    // no in-flight builder calls the raw mock with identical args.
    const wrappedSendMessage = useCompanionVoiceRuntimeMock.mock.calls[0][0].sendMessage;
    void wrappedSendMessage({ text: 'ping' });
    expect(sendMessage).toHaveBeenCalledWith({ text: 'ping' });

    expect(setOnUserTranscriptHandler).toHaveBeenCalledWith(appendVoiceUserMessage);
    expect(setAssistantResponseSuppressedChecker).toHaveBeenCalledWith(expect.any(Function));

    act(() => {
      streamContractCall.setBuilderTask({ phase: 'running', detail: 'Drafting the brief.' });
    });

    expect(result.current.builderTask).toEqual({ phase: 'running', detail: 'Drafting the brief.', canvasStreamed: true });
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
        storedBuilderArtifact: null,
        storeArtifacts: vi.fn(),
        storeBuilderArtifact: vi.fn(),
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

  it('cancels an active builder task and wraps stopStreaming', async () => {
    const showToast = vi.fn();
    const stopStreaming = vi.fn();

    useCompanionChatRuntimeMock.mockReturnValue({
      chatMessages: [],
      sendChatMessage: vi.fn(),
      chatStatus: 'ready',
      chatError: undefined,
      setChatMessages: vi.fn(),
      stopStreaming,
    });

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
        storedBuilderArtifact: null,
        storeArtifacts: vi.fn(),
        storeBuilderArtifact: vi.fn(),
        updateSession: vi.fn(),
        showUsageLimitModal: vi.fn(),
        recordConnectivityFailure: vi.fn(),
        showToast,
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        greetingAnchorId: 'greeting-1',
        markOffline: vi.fn(),
      })
    );

    const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
      setBuilderTask: (task: { phase: string; taskId?: string; runId?: string; detail?: string }) => void;
    };

    act(() => {
      streamContractCall.setBuilderTask({
        phase: 'running',
        taskId: 'task-builder-1',
        runId: 'run-builder-1',
        detail: 'Drafting the brief.',
      });
    });

    await act(async () => {
      await result.current.cancelBuilderTask();
    });

    expect(cancelBuilderTaskMock).toHaveBeenCalledWith('thread-1', 'task-builder-1', 'run-builder-1');
    expect(result.current.builderTask).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Builder cancelled.', variant: 'info' })
    );

    act(() => {
      streamContractCall.setBuilderTask({
        phase: 'running',
        taskId: 'task-builder-2',
        runId: 'run-builder-2',
        detail: 'Retrying the build.',
      });
    });

    await act(async () => {
      result.current.stopStreaming();
      await Promise.resolve();
    });

    expect(cancelBuilderTaskMock).toHaveBeenCalledTimes(2);
    expect(stopStreaming).toHaveBeenCalledTimes(1);
  });

  it('does not drop builder cancellation when stream task state lacks a run id', async () => {
    const showToast = vi.fn();
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
        storedBuilderArtifact: null,
        storeArtifacts: vi.fn(),
        storeBuilderArtifact: vi.fn(),
        updateSession: vi.fn(),
        showUsageLimitModal: vi.fn(),
        recordConnectivityFailure: vi.fn(),
        showToast,
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        greetingAnchorId: 'greeting-1',
        markOffline: vi.fn(),
      })
    );

    const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
      setBuilderTask: (task: { phase: string; taskId?: string; runId?: string; detail?: string }) => void;
    };

    act(() => {
      streamContractCall.setBuilderTask({
        phase: 'running',
        taskId: 'task-builder-1',
        detail: 'Drafting the brief.',
      });
    });

    await act(async () => {
      await result.current.cancelBuilderTask();
    });

    expect(cancelBuilderTaskMock).toHaveBeenCalledWith('thread-1', 'task-builder-1', undefined);
    expect(result.current.builderTask).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Builder cancelled.', variant: 'info' })
    );
  });

  it('hydrates truthful native canvas activity without legacy task polling', () => {
    useBuilderCanvasMock.mockReturnValue({
      activeTask: {
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-builder-1',
        status: 'running',
        latest_activity: { kind: 'phase', phase: 'drafting', label: 'Drafting' },
      },
      recentEvents: [{
        version: 1,
        event_id: 'task-builder-1:run-builder-1:1',
        sequence: 1,
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-builder-1',
        occurred_at: '2026-05-25T10:00:00Z',
        kind: 'progress',
        status: 'running',
        activity: { kind: 'phase', phase: 'drafting', label: 'Drafting' },
      }],
      completion: null,
      reconnecting: false,
    });
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
        storedBuilderArtifact: null,
        storeArtifacts: vi.fn(),
        storeBuilderArtifact: vi.fn(),
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
    expect(result.current.builderTask).toMatchObject({
      phase: 'running',
      taskId: 'task-builder-1',
      runId: 'run-builder-1',
      detail: 'Drafting',
      canvasStreamed: true,
    });
    expect(getBuilderTaskStatusMock).not.toHaveBeenCalled();
  });

  it('does not let a dismissed run hide a later run for the same builder task', () => {
    let builderCanvasState = {
      activeTask: {
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-old',
        status: 'running',
        latest_activity: { kind: 'phase', phase: 'drafting', label: 'Drafting old run' },
      },
      recentEvents: [],
      completion: null,
      reconnecting: false,
    };
    useBuilderCanvasMock.mockImplementation(() => builderCanvasState);

    const { result, rerender } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1' },
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        userId: 'user-1',
        artifacts: null,
        storedBuilderArtifact: null,
        storeArtifacts: vi.fn(),
        storeBuilderArtifact: vi.fn(),
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

    expect(result.current.builderTask).toMatchObject({
      taskId: 'task-builder-1',
      runId: 'run-old',
      detail: 'Drafting old run',
    });

    act(() => {
      result.current.clearBuilderTask();
    });

    expect(result.current.builderTask).toBeNull();

    builderCanvasState = {
      activeTask: {
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-new',
        status: 'running',
        latest_activity: { kind: 'phase', phase: 'drafting', label: 'Drafting new run' },
      },
      recentEvents: [],
      completion: null,
      reconnecting: false,
    };

    rerender();

    expect(result.current.builderTask).toMatchObject({
      taskId: 'task-builder-1',
      runId: 'run-new',
      detail: 'Drafting new run',
    });
  });

  it('maps terminal canvas failure into the visible builder state', () => {
      useBuilderCanvasMock.mockReturnValue({
        activeTask: {
          parent_thread_id: 'thread-1',
          task_id: 'task-builder-1',
          run_id: 'run-builder-1',
          status: 'failed',
          latest_activity: { kind: 'phase', phase: 'finalizing', label: 'Finalizing' },
        },
        recentEvents: [],
        completion: null,
        reconnecting: false,
      });
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
          storedBuilderArtifact: null,
          storeArtifacts: vi.fn(),
          storeBuilderArtifact: vi.fn(),
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
      expect(result.current.builderTask).toMatchObject({
        phase: 'failed',
        taskId: 'task-builder-1',
        runId: 'run-builder-1',
        detail: 'Finalizing',
      });
  });
});
