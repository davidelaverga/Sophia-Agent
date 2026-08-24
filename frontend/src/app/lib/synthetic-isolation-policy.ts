export const SYNTHETIC_ISOLATION_POLICY_SCHEMA = 'sophia_synthetic_isolation_policy_v1' as const;
export const VOICE_LAB_CONTEXT_COOKIE_NAME = '__Host-sophia-voice-lab-context' as const;
export const VOICE_LAB_RUN_BINDING_COOKIE_NAME = '__Host-sophia-voice-lab-run-binding' as const;

export type SyntheticIsolationPolicy = {
  schema: typeof SYNTHETIC_ISOLATION_POLICY_SCHEMA;
  source:
    | 'ordinary_request'
    | 'verified_voice_lab_context'
    | 'unverified_voice_lab_context_fail_closed';
  synthetic: boolean;
  ordinary_product_analytics_excluded: boolean;
  ordinary_error_reporting_excluded: boolean;
  sink_allocation_allowed: boolean;
  reason: 'synthetic_isolation_policy' | null;
};

declare global {
  interface Window {
    __SOPHIA_SYNTHETIC_ISOLATION_POLICY__?: SyntheticIsolationPolicy;
  }
}

export function getSyntheticIsolationPolicy(): SyntheticIsolationPolicy | null {
  if (typeof window === 'undefined') return null;
  const policy = window.__SOPHIA_SYNTHETIC_ISOLATION_POLICY__;
  return policy && typeof policy === 'object' ? policy : null;
}

/**
 * A present but malformed server bootstrap fails closed. The only state that
 * may allocate an ordinary telemetry/error sink is the exact ordinary policy.
 */
export function ordinaryAnalyticsSinkAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  const policy = window.__SOPHIA_SYNTHETIC_ISOLATION_POLICY__;
  // The server bootstrap is the sole authority for enabling ordinary sinks.
  // Missing bootstrap state (CSP failure, hydration race, or a stripped
  // inline script) must not silently restore telemetry for a synthetic tab.
  if (policy === undefined) return false;
  return policy.schema === SYNTHETIC_ISOLATION_POLICY_SCHEMA
    && policy.source === 'ordinary_request'
    && policy.synthetic === false
    && policy.ordinary_product_analytics_excluded === false
    && policy.ordinary_error_reporting_excluded === false
    && policy.sink_allocation_allowed === true
    && policy.reason === null;
}

/**
 * Server error reporting remains unchanged for an ordinary request. A request
 * carrying either HttpOnly Voice Lab marker is excluded before a Sentry scope
 * or event is allocated. Cookie presence intentionally fails closed: malformed
 * and stale synthetic state must not fall back into the ordinary sink.
 */
export function ordinaryServerErrorSinkAllowed(
  request: Pick<Request, 'headers'> | null | undefined,
  knownUserId?: string | null,
): boolean {
  if (request) {
    const cookieHeader = request.headers.get('cookie') ?? '';
    const cookieNames = cookieHeader
      .split(';')
      .map((part) => part.trim().split('=', 1)[0]);
    if (
      cookieNames.includes(VOICE_LAB_CONTEXT_COOKIE_NAME)
      || cookieNames.includes(VOICE_LAB_RUN_BINDING_COOKIE_NAME)
    ) {
      return false;
    }
  }

  const configuredPrincipal = process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL?.trim();
  const normalizedKnownUserId = knownUserId?.trim();
  if (
    configuredPrincipal
    && normalizedKnownUserId
    && normalizedKnownUserId === configuredPrincipal
  ) {
    return false;
  }

  // In auth-bypass deployments every server request resolves to SOPHIA_USER_ID.
  // If that identity is the dedicated lab principal, no marker is required to
  // keep server-side Sentry allocation categorically disabled.
  if (
    configuredPrincipal
    && process.env.SOPHIA_AUTH_BYPASS?.trim().toLowerCase() === 'true'
    && process.env.SOPHIA_USER_ID?.trim() === configuredPrincipal
  ) {
    return false;
  }
  return true;
}

export function syntheticAnalyticsExcluded(): boolean {
  return !ordinaryAnalyticsSinkAllowed();
}
