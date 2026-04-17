/**
 * VisualQualityPicker — settings card for visual quality tier selection.
 *
 * Options: Auto (default), Full, Balanced, Battery saver.
 */

'use client'

import { Monitor, Zap, Battery, Gauge } from 'lucide-react'
import { useCallback } from 'react'

import { haptic } from '../../hooks/useHaptics'
import { useVisualTier, type VisualTierPreference } from '../../hooks/useVisualTier'
import { cn } from '../../lib/utils'

const OPTIONS: { id: VisualTierPreference; label: string; desc: string; icon: typeof Monitor }[] = [
  { id: 'auto',     label: 'Auto',          desc: 'Adapts to your device automatically',  icon: Gauge },
  { id: 'full',     label: 'Full',          desc: 'All effects, maximum visual fidelity',  icon: Monitor },
  { id: 'balanced', label: 'Balanced',      desc: 'Reduced blur and animations',           icon: Zap },
  { id: 'low',      label: 'Battery saver', desc: 'Minimal effects for weak devices',      icon: Battery },
]

export function VisualQualityPicker() {
  const { preference, tier, autoDegraded, setPreference } = useVisualTier()

  const handleSelect = useCallback((id: VisualTierPreference) => {
    haptic('light')
    setPreference(id)
  }, [setPreference])

  return (
    <section className="cosmic-surface-panel-strong rounded-[1.8rem] p-5 sm:p-6">
      <p
        className="text-[11px] uppercase tracking-[0.16em]"
        style={{ color: 'var(--cosmic-text-whisper)' }}
      >
        Visual quality
      </p>
      <h3
        className="mt-1 font-cormorant text-[1.65rem] font-light"
        style={{ color: 'var(--cosmic-text-strong)' }}
      >
        Rendering fidelity
      </h3>
      <p
        className="mt-2 text-sm leading-6"
        style={{ color: 'var(--cosmic-text-muted)' }}
      >
        Controls how much GPU power Sophia uses for visual effects.
        {autoDegraded && (
          <span className="ml-1 text-[12px]" style={{ color: 'var(--sophia-glow)' }}>
            Auto-reduced due to frame drops.
          </span>
        )}
      </p>

      <div className="mt-4 grid gap-2">
        {OPTIONS.map(({ id, label, desc, icon: Icon }) => {
          const active = preference === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleSelect(id)}
              className={cn(
                'cosmic-focus-ring flex items-center gap-3 rounded-[1.25rem] border p-3.5 text-left transition-all duration-200',
                active
                  ? 'border-[color-mix(in_srgb,var(--sophia-purple)_40%,var(--cosmic-border))]'
                  : 'border-[var(--cosmic-border-soft)] hover:border-[var(--cosmic-border)]',
              )}
              style={{
                background: active
                  ? 'color-mix(in srgb, var(--sophia-purple) 8%, var(--cosmic-panel))'
                  : 'var(--cosmic-panel-soft)',
              }}
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                style={{
                  background: active
                    ? 'color-mix(in srgb, var(--sophia-purple) 14%, transparent)'
                    : 'var(--cosmic-panel)',
                  color: active ? 'var(--sophia-purple)' : 'var(--cosmic-text-whisper)',
                }}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <span
                  className="text-sm font-medium"
                  style={{ color: active ? 'var(--cosmic-text-strong)' : 'var(--cosmic-text)' }}
                >
                  {label}
                </span>
                <p className="text-[12px] leading-snug" style={{ color: 'var(--cosmic-text-muted)' }}>
                  {desc}
                </p>
              </div>
              {active && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    background: 'color-mix(in srgb, var(--sophia-purple) 14%, transparent)',
                    color: 'var(--sophia-purple)',
                  }}
                >
                  Tier {tier}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
