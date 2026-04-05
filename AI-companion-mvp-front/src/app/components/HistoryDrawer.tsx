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
  life: "bg-rose-400/12 text-rose-500 dark:bg-rose-300/12 dark:text-rose-200",
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
        className={`absolute inset-0 bg-black/35 backdrop-blur-md transition-opacity duration-300 ${
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
          bg-white/84 backdrop-blur-2xl dark:bg-black/42
          border-l border-black/8 dark:border-white/[0.08]
          shadow-[0_20px_80px_rgba(0,0,0,0.18)] dark:shadow-[0_24px_90px_rgba(0,0,0,0.5)]
          flex flex-col
          transition-transform duration-300 ease-out
          w-full sm:w-[400px] sm:max-w-[90vw]
          ${isClosing || isAnimatingIn ? "translate-x-full" : "translate-x-0"}
        `}
      >
        {/* Header - refined with subtle gradient */}
        <div className="relative flex items-center justify-between p-5 border-b border-black/8 dark:border-white/[0.08]">
          {/* Subtle gradient overlay */}
          <div 
            className="absolute inset-0 opacity-30 pointer-events-none"
            style={{
              background: 'linear-gradient(135deg, var(--sophia-purple) 0%, transparent 50%)',
              opacity: 0.05,
            }}
          />
          
          <div className="relative flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-black/8 bg-white/80 text-[var(--sophia-purple)] shadow-[0_10px_24px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:bg-white/[0.06] dark:shadow-[0_14px_36px_rgba(0,0,0,0.35)]">
              <History className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 id="history-drawer-title" className="font-cormorant text-[1.5rem] leading-none text-black/80 dark:text-white/82">
                Recent sessions
              </h2>
              <p className="mt-1 text-[11px] tracking-[0.04em] text-black/42 dark:text-white/42">
                Continuity and recall
              </p>
            </div>
          </div>
          <div className="relative flex items-center gap-1.5">
            <button
              onClick={handleClose}
              className="flex h-10 w-10 items-center justify-center rounded-2xl border border-black/8 bg-white/74 text-black/48 transition-all hover:bg-white/90 hover:text-black/68 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white/52 dark:hover:bg-white/[0.08] dark:hover:text-white/74"
              aria-label="Close history drawer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Error banner (compact) */}
        {conversationError && lastAttempted && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-2xl border border-sophia-warning/20 bg-sophia-warning/10 px-3 py-2 text-xs text-sophia-warning shadow-[0_10px_24px_rgba(0,0,0,0.05)] dark:shadow-[0_16px_32px_rgba(0,0,0,0.2)]">
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
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-2xl border border-sophia-purple/20 bg-sophia-purple/10 px-3 py-2 text-xs text-sophia-purple shadow-[0_10px_24px_rgba(0,0,0,0.05)] dark:shadow-[0_16px_32px_rgba(0,0,0,0.2)]">
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
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] border border-black/8 bg-white/80 text-sophia-purple shadow-[0_14px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:bg-white/[0.06] dark:shadow-[0_20px_36px_rgba(0,0,0,0.35)]">
                <RefreshCw className="w-5 h-5 text-sophia-purple/50 animate-spin" />
              </div>
              <p className="text-sm font-medium text-black/68 dark:text-white/74">Loading…</p>
            </div>
          ) : recentSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] border border-black/8 bg-white/78 text-black/36 shadow-[0_14px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-white/36 dark:shadow-[0_20px_36px_rgba(0,0,0,0.35)]">
                <History className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium text-black/68 dark:text-white/74">No sessions yet</p>
              <p className="mt-1.5 text-center text-xs text-black/44 dark:text-white/46">
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
                      w-full rounded-[1.4rem] text-left transition-all duration-200 group
                      border p-4 backdrop-blur-xl
                      border-black/8 bg-white/78 shadow-[0_14px_34px_rgba(0,0,0,0.08)]
                      hover:-translate-y-0.5 hover:border-sophia-purple/26 hover:bg-white/88 hover:shadow-[0_18px_40px_rgba(0,0,0,0.11)]
                      dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_18px_40px_rgba(0,0,0,0.35)] dark:hover:border-sophia-purple/30 dark:hover:bg-white/[0.07] dark:hover:shadow-[0_20px_44px_rgba(0,0,0,0.42)]
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-inset
                      ${!session.recapViewed ? "ring-1 ring-sophia-purple/20" : ""}
                    `}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`
                          flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border transition-colors
                          ${!session.recapViewed ? "border-sophia-purple/18 bg-sophia-purple/12" : "border-black/8 bg-black/[0.03] group-hover:border-sophia-purple/16 group-hover:bg-sophia-purple/10 dark:border-white/[0.08] dark:bg-white/[0.04]"}
                        `}
                      >
                        <Icon
                          className={`w-4 h-4 transition-colors ${
                            !session.recapViewed
                              ? "text-sophia-purple"
                              : "text-black/52 group-hover:text-sophia-purple dark:text-white/56"
                          }`}
                        />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-black/72 dark:text-white/78">{label}</span>
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[10px] capitalize ${
                              CONTEXT_MODE_BADGE[session.contextMode] || "bg-black/[0.05] text-black/48 dark:bg-white/[0.08] dark:text-white/52"
                            }`}
                          >
                            {session.contextMode}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-[11px] text-black/42 dark:text-white/44" title={timeAgo.tooltip}>
                            {timeAgo.text}
                          </span>
                          {session.messageCount > 0 && (
                            <>
                              <span className="text-black/22 dark:text-white/24">·</span>
                              <span className="text-[11px] text-black/42 dark:text-white/44">
                                {session.messageCount} msgs
                              </span>
                            </>
                          )}
                        </div>

                        {session.takeawayPreview && (
                          <p className="mt-2 line-clamp-2 text-[12px] text-black/56 dark:text-white/56">
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
        <div className="border-t border-black/8 px-4 py-3 dark:border-white/[0.08]">
          <button
            onClick={handleViewAll}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-black/8 bg-white/78 px-4 py-2.5 text-sm font-medium text-black/66 transition-all hover:border-sophia-purple/24 hover:bg-white/90 hover:text-black/78 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white/70 dark:hover:border-sophia-purple/28 dark:hover:bg-white/[0.08] dark:hover:text-white/82"
          >
            <ArrowUpRight className="w-4 h-4" />
            View all history
            <span className="rounded-full bg-sophia-purple/12 px-1.5 py-0.5 text-[10px] font-semibold text-sophia-purple dark:bg-sophia-purple/18">
              {sessionCount}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
