import { describe, expect, it } from 'vitest'
import {
  buildAiSdkChatBody,
  mapAiSdkMessagesToChatMessages,
  type AiSdkChatMessageLike,
} from '../../app/chat/useChatAiRuntime'

describe('useChatAiRuntime utilities', () => {
  it('builds AI SDK body contract for /api/chat', () => {
    const body = buildAiSdkChatBody({
      conversationId: 'session-123',
      userId: 'user-abc',
    })

    expect(body).toEqual({
      session_id: 'session-123',
      session_type: 'chat',
      context_mode: 'life',
      user_id: 'user-abc',
    })
  })

  it('maps assistant/user parts to ChatMessage and marks last assistant streaming', () => {
    const now = Date.now()
    const timestamps = new Map<string, number>([
      ['user-1', now - 1000],
      ['assistant-1', now - 500],
    ])

    const messages: AiSdkChatMessageLike[] = [
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

    const mapped = mapAiSdkMessagesToChatMessages(messages, 'streaming', timestamps)

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

  it('marks assistant as error when runtime status is error', () => {
    const timestamps = new Map<string, number>()
    const messages: AiSdkChatMessageLike[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'partial' }],
      },
    ]

    const mapped = mapAiSdkMessagesToChatMessages(messages, 'error', timestamps)
    expect(mapped[0].status).toBe('error')
  })

  it('sanitizes UI-message-dump text payloads into plain text content', () => {
    const timestamps = new Map<string, number>()
    const streamDump = [
      'data: {"type":"text-delta","delta":"Hello "}',
      'data: {"type":"text-delta","delta":"world"}',
      'data: [DONE]',
    ].join('\n')

    const messages: AiSdkChatMessageLike[] = [
      {
        id: 'assistant-stream',
        role: 'assistant',
        parts: [{ type: 'text', text: streamDump }],
      },
    ]

    const mapped = mapAiSdkMessagesToChatMessages(messages, 'ready', timestamps)
    expect(mapped[0].content).toBe('Hello world')
    expect(mapped[0].status).toBe('complete')
  })
})
