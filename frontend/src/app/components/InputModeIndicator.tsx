"use client"

import { MessageSquare, AlertCircle, RotateCcw } from "lucide-react"

import { useTranslation } from "../copy"
import { useUiStore as useFocusModeStore } from "../stores/ui-store"
import { useVoiceStore as useVoiceFallbackStore } from "../stores/voice-store"

export function InputModeIndicator() {
  const { t } = useTranslation()
  const focusMode = useFocusModeStore((state) => state.mode)
  const setMode = useFocusModeStore((state) => state.setMode)
  const setManualOverride = useFocusModeStore((state) => state.setManualOverride)
  const hasVoiceFailed = useVoiceFallbackStore((state) => state.hasVoiceFailed)
  const failureReason = useVoiceFallbackStore((state) => state.failureReason)
  const shouldAutoFallback = useVoiceFallbackStore((state) => state.shouldAutoFallback)
  const resetFailures = useVoiceFallbackStore((state) => state.resetFailures)

  const isVoiceMode = focusMode === "voice"

  const handleSwitchToText = () => {
    setMode("text")
    setManualOverride(true)
  }

  const handleRetryVoice = () => {
    resetFailures()
    setMode("voice")
    setManualOverride(true)
  }

  // Don't show anything if no failures
  if (!hasVoiceFailed && !shouldAutoFallback()) return null

  // Show fallback notification
  if (shouldAutoFallback() && isVoiceMode) {
    return (
      <div className="mb-3 rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">{t("inputModeIndicator.fallback.title")}</p>
            <p className="text-xs text-amber-700 mt-1 leading-relaxed">
              {failureReason || t("inputModeIndicator.fallback.defaultReason")}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleSwitchToText}
                className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 transition-colors"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                {t("inputModeIndicator.fallback.switchToText")}
              </button>
              <button
                type="button"
                onClick={handleRetryVoice}
                className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50 transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("inputModeIndicator.fallback.retryVoice")}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Show single failure warning (subtle)
  if (hasVoiceFailed && isVoiceMode) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg bg-sophia-purple/5 px-3 py-2 border border-sophia-purple/10">
        <AlertCircle className="h-4 w-4 text-sophia-purple shrink-0" />
        <p className="text-xs text-sophia-text2 flex-1">
          {t("inputModeIndicator.singleFailure.message")}{" "}
          <button
            type="button"
            onClick={handleSwitchToText}
            className="font-semibold text-sophia-purple hover:underline"
          >
            {t("inputModeIndicator.singleFailure.useTextInstead")}
          </button>
        </p>
      </div>
    )
  }

  return null
}
