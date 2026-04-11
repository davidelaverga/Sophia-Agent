const explicitAuthBypass =
  process.env.NEXT_PUBLIC_SOPHIA_AUTH_BYPASS
  ?? process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH

function normalizeBypassFlag(value: string | undefined): boolean | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') {
    return true
  }

  if (normalized === 'false') {
    return false
  }

  return null
}

const explicitAuthBypassSource =
  process.env.NEXT_PUBLIC_SOPHIA_AUTH_BYPASS != null
    ? 'NEXT_PUBLIC_SOPHIA_AUTH_BYPASS'
    : process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH != null
      ? 'NEXT_PUBLIC_DEV_BYPASS_AUTH'
      : null

// Auth bypass must be explicitly enabled. Real auth should remain the default in local development.
export const authBypassEnabled = normalizeBypassFlag(explicitAuthBypass) === true

export const authBypassSource = explicitAuthBypassSource
export const authBypassConfiguredValue = explicitAuthBypass ?? null

export const authBypassUserId = process.env.NEXT_PUBLIC_SOPHIA_USER_ID || 'local-dev-user'
