import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OnboardingTipGuard } from '../../app/components/onboarding'
import type * as OnboardingModule from '../../app/onboarding'
import { useOnboardingStore } from '../../app/stores/onboarding-store'

vi.mock('../../app/onboarding', async () => {
  const actual = await vi.importActual<typeof OnboardingModule>('../../app/onboarding')

  return {
    ...actual,
    OnboardingTooltip: ({ open, title, onPrimaryAction }: { open?: boolean; title: string; onPrimaryAction?: () => void }) => (
      open ? <button onClick={onPrimaryAction}>{title}</button> : null
    ),
    useTargetRect: (selector: string | null | undefined) => ({
      rect: selector && document.querySelector(selector)
        ? { x: 0, y: 0, width: 120, height: 48, top: 0, right: 120, bottom: 48, left: 0 }
        : null,
      element: null,
      isResolved: true,
    }),
    useOnboardingVoice: () => ({
      speak: vi.fn(async () => undefined),
      stop: vi.fn(),
      isPlaying: false,
      voiceOverEnabled: true,
      toggleVoiceOver: vi.fn(),
    }),
  }
})

describe('OnboardingTipGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    document.body.innerHTML = ''

    useOnboardingStore.setState((state) => ({
      ...state,
      firstRun: {
        ...state.firstRun,
        status: 'completed',
        currentStepId: null,
      },
      currentStepId: null,
      hasCompletedFirstRun: true,
      isActive: false,
      activeContextualTipId: null,
      contextualTips: {},
    }))
  })

  it('shows a contextual tip when its real target and trigger are present', async () => {
    const target = document.createElement('button')
    target.setAttribute('data-onboarding-contextual', 'ritual-card-suggested')
    document.body.appendChild(target)

    render(<OnboardingTipGuard tipId="tip-first-ritual-suggestion" isTriggered />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    expect(screen.getByRole('button', { name: 'Suggested ritual' })).toBeInTheDocument()
  })

  it('marks the tip as seen after dismissal', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-onboarding-contextual', 'ritual-card-suggested')
    document.body.appendChild(target)

    render(<OnboardingTipGuard tipId="tip-first-ritual-suggestion" isTriggered />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Suggested ritual' }))

    expect(useOnboardingStore.getState().contextualTips['tip-first-ritual-suggestion']?.seen).toBe(true)
    expect(screen.queryByText('Suggested ritual')).not.toBeInTheDocument()
  })
})