import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthenticatedUserIdMock = vi.fn();
const getUserScopedAuthHeaderMock = vi.fn();

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: (...args: unknown[]) => getAuthenticatedUserIdMock(...args),
  getUserScopedAuthHeader: (...args: unknown[]) => getUserScopedAuthHeaderMock(...args),
}));

import { POST as connectPOST } from '../../app/api/sophia/[userId]/voice/connect/route';
import { POST as disconnectPOST } from '../../app/api/sophia/[userId]/voice/disconnect/route';

describe('voice session proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthenticatedUserIdMock.mockResolvedValue('user-1');
    getUserScopedAuthHeaderMock.mockResolvedValue('Bearer scoped-token');
  });

  it('rejects voice connect when the Better Auth user does not match the URL userId', async () => {
    const response = await connectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-2/voice/connect?foo=bar'),
        text: async () => '{}',
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-2' }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Token does not grant access to this user' });
  });

  it('rejects voice disconnect when there is no authenticated Better Auth user', async () => {
    getAuthenticatedUserIdMock.mockResolvedValue(null);

    const response = await disconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/disconnect'),
        text: async () => '{}',
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated' });
  });

  it('proxies voice connect with the user-scoped bearer token for the matching user', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, session_id: 'voice-session-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await connectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/connect?source=ui'),
        text: async () => JSON.stringify({ platform: 'voice' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/sophia/user-1/voice/connect');
    expect(url).toContain('source=ui');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer scoped-token');
    expect(options.body).toBe(JSON.stringify({ platform: 'voice' }));
    expect(response.status).toBe(200);
  });

  it('proxies voice disconnect with the user-scoped bearer token for the matching user', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const response = await disconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/disconnect'),
        text: async () => JSON.stringify({ call_id: 'call-123' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/sophia/user-1/voice/disconnect');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer scoped-token');
    expect(options.body).toBe(JSON.stringify({ call_id: 'call-123' }));
    expect(response.status).toBe(204);
  });
});