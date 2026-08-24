import { cookies } from 'next/headers';

import {
  VOICE_LAB_CONTEXT_COOKIE_NAME,
  VOICE_LAB_RUN_BINDING_COOKIE_NAME,
} from '@/app/lib/synthetic-isolation-policy';
import { getSession } from '@/server/better-auth';

export type VoiceLabProductAccess = {
  /** Only an endpoint that adds and verifies the exact run capability may opt in. */
  voiceLabAccess?: 'governed';
};

function normalized(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return candidate && candidate !== 'anonymous' ? candidate : null;
}

function configuredPrincipal(): string | null {
  return normalized(process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL);
}

/**
 * The HttpOnly markers are a fail-closed request-context signal.  The
 * dedicated principal is an independent signal so a stale/missing marker can
 * never turn a Voice Lab Better-Auth session into an ordinary product user.
 */
export async function isVoiceLabOrdinaryProductContext(
  knownUserId?: string | null,
): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    if (
      cookieStore.has(VOICE_LAB_CONTEXT_COOKIE_NAME)
      || cookieStore.has(VOICE_LAB_RUN_BINDING_COOKIE_NAME)
    ) {
      return true;
    }
  } catch {
    // A non-request server call has no browser context.  It remains ordinary;
    // the Gateway independently fences the dedicated principal.
  }

  const principal = configuredPrincipal();
  if (!principal) return false;

  const known = normalized(knownUserId);
  if (known) return known === principal;

  if (
    process.env.SOPHIA_AUTH_BYPASS?.trim().toLowerCase() === 'true'
    && normalized(process.env.SOPHIA_USER_ID) === principal
  ) {
    return true;
  }

  try {
    const session = await getSession();
    return normalized(session?.user?.id ?? null) === principal;
  } catch {
    // A configured dedicated principal can still own the Better-Auth cookie
    // even when the session lookup is temporarily unavailable.  Treat that
    // ambiguity as synthetic so a missing/stale Voice Lab marker cannot turn
    // an auth outage into ordinary-product access or telemetry allocation.
    return true;
  }
}

export async function ordinaryProductAccessAllowed(
  options: VoiceLabProductAccess | undefined,
  knownUserId?: string | null,
): Promise<boolean> {
  if (options?.voiceLabAccess === 'governed') return true;
  return !(await isVoiceLabOrdinaryProductContext(knownUserId));
}

/**
 * First-instruction guard for ordinary same-origin handlers that would
 * otherwise parse a body, consume a limiter, mint a legacy token, or allocate
 * an upstream client before the common auth helper resolves the user.
 */
export async function voiceLabOrdinaryProductBoundaryResponse(
  knownUserId?: string | null,
): Promise<Response | null> {
  if (!(await isVoiceLabOrdinaryProductContext(knownUserId))) return null;
  return Response.json(
    { error: 'voice_lab_ordinary_product_route_forbidden' },
    { status: 403 },
  );
}
