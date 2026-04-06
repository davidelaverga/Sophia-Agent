"use client"

import { useEffect, useState, useRef } from "react"
import { Sparkles } from "lucide-react"
import { useAuth } from "../providers"
import { authClient } from "@/server/better-auth/client"
import { authBypassEnabled } from "@/app/lib/auth/dev-bypass"
import { useCopy, useTranslation } from "../copy"

type AuthState = "checking" | "unauthenticated" | "authenticated"

// Maximum time to wait for auth check before assuming unauthenticated
const AUTH_TIMEOUT_MS = 5000

export function AuthGate({ 
  children, 
  onAuthenticated 
}: { 
  children: React.ReactNode
  onAuthenticated?: () => void 
}) {
  const copy = useCopy()
  const { t } = useTranslation()

  const { user, loading } = useAuth()
  const [authState, setAuthState] = useState<AuthState>(
    authBypassEnabled ? "authenticated" : "checking"
  )
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasResolvedRef = useRef(authBypassEnabled)

  // Fire onAuthenticated immediately in dev bypass mode
  useEffect(() => {
    if (authBypassEnabled) onAuthenticated?.()
  }, [onAuthenticated])

  // Single effect to handle all auth state transitions
  useEffect(() => {
    if (authBypassEnabled) return
    // Already resolved - do nothing
    if (hasResolvedRef.current) return

    // Loading finished - resolve immediately
    if (!loading) {
      hasResolvedRef.current = true
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      
      if (user) {
        setAuthState("authenticated")
        onAuthenticated?.()
      } else {
        setAuthState("unauthenticated")
      }
      return
    }

    // Still loading - set timeout if not already set
    if (!timeoutRef.current) {
      timeoutRef.current = setTimeout(() => {
        if (!hasResolvedRef.current) {
          hasResolvedRef.current = true
          setAuthState("unauthenticated")
        }
      }, AUTH_TIMEOUT_MS)
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [user, loading, onAuthenticated])

  const handleDiscordLogin = async () => {
    setIsLoggingIn(true)
    try {
      await authClient.signIn.social({
        provider: "discord",
        callbackURL: "/",
      })
      // User will be redirected to Discord
    } catch {
      setIsLoggingIn(false)
    }
  }

  // Still checking auth state
  if (authState === "checking") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-sophia-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-sophia-purple/30 border-t-sophia-purple" />
          <p className="text-sm text-sophia-text2">{t("auth.loading")}</p>
        </div>
      </div>
    )
  }

  // User is authenticated, show children
  if (authState === "authenticated") {
    return <>{children}</>
  }

  // User needs to login
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-sophia-bg px-4">
      <div className="w-full max-w-md text-center">
        {/* Logo */}
        <div className="mb-8 animate-fadeIn">
          <div className="mx-auto inline-flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-sophia-purple to-sophia-glow shadow-lg shadow-sophia-purple/30">
            <Sparkles className="h-10 w-10 text-white" />
          </div>
        </div>

        {/* Welcome text */}
        <div className="mb-8 animate-fadeIn">
          <h1 className="text-3xl font-semibold text-sophia-text mb-3">
            {copy.brand.name}
          </h1>
          <p className="text-sophia-text2">
            {t("header.subtitle")}
          </p>
        </div>

        {/* Discord Login Button */}
        <div className="animate-fadeIn">
          <button
            onClick={handleDiscordLogin}
            disabled={isLoggingIn}
            className="inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-[#5865F2] px-6 py-4 text-base font-semibold text-white shadow-lg shadow-[#5865F2]/30 transition-all duration-300 hover:bg-[#4752C4] hover:shadow-xl hover:shadow-[#5865F2]/40 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {isLoggingIn ? (
              <>
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                <span>{t("auth.connecting")}</span>
              </>
            ) : (
              <>
                {/* Discord Icon */}
                <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                </svg>
                <span>{t("auth.button")}</span>
              </>
            )}
          </button>
        </div>

        {/* Footer note */}
        <p className="mt-6 text-xs text-sophia-text2/60">
          {t("auth.footerNote")}
        </p>
      </div>
    </div>
  )
}
