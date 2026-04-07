"use client"

import { type ChatMessage } from "../stores/chat-store"
import type { FocusMode } from "../stores/ui-store"

import { debugWarn } from "./debug-logger"

const STORAGE_KEY = "sophia-session"
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

export type PersistedSession = {
  conversationId: string
  messages: ChatMessage[]
  timestamp: number
  focusMode?: FocusMode
}

/**
 * Save current session to localStorage
 */
export function saveSession(
  conversationId: string,
  messages: ChatMessage[],
  focusMode?: FocusMode
): void {
  if (typeof window === "undefined") return
  
  try {
    const session: PersistedSession = {
      conversationId,
      messages,
      timestamp: Date.now(),
      focusMode,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch (error) {
    debugWarn("SessionPersistence", "Failed to save session", { error })
  }
}

/**
 * Load session from localStorage
 * Returns null if no valid session exists or if it's too old
 */
export function loadSession(): PersistedSession | null {
  if (typeof window === "undefined") return null
  
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    
    const session = JSON.parse(raw) as PersistedSession
    
    // Check if session is too old
    const age = Date.now() - session.timestamp
    if (age > MAX_AGE_MS) {
      clearSession()
      return null
    }
    
    // Validate session structure
    if (!session.conversationId || !Array.isArray(session.messages)) {
      clearSession()
      return null
    }
    
    return session
  } catch (error) {
    debugWarn("SessionPersistence", "Failed to load session", { error })
    clearSession()
    return null
  }
}

/**
 * Clear persisted session
 */
export function clearSession(): void {
  if (typeof window === "undefined") return
  
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    debugWarn("SessionPersistence", "Failed to clear session", { error })
  }
}

/**
 * Check if a valid session exists
 */
export function hasValidSession(): boolean {
  return loadSession() !== null
}
