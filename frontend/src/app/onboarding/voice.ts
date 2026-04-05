export type OnboardingVoiceEligibilityInput = {
  hasVoiceLine: boolean
  voiceOverEnabled: boolean
  reducedMotion: boolean
  isOnline: boolean
}

export function shouldEnableOnboardingVoice({
  hasVoiceLine,
  voiceOverEnabled,
  reducedMotion,
  isOnline,
}: OnboardingVoiceEligibilityInput): boolean {
  return hasVoiceLine && voiceOverEnabled && !reducedMotion && isOnline
}

export function getOnboardingVoiceOnlineState(): boolean {
  if (typeof navigator === 'undefined') {
    return true
  }

  return navigator.onLine !== false
}

export function resolvePreferredSpeechVoice(voices: SpeechSynthesisVoice[], language = 'en'): SpeechSynthesisVoice | null {
  if (!voices.length) {
    return null
  }

  const loweredLanguage = language.toLowerCase()
  const exactLanguageVoice = voices.find((voice) => voice.lang?.toLowerCase().startsWith(loweredLanguage))
  if (exactLanguageVoice) {
    return exactLanguageVoice
  }

  const englishVoice = voices.find((voice) => voice.lang?.toLowerCase().startsWith('en'))
  return englishVoice ?? voices[0] ?? null
}