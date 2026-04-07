"use client"

import { useEffect, useState, useRef, useCallback } from "react"

import { logger } from "../lib/error-logger"
import { emitTelemetry } from "../lib/telemetry"
import { useChatStore } from "../stores/chat-store"

export type ReflectionChunk = {
  id: string
  text: string
  ts: number
  reason: string
  turnId?: string // Track which turn generated this chunk
}

type ReflectionResponse = {
  allow?: boolean
  chunks?: ReflectionChunk[]
  reason?: string
  reflection_id?: string
}

export function useReflectionPrompt(conversationId?: string, turnId?: string) {
  const [chunks, setChunks] = useState<ReflectionChunk[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const lastFetchedTurnId = useRef<string | null>(null)
  const fetchCount = useRef(0)

  // Reset chunks when turnId changes to prevent showing stale data
  useEffect(() => {
    if (turnId && turnId !== lastFetchedTurnId.current) {
      // New turn detected - clear old chunks immediately
      setChunks(null)
    }
  }, [turnId])

  useEffect(() => {
    if (!conversationId || !turnId) return
    
    // Skip if we already fetched for this turn
    if (turnId === lastFetchedTurnId.current) return

    let cancelled = false
    const controller = new AbortController()
    const currentFetchId = ++fetchCount.current

    const fetchPrompt = async () => {
      setIsLoading(true)
      
      // Small delay to allow conversation to settle and avoid duplicate fetches
      await new Promise(resolve => setTimeout(resolve, 800))
      
      if (cancelled) return

      try {
        const response = await fetch(`/api/reflections/prompt`, {
          method: "POST",
          signal: controller.signal,
          headers: { 
            "Content-Type": "application/json",
            "Accept": "application/json" 
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            user_id: "anonymous",
            turn_id: turnId, // Pass turnId to backend for context
          }),
        })
        
        if (cancelled || currentFetchId !== fetchCount.current) return
        
        if (!response.ok) {
          setIsLoading(false)
          return
        }
        
        const payload = (await response.json()) as ReflectionResponse
        
        if (cancelled || currentFetchId !== fetchCount.current || !payload) {
          setIsLoading(false)
          return
        }
        
        if (payload.allow && payload.chunks && payload.chunks.length > 0) {
          // Tag chunks with the turnId that generated them
          const taggedChunks = payload.chunks.slice(0, 3).map(chunk => ({
            ...chunk,
            turnId,
            // Ensure unique ID by including turnId
            id: chunk.id.includes(turnId) ? chunk.id : `${turnId}-${chunk.id}`
          }))
          
          lastFetchedTurnId.current = turnId
          useChatStore.getState().closeSessionFeedback()
          setChunks(taggedChunks)
          emitTelemetry("reflection.prompt_shown", { turn_id: turnId })
        } else if (payload.allow === false && payload.reason) {
          emitTelemetry("reflection.prompt_denied", { reason: payload.reason })
        }
      } catch (err) {
        // silent fail, but log for debugging
        if (!cancelled) {
          logger.debug("useReflectionPrompt", "Fetch failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        if (!cancelled && currentFetchId === fetchCount.current) {
          setIsLoading(false)
        }
      }
    }

    void fetchPrompt()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [conversationId, turnId])

  const dismiss = useCallback(() => {
    setChunks(null)
    // Don't reset lastFetchedTurnId so we don't re-fetch for the same turn
  }, [])
  
  const refresh = useCallback(() => {
    // Force a new fetch by resetting the last fetched turn
    lastFetchedTurnId.current = null
    setChunks(null)
  }, [])

  return { chunks, dismiss, isLoading, refresh }
}





