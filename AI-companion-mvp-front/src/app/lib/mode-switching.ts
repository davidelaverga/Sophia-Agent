/**
 * Mode Switching Domain Logic
 * 
 * CLEAN Architecture - Domain Layer
 * Pure business logic for validating mode transitions.
 * No dependencies on stores, UI, or frameworks.
 */

/**
 * Reasons why a mode switch might be blocked
 */
export type BlockReason = 
  | "chat_locked"           // Chat is sending/streaming
  | "voice_recording"       // Voice is actively recording
  | "voice_processing"      // Voice is processing/transcribing
  | "voice_playing"         // Voice is playing audio
  | "modal_open"            // Modal is open (should block chat but not mode switch)
  | "none";                 // No blocking condition

/**
 * Current operational state of the application
 */
export interface AppOperationState {
  /** Chat is locked (sending/streaming) */
  isChatLocked: boolean;
  /** Voice is in an active stage (recording/processing/playing) */
  isVoiceActive: boolean;
  /** Voice is specifically recording */
  isVoiceRecording: boolean;
  /** Voice is specifically playing audio */
  isVoicePlaying: boolean;
  /** A modal is currently open */
  isModalOpen: boolean;
}

/**
 * Result of a mode switch validation check
 */
export interface ModeSwitchValidation {
  /** Whether the switch is allowed */
  canSwitch: boolean;
  /** Reason for blocking (if blocked) */
  reason: BlockReason;
  /** User-friendly message explaining why switch is blocked */
  message?: string;
}

/**
 * Check if switching from chat mode to voice mode is allowed
 * 
 * Business Rule: Cannot switch to voice while chat is locked (sending/streaming)
 * Rationale: Prevents losing user's message or interrupting ongoing response
 */
export function canSwitchToVoice(state: AppOperationState): ModeSwitchValidation {
  // Block if chat is actively processing
  if (state.isChatLocked) {
    return {
      canSwitch: false,
      reason: "chat_locked",
      message: "Sophia is responding..."
    };
  }

  // All clear
  return {
    canSwitch: true,
    reason: "none"
  };
}

/**
 * Check if switching from voice mode to chat mode is allowed
 * 
 * Business Rule: Cannot switch to chat while voice is active
 * Rationale: Prevents losing voice recording or interrupting playback
 */
export function canSwitchToChat(state: AppOperationState): ModeSwitchValidation {
  // Block if voice is recording
  if (state.isVoiceRecording) {
    return {
      canSwitch: false,
      reason: "voice_recording",
      message: "Recording in progress..."
    };
  }

  // Block if voice is processing (transcribing, sending)
  if (state.isVoiceActive && !state.isVoicePlaying) {
    return {
      canSwitch: false,
      reason: "voice_processing",
      message: "Sophia is thinking..."
    };
  }

  // Block if voice is playing audio
  if (state.isVoicePlaying) {
    return {
      canSwitch: false,
      reason: "voice_playing",
      message: "Sophia is speaking..."
    };
  }

  // All clear
  return {
    canSwitch: true,
    reason: "none"
  };
}

/**
 * Check if auto-switching modes is allowed
 * 
 * Business Rule: Auto-switch should be less aggressive than manual switch
 * Only auto-switch when there are no active operations at all
 */
export function canAutoSwitchMode(state: AppOperationState): boolean {
  // Never auto-switch if chat is locked
  if (state.isChatLocked) {
    return false;
  }

  // Never auto-switch if voice is active
  if (state.isVoiceActive) {
    return false;
  }

  // Never auto-switch if modal is open
  if (state.isModalOpen) {
    return false;
  }

  // All clear for auto-switching
  return true;
}

/**
 * Get user-friendly message for why a mode switch was blocked
 */
export function getBlockedSwitchMessage(reason: BlockReason): string {
  switch (reason) {
    case "chat_locked":
      return "Please wait while Sophia responds";
    case "voice_recording":
      return "Finish recording first";
    case "voice_processing":
      return "Sophia is processing your message";
    case "voice_playing":
      return "Sophia is speaking";
    case "modal_open":
      return "Close the modal first";
    case "none":
      return "";
    default:
      return "Please wait a moment";
  }
}
