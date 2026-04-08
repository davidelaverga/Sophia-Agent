import { beforeEach, describe, expect, it, vi } from 'vitest'

import { extractFirstName, resolveOnboardingCopy } from '../../app/onboarding/personalization'
import type * as OnboardingStoreModule from '../../app/stores/onboarding-store'

async function loadOnboardingStore(): Promise<typeof OnboardingStoreModule> {
  vi.resetModules()
  return import('../../app/stores/onboarding-store')
}

describe('Onboarding Store', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('initializes the v2 onboarding store with safe defaults', async () => {
    const { useOnboardingStore } = await loadOnboardingStore()
    const state = useOnboardingStore.getState()

    expect(state.firstRun.status).toBe('not_started')
    expect(state.currentStepId).toBeNull()
    expect(state.hasCompletedFirstRun).toBe(false)
    expect(state.isActive).toBe(false)
    expect(state.preferences.voiceOverEnabled).toBe(true)
    expect(state.contextualTips).toEqual({})
  })

  it('migrates the legacy onboarding completion flag once and removes the old key', async () => {
    localStorage.setItem('sophia-onboarding', JSON.stringify({
      state: {
        hasCompletedOnboarding: true,
        currentStep: 'privacy',
      },
    }))

    const { useOnboardingStore } = await loadOnboardingStore()
    const state = useOnboardingStore.getState()

    expect(state.firstRun.status).toBe('completed')
    expect(state.hasCompletedFirstRun).toBe(true)
    expect(state.hasCompletedOnboarding).toBe(true)
    expect(state.currentStepId).toBeNull()
    expect(localStorage.getItem('sophia-onboarding')).toBeNull()
  })

  it('starts onboarding, advances through steps, and completes on the final step', async () => {
    const { useOnboardingStore } = await loadOnboardingStore()
    const state = useOnboardingStore.getState()

    state.startOnboarding()
    expect(useOnboardingStore.getState().currentStepId).toBe('welcome')
    expect(useOnboardingStore.getState().isActive).toBe(true)

    state.advanceStep()
    expect(useOnboardingStore.getState().currentStepId).toBe('dashboard-presets')
    expect(useOnboardingStore.getState().firstRun.completedSteps).toContain('welcome')

    useOnboardingStore.getState().goToStep('ready')
    useOnboardingStore.getState().advanceStep()

    const completedState = useOnboardingStore.getState()
    expect(completedState.firstRun.status).toBe('completed')
    expect(completedState.hasCompletedFirstRun).toBe(true)
    expect(completedState.currentStepId).toBeNull()
    expect(completedState.firstRun.completedSteps).toContain('ready')
  })

  it('supports skip, replay, and reset without clearing contextual tips or preferences', async () => {
    const { useOnboardingStore } = await loadOnboardingStore()

    useOnboardingStore.getState().startOnboarding()
    useOnboardingStore.getState().markTipSeen('tip-first-recap')
    useOnboardingStore.getState().setVoiceOverEnabled(false)
    useOnboardingStore.getState().skipOnboarding()

    let state = useOnboardingStore.getState()
    expect(state.firstRun.status).toBe('skipped')
    expect(state.hasCompletedOnboarding).toBe(true)
    expect(state.hasCompletedFirstRun).toBe(false)
    expect(state.contextualTips['tip-first-recap']?.seen).toBe(true)
    expect(state.preferences.voiceOverEnabled).toBe(false)

    useOnboardingStore.getState().replayOnboarding()
    state = useOnboardingStore.getState()
    expect(state.firstRun.status).toBe('in_progress')
    expect(state.currentStepId).toBe('welcome')
    expect(state.contextualTips['tip-first-recap']?.seen).toBe(true)

    useOnboardingStore.getState().resetOnboarding()
    state = useOnboardingStore.getState()
    expect(state.firstRun.status).toBe('not_started')
    expect(state.currentStepId).toBeNull()
    expect(state.contextualTips['tip-first-recap']?.seen).toBe(true)
    expect(state.preferences.voiceOverEnabled).toBe(false)
  })

  it('marks and dismisses contextual tips as seen', async () => {
    const { useOnboardingStore } = await loadOnboardingStore()

    useOnboardingStore.getState().markTipSeen('tip-first-artifacts')
    useOnboardingStore.getState().dismissTip('tip-first-memory-candidate')

    const state = useOnboardingStore.getState()
    expect(state.contextualTips['tip-first-artifacts']).toMatchObject({
      seen: true,
      dismissed: false,
    })
    expect(state.contextualTips['tip-first-memory-candidate']).toMatchObject({
      seen: true,
      dismissed: true,
    })
  })

  it('only allows one active contextual tip at a time', async () => {
    const { useOnboardingStore } = await loadOnboardingStore()

    expect(useOnboardingStore.getState().requestContextualTip('tip-first-artifacts')).toBe(true)
    expect(useOnboardingStore.getState().activeContextualTipId).toBe('tip-first-artifacts')

    expect(useOnboardingStore.getState().requestContextualTip('tip-first-recap')).toBe(false)
    expect(useOnboardingStore.getState().activeContextualTipId).toBe('tip-first-artifacts')

    useOnboardingStore.getState().clearActiveContextualTip('tip-first-artifacts')
    expect(useOnboardingStore.getState().requestContextualTip('tip-first-recap')).toBe(true)
    expect(useOnboardingStore.getState().activeContextualTipId).toBe('tip-first-recap')
  })
})

describe('Onboarding Personalization', () => {
  it('extracts a first name when a real name is available', () => {
    expect(extractFirstName('Sophia Rivers')).toBe('Sophia')
    expect(extractFirstName('  David  ')).toBe('David')
  })

  it('omits broken or email-based placeholders cleanly', () => {
    expect(extractFirstName('person@example.com')).toBeNull()
    expect(resolveOnboardingCopy('Welcome, {firstName}.', null)).toBe('Welcome.')
    expect(resolveOnboardingCopy('Welcome, {firstName}. Let me show you around.', null)).toBe('Welcome. Let me show you around.')
  })
})