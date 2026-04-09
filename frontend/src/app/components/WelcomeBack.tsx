"use client"

import { MessageSquare, Plus, Clock, ChevronRight } from "lucide-react"
import { useState, useEffect, useCallback, useMemo } from "react"

import { useCopy, useTranslation } from "../copy"
import { haptic } from "../hooks/useHaptics"
import { useSessionPersistence } from "../hooks/useSessionPersistence"
import { 
  getCurrentSessionPreview, 
  formatRelativeTime,
  type ConversationSummary 
} from "../lib/conversation-history"
import { getTimeBasedGreeting } from "../lib/time-greetings"
import type { PresetType } from "../types/session"


type WelcomeBackProps = {
  onContinue: () => void
  onStartNew: () => void
  onPromptSelect: (prompt: string) => void
}

// Ritual emoji mapping
const RITUAL_EMOJI: Record<PresetType, string> = {
  prepare: '🎯',
  debrief: '💭',
  reset: '🔄',
  vent: '💨',
  open: '✨',
  chat: '💬',
};

// Ritual labels (friendly names)
const RITUAL_LABELS: Record<PresetType, string> = {
  prepare: 'Prepare',
  debrief: 'Debrief',
  reset: 'Reset',
  vent: 'Vent',
  open: 'Chat',
  chat: 'Chat',
};

