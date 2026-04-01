import { describe, expect, it } from 'vitest'

import { shouldEnableOnboardingVoice } from '../../app/onboarding/voice'

describe('shouldEnableOnboardingVoice', () => {
  it('enables voice only when the step has a voice line and voice is allowed', () => {
    expect(shouldEnableOnboardingVoice({
      hasVoiceLine: true,
      voiceOverEnabled: true,
      reducedMotion: false,
      isOnline: true,
    })).toBe(true)
  })

  it('disables voice when muted, offline, reduced motion, or no voice line', () => {
    expect(shouldEnableOnboardingVoice({
      hasVoiceLine: false,
      voiceOverEnabled: true,
      reducedMotion: false,
      isOnline: true,
    })).toBe(false)

    expect(shouldEnableOnboardingVoice({
      hasVoiceLine: true,
      voiceOverEnabled: false,
      reducedMotion: false,
      isOnline: true,
    })).toBe(false)

    expect(shouldEnableOnboardingVoice({
      hasVoiceLine: true,
      voiceOverEnabled: true,
      reducedMotion: true,
      isOnline: true,
    })).toBe(false)

    expect(shouldEnableOnboardingVoice({
      hasVoiceLine: true,
      voiceOverEnabled: true,
      reducedMotion: false,
      isOnline: false,
    })).toBe(false)
  })
})