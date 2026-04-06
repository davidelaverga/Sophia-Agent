import { headers as nextHeaders } from 'next/headers';

import { authBypassEnabled, authBypassUserId } from '@/app/lib/auth/dev-bypass';
import { getServerAuthHeader } from '@/app/lib/auth/server-auth';
import { auth } from '@/server/better-auth';

export const SOPHIA_GATEWAY_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8001';

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

export async function resolveSophiaUserId(explicitUserId?: string | null): Promise<string | null> {
  const provided = normalizeUserId(explicitUserId);
  if (provided) {
    return provided;
  }

  if (authBypassEnabled) {
    return authBypassUserId;
  }

  try {
    const session = await auth.api.getSession({ headers: await nextHeaders() });
    return normalizeUserId(session?.user?.id ?? null);
  } catch {
    return null;
  }
}

export function isSyntheticMemoryId(memoryId: string | null | undefined): boolean {
  const normalized = normalizeUserId(memoryId);
  if (!normalized) {
    return true;
  }

  return /^candidate-/.test(normalized) || /^mem_\d+$/.test(normalized);
}

export async function fetchSophiaApi(path: string, init: RequestInit): Promise<Response> {
  const requestHeaders = new Headers(init.headers);

  if (init.body !== undefined && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  requestHeaders.set('Authorization', await getServerAuthHeader());

  return fetch(`${SOPHIA_GATEWAY_URL}${path}`, {
    ...init,
    headers: requestHeaders,
  });
}