export function WelcomeBack({ onContinue, onStartNew, onPromptSelect }: WelcomeBackProps) {
  const copy = useCopy()
  const { t } = useTranslation()

  const [currentSession, setCurrentSession] = useState<ConversationSummary | null>(null)
  const [mounted, setMounted] = useState(false)
  
  // Session persistence hook (Phase 4 - Week 4)
  const { restoreSession, canResume, getSummary, clearAndStartFresh } = useSessionPersistence()
  const snapshotSummary = useMemo(() => getSummary(), [getSummary])
  
  // Get time-based greeting on mount
  const greeting = useMemo(() => getTimeBasedGreeting(copy), [copy])
  
  useEffect(() => {
    setMounted(true)
    // Use snapshot if available, otherwise fall back to old session preview
    if (canResume && snapshotSummary.hasSnapshot && !snapshotSummary.isStale) {
      // Convert snapshot to ConversationSummary format for display
      const now = Date.now()
      setCurrentSession({
        id: 'snapshot',
        title: snapshotSummary.sessionType 
          ? `${RITUAL_EMOJI[snapshotSummary.sessionType]} ${RITUAL_LABELS[snapshotSummary.sessionType]}`
          : '💬 Chat',
        preview: snapshotSummary.lastMessagePreview || 'Continue your conversation...',
        messageCount: snapshotSummary.messageCount,
        createdAt: now,
        updatedAt: new Date(snapshotSummary.updatedAt).getTime(),
        inputMode: 'text',
        voiceCount: 0,
        textCount: snapshotSummary.messageCount,
      })
    } else {
      setCurrentSession(getCurrentSessionPreview())
    }
  }, [canResume, snapshotSummary])
  
  const handleContinue = useCallback(() => {
    haptic('medium')
    // Restore from snapshot (Phase 4 - Week 4)
    restoreSession()
    // Always proceed - even if restore fails, let user continue
    onContinue()
  }, [restoreSession, onContinue])
  
  const handleStartNew = useCallback(async () => {
    haptic('light')
    
    // Clear snapshot and archive (Phase 4 - Week 4)
    await clearAndStartFresh()
    
    // Refresh UI state
    setCurrentSession(null)
    
    onStartNew()
  }, [clearAndStartFresh, onStartNew])
  
  if (!mounted) return null
  
  // Welcome Back view with current session
  if (currentSession) {
    return (
      <>
        <div className="flex h-full flex-col justify-between gap-6 rounded-2xl bg-sophia-bubble p-8 text-sophia-text animate-in fade-in duration-300">
          {/* Header */}
          <div className="space-y-4">
            <p className="inline-flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-sophia-purple animate-breathe">
              <span className="text-base">{greeting.icon}</span>
              <span>{greeting.heading}</span>
            </p>
            
            <div className="space-y-3">
              <h2 className="text-3xl font-semibold text-sophia-text sm:text-4xl">
                {t("welcomeBack.continueOurConversation")}
            </h2>
            <p className="text-base leading-relaxed text-sophia-text2 sm:text-lg">
              {t("welcomeBack.unfinishedConversationFrom", {
                time: formatRelativeTime(currentSession.updatedAt).toLowerCase(),
              })}
            </p>
          </div>
        </div>
        
        {/* Current session card */}
        <div 
          onClick={handleContinue}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleContinue(); } }}
          role="button"
          tabIndex={0}
          className="group cursor-pointer rounded-xl bg-sophia-surface border border-sophia-surface-border hover:border-sophia-purple/40 hover:bg-sophia-button-hover hover:shadow-md transition-all duration-200 p-4 sm:p-5 overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
        >
          <div className="flex items-start gap-3 sm:gap-4 min-w-0">
            <div className="flex-shrink-0 p-2.5 sm:p-3 rounded-xl bg-sophia-purple/10 text-sophia-purple">
              <MessageSquare className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sophia-text text-lg truncate group-hover:text-sophia-purple transition-colors">
                {currentSession.title}
              </h3>
              <p className="text-sm text-sophia-text2 mt-1 line-clamp-2">
                {currentSession.preview}
              </p>
              <div className="mt-3 space-y-1 text-xs text-sophia-text2/70 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{formatRelativeTime(currentSession.updatedAt)}</span>
                </div>
                <div className="truncate">
                  {t("welcomeBack.messagesCount", { count: currentSession.messageCount })}
                </div>
              </div>
            </div>
            <ChevronRight className="hidden xs:block w-5 h-5 flex-shrink-0 text-sophia-text2/50 group-hover:text-sophia-purple transition-colors mt-1" />
          </div>
        </div>
        
        {/* Action buttons */}
        <div className="space-y-3">
          <button
            onClick={handleContinue}
            className="w-full py-4 rounded-xl bg-sophia-purple text-white font-semibold text-lg shadow-lg shadow-sophia-purple/20 hover:shadow-sophia-purple/30 hover:brightness-105 transition-all duration-200 active:scale-[0.98]"
          >
            {t("welcomeBack.continueConversation")}
          </button>
          
          <div className="flex gap-3">
            <button
              onClick={handleStartNew}
              className="flex-1 py-3 rounded-xl border border-sophia-surface-border bg-sophia-surface text-sophia-purple font-medium transition-all hover:border-sophia-purple/30 hover:bg-sophia-purple/5 active:scale-[0.98]"
            >
              <Plus className="w-4 h-4 inline-block mr-2" />
              {t("welcomeBack.startNew")}
            </button>
            
          </div>
        </div>
        </div>
      </>
    )
  }
  
  // No current session - show regular empty state with history access
  return (
    <>
      <div className="flex h-full flex-col justify-between gap-8 rounded-2xl bg-sophia-bubble p-8 text-sophia-text">
        <div className="space-y-4">
          {/* Presence indicator with breathing animation */}
          <p className="inline-flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-sophia-purple animate-breathe">
            <span className="text-base">{greeting.icon}</span>
            <span>{copy.home.hero.status}</span>
          </p>
          
          {/* Welcome message with time-based greeting */}
          <div className="space-y-3">
            <h2 className="text-3xl font-semibold text-sophia-text sm:text-4xl">
              {greeting.heading}
            </h2>
            <p className="text-base leading-relaxed text-sophia-text2 sm:text-lg">
              {greeting.body}
            </p>
          </div>
        </div>
        
        {/* Quick prompts */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-sophia-text2">{t("welcomeBack.tryAsking")}</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {copy.chat.quickPrompts.map((prompt, index) => (
              <button
                key={prompt.id}
                type="button"
                className="group cursor-pointer rounded-xl border border-sophia-surface-border bg-sophia-surface px-4 py-2.5 text-sm font-medium text-sophia-text shadow-soft transition-all duration-300 ease-out hover:scale-[1.02] hover:border-sophia-purple/40 hover:bg-sophia-button-hover hover:text-sophia-purple hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/20"
                onClick={() => onPromptSelect(prompt.label)}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <span className="mr-2 inline-block text-base transition-transform duration-300 group-hover:scale-110" aria-hidden>
                  {prompt.emoji}
                </span>
                <span>{prompt.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
