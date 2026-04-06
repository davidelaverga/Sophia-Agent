"use client"

import { Settings, History, Home } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, lazy, Suspense, Fragment } from "react"

import { useCopy, useTranslation } from "../copy"
import { haptic } from "../hooks/useHaptics"
import { useChatStore } from "../stores/chat-store"
import { getPresenceCopyKey, usePresenceStore } from "../stores/presence-store"
import { useUiStore as useFocusModeStore } from "../stores/ui-store"

import { ActiveModeIndicator } from "./ActiveModeIndicator"
import { FoundingSupporterBadge } from "./FoundingSupporterBadge"
import { ThemeToggle } from "./ThemeToggle"

// Lazy load HistoryDrawer
const HistoryDrawer = lazy(() => import("./HistoryDrawer").then(mod => ({ default: mod.HistoryDrawer })))

export function Header() {
  const router = useRouter()
  const copy = useCopy()
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)

  const status = usePresenceStore((state) => state.status)
  const detail = usePresenceStore((state) => state.detail)
  const setMode = useFocusModeStore((state) => state.setMode)
  const setManualOverride = useFocusModeStore((state) => state.setManualOverride)

  // Presence text for Sophia - used for title tooltip on logo
  const presenceText = detail ?? t(getPresenceCopyKey(status))

  // Mobile-only: Make the logo feel "alive" based on presence state (no extra UI)
  const mobilePresenceAnimation =
    status === "speaking"
      ? "animate-pulse-reply sm:animate-none"
      : status === "listening"
        ? "animate-ringBreathe sm:animate-none"
        : status === "reflecting"
          ? "animate-glowBreathe sm:animate-none"
          : status === "thinking"
            ? "animate-pulseSoft sm:animate-none"
            : "animate-breatheSlow sm:animate-none"

  const handleLogoClick = () => {
    // Haptic feedback for navigation
    haptic('light')
    
    // Clear messages from memory (session stays in localStorage)
    useChatStore.setState({
      messages: [],
      activeReplyId: undefined,
      isLocked: false,
      lastError: undefined,
    })
    
    // Switch to voice mode (home)
    setMode("voice")
    setManualOverride(false)
    
    // Emit event so Transcript shows WelcomeBack
    window.dispatchEvent(new CustomEvent("sophia:go-home"))
  }

  return (
    <Fragment>
      <header className="safe-px flex h-14 items-center justify-between gap-2 sm:bg-transparent bg-sophia-bg/80 backdrop-blur-md sm:backdrop-blur-none sticky top-0 z-10">
        {/* Left: Logo + Name - always visible */}
        <button
          type="button"
          onClick={handleLogoClick}
          className="flex items-center gap-2.5 min-w-0 group"
          aria-label={t("header.homeButtonAriaLabel")}
          title={t("header.homeButtonTitle")}
        >
        <div
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-sophia-purple text-lg font-semibold text-white transition-transform group-hover:scale-105 group-active:scale-95 ${mobilePresenceAnimation}`}
          title={presenceText}
        >
          {copy.brand.initial}
        </div>
        <div className="min-w-0 hidden sm:block text-left">
          <p className="text-base font-semibold text-sophia-text truncate">
            {copy.brand.name}
          </p>
          <p className="text-xs text-sophia-text2 truncate">{t("header.subtitle")}</p>
        </div>
      </button>
      
      {/* Right: Actions */}
      <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
        <ActiveModeIndicator />
        
        {/* Founding Supporter badge - hidden on small screens */}
        <FoundingSupporterBadge compact className="hidden md:flex" />
        
        {/* Dashboard button - back to V2 */}
        <button
          type="button"
          onClick={() => {
            haptic('light')
            router.push('/')
          }}
          className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl border border-sophia-surface-border bg-sophia-button hover:border-sophia-purple/40 hover:scale-105 shadow-md dark:shadow-lg dark:shadow-sophia-purple/20 transition-all duration-200"
          aria-label="Go to Dashboard"
        >
          <span className="group/icon relative flex items-center justify-center">
            <Home className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
            
            {/* Tooltip */}
            <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 px-3 py-2 text-xs rounded-lg opacity-0 group-hover/icon:opacity-100 transition-opacity duration-300 delay-200 pointer-events-none whitespace-nowrap z-50 bg-sophia-surface text-sophia-text shadow-lg border border-sophia-surface-border">
              <div className="text-center">
                Dashboard
              </div>
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-sophia-surface border-l border-t border-sophia-surface-border"></div>
            </div>
          </span>
        </button>
        
        {/* History button */}
        <button
          type="button"
          onClick={() => {
            haptic('light')
            setShowHistory(true)
          }}
          className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl border border-sophia-surface-border bg-sophia-button hover:border-sophia-purple/40 hover:scale-105 shadow-md dark:shadow-lg dark:shadow-sophia-purple/20 transition-all duration-200"
          aria-label={t("welcomeBack.historyTitle")}
        >
          <span className="group/icon relative flex items-center justify-center">
            <History className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
            
            {/* Tooltip */}
            <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 px-3 py-2 text-xs rounded-lg opacity-0 group-hover/icon:opacity-100 transition-opacity duration-300 delay-200 pointer-events-none whitespace-nowrap z-50 bg-sophia-surface text-sophia-text shadow-lg border border-sophia-surface-border">
              <div className="text-center">
                {t("header.tooltip.history")}
              </div>
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-sophia-surface border-l border-t border-sophia-surface-border"></div>
            </div>
          </span>
        </button>
        
        <ThemeToggle dataOnboardingId="header-theme-toggle" />
        
        {/* Settings button */}
        <button
          type="button"
          onClick={() => {
            haptic('light')
            router.push('/settings')
          }}
          data-onboarding="header-settings"
          className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl border border-sophia-surface-border bg-sophia-button hover:border-sophia-purple/40 hover:scale-105 shadow-md dark:shadow-lg dark:shadow-sophia-purple/20 transition-all duration-200"
          aria-label={t("settings.title")}
        >
          <span className="group/icon relative flex items-center justify-center">
            <Settings className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
            
            {/* Tooltip */}
            <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 px-3 py-2 text-xs rounded-lg opacity-0 group-hover/icon:opacity-100 transition-opacity duration-300 delay-200 pointer-events-none whitespace-nowrap z-50 bg-sophia-surface text-sophia-text shadow-lg border border-sophia-surface-border">
              <div className="text-center">
                {t("header.tooltip.settings")}
              </div>
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-sophia-surface border-l border-t border-sophia-surface-border"></div>
            </div>
          </span>
        </button>
      </div>
    </header>
      
    {/* History Drawer - outside header for proper z-index */}
    {showHistory && (
      <Suspense fallback={null}>
        <HistoryDrawer
          isOpen={showHistory}
          onClose={() => setShowHistory(false)}
          onConversationLoaded={() => setShowHistory(false)}
        />
      </Suspense>
    )}
    </Fragment>
  )
}
