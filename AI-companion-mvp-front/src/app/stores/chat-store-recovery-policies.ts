import type { ChatMessage } from '../types'
import { createMessageId } from '../lib/utils'

type RetryableStreamStatus = 'cancelled' | 'interrupted' | 'error'
type RecoverableStreamStatus = 'interrupted' | 'error'

export function isRetryableStreamStatus(status: string): status is RetryableStreamStatus {
  return status === 'cancelled' || status === 'interrupted' || status === 'error'
}

export function isRecoverableStreamStatus(status: string): status is RecoverableStreamStatus {
  return status === 'interrupted' || status === 'error'
}

export function selectLastUserMessage(messages: ChatMessage[], lastUserTurnId?: string): ChatMessage | undefined {
  if (lastUserTurnId) {
    const byTurnId = messages.find((message) => message.id === lastUserTurnId)
    if (byTurnId) return byTurnId
  }

  return [...messages].reverse().find((message) => message.role === 'user')
}

export function selectRetryPlaceholder(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find(
    (message) =>
      message.status === 'cancelled' ||
      message.status === 'interrupted' ||
      message.status === 'error',
  )
}

export function removeMessageById(messages: ChatMessage[], messageId?: string): ChatMessage[] {
  if (!messageId) return messages
  return messages.filter((message) => message.id !== messageId)
}

export function applyRecoveredResponse(
  messages: ChatMessage[],
  recovery: { existingResponse: string; existingMessageId?: string },
): ChatMessage[] {
  const interruptedMessage = messages.find(
    (message) => message.status === 'interrupted' || message.status === 'error',
  )

  if (!interruptedMessage) {
    return [
      ...messages,
      {
        id: recovery.existingMessageId || createMessageId(),
        role: 'sophia',
        content: recovery.existingResponse,
        createdAt: Date.now(),
        status: 'complete',
        meta: { recoveredFromDisconnect: true },
      },
    ]
  }

  return messages.map((message) =>
    message.id === interruptedMessage.id
      ? {
          ...message,
          content: recovery.existingResponse,
          status: 'complete',
          meta: { ...message.meta, recoveredFromDisconnect: true },
        }
      : message,
  )
}
