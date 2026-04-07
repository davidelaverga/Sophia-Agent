import {
  eventBus,
  type ChatMessageReceivedEvent,
  type ChatMessageSentEvent,
  type ChatStreamChunkEvent,
  type ChatStreamCompleteEvent,
  type ChatStreamErrorEvent,
  type ChatStreamRecoveredEvent,
  type ChatStreamReconnectingEvent,
  type ChatStreamStartEvent,
} from '../lib/events'

export function emitChatStreamRecovered(messageId?: string) {
  const payload: ChatStreamRecoveredEvent = {
    messageId,
    timestamp: Date.now(),
  }
  eventBus.emit('chat:stream:recovered', payload)
}

export function emitChatMessageSent(payload: Omit<ChatMessageSentEvent, 'timestamp'>) {
  eventBus.emit('chat:message:sent', {
    ...payload,
    timestamp: Date.now(),
  })
}

export function emitChatStreamStart(conversationId: string) {
  const payload: ChatStreamStartEvent = {
    conversationId,
    timestamp: Date.now(),
  }
  eventBus.emit('chat:stream:start', payload)
}

export function emitChatStreamChunk(id: string, content: string) {
  const payload: ChatStreamChunkEvent = {
    id,
    content,
    timestamp: Date.now(),
  }
  eventBus.emit('chat:stream:chunk', payload)
}

export function emitChatStreamComplete(payload: Omit<ChatStreamCompleteEvent, 'timestamp'>) {
  eventBus.emit('chat:stream:complete', {
    ...payload,
    timestamp: Date.now(),
  })
}

export function emitChatMessageReceived(payload: Omit<ChatMessageReceivedEvent, 'timestamp'>) {
  eventBus.emit('chat:message:received', {
    ...payload,
    timestamp: Date.now(),
  })
}

export function emitChatStreamError(error: string) {
  const payload: ChatStreamErrorEvent = {
    error,
    timestamp: Date.now(),
  }
  eventBus.emit('chat:stream:error', payload)
}

export function emitChatStreamReconnecting(attempt: number, maxRetries: number) {
  const payload: ChatStreamReconnectingEvent = {
    attempt,
    maxRetries,
    timestamp: Date.now(),
  }
  eventBus.emit('chat:stream:reconnecting', payload)
}

export function emitChatStreamReconnected() {
  eventBus.emit('chat:stream:reconnected', {
    timestamp: Date.now(),
  })
}
