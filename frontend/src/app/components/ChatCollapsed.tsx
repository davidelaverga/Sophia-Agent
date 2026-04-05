"use client"

import { MessageSquare, ChevronRight } from "lucide-react"
import { useModeSwitch } from "../hooks/useModeSwitch"
import { useUsageLimitStore } from "../stores/usage-limit-store"
import { useTranslation } from "../copy"

/**
 * ChatCollapsed
 * 
 * Minimal indicator shown when user is in voice mode.
 * Simple click to switch to text focus mode.
 * Includes validation to prevent switching during voice operations.
 */

export function ChatCollapsed() {
  const { t } = useTranslation()
  const showToast = useUsageLimitStore((state) => state.showToast)
  
  const { canSwitchToChat, switchToChat } = useModeSwitch({
    onBlocked: (_message) => {
      // Show toast with the block reason
      showToast({
        reason: "voice",
        plan_tier: "FREE",
        used: 0,
        limit: 0,
      })
    },
  })
  
  const isDisabled = !canSwitchToChat.canSwitch
  const tooltipMessage = canSwitchToChat.message || t("collapsed.chat.tooltipFallback")

  return (
    <button
      type="button"
      onClick={switchToChat}
      disabled={isDisabled}
      title={tooltipMessage}
      className="w-full group rounded-2xl bg-sophia-surface p-3 sm:p-4 shadow-soft hover:shadow-md transition-all duration-300 animate-fadeIn disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-soft"
    >
      <div className="flex items-center gap-3 sm:gap-4">
        {/* Minimal chat icon */}
        <div className="relative flex-shrink-0">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-gradient-to-br from-sophia-purple/10 to-sophia-purple/5 flex items-center justify-center group-hover:from-sophia-purple/20 group-hover:to-sophia-purple/10 transition-all duration-300">
            <MessageSquare className="h-4 w-4 sm:h-5 sm:w-5 text-sophia-purple" />
          </div>
        </div>

        {/* Text */}
        <div className="flex-1 text-left">
          <p className="text-sm font-semibold text-sophia-text group-hover:text-sophia-purple transition-colors duration-300">
            {t("collapsed.chat.title")}
          </p>
          <p className="text-xs text-sophia-text2">
            {t("collapsed.chat.subtitle")}
          </p>
        </div>

        {/* Arrow indicator */}
        <div className="flex-shrink-0 text-sophia-purple/40 group-hover:text-sophia-purple group-hover:translate-x-1 transition-all duration-300">
          <ChevronRight className="h-5 w-5" />
        </div>
      </div>
    </button>
  )
}





