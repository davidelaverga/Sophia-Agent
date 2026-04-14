import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useCompanionRuntimeMock = vi.fn()
const useInterruptMock = vi.fn()
const useAuthMock = vi.fn()
const usePlatformSignalMock = vi.fn()

vi.mock('../../app/companion-runtime/useCompanionRuntime', () => ({
  useCompanionRuntime: (...args: unknown[]) => useCompanionRuntimeMock(...args),
}))

vi.mock('../../app/hooks/useInterrupt', () => ({
  useInterrupt: (...args: unknown[]) => useInterruptMock(...args),
}))

vi.mock('../../app/providers', () => ({
  useAuth: () => useAuthMock(),
}))

vi.mock('../../app/hooks/usePlatformSignal', () => ({
  usePlatformSignal: () => usePlatformSignalMock(),
}))

vi.mock('../../app/hooks/useSessionPersistence', () => ({
  useSessionPersistence: () => undefined,
}))

vi.mock('../../app/hooks/useUsageMonitor', () => ({
  useUsageMonitor: () => undefined,
}))

vi.mock('../../app/hooks/useBackendTokenSync', () => ({
  useBackendTokenSync: () => ({ isSyncing: false, syncError: null }),
}))

import {
  buildChatRouteBody,
  mapRouteMessagesToChatMessages,
  type RouteChatMessageLike,
  useChatRouteExperience,
} from '../../app/chat/useChatRouteExperience'
import { useChatStore } from '../../app/stores/chat-store'
import { useEmotionStore } from '../../app/stores/emotion-store'
import { useMessageMetadataStore } from '../../app/stores/message-metadata-store'
import { useRecapStore } from '../../app/stores/recap-store'

function resetStores() {
  localStorage.clear()
  useChatStore.setState({
    messages: [],
    composerValue: '',
    isLocked: false,
    conversationId: undefined,
    activeReplyId: undefined,
    lastError: undefined,
    feedbackGate: undefined,
    sessionFeedback: { open: false },
    lastCompletedTurnId: undefined,
    abortController: undefined,
    isLoadingHistory: false,
    routeRuntime: undefined,
    streamStatus: 'idle',
    streamAttempt: 0,
    lastUserTurnId: undefined,
  })
  useMessageMetadataStore.setState({
    metadataByMessage: {},
    currentThreadId: null,
    currentSessionId: null,
    currentRunId: null,
    emotionalWeather: null,
  })
  useRecapStore.setState({ artifacts: {} })
  useEmotionStore.setState({ emotion: 'neutral' })
}

describe('useChatRouteExperience utilities', () => {
  it('builds the /chat request body contract', () => {
    const body = buildChatRouteBody({
      conversationId: 'session-123',
      userId: 'user-abc',
      threadId: 'thread-xyz',
    })

    expect(body).toEqual({
      session_id: 'session-123',
      session_type: 'chat',
      context_mode: 'life',
      thread_id: 'thread-xyz',
      user_id: 'user-abc',
    })
  })

  it('maps runtime messages into chat-store messages', () => {
    const now = Date.now()
    const timestamps = new Map<string, number>([
      ['user-1', now - 1000],
      ['assistant-1', now - 500],
    ])

    const messages: RouteChatMessageLike[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello there' }],
      },
    ]

    const mapped = mapRouteMessagesToChatMessages(messages, 'streaming', timestamps)

    expect(mapped).toHaveLength(2)
    expect(mapped[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: 'Hi',
      status: 'complete',
      source: 'text',
    })
    expect(mapped[1]).toMatchObject({
      id: 'assistant-1',
      role: 'sophia',
      content: 'Hello there',
      status: 'streaming',
      source: 'text',
      turnId: 'assistant-1',
    })
  })
})

