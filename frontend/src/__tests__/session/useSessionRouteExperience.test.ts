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
const cancelBuilderTaskMock = vi.fn();
const getActiveBuilderTaskMock = vi.fn();
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

vi.mock('../../app/lib/builder-workflow', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../app/lib/builder-workflow');

  return {
    ...actual,
    cancelBuilderTask: (...args: unknown[]) => cancelBuilderTaskMock(...args),
    getActiveBuilderTask: (...args: unknown[]) => getActiveBuilderTaskMock(...args),
    getBuilderTaskStatus: (...args: unknown[]) => getBuilderTaskStatusMock(...args),
  };
});

import { useSessionRouteExperience } from '../../app/session/useSessionRouteExperience';

describe('useSessionRouteExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelBuilderTaskMock.mockResolvedValue({ detail: 'Builder cancelled.' });
    getActiveBuilderTaskMock.mockReset();
    getBuilderTaskStatusMock.mockReset();

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
        markStreamTurnStarted: expect.any(Function),
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

    act(() => {
      streamContractCall.setBuilderTask({ phase: 'running', detail: 'Drafting the brief.' });
    });

    expect(result.current.builderTask).toEqual({ phase: 'running', detail: 'Drafting the brief.' });
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

  it('rehydrates an active builder task during the post-send discovery window even when the stream misses the initial builder event', async () => {
    getActiveBuilderTaskMock.mockResolvedValue({
      task_id: 'task-builder-1',
      status: 'running',
      detail: 'Builder is drafting the brief.',
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

    await act(async () => {
      result.current.markStreamTurnStarted(Date.now());
      await Promise.resolve();
    });

    expect(getActiveBuilderTaskMock).toHaveBeenCalledWith('thread-1', 'session-1');
    expect(result.current.builderTask).toMatchObject({
      phase: 'running',
      taskId: 'task-builder-1',
      detail: 'Builder is drafting the brief.',
    });
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
      setBuilderTask: (task: { phase: string; taskId?: string; detail?: string }) => void;
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

    expect(cancelBuilderTaskMock).toHaveBeenCalledWith('task-builder-1');
    expect(result.current.builderTask).toEqual({
      phase: 'cancelled',
      taskId: 'task-builder-1',
      detail: 'Builder cancelled.',
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Builder cancelled.', variant: 'info' })
    );

    act(() => {
      streamContractCall.setBuilderTask({
        phase: 'running',
        taskId: 'task-builder-1',
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

  it('polls a running builder task to completion and persists the artifact', async () => {
    vi.useFakeTimers();

    try {
      getBuilderTaskStatusMock
        .mockResolvedValueOnce({
          task_id: 'task-builder-1',
          status: 'running',
          detail: 'Builder is drafting the brief.',
          progress_percent: 60,
          progress_source: 'todos',
          total_steps: 5,
          completed_steps: 3,
          in_progress_steps: 1,
          pending_steps: 1,
          active_step_title: 'Draft the summary',
          heartbeat_ms: 1200,
          idle_ms: 1200,
        })
        .mockResolvedValueOnce({
          task_id: 'task-builder-1',
          status: 'completed',
          detail: 'Deliverable ready.',
          builder_result: {
            artifact_title: 'One-page brief',
            artifact_type: 'brief',
            companion_summary: 'Deliverable ready.',
            user_next_action: 'Review the draft.',
          },
        });

      const storeBuilderArtifact = vi.fn();

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
          storeBuilderArtifact,
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

      const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
        setBuilderTask: (task: { phase: string; taskId?: string; detail?: string }) => void;
      };

      act(() => {
        streamContractCall.setBuilderTask({
          phase: 'running',
          taskId: 'task-builder-1',
          detail: 'Drafting the brief.',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(getBuilderTaskStatusMock).toHaveBeenCalledWith('task-builder-1');
      expect(result.current.builderTask).toMatchObject({
        taskId: 'task-builder-1',
        progressPercent: 60,
        activeStepTitle: 'Draft the summary',
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(result.current.builderTask).toMatchObject({
        phase: 'completed',
        taskId: 'task-builder-1',
        detail: 'Deliverable ready.',
      });
      expect(storeBuilderArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactTitle: 'One-page brief',
          companionSummary: 'Deliverable ready.',
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces builder debug detail from task status polling', async () => {
    vi.useFakeTimers();

    try {
      getBuilderTaskStatusMock.mockResolvedValue({
        task_id: 'task-builder-1',
        status: 'timed_out',
        progress_percent: 50,
        debug: {
          suspected_blocker_detail: 'Builder timed out after calling bash before emit_builder_artifact.',
          last_shell_command: {
            status: 'shell_unavailable',
            requested_command: 'ls /mnt/user-data/workspace',
            error: 'No suitable shell executable found.',
          },
        },
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

      const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
        setBuilderTask: (task: { phase: string; taskId?: string; detail?: string }) => void;
      };

      act(() => {
        streamContractCall.setBuilderTask({
          phase: 'running',
          taskId: 'task-builder-1',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.builderTask).toMatchObject({
        phase: 'timed_out',
        taskId: 'task-builder-1',
        detail: 'Builder timed out after calling bash before emit_builder_artifact.',
        debug: {
          lastShellCommand: {
            status: 'shell_unavailable',
            requestedCommand: 'ls /mnt/user-data/workspace',
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect the same builder artifact after the user dismisses it', () => {
    const storeBuilderArtifact = vi.fn();

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
        storeBuilderArtifact,
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

    const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
      setBuilderArtifact: (artifact: {
        artifactTitle: string;
        artifactType: string;
        artifactPath: string;
      }) => void;
    };

    const artifact = {
      artifactTitle: 'One-page brief',
      artifactType: 'brief',
      artifactPath: '/mnt/user-data/outputs/one-page-brief.md',
    };

    act(() => {
      streamContractCall.setBuilderArtifact(artifact);
    });

    expect(result.current.builderArtifact).toMatchObject(artifact);

    act(() => {
      result.current.clearBuilderArtifact();
    });

    expect(result.current.builderArtifact).toBeNull();

    act(() => {
      streamContractCall.setBuilderArtifact(artifact);
    });

    expect(result.current.builderArtifact).toBeNull();
    expect(storeBuilderArtifact).toHaveBeenCalledWith(null);
  });

  it('does not rehydrate the same completed builder task after dismissing its deliverable', async () => {
    getActiveBuilderTaskMock.mockResolvedValue({
      task_id: 'task-builder-1',
      status: 'completed',
      detail: 'Deliverable ready.',
      builder_result: {
        artifact_title: 'One-page brief',
        artifact_type: 'brief',
        artifact_path: '/mnt/user-data/outputs/one-page-brief.md',
      },
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

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.builderTask).toMatchObject({
      phase: 'completed',
      taskId: 'task-builder-1',
    });
    expect(result.current.builderArtifact).toMatchObject({
      artifactTitle: 'One-page brief',
    });

    act(() => {
      result.current.clearBuilderArtifact();
      result.current.clearBuilderTask();
    });

    expect(result.current.builderTask).toBeNull();
    expect(result.current.builderArtifact).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.builderTask).toBeNull();
    expect(result.current.builderArtifact).toBeNull();
  });

  it('does not clear the builder task when storedBuilderArtifact changes within the same session', async () => {
    const baseProps = {
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
    } as const;

    const { result, rerender } = renderHook((props: typeof baseProps) =>
      useSessionRouteExperience(props),
      { initialProps: baseProps }
    );

    const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
      setBuilderTask: (task: { phase: string; taskId?: string; detail?: string }) => void;
    };

    act(() => {
      streamContractCall.setBuilderTask({
        phase: 'completed',
        taskId: 'task-builder-1',
        detail: 'Deliverable ready.',
      });
    });

    expect(result.current.builderTask).toMatchObject({
      phase: 'completed',
      taskId: 'task-builder-1',
    });

    rerender({
      ...baseProps,
      storedBuilderArtifact: {
        artifactTitle: 'One-page brief',
        artifactType: 'brief',
        artifactPath: '/mnt/user-data/outputs/one-page-brief.md',
        decisionsMade: [],
      },
    });

    expect(result.current.builderTask).toMatchObject({
      phase: 'completed',
      taskId: 'task-builder-1',
    });
    expect(result.current.builderArtifact).toMatchObject({
      artifactTitle: 'One-page brief',
    });
  });

  it('keeps a dismissed builder artifact hidden after remounting the same session', () => {
    const artifact = {
      artifactTitle: 'One-page brief',
      artifactType: 'brief' as const,
      artifactPath: '/mnt/user-data/outputs/one-page-brief.md',
      decisionsMade: [],
    };

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
        storedBuilderArtifact: artifact,
        storedDismissedBuilderArtifactKey: [artifact.artifactPath, '', artifact.artifactTitle].join('::'),
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

    expect(result.current.builderArtifact).toBeNull();
  });
});