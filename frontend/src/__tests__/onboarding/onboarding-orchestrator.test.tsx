import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OnboardingOrchestrator } from '../../app/components/onboarding/OnboardingOrchestrator'
import { useAuthTokenStore } from '../../app/stores/auth-token-store'
import { useOnboardingStore } from '../../app/stores/onboarding-store'

describe('OnboardingOrchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    document.body.innerHTML = ''
    useOnboardingStore.getState().resetOnboarding()
    useAuthTokenStore.setState({
      token: 'token',
      user: {
        id: 'user-1',
        email: 'david@example.com',
        username: 'David Stone',
        discord_id: 'discord-1',
      },
      isValidating: false,
      lastValidated: Date.now(),
    })
  })

  it('shows the personalized welcome step on the dashboard route', async () => {
    render(<OnboardingOrchestrator />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    expect(screen.getByText('Welcome, David.')).toBeInTheDocument()
    expect(screen.getByText(/your space to think, decompress, and grow/i)).toBeInTheDocument()
  })

  it('advances onto the mic spotlight step when the dashboard target exists', async () => {
    const micTarget = document.createElement('button')
    micTarget.setAttribute('data-onboarding', 'mic-cta')
    const presetGaming = document.createElement('button')
    presetGaming.setAttribute('data-onboarding', 'preset-tab-gaming')
    const presetWork = document.createElement('button')
    presetWork.setAttribute('data-onboarding', 'preset-tab-work')
    const presetLife = document.createElement('button')
    presetLife.setAttribute('data-onboarding', 'preset-tab-life')
    document.body.appendChild(micTarget)
    document.body.appendChild(presetGaming)
    document.body.appendChild(presetWork)
    document.body.appendChild(presetLife)

    render(<OnboardingOrchestrator />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    await act(async () => {
      useOnboardingStore.getState().goToStep('dashboard-mic')
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(screen.getByText('The microphone')).toBeInTheDocument()
    expect(useOnboardingStore.getState().currentStepId).toBe('dashboard-mic')

    presetGaming.remove()
    presetWork.remove()
    presetLife.remove()
  })

  it('skips the first-run tour when Escape is pressed', async () => {
    render(<OnboardingOrchestrator />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(useOnboardingStore.getState().firstRun.status).toBe('skipped')
    expect(useOnboardingStore.getState().currentStepId).toBeNull()
  })

  it('supports ArrowRight and ArrowLeft navigation through first-run steps', async () => {
    const micTarget = document.createElement('button')
    micTarget.setAttribute('data-onboarding', 'mic-cta')
    const presetGaming = document.createElement('button')
    presetGaming.setAttribute('data-onboarding', 'preset-tab-gaming')
    const presetWork = document.createElement('button')
    presetWork.setAttribute('data-onboarding', 'preset-tab-work')
    const presetLife = document.createElement('button')
    presetLife.setAttribute('data-onboarding', 'preset-tab-life')
    const ritualPrepare = document.createElement('button')
    ritualPrepare.setAttribute('data-onboarding', 'ritual-card-prepare')
    const ritualDebrief = document.createElement('button')
    ritualDebrief.setAttribute('data-onboarding', 'ritual-card-debrief')
    const ritualReset = document.createElement('button')
    ritualReset.setAttribute('data-onboarding', 'ritual-card-reset')
    const ritualVent = document.createElement('button')
    ritualVent.setAttribute('data-onboarding', 'ritual-card-vent')
    document.body.appendChild(micTarget)
    document.body.appendChild(presetGaming)
    document.body.appendChild(presetWork)
    document.body.appendChild(presetLife)
    document.body.appendChild(ritualPrepare)
    document.body.appendChild(ritualDebrief)
    document.body.appendChild(ritualReset)
    document.body.appendChild(ritualVent)

    render(<OnboardingOrchestrator />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    expect(screen.getByText('Welcome, David.')).toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(screen.getByText('Worlds')).toBeInTheDocument()
    expect(useOnboardingStore.getState().currentStepId).toBe('dashboard-presets')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(screen.getByText('Rituals')).toBeInTheDocument()
    expect(useOnboardingStore.getState().currentStepId).toBe('dashboard-rituals')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(screen.getByText('The microphone')).toBeInTheDocument()
    expect(useOnboardingStore.getState().currentStepId).toBe('dashboard-mic')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    })

    expect(screen.getByText('Rituals')).toBeInTheDocument()
    expect(useOnboardingStore.getState().currentStepId).toBe('dashboard-rituals')

    micTarget.remove()
    presetGaming.remove()
    presetWork.remove()
    presetLife.remove()
    ritualPrepare.remove()
    ritualDebrief.remove()
    ritualReset.remove()
    ritualVent.remove()
  })

  it('moves focus into the tooltip and restores it when the tour closes', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Return focus here'
    document.body.appendChild(trigger)
    trigger.focus()

    render(<OnboardingOrchestrator />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    const primaryAction = screen.getByRole('button', { name: /continue/i })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })

    expect(primaryAction).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: /skip tour/i }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(trigger).toHaveFocus()

    trigger.remove()
  })
})