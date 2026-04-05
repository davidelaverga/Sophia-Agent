"use client"

import { type ReactNode, useState } from "react"
import { Header } from "./Header"
import { AuthGate } from "./AuthGate"
import { ConsentGate } from "./ConsentGate"
import { GentleUsageToast } from "./GentleUsageToast"
import { useUsageLimitStore } from "../stores/usage-limit-store"
import { ErrorBoundary } from "./ErrorBoundary"
import { useTranslation } from "../copy"

// Import UsageLimitModal directly - it needs to be immediately available
// when limit is reached (lazy loading could delay the modal appearing)
import { UsageLimitModal } from "./UsageLimitModal"

type AppShellProps = {
  children: ReactNode
  actionBar?: ReactNode
}

export function AppShell({ children, actionBar }: AppShellProps) {
  const { t } = useTranslation()
  const [isAuthReady, setIsAuthReady] = useState(false)
  const [isConsentReady, setIsConsentReady] = useState(false)
  const limitModalOpen = useUsageLimitStore((state) => state.isOpen)
  const limitInfo = useUsageLimitStore((state) => state.limitInfo)
  const closeLimitModal = useUsageLimitStore((state) => state.closeModal)

  const showConsentGate = isAuthReady && !isConsentReady
  const isMainContentReady = isConsentReady

  return (
    <AuthGate onAuthenticated={() => setIsAuthReady(true)}>
    <div className="grid min-h-[100svh] grid-rows-[auto_1fr_auto] bg-sophia-bg text-sophia-text">
        {/* Skip to main content link for keyboard navigation */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-sophia-purple focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-sophia-purple focus:ring-offset-2"
        >
          {t("appShell.skipToMainContent")}
        </a>
        
        <div className="transition-opacity duration-300 opacity-100">
          <Header />
          <div className="h-px w-full bg-sophia-purple/10" />
        </div>
        
        <main id="main-content" className="safe-px overflow-y-auto flex flex-col justify-center transition-opacity duration-300 opacity-100" aria-hidden={!isMainContentReady}>
          <div className="mx-auto w-full max-w-2xl py-4 animate-fadeIn">
            {children}
            {/* Action bar (Composer) - inside main content for centered layout */}
            {actionBar && <div className="mt-4">{actionBar}</div>}
          </div>
        </main>
        <footer className="safe-px safe-b animate-fadeIn transition-opacity duration-300 opacity-100" aria-hidden={!isMainContentReady}>
          <div className="mx-auto w-full max-w-2xl py-3">
            {/* 💜 Subtle footer link - Always visible but very discrete */}
            <div className="flex items-center justify-center pt-2 pb-1">
              <a
                href="/founding-supporter"
                className="text-[10px] text-sophia-text2/50 hover:text-sophia-purple/60 transition-colors duration-200"
              >
                {t("appShell.foundingSupporterLink")}
              </a>
            </div>
          </div>
        </footer>

        {showConsentGate && <ConsentGate onReady={() => setIsConsentReady(true)} />}

        <ErrorBoundary componentName="UsageLimitModal">
          <UsageLimitModal open={limitModalOpen} onClose={closeLimitModal} info={limitInfo} />
        </ErrorBoundary>
        <GentleUsageToast />
      </div>
    </AuthGate>
  )
}
