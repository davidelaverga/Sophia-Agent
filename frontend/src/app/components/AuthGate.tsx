"use client"

import { Sparkles } from "lucide-react"
import { useEffect, useState, useRef } from "react"

import { authBypassEnabled } from "@/app/lib/auth/dev-bypass"
import { authClient } from "@/server/better-auth/client"

import { useCopy, useTranslation } from "../copy"
import { useAuth } from "../providers"

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

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true)
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
      })
      // User will be redirected to Google
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

        {/* Google Login Button */}
        <div className="animate-fadeIn">
          <button
            onClick={handleGoogleLogin}
            disabled={isLoggingIn}
            className="inline-flex w-full items-center justify-center gap-3 rounded-2xl border border-black/10 bg-white px-6 py-4 text-base font-semibold text-[#111827] shadow-lg shadow-black/10 transition-all duration-300 hover:bg-[#F8FAFC] hover:shadow-xl hover:shadow-black/15 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {isLoggingIn ? (
              <>
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-black/15 border-t-[#111827]" />
                <span>{t("auth.connecting")}</span>
              </>
            ) : (
              <>
                {/* Google Icon */}
                <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303C33.654 32.657 29.212 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917Z"/>
                  <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4c-7.682 0-14.338 4.337-17.694 10.691Z"/>
                  <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.193l-6.19-5.238C29.143 35.091 26.715 36 24 36c-5.191 0-9.625-3.329-11.287-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44Z"/>
                  <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.085 5.569l.003-.001 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917Z"/>
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
