/**
 * VisualQualityPicker — compact segmented control for visual quality tier.
 *
 * Renders as a label + inline pill selector. No card wrapper — parent handles layout.
 */

'use client'

import { useCallback } from 'react'

import { haptic } from '../../hooks/useHaptics'
import { useVisualTier, type VisualTierPreference } from '../../hooks/useVisualTier'

const OPTIONS: { id: VisualTierPreference; label: string }[] = [
  { id: 'auto',     label: 'Auto' },
  { id: 'full',     label: 'Full' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'low',      label: 'Light' },
]

export function VisualQualityPicker() {
  const { preference, tier, autoDegraded, setPreference } = useVisualTier()

  const handleSelect = useCallback((id: VisualTierPreference) => {
    haptic('light')
    setPreference(id)
  }, [setPreference])

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
            Performance mode
          </p>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
            Controls GPU usage for visual effects
            {autoDegraded && (
              <span className="ml-1" style={{ color: 'var(--sophia-glow)' }}>· Auto-reduced</span>
            )}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            background: 'color-mix(in srgb, var(--sophia-purple) 10%, transparent)',
            color: 'var(--sophia-purple)',
          }}
        >
          Tier {tier}
        </span>
      </div>

      <div
        className="mt-3 flex gap-1 rounded-2xl border p-1"
        style={{
          background: 'var(--cosmic-panel-soft)',
          borderColor: 'var(--cosmic-border-soft)',
        }}
      >
        {OPTIONS.map(({ id, label }) => {
          const active = preference === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleSelect(id)}
              className="cosmic-focus-ring flex-1 rounded-xl px-2 py-2 text-[12px] font-medium transition-all duration-200"
              style={{
                background: active ? 'var(--cosmic-panel)' : 'transparent',
                color: active ? 'var(--sophia-purple)' : 'var(--cosmic-text-whisper)',
                boxShadow: active ? '0 1px 4px color-mix(in srgb, var(--sophia-purple) 12%, transparent)' : 'none',
              }}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
