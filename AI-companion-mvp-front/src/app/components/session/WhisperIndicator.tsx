"use client"

import { usePresenceStore, type PresenceState } from "../../stores/presence-store"

const WHISPER_LABELS: Partial<Record<PresenceState, string>> = {
  speaking: "speaking",
  listening: "listening",
  reflecting: "reflecting",
}

/**
 * WhisperIndicator — atmospheric presence status label.
 *
 * Fixed bottom-center, 10px tracking-wide lowercase.
 * Shows "speaking", "listening", "reflecting". Empty for thinking/resting.
 * Fades with chrome via external opacity prop.
 */
export function WhisperIndicator({ opacity = 1 }: { opacity?: number }) {
  const status = usePresenceStore((s) => s.status)
  const label = WHISPER_LABELS[status] ?? ""

  if (!label) return null

  return (
    <div
      className="fixed bottom-[18px] left-1/2 -translate-x-1/2 z-25 pointer-events-none"
      style={{ opacity, transition: "opacity 0.6s ease" }}
    >
      <span className="text-[10px] tracking-[0.18em] lowercase text-white/10 transition-colors duration-1000">
        {label}
      </span>
    </div>
  )
}
