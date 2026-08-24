import { getAuthenticatedUserId, getUserScopedAuthHeader, refreshUserScopedAuthHeader } from '@/app/lib/auth/server-auth';
import { VOICE_LAB_PROVIDER_CLEANUP_HEADER } from '@/app/lib/voice-lab-provider-cleanup';
import { VOICE_LAB_CAPABILITY_HEADER } from '@/server/voice-lab/capability';
import type { VoiceLabProductAccess } from '@/server/voice-lab/ordinary-route-isolation';

import { getPrimaryGatewayUrl } from './gateway-url';

export const SOPHIA_GATEWAY_URL = getPrimaryGatewayUrl();

function normalizeUserId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === 'anonymous') {
    return null;
  }

  return trimmed;
}

export async function resolveSophiaUserId(options?: VoiceLabProductAccess): Promise<string | null> {
  return getAuthenticatedUserId(options);
}

export function isSyntheticMemoryId(memoryId: string | null | undefined): boolean {
  const normalized = normalizeUserId(memoryId);
  if (!normalized) {
    return true;
  }

  return normalized.startsWith('candidate-') || normalized.startsWith('local:') || /^mem_\d+$/.test(normalized);
}

export async function fetchSophiaApi(
  path: string,
  init: RequestInit,
  options?: VoiceLabProductAccess,
): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  const capabilityOnly = options?.voiceLabAccess === 'governed'
    && Boolean(
      requestHeaders.get(VOICE_LAB_CAPABILITY_HEADER)
      || requestHeaders.get(VOICE_LAB_PROVIDER_CLEANUP_HEADER),
    );
  const authHeader = capabilityOnly ? '' : await getUserScopedAuthHeader(options);

  if (init.body !== undefined && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  if (!capabilityOnly && !authHeader) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const execute = (authorization?: string) => {
    const headers = new Headers(requestHeaders)
    if (authorization) {
      headers.set('Authorization', authorization)
    } else {
      headers.delete('Authorization')
    }

    return fetch(`${SOPHIA_GATEWAY_URL}${path}`, {
      ...init,
      headers,
    })
  }

  let response = await execute(authHeader || undefined)

  if (!capabilityOnly && (response.status === 401 || response.status === 403)) {
    const refreshedAuthHeader = await refreshUserScopedAuthHeader(options)
    if (refreshedAuthHeader && refreshedAuthHeader !== authHeader) {
      response = await execute(refreshedAuthHeader)
    }
  }

  return response
}
