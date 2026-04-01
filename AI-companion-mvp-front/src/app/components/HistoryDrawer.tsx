"use client"

import { useEffect, useCallback, useRef, useState, useMemo } from "react"
import { X, History, RefreshCw, ArrowUpRight, Target, MessageCircle, Wind } from "lucide-react"
import { useTranslation } from "../copy"
import { 
  useConversationStore, 
  selectIsLoadingConversation,
} from "../stores/conversation-store"
import { useSessionHistoryStore } from "../stores/session-history-store"
import { useUiStore } from "../stores/ui-store"
import { haptic } from "../hooks/useHaptics"
import { useRouter } from "next/navigation"
import { humanizeTime } from "../lib/humanize-time"
import type { PresetType } from "../lib/session-types"

/** Max recent sessions shown in the quick-access drawer */
const MAX_RECENT = 7

const PRESET_LABELS: Record<PresetType, string> = {
  prepare: "Pre-game",
  debrief: "Post-game",
  reset: "Reset",
  vent: "Vent",
  open: "Chat",
  chat: "Chat",
}

const PRESET_ICONS: Record<PresetType, typeof Target> = {
  prepare: Target,
  debrief: MessageCircle,
  reset: RefreshCw,
  vent: Wind,
  open: MessageCircle,
  chat: MessageCircle,
}

const CONTEXT_MODE_BADGE: Record<string, string> = {
  gaming: "bg-sophia-accent/12 text-sophia-accent",
  work: "bg-sophia-purple/12 text-sophia-purple",
}

type HistoryDrawerProps = {
  isOpen: boolean
  onClose: () => void
  onConversationLoaded: () => void
}

