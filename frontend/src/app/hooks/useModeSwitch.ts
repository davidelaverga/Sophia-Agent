/**
 * Mode Switch Hook
 * 
 * CLEAN Architecture - Presentation Layer
 * Bridges domain logic (mode-switching.ts) with UI state (stores).
 * Provides React components with mode switch validation and handlers.
 */

"use client"

import { useCallback, useMemo } from "react"

import {
  canSwitchToVoice,
  canSwitchToChat,
  canAutoSwitchMode,
  getBlockedSwitchMessage,
  type AppOperationState,
  type ModeSwitchValidation
} from "../lib/mode-switching"
import { useChatStore } from "../stores/chat-store"
import { usePresenceStore } from "../stores/presence-store"
import { useUiStore as useFocusModeStore } from "../stores/ui-store"

export interface UseModeSwitch {
  /** Validation result for switching to voice mode */
  canSwitchToVoice: ModeSwitchValidation;
  /** Validation result for switching to chat mode */
  canSwitchToChat: ModeSwitchValidation;
  /** Whether auto-switching is allowed */
  canAutoSwitch: boolean;
  /** Handler for switching to voice mode (with validation) */
  switchToVoice: () => void;
  /** Handler for switching to chat mode (with validation) */
  switchToChat: () => void;
  /** Current operational state (for debugging) */
  operationState: AppOperationState;
}

/**
 * Hook that provides mode switching validation and handlers
 * 
 * Usage:
 * ```tsx
 * const { canSwitchToVoice, switchToVoice } = useModeSwitch()
 * 
 * <button 
 *   onClick={switchToVoice}
 *   disabled={!canSwitchToVoice.canSwitch}
 *   title={canSwitchToVoice.message}
 * >
 *   Switch to Voice
 * </button>
 * ```
 */
export function useModeSwitch(options?: {
  /** Callback when switch is blocked */
  onBlocked?: (reason: string) => void;
}): UseModeSwitch {
  const { setMode, setManualOverride } = useFocusModeStore()
  const isLocked = useChatStore((state) => state.isLocked)

  // Get voice state from presence store (single source of truth)
  const presenceStatus = usePresenceStore((state) => state.status)
  const isListening = usePresenceStore((state) => state.isListening)
  const isSpeaking = usePresenceStore((state) => state.isSpeaking)

  // Build current operational state
  const operationState: AppOperationState = useMemo(() => {
    const isVoiceActive = presenceStatus === "listening" || presenceStatus === "thinking" || presenceStatus === "speaking"
    const isVoiceRecording = isListening
    const isVoicePlaying = isSpeaking

    return {
      isChatLocked: isLocked,
      isVoiceActive,
      isVoiceRecording,
      isVoicePlaying,
      isModalOpen: false // Will be enhanced later if needed
    }
  }, [isLocked, presenceStatus, isListening, isSpeaking])
  
  // Validate mode switches
  const voiceValidation = useMemo(
    () => canSwitchToVoice(operationState),
    [operationState]
  )
  
  const chatValidation = useMemo(
    () => canSwitchToChat(operationState),
    [operationState]
  )
  
  const canAuto = useMemo(
    () => canAutoSwitchMode(operationState),
    [operationState]
  )
  
  // Handler for switching to voice mode
  const switchToVoice = useCallback(() => {
    const validation = canSwitchToVoice(operationState)
    
    if (!validation.canSwitch) {
      // Blocked - notify user
      const message = validation.message || getBlockedSwitchMessage(validation.reason)
      options?.onBlocked?.(message)
      return
    }
    
    // All clear - switch to voice
    setMode("voice")
    setManualOverride(true)
  }, [operationState, setMode, setManualOverride, options])
  
  // Handler for switching to chat mode
  const switchToChat = useCallback(() => {
    const validation = canSwitchToChat(operationState)
    
    if (!validation.canSwitch) {
      // Blocked - notify user
      const message = validation.message || getBlockedSwitchMessage(validation.reason)
      options?.onBlocked?.(message)
      return
    }
    
    // All clear - switch to chat
    setMode("text")
    setManualOverride(true)
  }, [operationState, setMode, setManualOverride, options])
  
  return {
    canSwitchToVoice: voiceValidation,
    canSwitchToChat: chatValidation,
    canAutoSwitch: canAuto,
    switchToVoice,
    switchToChat,
    operationState
  }
}
