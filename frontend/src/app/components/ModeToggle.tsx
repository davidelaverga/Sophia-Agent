"use client"

import { Fragment, useId } from "react"

import { haptic } from "../hooks/useHaptics"
import { useModeSwitch } from "../hooks/useModeSwitch"
import { useUiStore, type FocusMode } from "../stores/ui-store"

const MODES: { mode: FocusMode; label: string }[] = [
  { mode: "voice", label: "voice" },
  { mode: "text", label: "text" },
]

export function ModeToggle({
  opacity = 1,
  isBusy = false,
  showInsightIndicator = false,
  hasNewInsight = false,
}: {
  opacity?: number
  isBusy?: boolean
  showInsightIndicator?: boolean
  hasNewInsight?: boolean
}) {
  const currentMode = useUiStore((s) => s.mode)
  const setMode = useUiStore((s) => s.setMode)
  const setManualOverride = useUiStore((s) => s.setManualOverride)
  const { canSwitchToVoice, canSwitchToChat } = useModeSwitch()
  const insightStatusId = useId()

  const insightState = hasNewInsight
    ? "active"
    : showInsightIndicator
      ? "inactive"
      : "hidden"

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
      aria-describedby={hasNewInsight ? insightStatusId : undefined}
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
      {MODES.map(({ mode, label }, index) => {
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

            {index === 0 && (
              <span
                aria-hidden="true"
                className="inline-flex h-6 w-4 shrink-0 items-center justify-center"
              >
                <span
                  data-testid="mode-toggle-insight-indicator"
                  data-state={insightState}
                  className="mode-toggle-insight-indicator"
                />
              </span>
            )}
          </Fragment>
        )
      })}

      {hasNewInsight ? (
        <span id={insightStatusId} className="sr-only">
          New insight available
        </span>
      ) : null}

      <style>{`
        .mode-toggle-insight-indicator {
          width: 0.45rem;
          height: 0.45rem;
          border-radius: 9999px;
          background: color-mix(in srgb, var(--sophia-purple) 42%, var(--cosmic-text-muted));
          opacity: 0;
          transform: scale(0.72);
          box-shadow: none;
          transition:
            opacity 220ms ease,
            transform 320ms ease,
            background 320ms ease,
            box-shadow 320ms ease;
        }

        .mode-toggle-insight-indicator[data-state="inactive"] {
          opacity: 0.42;
          transform: scale(0.92);
          background: color-mix(in srgb, var(--sophia-purple) 28%, var(--cosmic-text-muted));
        }

        .mode-toggle-insight-indicator[data-state="active"] {
          opacity: 1;
          transform: scale(1);
          background: color-mix(in srgb, var(--sophia-glow) 78%, white 10%);
          box-shadow:
            0 0 0 1px color-mix(in srgb, var(--sophia-purple) 16%, transparent),
            0 0 14px color-mix(in srgb, var(--sophia-purple) 42%, transparent),
            0 0 24px color-mix(in srgb, var(--sophia-glow) 18%, transparent);
          animation: mode-toggle-insight-pulse 2.1s ease-in-out infinite;
        }

        @keyframes mode-toggle-insight-pulse {
          0%,
          100% {
            opacity: 0.84;
            transform: scale(0.96);
            box-shadow:
              0 0 0 1px color-mix(in srgb, var(--sophia-purple) 12%, transparent),
              0 0 12px color-mix(in srgb, var(--sophia-purple) 28%, transparent),
              0 0 22px color-mix(in srgb, var(--sophia-glow) 12%, transparent);
          }

          50% {
            opacity: 1;
            transform: scale(1.18);
            box-shadow:
              0 0 0 1px color-mix(in srgb, var(--sophia-purple) 22%, transparent),
              0 0 18px color-mix(in srgb, var(--sophia-purple) 42%, transparent),
              0 0 30px color-mix(in srgb, var(--sophia-glow) 18%, transparent);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .mode-toggle-insight-indicator[data-state="active"] {
            animation: none;
            transform: scale(1.04);
          }
        }
      `}</style>
    </div>
  )
}
