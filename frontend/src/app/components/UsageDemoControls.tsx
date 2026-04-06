"use client"

import { Settings, X } from "lucide-react"
import { useState } from "react"

import { useTranslation } from "../copy"
import { useUsageLimitStore } from "../stores/usage-limit-store"

/**
 * Demo controls for testing usage alerts
 * Only visible in development or when ?demo=true is in URL
 */
export function UsageDemoControls() {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const showHint = useUsageLimitStore((state) => state.showHint)
  const showToast = useUsageLimitStore((state) => state.showToast)
  const showModal = useUsageLimitStore((state) => state.showModal)
  const dismissHint = useUsageLimitStore((state) => state.dismissHint)
  const dismissToast = useUsageLimitStore((state) => state.dismissToast)

  // Only show in development or with ?demo=true
  const isDemoMode = 
    process.env.NODE_ENV === "development" || 
    (typeof window !== "undefined" && window.location.search.includes("demo=true"))

  if (!isDemoMode) return null

  const demoUsageInfo = {
    voice: {
      reason: "voice" as const,
      plan_tier: "FREE" as const,
      limit: 600, // 10 minutes
      used: 0,
    },
    text: {
      reason: "text" as const,
      plan_tier: "FREE" as const,
      limit: 1800, // 30 minutes
      used: 0,
    },
    reflections: {
      reason: "reflections" as const,
      plan_tier: "FREE" as const,
      limit: 4,
      used: 0,
    },
  }

  const triggerHint = (type: "voice" | "text" | "reflections", percent: number) => {
    const info = { ...demoUsageInfo[type] }
    info.used = Math.floor(info.limit * (percent / 100))
    showHint(info)
  }

  const triggerToast = (type: "voice" | "text" | "reflections", percent: number) => {
    const info = { ...demoUsageInfo[type] }
    info.used = Math.floor(info.limit * (percent / 100))
    showToast(info)
  }

  const triggerModal = (type: "voice" | "text" | "reflections") => {
    const info = { ...demoUsageInfo[type] }
    info.used = info.limit
    // Force=true bypasses the "recently dismissed" check for demo purposes
    showModal(info, true)
  }

  const clearAll = () => {
    dismissHint()
    dismissToast()
  }

  return (
    <>
      {/* Floating button to open controls */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-4 right-4 z-[100] flex h-12 w-12 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition hover:bg-red-600"
        title={t("usageDemoControls.fabTitle")}
      >
        {isOpen ? <X className="h-5 w-5" /> : <Settings className="h-5 w-5" />}
      </button>

      {/* Controls panel */}
      {isOpen && (
        <div className="fixed bottom-20 right-4 z-[100] w-80 rounded-2xl border border-sophia-card-border bg-sophia-surface p-4 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900">{t("usageDemoControls.panelTitle")}</h3>
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-red-500 hover:underline"
            >
              {t("usageDemoControls.clearAll")}
            </button>
          </div>

          {/* Voice Controls */}
          <div className="mb-4 space-y-2 rounded-lg border border-purple-200 bg-purple-50 p-3">
            <p className="text-xs font-semibold text-purple-900">{t("usageDemoControls.sections.voice")}</p>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => triggerHint("voice", 60)}
                className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-900 hover:bg-yellow-200"
              >
                {t("usageDemoControls.buttons.hint", { percent: 60 })}
              </button>
              <button
                type="button"
                onClick={() => triggerToast("voice", 85)}
                className="rounded bg-orange-100 px-2 py-1 text-xs text-orange-900 hover:bg-orange-200"
              >
                {t("usageDemoControls.buttons.toast", { percent: 85 })}
              </button>
              <button
                type="button"
                onClick={() => triggerModal("voice")}
                className="rounded bg-red-100 px-2 py-1 text-xs text-red-900 hover:bg-red-200"
              >
                {t("usageDemoControls.buttons.modal", { percent: 100 })}
              </button>
            </div>
          </div>

          {/* Text Controls */}
          <div className="mb-4 space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
            <p className="text-xs font-semibold text-blue-900">{t("usageDemoControls.sections.text")}</p>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => triggerHint("text", 65)}
                className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-900 hover:bg-yellow-200"
              >
                {t("usageDemoControls.buttons.hint", { percent: 65 })}
              </button>
              <button
                type="button"
                onClick={() => triggerToast("text", 90)}
                className="rounded bg-orange-100 px-2 py-1 text-xs text-orange-900 hover:bg-orange-200"
              >
                {t("usageDemoControls.buttons.toast", { percent: 90 })}
              </button>
              <button
                type="button"
                onClick={() => triggerModal("text")}
                className="rounded bg-red-100 px-2 py-1 text-xs text-red-900 hover:bg-red-200"
              >
                {t("usageDemoControls.buttons.modal", { percent: 100 })}
              </button>
            </div>
          </div>

          {/* Reflections Controls */}
          <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 p-3">
            <p className="text-xs font-semibold text-green-900">{t("usageDemoControls.sections.reflections")}</p>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => triggerHint("reflections", 75)}
                className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-900 hover:bg-yellow-200"
              >
                {t("usageDemoControls.buttons.hint", { percent: 75 })}
              </button>
              <button
                type="button"
                onClick={() => triggerToast("reflections", 80)}
                className="rounded bg-orange-100 px-2 py-1 text-xs text-orange-900 hover:bg-orange-200"
              >
                {t("usageDemoControls.buttons.toast", { percent: 80 })}
              </button>
              <button
                type="button"
                onClick={() => triggerModal("reflections")}
                className="rounded bg-red-100 px-2 py-1 text-xs text-red-900 hover:bg-red-200"
              >
                {t("usageDemoControls.buttons.modal", { percent: 100 })}
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-gray-100 p-2 text-xs text-gray-600">
            <p className="font-semibold">{t("usageDemoControls.legend.title")}</p>
            <p>{t("usageDemoControls.legend.hint")}</p>
            <p>{t("usageDemoControls.legend.toast")}</p>
            <p>{t("usageDemoControls.legend.modal")}</p>
          </div>
        </div>
      )}
    </>
  )
}

