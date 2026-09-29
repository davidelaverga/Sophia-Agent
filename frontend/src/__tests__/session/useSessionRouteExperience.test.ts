import { act, renderHook, waitFor } from '@testing-library/react';
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

vi.mock('../../app/providers', () => ({ useAuth: () => ({ loading: false, user: { id: 'user-1' } }) }));

vi.mock('../../app/lib/memory-source-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../app/lib/memory-source-client');
  // One dedicated session id gets a governed profile (canonical message ids);
  // every other session stays legacy.
  return { ...actual, loadSourceProfile: vi.fn(async (owner: string, session: string, thread: string) => (
    session === '33333333-3333-4333-8333-333333333333'
      ? {
        schema: 'mem00.source-profile.v1', owner_id: owner, session_id: session, thread_id: thread,
        authority: 'governed', observation_only: true, boundary: { schema: 'mem00.source-boundary.v1', owner_id: owner,
          session_id: session, thread_id: thread, memory_clear_epoch: 1, transcript_revision: 0 },
      }
      : {
        schema: 'mem00.source-profile.v1', owner_id: owner, session_id: session, thread_id: thread,
        authority: 'legacy', observation_only: true, boundary: null,
      }
  )) };
});

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

import {
  executeVoiceBuilderToolBridgeCall,
  hasVoiceBuilderToolBridge,
  type VoiceBuilderToolResult,
} from '../../app/lib/voice-builder-actions';
import { useSessionRouteExperience } from '../../app/session/useSessionRouteExperience';

