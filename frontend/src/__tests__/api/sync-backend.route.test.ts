import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.fn();
const listUserAccountsMock = vi.fn();
const providerLoginMock = vi.fn();
const cookieSetMock = vi.fn();
const headersMock = vi.fn();

let authBypassEnabledMock = false;

vi.mock('next/headers', () => ({
  headers: (...args: unknown[]) => headersMock(...args),
  cookies: async () => ({
    set: cookieSetMock,
  }),
}));

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  get authBypassEnabled() {
    return authBypassEnabledMock;
  },
}));

vi.mock('../../app/lib/auth/backend-auth', () => ({
  providerLogin: (...args: unknown[]) => providerLoginMock(...args),
}));

vi.mock('../../server/better-auth/config', () => ({
  auth: {
    api: {
      listUserAccounts: (...args: unknown[]) => listUserAccountsMock(...args),
    },
  },
}));

vi.mock('../../server/better-auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

import { POST } from '../../app/api/auth/sync-backend/route';

describe('/api/auth/sync-backend POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authBypassEnabledMock = false;
    headersMock.mockReturnValue(new Headers({ cookie: 'better-auth.session=abc123' }));
    getSessionMock.mockResolvedValue({
      user: {
        id: 'session-user-1',
        email: 'user@example.com',
        name: 'Test User',
      },
    });
    listUserAccountsMock.mockResolvedValue([
      { providerId: 'google', accountId: 'google-account-123' },
    ]);
    providerLoginMock.mockResolvedValue({
      id: 'backend-user-1',
      email: 'user@example.com',
      username: 'Test User',
      api_token: 'token-123',
    });
  });

  it('syncs the Google account through the legacy backend bridge and sets the backend token cookie', async () => {
    const response = await POST();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(providerLoginMock).toHaveBeenCalledWith({
      provider: 'google',
      canonicalUserId: 'session-user-1',
      providerUserId: 'google-account-123',
      email: 'user@example.com',
      forwardedCookieHeader: 'better-auth.session=abc123',
      username: 'Test User',
    });
    expect(cookieSetMock).toHaveBeenCalledWith(
      'sophia-backend-token',
      'token-123',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      }),
    );
    expect(payload).toEqual({
      ok: true,
      user: { id: 'backend-user-1', email: 'user@example.com', username: 'Test User' },
    });
  });

  it('falls back to the canonical session user id when no linked Google account exists', async () => {
    listUserAccountsMock.mockResolvedValue([{ providerId: 'discord', accountId: 'discord-legacy' }]);

    const response = await POST();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(providerLoginMock).toHaveBeenCalledWith({
      provider: 'google',
      canonicalUserId: 'session-user-1',
      providerUserId: 'session-user-1',
      email: 'user@example.com',
      forwardedCookieHeader: 'better-auth.session=abc123',
      username: 'Test User',
    });
    expect(payload).toEqual({
      ok: true,
      user: { id: 'backend-user-1', email: 'user@example.com', username: 'Test User' },
    });
  });

  it('returns a skipped success when the legacy backend bridge is missing locally', async () => {
    providerLoginMock.mockRejectedValue(Object.assign(new Error('HTTP 404: Not Found'), { status: 404 }));

    const response = await POST();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      skipped: true,
      reason: 'Legacy backend auth bridge unavailable',
    });
  });
});