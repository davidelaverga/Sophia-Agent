import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getUnionTargetRect, resolveOnboardingTargetElement, resolveOnboardingTargetElements } from '../../app/onboarding/ui/useTargetRect'

describe('resolveOnboardingTargetElement', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('returns a target immediately when it already exists', async () => {
    const element = document.createElement('button')
    element.setAttribute('data-onboarding', 'mic-cta')
    document.body.appendChild(element)

    const resolvedElement = await resolveOnboardingTargetElement("[data-onboarding='mic-cta']")

    expect(resolvedElement).toBe(element)
  })

  it('retries lookup and resolves when the target appears later', async () => {
    vi.useFakeTimers()

    const resolutionPromise = resolveOnboardingTargetElement("[data-onboarding='ritual-grid']", {
      attempts: 3,
      delayMs: 100,
    })

    setTimeout(() => {
      const element = document.createElement('div')
      element.setAttribute('data-onboarding', 'ritual-grid')
      document.body.appendChild(element)
    }, 150)

    await vi.advanceTimersByTimeAsync(200)
    const resolvedElement = await resolutionPromise

    expect(resolvedElement).not.toBeNull()
    expect(resolvedElement?.getAttribute('data-onboarding')).toBe('ritual-grid')
  })

  it('returns null when the target never appears', async () => {
    vi.useFakeTimers()

    const resolutionPromise = resolveOnboardingTargetElement("[data-onboarding='missing-target']", {
      attempts: 3,
      delayMs: 100,
    })

    await vi.advanceTimersByTimeAsync(300)

    await expect(resolutionPromise).resolves.toBeNull()
  })

  it('resolves multiple real targets and builds a union rect for tooltip placement', async () => {
    const gaming = document.createElement('button')
    gaming.setAttribute('data-onboarding', 'preset-tab-gaming')
    gaming.getBoundingClientRect = vi.fn(() => ({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      top: 20,
      right: 110,
      bottom: 60,
      left: 10,
      toJSON: () => ({}),
    }))

    const work = document.createElement('button')
    work.setAttribute('data-onboarding', 'preset-tab-work')
    work.getBoundingClientRect = vi.fn(() => ({
      x: 130,
      y: 18,
      width: 110,
      height: 42,
      top: 18,
      right: 240,
      bottom: 60,
      left: 130,
      toJSON: () => ({}),
    }))

    document.body.appendChild(gaming)
    document.body.appendChild(work)

    const resolved = await resolveOnboardingTargetElements([
      "[data-onboarding='preset-tab-gaming']",
      "[data-onboarding='preset-tab-work']",
    ])

    expect(resolved).toHaveLength(2)

    const unionRect = getUnionTargetRect(resolved.map((element) => ({ ...element.getBoundingClientRect() })))

    expect(unionRect).toMatchObject({
      top: 18,
      left: 10,
      right: 240,
      bottom: 60,
      width: 230,
      height: 42,
    })
  })
})