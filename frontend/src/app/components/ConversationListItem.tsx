/**
 * ConversationListItem Component
 * ================================
 * 
 * Reusable conversation history item.
 * Extracted from HistoryDrawer for better maintainability.
 */

"use client"

import { Mic, MessageCircle, Layers, Cloud, Trash2, Clock, ChevronRight } from "lucide-react"
import { useCallback } from "react"

import { useTranslation } from "../copy"
import { haptic } from "../hooks/useHaptics"
import { formatLocalizedRelativeTime } from "../lib/format-time-localized"

export interface ConversationItem {
  id: string
  title: string
  preview: string
  updatedAt: number | Date
  messageCount: number
  inputMode: "voice" | "text" | "mixed"
  source?: "backend" | "local" | "mixed"
}

interface ConversationListItemProps {
  conversation: ConversationItem
  onClick: () => void
  onDelete: (e: React.MouseEvent) => void
}

/**
 * Single conversation item in the history list.
 * Shows mode indicator, title, preview, timestamp, and message count.
 */
export function ConversationListItem({ 
  conversation, 
  onClick, 
  onDelete 
}: ConversationListItemProps) {
  const { t, locale } = useTranslation()
  
  const { id, title, preview, updatedAt, messageCount, inputMode, source } = conversation

  // Mode icon component
  const ModeIcon = inputMode === "voice" 
    ? Mic 
    : inputMode === "mixed" 
    ? Layers 
    : MessageCircle

  // Mode label for badge - translated
  const modeLabel = t(`welcomeBack.modes.${inputMode}`)
  
  // Get time translations for localized formatting
  const timeTranslations = {
    justNow: t("welcomeBack.time.justNow"),
    momentAgo: t("welcomeBack.time.momentAgo"),
    fewMinutesAgo: t("welcomeBack.time.fewMinutesAgo"),
    earlierThisHour: t("welcomeBack.time.earlierThisHour"),
    earlierToday: t("welcomeBack.time.earlierToday"),
    thisMorning: t("welcomeBack.time.thisMorning"),
    thisAfternoon: t("welcomeBack.time.thisAfternoon"),
    thisEvening: t("welcomeBack.time.thisEvening"),
    yesterdayMorning: t("welcomeBack.time.yesterdayMorning"),
    yesterdayAfternoon: t("welcomeBack.time.yesterdayAfternoon"),
    yesterdayEvening: t("welcomeBack.time.yesterdayEvening"),
    twoDaysAgo: t("welcomeBack.time.twoDaysAgo"),
    threeDaysAgo: t("welcomeBack.time.threeDaysAgo"),
    fewDaysAgo: t("welcomeBack.time.fewDaysAgo"),
    lastWeek: t("welcomeBack.time.lastWeek"),
    coupleWeeksAgo: t("welcomeBack.time.coupleWeeksAgo"),
    fewWeeksAgo: t("welcomeBack.time.fewWeeksAgo"),
  }
  
  const formattedTime = formatLocalizedRelativeTime(
    typeof updatedAt === 'number' ? updatedAt : updatedAt.getTime(),
    timeTranslations,
    locale
  )

  const handleOpen = useCallback(() => {
    haptic('light')
    onClick()
  }, [onClick])

  const handleDelete = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
    haptic('medium')
    onDelete(event)
  }, [onDelete])

  return (
    <button
      key={id}
      onClick={handleOpen}
      className="group w-full flex items-start gap-3 p-3.5 rounded-xl bg-sophia-bg/20 hover:bg-sophia-bg/40 border border-transparent hover:border-sophia-surface-border transition-all duration-200 text-left"
    >
      {/* Mode indicator icon */}
      <div className="w-9 h-9 rounded-lg flex-shrink-0 bg-sophia-surface-border/40 group-hover:bg-sophia-purple/15 flex items-center justify-center relative transition-colors">
        <ModeIcon className="w-4 h-4 text-sophia-text2/70 group-hover:text-sophia-purple transition-colors" />
        {/* Source indicator (cloud for backend-synced) */}
        {source === "backend" && (
          <Cloud className="w-2.5 h-2.5 absolute -top-0.5 -right-0.5 text-sophia-purple" />
        )}
      </div>
      
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-medium text-sophia-text truncate text-sm">
              {title}
            </h3>
            {/* Mode badge */}
            <span className="flex-shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide bg-sophia-purple/15 text-sophia-purple">
              {modeLabel}
            </span>
          </div>
          
          {/* Delete button — the extended ::before reaches a ~40px touch target
              without changing the visual size. On desktop the button stays hidden
              behind `group-hover`; on touch (`:focus-within`) it stays reachable. */}
          <button
            onClick={handleDelete}
            className="relative opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 hover:bg-sophia-error/10 rounded-lg transition-all flex-shrink-0 border border-transparent hover:border-sophia-error/20 before:absolute before:-inset-2.5 before:content-[''] before:rounded-xl"
            title={t("welcomeBack.deleteConversationTitle")}
          >
            <Trash2 className="w-4 h-4 text-sophia-error/60 hover:text-sophia-error" />
          </button>
        </div>
        
        {/* Preview text */}
        <p className="text-[12px] text-sophia-text2/70 truncate mt-1.5">
          {preview}
        </p>
        
        {/* Metadata */}
        <div className="flex items-center gap-1.5 mt-2 text-[11px] text-sophia-text2/50">
          <Clock className="w-3 h-3" />
          <span>{formattedTime}</span>
          <span className="text-sophia-text2/30">·</span>
          <span>{t("welcomeBack.messagesCount", { count: messageCount })}</span>
        </div>
      </div>
      
      {/* Chevron indicator */}
      <ChevronRight className="w-4 h-4 text-sophia-text2/30 group-hover:text-sophia-purple transition-colors flex-shrink-0 mt-2.5" />
    </button>
  )
}

export default ConversationListItem
