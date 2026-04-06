import { describe, it, expect } from 'vitest'

import { derivePlatform } from '../../app/hooks/usePlatformSignal'

describe('derivePlatform', () => {
  it('returns "text" for text mode on web', () => {
    expect(derivePlatform('text', false)).toBe('text')
  })

  it('returns "voice" for voice mode on web', () => {
    expect(derivePlatform('voice', false)).toBe('voice')
  })

  it('returns "ios_voice" for voice mode on iOS', () => {
    expect(derivePlatform('voice', true)).toBe('ios_voice')
  })

  it('returns "text" for text mode on iOS', () => {
    expect(derivePlatform('text', true)).toBe('text')
  })
})
