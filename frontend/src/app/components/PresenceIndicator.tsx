"use client"

import { useEffect, useRef } from "react"

import { useTranslation } from "../copy"
import { getPresenceCopyKey, usePresenceStore } from "../stores/presence-store"

const stageAccent: Record<string, string> = {
  listening: "bg-sophia-glow",
  thinking: "bg-sophia-text2/70",
  reflecting: "bg-sophia-purple/80",
  speaking: "bg-sophia-purple",
  resting: "bg-sophia-text2/30",
}

export function PresenceIndicator() {
  const { t } = useTranslation()

  const stage = usePresenceStore((state) => state.status)
  const detail = usePresenceStore((state) => state.detail)
  const srRef = useRef<HTMLSpanElement | null>(null)
  const label = detail ?? t(getPresenceCopyKey(stage))

  useEffect(() => {
    if (srRef.current) {
      srRef.current.textContent = `Sophia is ${label}`
    }
  }, [label])

  return (
    <div className="flex items-center gap-2 text-sm text-sophia-text2 transition-all duration-500 ease-out" aria-live="polite">
      <span
        className={`h-2.5 w-2.5 rounded-full ${stageAccent[stage] ?? stageAccent.resting} motion-safe:animate-breathe shadow-sm transition-all duration-500`}
      />
      <span className="transition-all duration-300">{label}</span>
      <span ref={srRef} className="sr-only" />
    </div>
  )
}

