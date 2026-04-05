/**
 * useConversationHistory Hook
 * 
 * Phase 4 Week 4 - Subphase 3: Conversation History Consistency
 * 
 * Provides unified conversation history from the conversation store.
 * This is a convenience wrapper around useConversationStore.
 */
"use client"

import { useCallback, useEffect } from "react"
import { useAuth } from "../providers"
import { useAuthTokenStore } from "../stores/auth-token-store"
import { 
  useConversationStore,
  type ConversationListItem,
} from "../stores/conversation-store"

export type { ConversationListItem as UnifiedConversation }

interface UseConversationHistoryReturn {
  conversations: ConversationListItem[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  loadConversation: (id: string, source: "local" | "backend") => Promise<boolean>
  isAuthenticated: boolean
}

export function useConversationHistory(): UseConversationHistoryReturn {
  const { user } = useAuth()
  
  const conversations = useConversationStore(state => state.conversations)
  const listLoadingState = useConversationStore(state => state.listLoadingState)
  const listError = useConversationStore(state => state.listError)
  const refreshConversations = useConversationStore(state => state.refreshConversations)
  const loadConversationAction = useConversationStore(state => state.loadConversation)
  
  const isAuthenticated = !!user && !!useAuthTokenStore.getState().token
  const isLoading = listLoadingState === "loading" || listLoadingState === "refreshing"

  // Initial load on mount when authenticated
  useEffect(() => {
    if (conversations.length === 0) {
      refreshConversations()
    }
  }, [conversations.length, refreshConversations])
  
  const refresh = useCallback(async () => {
    await refreshConversations()
  }, [refreshConversations])
  
  const loadConversation = useCallback(async (id: string, source: "local" | "backend"): Promise<boolean> => {
    return loadConversationAction(id, source)
  }, [loadConversationAction])
  
  return {
    conversations,
    isLoading,
    error: listError,
    refresh,
    loadConversation,
    isAuthenticated,
  }
}
