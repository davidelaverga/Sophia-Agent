import { describe, expect, it } from 'vitest'

import {
  getDetailPanelPosition,
  getHoverLabelPosition,
} from '@/app/journal/journalFloatingLayout'

describe('journalFloatingLayout', () => {
  it('clamps hover labels within the viewport and flips them below when needed', () => {
    expect(getHoverLabelPosition({
      anchorX: 18,
      anchorY: 24,
      boxWidth: 220,
      boxHeight: 54,
      viewportWidth: 360,
      viewportHeight: 640,
    })).toEqual({
      left: 12,
      top: 44,
    })
  })

  it('keeps hover labels inside the right edge of the viewport', () => {
    expect(getHoverLabelPosition({
      anchorX: 344,
      anchorY: 220,
      boxWidth: 220,
      boxHeight: 54,
      viewportWidth: 360,
      viewportHeight: 640,
    })).toEqual({
      left: 128,
      top: 152,
    })
  })

  it('places detail panels below the orb when the taller card no longer fits above it', () => {
    expect(getDetailPanelPosition({
      anchorX: 180,
      anchorY: 140,
      boxWidth: 260,
      boxHeight: 280,
      viewportWidth: 360,
      viewportHeight: 540,
    })).toEqual({
      left: 50,
      top: 172,
    })
  })

  it('clamps detail panels to the viewport bottom when there is no room below', () => {
    expect(getDetailPanelPosition({
      anchorX: 332,
      anchorY: 96,
      boxWidth: 260,
      boxHeight: 420,
      viewportWidth: 360,
      viewportHeight: 540,
    })).toEqual({
      left: 88,
      top: 108,
    })
  })
})