export function HistoryDrawer({ isOpen, onClose, onConversationLoaded }: HistoryDrawerProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const showToast = useUiStore((state) => state.showToast)
  
  // Conversation loader (for session playback)
  const isLoadingConversation = useConversationStore(selectIsLoadingConversation)
  const conversationError = useConversationStore(state => state.conversationError)
  const loadConversationAction = useConversationStore(state => state.loadConversation)
  
  // Session history
  const sessions = useSessionHistoryStore(state => state.sessions)
  const sessionCount = sessions.length
  const recentSessions = useMemo(() => sessions.slice(0, MAX_RECENT), [sessions])
  
  // Local state for animations
  const [isClosing, setIsClosing] = useState(false)
  const [isAnimatingIn, setIsAnimatingIn] = useState(true)
  const drawerRef = useRef<HTMLDivElement>(null)
  const touchStartX = useRef<number>(0)
  const touchCurrentX = useRef<number>(0)
  const [lastAttempted, setLastAttempted] = useState<{ id: string; source: "local" | "backend" | "mixed" } | null>(null)
  
  const handleClose = useCallback(() => {
    setIsClosing(true)
    // Wait for animation to finish
    setTimeout(() => {
      onClose()
      setIsClosing(false)
    }, 200)
  }, [onClose])
  
  // Animate drawer in
  useEffect(() => {
    if (isOpen) {
      setIsClosing(false)
      setIsAnimatingIn(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsAnimatingIn(false)
        })
      })
    }
  }, [isOpen])
  
  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        handleClose()
      }
    }
    
    document.addEventListener("keydown", handleEscape)
    return () => document.removeEventListener("keydown", handleEscape)
  }, [isOpen, handleClose])
  
  // Lock body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = ""
    }
    return () => {
      document.body.style.overflow = ""
    }
  }, [isOpen])
  
  // Phase 4 Week 4: Idempotent conversation loading
  const handleLoadConversation = useCallback(async (
    conversationId: string,
    source: "local" | "backend" | "mixed" = "local"
  ) => {
    haptic('light')
    setLastAttempted({ id: conversationId, source })
    
    // Use the conversation store's loader (handles cancellation, archiving, deduping)
    const success = await loadConversationAction(conversationId, source)
    
    if (success) {
      handleClose()
      onConversationLoaded()
    } else {
      showToast({
        message: "Couldn’t open that session. Tap Retry.",
        variant: "warning",
        durationMs: 3200,
      })
    }
  }, [handleClose, onConversationLoaded, loadConversationAction, showToast])
  
  // Navigate to the full history page
  const handleViewAll = useCallback(() => {
    haptic('light')
    handleClose()
    router.push('/history')
  }, [handleClose, router])
  
  // Touch handlers for swipe-to-close (mobile)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchCurrentX.current = e.touches[0].clientX
  }, [])
  
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    touchCurrentX.current = e.touches[0].clientX
    const drawer = drawerRef.current
    if (!drawer) return
    
    const diff = touchCurrentX.current - touchStartX.current
    // Only allow swiping right (to close)
    if (diff > 0) {
      drawer.style.transform = `translateX(${diff}px)`
    }
  }, [])
  
  const handleTouchEnd = useCallback(() => {
    const diff = touchCurrentX.current - touchStartX.current
    const drawer = drawerRef.current
    
    if (drawer) {
      drawer.style.transform = ""
    }
    
    // If swiped more than 100px to the right, close
    if (diff > 100) {
      haptic('light')
      handleClose()
    }
  }, [handleClose])
  
  if (!isOpen && !isClosing) return null
  
  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop - frosted glass effect */}
      <div
        className={`absolute inset-0 bg-sophia-bg/80 backdrop-blur-sm transition-opacity duration-300 ${
          isClosing || isAnimatingIn ? "opacity-0" : "opacity-100"
        }`}
        onClick={handleClose}
        aria-hidden="true"
      />
      
      {/* Drawer panel - modern glass design */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-drawer-title"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`
          absolute right-0 top-0 h-full
          bg-sophia-surface dark:bg-sophia-surface/95 dark:backdrop-blur-xl
          border-l border-sophia-surface-border
          shadow-[0_0_60px_-15px_color-mix(in_srgb,var(--sophia-purple)_30%,transparent)]
          flex flex-col
          transition-transform duration-300 ease-out
          w-full sm:w-[400px] sm:max-w-[90vw]
          ${isClosing || isAnimatingIn ? "translate-x-full" : "translate-x-0"}
        `}
      >
        {/* Header - refined with subtle gradient */}
        <div className="relative flex items-center justify-between p-5 border-b border-sophia-surface-border">
          {/* Subtle gradient overlay */}
          <div 
            className="absolute inset-0 opacity-30 pointer-events-none"
            style={{
              background: 'linear-gradient(135deg, var(--sophia-purple) 0%, transparent 50%)',
              opacity: 0.05,
            }}
          />
          
          <div className="relative flex items-center gap-3">
            <div className="p-2 rounded-xl bg-sophia-purple/10 border border-sophia-surface-border">
              <History className="w-4.5 h-4.5 text-sophia-purple" />
            </div>
            <div>
              <h2 id="history-drawer-title" className="text-base font-semibold text-sophia-text">
                Recent sessions
              </h2>
              <p className="text-[11px] text-sophia-text2/60 mt-0.5">
                {sessionCount} sessions
              </p>
            </div>
          </div>
          <div className="relative flex items-center gap-1.5">
            <button
              onClick={handleClose}
              className="p-2 rounded-xl bg-sophia-surface border border-sophia-surface-border hover:bg-sophia-button hover:border-sophia-purple/20 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
              aria-label="Close history drawer"
            >
              <X className="w-3.5 h-3.5 text-sophia-text2" />
            </button>
          </div>
        </div>

        {/* Error banner (compact) */}
        {conversationError && lastAttempted && (
          <div className="mx-4 mt-2 px-3 py-2 bg-sophia-warning/10 border border-sophia-warning/20 rounded-lg text-sophia-warning text-xs flex items-center gap-2">
            <span>⚠️ {conversationError}</span>
            <button
              onClick={() => handleLoadConversation(lastAttempted.id, lastAttempted.source)}
              className="underline hover:no-underline ml-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple rounded"
            >
              {t("welcomeBack.retry")}
            </button>
          </div>
        )}
        
        {/* Loading indicator */}
        {isLoadingConversation && (
          <div className="mx-4 mt-2 px-3 py-2 bg-sophia-purple/10 border border-sophia-purple/20 rounded-lg text-sophia-purple text-xs flex items-center gap-2">
            <RefreshCw className="w-3 h-3 animate-spin" />
            <span>Loading…</span>
          </div>
        )}
        
        {/* Swipe indicator (mobile only) */}
        <div className="sm:hidden flex justify-center py-2">
          <div className="w-10 h-1 rounded-full bg-sophia-purple/20" />
        </div>
        
        {/* Recent sessions list */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin">
          {isLoadingConversation && recentSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12">
              <div className="w-12 h-12 rounded-2xl bg-sophia-purple/10 flex items-center justify-center mb-4">
                <RefreshCw className="w-5 h-5 text-sophia-purple/50 animate-spin" />
              </div>
              <p className="text-sm font-medium text-sophia-text">Loading…</p>
            </div>
          ) : recentSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12">
              <div className="w-12 h-12 rounded-2xl bg-sophia-surface/50 border border-sophia-surface-border flex items-center justify-center mb-4">
                <History className="w-5 h-5 text-sophia-text2/40" />
              </div>
              <p className="text-sm font-medium text-sophia-text">No sessions yet</p>
              <p className="text-xs text-center mt-1.5 text-sophia-text2/60">
                Finish a session to see it here
              </p>
            </div>
          ) : (
            <>
              {recentSessions.map((session) => {
                const Icon = PRESET_ICONS[session.presetType]
                const label = PRESET_LABELS[session.presetType]
                const timeAgo = humanizeTime(session.endedAt)

                return (
                  <button
                    key={session.sessionId}
                    onClick={() => handleLoadConversation(session.sessionId, "backend")}
                    className={`
                      w-full rounded-2xl text-left transition-all duration-200 group
                      border border-sophia-surface-border p-4
                      bg-sophia-surface shadow-soft
                      hover:border-sophia-purple/30 hover:bg-sophia-surface hover:shadow-md hover:-translate-y-0.5
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-inset
                      ${!session.recapViewed ? "ring-1 ring-sophia-purple/20" : ""}
                    `}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`
                          w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors
                          ${!session.recapViewed ? "bg-sophia-purple/15" : "bg-sophia-surface-border/40 group-hover:bg-sophia-purple/10"}
                        `}
                      >
                        <Icon
                          className={`w-4 h-4 transition-colors ${
                            !session.recapViewed
                              ? "text-sophia-purple"
                              : "text-sophia-text2/70 group-hover:text-sophia-purple"
                          }`}
                        />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-sophia-text">{label}</span>
                          <span
                            className={`text-[10px] capitalize px-1.5 py-0.5 rounded-full ${
                              CONTEXT_MODE_BADGE[session.contextMode] || "bg-sophia-surface/70 text-sophia-text2"
                            }`}
                          >
                            {session.contextMode}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-[11px] text-sophia-text2/50" title={timeAgo.tooltip}>
                            {timeAgo.text}
                          </span>
                          {session.messageCount > 0 && (
                            <>
                              <span className="text-sophia-text2/30">·</span>
                              <span className="text-[11px] text-sophia-text2/50">
                                {session.messageCount} msgs
                              </span>
                            </>
                          )}
                        </div>

                        {session.takeawayPreview && (
                          <p className="text-[12px] text-sophia-text2/70 mt-2 line-clamp-2">
                            {session.takeawayPreview}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </>
          )}
        </div>
        
        {/* Footer: View All History → /history */}
        <div className="border-t border-sophia-surface-border px-4 py-3">
          <button
            onClick={handleViewAll}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-sophia-text bg-sophia-button border border-sophia-surface-border hover:bg-sophia-button-hover hover:border-sophia-purple/30 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
          >
            <ArrowUpRight className="w-4 h-4" />
            View all history
            <span className="text-[10px] font-semibold bg-sophia-purple/15 px-1.5 py-0.5 rounded-full">
              {sessionCount}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
