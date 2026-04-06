/**
 * useVoiceToggle Hook
 * ====================
 * 
 * Unified voice recording toggle logic.
 * Extracted from VoicePanel and VoiceFocusView to eliminate duplication.
 * 
 * Handles:
 * - Modal blocking (usage limit)
 * - Stage-based disabling (thinking/speaking)
 * - Haptic feedback
 * - Auto-stop on modal open
 */

"use client"

import { useEffect, useCallback } from "react"

import { logger } from "../lib/error-logger"
import type { VoiceStage } from "../lib/voice-types"
import { selectIsModalOpen } from "../stores/selectors"
import { useUiStore as useFocusModeStore } from "../stores/ui-store"
import { useUsageLimitStore } from "../stores/usage-limit-store"

import { haptic } from "./useHaptics"

type WaveformState = "resting" | "listening" | "thinking" | "speaking"

interface UseVoiceToggleOptions {
  /** Current voice stage from useVoiceLoop */
  stage: VoiceStage
  /** Function to stop recording */
  stopTalking: () => void
  /** Function to start recording (only used in focus mode) */
  startTalking?: () => Promise<void>
  /** 
   * Behavior when clicking in idle state:
   * - "switch-mode": Switch to voice focus mode (VoicePanel behavior)
   * - "start-recording": Start recording directly (VoiceFocusView behavior)
   */
  idleBehavior: "switch-mode" | "start-recording"
}

interface UseVoiceToggleReturn {
  /** Whether the toggle button should be disabled */
  isDisabled: boolean
  /** Whether a modal is blocking interaction */
  isModalOpen: boolean
  /** Handle toggle click */
  handleToggle: () => void
  /** Handle keyboard events (space/enter) */
  handleKeyPress: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  /** Get waveform visualization state */
  getWaveformState: () => WaveformState
}

/**
 * Hook for voice recording toggle functionality.
 * Consolidates duplicate logic from VoicePanel and VoiceFocusView.
 */
export function useVoiceToggle({
  stage,
  stopTalking,
  startTalking,
  idleBehavior,
}: UseVoiceToggleOptions): UseVoiceToggleReturn {
  // Check if usage limit modal is open
  const isModalOpen = useUsageLimitStore(selectIsModalOpen)
  
  // Focus mode controls (only needed for switch-mode behavior)
  const setMode = useFocusModeStore((state) => state.setMode)
  const setManualOverride = useFocusModeStore((state) => state.setManualOverride)
  
  // Auto-stop recording if modal opens
  useEffect(() => {
    const isRecording = stage === "listening"
    if (isModalOpen && isRecording) {
      stopTalking()
    }
  }, [isModalOpen, stopTalking, stage])
  
  // Compute disabled state
  const isDisabled = stage === "thinking" || stage === "speaking" || isModalOpen
  
  // Map voice stage to waveform state
  const getWaveformState = useCallback((): WaveformState => {
    if (stage === "listening") return "listening"
    if (stage === "thinking") return "thinking"
    if (stage === "speaking") return "speaking"
    return "resting"
  }, [stage])
  
  // Handle toggle action
  const handleToggle = useCallback(() => {
    // Block if modal is open
    if (isModalOpen) return
    
    // Block if processing
    if (stage === "thinking" || stage === "speaking") return
    
    const isRecording = stage === "listening"
    
    // Haptic feedback
    haptic(isRecording ? "success" : "medium")
    
    if (isRecording) {
      // Stop recording
      stopTalking()
    } else {
      // Handle idle state based on behavior mode
      if (idleBehavior === "switch-mode") {
        // VoicePanel: Just switch to voice mode
        setMode("voice")
        setManualOverride(true)
      } else {
        // VoiceFocusView: Start recording directly
        setManualOverride(true)
        startTalking?.().catch((error) => {
          logger.logError(error, {
            component: "useVoiceToggle",
            action: "start_talking",
          })
        })
      }
    }
  }, [isModalOpen, stage, stopTalking, startTalking, idleBehavior, setMode, setManualOverride])
  
  // Handle keyboard activation
  const handleKeyPress = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault()
        handleToggle()
      }
    },
    [handleToggle]
  )
  
  return {
    isDisabled,
    isModalOpen,
    handleToggle,
    handleKeyPress,
    getWaveformState,
  }
}
