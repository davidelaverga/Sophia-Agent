"use client"

import { haptic } from "../hooks/useHaptics"
import { useModeSwitch } from "../hooks/useModeSwitch"
import { useUiStore, type FocusMode } from "../stores/ui-store"

const MODES: { mode: FocusMode; label: string }[] = [
  { mode: "voice", label: "voice" },
  { mode: "text", label: "text" },
]

export function ModeToggle({ opacity = 1, isBusy = false }: { opacity?: number; isBusy?: boolean }) {
  const currentMode = useUiStore((s) => s.mode)
  const setMode = useUiStore((s) => s.setMode)
  const setManualOverride = useUiStore((s) => s.setManualOverride)
  const { canSwitchToVoice, canSwitchToChat } = useModeSwitch()

  function handleSelect(mode: FocusMode) {
    if (mode === currentMode) return
    if (isBusy) {
      // Tactile ack that the tap was noticed even though the switch is blocked.
      haptic('error')
      return
    }
    if (mode === "voice" && !canSwitchToVoice.canSwitch) {
      haptic('error')
      return
    }
    if (mode === "text" && !canSwitchToChat.canSwitch) {
      haptic('error')
      return
    }
    haptic('selection')
    setMode(mode)
    setManualOverride(true)
  }

  return (
    <div
      role="tablist"
      aria-label="Interaction mode"
      className="inline-flex items-center gap-1 px-2 py-1.5 rounded-full border"
      style={{
        background: 'var(--cosmic-panel-soft)',
        borderColor: 'var(--cosmic-border-soft)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        opacity,
        transition: "opacity 0.6s ease",
      }}
    >
      {MODES.map(({ mode, label }) => {
        const isActive = mode === currentMode
        const isDisabled = !isActive && (isBusy
          || (mode === "voice" && !canSwitchToVoice.canSwitch)
          || (mode === "text" && !canSwitchToChat.canSwitch))

        const disabledMessage = mode === "voice"
          ? canSwitchToVoice.message ?? "Cannot switch to voice"
          : canSwitchToChat.message ?? "Cannot switch to text"

        return (
          <button
            key={mode}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-disabled={isDisabled}
            disabled={isDisabled}
            onClick={() => handleSelect(mode)}
            title={isDisabled ? (isBusy ? "Sophia is responding…" : disabledMessage) : label}
            className={[
              "text-[11px] tracking-[0.14em] lowercase transition-all duration-300 px-3 py-0.5 rounded-full",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20",
              isActive
                ? "bg-white/[0.1]"
                : "cursor-pointer",
              isDisabled && "opacity-40 cursor-not-allowed",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              color: isActive
                ? 'var(--cosmic-text)'
                : isDisabled
                  ? 'var(--cosmic-text-faint)'
                  : 'var(--cosmic-text-muted)',
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
