"use client"

import { useRouter } from "next/navigation"
import { useUsageLimitStore } from "../stores/usage-limit-store"
import { useTranslation } from "../copy"
import { Sparkles } from "lucide-react"

/**
 * Subtle, non-intrusive usage hint that appears in the footer
 * Only shows when user is approaching their limit (50-79%)
 * Designed to be calm, informative, and never threatening
 */
export function UsageHint() {
  const { t } = useTranslation()

  const router = useRouter()
  const hintInfo = useUsageLimitStore((state) => state.hintInfo)

  if (!hintInfo) return null

  const getHintText = () => {
    const remaining = hintInfo.limit - hintInfo.used
    
    switch (hintInfo.reason) {
      case "voice":
        return t("usageLimit.hintVoice", { remaining: Math.round(remaining / 60) })
      case "text":
        return t("usageLimit.hintText", { remaining })
      case "reflections":
        return t("usageLimit.hintReflections", { remaining })
      default:
        return null
    }
  }

  const hintText = getHintText()
  if (!hintText) return null

  return (
    <div className="flex items-start gap-2 rounded-2xl bg-sophia-purple/5 px-4 py-3 text-xs text-sophia-text2 animate-fadeIn">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-sophia-purple/60" />
      <div className="flex-1">
        <p className="leading-relaxed">{hintText}</p>
        {/* 💜 Subtle link to Founding Supporter - Contextual, non-intrusive */}
        <button
          type="button"
          onClick={() => router.push("/founding-supporter")}
          className="mt-1.5 text-xs font-semibold text-sophia-purple hover:text-sophia-glow transition-colors duration-200"
        >
          {t("usageHint.learnUnlimitedCta")}
        </button>
      </div>
    </div>
  )
}
