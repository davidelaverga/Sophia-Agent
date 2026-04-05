"use client"

import { useEffect, useRef } from "react"
import { useAuth } from "../providers"
import { useUsageLimitStore } from "../stores/usage-limit-store"
import type { UsageLimitInfo } from "../types/rate-limits"
import { logger } from "../lib/error-logger"

// Global cache to prevent duplicate fetches across component remounts
const usageCache = {
  userId: null as string | null,
  timestamp: 0,
  TTL_MS: 60_000, // 60 seconds - usage doesn't change that fast
};


/**
 * Monitor user usage - Optimized version
 * 
 * Since backend now returns usage data with every response (text and voice),
 * we only need to fetch usage ONCE on initial load.
 * 
 * Real-time updates come from:
 * - Text: usage is included in TextResponse and processed by chat-store
 * - Voice: usage is included in voice response
 * 
 * This eliminates the need for constant polling, reducing backend load significantly.
 */
export function useUsageMonitor() {
  const { user } = useAuth()
  const initialFetchDone = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!user) {
      // Clear user context when logged out
      logger.setUser(null)
      initialFetchDone.current = false
      return
    }

    // Set user context for error tracking
    logger.setUser(user.id, user.email, user.name)
    logger.addBreadcrumb("User authenticated", { userId: user.id })

    // Only fetch once on initial load
    if (initialFetchDone.current) {
      return
    }
    
    // Check global cache - prevent re-fetch if recently fetched for same user
    const now = Date.now()
    if (usageCache.userId === user.id && (now - usageCache.timestamp) < usageCache.TTL_MS) {
      initialFetchDone.current = true
      return
    }

    // Cancel any pending request
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    const fetchInitialUsage = async () => {
      try {
        // Use local proxy — auth handled server-side (httpOnly cookie)
        const response = await fetch('/api/usage/backend', { 
          signal: abortControllerRef.current?.signal,
        })
        
        if (!response.ok) {
          if (response.status === 401) {
            return
          }
          return
        }

        const data = await response.json()
        
        // Get plan tier from response
        const planTier = data?.plan_tier || "FREE"
        useUsageLimitStore.getState().setPlanTier(planTier.toUpperCase() as "FREE" | "FOUNDING_SUPPORTER")

        // Calculate percentages
        const voiceLimit = data?.limits?.daily_voice_seconds || 600
        const voiceUsed = data?.today?.voice_seconds || 0
        const voicePercent = voiceLimit > 0 ? ((voiceUsed / voiceLimit) * 100) : 0

        const textLimit = data?.limits?.daily_text_messages || 50
        const textUsed = data?.today?.text_messages || 0
        const textPercent = textLimit > 0 ? ((textUsed / textLimit) * 100) : 0

        // Update store with user_id for backend requests
        useUsageLimitStore.getState().setUsageData(voicePercent, textPercent, user.id)
        
        // Check voice alerts
        const voiceInfo: UsageLimitInfo = {
          reason: "voice",
          plan_tier: planTier.toUpperCase(),
          limit: voiceLimit,
          used: voiceUsed,
        }
        useUsageLimitStore.getState().applyUsageInfo(voiceInfo)

        // Check text alerts
        const textInfo: UsageLimitInfo = {
          reason: "text",
          plan_tier: planTier.toUpperCase(),
          limit: textLimit,
          used: textUsed,
        }
        useUsageLimitStore.getState().applyUsageInfo(textInfo)

        // Update global cache
        usageCache.userId = user.id
        usageCache.timestamp = Date.now()
        initialFetchDone.current = true
        
      } catch (err) {
        // Ignore abort errors, silent fail for others (usage monitoring is non-critical)
        if (err instanceof Error && err.name === 'AbortError') {
          return
        }
      }
    }

    fetchInitialUsage()
    
    // Cleanup: abort pending request on unmount
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [user])
}
