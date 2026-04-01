import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, type ChatMessage } from '../../app/stores/chat-store'

function resetChatStoreForTest() {
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
    runtimeMode: 'legacy',
    aiSdkRuntime: undefined,
    streamStatus: 'idle',
    streamAttempt: 0,
    lastUserTurnId: undefined,
  })
}

describe('chat-store AI SDK runtime bridge', () => {
  beforeEach(() => {
    resetChatStoreForTest()
  })

  it('binds and unbinds AI SDK runtime mode', () => {
    const send = vi.fn(async () => undefined)
    const stop = vi.fn()
    const retry = vi.fn(async () => undefined)

    useChatStore.getState().bindAiSdkRuntime({ send, stop, retry })

    expect(useChatStore.getState().runtimeMode).toBe('ai-sdk')
    expect(useChatStore.getState().aiSdkRuntime).toBeDefined()

    useChatStore.getState().unbindAiSdkRuntime()

    expect(useChatStore.getState().runtimeMode).toBe('legacy')
    expect(useChatStore.getState().aiSdkRuntime).toBeUndefined()
    expect(useChatStore.getState().streamStatus).toBe('idle')
  })

  it('delegates sendMessage to bound AI SDK runtime', async () => {
    const send = vi.fn(async () => undefined)
    const stop = vi.fn()
    const retry = vi.fn(async () => undefined)

    useChatStore.getState().bindAiSdkRuntime({ send, stop, retry })
    useChatStore.setState({ composerValue: 'hello from /chat' })

    await useChatStore.getState().sendMessage()

    expect(send).toHaveBeenCalledWith({ text: 'hello from /chat' })
    expect(useChatStore.getState().composerValue).toBe('')
    expect(useChatStore.getState().streamStatus).toBe('streaming')
  })

  it('delegates cancel and retry actions to bound AI SDK runtime', async () => {
    const send = vi.fn(async () => undefined)
    const stop = vi.fn()
    const retry = vi.fn(async () => undefined)

    useChatStore.getState().bindAiSdkRuntime({ send, stop, retry })
    useChatStore.setState({
      streamStatus: 'error',
      messages: [
        {
          id: 'assistant-1',
          role: 'sophia',
          content: 'partial',
          createdAt: Date.now(),
          status: 'streaming',
          source: 'text',
        },
      ] as ChatMessage[],
    })

    useChatStore.getState().cancelStream()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().streamStatus).toBe('cancelled')

    useChatStore.setState({ streamStatus: 'error' })
    useChatStore.getState().retryStream()

    expect(retry).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().streamStatus).toBe('streaming')
  })

  it('syncAiSdkState merges AI messages while preserving voice messages', () => {
    const voiceMessage: ChatMessage = {
      id: 'voice-user-1',
      role: 'user',
      content: 'voice input',
      createdAt: 10,
      status: 'complete',
      source: 'voice',
    }

    const aiMessage: ChatMessage = {
      id: 'assistant-1',
      role: 'sophia',
      content: 'ai response',
      createdAt: 20,
      status: 'streaming',
      source: 'text',
      turnId: 'assistant-1',
    }

    useChatStore.setState({
      messages: [voiceMessage],
      conversationId: 'conv-1',
    })

    useChatStore.getState().syncAiSdkState({
      messages: [aiMessage],
      chatStatus: 'streaming',
      conversationId: 'conv-1',
    })

    const state = useChatStore.getState()
    expect(state.messages.map((m) => m.id)).toEqual(['voice-user-1', 'assistant-1'])
    expect(state.isLocked).toBe(true)
    expect(state.streamStatus).toBe('streaming')
    expect(state.activeReplyId).toBe('assistant-1')
  })
})