describe('useChatRouteExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStores()

    useAuthMock.mockReturnValue({
      user: { id: 'user-1' },
      loading: false,
      signOut: vi.fn(),
    })
    usePlatformSignalMock.mockReturnValue('text')
    useInterruptMock.mockReturnValue({
      pendingInterrupt: null,
      interruptQueue: [],
      isResuming: false,
      handleInterruptSelect: vi.fn(async () => undefined),
      handleInterruptSnooze: vi.fn(),
      handleInterruptDismiss: vi.fn(),
      setInterrupt: vi.fn(),
    })
  })

  it('binds the route runtime to the canonical companion runtime', async () => {
    const sendChatMessage = vi.fn(async () => undefined)
    const stopStreaming = vi.fn()
    const setAssistantResponseSuppressedChecker = vi.fn()
    const setOnUserTranscriptHandler = vi.fn()

    useCompanionRuntimeMock.mockReturnValue({
      routeProfile: { id: 'chat' },
      chatRuntime: {
        chatMessages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hello from the canonical runtime' }],
          },
        ],
        sendChatMessage,
        chatStatus: 'ready',
        chatError: undefined,
        setChatMessages: vi.fn(),
        stopStreaming,
      },
      streamContract: {
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        markStreamTurnStarted: vi.fn(),
      },
      artifactsRuntime: {},
      voiceRuntime: {
        voiceState: {
          stage: 'idle',
          hasRetryableVoiceTurn: () => false,
          retryLastVoiceTurn: async () => false,
          resetVoiceState: vi.fn(),
        },
        setAssistantResponseSuppressedChecker,
        setOnUserTranscriptHandler,
      },
    })

    const { result } = renderHook(() => useChatRouteExperience())

    expect(useCompanionRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routeProfile: 'chat',
        chat: expect.objectContaining({ chatRequestBody: { platform: 'text' } }),
      })
    )
    expect(useChatStore.getState().routeRuntime).toBeDefined()
    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: 'assistant-1',
      content: 'Hello from the canonical runtime',
      role: 'sophia',
    })
    expect(result.current.voiceState.stage).toBe('idle')

    useChatStore.setState({ composerValue: 'hello from /chat' })

    await act(async () => {
      await useChatStore.getState().sendMessage()
    })

    expect(sendChatMessage).toHaveBeenCalledWith(
      { text: 'hello from /chat' },
      {
        body: expect.objectContaining({
          session_type: 'chat',
          context_mode: 'life',
          user_id: 'user-1',
        }),
      }
    )
    expect(setAssistantResponseSuppressedChecker).toHaveBeenCalled()
    expect(setOnUserTranscriptHandler).toHaveBeenCalled()
  })

  it('reuses the active thread when it belongs to the current conversation', async () => {
    const sendChatMessage = vi.fn(async () => undefined)

    useCompanionRuntimeMock.mockReturnValue({
      routeProfile: { id: 'chat' },
      chatRuntime: {
        chatMessages: [],
        sendChatMessage,
        chatStatus: 'ready',
        chatError: undefined,
        setChatMessages: vi.fn(),
        stopStreaming: vi.fn(),
      },
      streamContract: {
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        markStreamTurnStarted: vi.fn(),
      },
      artifactsRuntime: {},
      voiceRuntime: {
        voiceState: {
          stage: 'idle',
          hasRetryableVoiceTurn: () => false,
          retryLastVoiceTurn: async () => false,
          resetVoiceState: vi.fn(),
        },
        setAssistantResponseSuppressedChecker: vi.fn(),
        setOnUserTranscriptHandler: vi.fn(),
      },
    })

    useChatStore.setState({ conversationId: 'session-ctx', composerValue: 'keep context' })
    useMessageMetadataStore.setState({
      metadataByMessage: {},
      currentThreadId: 'thread-ctx',
      currentSessionId: 'session-ctx',
      currentRunId: null,
      emotionalWeather: null,
    })

    renderHook(() => useChatRouteExperience())

    await act(async () => {
      await useChatStore.getState().sendMessage()
    })

    expect(sendChatMessage).toHaveBeenCalledWith(
      { text: 'keep context' },
      {
        body: expect.objectContaining({
          session_id: 'session-ctx',
          thread_id: 'thread-ctx',
        }),
      },
    )
  })

  it('rehydrates builder artifacts from persisted recap state', () => {
    useCompanionRuntimeMock.mockReturnValue({
      routeProfile: { id: 'chat' },
      chatRuntime: {
        chatMessages: [],
        sendChatMessage: vi.fn(async () => undefined),
        chatStatus: 'ready',
        chatError: undefined,
        setChatMessages: vi.fn(),
        stopStreaming: vi.fn(),
      },
      streamContract: {
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        markStreamTurnStarted: vi.fn(),
      },
      artifactsRuntime: {},
      voiceRuntime: {
        voiceState: {
          stage: 'idle',
          hasRetryableVoiceTurn: () => false,
          retryLastVoiceTurn: async () => false,
          resetVoiceState: vi.fn(),
        },
        setAssistantResponseSuppressedChecker: vi.fn(),
        setOnUserTranscriptHandler: vi.fn(),
      },
    })

    useChatStore.setState({ conversationId: 'conv-builder' })
    useRecapStore.getState().setArtifacts('conv-builder', {
      sessionId: 'conv-builder',
      threadId: 'thread-builder',
      sessionType: 'chat',
      contextMode: 'life',
      status: 'ready',
      builderArtifact: {
        artifactTitle: 'Launch brief',
        artifactType: 'document',
        artifactPath: 'mnt/user-data/outputs/launch-brief.md',
        decisionsMade: ['Shortened the intro'],
      },
    })

    const { result } = renderHook(() => useChatRouteExperience())

    expect(result.current.builderArtifact).toMatchObject({
      artifactTitle: 'Launch brief',
      artifactType: 'document',
    })
  })

  it('persists streamed builder artifacts into recap storage for chat reloads', () => {
    useCompanionRuntimeMock.mockReturnValue({
      routeProfile: { id: 'chat' },
      chatRuntime: {
        chatMessages: [],
        sendChatMessage: vi.fn(async () => undefined),
        chatStatus: 'ready',
        chatError: undefined,
        setChatMessages: vi.fn(),
        stopStreaming: vi.fn(),
      },
      streamContract: {
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        markStreamTurnStarted: vi.fn(),
      },
      artifactsRuntime: {},
      voiceRuntime: {
        voiceState: {
          stage: 'idle',
          hasRetryableVoiceTurn: () => false,
          retryLastVoiceTurn: async () => false,
          resetVoiceState: vi.fn(),
        },
        setAssistantResponseSuppressedChecker: vi.fn(),
        setOnUserTranscriptHandler: vi.fn(),
      },
    })

    useChatStore.setState({ conversationId: 'conv-stream' })
    useMessageMetadataStore.setState({
      metadataByMessage: {},
      currentThreadId: 'thread-stream',
      currentSessionId: 'conv-stream',
      currentRunId: null,
      emotionalWeather: null,
    })

    renderHook(() => useChatRouteExperience())

    const runtimeArgs = useCompanionRuntimeMock.mock.calls[0]?.[0]
    expect(runtimeArgs).toBeDefined()

    act(() => {
      runtimeArgs.stream.setBuilderArtifact({
        artifactTitle: 'Roadmap deck',
        artifactType: 'presentation',
        artifactPath: 'mnt/user-data/outputs/roadmap-deck.pdf',
        decisionsMade: ['Cut slide 12'],
      })
    })

    expect(useRecapStore.getState().getArtifacts('conv-stream')).toMatchObject({
      threadId: 'thread-stream',
      builderArtifact: {
        artifactTitle: 'Roadmap deck',
        artifactType: 'presentation',
      },
    })
  })

  it('surfaces streamed builder task state in the chat route experience', () => {
    useCompanionRuntimeMock.mockReturnValue({
      routeProfile: { id: 'chat' },
      chatRuntime: {
        chatMessages: [],
        sendChatMessage: vi.fn(async () => undefined),
        chatStatus: 'ready',
        chatError: undefined,
        setChatMessages: vi.fn(),
        stopStreaming: vi.fn(),
      },
      streamContract: {
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        markStreamTurnStarted: vi.fn(),
      },
      artifactsRuntime: {},
      voiceRuntime: {
        voiceState: {
          stage: 'idle',
          hasRetryableVoiceTurn: () => false,
          retryLastVoiceTurn: async () => false,
          resetVoiceState: vi.fn(),
        },
        setAssistantResponseSuppressedChecker: vi.fn(),
        setOnUserTranscriptHandler: vi.fn(),
      },
    })

    const { result } = renderHook(() => useChatRouteExperience())
    const runtimeArgs = useCompanionRuntimeMock.mock.calls[0]?.[0]

    act(() => {
      runtimeArgs.stream.setBuilderTask({
        phase: 'running',
        taskId: 'builder-task-1',
        detail: 'Drafting the outline.',
      })
    })

    expect(result.current.builderTask).toEqual({
      phase: 'running',
      taskId: 'builder-task-1',
      detail: 'Drafting the outline.',
    })

    act(() => {
      result.current.clearBuilderTask()
    })

    expect(result.current.builderTask).toBeNull()
  })
})