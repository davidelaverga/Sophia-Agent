"use client"

import { useEffect, useState } from "react"
import { Shield, AlertTriangle } from "lucide-react"
import { useCopy, useTranslation } from "../copy"
import { getConsentStatus, postConsentAccept } from "../lib/api/privacy"
import { useFocusTrap } from "../hooks/useFocusTrap"

type GateState = "checking" | "needsConsent" | "error" | "ready"

const CONSENT_CACHE_KEY = "sophia_consent_accepted"

// Check localStorage for cached consent (avoids flash on reload)
const getCachedConsent = (): boolean => {
  if (typeof window === "undefined") return false
  try {
    return localStorage.getItem(CONSENT_CACHE_KEY) === "true"
  } catch {
    return false
  }
}

const setCachedConsent = (value: boolean) => {
  if (typeof window === "undefined") return
  try {
    if (value) {
      localStorage.setItem(CONSENT_CACHE_KEY, "true")
    } else {
      localStorage.removeItem(CONSENT_CACHE_KEY)
    }
  } catch {
    // localStorage not available
  }
}

export function ConsentGate({ onReady }: { onReady: () => void }) {
  const copy = useCopy()
  const { t } = useTranslation()

  const devBypass = process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "true"

  // Start as "ready" if we have cached consent or dev bypass (prevents flash)
  const [state, setState] = useState<GateState>(() => 
    devBypass || getCachedConsent() ? "ready" : "checking"
  )
  const [error, setError] = useState<string>()
  const [retryCount, setRetryCount] = useState(0)
  const { containerRef } = useFocusTrap()

  // If cached consent or dev bypass, call onReady immediately
  useEffect(() => {
    if (devBypass || getCachedConsent()) {
      onReady()
    }
  }, [devBypass, onReady])

  useEffect(() => {
    // Skip fetch if we already have cached consent or dev bypass
    if (devBypass || getCachedConsent()) {
      setState("ready")
      return
    }

    let aborted = false

    const fetchStatus = async () => {
      setState("checking")
      setError(undefined)
      try {
        const status = await getConsentStatus()
        if (aborted) return
        if (status.consent) {
          setCachedConsent(true)
          setState("ready")
          onReady()
        } else {
          setState("needsConsent")
        }
      } catch (err) {
        if (aborted) return
        setState("error")
        setError((err as Error).message || t("consentGate.errors.loadStatus"))
      }
    }

    fetchStatus()
    return () => {
      aborted = true
    }
  }, [retryCount, onReady, t])

  const handleAccept = async () => {
    setError(undefined)
    setState("checking")
    try {
      await postConsentAccept()
      setCachedConsent(true)
      setState("ready")
      onReady()
    } catch (err) {
      setState("needsConsent")
      setError((err as Error).message || t("consentGate.errors.saveConsent"))
    }
  }

  if (state === "ready") {
    return null
  }

  const showFallbackContinue = state === "error" || (state === "needsConsent" && Boolean(error))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-sophia-bg px-3">
      <div 
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        className="w-full max-w-full rounded-3xl bg-sophia-surface border-2 border-sophia-purple/20 p-5 text-sophia-text shadow-2xl sm:max-w-lg sm:p-6"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Shield className="h-8 w-8 text-sophia-purple" />
          <div>
            <p id="consent-title" className="text-lg font-semibold">{t("consentModal.title")}</p>
            <p className="text-sm text-sophia-text2">{t("consentModal.intro")}</p>
          </div>
        </div>

        <div className="mt-5 space-y-4 text-sm text-sophia-text2">
          <ConsentList title={t("consentModal.whatTitle")} items={copy.consentModal.whatItems} />
          <ConsentList title={t("consentModal.howTitle")} items={copy.consentModal.howItems} />
          <p className="rounded-2xl bg-sophia-user/70 px-3 py-2 text-xs">{t("consentModal.retention")}</p>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-sophia-error/30 bg-sophia-error/10 px-3 py-2 text-sm text-sophia-text">
            <AlertTriangle className="h-4 w-4 text-sophia-error" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            className="inline-flex flex-1 items-center justify-center rounded-2xl border border-sophia-surface-border px-4 py-3 text-sm font-medium text-sophia-text transition hover:border-sophia-purple/40"
            onClick={() => setRetryCount((count) => count + 1)}
            disabled={state === "checking"}
          >
            {state === "checking" ? t("consentGate.checking") : t("consentGate.retry")}
          </button>
          <button
            type="button"
            className="inline-flex flex-1 items-center justify-center rounded-2xl bg-sophia-purple px-4 py-3 text-sm font-semibold text-white transition hover:bg-sophia-glow disabled:opacity-60"
            onClick={handleAccept}
            disabled={state === "checking"}
          >
            {state === "checking" ? t("consentModal.buttons.saving") : t("consentModal.buttons.accept")}
          </button>
        </div>

        {showFallbackContinue && (
          <button
            type="button"
            className="mt-3 w-full text-center text-xs font-medium text-sophia-text2 underline underline-offset-2"
            onClick={onReady}
          >
            {t("consentGate.continueAnyway")}
          </button>
        )}
      </div>
    </div>
  )
}

function ConsentList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <p className="text-sm font-semibold text-sophia-text">{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-sophia-text2">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}



