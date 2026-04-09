const explicitAuthBypass =
  process.env.NEXT_PUBLIC_SOPHIA_AUTH_BYPASS
  ?? process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH

// Temporary default: bypass auth outside production unless explicitly disabled.
export const authBypassEnabled =
  explicitAuthBypass === 'true' ||
  (process.env.NODE_ENV !== 'production' && explicitAuthBypass !== 'false')

export const authBypassUserId = process.env.NEXT_PUBLIC_SOPHIA_USER_ID || 'local-dev-user'
