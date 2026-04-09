"use client"

import { Sparkles } from "lucide-react"
import { useEffect, useState, useRef, useMemo } from "react"

import { authBypassEnabled } from "@/app/lib/auth/dev-bypass"
import { authClient } from "@/server/better-auth/client"

import { useCopy, useTranslation } from "../copy"
import { useAuth } from "../providers"

type AuthState = "checking" | "unauthenticated" | "authenticated"

// Maximum time to wait for auth check before assuming unauthenticated
const AUTH_TIMEOUT_MS = 5000

/* ── Ambient particles (deterministic seeds, no layout shift) ── */
function useAmbientParticles(count: number) {
  return useMemo(() => {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      x: ((i * 37 + 13) % 100),
      y: ((i * 53 + 7) % 100),
      size: 1.5 + (i % 3) * 0.8,
      delay: (i * 0.4) % 6,
      duration: 4 + (i % 3) * 2,
    }))
  }, [count])
}

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
  const particles = useAmbientParticles(24)

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-sophia-bg px-4 overflow-hidden">

      {/* ── Ambient particle field ── */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {particles.map((p) => (
          <span
            key={p.id}
            className="absolute rounded-full bg-sophia-purple/20 animate-cosmicTwinkle"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: `${p.size}px`,
              height: `${p.size}px`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
            }}
          />
        ))}
      </div>

      {/* ── Radial vignette ── */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background: "radial-gradient(ellipse 70% 60% at 50% 45%, transparent 0%, var(--bg) 100%)",
        }}
      />

      {/* ── Main card ── */}
      <div
        className="relative z-10 w-full max-w-sm text-center"
        style={{ animationDelay: "100ms" }}
      >
        {/* Logo with breathing rings */}
        <div className="mb-10 animate-fadeIn flex items-center justify-center">
          <div className="relative flex items-center justify-center">
            {/* Outer breathing ring */}
            <span
              className="absolute rounded-full border border-sophia-purple/15 animate-breatheSlow"
              style={{ width: "140px", height: "140px" }}
            />
            {/* Middle breathing ring */}
            <span
              className="absolute rounded-full border border-sophia-purple/25 animate-breathe"
              style={{ width: "112px", height: "112px" }}
            />
            {/* Icon container */}
            <div className="relative inline-flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-sophia-purple/90 to-sophia-glow/80 shadow-[0_0_40px_rgba(var(--sophia-purple-rgb),0.35)]">
              <Sparkles className="h-10 w-10 text-white animate-glowBreathe" />
            </div>
          </div>
        </div>

        {/* Welcome text */}
        <div className="mb-10 animate-fadeIn" style={{ animationDelay: "200ms" }}>
          <h1
            className="mb-3 text-sophia-text"
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontWeight: 300,
              fontSize: "clamp(28px, 4vw, 36px)",
              letterSpacing: "-0.01em",
            }}
          >
            {copy.brand.name}
          </h1>
          <p className="text-sm tracking-wide" style={{ color: "var(--cosmic-text-muted)" }}>
            {t("header.subtitle")}
          </p>
        </div>

        {/* Glass login card */}
        <div
          className="animate-fadeIn rounded-2xl p-6"
          style={{
            animationDelay: "400ms",
            background: "var(--cosmic-panel-strong)",
            border: "1px solid var(--cosmic-border-soft)",
            boxShadow: "var(--cosmic-shadow-lg)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
          }}
        >
          <button
            onClick={handleGoogleLogin}
            disabled={isLoggingIn}
            className="inline-flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/95 px-6 py-3.5 text-sm font-medium text-[#1f1f1f] transition-all duration-300 hover:bg-white hover:shadow-[0_8px_30px_rgba(var(--sophia-purple-rgb),0.15)] hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-sophia-purple disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {isLoggingIn ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-sophia-purple/30 border-t-sophia-purple" />
                <span>{t("auth.connecting")}</span>
              </>
            ) : (
              <>
                {/* Google Icon */}
                <svg className="h-[18px] w-[18px]" viewBox="0 0 48 48" aria-hidden="true">
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
        <p
          className="mt-8 animate-fadeIn text-xs"
          style={{ animationDelay: "600ms", color: "var(--cosmic-text-whisper)" }}
        >
          {t("auth.footerNote")}
        </p>
      </div>
    </div>
  )
}
