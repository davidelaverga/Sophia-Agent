import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureBetterAuthSchemaMock = vi.fn();
const makeSignatureMock = vi.fn();
const findUserByEmailMock = vi.fn();
const createUserMock = vi.fn();
const findAccountMock = vi.fn();
const createAccountMock = vi.fn();
const createSessionMock = vi.fn();

vi.mock('better-auth/crypto', () => ({
  makeSignature: (...args: unknown[]) => makeSignatureMock(...args),
}));

vi.mock('../../server/better-auth/migrations', () => ({
  ensureBetterAuthSchema: (...args: unknown[]) => ensureBetterAuthSchemaMock(...args),
}));

vi.mock('../../server/better-auth/config', () => ({
  auth: {
    $context: Promise.resolve({
      secret: 'better-auth-secret',
      authCookies: {
        sessionToken: {
          name: 'better-auth.session_token',
          attributes: {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            path: '/',
            maxAge: 3600,
          },
        },
      },
      internalAdapter: {
        findUserByEmail: (...args: unknown[]) => findUserByEmailMock(...args),
        createUser: (...args: unknown[]) => createUserMock(...args),
        findAccount: (...args: unknown[]) => findAccountMock(...args),
        createAccount: (...args: unknown[]) => createAccountMock(...args),
        createSession: (...args: unknown[]) => createSessionMock(...args),
      },
    }),
  },
}));

import { POST } from '../../app/api/test-auth/login/route';

describe('/api/test-auth/login POST', () => {
  const originalTestAuthFlag = process.env.SOPHIA_E2E_TEST_AUTH;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOPHIA_E2E_TEST_AUTH = 'true';

    ensureBetterAuthSchemaMock.mockResolvedValue(undefined);
    makeSignatureMock.mockResolvedValue('signed-token');
    findUserByEmailMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue({
      id: 'user-123',
      email: 'auth-smoke@example.com',
      name: 'Auth Smoke User',
    });
    findAccountMock.mockResolvedValue(null);
    createAccountMock.mockResolvedValue({ id: 'account-123' });
    createSessionMock.mockResolvedValue({ token: 'session-token' });
  });

  afterEach(() => {
    if (originalTestAuthFlag === undefined) {
      delete process.env.SOPHIA_E2E_TEST_AUTH;
      return;
    }

    process.env.SOPHIA_E2E_TEST_AUTH = originalTestAuthFlag;
  });

  it('returns 404 when the test auth route is disabled', async () => {
    process.env.SOPHIA_E2E_TEST_AUTH = 'false';

    const request = new Request('http://localhost:3000/api/test-auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'auth-smoke@example.com' }),
      headers: {
        'Content-Type': 'application/json',
      },
    }) as unknown as NextRequest;

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload).toEqual({ error: 'Not found' });
    expect(ensureBetterAuthSchemaMock).not.toHaveBeenCalled();
  });

  it('creates a Better Auth session cookie for the seeded test user', async () => {
    const request = new Request('http://localhost:3000/api/test-auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'auth-smoke@example.com',
        name: 'Auth Smoke User',
        accountId: 'google-auth-smoke',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    }) as unknown as NextRequest;

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(ensureBetterAuthSchemaMock).toHaveBeenCalledTimes(1);
    expect(findUserByEmailMock).toHaveBeenCalledWith('auth-smoke@example.com');
    expect(createUserMock).toHaveBeenCalledWith({
      email: 'auth-smoke@example.com',
      name: 'Auth Smoke User',
      emailVerified: true,
      image: null,
    });
    expect(findAccountMock).toHaveBeenCalledWith('google-auth-smoke');
    expect(createAccountMock).toHaveBeenCalledWith({
      userId: 'user-123',
      providerId: 'google',
      accountId: 'google-auth-smoke',
      scope: 'openid,profile,email',
    });
    expect(createSessionMock).toHaveBeenCalledWith('user-123');
    expect(makeSignatureMock).toHaveBeenCalledWith('session-token', 'better-auth-secret');
    expect(payload).toEqual({
      ok: true,
      user: {
        id: 'user-123',
        email: 'auth-smoke@example.com',
        name: 'Auth Smoke User',
      },
      accountId: 'google-auth-smoke',
    });
    expect(response.headers.get('set-cookie')).toContain('better-auth.session_token=session-token.signed-token');
  });
});