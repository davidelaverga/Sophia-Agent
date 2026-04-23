import { getAuthenticatedUserId, getUserScopedAuthHeader, refreshUserScopedAuthHeader } from '@/app/lib/auth/server-auth';

import { getPrimaryGatewayUrl } from './gateway-url';

export const SOPHIA_GATEWAY_URL = getPrimaryGatewayUrl();

function getSophiaAuthBackendUrl(): string | null {
  const configuredUrl = process.env.SOPHIA_AUTH_BACKEND_URL ?? process.env.NEXT_PUBLIC_SOPHIA_AUTH_BACKEND_URL;
  if (typeof configuredUrl !== 'string') {
    return null;
  }

  const trimmed = configuredUrl.trim().replace(/\/$/, '');
  return trimmed || null;
}

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

export async function resolveSophiaUserId(): Promise<string | null> {
  return getAuthenticatedUserId();
}

export function isSyntheticMemoryId(memoryId: string | null | undefined): boolean {
  const normalized = normalizeUserId(memoryId);
  if (!normalized) {
    return true;
  }

  return normalized.startsWith('candidate-') || normalized.startsWith('local:') || /^mem_\d+$/.test(normalized);
}

export async function fetchSophiaApi(path: string, init: RequestInit): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  const authHeader = await getUserScopedAuthHeader();
  const authBackendUrl = getSophiaAuthBackendUrl();

  if (init.body !== undefined && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const execute = (authorization: string) => {
    const headers = new Headers(requestHeaders)
    headers.set('Authorization', authorization)
    if (authBackendUrl) {
      headers.set('X-Sophia-Auth-Backend-Url', authBackendUrl)
    }

    return fetch(`${SOPHIA_GATEWAY_URL}${path}`, {
      ...init,
      headers,
    })
  }

  let response = await execute(authHeader)

  if (response.status === 401 || response.status === 403) {
    const refreshedAuthHeader = await refreshUserScopedAuthHeader()
    if (refreshedAuthHeader && refreshedAuthHeader !== authHeader) {
      response = await execute(refreshedAuthHeader)
    }
  }

  return response
}