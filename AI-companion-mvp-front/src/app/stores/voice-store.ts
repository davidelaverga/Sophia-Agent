/**
 * Voice Store
 * Consolidates voice-related state management
 * 
 * Combines:
 * - Voice history (transcript messages)
 * - Voice fallback (failure tracking)
 * - Stream voice feature flag
 */

"use client"

import { create } from "zustand"

// Feature flag: when true, ConversationView uses useStreamVoiceSession instead of useVoiceLoop.
// Removed when Unit 6 completes.
export const STREAM_VOICE_ENABLED = false
import { createMessageId } from "../lib/utils"

// =============================================================================
// TYPES
// =============================================================================

export type VoiceMessage = {
  id: string
  content: string
  timestamp: number
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_FAILURES_BEFORE_FALLBACK = 2
const FAILURE_RESET_TIME_MS = 5 * 60 * 1000 // 5 minutes

// =============================================================================
// STORE INTERFACE
// =============================================================================

interface VoiceState {
  // History
  messages: VoiceMessage[]
  addMessage: (content: string) => void
  clearHistory: () => void
  
  // Fallback tracking
  hasVoiceFailed: boolean
  failureReason?: string
  failureCount: number
  lastFailureTime?: number
  isVoiceAvailable: boolean
  
  // Fallback actions
  setVoiceFailed: (reason: string) => void
  setVoiceAvailable: () => void
  resetFailures: () => void
  shouldAutoFallback: () => boolean
}

// =============================================================================
// STORE IMPLEMENTATION
// =============================================================================

export const useVoiceStore = create<VoiceState>((set, get) => ({
  // History state
  messages: [],
  
  addMessage: (content) => {
    const newMessage: VoiceMessage = {
      id: createMessageId(),
      content,
      timestamp: Date.now(),
    }
    set((state) => ({
      messages: [...state.messages, newMessage],
    }))
  },
  
  clearHistory: () => set({ messages: [] }),
  
  // Fallback state
  hasVoiceFailed: false,
  failureReason: undefined,
  failureCount: 0,
  lastFailureTime: undefined,
  isVoiceAvailable: true,

  setVoiceFailed: (reason: string) => {
    const now = Date.now()
    const state = get()
    
    // Reset count if last failure was too long ago
    const shouldReset = state.lastFailureTime && (now - state.lastFailureTime) > FAILURE_RESET_TIME_MS
    const newCount = shouldReset ? 1 : state.failureCount + 1
    
    set({
      hasVoiceFailed: true,
      failureReason: reason,
      failureCount: newCount,
      lastFailureTime: now,
      isVoiceAvailable: newCount < MAX_FAILURES_BEFORE_FALLBACK,
    })
  },

  setVoiceAvailable: () => {
    set({
      hasVoiceFailed: false,
      failureReason: undefined,
      isVoiceAvailable: true,
    })
  },

  resetFailures: () => {
    set({
      hasVoiceFailed: false,
      failureReason: undefined,
      failureCount: 0,
      lastFailureTime: undefined,
      isVoiceAvailable: true,
    })
  },

  shouldAutoFallback: () => {
    const state = get()
    return !state.isVoiceAvailable && state.failureCount >= MAX_FAILURES_BEFORE_FALLBACK
  },
}))

