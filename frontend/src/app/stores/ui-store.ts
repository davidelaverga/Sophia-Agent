/**
 * UI Store
 * Consolidates UI-related transient state
 * 
 * Combines:
 * - Toast notifications
 * - Focus mode (voice/text layout)
 */

"use client"

import { create } from "zustand"

// =============================================================================
// TYPES
// =============================================================================

export type UiToastVariant = 'info' | 'success' | 'warning' | 'error'

export type UiToastState = {
  id: string
  message: string
  variant: UiToastVariant
  durationMs: number
  action?: { label: string; onClick: () => void }
}

export type FocusMode = "voice" | "text"

// =============================================================================
// STORE INTERFACE
// =============================================================================

interface UiState {
  // Toast
  toast: UiToastState | null
  showToast: (input: { message: string; variant?: UiToastVariant; durationMs?: number; action?: { label: string; onClick: () => void } }) => void
  dismissToast: () => void
  
  // Focus mode
  mode: FocusMode
  setMode: (mode: FocusMode) => void
  isManualOverride: boolean
  setManualOverride: (override: boolean) => void
  transcriptExpanded: boolean
  toggleTranscript: () => void

  // Chrome fade
  chromeFaded: boolean
  setChromeFaded: (faded: boolean) => void
  disableChromeFade: boolean
  setDisableChromeFade: (disabled: boolean) => void
}

// =============================================================================
// STORE IMPLEMENTATION
// =============================================================================

export const useUiStore = create<UiState>((set) => ({
  // Toast state
  toast: null,
  
  showToast: ({ message, variant = 'info', durationMs = 2800, action }) => {
    const minByVariant: Record<UiToastVariant, number> = {
      info: 3000,
      success: 3200,
      warning: 4400,
      error: 5000,
    }

    set({
      toast: {
        id: `${Date.now()}`,
        message,
        variant,
        durationMs: Math.max(durationMs, minByVariant[variant]),
        action,
      },
    })
  },
  
  dismissToast: () => set({ toast: null }),
  
  // Focus mode state
  mode: "voice",
  setMode: (mode) => set({ mode }),
  
  isManualOverride: false,
  setManualOverride: (override) => set({ isManualOverride: override }),
  
  transcriptExpanded: false,
  toggleTranscript: () => set((state) => ({ 
    transcriptExpanded: !state.transcriptExpanded 
  })),

  // Chrome fade state
  chromeFaded: false,
  setChromeFaded: (faded) => set({ chromeFaded: faded }),
  disableChromeFade: false,
  setDisableChromeFade: (disabled) => set({ disableChromeFade: disabled }),
}))

