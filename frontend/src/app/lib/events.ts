/**
 * Event Bus - Type-safe pub/sub for decoupling stores
 * 
 * This event bus allows stores and components to communicate without direct coupling.
 * All events are strongly typed for safety and IDE autocomplete.
 * 
 * @example
 * ```typescript
 * // Subscribe to events
 * eventBus.on('chat:message:sent', (data) => {
 *   debugLog('events', 'Message sent', { content: data.content })
 * })
 * 
 * // Emit events
 * eventBus.emit('chat:message:sent', {
 *   id: '123',
 *   content: 'Hello',
 *   role: 'user',
 *   timestamp: Date.now()
 * })
 * 
 * // Unsubscribe
 * const unsubscribe = eventBus.on('chat:message:sent', handler)
 * unsubscribe()
 * ```
 */

// ============================================================================
// Event Type Definitions
// ============================================================================

export type ChatMessageSentEvent = {
  id: string
  content: string
  role: "user" | "sophia" | "system"
  timestamp: number
  source?: "voice" | "text"
}

export type ChatMessageReceivedEvent = {
  id: string
  content: string
  role: "user" | "sophia" | "system"
  timestamp: number
  turnId?: string
  audioUrl?: string
}

export type ChatStreamStartEvent = {
  conversationId: string
  timestamp: number
}

export type ChatStreamChunkEvent = {
  id: string
  content: string
  timestamp: number
}

export type ChatStreamCompleteEvent = {
  id: string
  finalContent: string
  timestamp: number
  turnId?: string
}

export type ChatStreamErrorEvent = {
  error: string
  timestamp: number
}

// Phase 4 Week 4: Stream reconnect events
export type ChatStreamReconnectingEvent = {
  attempt: number
  maxRetries: number
  timestamp: number
}

export type ChatStreamReconnectedEvent = {
  timestamp: number
}

// Phase 4 Week 4: Stream recovery event
export type ChatStreamRecoveredEvent = {
  messageId?: string
  timestamp: number
}

export type ChatClearedEvent = {
  timestamp: number
}

export type VoiceRecordingStartEvent = {
  timestamp: number
}

export type VoiceRecordingStopEvent = {
  timestamp: number
  duration?: number
}

export type VoicePlaybackStartEvent = {
  messageId: string
  timestamp: number
}

export type VoicePlaybackCompleteEvent = {
  messageId: string
  timestamp: number
}

export type PresenceChangeEvent = {
  from: string
  to: string
  timestamp: number
  detail?: string
}

export type ThemeChangeEvent = {
  theme: string
  timestamp: number
}

export type ErrorEvent = {
  error: Error | string
  context: string
  timestamp: number
  severity?: "warning" | "error" | "fatal"
}

export type UsageLimitReachedEvent = {
  limitType: "voice" | "text" | "reflections"
  used: number
  limit: number
  timestamp: number
}

// ============================================================================
// Event Map - Central registry of all events
// ============================================================================

export type EventMap = {
  // Chat events
  "chat:message:sent": ChatMessageSentEvent
  "chat:message:received": ChatMessageReceivedEvent
  "chat:stream:start": ChatStreamStartEvent
  "chat:stream:chunk": ChatStreamChunkEvent
  "chat:stream:complete": ChatStreamCompleteEvent
  "chat:stream:error": ChatStreamErrorEvent
  "chat:stream:reconnecting": ChatStreamReconnectingEvent
  "chat:stream:reconnected": ChatStreamReconnectedEvent
  "chat:stream:recovered": ChatStreamRecoveredEvent
  "chat:cleared": ChatClearedEvent

  // Voice events
  "voice:recording:start": VoiceRecordingStartEvent
  "voice:recording:stop": VoiceRecordingStopEvent
  "voice:playback:start": VoicePlaybackStartEvent
  "voice:playback:complete": VoicePlaybackCompleteEvent

  // Presence events
  "presence:change": PresenceChangeEvent

  // Theme events
  "theme:change": ThemeChangeEvent

  // Error events
  "error:captured": ErrorEvent

  // Usage limit events
  "usage:limit:reached": UsageLimitReachedEvent
}

// ============================================================================
// Event Bus Implementation
// ============================================================================

type EventHandler<T> = (data: T) => void
type Unsubscribe = () => void

class EventBus {
  private listeners = new Map<keyof EventMap, Set<EventHandler<unknown>>>()

  /**
   * Subscribe to an event
   * @param event - Event name (e.g., 'chat:message:sent')
   * @param handler - Callback function to handle the event
   * @returns Unsubscribe function
   */
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }

    this.listeners.get(event).add(handler as EventHandler<unknown>)

    // Return unsubscribe function
    return () => {
      const handlers = this.listeners.get(event)
      if (handlers) {
        handlers.delete(handler)
        if (handlers.size === 0) {
          this.listeners.delete(event)
        }
      }
    }
  }

  /**
   * Subscribe to an event once (auto-unsubscribes after first call)
   * @param event - Event name
   * @param handler - Callback function
   * @returns Unsubscribe function
   */
  once<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): Unsubscribe {
    const unsubscribe = this.on(event, (data) => {
      handler(data)
      unsubscribe()
    })
    return unsubscribe
  }

  /**
   * Emit an event to all subscribers
   * @param event - Event name
   * @param data - Event data
   */
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const handlers = this.listeners.get(event)
    if (!handlers) return

    // Call all handlers
    handlers.forEach((handler) => {
      try {
        ;(handler as EventHandler<EventMap[K]>)(data)
      } catch (error) {
            logger.logError(error, {
              component: "event-bus",
              action: "emit",
              metadata: { event: String(event) },
            })
      }
    })
  }

  /**
   * Remove all listeners for a specific event
   * @param event - Event name
   */
  off<K extends keyof EventMap>(event: K): void {
    this.listeners.delete(event)
  }

  /**
   * Remove all listeners for all events
   */
  clear(): void {
    this.listeners.clear()
  }

  /**
   * Get the number of listeners for an event
   * @param event - Event name
   * @returns Number of listeners
   */
  listenerCount<K extends keyof EventMap>(event: K): number {
    return this.listeners.get(event)?.size ?? 0
  }

  /**
   * Get all registered event names
   * @returns Array of event names
   */
  eventNames(): Array<keyof EventMap> {
    return Array.from(this.listeners.keys())
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Global event bus instance
 * 
 * Use this to communicate between stores and components without direct coupling.
 * 
 * @example
 * ```typescript
 * // In chat-store.ts
 * eventBus.emit('chat:message:sent', { id, content, role, timestamp })
 * 
 * // In presence-store.ts
 * eventBus.on('chat:message:sent', (data) => {
 *   // Update presence based on message
 * })
 * ```
 */
export const eventBus = new EventBus()

// ============================================================================
// React Hook for Event Subscriptions
// ============================================================================

import { useEffect } from "react"

import { logger } from "./error-logger"

/**
 * React hook to subscribe to events with automatic cleanup
 * 
 * @param event - Event name
 * @param handler - Event handler
 * @param deps - Dependency array (like useEffect)
 * 
 * @example
 * ```typescript
 * function MyComponent() {
 *   useEventBus('chat:message:sent', (data) => {
 *     debugLog('events', 'Message sent', { content: data.content })
 *   }, [])
 * }
 * ```
 */
export function useEventBus<K extends keyof EventMap>(
  event: K,
  handler: EventHandler<EventMap[K]>,
  deps: React.DependencyList = []
): void {
  useEffect(() => {
    const unsubscribe = eventBus.on(event, handler)
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps])
}
