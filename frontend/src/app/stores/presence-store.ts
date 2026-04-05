"use client"

import { create } from "zustand"
import type { CopyKey } from "../copy"
import { eventBus } from "../lib/events"
import { isVerboseDebugEnabled } from "../lib/debug"
import { debugLog } from "../lib/debug-logger"

const PRESENCE_STATES = ["resting", "listening", "thinking", "reflecting", "speaking"] as const

export type PresenceState = (typeof PRESENCE_STATES)[number]

type PresenceStore = {
  status: PresenceState
  detail?: string
  updatedAt: number
  isListening: boolean
  isSpeaking: boolean
  metaStage: PresenceState
  setListening: (value: boolean) => void
  setSpeaking: (value: boolean) => void
  setMetaStage: (stage?: string, detail?: string) => void
  setDetail: (detail?: string) => void
  settleToRestingSoon: () => void
  reset: () => void
}

const normalizeStatus = (status?: string): PresenceState => {
  if (!status) return "resting"
  const value = status.toLowerCase() as PresenceState
  return (PRESENCE_STATES as readonly string[]).includes(value) ? value : "resting"
}

const presenceKeyMap: Record<PresenceState, CopyKey> = {
  resting: "presence.resting",
  listening: "presence.listening",
  thinking: "presence.thinking",
  reflecting: "presence.reflecting",
  speaking: "presence.speaking",
}

const reflectingGateMs = 250
let reflectingTimer: ReturnType<typeof setTimeout> | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null

const computeStage = (state: Pick<PresenceStore, "isListening" | "isSpeaking" | "metaStage">): PresenceState => {
  if (state.isSpeaking) return "speaking"
  if (state.isListening) return "listening"
  if (state.metaStage === "reflecting") return "reflecting"
  if (state.metaStage === "thinking") return "thinking"
  return "resting"
}

export const usePresenceStore = create<PresenceStore>((set, get) => ({
  status: "resting",
  detail: undefined,
  updatedAt: Date.now(),
  isListening: false,
  isSpeaking: false,
  metaStage: "resting",
  setListening: (value) =>
    set((state) => {
      const next = { ...state, isListening: value }
      return {
        ...next,
        status: computeStage(next),
        updatedAt: Date.now(),
      }
    }),
  setSpeaking: (value) =>
    set((state) => {
      const next = { ...state, isSpeaking: value }
      return {
        ...next,
        status: computeStage(next),
        updatedAt: Date.now(),
      }
    }),
  setMetaStage: (stage, detail) => {
    const normalized = normalizeStatus(stage)
    if (normalized === "reflecting") {
      if (reflectingTimer) return
      set((state) => {
        const next = { ...state, metaStage: "thinking" as PresenceState, detail: detail ?? state.detail }
        return {
          ...next,
          status: computeStage(next),
          updatedAt: Date.now(),
        }
      })
      reflectingTimer = setTimeout(() => {
        reflectingTimer = null
        set((state) => {
          const next = { ...state, metaStage: "reflecting" as PresenceState }
          return {
            ...next,
            status: computeStage(next),
            updatedAt: Date.now(),
          }
        })
      }, reflectingGateMs)
      return
    }

    if (reflectingTimer) {
      clearTimeout(reflectingTimer)
      reflectingTimer = null
    }

    set((state) => {
      const next = { ...state, metaStage: normalized, detail: detail ?? state.detail }
      return {
        ...next,
        status: computeStage(next),
        updatedAt: Date.now(),
      }
    })
  },
  setDetail: (detail) => set({ detail, updatedAt: Date.now() }),
  settleToRestingSoon: () => {
    if (settleTimer) {
      clearTimeout(settleTimer)
    }
    settleTimer = setTimeout(() => {
      settleTimer = null
      const state = get()
      if (state.isListening || state.isSpeaking) return
      set((current) => {
        const next = { ...current, metaStage: "resting" as PresenceState, detail: undefined }
        return {
          ...next,
          status: computeStage(next),
          updatedAt: Date.now(),
        }
      })
    }, 1200)
  },
  reset: () => {
    if (reflectingTimer) {
      clearTimeout(reflectingTimer)
      reflectingTimer = null
    }
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    set({
      status: "resting",
      detail: undefined,
      updatedAt: Date.now(),
      isListening: false,
      isSpeaking: false,
      metaStage: "resting",
    })
  },
}))

// ============================================================================
// Event Bus Integration - Decouple from chat-store
// ============================================================================

// Listen to chat events to update presence automatically
eventBus.on("chat:stream:start", () => {
  usePresenceStore.getState().setListening(true)
})

eventBus.on("chat:stream:chunk", () => {
  usePresenceStore.getState().setListening(false)
  usePresenceStore.getState().setMetaStage("thinking")
})

eventBus.on("chat:stream:complete", () => {
  usePresenceStore.getState().setListening(false)
  usePresenceStore.getState().settleToRestingSoon()
})

eventBus.on("chat:stream:error", () => {
  usePresenceStore.getState().setListening(false)
  usePresenceStore.getState().settleToRestingSoon()
})

// Listen to voice events
eventBus.on("voice:recording:start", () => {
  usePresenceStore.getState().setListening(true)
})

eventBus.on("voice:recording:stop", () => {
  usePresenceStore.getState().setListening(false)
})

eventBus.on("voice:playback:start", () => {
  usePresenceStore.getState().setSpeaking(true)
})

eventBus.on("voice:playback:complete", () => {
  usePresenceStore.getState().setSpeaking(false)
  usePresenceStore.getState().settleToRestingSoon()
})

// ============================================================================
// Development Logging
// ============================================================================

if (process.env.NODE_ENV !== "production" && isVerboseDebugEnabled()) {
  usePresenceStore.subscribe((state, prevState) => {
    if (!prevState) return

    if (state.status !== prevState.status || state.detail !== prevState.detail) {
      debugLog(
        "presence-store",
        `${prevState.status}${prevState.detail ? ` (${prevState.detail})` : ""} → ${state.status}${state.detail ? ` (${state.detail})` : ""}`,
      )
    }
  })
}

export const getPresenceCopyKey = (status: PresenceState): CopyKey =>
  presenceKeyMap[status] ?? "presence.resting"
