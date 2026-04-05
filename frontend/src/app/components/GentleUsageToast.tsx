"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useUsageLimitStore } from "../stores/usage-limit-store"
import { useCopy, useTranslation } from "../copy"
import { Sparkles, X } from "lucide-react"

/**
 * Gentle, non-blocking toast that appears when user reaches 80% of their limit
 * Designed to be informative and calm, never threatening
 * Can be dismissed by the user
 * 
 * Redesigned to be more subtle, elegant, and aligned with Sophia's calming presence
 */
export function GentleUsageToast() {
  const copy = useCopy()
  const { t } = useTranslation()
  const router = useRouter()

  const toastInfo = useUsageLimitStore((state) => state.toastInfo)
  const dismissToast = useUsageLimitStore((state) => state.dismissToast)
  const [isVisible, setIsVisible] = useState(false)
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    if (toastInfo) {
      setIsExiting(false)
      // Gentle slide-up animation
      setTimeout(() => setIsVisible(true), 50)
      
      // Auto-dismiss after 8 seconds (gentle, not intrusive)
      const autoDismiss = setTimeout(() => {
        handleDismiss()
      }, 8000)
      
      return () => clearTimeout(autoDismiss)
    } else {
      setIsVisible(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastInfo])

  const handleDismiss = () => {
    setIsExiting(true)
    setTimeout(() => {
      setIsVisible(false)
      dismissToast()
    }, 400) // Smooth fade out
  }

  if (!toastInfo) return null

  const getToastText = () => {
    const remaining = toastInfo.limit - toastInfo.used
    
    switch (toastInfo.reason) {
      case "voice":
        return t("usageLimit.toastVoice", { remaining: Math.round(remaining / 60) })
      case "text":
        return t("usageLimit.toastText", { remaining })
      case "reflections":
        return t("usageLimit.toastReflections", { remaining })
      default:
        return null
    }
  }

  const toastText = getToastText()
  if (!toastText) return null

  return (
    <div
      className={`fixed bottom-24 left-1/2 z-40 w-full max-w-sm -translate-x-1/2 px-4 transition-all duration-500 ease-out ${
        isVisible && !isExiting
          ? "translate-y-0 opacity-100"
          : "translate-y-8 opacity-0 pointer-events-none"
      }`}
    >
      <div className="relative rounded-2xl border border-sophia-purple/20 bg-sophia-surface p-4 shadow-lg shadow-sophia-purple/10 animate-breatheSlow">
        {/* Subtle glow effect overlay - positioned behind content */}
        <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-sophia-purple/10 via-transparent to-transparent opacity-60" />
        
        <div className="relative flex items-start gap-3">
          {/* Icon with more Sophia color */}
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sophia-purple/15 to-sophia-purple/8 shadow-sm">
            <Sparkles className="h-3.5 w-3.5 text-sophia-purple" />
          </div>
          
          <div className="flex-1 space-y-1.5 min-w-0">
            {/* Title with more Sophia color */}
            <p className="text-xs font-semibold text-sophia-purple">
              {copy.usageLimit.toastTitle}
            </p>
            
            {/* More breathing room, softer text */}
            <p className="text-xs leading-relaxed text-sophia-text2/90">
              {toastText}
            </p>
            
            {/* CTA link with more presence */}
            <button
              type="button"
              onClick={() => {
                router.push("/founding-supporter")
              }}
              className="text-xs font-semibold text-sophia-purple hover:text-sophia-glow transition-colors duration-200"
            >
              {copy.usageLimit.toastCta}
            </button>
          </div>
          
          {/* Smaller, more subtle close button */}
          <button
            type="button"
            onClick={handleDismiss}
            className="flex-shrink-0 rounded-lg p-1 text-sophia-text2/60 transition-all duration-200 hover:bg-sophia-purple/10 hover:text-sophia-purple/80"
            aria-label={copy.misc.dismiss}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

