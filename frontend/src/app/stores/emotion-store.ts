"use client"

import { create } from "zustand"

/**
 * Minimal store for the latest Sophia voice emotion.
 * Updated on each artifact arrival; read by UI components for color mapping.
 */

interface EmotionState {
  /** Current primary emotion from the latest artifact */
  emotion: string | null
  /** Setter — called when a sophia.artifact arrives */
  setEmotion: (emotion: string | null) => void
  /** Reset to no emotion */
  clear: () => void
}

export const useEmotionStore = create<EmotionState>((set) => ({
  emotion: null,
  setEmotion: (emotion) => set({ emotion }),
  clear: () => set({ emotion: null }),
}))
