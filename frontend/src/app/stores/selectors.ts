/**
 * Zustand Store Selectors
 * ========================
 * 
 * Memoized selectors for efficient store subscriptions.
 * Using selectors prevents unnecessary re-renders when unrelated state changes.
 * 
 * Usage with shallow comparison:
 * ```tsx
 * import { useShallow } from 'zustand/react/shallow'
 * 
 * // Instead of multiple individual selectors:
 * const value = useChatStore(state => state.composerValue)
 * const isLocked = useChatStore(state => state.isLocked)
 * 
 * // Use combined selector with shallow:
 * const { composerValue, isLocked } = useChatStore(
 *   useShallow(selectComposerState)
 * )
 * ```
 */

import type { ChatMessage } from './chat-store'
import type { PresenceState } from './presence-store'

// ============================================================================
// Chat Store Selectors
// ============================================================================

/**
 * Composer state - for the text input component
 */
export const selectComposerState = (state: {
  composerValue: string
  setComposerValue: (v: string) => void
  sendMessage: (override?: string) => Promise<void>
  isLocked: boolean
}) => ({
  composerValue: state.composerValue,
  setComposerValue: state.setComposerValue,
  sendMessage: state.sendMessage,
  isLocked: state.isLocked,
})

/**
 * Transcript state - for the message list
 */
export const selectTranscriptState = (state: {
  messages: ChatMessage[]
  isLocked: boolean
  lastError?: string
}) => ({
  messages: state.messages,
  isLocked: state.isLocked,
  lastError: state.lastError,
})

/**
 * Feedback state - for feedback components
 */
export const selectFeedbackState = (state: {
  feedbackGate?: { turnId: string; allowed: boolean; emotionalWeight?: number | null }
  acknowledgeFeedback: (turnId: string) => void
}) => ({
  feedbackGate: state.feedbackGate,
  acknowledgeFeedback: state.acknowledgeFeedback,
})

/**
 * Session feedback toast state
 */
export const selectSessionFeedbackState = (state: {
  sessionFeedback?: { open: boolean; turnId?: string }
  closeSessionFeedback: () => void
  acknowledgeFeedback: (turnId: string) => void
}) => ({
  sessionFeedback: state.sessionFeedback,
  closeSessionFeedback: state.closeSessionFeedback,
  acknowledgeFeedback: state.acknowledgeFeedback,
})

// ============================================================================
// Presence Store Selectors
// ============================================================================

/**
 * Presence display state - for UI indicators
 */
export const selectPresenceDisplay = (state: {
  status: PresenceState
  detail?: string
}) => ({
  status: state.status,
  detail: state.detail,
})

/**
 * Voice activity state - for mode switching logic
 */
export const selectVoiceActivity = (state: {
  status: PresenceState
  isListening: boolean
  isSpeaking: boolean
}) => ({
  status: state.status,
  isListening: state.isListening,
  isSpeaking: state.isSpeaking,
})

// ============================================================================
// Usage Limit Store Selectors
// ============================================================================

/**
 * Modal open state - for blocking interactions
 */
export const selectIsModalOpen = (state: { isOpen: boolean }) => state.isOpen

/**
 * Usage limits display
 */
export const selectUsageLimits = (state: {
  textRemaining: number
  voiceRemaining: number
  isLimited: boolean
}) => ({
  textRemaining: state.textRemaining,
  voiceRemaining: state.voiceRemaining,
  isLimited: state.isLimited,
})

// ============================================================================
// Focus Mode Store Selectors
// ============================================================================

/**
 * Focus mode state with setter
 */
export const selectFocusMode = (state: {
  mode: 'chat' | 'voice' | 'off'
  setMode: (mode: 'chat' | 'voice' | 'off') => void
  setManualOverride: (value: boolean) => void
}) => ({
  mode: state.mode,
  setMode: state.setMode,
  setManualOverride: state.setManualOverride,
})
