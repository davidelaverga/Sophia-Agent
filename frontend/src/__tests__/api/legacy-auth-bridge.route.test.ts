import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.fn();

let authBypassEnabledMock = false;
let authBypassUserIdMock = 'dev-user';

vi.mock('../../server/better-auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  get authBypassEnabled() {
    return authBypassEnabledMock;
  },
  get authBypassUserId() {
    return authBypassUserIdMock;
  },
}));

import { POST as loginPOST } from '../../app/api/v1/auth/discord/login/route';
import { GET as meGET } from '../../app/api/v1/auth/me/route';
import { POST as refreshPOST } from '../../app/api/v1/auth/token/refresh/route';
import { GET as validateGET } from '../../app/api/v1/auth/validate/route';

describe('legacy Better Auth bridge routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authBypassEnabledMock = false;
    authBypassUserIdMock = 'dev-user';
    process.env.BETTER_AUTH_SECRET = 'bridge-test-secret-1234567890';
    getSessionMock.mockResolvedValue({
      user: {
        id: 'session-user-1',
        email: 'user@example.com',
        name: 'Session User',
      },
    });
  });

  it('issues a backend token bound to the Better Auth user id and round-trips through /me and /validate', async () => {
    const loginResponse = await loginPOST(
      new Request('http://localhost:3000/api/v1/auth/discord/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonical_user_id: 'session-user-1',
          discord_id: 'google-account-123',
          email: 'user@example.com',
          username: 'Session User',
        }),
      }),
    );

    expect(loginResponse.status).toBe(200);
    const loginPayload = await loginResponse.json();
    expect(loginPayload).toMatchObject({
      id: 'session-user-1',
      email: 'user@example.com',
      username: 'Session User',
      discord_id: 'google-account-123',
      is_active: true,
    });
    expect(typeof loginPayload.api_token).toBe('string');

    const meResponse = await meGET(
      new Request('http://localhost:3000/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${loginPayload.api_token}` },
      }),
    );

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toMatchObject({
      id: 'session-user-1',
      email: 'user@example.com',
      username: 'Session User',
    });

    const validateResponse = await validateGET(
      new Request('http://localhost:3000/api/v1/auth/validate', {
        headers: { Authorization: `Bearer ${loginPayload.api_token}` },
      }),
    );

    expect(validateResponse.status).toBe(200);
    await expect(validateResponse.json()).resolves.toEqual({
      valid: true,
      user_id: 'session-user-1',
      email: 'user@example.com',
      is_active: true,
    });
  });

  it('refreshes a valid backend token without changing the canonical user id', async () => {
    const loginResponse = await loginPOST(
      new Request('http://localhost:3000/api/v1/auth/discord/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonical_user_id: 'session-user-1',
          discord_id: 'google-account-123',
          email: 'user@example.com',
        }),
      }),
    );
    const loginPayload = await loginResponse.json();

    const refreshResponse = await refreshPOST(
      new Request('http://localhost:3000/api/v1/auth/token/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginPayload.api_token}` },
      }),
    );

    expect(refreshResponse.status).toBe(200);
    await expect(refreshResponse.json()).resolves.toMatchObject({
      id: 'session-user-1',
      email: 'user@example.com',
      is_active: true,
    });
  });

  it('rejects canonical_user_id mismatches before minting a backend token', async () => {
    const response = await loginPOST(
      new Request('http://localhost:3000/api/v1/auth/discord/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonical_user_id: 'other-user',
          discord_id: 'google-account-123',
          email: 'user@example.com',
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      detail: 'canonical_user_id does not match the Better Auth session user',
    });
  });

  it('rejects invalid backend bearer tokens', async () => {
    const response = await meGET(
      new Request('http://localhost:3000/api/v1/auth/me', {
        headers: { Authorization: 'Bearer not-a-real-token' },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      detail: 'Invalid backend token format',
      valid: false,
    });
  });

  it('supports auth bypass by minting tokens for the configured bypass user', async () => {
    authBypassEnabledMock = true;
    authBypassUserIdMock = 'bypass-user-77';
    getSessionMock.mockResolvedValue(null);

    const response = await loginPOST(
      new Request('http://localhost:3000/api/v1/auth/discord/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bypass@example.com', username: 'Bypass User' }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'bypass-user-77',
      email: 'bypass@example.com',
      username: 'Bypass User',
      is_active: true,
    });
  });
});