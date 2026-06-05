"use client"

import { CheckCircle2, CircleSlash } from "lucide-react"

import { cn } from "../../lib/utils"

interface ExactTextBadgeProps {
  available: boolean
  className?: string
}

export function ExactTextBadge({ available, className }: ExactTextBadgeProps) {
  const Icon = available ? CheckCircle2 : CircleSlash

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        available
          ? "border-[color:var(--cosmic-teal-border)] bg-[color:var(--cosmic-teal-bg)] text-[color:var(--cosmic-text-strong)]"
          : "border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)]",
        className,
      )}
      title={
        available
          ? "Sophia can use trusted text for precise words and numbers."
          : "Trusted text is not available for this artifact."
      }
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{available ? "Exact text available" : "Exact text unavailable"}</span>
    </span>
  )
}
