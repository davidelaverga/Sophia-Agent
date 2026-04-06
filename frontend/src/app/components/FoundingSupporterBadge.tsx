"use client"

import { Heart } from "lucide-react"

import { useCopy } from "../copy"
import { useUsageLimitStore } from "../stores/usage-limit-store"

type FoundingSupporterBadgeProps = {
  /** Show compact version (just icon + short label) */
  compact?: boolean
  /** Additional className */
  className?: string
}

/**
 * Badge component to display Founding Supporter status
 * Only renders if user has FOUNDING_SUPPORTER plan tier
 */
export function FoundingSupporterBadge({ compact = false, className = "" }: FoundingSupporterBadgeProps) {
  const copy = useCopy()
  const planTier = useUsageLimitStore((state) => state.planTier)
  
  if (planTier !== "FOUNDING_SUPPORTER") {
    return null
  }

  if (compact) {
    return (
      <div 
        className={`inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-sophia-purple to-sophia-glow px-2 py-0.5 ${className}`}
        title={copy.foundingSupporter.badge.label}
      >
        <Heart className="h-3 w-3 text-white" fill="white" />
        <span className="text-xs font-semibold text-white">
          {copy.foundingSupporter.badge.shortLabel}
        </span>
      </div>
    )
  }

  return (
    <div className={`inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sophia-purple to-sophia-glow px-3 py-1 shadow-sm ${className}`}>
      <Heart className="h-4 w-4 text-white" fill="white" />
      <span className="text-sm font-semibold text-white">
        {copy.foundingSupporter.badge.label}
      </span>
    </div>
  )
}
