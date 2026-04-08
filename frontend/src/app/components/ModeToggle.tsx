"use client"

import { useModeSwitch } from "../hooks/useModeSwitch"
import { useUiStore, type FocusMode } from "../stores/ui-store"

const MODES: { mode: FocusMode; label: string }[] = [
  { mode: "voice", label: "voice" },
  { mode: "text", label: "text" },
]

export function ModeToggle({ opacity = 1 }: { opacity?: number }) {
  const currentMode = useUiStore((s) => s.mode)
  const setMode = useUiStore((s) => s.setMode)
  const setManualOverride = useUiStore((s) => s.setManualOverride)
  const { canSwitchToVoice } = useModeSwitch()

  function handleSelect(mode: FocusMode) {
    if (mode === currentMode) return
    if (mode === "voice" && !canSwitchToVoice.canSwitch) return
    setMode(mode)
    setManualOverride(true)
  }

  return (
    <div
      role="tablist"
      aria-label="Interaction mode"
      className="inline-flex items-center gap-1 px-2 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.04]"
      style={{ opacity, transition: "opacity 0.6s ease" }}
    >
      {MODES.map(({ mode, label }) => {
        const isActive = mode === currentMode
        const isDisabled = mode === "voice" && !canSwitchToVoice.canSwitch

        return (
          <button
            key={mode}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-disabled={isDisabled}
            disabled={isDisabled}
            onClick={() => handleSelect(mode)}
            title={isDisabled ? canSwitchToVoice.message ?? "Cannot switch to voice" : label}
            className={[
              "text-[11px] tracking-[0.14em] lowercase transition-all duration-300 px-3 py-0.5 rounded-full",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20",
              isActive
                ? "text-white/50 bg-white/[0.06]"
                : "text-white/25 hover:text-white/40 cursor-pointer",
              isDisabled && "opacity-40 cursor-not-allowed",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
