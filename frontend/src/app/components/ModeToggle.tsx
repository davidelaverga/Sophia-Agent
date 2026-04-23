"use client"

import { Fragment } from "react"

import { haptic } from "../hooks/useHaptics"
import { useModeSwitch } from "../hooks/useModeSwitch"
import { useUiStore, type FocusMode } from "../stores/ui-store"

const MODES: { mode: FocusMode; label: string }[] = [
  { mode: "voice", label: "voice" },
  { mode: "text", label: "text" },
]

export type ModeToggleInsight = {
  hasArtifacts: boolean
  isNew?: boolean
  onClick: () => void
}

export function ModeToggle({
  opacity = 1,
  isBusy = false,
  insight,
}: {
  opacity?: number
  isBusy?: boolean
  /** Optional third segment fused into the same capsule for accessing insights. */
  insight?: ModeToggleInsight
}) {
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
        borderColor: insight?.isNew
          ? 'color-mix(in srgb, var(--sophia-purple) 22%, var(--cosmic-border-soft))'
          : 'var(--cosmic-border-soft)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        opacity,
        transition: 'opacity 0.6s ease, border-color 0.6s ease',
      }}
    >
      {MODES.map(({ mode, label }, idx) => {
        const isActive = mode === currentMode
        const isDisabled = !isActive && (isBusy
          || (mode === "voice" && !canSwitchToVoice.canSwitch)
          || (mode === "text" && !canSwitchToChat.canSwitch))

        const disabledMessage = mode === "voice"
          ? canSwitchToVoice.message ?? "Cannot switch to voice"
          : canSwitchToChat.message ?? "Cannot switch to text"

        return (
          <Fragment key={mode}>
            <button
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
            {/* Insight dot lives between voice and text — a quiet third citizen sharing the same shell. */}
            {insight?.hasArtifacts && idx === 0 && (
              <button
                type="button"
                onClick={() => { haptic('light'); insight.onClick() }}
                aria-label={insight.isNew ? 'New insights available' : 'Show insights'}
                title={insight.isNew ? 'new insight' : 'insights'}
                className={[
                  'group relative inline-flex items-center justify-center rounded-full px-2 py-0.5 cursor-pointer',
                  'text-[11px] leading-[1.2]',
                  'transition-all duration-300',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20',
                ].join(' ')}
              >
                {/* Zero-width spacer matches the voice/text line-box so the dot centers vertically. */}
                <span aria-hidden className="invisible">a</span>
                <span
                  aria-hidden
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 block rounded-full transition-all duration-300"
                  style={{
                    width: insight.isNew ? '7px' : '5px',
                    height: insight.isNew ? '7px' : '5px',
                    background: insight.isNew
                      ? 'color-mix(in srgb, var(--sophia-purple) 70%, white 20%)'
                      : 'color-mix(in srgb, var(--sophia-purple) 40%, var(--cosmic-text-faint))',
                    boxShadow: insight.isNew
                      ? '0 0 6px color-mix(in srgb, var(--sophia-purple) 60%, transparent)'
                      : 'none',
                  }}
                />
              </button>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
