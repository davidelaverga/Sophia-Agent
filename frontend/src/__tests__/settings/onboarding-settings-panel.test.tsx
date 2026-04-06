import { fireEvent, render, screen } from '@testing-library/react'
import type * as NextNavigationModule from 'next/navigation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushMock = vi.fn()
const showToastMock = vi.fn()

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof NextNavigationModule>('next/navigation')
  return {
    ...actual,
    useRouter: () => ({
      push: pushMock,
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
  }
})

vi.mock('../../app/stores/ui-store', () => ({
  useUiStore: (selector: (state: { showToast: typeof showToastMock }) => unknown) => selector({ showToast: showToastMock }),
}))

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}))

import { OnboardingSettingsPanel } from '../../app/components/settings/OnboardingSettingsPanel'
import { useOnboardingStore } from '../../app/stores/onboarding-store'

describe('OnboardingSettingsPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    pushMock.mockReset()
    showToastMock.mockReset()
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
      preferences: {
        ...state.preferences,
        voiceOverEnabled: true,
      },
    }))
  })

  it('replays the tour from settings and routes back to the dashboard', () => {
    render(<OnboardingSettingsPanel />)

    fireEvent.click(screen.getByRole('button', { name: /replay/i }))

    expect(useOnboardingStore.getState().firstRun.status).toBe('in_progress')
    expect(useOnboardingStore.getState().currentStepId).toBe('welcome')
    expect(pushMock).toHaveBeenCalledWith('/')
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'info',
    }))
  })

  it('toggles onboarding voice-over preference', () => {
    render(<OnboardingSettingsPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'On' }))

    expect(useOnboardingStore.getState().preferences.voiceOverEnabled).toBe(false)
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Onboarding voice-over muted',
      variant: 'success',
    }))
  })
})