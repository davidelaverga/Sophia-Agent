import { describe, expect, it } from 'vitest'

import { resolveTooltipLayout } from '../../app/onboarding/ui/layout'
import type { OnboardingTargetRect } from '../../app/onboarding/types'

const targetRect: OnboardingTargetRect = {
  x: 200,
  y: 160,
  width: 64,
  height: 64,
  top: 160,
  right: 264,
  bottom: 224,
  left: 200,
}

describe('resolveTooltipLayout', () => {
  it('centers the tooltip when there is no target', () => {
    const layout = resolveTooltipLayout({
      preferredPosition: 'center',
      targetRect: null,
      viewportWidth: 1200,
      viewportHeight: 800,
      tooltipWidth: 360,
      tooltipHeight: 220,
    })

    expect(layout.placement).toBe('center')
    expect(layout.arrow).toBeNull()
    expect(layout.left).toBeGreaterThan(0)
    expect(layout.top).toBeGreaterThan(0)
  })

  it('flips placement when the preferred side would overflow', () => {
    const layout = resolveTooltipLayout({
      preferredPosition: 'top',
      targetRect: {
        ...targetRect,
        top: 12,
        y: 12,
        bottom: 76,
      },
      viewportWidth: 1200,
      viewportHeight: 800,
      tooltipWidth: 360,
      tooltipHeight: 220,
    })

    expect(layout.placement).toBe('bottom')
    expect(layout.arrow?.side).toBe('top')
  })

  it('falls back to a bottom sheet on very narrow viewports', () => {
    const layout = resolveTooltipLayout({
      preferredPosition: 'right',
      targetRect,
      viewportWidth: 340,
      viewportHeight: 740,
      tooltipWidth: 360,
      tooltipHeight: 220,
    })

    expect(layout.placement).toBe('bottom-sheet')
    expect(layout.isBottomSheet).toBe(true)
    expect(layout.arrow).toBeNull()
  })
})