"use client"

import { Mic, Keyboard } from "lucide-react"
import { useUiStore, type FocusMode } from "../stores/ui-store"
import { useModeSwitch } from "../hooks/useModeSwitch"

const MODES: { mode: FocusMode; icon: typeof Mic; label: string }[] = [
  { mode: "voice", icon: Mic, label: "Voice" },
  { mode: "text", icon: Keyboard, label: "Text" },
]

export function ModeToggle() {
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
      className="inline-flex items-center gap-1 rounded-full bg-sophia-surface/80 p-0.5 backdrop-blur-sm"
    >
      {MODES.map(({ mode, icon: Icon, label }) => {
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
              "flex items-center justify-center rounded-full p-2 transition-all duration-200",
              isActive
                ? "bg-sophia-purple/15 text-sophia-purple shadow-sm"
                : "text-sophia-text2 hover:text-sophia-text hover:bg-sophia-surface/80",
              isDisabled && "opacity-40 cursor-not-allowed",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <Icon className="h-4 w-4" />
            <span className="sr-only">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
