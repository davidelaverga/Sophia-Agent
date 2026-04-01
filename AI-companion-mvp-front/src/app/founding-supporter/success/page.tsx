"use client"

import { Loader2 } from "lucide-react"
import { useCopy, useTranslation } from "../../copy"

/**
 * BLOCKED PAGE - Backend Integration Pending
 * 
 * This page is temporarily blocked until the backend endpoint is ready
 * to handle Founding Supporter payment verification and user upgrade.
 * 
 * DO NOT ENABLE until backend confirms the following:
 * - Payment webhook is processing Stripe events
 * - User tier upgrade is working correctly
 * - Session validation is in place
 * 
 * Last updated: December 7, 2025
 */

export default function FoundingSupporterSuccessPage() {
  const copy = useCopy()
  const { t } = useTranslation()
  return (
    <main className="relative min-h-screen flex items-center justify-center bg-sophia-bg px-4">
      {/* Subtle background glow */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sophia-purple/10 blur-3xl" />
      
      <div className="relative z-10 text-center space-y-6 max-w-md">
        {/* Sophia avatar breathing */}
        <div className="flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-sophia-purple text-2xl font-semibold text-white shadow-lg animate-breatheSlow">
            {copy.brand.initial}
          </div>
        </div>

        {/* Loading spinner */}
        <div className="flex justify-center">
          <Loader2 className="h-10 w-10 text-sophia-purple animate-spin" />
        </div>

        {/* Status message */}
        <div className="space-y-3">
          <h1 className="text-2xl font-semibold text-sophia-text">
            {t("foundingSupporterSuccess.verifyingTitle")}
          </h1>
          <p className="text-sophia-text2 leading-relaxed">
            {t("foundingSupporterSuccess.verifyingBody")}
          </p>
        </div>

        {/* Technical note for developers (hidden in production) */}
        {process.env.NODE_ENV === 'development' && (
          <div className="mt-8 rounded-xl bg-amber-500/10 border border-amber-500/20 p-4 text-left">
            <p className="text-xs text-amber-600 dark:text-amber-400 font-mono">
              {t("foundingSupporterSuccess.devNote")}
            </p>
          </div>
        )}
      </div>
    </main>
  )
}

/* 
 * ORIGINAL SUCCESS PAGE CODE - PRESERVED FOR BACKEND INTEGRATION
 * 
 * Uncomment and restore when backend is ready:
 * 
 * import { useEffect, useState } from "react"
 * import { useRouter } from "next/navigation"
 * import { Check, Heart, MessageCircle, Mic, Sparkles, Star } from "lucide-react"
 * import { copy } from "../../copy"
 * import { useUsageLimitStore } from "../../stores/usage-limit-store"
 * 
 * const CONFETTI_COLORS = ['#9333ea', '#c084fc', '#fbbf24', '#f472b6', '#34d399']
 * 
 * function generateConfetti() {
 *   return Array.from({ length: 50 }, (_, i) => ({
 *     id: i,
 *     delay: Math.random() * 2,
 *     left: Math.random() * 100,
 *     color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
 *     isCircle: Math.random() > 0.5,
 *     size: 8 + Math.random() * 8,
 *   }))
 * }
 * 
 * [... rest of original implementation ...]
 */