describe('useSessionRouteExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelBuilderTaskMock.mockResolvedValue({ status: 'cancelled', detail: 'Builder cancelled.' });
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

  it('wires the ritual route through canonical companion runtime modules', async () => {
    const interruptHandler = vi.fn();

    const { result } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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

    // The route experience wraps sendMessage with freshness checks. The voice
    // runtime receives the wrapped function, which delegates to the raw sender.
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
    await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
    const wrappedSendMessage = useCompanionVoiceRuntimeMock.mock.calls.at(-1)![0].sendMessage;
    await wrappedSendMessage({ text: 'ping' });
    expect(sendMessage).toHaveBeenCalledWith({ text: 'ping' });

    expect(setOnUserTranscriptHandler).toHaveBeenCalledWith(expect.any(Function));
    const voiceTranscriptHandler = setOnUserTranscriptHandler.mock.calls[0][0] as (text: string) => void;
    act(() => {
      voiceTranscriptHandler('hello from voice');
    });
    expect(appendVoiceUserMessage).toHaveBeenCalledWith('hello from voice');
    expect(setAssistantResponseSuppressedChecker).toHaveBeenCalledWith(expect.any(Function));

    act(() => {
      streamContractCall.setBuilderTask({ phase: 'running', detail: 'Drafting the brief.' });
    });

    expect(result.current.builderTask).toEqual({ phase: 'running', detail: 'Drafting the brief.' });
  });

  it('does not auto-cancel a running builder when sending a normal message', async () => {
    const rawSendMessage = vi.fn(async () => undefined);
    useSessionOutboundSendMock.mockReturnValue(rawSendMessage);

    const { result } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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

    await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
    await act(async () => {
      await result.current.sendMessage({ text: 'also add Recursive MAS' });
    });

    expect(rawSendMessage).toHaveBeenCalledWith({ text: 'also add Recursive MAS' });
    expect(cancelBuilderTaskMock).not.toHaveBeenCalled();
  });

  it('cancels an active builder directly for explicit stop text without sending to companion', async () => {
    const rawSendMessage = vi.fn(async () => undefined);
    const showToast = vi.fn();
    useSessionOutboundSendMock.mockReturnValue(rawSendMessage);

    const { result } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
        detail: 'Packaging artifact.',
      });
    });

    await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
    await act(async () => {
      await result.current.sendMessage({ text: 'please terminate the build task' });
    });

    expect(cancelBuilderTaskMock).toHaveBeenCalledWith('thread-1', 'task-builder-1', 'run-builder-1');
    expect(rawSendMessage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Builder cancelled.', variant: 'info' })
    );
  });

  it('cancels an active builder directly from a voice stop transcript', async () => {
    const showToast = vi.fn();

    renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
        detail: 'Finalizing.',
      });
    });

    const { setOnUserTranscriptHandler } = useCompanionVoiceRuntimeMock.mock.results[0].value;
    const calls = setOnUserTranscriptHandler.mock.calls;
    const transcriptHandler = calls[calls.length - 1][0] as (text: string) => void;
    await act(async () => {
      transcriptHandler('please stop the build');
      await Promise.resolve();
    });

    const { appendVoiceUserMessage } = useSessionVoiceMessagesMock.mock.results[0].value;
    expect(appendVoiceUserMessage).toHaveBeenCalledWith('please stop the build');
    expect(cancelBuilderTaskMock).toHaveBeenCalledWith('thread-1', 'task-builder-1', 'run-builder-1');
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Builder cancelled.', variant: 'info' })
    );
  });

  it('does not cancel the running build for a spoken correction that mentions stop this', async () => {
    const showToast = vi.fn();

    renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
      streamContractCall.setBuilderTask({ phase: 'running', taskId: 'task-builder-1', runId: 'run-builder-1' });
    });

    const { setOnUserTranscriptHandler } = useCompanionVoiceRuntimeMock.mock.results[0].value;
    const calls = setOnUserTranscriptHandler.mock.calls;
    const transcriptHandler = calls[calls.length - 1][0] as (text: string) => void;
    await act(async () => {
      transcriptHandler('stop this section about pricing and focus on Germany');
      await Promise.resolve();
    });
    expect(cancelBuilderTaskMock).not.toHaveBeenCalled();

    const latestHandler = setOnUserTranscriptHandler.mock.calls[setOnUserTranscriptHandler.mock.calls.length - 1][0] as (text: string) => void;
    await act(async () => {
      latestHandler('okay, stop it.');
      await Promise.resolve();
    });
    expect(cancelBuilderTaskMock).toHaveBeenCalledWith('thread-1', 'task-builder-1', 'run-builder-1');
  });

  it('registers a voice builder bridge that sends corrections through the governed send path', async () => {
    const rawSendMessage = vi.fn(async () => undefined);
    useSessionOutboundSendMock.mockReturnValue(rawSendMessage);

    const { result } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: '11111111-1111-4111-8111-111111111111',
        activeSessionId: '11111111-1111-4111-8111-111111111111',
        activeThreadId: '22222222-2222-4222-8222-222222222222',
        chatRequestBody: { session_id: '11111111-1111-4111-8111-111111111111', thread_id: '22222222-2222-4222-8222-222222222222', user_id: 'user-1' },
        hasValidBackendSessionId: true,
        backendSessionId: '11111111-1111-4111-8111-111111111111',
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
      setBuilderTask: (task: { phase: string; taskId?: string; runId?: string; detail?: string }) => void;
    };
    act(() => {
      streamContractCall.setBuilderTask({ phase: 'running', taskId: 'task-builder-1', runId: 'run-builder-1' });
    });
    await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
    expect(hasVoiceBuilderToolBridge()).toBe(true);

    let pending!: Promise<VoiceBuilderToolResult>;
    act(() => {
      pending = executeVoiceBuilderToolBridgeCall({
        id: 'voice-update-1',
        name: 'update_async_task',
        args: { task_id: 'task-builder-1', message: 'Stop this section about pricing.' },
        recentUserUtterances: [],
      });
    });
    await waitFor(() => expect(rawSendMessage).toHaveBeenCalledTimes(1));
    expect(rawSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Correction: Stop this section about pricing.'),
    }));
    expect(cancelBuilderTaskMock).not.toHaveBeenCalled();

    act(() => {
      streamContractCall.setBuilderTask({ phase: 'running', taskId: 'task-builder-1', runId: 'run-builder-2' });
    });
    await expect(pending).resolves.toMatchObject({ ok: true, updated: true, task_id: 'task-builder-1', run_id: 'run-builder-2' });
  });

  describe('voice builder turn failures (governed session)', () => {
    const governedSession = '33333333-3333-4333-8333-333333333333';
    const governedThread = '44444444-4444-4444-8444-444444444444';

    const renderGoverned = () => renderHook(() =>
      useSessionRouteExperience({
        sessionId: governedSession,
        activeSessionId: governedSession,
        activeThreadId: governedThread,
        chatRequestBody: { session_id: governedSession, thread_id: governedThread, user_id: 'user-1' },
        hasValidBackendSessionId: true,
        backendSessionId: governedSession,
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
    // The AI SDK resolves the send even when the turn ends in a stream error;
    // the transport reports the error with the id of the message it sent.
    const reportTurnError = (messageId: string | null, errorText: string, afterActivity: boolean) => {
      const runtime = useCompanionChatRuntimeMock.mock.calls[useCompanionChatRuntimeMock.mock.calls.length - 1][0] as {
        onTurnError?: (messageId: string | null, errorText: string, afterActivity: boolean) => void;
      };
      runtime.onTurnError?.(messageId, errorText, afterActivity);
    };
    const startCall = (atMs: number) => executeVoiceBuilderToolBridgeCall({
      id: 'voice-start-1',
      name: 'start_builder_task',
      args: { description: 'Research the EU AI Act and write a Markdown report.' },
      recentUserUtterances: [{ text: 'please research the EU AI Act and write me a report', atMs }],
    });

    it('ends the request at once when its own companion turn is refused', async () => {
      const rawSendMessage = vi.fn(async (input: { sourceIntent?: { action: { message_id: string } } }) => {
        reportTurnError(input.sourceIntent?.action.message_id ?? null, 'memory_context_rotation_required', false);
      });
      useSessionOutboundSendMock.mockReturnValue(rawSendMessage);
      const { result } = renderGoverned();
      await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
      expect(hasVoiceBuilderToolBridge()).toBe(true);

      const startedAt = Date.now();
      let pending!: Promise<VoiceBuilderToolResult>;
      act(() => { pending = startCall(startedAt); });

      await expect(pending).resolves.toMatchObject({
        ok: false,
        builder_task_started: false,
        reason: 'builder_request_not_sent',
        send_error: 'memory_context_rotation_required',
      });
      expect(rawSendMessage).toHaveBeenCalledTimes(1);
      // Before the fix this waited for the 25 s confirmation timeout.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    it('reports a run-creation refusal (HTTP 403) as not started, not unconfirmed', async () => {
      // 2026-09-28: all three voice requests were refused this way and the
      // model was told they were unconfirmed, so it kept retrying.
      const rawSendMessage = vi.fn(async (input: { sourceIntent?: { action: { message_id: string } } }) => {
        reportTurnError(input.sourceIntent?.action.message_id ?? null, '{"error":"memory_source_send_refused"}', false);
      });
      useSessionOutboundSendMock.mockReturnValue(rawSendMessage);
      const { result } = renderGoverned();
      await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));

      let pending!: Promise<VoiceBuilderToolResult>;
      act(() => { pending = startCall(Date.now()); });

      const refused = await pending;
      expect(refused).toMatchObject({
        ok: false,
        builder_task_started: false,
        reason: 'builder_request_not_sent',
        send_error: 'memory_source_send_refused',
      });
      expect(String(refused.recovery_guidance)).toContain('Do not retry it yourself');
      expect(rawSendMessage).toHaveBeenCalledTimes(1);
    });

    it('reports a refusal after the turn acted as unconfirmed, at once', async () => {
      const rawSendMessage = vi.fn(async (input: { sourceIntent?: { action: { message_id: string } } }) => {
        reportTurnError(input.sourceIntent?.action.message_id ?? null, 'memory_context_rotation_required', true);
      });
      useSessionOutboundSendMock.mockReturnValue(rawSendMessage);
      const { result } = renderGoverned();
      await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));

      const startedAt = Date.now();
      let pending!: Promise<VoiceBuilderToolResult>;
      act(() => { pending = startCall(startedAt); });

      const outcome = await pending;
      expect(outcome).toMatchObject({ ok: false, builder_task_started: false, reason: 'builder_start_unconfirmed', status: 'unconfirmed' });
      expect(outcome).not.toHaveProperty('send_error');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    it("never blames another message's failure on the voice request", async () => {
      const rawSendMessage = vi.fn(async () => {
        // A concurrent typed turn (or an earlier session) fails meanwhile.
        reportTurnError('some-other-message-id', 'memory_context_rotation_required', false);
      });
      useSessionOutboundSendMock.mockReturnValue(rawSendMessage);
      const { result } = renderGoverned();
      await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
      const streamContractCall = useCompanionStreamContractMock.mock.calls[0][0] as {
        setBuilderTask: (task: { phase: string; taskId?: string; runId?: string }) => void;
      };

      let pending!: Promise<VoiceBuilderToolResult>;
      act(() => { pending = startCall(Date.now()); });
      await waitFor(() => expect(rawSendMessage).toHaveBeenCalledTimes(1));
      act(() => {
        streamContractCall.setBuilderTask({ phase: 'running', taskId: 'task-builder-9', runId: 'run-builder-9' });
      });

      await expect(pending).resolves.toMatchObject({ ok: true, builder_task_started: true, task_id: 'task-builder-9' });
    });
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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

  it('keeps a builder task visible when cancellation is still running', async () => {
    cancelBuilderTaskMock.mockResolvedValueOnce({
      task_id: 'task-builder-1',
      run_id: 'run-builder-1',
      status: 'running',
      detail: 'Builder cancellation was requested.',
    });
    const showToast = vi.fn();
    let builderCanvasState: {
      activeTask: null | Record<string, unknown>;
      recentEvents: unknown[];
      completion: null | Record<string, unknown>;
      reconnecting: boolean;
    } = {
      activeTask: null,
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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

    expect(result.current.builderTask).toMatchObject({
      phase: 'running',
      taskId: 'task-builder-1',
      runId: 'run-builder-1',
      detail: 'Builder cancellation was requested.',
    });

    builderCanvasState = {
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
    };

    rerender();

    expect(result.current.builderTask).toMatchObject({
      phase: 'failed',
      taskId: 'task-builder-1',
      runId: 'run-builder-1',
    });
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
        activity: { kind: 'tool_activity', category: 'research', action: 'searching_web', label: 'Searching web', source_domain: 'example.com', source_title: 'Example source' },
      }],
      completion: null,
      reconnecting: false,
    });
    const { result } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
    expect(result.current.builderTask?.activityLog?.[0]).toMatchObject({
      type: 'tool_call',
      title: 'Searching web',
      action: 'searching_web',
      detail: 'Example source · example.com',
      sourceDomain: 'example.com',
    });
    expect(getBuilderTaskStatusMock).not.toHaveBeenCalled();
  });

  it('maps canvas failure diagnostics to safe task detail and telemetry fields', () => {
    useBuilderCanvasMock.mockReturnValue({
      activeTask: {
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-builder-1',
        status: 'failed',
        latest_activity: { kind: 'phase', phase: 'finalizing', label: 'Finalizing' },
        completion: {
          thread_id: 'thread-1',
          task_id: 'task-builder-1',
          run_id: 'run-builder-1',
          status: 'error',
          builder_failure_diagnostics: {
            schema: 'builder_failure_diagnostics_v1',
            failure_stage: 'emit_rejected',
            failure_code: 'html_invalid_artifact_extension',
            failure_reason: 'Builder rejected HTML output because it was not a standalone .html file.',
            emit_attempted: true,
            artifact_target_path: 'sophia-workspace-demo.html',
            artifact_target_exists: false,
            outputs_summary: [{ relative_path: 'sophia-workspace-demo.md', extension: 'md', size_bytes: 12, exists: true }],
            supabase_mirror_result: 'skipped',
            raw_content_excluded: true,
            raw_artifact_text_excluded: true,
            raw_frame_excluded: true,
            secrets_excluded: true,
          },
        },
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
      detail: 'Builder rejected HTML output because it was not a standalone .html file.',
      builderFailureDiagnosticAvailable: true,
      builderFailureStage: 'emit_rejected',
      builderFailureCode: 'html_invalid_artifact_extension',
      builderEmitAttempted: true,
      builderExpectedArtifactExists: false,
      builderOutputsSummaryCount: 1,
      builderSupabaseMirrorResult: 'skipped',
    });
    expect(result.current.builderTask?.builderExpectedArtifactPathHash).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(result.current.builderTask)).not.toContain('<!doctype html>');
    expect(JSON.stringify(result.current.builderTask)).not.toContain('signed-url');
  });

  it('treats a matching terminal completion as authoritative over a stale running snapshot', () => {
    useBuilderCanvasMock.mockReturnValue({
      activeTask: {
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-builder-1',
        status: 'running',
        latest_activity: { kind: 'phase', phase: 'finalizing', label: 'Finalizing' },
      },
      recentEvents: [],
      completion: {
        thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-builder-1',
        status: 'success',
        artifact_path: 'mnt/user-data/outputs/deck.pptx',
      },
      reconnecting: false,
    });

    const { result } = renderHook(() =>
      useSessionRouteExperience({
        sessionId: 'session-1',
        activeSessionId: 'session-1',
        activeThreadId: 'thread-1',
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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
      phase: 'completed',
      taskId: 'task-builder-1',
      runId: 'run-builder-1',
    });
  });

  it('does not let a dismissed run hide a later run for the same builder task', () => {
    let builderCanvasState: {
      activeTask: Record<string, unknown>;
      recentEvents: unknown[];
      completion: null;
      reconnecting: boolean;
    } = {
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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

  it('does not carry stale builder detail into a new canvas run before activity arrives', () => {
    let builderCanvasState: {
      activeTask: Record<string, unknown>;
      recentEvents: unknown[];
      completion: null;
      reconnecting: boolean;
    } = {
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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

    expect(result.current.builderTask?.detail).toBe('Drafting old run');

    builderCanvasState = {
      activeTask: {
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-new',
        status: 'running',
      },
      recentEvents: [],
      completion: null,
      reconnecting: false,
    };

    rerender();

    expect(result.current.builderTask).toMatchObject({
      taskId: 'task-builder-1',
      runId: 'run-new',
      detail: 'Creating plan',
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
          chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
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

  it('synthesizes completion UI from terminal canvas state when event history is gone', () => {
    const storedBuilderArtifact = {
      artifactPath: 'mnt/user-data/outputs/brief.md',
      artifactTitle: 'Launch brief',
      artifactType: 'document' as const,
      decisionsMade: [],
    };

    useBuilderCanvasMock.mockReturnValue({
      activeTask: {
        parent_thread_id: 'thread-1',
        task_id: 'task-builder-1',
        run_id: 'run-builder-1',
        status: 'completed',
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
        chatRequestBody: { session_id: 'session-1', thread_id: 'thread-1', user_id: 'user-1' },
        hasValidBackendSessionId: true,
        backendSessionId: 'session-1',
        userId: 'user-1',
        artifacts: null,
        storedBuilderArtifact,
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

    expect(result.current.builderCompletion).toEqual(expect.objectContaining({
      task_id: 'task-builder-1',
      run_id: 'run-builder-1',
      status: 'success',
      artifact_title: 'Launch brief',
      artifact_path: 'mnt/user-data/outputs/brief.md',
      artifact_url: '/api/threads/thread-1/artifacts/mnt/user-data/outputs/brief.md',
    }));
  });
});
