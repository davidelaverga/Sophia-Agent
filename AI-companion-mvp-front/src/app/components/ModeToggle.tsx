"use client"

import { useUiStore, type FocusMode } from "../stores/ui-store"
import { useModeSwitch } from "../hooks/useModeSwitch"

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
      className="inline-flex items-center gap-3"
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
              "text-[10px] tracking-[0.18em] lowercase transition-colors duration-300",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20 rounded",
              isActive
                ? "text-white/20"
                : "text-white/10 hover:text-white/25 cursor-pointer",
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
