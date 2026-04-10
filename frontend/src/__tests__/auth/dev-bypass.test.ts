import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

async function loadDevBypassModule() {
  vi.resetModules()
  return import('../../app/lib/auth/dev-bypass')
}

describe('dev-bypass config', () => {
  afterEach(() => {
    vi.resetModules()

    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key]
      }
    }

    Object.assign(process.env, ORIGINAL_ENV)
  })

  it('keeps auth bypass disabled by default when no env flag is set', async () => {
    delete process.env.NEXT_PUBLIC_SOPHIA_AUTH_BYPASS
    delete process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH

    const devBypass = await loadDevBypassModule()

    expect(devBypass.authBypassEnabled).toBe(false)
    expect(devBypass.authBypassSource).toBeNull()
    expect(devBypass.authBypassConfiguredValue).toBeNull()
  })

  it('enables bypass when the primary Sophia bypass flag is true', async () => {
    process.env.NEXT_PUBLIC_SOPHIA_AUTH_BYPASS = 'true'
    delete process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH

    const devBypass = await loadDevBypassModule()

    expect(devBypass.authBypassEnabled).toBe(true)
    expect(devBypass.authBypassSource).toBe('NEXT_PUBLIC_SOPHIA_AUTH_BYPASS')
    expect(devBypass.authBypassConfiguredValue).toBe('true')
  })

  it('treats explicit false as disabled even in development', async () => {
    process.env.NEXT_PUBLIC_SOPHIA_AUTH_BYPASS = 'false'
    process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH = 'true'

    const devBypass = await loadDevBypassModule()

    expect(devBypass.authBypassEnabled).toBe(false)
    expect(devBypass.authBypassSource).toBe('NEXT_PUBLIC_SOPHIA_AUTH_BYPASS')
    expect(devBypass.authBypassConfiguredValue).toBe('false')
  })
})